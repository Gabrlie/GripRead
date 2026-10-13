//! GripRead's server: the core's commands over HTTP for the web version
//! (`POST /api/rpc/{name}`), its events over a WebSocket (`/api/events`),
//! uploads that stand in for picked files, and the built page. One account
//! guards everything but sign-in and the page itself.

pub mod auth;
mod paths;

use auth::{Auth, AuthError, Session};
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use gripread_core::api::{self, Events, Reply};
use gripread_core::commands::AppState;
use gripread_core::error::AppError;
use gripread_core::platform::Platform;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;

const COOKIE: &str = "gripread_session";
/// The largest file one upload may carry.
const UPLOAD_LIMIT: u64 = 1 << 30;
/// Uploads older than this are removed at start; imports copy what they keep.
const UPLOAD_KEEP: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

pub struct Config {
    /// The data folder: the library, `server.json`, and uploads.
    pub data: PathBuf,
    /// The built page (`dist/`), served at `/` when present.
    pub web: Option<PathBuf>,
    /// Sets the password on first run, for unattended setups.
    pub password: Option<String>,
}

/// A file a command wrote for the reader to keep (a backup, exported
/// sources), held until the page downloads it from `/api/export`.
struct Export {
    name: String,
    mime: String,
    bytes: Vec<u8>,
}

type ExportSlot = Arc<Mutex<Option<Export>>>;

/// Core events to every open WebSocket, as `{ event, payload }`.
struct Broadcast(broadcast::Sender<String>);

impl Events for Broadcast {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self
            .0
            .send(json!({ "event": event, "payload": payload }).to_string());
    }
}

/// Files on the server are uploads (see [`paths`]); a document "saved"
/// for the reader is kept for the page to download.
struct ServerPlatform(ExportSlot);

impl Platform for ServerPlatform {
    fn list_txt_folder(
        &self,
        _path: &str,
    ) -> Result<Vec<gripread_core::models::PickedFile>, AppError> {
        Err(AppError::invalid_argument("网页版请直接选择多个文件上传"))
    }

    fn save_document(
        &self,
        _path: Option<&str>,
        name: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<bool, AppError> {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Export {
            name: name.to_string(),
            mime: mime.to_string(),
            bytes: bytes.to_vec(),
        });
        Ok(true)
    }

    fn pick_writable_folder(
        &self,
        _path: Option<&str>,
    ) -> Result<Option<(String, String)>, AppError> {
        Err(AppError::invalid_argument("服务器不使用本地备份文件夹"))
    }
}

pub struct Server {
    core: Arc<AppState>,
    auth: Auth,
    events: broadcast::Sender<String>,
    uploads: PathBuf,
    exports: ExportSlot,
}

/// Opens the data folder and builds the routes.
pub fn app(config: Config) -> Result<Router, String> {
    std::fs::create_dir_all(&config.data).map_err(|error| error.to_string())?;
    let auth =
        Auth::open(&config.data, config.password.as_deref()).map_err(|error| match error {
            AuthError::TooShort => format!("GRIPREAD_PASSWORD 至少 {} 位", auth::MIN_PASSWORD),
            other => format!("{other:?}"),
        })?;
    let (events, _) = broadcast::channel(256);
    let exports: ExportSlot = Arc::default();
    let core = AppState::open(
        config.data.join("library"),
        Arc::new(Broadcast(events.clone())),
        Arc::new(ServerPlatform(exports.clone())),
    )
    .map_err(|error| error.message)?;
    let uploads = config.data.join("uploads");
    clear_old_uploads(&uploads);
    let server = Arc::new(Server {
        core,
        auth,
        events,
        uploads,
        exports,
    });
    let api = Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/setup", post(setup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/password", post(change_password))
        .route("/api/auth/sessions", get(sessions))
        .route("/api/auth/sessions/{id}", delete(revoke))
        .route("/api/rpc/{name}", post(rpc))
        .route("/api/upload", post(upload))
        .route("/api/export", get(export))
        .route("/api/events", get(events_socket))
        .layer(axum::extract::DefaultBodyLimit::max(64 << 20))
        .with_state(server);
    Ok(match config.web {
        Some(web) => {
            let index = web.join("index.html");
            api.fallback_service(
                tower_http::services::ServeDir::new(web)
                    .fallback(tower_http::services::ServeFile::new(index)),
            )
        }
        None => api,
    })
}

