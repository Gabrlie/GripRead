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
use crate::models::{ConnectSyncServerRequest, OnlineChapter, SyncServerStatus};
use crate::storage::{Storage, SyncChange};
use crate::sync::{
    self as protocol, PullReply, PushReply, PushRequest, ServerBook, ShelfUpdateReply,
    ShelfUpdateRequest,
};

const FILE: &str = "sync-server.json";
/// The last sign-in (address, device name, password), kept after
/// disconnecting so connecting again needs no typing; never in backups.
const LOGIN_FILE: &str = "sync-server-login.json";
const QUIET: Duration = Duration::from_secs(3);
const LONGEST: Duration = Duration::from_secs(10);
/// While a book is open, progress goes up at least this often.
const READING_ROUND: Duration = Duration::from_secs(5 * 60);
const RETRY_FIRST: Duration = Duration::from_secs(30);
const RETRY_LONGEST: Duration = Duration::from_secs(300);
/// A chapter the server may first have to fetch from its source.
const CHAPTER_TIMEOUT: Duration = Duration::from_secs(60);
/// A whole shelf update on the server.
const SHELF_UPDATE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

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
    /// 通过服务器更新书籍 is off: 更新目录 fetches the contents here.
    update_here: bool,
    /// Books the server asked for that are not sent yet.
    uploads: Vec<String>,
}

impl Config {
    fn connected(&self) -> bool {
        !self.address.is_empty() && !self.token.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct Login {
    address: String,
    device_name: String,
    password: String,
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
    /// Rounds keep their connections between requests.
    agent: ureq::Agent,
    /// Covers known to be on the server this session, so a book record
    /// changed by reading does not send its cover again.
    covers: Mutex<std::collections::HashSet<String>>,
    /// The app is in the background, where the system may cut connections.
    background: AtomicBool,
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
    AppError::keyed(
        ErrorCode::Io,
        "serverUnreachable",
        format!("服务器连接失败：{error}"),
    )
    .with("error", &error)
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
    let value = serde_json::from_str::<Value>(body).ok();
    let message = value
        .as_ref()
        .and_then(|value| value["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("HTTP {status}"));
    let code = if status == 401 {
        ErrorCode::InvalidArgument
    } else {
        ErrorCode::Io
    };
    // The server's key, when it sent one, travels on for translation.
    match value.as_ref().and_then(|value| value["key"].as_str()) {
        Some(key) => AppError::keyed(code, key, message),
        None => AppError::new(code, message),
    }
}

struct Http<'a> {
    address: &'a str,
    token: &'a str,
    agent: ureq::Agent,
}

/// An older server answered with its page: it lacks the route.
fn too_old() -> AppError {
    AppError::keyed(
        ErrorCode::InvalidArgument,
        "serverTooOld",
        "服务器版本较旧，不支持这个功能，请更新服务器",
    )
}

/// A request answered by the page rather than the API (a server too old to
/// know the route) or refused for its method.
fn unknown_route(status: u16) -> bool {
    status == 404 || status == 405
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
        if crate::online_reader::is_web_page(&text) {
            return Err(too_old());
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
    /// Loads the connection and starts the worker, which stays idle until a
    /// server is connected. Rounds run on events, not continuously: changes
    /// to what sync carries (after they pause), opening and closing a book,
    /// leaving and returning to the app, a changed network, 立即同步, and
    /// every few minutes while a book is open.
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
                agent: agent(Duration::from_secs(120)),
                covers: Mutex::default(),
                background: AtomicBool::new(false),
            }),
        };
        let worker = client.clone();
        let _ = std::thread::Builder::new()
            .name("sync".into())
            .spawn(move || worker.work());
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
            crate::log_keyed!(
                Warn,
                "sync",
                "serverSettingsUnsaved",
                "服务器同步设置保存失败"
            );
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
        let login = (!config.connected()).then(|| self.login()).flatten();
        SyncServerStatus {
            connected: config.connected(),
            remembered: login.is_some(),
            address: login
                .as_ref()
                .map_or(config.address, |login| login.address.clone()),
            device_name: login.map_or(config.device_name, |login| login.device_name),
            syncing: self.inner.syncing.load(Ordering::Acquire),
            last_sync: config.last_sync,
            last_error: config.last_error,
            auto_download: config.auto_download,
            update_via_server: !config.update_here,
        }
    }

    fn login(&self) -> Option<Login> {
        fs::read_to_string(self.inner.root.join(LOGIN_FILE))
            .ok()
            .and_then(|text| serde_json::from_str::<Login>(&text).ok())
            .filter(|login| !login.address.is_empty())
    }

