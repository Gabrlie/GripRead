//! The device's side of native sync with the GripRead server (设置 ›
//! 服务器). A worker thread runs a sync round when asked: it pulls the
//! records others wrote and applies them, fetches the books and covers they
//! name, then pushes what changed here and sends the files the server
//! lacks. Changes start a round 3 s after the last one (at most 10 s during
//! continuous changes); a long poll on the server starts one as soon as
//! another device writes. The address and session token live in
//! `sync-server.json` in the data folder, never in backups.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ureq::http::{Method, Request};

use crate::api::Events;
use crate::error::{AppError, ErrorCode};
use crate::models::{ConnectSyncServerRequest, SyncServerStatus};
use crate::storage::{Storage, SyncChange};
use crate::sync::{self as protocol, PullReply, PushReply, PushRequest};

const FILE: &str = "sync-server.json";
const QUIET: Duration = Duration::from_secs(3);
const LONGEST: Duration = Duration::from_secs(10);
/// A long poll waits this long on the server for another device's change.
const WAIT: Duration = Duration::from_secs(25);
const RETRY_FIRST: Duration = Duration::from_secs(30);
const RETRY_LONGEST: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    address: String,
    token: String,
    device_name: String,
    /// The newest server record this device has applied.
    cursor: i64,
    last_sync: Option<i64>,
    last_error: Option<String>,
    auto_download: bool,
    /// Books the server asked for that are not sent yet.
    uploads: Vec<String>,
}

impl Config {
    fn connected(&self) -> bool {
        !self.address.is_empty() && !self.token.is_empty()
    }
}

#[derive(Default)]
struct Wake {
    /// When the first and the latest change since the last round came.
    changed: Option<(Instant, Instant)>,
    now: bool,
    retry_at: Option<Instant>,
    /// Rounds finished, for callers waiting on one.
    rounds: u64,
}

struct Inner {
    root: PathBuf,
    storage: Arc<Mutex<Storage>>,
    events: Arc<dyn Events>,
    config: Mutex<Config>,
    wake: Mutex<Wake>,
    signal: Condvar,
    syncing: AtomicBool,
    /// The book open in the reader, which gets a prompt for others' progress.
    open_book: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct SyncClient {
    inner: Arc<Inner>,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

fn network_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("服务器连接失败：{error}"))
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(timeout))
        .build()
        .into()
}

/// The address as entered, with a scheme and without a trailing slash.
fn normalize_address(address: &str) -> String {
    let address = address.trim().trim_end_matches('/');
    if address.starts_with("http://") || address.starts_with("https://") {
        address.to_string()
    } else {
        format!("https://{address}")
    }
}

/// The server's error message for a failed request.
fn failure(status: u16, body: &str) -> AppError {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("HTTP {status}"));
    let code = if status == 401 {
        ErrorCode::InvalidArgument
    } else {
        ErrorCode::Io
    };
    AppError::new(code, message)
}

struct Http<'a> {
    address: &'a str,
    token: &'a str,
    agent: ureq::Agent,
}

impl Http<'_> {
    fn request(&self, method: Method, path: &str) -> ureq::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(format!("{}{path}", self.address))
            .header("Authorization", format!("Bearer {}", self.token))
    }

    fn json<T: for<'de> Deserialize<'de>>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T, AppError> {
        let builder = self
            .request(method, path)
            .header("Content-Type", "application/json");
        let request = builder
            .body(body.map(|body| body.to_string()).unwrap_or_default())
            .map_err(network_error)?;
        let mut response = self.agent.run(request).map_err(network_error)?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_string()
            .map_err(network_error)?;
        if !(200..300).contains(&status) {
            return Err(failure(status, &text));
        }
        serde_json::from_str(&text).map_err(network_error)
    }

    /// Downloads to `target`; `false` when the server has no such file.
    fn download(&self, path: &str, target: &Path) -> Result<bool, AppError> {
        let request = self
            .request(Method::GET, path)
            .body(())
            .map_err(network_error)?;
        let mut response = self.agent.run(request).map_err(network_error)?;
        let status = response.status().as_u16();
        if status == 404 {
            return Ok(false);
        }
        if !(200..300).contains(&status) {
            return Err(failure(status, ""));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let partial = target.with_extension("part");
        let mut file = fs::File::create(&partial)?;
        let mut reader = response.body_mut().with_config().limit(u64::MAX).reader();
        std::io::copy(&mut reader, &mut file).map_err(network_error)?;
        file.sync_all()?;
        fs::rename(&partial, target)?;
        Ok(true)
    }

    fn upload(&self, path: &str, file: &Path) -> Result<(), AppError> {
        let body = fs::File::open(file)?;
        let request = self
            .request(Method::PUT, path)
            .body(body)
            .map_err(network_error)?;
        let mut response = self.agent.run(request).map_err(network_error)?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let text = response.body_mut().read_to_string().unwrap_or_default();
        Err(failure(status, &text))
    }
}