fn clear_old_uploads(uploads: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(uploads) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > UPLOAD_KEEP);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn failure(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "code": code, "message": message }))).into_response()
}

fn app_error(error: AppError) -> Response {
    (StatusCode::BAD_REQUEST, Json(error)).into_response()
}

fn auth_error(error: AuthError) -> Response {
    match error {
        AuthError::WrongState => {
            failure(StatusCode::CONFLICT, "auth_state", "账号状态已变化，请刷新")
        }
        AuthError::BadPassword => failure(StatusCode::UNAUTHORIZED, "unauthorized", "密码不对"),
        AuthError::TooMany => failure(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "尝试次数过多，请一分钟后再试",
        ),
        AuthError::TooShort => failure(
            StatusCode::BAD_REQUEST,
            "invalid_argument",
            &format!("密码至少 {} 位", auth::MIN_PASSWORD),
        ),
        AuthError::Io(message) => failure(StatusCode::INTERNAL_SERVER_ERROR, "io", &message),
    }
}

fn token_of<'a>(headers: &'a HeaderMap, query: Option<&'a str>) -> Option<&'a str> {
    if let Some(bearer) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    {
        return Some(bearer.trim());
    }
    let cookies = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok());
    for cookie in cookies.flat_map(|line| line.split(';')) {
        if let Some(token) = cookie.trim().strip_prefix(&format!("{COOKIE}=")) {
            return Some(token);
        }
    }
    query
}

impl Server {
    fn signed_in(&self, headers: &HeaderMap, query: Option<&str>) -> Option<Session> {
        token_of(headers, query).and_then(|token| self.auth.session(token))
    }
}

