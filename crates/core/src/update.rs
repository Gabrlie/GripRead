//! 检查更新: GripRead's releases on GitHub, offered on the 正式版 or 测试版
//! channel. Android downloads its APK (verified against the release's
//! `SHA256SUMS`) and hands it to the system installer; the desktop app runs
//! the Tauri updater on the release's `latest.json`; the web version only
//! says that a newer server image exists.
//!
//! 下载方式 picks the route: 自动 (the connected GripRead server, which
//! caches releases and files under `/api/update/…`, else GitHub through the
//! app's proxy, falling back to GitHub when the server fails), 直连 (GitHub
//! without a proxy), 代理 (GitHub through the app's proxy), 加速器 (the
//! release list from GitHub, files through an accelerator address), and
//! 服务器 (the connected server only).

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands::AppState;
use crate::error::{AppError, ErrorCode};
use crate::models::{
    AvailableUpdate, CheckUpdateRequest, InstallOutcome, InstallUpdateRequest, ReleaseNote,
    SaveUpdateSettingsRequest, UpdateChannel, UpdateCheck, UpdateKind, UpdateProgress,
    UpdateSettings, UpdateSource, DEFAULT_ACCELERATOR,
};
use crate::platform::{DesktopUpdate, UpdateTarget};

/// Where GripRead is published.
pub const REPOSITORY: &str = "Gabrlie/GripRead";
const SETTINGS_FILE: &str = "update.json";
/// The server's cached release list stays this long.
const RELEASES_FRESH: Duration = Duration::from_secs(10 * 60);
/// Releases listed in 更新日志.
const NOTES_KEPT: usize = 10;

/// A GitHub release, as the API returns it and the server passes it on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub html_url: String,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub browser_download_url: String,
}

impl Release {
    fn version(&self) -> Option<Version> {
        parse_version(&self.tag_name)
    }

    fn asset(&self, name: &str) -> Option<&ReleaseAsset> {
        self.assets.iter().find(|asset| asset.name == name)
    }

    fn published_at(&self) -> i64 {
        self.published_at
            .as_deref()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .map(|at| at.timestamp_millis())
            .unwrap_or_default()
    }
}

pub fn parse_version(text: &str) -> Option<Version> {
    Version::parse(text.trim().trim_start_matches('v')).ok()
}

fn update_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Io, message)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