    /// 忘记登录信息.
    pub fn forget_login(&self) {
        let _ = fs::remove_file(self.inner.root.join(LOGIN_FILE));
        self.announce();
    }

    /// The app went to the background or came back. In the background the
    /// system may cut connections, so failures there are retried quietly.
    pub fn set_background(&self, background: bool) {
        self.inner.background.store(background, Ordering::Release);
        // Leaving sends what reading changed; returning catches up.
        self.now();
    }

    fn background(&self) -> bool {
        self.inner.background.load(Ordering::Acquire)
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

    /// A chapter from the server, which keeps chapters it fetched and can
    /// reach sources this device cannot; `None` when not connected or the
    /// server could not give it.
    pub fn fetch_chapter(&self, key: &str, chapter: &OnlineChapter) -> Option<String> {
        let config = self.config();
        if !config.connected() {
            return None;
        }
        let mut response = self
            .inner
            .agent
            .get(format!("{}/api/sync/chapter", config.address))
            .config()
            .timeout_recv_response(Some(CHAPTER_TIMEOUT))
            .build()
            .query("key", key)
            .query("url", &chapter.url)
            .query("title", &chapter.title)
            .header("Authorization", format!("Bearer {}", config.token))
            .call()
            .ok()?;
        // An older server answers routes it lacks with its page.
        let text_reply = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/plain"));
        if response.status().as_u16() != 200 || !text_reply {
            return None;
        }
        response.body_mut().read_to_string().ok()
    }

    /// 通过服务器访问: sends a book source's hop through the server; an
    /// error when not connected or the server could not send it.
    pub fn relay_hop(
        &self,
        hop: &crate::sources::http::Hop,
    ) -> Result<crate::sources::http::HopAnswer, String> {
        let config = self.config();
        if !config.connected() {
            return Err("未连接服务器".into());
        }
        let body = serde_json::to_string(&crate::sources::http::RelayHop::from_hop(hop))
            .map_err(|error| error.to_string())?;
        let mut response = self
            .inner
            .agent
            .post(format!("{}/api/source/fetch", config.address))
            .config()
            .timeout_recv_response(Some(hop.timeout + Duration::from_secs(10)))
            .http_status_as_error(false)
            .build()
            .header("Authorization", format!("Bearer {}", config.token))
            .header("Content-Type", "application/json")
            .send(body)
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_string()
            .map_err(|error| error.to_string())?;
        if status != 200 {
            let message = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| value["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| format!("服务器返回 {status}"));
            return Err(message);
        }
        serde_json::from_str::<crate::sources::http::RelayAnswer>(&text)
            .map_err(|error| error.to_string())?
            .to_answer()
    }

    /// 更新书架 on the server, which then syncs the new chapters here;
    /// `None` when the server is too old to do it.
    pub fn update_shelf(&self, keys: Vec<String>) -> Result<Option<ShelfUpdateReply>, AppError> {
        let config = self.config();
        if !config.connected() {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "notConnected",
                "未连接服务器",
            ));
        }
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("{}/api/jobs/update", config.address))
            .header("Authorization", format!("Bearer {}", config.token))
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&ShelfUpdateRequest { keys })?)
            .map_err(network_error)?;
        let mut response = agent(SHELF_UPDATE_TIMEOUT)
            .run(request)
            .map_err(network_error)?;
        let status = response.status().as_u16();
        if unknown_route(status) {
            return Ok(None);
        }
        let text = response
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_string()
            .map_err(network_error)?;
        if !(200..300).contains(&status) {
            return Err(failure(status, &text));
        }
        serde_json::from_str(&text).map(Some).map_err(network_error)
    }

    /// 服务器管理 from the app: the connected server's management routes,
    /// sent with this device's session. Other paths are refused.
    pub fn api(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, AppError> {
        let config = self.config();
        if !config.connected() {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "notConnected",
                "未连接服务器",
            ));
        }
        let method = Method::from_bytes(method.to_ascii_uppercase().as_bytes())
            .map_err(|_| AppError::invalid_argument("unknown method"))?;
        if !management_route(&method, path) {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "badRoute",
                "不支持的服务器接口",
            ));
        }
        let timeout = if path == "/api/jobs/update" {
            SHELF_UPDATE_TIMEOUT
        } else {
            Duration::from_secs(30)
        };
        let next_password = (path == "/api/auth/password")
            .then(|| body.as_ref()?.get("next")?.as_str().map(str::to_string))
            .flatten();
        let request = Request::builder()
            .method(method)
            .uri(format!("{}{path}", config.address))
            .header("Authorization", format!("Bearer {}", config.token))
            .header("Content-Type", "application/json")
            .body(body.map(|body| body.to_string()).unwrap_or_default())
            .map_err(network_error)?;
        let mut response = agent(timeout).run(request).map_err(network_error)?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(16 * 1024 * 1024)
            .read_to_string()
            .map_err(network_error)?;
        if unknown_route(status) || crate::online_reader::is_web_page(&text) {
            return Err(too_old());
        }
        if !(200..300).contains(&status) {
            return Err(failure(status, &text));
        }
        // The kept sign-in follows a password changed from here.
        if let (Some(next), Some(mut login)) = (next_password, self.login()) {
            login.password = next;
            if let Ok(text) = serde_json::to_string_pretty(&login) {
                let _ = fs::write(self.inner.root.join(LOGIN_FILE), text);
            }
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(network_error)
    }

    /// 订阅 refreshed on the server; `None` when the server is too old.
    pub fn rss_refresh(
        &self,
        urls: Vec<String>,
    ) -> Result<Option<protocol::RssRefreshReply>, AppError> {
        let config = self.config();
        if !config.connected() {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "notConnected",
                "未连接服务器",
            ));
        }
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("{}/api/rss/refresh", config.address))
            .header("Authorization", format!("Bearer {}", config.token))
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&protocol::RssRefreshRequest {
                urls,
            })?)
            .map_err(network_error)?;
        let mut response = agent(Duration::from_secs(5 * 60))
            .run(request)
            .map_err(network_error)?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(16 * 1024 * 1024)
            .read_to_string()
            .map_err(network_error)?;
        if unknown_route(status) || crate::online_reader::is_web_page(&text) {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(failure(status, &text));
        }
        serde_json::from_str(&text).map(Some).map_err(network_error)
    }

    /// 全文 of the page at `link`, read by the server; `None` when the
    /// server is too old to.
    pub fn rss_full_text(&self, link: &str) -> Result<Option<String>, AppError> {
        let config = self.config();
        if !config.connected() {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "notConnected",
                "未连接服务器",
            ));
        }
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("{}/api/rss/fulltext", config.address))
            .header("Authorization", format!("Bearer {}", config.token))
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&protocol::RssFullTextRequest {
                link: link.to_string(),
            })?)
            .map_err(network_error)?;
        let mut response = agent(Duration::from_secs(60))
            .run(request)
            .map_err(network_error)?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(16 * 1024 * 1024)
            .read_to_string()
            .map_err(network_error)?;
        if unknown_route(status) || crate::online_reader::is_web_page(&text) {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(failure(status, &text));
        }
        serde_json::from_str::<protocol::RssFullTextReply>(&text)
            .map(|reply| Some(reply.html))
            .map_err(network_error)
    }

    /// A feed's articles the server fetched since `since`; `None` when the
    /// server does not have the feed (or the route).
    pub fn rss_articles(
        &self,
        url: &str,
        since: i64,
    ) -> Result<Option<protocol::RssArticlesReply>, AppError> {
        let config = self.config();
        if !config.connected() {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "notConnected",
                "未连接服务器",
            ));
        }
        let mut response = self
            .inner
            .agent
            .get(format!("{}/api/rss/articles", config.address))
            .query("feed", url)
            .query("since", since.to_string())
            .header("Authorization", format!("Bearer {}", config.token))
            .call()
            .map_err(network_error)?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_string()
            .map_err(network_error)?;
        if unknown_route(status) || crate::online_reader::is_web_page(&text) {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(failure(status, &text));
        }
        serde_json::from_str(&text).map(Some).map_err(network_error)
    }

    /// 云书架 while connected: the books whose files the server keeps.
    pub fn server_books(&self) -> Result<Vec<ServerBook>, AppError> {
        let config = self.config();
        if !config.connected() {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "notConnected",
                "未连接服务器",
            ));
        }
        let http = Http {
            address: &config.address,
            token: &config.token,
            agent: self.inner.agent.clone(),
        };
        http.json(Method::GET, "/api/cloud/books", None)
    }

    /// Downloads a book the server keeps to `target`.
    pub fn download_server_book(&self, sha256: &str, target: &Path) -> Result<(), AppError> {
        let config = self.config();
        if !config.connected() {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "notConnected",
                "未连接服务器",
            ));
        }
        if !protocol::valid_sha256(sha256) {
            return Err(AppError::invalid_argument("unknown server book"));
        }
        let http = Http {
            address: &config.address,
            token: &config.token,
            agent: self.inner.agent.clone(),
        };
        if http.download(&format!("/api/blobs/book/{sha256}"), target)? {
            Ok(())
        } else {
            Err(AppError::keyed(
                ErrorCode::NotFound,
                "serverNoBook",
                "服务器上没有这本书",
            ))
        }
    }

    /// Sends these books' files (by SHA-256) in the next round.
    pub fn queue_uploads(&self, books: &[String]) {
        self.update(|config| {
            for sha in books {
                if !config.uploads.contains(sha) {
                    config.uploads.push(sha.clone());
                }
            }
        });
        self.now();
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

    /// The reader opened a book or closed it; closing sends its progress.
    pub fn set_open_book(&self, book_id: Option<String>) {
        let closed = book_id.is_none();
        if let Ok(mut open) = self.inner.open_book.lock() {
            *open = book_id;
        }
        if closed {
            self.changed();
        }
        // The worker's reading timer follows the open book.
        self.inner.signal.notify_all();
    }

    fn reading(&self) -> bool {
        self.inner.open_book.lock().is_ok_and(|open| open.is_some())
    }

    /// Whether 更新目录 asks the server while connected.
    pub fn updates_through_server(&self) -> bool {
        let config = self.config();
        config.connected() && !config.update_here
    }

    pub fn set_update_via_server(&self, on: bool) {
        self.update(|config| config.update_here = !on);
        self.announce();
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
        // An empty password reuses the kept one for the same server.
        let password = match self.login() {
            Some(login) if request.password.is_empty() && login.address == address => {
                login.password
            }
            _ => request.password.clone(),
        };
        let http = Http {
            address: &address,
            token: "",
            agent: agent(Duration::from_secs(30)),
        };
        let reply: Value = http.json(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "password": password, "device": device_name })),
        )?;
        let token = reply["token"]
            .as_str()
            .ok_or_else(|| AppError::keyed(ErrorCode::Io, "noToken", "服务器没有返回登录凭据"))?
            .to_string();
        self.inner
            .storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .sync_forget()?;
        let login = Login {
            address: address.clone(),
            device_name: device_name.clone(),
            password,
        };
        if fs::write(
            self.inner.root.join(LOGIN_FILE),
            serde_json::to_string_pretty(&login)?,
        )
        .is_err()
        {
            crate::log_keyed!(Warn, "sync", "serverLoginUnsaved", "服务器登录信息保存失败");
        }
        if let Ok(mut covers) = self.inner.covers.lock() {
            covers.clear();
        }
        self.update(|config| {
            *config = Config {
                address,
                token,
                device_name,
                auto_download: true,
                ..Config::default()
            };
        });
        crate::log_keyed!(Info, "sync", "serverConnected", "已连接服务器");
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
        if let Ok(storage) = self.lock() {
            let _ = storage.forget_server_books();
        }
        crate::log_keyed!(Info, "sync", "serverDisconnected", "已断开服务器");
        self.announce();
    }

    fn work(&self) {
        let mut failures = 0u32;
        let mut last_round = Instant::now();
        loop {
            {
                let Ok(mut wake) = self.inner.wake.lock() else {
                    return;
                };
                loop {
                    let now = Instant::now();
                    // After a failure, changes wait for the retry; events
                    // (`now`) still run a round.
                    let due = wake
                        .changed
                        .map(|(first, last)| (last + QUIET).min(first + LONGEST))
                        .map(|due| wake.retry_at.map_or(due, |retry| due.max(retry)));
                    let retry = wake.retry_at;
                    let reading = (self.connected() && !self.background() && self.reading())
                        .then_some(last_round + READING_ROUND);
                    if wake.now
                        || due.is_some_and(|due| due <= now)
                        || retry.is_some_and(|retry| retry <= now)
                        || reading.is_some_and(|at| at <= now)
                    {
                        break;
                    }
                    let next = [due, retry, reading].into_iter().flatten().min();
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
                last_round = Instant::now();
                self.inner.syncing.store(false, Ordering::Release);
                match result {
                    Ok(()) => {
                        if failures > 0 {
                            crate::log_keyed!(Info, "sync", "syncRecovered", "服务器同步已恢复");
                        }
                        failures = 0;
                        self.update(|config| {
                            config.last_sync = Some(now_millis());
                            config.last_error = None;
                        });
                    }
                    Err(error) if self.background() => {
                        // The system cut the connection; coming back retries.
                        crate::log_keyed!(
                            Info,
                            "sync",
                            "syncPaused",
                            format!("后台同步中断，回到前台后重试：{}", error.message),
                            @error error,
                        );
                    }
                    Err(error) => {
                        failures += 1;
                        // One line for an outage, however many rounds it fails.
                        if failures == 1 {
                            crate::log_keyed!(
                                Warn,
                                "sync",
                                "syncFailed",
                                format!("同步失败，稍后重试：{}", error.message),
                                @error error,
                            );
                        }
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
            agent: self.inner.agent.clone(),
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
                // The open book's position from elsewhere is offered there,
                // when this round brought a new one.
                if let Some(book_id) = open {
                    let arrived = storage
                        .synced_progress_key(&book_id)
                        .ok()
                        .flatten()
                        .is_some_and(|key| others.iter().any(|change| change.key == key));
                    let value = if arrived {
                        storage.synced_progress(&book_id).ok().flatten()
                    } else {
                        None
                    };
                    if let Some(value) = value {
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
                // Books whose files the server did not ask for are there.
                let held: Vec<String> = changes
                    .iter()
                    .filter(|change| change.value.is_some())
                    .filter_map(|change| change.key.strip_prefix("book:"))
                    .filter(|sha| !reply.missing_books.iter().any(|missing| missing == sha))
                    .map(str::to_string)
                    .collect();
                storage.mark_on_server(&held)?;
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
            // The covers the server did not ask for are there.
            if let Ok(mut known) = self.inner.covers.lock() {
                known.extend(
                    changes
                        .iter()
                        .filter_map(cover_name)
                        .filter(|name| !reply.missing_covers.contains(name)),
                );
                known.extend(reply.missing_covers.iter().cloned());
            }
        }
        for sha in self.config().uploads {
            // A book a private group keeps on the device is never sent,
            // even when the server asks for its file.
            let kept = {
                let storage = self.lock()?;
                match storage.book_for_source(&sha)? {
                    Some(id) => storage.keeps_book_private(&id)?,
                    None => false,
                }
            };
            if kept {
                self.update(|config| config.uploads.retain(|pending| pending != &sha));
                continue;
            }
            let file = protocol::book_file(&*self.lock()?, &sha)?;
            if let Some(file) = file {
                http.upload(&format!("/api/blobs/book/{sha}"), &file)?;
                self.lock()?.mark_on_server(std::slice::from_ref(&sha))?;
                // The shelf's cloud mark changed.
                self.inner.events.emit("sync-applied", Value::Null);
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
            self.knows_cover(&name);
        }
        Ok(())
    }

    /// Sends the cover a pushed book record names (the server keeps one copy).
    fn send_cover(&self, http: &Http<'_>, change: &SyncChange) -> Result<(), AppError> {
        let Some(name) = cover_name(change) else {
            return Ok(());
        };
        let known = self
            .inner
            .covers
            .lock()
            .is_ok_and(|known| known.contains(&name));
        if known {
            return Ok(());
        }
        let file = protocol::cover_file(&*self.lock()?, &name)?;
        if let Some(file) = file {
            http.upload(&format!("/api/blobs/cover/{name}"), &file)?;
            self.knows_cover(&name);
        }
        Ok(())
    }

    fn knows_cover(&self, name: &str) {
        if let Ok(mut known) = self.inner.covers.lock() {
            known.insert(name.to_string());
        }
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

/// The routes 服务器管理 may use from the app.
fn management_route(method: &Method, path: &str) -> bool {
    match (method.as_str(), path) {
        ("GET" | "PUT", "/api/jobs") | ("POST", "/api/jobs/update") => true,
        ("GET", "/api/auth/sessions") | ("POST", "/api/auth/password") => true,
        ("DELETE", path) => path.strip_prefix("/api/auth/sessions/").is_some_and(|id| {
            !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        }),
        _ => false,
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
    fn only_management_routes_go_through_the_app() {
        assert!(management_route(&Method::GET, "/api/jobs"));
        assert!(management_route(&Method::PUT, "/api/jobs"));
        assert!(management_route(&Method::POST, "/api/jobs/update"));
        assert!(management_route(
            &Method::DELETE,
            "/api/auth/sessions/0f3a-9b"
        ));
        assert!(!management_route(
            &Method::DELETE,
            "/api/auth/sessions/../rpc"
        ));
        assert!(!management_route(&Method::POST, "/api/rpc/delete_book"));
        assert!(!management_route(&Method::GET, "/api/sync/pull"));
        assert!(!management_route(&Method::POST, "/api/auth/logout"));
    }

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