fn unauthorized() -> Response {
    failure(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录")
}

/// The session cookie; `Secure` when the page came over HTTPS (through a
/// reverse proxy that says so).
fn session_cookie(headers: &HeaderMap, token: &str) -> HeaderValue {
    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"));
    let value = format!(
        "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000{}",
        if secure { "; Secure" } else { "" }
    );
    HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

async fn status(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    let session = token_of(&headers, None).and_then(|token| server.auth.session(token));
    Json(json!({
        "configured": server.auth.configured(),
        "signedIn": session.is_some(),
        "device": session.map(|session| session.device),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct Credentials {
    password: String,
    #[serde(default)]
    device: String,
}

fn signed_in_reply(headers: &HeaderMap, token: String) -> Response {
    let mut response = Json(json!({ "token": token })).into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, session_cookie(headers, &token));
    response
}

async fn setup(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(credentials): Json<Credentials>,
) -> Response {
    match server
        .auth
        .setup(&credentials.password, &credentials.device)
    {
        Ok(token) => signed_in_reply(&headers, token),
        Err(error) => auth_error(error),
    }
}

async fn login(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(credentials): Json<Credentials>,
) -> Response {
    let auth_server = server.clone();
    let result = tokio::task::spawn_blocking(move || {
        auth_server
            .auth
            .login(&credentials.password, &credentials.device)
    })
    .await;
    match result {
        Ok(Ok(token)) => signed_in_reply(&headers, token),
        Ok(Err(error)) => auth_error(error),
        Err(error) => failure(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    }
}

async fn logout(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    if let Some(session) = server.signed_in(&headers, None) {
        let _ = server.auth.revoke(&session.id);
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("gripread_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
    );
    response
}

#[derive(Deserialize)]
struct PasswordChange {
    current: String,
    next: String,
}

async fn change_password(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(change): Json<PasswordChange>,
) -> Response {
    let Some(session) = server.signed_in(&headers, None) else {
        return unauthorized();
    };
    match server
        .auth
        .change_password(&change.current, &change.next, &session.id)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth_error(error),
    }
}

async fn sessions(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    let Some(session) = server.signed_in(&headers, None) else {
        return unauthorized();
    };
    let current = session.id;
    let list: Vec<Value> = server
        .auth
        .sessions()
        .into_iter()
        .map(|session| {
            let mut value = serde_json::to_value(&session).unwrap_or_default();
            value["current"] = Value::Bool(session.id == current);
            value
        })
        .collect();
    Json(list).into_response()
}

async fn revoke(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    match server.auth.revoke(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => failure(StatusCode::NOT_FOUND, "not_found", "没有这台设备"),
        Err(error) => auth_error(error),
    }
}

async fn rpc(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Bytes,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let mut args: Value = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(args) => args,
            Err(error) => {
                return failure(
                    StatusCode::BAD_REQUEST,
                    "invalid_argument",
                    &error.to_string(),
                )
            }
        }
    };
    if let Err(error) = paths::admit(&mut args, &server.uploads) {
        return app_error(error);
    }
    match api::dispatch(&server.core, &name, args).await {
        Ok(Reply::Json(value)) => Json(value).into_response(),
        Ok(Reply::Bytes(bytes)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        Err(error) => app_error(error),
    }
}

#[derive(Deserialize)]
struct UploadQuery {
    name: String,
}

/// Stores one file and answers the `upload:` path commands accept for it.
async fn upload(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Query(query): Query<UploadQuery>,
    body: Body,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let name = paths::file_name(&query.name);
    let id = uuid::Uuid::new_v4().to_string();
    let folder = server.uploads.join(&id);
    let target = folder.join(&name);
    let written: Result<(), String> = async {
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|error| error.to_string())?;
        let mut file = tokio::fs::File::create(&target)
            .await
            .map_err(|error| error.to_string())?;
        let mut stream = body.into_data_stream();
        let mut total = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| error.to_string())?;
            total += chunk.len() as u64;
            if total > UPLOAD_LIMIT {
                return Err("文件太大".to_string());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| error.to_string())?;
        }
        file.flush().await.map_err(|error| error.to_string())
    }
    .await;
    match written {
        Ok(()) => Json(json!({ "path": paths::token(&id, &name), "name": name })).into_response(),
        Err(message) => {
            let _ = tokio::fs::remove_dir_all(&folder).await;
            failure(StatusCode::BAD_REQUEST, "io", &message)
        }
    }
}

/// The file the last command saved for the reader, once.
async fn export(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let taken = server
        .exports
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    let Some(export) = taken else {
        return failure(StatusCode::NOT_FOUND, "not_found", "没有可下载的文件");
    };
    let disposition = format!(
        "attachment; filename=\"export\"; filename*=UTF-8''{}",
        paths::percent_encode(&export.name)
    );
    (
        [
            (header::CONTENT_TYPE, export.mime),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        export.bytes,
    )
        .into_response()
}

#[derive(Deserialize)]
struct SocketQuery {
    token: Option<String>,
}

async fn events_socket(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Query(query): Query<SocketQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if server.signed_in(&headers, query.token.as_deref()).is_none() {
        return unauthorized();
    }
    let receiver = server.events.subscribe();
    upgrade.on_upgrade(move |socket| forward(socket, receiver))
}

/// Sends core events to one socket until either side closes.
async fn forward(socket: WebSocket, mut events: broadcast::Receiver<String>) {
    let (mut sender, mut incoming) = socket.split();
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(text) => {
                    if sender.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                // A slow page missed some progress; later events still come.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            message = incoming.next() => match message {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

#[cfg(test)]
mod tests;