pub fn load_settings(root: &Path) -> UpdateSettings {
    fs::read_to_string(root.join(SETTINGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_settings(root: &Path, settings: &UpdateSettings) -> Result<(), AppError> {
    let path = root.join(SETTINGS_FILE);
    let partial = path.with_extension("json.part");
    fs::write(&partial, serde_json::to_string_pretty(settings)?)?;
    fs::rename(&partial, &path)?;
    Ok(())
}

pub fn save_settings(
    root: &Path,
    request: SaveUpdateSettingsRequest,
) -> Result<UpdateSettings, AppError> {
    let mut settings = load_settings(root);
    settings.channel = request.channel;
    settings.source = request.source;
    settings.accelerator = match request.accelerator.trim() {
        "" => DEFAULT_ACCELERATOR.to_string(),
        accelerator => accelerator.to_string(),
    };
    settings.auto_check = request.auto_check;
    settings.skipped = request.skipped;
    write_settings(root, &settings)?;
    Ok(settings)
}

pub fn mark_checked(root: &Path) {
    let mut settings = load_settings(root);
    settings.last_check = Some(now_ms());
    if write_settings(root, &settings).is_err() {
        crate::app_log::warn("update", "检查更新时间保存失败");
    }
}

/// Where releases and files come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Upstream {
    /// GitHub, through the app's proxy or not.
    GitHub { proxy: bool },
    /// GitHub's release list directly, files through an accelerator address.
    Accelerator { template: String },
    /// A GripRead server's mirror, with its address and session token.
    Server { address: String, token: String },
}

impl Upstream {
    /// GitHub as 自动 reaches it, and as the server does for its mirror.
    pub const GITHUB: Upstream = Upstream::GitHub { proxy: true };

    fn proxied(&self) -> bool {
        matches!(self, Upstream::GitHub { proxy: true })
    }
}

/// A file's address through an accelerator: `{url}`, `{path}`, `{tag}`,
/// and `{name}` are filled in; a template without them is a prefix.
pub fn accelerated(template: &str, url: &str, tag: &str, name: &str) -> String {
    let template = template.trim();
    let path = url.strip_prefix("https://github.com/").unwrap_or(url);
    if ["{url}", "{path}", "{tag}", "{name}"]
        .iter()
        .any(|marker| template.contains(marker))
    {
        template
            .replace("{url}", url)
            .replace("{path}", path)
            .replace("{tag}", tag)
            .replace("{name}", name)
    } else {
        format!("{template}{url}")
    }
}

/// An HTTP client that verifies certificates and follows redirects (GitHub
/// sends downloads elsewhere), through the app's proxy when `proxied`.
fn agent(root: &Path, timeout: Duration, proxied: bool) -> Result<ureq::Agent, AppError> {
    let proxy = match proxied.then(|| crate::network::proxy(root)).flatten() {
        Some(address) => Some(
            ureq::Proxy::new(&address)
                .map_err(|error| update_error(format!("代理设置无效：{error}")))?,
        ),
        None => None,
    };
    Ok(ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(timeout))
        .proxy(proxy)
        .build()
        .into())
}

fn get(
    agent: &ureq::Agent,
    upstream: &Upstream,
    url: &str,
) -> Result<ureq::http::Response<ureq::Body>, AppError> {
    let mut request = agent
        .get(url)
        .header("User-Agent", "GripRead")
        .header("Accept", "application/vnd.github+json");
    if let Upstream::Server { token, .. } = upstream {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let response = request
        .call()
        .map_err(|error| update_error(format!("连接更新服务器失败：{error}")))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(update_error(format!("更新服务器返回 HTTP {status}")));
    }
    Ok(response)
}

/// The published releases, newest first as the upstream lists them.
pub fn fetch_releases(root: &Path, upstream: &Upstream) -> Result<Vec<Release>, AppError> {
    let url = match upstream {
        Upstream::GitHub { .. } | Upstream::Accelerator { .. } => {
            format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=30")
        }
        Upstream::Server { address, .. } => format!("{address}/api/update/releases"),
    };
    let agent = agent(root, Duration::from_secs(30), upstream.proxied())?;
    let mut response = get(&agent, upstream, &url)?;
    let text = response
        .body_mut()
        .with_config()
        .limit(16 * 1024 * 1024)
        .read_to_string()
        .map_err(|error| update_error(format!("读取发布信息失败：{error}")))?;
    serde_json::from_str(&text).map_err(|error| update_error(format!("发布信息无效：{error}")))
}

/// The release notes for 更新日志: the changes and commits, without the
/// download table, image lines, and checksums that only matter on GitHub.
pub fn trim_notes(body: &str) -> String {
    let starts_line = |at: &usize| *at == 0 || body.as_bytes()[*at - 1] == b'\n';
    let end = ["## 下载", "## 服务器镜像", "所有文件的 SHA-256"]
        .iter()
        .filter_map(|marker| {
            body.match_indices(marker)
                .map(|(at, _)| at)
                .find(starts_line)
        })
        .min()
        .unwrap_or(body.len());
    body[..end].trim().to_string()
}

fn kind_of(target: &UpdateTarget) -> UpdateKind {
    match target {
        UpdateTarget::Android { .. } => UpdateKind::Android,
        UpdateTarget::Desktop { .. } => UpdateKind::Desktop,
        UpdateTarget::None => UpdateKind::Server,
    }
}

/// The file this device downloads from a release: the APK for its ABI (the
/// universal one otherwise). Desktop and the web version download none.
fn asset_for<'a>(release: &'a Release, target: &UpdateTarget) -> Option<&'a ReleaseAsset> {
    let UpdateTarget::Android { abis, .. } = target else {
        return None;
    };
    let version = release.tag_name.trim_start_matches('v');
    abis.iter()
        .map(String::as_str)
        .chain(["universal"])
        .find_map(|abi| {
            release
                .asset(&format!("GripRead-{version}-Android-{abi}.apk"))
                // Releases up to 0.2.1-beta.1 named them in lower case.
                .or_else(|| release.asset(&format!("gripread-{version}-{abi}.apk")))
        })
}

