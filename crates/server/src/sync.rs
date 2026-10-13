//! Native sync over HTTP (`gripread_core::sync`): devices push and pull
//! records and send and fetch book and cover files; the web version's own
//! edits are logged a moment after it makes them. Each new record is
//! announced on the event socket as `sync { head }`.

use super::*;
use axum::routing::put;
use gripread_core::sync::{self as protocol, PullReply, PushRequest};
use std::time::Duration;
use tokio::sync::Notify;

/// A quiet moment after the web version's last edit before it is logged.
const EDIT_QUIET: Duration = Duration::from_secs(2);
/// …but no longer than this during continuous edits.
const EDIT_LONGEST: Duration = Duration::from_secs(10);

pub fn routes() -> Router<Arc<Server>> {
    Router::new()
        .route("/api/sync/push", post(push))
        .route("/api/sync/pull", get(pull))
        .route("/api/sync/wait", get(wait))
        .route("/api/blobs/book/{sha256}", put(put_book).get(get_book))
        .route("/api/blobs/cover/{name}", put(put_cover).get(get_cover))
}

impl Server {
    fn announce(&self, head: i64) {
        let _ = self
            .events
            .send(json!({ "event": "sync", "payload": { "head": head } }).to_string());
    }
}

/// How often the server backs its library up, when anything changed.
const BACKUP_EVERY: Duration = Duration::from_secs(24 * 3600);

/// Writes a recovery point of the library a day apart while records keep
/// arriving (the core keeps the newest few).
pub fn daily_backups(server: Arc<Server>) {
    tokio::spawn(async move {
        let mut backed_up = None;
        loop {
            tokio::time::sleep(BACKUP_EVERY).await;
            let core = server.core.clone();
            let done = tokio::task::spawn_blocking(move || {
                let guard = core.storage.lock().ok()?;
                let (_, head) = guard.sync_log_since(i64::MAX, 1).ok()?;
                if backed_up == Some(head) {
                    return Some(head);
                }
                match guard.write_recovery_point("server") {
                    Ok(_) => Some(head),
                    Err(error) => {
                        gripread_core::app_log::warn(
                            "sync",
                            format!("服务器备份失败：{}", error.message),
                        );
                        backed_up
                    }
                }
            })
            .await
            .ok()
            .flatten();
            backed_up = done;
        }
    });
}

/// Logs the web version's edits once they pause (see [`EDIT_QUIET`]).
pub fn watch_edits(server: Arc<Server>, edits: Arc<Notify>) {
    tokio::spawn(async move {
        loop {
            edits.notified().await;
            let started = tokio::time::Instant::now();
            while started.elapsed() < EDIT_LONGEST {
                if tokio::time::timeout(EDIT_QUIET, edits.notified())
                    .await
                    .is_err()
                {
                    break;
                }
            }
            let core = server.core.clone();
            let logged = tokio::task::spawn_blocking(move || {
                let mut guard = core.storage.lock().ok()?;
                protocol::log_own_changes(&mut guard, "server")
                    .ok()
                    .flatten()
            })
            .await
            .ok()
            .flatten();
            if let Some(head) = logged {
                server.announce(head);
            }
        }
    });
}

async fn push(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(request): Json<PushRequest>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let core = server.core.clone();
    match tokio::task::spawn_blocking(move || protocol::accept_push(&core.storage, &request)).await
    {
        Ok(Ok(reply)) => {
            server.announce(reply.head);
            Json(reply).into_response()
        }
        Ok(Err(error)) => app_error(error),
        Err(error) => failure(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    }
}

#[derive(Deserialize)]
struct PullQuery {
    #[serde(default)]
    since: i64,
    limit: Option<u32>,
}

async fn pull(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Query(query): Query<PullQuery>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let core = server.core.clone();
    let limit = query.limit.unwrap_or(protocol::PULL_LIMIT);
    let result: Result<PullReply, AppError> =
        tokio::task::spawn_blocking(move || protocol::pull(&core.storage, query.since, limit))
            .await
            .unwrap_or_else(|error| {
                Err(AppError::new(
                    gripread_core::error::ErrorCode::Io,
                    error.to_string(),
                ))
            });
    match result {
        Ok(reply) => Json(reply).into_response(),
        Err(error) => app_error(error),
    }
}

/// How long a device's long poll waits for a new record.
const WAIT: Duration = Duration::from_secs(25);

#[derive(Deserialize)]
struct WaitQuery {
    #[serde(default)]
    since: i64,
}

fn log_head(core: &AppState) -> Option<i64> {
    let guard = core.storage.lock().ok()?;
    guard.sync_log_since(i64::MAX, 1).ok().map(|(_, head)| head)
}

/// A device's long poll: answers `{ head }` once the log passes `since`, or
/// after a while with the head as it is.
async fn wait(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Query(query): Query<WaitQuery>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    // Listen before looking, so a record logged in between is not missed.
    let mut events = server.events.subscribe();
    let core = server.core.clone();
    let head = tokio::task::spawn_blocking(move || log_head(&core))
        .await
        .ok()
        .flatten()
        .unwrap_or(0);
    if head > query.since {
        return Json(json!({ "head": head })).into_response();
    }
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(text)) => {
                let Ok(event) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if event["event"] == "sync" {
                    if let Some(head) = event["payload"]["head"]
                        .as_i64()
                        .filter(|head| *head > query.since)
                    {
                        return Json(json!({ "head": head })).into_response();
                    }
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) | Err(_) => return Json(json!({ "head": head })).into_response(),
        }
    }
}