impl SyncClient {
    /// Loads the connection and starts the worker and the long poll; both
    /// stay idle until a server is connected.
    pub fn start(root: &Path, storage: Arc<Mutex<Storage>>, events: Arc<dyn Events>) -> Self {
        let config: Config = fs::read_to_string(root.join(FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let connected = config.connected();
        let client = Self {
            inner: Arc::new(Inner {
                root: root.to_path_buf(),
                storage,
                events,
                config: Mutex::new(config),
                wake: Mutex::new(Wake::default()),
                signal: Condvar::new(),
                syncing: AtomicBool::new(false),
                open_book: Mutex::new(None),
            }),
        };
        let worker = client.clone();
        let _ = std::thread::Builder::new()
            .name("sync".into())
            .spawn(move || worker.work());
        let listener = client.clone();
        let _ = std::thread::Builder::new()
            .name("sync-wait".into())
            .spawn(move || listener.listen());
        if connected {
            client.now();
        }
        client
    }

    fn config(&self) -> Config {
        self.inner
            .config
            .lock()
            .map(|config| config.clone())
            .unwrap_or_default()
    }

    fn update(&self, change: impl FnOnce(&mut Config)) {
        let Ok(mut config) = self.inner.config.lock() else {
            return;
        };
        change(&mut config);
        let text = serde_json::to_string_pretty(&*config).unwrap_or_default();
        let path = self.inner.root.join(FILE);
        let partial = path.with_extension("json.part");
        if fs::write(&partial, text)
            .and_then(|()| fs::rename(&partial, &path))
            .is_err()
        {
            crate::app_log::warn("sync", "服务器同步设置保存失败");
        }
    }

    pub fn connected(&self) -> bool {
        self.config().connected()
    }

    /// The connected server's address and session token.
    pub fn server(&self) -> Option<(String, String)> {
        let config = self.config();
        config.connected().then_some((config.address, config.token))
    }

    pub fn status(&self) -> SyncServerStatus {
        let config = self.config();
        SyncServerStatus {
            connected: config.connected(),
            address: config.address,
            device_name: config.device_name,
            syncing: self.inner.syncing.load(Ordering::Acquire),
            last_sync: config.last_sync,
            last_error: config.last_error,
            auto_download: config.auto_download,
        }
    }

    fn announce(&self) {
        if let Ok(status) = serde_json::to_value(self.status()) {
            self.inner.events.emit("sync-status", status);
        }
    }

    /// A change here: a round follows once changes pause.
    pub fn changed(&self) {
        if !self.connected() {
            return;
        }
        if let Ok(mut wake) = self.inner.wake.lock() {
            let now = Instant::now();
            wake.changed = Some(match wake.changed {
                Some((first, _)) => (first, now),
                None => (now, now),
            });
        }
        self.inner.signal.notify_all();
    }

    /// A round as soon as the worker is free (立即同步, start, foreground).
    pub fn now(&self) {
        if let Ok(mut wake) = self.inner.wake.lock() {
            wake.now = true;
        }
        self.inner.signal.notify_all();
    }

    /// Runs a round and waits for it, at most `timeout` (opening a book).
    pub fn sync_and_wait(&self, timeout: Duration) {
        if !self.connected() {
            return;
        }
        let Ok(mut wake) = self.inner.wake.lock() else {
            return;
        };
        let target = wake.rounds + 1 + u64::from(self.inner.syncing.load(Ordering::Acquire));
        wake.now = true;
        self.inner.signal.notify_all();
        let deadline = Instant::now() + timeout;
        while wake.rounds < target {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            wake = match self.inner.signal.wait_timeout(wake, left) {
                Ok((wake, _)) => wake,
                Err(_) => return,
            };
        }
    }

    pub fn set_open_book(&self, book_id: Option<String>) {
        if let Ok(mut open) = self.inner.open_book.lock() {
            *open = book_id;
        }
    }

    pub fn set_auto_download(&self, on: bool) {
        self.update(|config| config.auto_download = on);
        if on {
            self.now();
        }
        self.announce();
    }

    /// Signs in with the server's password and syncs from the start: the
    /// server's records apply first, then this device's others go up.
    pub fn connect(
        &self,
        request: &ConnectSyncServerRequest,
    ) -> Result<SyncServerStatus, AppError> {
        let address = normalize_address(&request.address);
        let device_name = request.device_name.trim().to_string();
        let http = Http {
            address: &address,
            token: "",
            agent: agent(Duration::from_secs(30)),
        };
        let reply: Value = http.json(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "password": request.password, "device": device_name })),
        )?;
        let token = reply["token"]
            .as_str()
            .ok_or_else(|| AppError::new(ErrorCode::Io, "服务器没有返回登录凭据"))?
            .to_string();
        self.inner
            .storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .sync_forget()?;
        self.update(|config| {
            *config = Config {
                address,
                token,
                device_name,
                auto_download: true,
                ..Config::default()
            };
        });
        crate::app_log::info("sync", "已连接服务器");
        self.now();
        Ok(self.status())
    }

    /// Signs this device out and stops syncing; WebDAV resumes.
    pub fn disconnect(&self) {
        let config = self.config();
        if config.connected() {
            let http = Http {
                address: &config.address,
                token: &config.token,
                agent: agent(Duration::from_secs(10)),
            };
            let _ = http.json::<Value>(Method::POST, "/api/auth/logout", None);
        }
        self.update(|config| *config = Config::default());
        crate::app_log::info("sync", "已断开服务器");
        self.announce();
    }

    fn work(&self) {
        let mut failures = 0u32;
        loop {
            {
                let Ok(mut wake) = self.inner.wake.lock() else {
                    return;
                };
                loop {
                    let now = Instant::now();
                    let due = wake
                        .changed
                        .map(|(first, last)| (last + QUIET).min(first + LONGEST));
                    let retry = wake.retry_at;
                    if wake.now
                        || due.is_some_and(|due| due <= now)
                        || retry.is_some_and(|retry| retry <= now)
                    {
                        break;
                    }
                    let next = [due, retry].into_iter().flatten().min();
                    wake = match next {
                        Some(at) => match self.inner.signal.wait_timeout(wake, at - now) {
                            Ok((wake, _)) => wake,
                            Err(_) => return,
                        },
                        None => match self.inner.signal.wait(wake) {
                            Ok(wake) => wake,
                            Err(_) => return,
                        },
                    };
                }
                wake.now = false;
                wake.changed = None;
                wake.retry_at = None;
            }
            if self.connected() {
                self.inner.syncing.store(true, Ordering::Release);
                self.announce();
                let result = self.round();
                self.inner.syncing.store(false, Ordering::Release);
                match result {
                    Ok(()) => {
                        failures = 0;
                        self.update(|config| {
                            config.last_sync = Some(now_millis());
                            config.last_error = None;
                        });
                    }
                    Err(error) => {
                        failures += 1;
                        crate::app_log::warn("sync", format!("同步失败：{}", error.message));
                        self.update(|config| config.last_error = Some(error.message.clone()));
                        let delay = RETRY_FIRST
                            .saturating_mul(2u32.saturating_pow(failures - 1))
                            .min(RETRY_LONGEST);
                        if let Ok(mut wake) = self.inner.wake.lock() {
                            wake.retry_at = Some(Instant::now() + delay);
                        }
                    }
                }
                self.announce();
            }
            if let Ok(mut wake) = self.inner.wake.lock() {
                wake.rounds += 1;
            }
            self.inner.signal.notify_all();
        }
    }

    /// Waits on the server for another device's change, then syncs.
    fn listen(&self) {
        let mut failures = 0u32;
        loop {
            let config = self.config();
            if !config.connected() {
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
            let http = Http {
                address: &config.address,
                token: &config.token,
                agent: agent(WAIT + Duration::from_secs(15)),
            };
            let path = format!("/api/sync/wait?since={}", config.cursor);
            match http.json::<Value>(Method::GET, &path, None) {
                Ok(reply) => {
                    failures = 0;
                    if reply["head"]
                        .as_i64()
                        .is_some_and(|head| head > config.cursor)
                    {
                        self.now();
                        // Let the round move the cursor before waiting again.
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
                Err(_) => {
                    failures += 1;
                    std::thread::sleep(Duration::from_secs((5 * u64::from(failures)).min(60)));
                }
            }
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Storage>, AppError> {
        self.inner
            .storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
    }

    fn round(&self) -> Result<(), AppError> {
        let config = self.config();
        let device = self.lock()?.stored_webdav()?.device_id;
        let http = Http {
            address: &config.address,
            token: &config.token,
            agent: agent(Duration::from_secs(120)),
        };
        let mut applied = false;
        let mut books = Vec::new();
        let mut cursor = config.cursor;
        loop {
            let reply: PullReply = http.json(
                Method::GET,
                &format!(
                    "/api/sync/pull?since={cursor}&limit={}",
                    protocol::PULL_LIMIT
                ),
                None,
            )?;
            let others: Vec<SyncChange> = reply
                .changes
                .into_iter()
                .filter(|change| change.device != device)
                .map(|change| SyncChange {
                    key: change.key,
                    value: change.value,
                })
                .collect();
            for change in &others {
                self.fetch_cover(&http, change)?;
                if let (Some(sha), Some(_)) = (change.key.strip_prefix("book:"), &change.value) {
                    books.push(sha.to_string());
                }
            }
            if !others.is_empty() {
                let open = self
                    .inner
                    .open_book
                    .lock()
                    .ok()
                    .and_then(|open| open.clone());
                let mut storage = self.lock()?;
                storage.sync_apply(&others)?;
                applied = true;
                // The open book's position from elsewhere is offered there.
                if let Some(book_id) = open {
                    if let Ok(Some(value)) = storage.synced_progress(&book_id) {
                        if value["deviceId"].as_str() != Some(device.as_str()) {
                            self.inner
                                .events
                                .emit("sync-progress", json!({ "bookId": book_id }));
                        }
                    }
                }
            }
            cursor = reply.head;
            self.update(|config| config.cursor = reply.head);
            if !reply.more {
                break;
            }
        }
        if config.auto_download {
            for sha in books {
                applied |= self.download_book(&http, &sha)?;
            }
        }
        if applied {
            self.inner.events.emit("sync-applied", Value::Null);
        }

        let changes = self.lock()?.sync_pending()?;
        if !changes.is_empty() {
            for change in &changes {
                self.send_cover(&http, change)?;
            }
            let reply: PushReply = http.json(
                Method::POST,
                "/api/sync/push",
                Some(serde_json::to_value(PushRequest {
                    device: device.clone(),
                    changes: changes.clone(),
                })?),
            )?;
            {
                let storage = self.lock()?;
                for change in &changes {
                    storage.sync_mark(change)?;
                }
            }
            self.update(|config| {
                for sha in reply.missing_books {
                    if !config.uploads.contains(&sha) {
                        config.uploads.push(sha);
                    }
                }
            });
            for name in &reply.missing_covers {
                let file = protocol::cover_file(&*self.lock()?, name)?;
                if let Some(file) = file {
                    http.upload(&format!("/api/blobs/cover/{name}"), &file)?;
                }
            }
        }
        for sha in self.config().uploads {
            let file = protocol::book_file(&*self.lock()?, &sha)?;
            if let Some(file) = file {
                http.upload(&format!("/api/blobs/book/{sha}"), &file)?;
            }
            self.update(|config| config.uploads.retain(|pending| pending != &sha));
        }
        Ok(())
    }

    /// Fetches a cover a record names when this device lacks it.
    fn fetch_cover(&self, http: &Http<'_>, change: &SyncChange) -> Result<(), AppError> {
        let Some(name) = cover_name(change) else {
            return Ok(());
        };
        let target = {
            let storage = self.lock()?;
            if protocol::cover_file(&storage, &name)?.is_some() {
                return Ok(());
            }
            storage.cover_cache().join(&name)
        };
        let partial = target.with_extension("download");
        if http.download(&format!("/api/blobs/cover/{name}"), &partial)? {
            let bytes = fs::read(&partial)?;
            let _ = fs::remove_file(&partial);
            protocol::store_cover(&self.inner.storage, &name, &bytes)?;
        }
        Ok(())
    }

    /// Sends the cover a pushed book record names (the server keeps one copy).
    fn send_cover(&self, http: &Http<'_>, change: &SyncChange) -> Result<(), AppError> {
        let Some(name) = cover_name(change) else {
            return Ok(());
        };
        let file = protocol::cover_file(&*self.lock()?, &name)?;
        if let Some(file) = file {
            http.upload(&format!("/api/blobs/cover/{name}"), &file)?;
        }
        Ok(())
    }

    /// Downloads and imports a book the server has and this device lacks.
    fn download_book(&self, http: &Http<'_>, sha: &str) -> Result<bool, AppError> {
        if !protocol::valid_sha256(sha) || self.lock()?.book_for_source(sha)?.is_some() {
            return Ok(false);
        }
        let target = self
            .inner
            .root
            .join("sync-downloads")
            .join(format!("{sha}.txt"));
        if !http.download(&format!("/api/blobs/book/{sha}"), &target)? {
            return Ok(false);
        }
        let imported = protocol::import_book_file(&self.inner.storage, sha, &target);
        let _ = fs::remove_file(&target);
        imported
    }
}

fn cover_name(change: &SyncChange) -> Option<String> {
    change.key.strip_prefix("book:")?;
    let cover = change.value.as_ref()?.get("cover")?;
    let name = format!(
        "{}.{}",
        cover.get("sha256")?.as_str()?,
        cover.get("ext")?.as_str()?
    );
    protocol::valid_cover_name(&name).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_get_a_scheme_and_lose_trailing_slashes() {
        assert_eq!(
            normalize_address("reader.example.com/"),
            "https://reader.example.com"
        );
        assert_eq!(
            normalize_address(" http://10.0.0.2:8080// "),
            "http://10.0.0.2:8080"
        );
    }
}