/// What the channel offers to a copy at `current`: a newer release, if
/// any, and the channel's recent releases for 更新日志.
pub fn plan(
    releases: &[Release],
    channel: UpdateChannel,
    current: &str,
    target: &UpdateTarget,
) -> UpdateCheck {
    let mut offered: Vec<(Version, &Release)> = releases
        .iter()
        .filter(|release| !release.draft)
        .filter(|release| channel == UpdateChannel::Beta || !release.prerelease)
        .filter_map(|release| release.version().map(|version| (version, release)))
        .collect();
    offered.sort_by(|a, b| b.0.cmp(&a.0));
    let running = parse_version(current).unwrap_or(Version::new(0, 0, 0));
    let note = |release: &Release| ReleaseNote {
        version: release.tag_name.trim_start_matches('v').to_string(),
        prerelease: release.prerelease,
        published_at: release.published_at(),
        notes: trim_notes(release.body.as_deref().unwrap_or_default()),
        url: release.html_url.clone(),
    };
    let update = offered
        .first()
        .filter(|(version, _)| *version > running)
        .map(|(_, release)| {
            let asset = asset_for(release, target);
            let note = note(release);
            AvailableUpdate {
                version: note.version,
                prerelease: note.prerelease,
                published_at: note.published_at,
                notes: note.notes,
                url: note.url,
                asset: asset.map(|asset| asset.name.clone()),
                size: asset.map(|asset| asset.size),
            }
        });
    UpdateCheck {
        kind: kind_of(target),
        current: current.to_string(),
        update,
        releases: offered
            .iter()
            .take(NOTES_KEPT)
            .map(|(_, release)| note(release))
            .collect(),
        via_server: false,
    }
}

/// Finds `version` among the releases.
pub fn find_release<'a>(releases: &'a [Release], version: &str) -> Option<&'a Release> {
    let wanted = parse_version(version)?;
    releases
        .iter()
        .find(|release| release.version().as_ref() == Some(&wanted))
}

/// The SHA-256 a `SHA256SUMS` file lists for `name`.
pub fn checksum_of(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let file = parts.next()?.trim_start_matches('*');
        (file == name && hash.len() == 64).then(|| hash.to_ascii_lowercase())
    })
}

fn asset_url(upstream: &Upstream, release: &Release, name: &str) -> Result<String, AppError> {
    let github = || {
        release
            .asset(name)
            .map(|asset| asset.browser_download_url.clone())
            .filter(|url| !url.is_empty())
            .ok_or_else(|| update_error(format!("发布中没有 {name}")))
    };
    Ok(match upstream {
        Upstream::GitHub { .. } => github()?,
        Upstream::Accelerator { template } => {
            accelerated(template, &github()?, &release.tag_name, name)
        }
        Upstream::Server { address, .. } => {
            format!("{address}/api/update/asset/{}/{name}", release.tag_name)
        }
    })
}