/// Receives a book's original file, imports it unless it is here already.
async fn put_book(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Path(sha256): Path<String>,
    body: Body,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    if !protocol::valid_sha256(&sha256) {
        return failure(StatusCode::BAD_REQUEST, "invalid_argument", "校验值无效");
    }
    let folder = server.uploads.join(uuid::Uuid::new_v4().to_string());
    let target = folder.join("book.txt");
    if let Err(message) = receive(body, &folder, &target).await {
        let _ = tokio::fs::remove_dir_all(&folder).await;
        return failure(StatusCode::BAD_REQUEST, "io", &message);
    }
    let core = server.core.clone();
    let stored = {
        let target = target.clone();
        tokio::task::spawn_blocking(move || protocol::store_book(&core.storage, &sha256, &target))
            .await
    };
    let _ = tokio::fs::remove_dir_all(&folder).await;
    match stored {
        Ok(Ok(imported)) => {
            if imported {
                let core = server.core.clone();
                let head = tokio::task::spawn_blocking(move || {
                    core.storage
                        .lock()
                        .ok()
                        .and_then(|guard| guard.sync_log_since(i64::MAX, 1).ok())
                        .map(|(_, head)| head)
                })
                .await
                .ok()
                .flatten();
                if let Some(head) = head {
                    server.announce(head);
                }
            }
            Json(json!({ "imported": imported })).into_response()
        }
        Ok(Err(error)) => app_error(error),
        Err(error) => failure(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    }
}

/// Streams a request body to `target`, within the upload size limit.
async fn receive(
    body: Body,
    folder: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    tokio::fs::create_dir_all(folder)
        .await
        .map_err(|error| error.to_string())?;
    let mut file = tokio::fs::File::create(target)
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

async fn get_book(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Path(sha256): Path<String>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let core = server.core.clone();
    let found = tokio::task::spawn_blocking(move || {
        let guard = core.storage.lock().ok()?;
        protocol::book_file(&guard, &sha256).ok().flatten()
    })
    .await
    .ok()
    .flatten();
    send_file(found, "text/plain; charset=utf-8").await
}

async fn put_cover(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Bytes,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let core = server.core.clone();
    match tokio::task::spawn_blocking(move || protocol::store_cover(&core.storage, &name, &body))
        .await
    {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => app_error(error),
        Err(error) => failure(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    }
}

async fn get_cover(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let core = server.core.clone();
    let found = tokio::task::spawn_blocking(move || {
        let guard = core.storage.lock().ok()?;
        protocol::cover_file(&guard, &name).ok().flatten()
    })
    .await
    .ok()
    .flatten();
    send_file(found, "application/octet-stream").await
}

async fn send_file(path: Option<PathBuf>, mime: &'static str) -> Response {
    let Some(path) = path else {
        return failure(StatusCode::NOT_FOUND, "not_found", "服务器上没有这个文件");
    };
    match tokio::fs::File::open(&path).await {
        Ok(file) => {
            let stream = tokio_util::io::ReaderStream::new(file);
            ([(header::CONTENT_TYPE, mime)], Body::from_stream(stream)).into_response()
        }
        Err(_) => failure(StatusCode::NOT_FOUND, "not_found", "服务器上没有这个文件"),
    }
}