/// How the desktop updater reaches a release: its `latest.json` and its
/// archives along the same route as everything else.
fn desktop_update(root: &Path, upstream: &Upstream, release: &Release) -> DesktopUpdate {
    let manifest = asset_url(upstream, release, "latest.json").unwrap_or_else(|_| {
        format!(
            "https://github.com/{REPOSITORY}/releases/download/{}/latest.json",
            release.tag_name
        )
    });
    let route = upstream.clone();
    let release = release.clone();
    DesktopUpdate {
        manifest,
        archive: Box::new(move |name: &str| asset_url(&route, &release, name).ok()),
        authorization: match upstream {
            Upstream::Server { token, .. } => Some(format!("Bearer {token}")),
            _ => None,
        },
        proxy: upstream
            .proxied()
            .then(|| crate::network::proxy(root))
            .flatten(),
    }
}

/// Downloads `name` of `release` into `folder`, verified against the
/// release's `SHA256SUMS`, and returns its path. Older downloads in the
/// folder are removed. `progress` gets the bytes received and the total.
pub fn download(
    root: &Path,
    upstream: &Upstream,
    release: &Release,
    name: &str,
    folder: &Path,
    cancel: &AtomicBool,
    progress: &dyn Fn(u64, Option<u64>),
) -> Result<PathBuf, AppError> {
    let agent = agent(root, Duration::from_secs(60), upstream.proxied())?;
    let sums = get(
        &agent,
        upstream,
        &asset_url(upstream, release, "SHA256SUMS")?,
    )?
    .body_mut()
    .read_to_string()
    .map_err(|error| update_error(format!("读取校验值失败：{error}")))?;
    let expected =
        checksum_of(&sums, name).ok_or_else(|| update_error(format!("校验值中没有 {name}")))?;

    fs::create_dir_all(folder)?;
    let target = folder.join(name);
    let partial = folder.join(format!("{name}.part"));
    let mut response = get(&agent, upstream, &asset_url(upstream, release, name)?)?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    let result = (|| {
        let mut reader = response.body_mut().with_config().limit(1 << 31).reader();
        let mut file = File::create(&partial)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 64 * 1024];
        let mut received = 0u64;
        let mut reported = Instant::now();
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(AppError::new(ErrorCode::ImportCancelled, "已取消下载"));
            }
            let read = reader
                .read(&mut buffer)
                .map_err(|error| update_error(format!("下载中断：{error}")))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]);
            received += read as u64;
            if reported.elapsed() >= Duration::from_millis(200) {
                progress(received, total);
                reported = Instant::now();
            }
        }
        file.sync_all()?;
        progress(received, total);
        if hex::encode(hasher.finalize()) != expected {
            return Err(update_error("下载的安装包校验失败，请重试"));
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    keep_download(folder, name)?;
    Ok(target)
}

/// Gives the verified `<name>.part` its name, then removes older downloads
/// (and their partial files); the new file is never among them.
fn keep_download(folder: &Path, name: &str) -> Result<(), AppError> {
    fs::rename(folder.join(format!("{name}.part")), folder.join(name))?;
    for entry in fs::read_dir(folder)?.flatten() {
        let file = entry.file_name().to_string_lossy().to_string();
        if file.to_ascii_lowercase().starts_with("gripread-") && file != name {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// The server's mirror: the release list, cached for ten minutes in
/// `updates/releases.json` (the stale copy answers while GitHub fails).
pub fn cached_releases(root: &Path) -> Result<Vec<Release>, AppError> {
    let folder = root.join("updates");
    let path = folder.join("releases.json");
    let fresh = fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < RELEASES_FRESH);
    let cached =
        || -> Option<Vec<Release>> { serde_json::from_str(&fs::read_to_string(&path).ok()?).ok() };
    if fresh {
        if let Some(releases) = cached() {
            return Ok(releases);
        }
    }
    match fetch_releases(root, &Upstream::GITHUB) {
        Ok(releases) => {
            fs::create_dir_all(&folder)?;
            let partial = path.with_extension("json.part");
            fs::write(&partial, serde_json::to_string(&releases)?)?;
            fs::rename(&partial, &path)?;
            Ok(releases)
        }
        Err(error) => cached().ok_or(error),
    }
}

/// The server's mirror: a release file, downloaded from GitHub once into
/// `updates/assets/<tag>/` and kept for the two newest tags. Only files the
/// release lists are served.
pub fn cached_asset(root: &Path, tag: &str, name: &str) -> Result<PathBuf, AppError> {
    let releases = cached_releases(root)?;
    let release = releases
        .iter()
        .find(|release| release.tag_name == tag)
        .ok_or_else(|| AppError::new(ErrorCode::FileNotFound, "没有这个版本"))?;
    let asset = release
        .asset(name)
        .ok_or_else(|| AppError::new(ErrorCode::FileNotFound, "没有这个文件"))?;
    let assets = root.join("updates").join("assets");
    let folder = assets.join(tag);
    let path = folder.join(&asset.name);
    if !path.is_file() {
        fs::create_dir_all(&folder)?;
        let agent = agent(root, Duration::from_secs(60), true)?;
        let mut response = get(&agent, &Upstream::GITHUB, &asset.browser_download_url)?;
        let partial = folder.join(format!("{}.part", asset.name));
        let mut file = File::create(&partial)?;
        std::io::copy(
            &mut response.body_mut().with_config().limit(1 << 31).reader(),
            &mut file,
        )
        .map_err(|error| update_error(format!("下载中断：{error}")))?;
        file.sync_all()?;
        fs::rename(&partial, &path)?;
        prune_assets(&assets, tag);
    }
    Ok(path)
}

/// Keeps the files of `keep` and of the newest other tag.
fn prune_assets(assets: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(assets) else {
        return;
    };
    let mut tags: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.file_name() != keep)
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    tags.sort_by_key(|tag| std::cmp::Reverse(tag.0));
    for (_, path) in tags.into_iter().skip(1) {
        let _ = fs::remove_dir_all(path);
    }
}

/// The route 下载方式 picks. 自动 uses the connected server, else GitHub;
/// 服务器 needs a connection.
fn upstream_for(
    settings: &UpdateSettings,
    server: Option<&(String, String)>,
) -> Result<Upstream, AppError> {
    let server = || {
        server.map(|(address, token)| Upstream::Server {
            address: address.clone(),
            token: token.clone(),
        })
    };
    Ok(match settings.source {
        UpdateSource::Auto => server().unwrap_or(Upstream::GITHUB),
        UpdateSource::Direct => Upstream::GitHub { proxy: false },
        UpdateSource::Proxy => Upstream::GITHUB,
        UpdateSource::Accelerator => Upstream::Accelerator {
            template: match settings.accelerator.trim() {
                "" => DEFAULT_ACCELERATOR.to_string(),
                template => template.to_string(),
            },
        },
        UpdateSource::Server => server()
            .ok_or_else(|| AppError::invalid_argument("下载方式是 服务器，但还没有连接服务器"))?,
    })
}

/// The releases for a check or an install along the chosen route. Only
/// 自动 falls back from the server to GitHub; the server itself reads its
/// own cache.
fn releases_for(
    root: &Path,
    server: Option<&(String, String)>,
    target: &UpdateTarget,
) -> Result<(Vec<Release>, Upstream), AppError> {
    let settings = load_settings(root);
    let upstream = upstream_for(&settings, server)?;
    if matches!(target, UpdateTarget::None) {
        return Ok((cached_releases(root)?, Upstream::GITHUB));
    }
    match fetch_releases(root, &upstream) {
        Ok(releases) => Ok((releases, upstream)),
        Err(error)
            if settings.source == UpdateSource::Auto
                && matches!(upstream, Upstream::Server { .. }) =>
        {
            crate::app_log::warn(
                "update",
                format!("通过服务器检查更新失败，改为直连 GitHub：{}", error.message),
            );
            Ok((fetch_releases(root, &Upstream::GITHUB)?, Upstream::GITHUB))
        }
        Err(error) => Err(error),
    }
}

pub async fn get_update_settings(state: &Arc<AppState>) -> Result<UpdateSettings, AppError> {
    Ok(load_settings(&state.data_root))
}

pub async fn save_update_settings(
    state: &Arc<AppState>,
    request: SaveUpdateSettingsRequest,
) -> Result<UpdateSettings, AppError> {
    save_settings(&state.data_root, request)
}

pub async fn check_update(
    state: &Arc<AppState>,
    request: CheckUpdateRequest,
) -> Result<UpdateCheck, AppError> {
    let root = state.data_root.clone();
    let target = state.platform.update_target();
    let server = state.sync.server();
    tokio::task::spawn_blocking(move || {
        let (releases, upstream) = releases_for(&root, server.as_ref(), &target)?;
        let mut check = plan(
            &releases,
            load_settings(&root).channel,
            &request.current,
            &target,
        );
        check.via_server = matches!(upstream, Upstream::Server { .. });
        if request.automatic == Some(true) {
            mark_checked(&root);
        }
        Ok(check)
    })
    .await
    .map_err(|error| update_error(error.to_string()))?
}

/// Downloads and installs `version`: the APK through the system installer
/// on Android, the desktop updater elsewhere. Progress comes as
/// `update-progress`; `cancel_source_operation` stops the download.
pub async fn install_update(
    state: &Arc<AppState>,
    request: InstallUpdateRequest,
) -> Result<InstallOutcome, AppError> {
    let root = state.data_root.clone();
    let target = state.platform.update_target();
    let server = state.sync.server();
    let platform = state.platform.clone();
    let events = state.events.clone();
    let cancel = state.operations.register(&request.operation_id);
    let cancels = state.operations.cancels();
    let id = request.operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let progress = |received: u64, total: Option<u64>| {
            let event = UpdateProgress {
                operation_id: id.clone(),
                received,
                total,
            };
            events.emit(
                "update-progress",
                serde_json::to_value(event).unwrap_or_default(),
            );
        };
        let (releases, upstream) = releases_for(&root, server.as_ref(), &target)?;
        let release = find_release(&releases, &request.version)
            .ok_or_else(|| update_error(format!("没有找到版本 {}", request.version)))?;
        match &target {
            UpdateTarget::Android { folder, .. } => {
                let name = asset_for(release, &target)
                    .ok_or_else(|| update_error("这个版本没有适合本机的安装包"))?
                    .name
                    .clone();
                let automatic = load_settings(&root).source == UpdateSource::Auto;
                let path =
                    match download(&root, &upstream, release, &name, folder, &cancel, &progress) {
                        Err(error)
                            if automatic
                                && matches!(upstream, Upstream::Server { .. })
                                && error.code != ErrorCode::ImportCancelled =>
                        {
                            crate::app_log::warn(
                                "update",
                                format!("通过服务器下载失败，改为直连 GitHub：{}", error.message),
                            );
                            // The bar starts over for the second download.
                            progress(0, None);
                            download(
                                &root,
                                &Upstream::GITHUB,
                                release,
                                &name,
                                folder,
                                &cancel,
                                &progress,
                            )?
                        }
                        other => other?,
                    };
                platform.install_apk(&path)
            }
            UpdateTarget::Desktop { .. } => {
                platform.install_desktop_update(
                    &desktop_update(&root, &upstream, release),
                    &progress,
                )?;
                Ok(InstallOutcome::Started)
            }
            UpdateTarget::None => Err(update_error("网页版请更新服务器镜像")),
        }
    })
    .await
    .map_err(|error| update_error(error.to_string()));
    crate::source_commands::SourceOperations::finish(&cancels, &request.operation_id);
    result?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, prerelease: bool, assets: &[&str]) -> Release {
        Release {
            tag_name: tag.into(),
            body: Some(format!(
                "## 更新内容\n\n- {tag}\n\n## 下载\n\n| x |\n\n## 服务器镜像\n\ndocker"
            )),
            prerelease,
            draft: false,
            published_at: Some("2026-10-14T03:27:28Z".into()),
            html_url: format!("https://github.com/x/releases/tag/{tag}"),
            assets: assets
                .iter()
                .map(|name| ReleaseAsset {
                    name: name.to_string(),
                    size: 10,
                    browser_download_url: format!("https://dl/{name}"),
                })
                .collect(),
        }
    }

    fn android() -> UpdateTarget {
        UpdateTarget::Android {
            abis: vec!["arm64-v8a".into(), "armeabi-v7a".into()],
            folder: PathBuf::from("/cache"),
        }
    }

    fn releases() -> Vec<Release> {
        vec![
            release(
                "v0.2.2-beta.1",
                true,
                &["gripread-0.2.2-beta.1-arm64-v8a.apk"],
            ),
            release(
                "v0.2.1",
                false,
                &[
                    "GripRead-0.2.1-Android-armeabi-v7a.apk",
                    "GripRead-0.2.1-Android-universal.apk",
                ],
            ),
            release("v0.2.0", false, &[]),
        ]
    }

    #[test]
    fn channels_offer_releases_or_betas_too() {
        let stable = plan(&releases(), UpdateChannel::Stable, "0.2.0", &android());
        assert_eq!(stable.update.as_ref().unwrap().version, "0.2.1");
        assert_eq!(stable.releases.len(), 2);
        let beta = plan(&releases(), UpdateChannel::Beta, "0.2.0", &android());
        let update = beta.update.unwrap();
        assert_eq!(update.version, "0.2.2-beta.1");
        assert_eq!(
            update.asset.as_deref(),
            Some("gripread-0.2.2-beta.1-arm64-v8a.apk")
        );
        assert_eq!(beta.kind, UpdateKind::Android);
    }

    #[test]
    fn versions_order_with_prereleases_and_local_builds() {
        // A local build sorts before the beta and release of its version.
        let local = plan(
            &releases(),
            UpdateChannel::Beta,
            "0.2.2-alpha.202610140419",
            &android(),
        );
        assert_eq!(local.update.unwrap().version, "0.2.2-beta.1");
        let newest = plan(&releases(), UpdateChannel::Stable, "0.2.1", &android());
        assert_eq!(newest.update, None);
        let unknown = plan(&releases(), UpdateChannel::Stable, "dev", &android());
        assert_eq!(unknown.update.unwrap().version, "0.2.1");
    }

    #[test]
    fn the_apk_follows_the_abis_then_the_universal_one() {
        let pick = |abis: &[&str]| {
            let target = UpdateTarget::Android {
                abis: abis.iter().map(|abi| abi.to_string()).collect(),
                folder: PathBuf::new(),
            };
            plan(&releases(), UpdateChannel::Stable, "0.2.0", &target)
                .update
                .unwrap()
                .asset
        };
        assert_eq!(
            pick(&["arm64-v8a", "armeabi-v7a"]).as_deref(),
            Some("GripRead-0.2.1-Android-armeabi-v7a.apk")
        );
        assert_eq!(
            pick(&["x86_64"]).as_deref(),
            Some("GripRead-0.2.1-Android-universal.apk")
        );
        let web = plan(
            &releases(),
            UpdateChannel::Stable,
            "0.2.0",
            &UpdateTarget::None,
        );
        assert_eq!(web.kind, UpdateKind::Server);
        assert_eq!(web.update.unwrap().asset, None);
    }

    #[test]
    fn notes_keep_the_changes_only() {
        let check = plan(&releases(), UpdateChannel::Stable, "0.2.0", &android());
        assert_eq!(check.update.unwrap().notes, "## 更新内容\n\n- v0.2.1");
        assert_eq!(trim_notes("- only\n"), "- only");
        assert_eq!(trim_notes("## 下载\n\nx"), "");
    }

    #[test]
    fn a_finished_download_keeps_its_file_and_drops_older_ones() {
        let folder = std::env::temp_dir().join(format!("gripread-update-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        let name = "GripRead-0.2.1-Android-arm64-v8a.apk";
        fs::write(folder.join(format!("{name}.part")), b"new").unwrap();
        fs::write(folder.join("gripread-0.2.0-arm64-v8a.apk"), b"old").unwrap();
        fs::write(
            folder.join("GripRead-0.2.1-beta.1-Android-x86.apk.part"),
            b"x",
        )
        .unwrap();
        keep_download(&folder, name).unwrap();
        let left: Vec<String> = fs::read_dir(&folder)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left, vec![name.to_string()]);
        assert_eq!(fs::read(folder.join(name)).unwrap(), b"new");
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn accelerators_fill_in_their_template_or_prefix() {
        let url = "https://github.com/Gabrlie/GripRead/releases/download/v0.2.1/a.apk";
        assert_eq!(
            accelerated("https://gh-proxy.com/{url}", url, "v0.2.1", "a.apk"),
            format!("https://gh-proxy.com/{url}")
        );
        assert_eq!(
            accelerated("https://ghfast.top/", url, "v0.2.1", "a.apk"),
            format!("https://ghfast.top/{url}")
        );
        assert_eq!(
            accelerated("https://mirror.example/{path}", url, "v0.2.1", "a.apk"),
            "https://mirror.example/Gabrlie/GripRead/releases/download/v0.2.1/a.apk"
        );
        assert_eq!(
            accelerated("https://cdn.example/{tag}/{name}", url, "v0.2.1", "a.apk"),
            "https://cdn.example/v0.2.1/a.apk"
        );
    }

    #[test]
    fn the_route_follows_the_download_setting() {
        let server = ("https://reader.example".to_string(), "t".to_string());
        let with = |source| UpdateSettings {
            source,
            ..UpdateSettings::default()
        };
        assert!(matches!(
            upstream_for(&with(UpdateSource::Auto), Some(&server)).unwrap(),
            Upstream::Server { .. }
        ));
        assert_eq!(
            upstream_for(&with(UpdateSource::Auto), None).unwrap(),
            Upstream::GITHUB
        );
        assert_eq!(
            upstream_for(&with(UpdateSource::Direct), Some(&server)).unwrap(),
            Upstream::GitHub { proxy: false }
        );
        assert_eq!(
            upstream_for(&with(UpdateSource::Accelerator), None).unwrap(),
            Upstream::Accelerator {
                template: DEFAULT_ACCELERATOR.into()
            }
        );
        assert!(upstream_for(&with(UpdateSource::Server), None).is_err());
    }

    #[test]
    fn checksums_are_found_by_file_name() {
        let hash = "a".repeat(64);
        let sums = format!(
            "{hash}  gripread-0.2.1-universal.apk\n{}  other\n",
            "b".repeat(64)
        );
        assert_eq!(
            checksum_of(&sums, "gripread-0.2.1-universal.apk"),
            Some(hash)
        );
        assert_eq!(checksum_of(&sums, "missing.apk"), None);
    }

    #[test]
    fn settings_round_trip_and_keep_the_last_check() {
        let root = std::env::temp_dir().join(format!("gripread-update-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert_eq!(load_settings(&root), UpdateSettings::default());
        mark_checked(&root);
        let saved = save_settings(
            &root,
            SaveUpdateSettingsRequest {
                channel: UpdateChannel::Beta,
                source: UpdateSource::Accelerator,
                accelerator: " ".into(),
                auto_check: false,
                skipped: Some("0.2.1".into()),
            },
        )
        .unwrap();
        assert_eq!(saved.channel, UpdateChannel::Beta);
        assert_eq!(
            saved.accelerator, DEFAULT_ACCELERATOR,
            "an empty address is the default"
        );
        assert!(saved.last_check.is_some());
        assert_eq!(load_settings(&root), saved);
        fs::remove_dir_all(root).unwrap();
    }
}
