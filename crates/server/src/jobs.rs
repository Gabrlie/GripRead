//! 定时追更: the server updates its online books' directories on a
//! schedule, fetches a few new chapters of each ahead, and the changes reach
//! devices as sync records. Devices that are connected also send their own
//! 更新书架 here (`POST /api/jobs/update`), and read chapters through the
//! server (`GET /api/sync/chapter`), which may reach sources they cannot.

use super::*;
use axum::extract::Query;
use gripread_core::sync::{BookUpdate, ShelfUpdateReply, ShelfUpdateRequest};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Book sources run scripts that need a deep stack.
const ENGINE_STACK: usize = 16 * 1024 * 1024;
/// Books updated at once.
const WORKERS: usize = 4;
const SETTINGS_FILE: &str = "jobs.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct JobSettings {
    /// Hours between updates; 0 turns them off.
    pub interval_hours: u32,
    /// New chapters of each book fetched ahead after an update.
    pub prefetch: u32,
    /// Minutes between 订阅 refreshes; 0 turns them off.
    pub rss_interval_minutes: u32,
}

impl Default for JobSettings {
    fn default() -> Self {
        Self {
            interval_hours: 6,
            prefetch: 5,
            rss_interval_minutes: 60,
        }
    }
}

/// Minutes between the server's 订阅 refreshes.
pub(crate) fn rss_interval(server: &Server) -> u32 {
    load_settings(server).rss_interval_minutes
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub running: bool,
    pub last_run: Option<i64>,
    pub next_run: Option<i64>,
    /// Books updated, new chapters, and books that failed in the last run.
    pub updated: u32,
    pub new_chapters: u32,
    pub failed: u32,
    /// Which books failed in the last run, and why.
    pub failures: Vec<JobFailure>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobFailure {
    pub title: String,
    pub error: String,
}

#[derive(Default)]
pub struct Jobs {
    status: Mutex<JobStatus>,
    /// One update at a time; a second request waits for it.
    run: tokio::sync::Mutex<()>,
    /// Woken when the settings change, to plan the next run again.
    changed: tokio::sync::Notify,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

fn settings_path(server: &Server) -> PathBuf {
    server.data.join(SETTINGS_FILE)
}

fn load_settings(server: &Server) -> JobSettings {
    std::fs::read_to_string(settings_path(server))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn routes() -> Router<Arc<Server>> {
    Router::new()
        .route("/api/jobs", get(get_jobs).put(save_jobs))
        .route("/api/jobs/update", post(update_now))
        .route("/api/sync/chapter", get(chapter))
        .route("/api/source/fetch", post(source_fetch))
}

/// Runs the scheduled updates for as long as the server runs.
pub fn schedule(server: Arc<Server>) {
    tokio::spawn(async move {
        loop {
            let settings = load_settings(&server);
            let last = server
                .jobs
                .status
                .lock()
                .ok()
                .and_then(|status| status.last_run);
            let wait = (settings.interval_hours > 0).then(|| {
                let every = i64::from(settings.interval_hours) * 3600 * 1000;
                // The first run comes a minute after start.
                let next = last.map_or(now_ms() + 60_000, |last| last + every);
                if let Ok(mut status) = server.jobs.status.lock() {
                    status.next_run = Some(next);
                }
                Duration::from_millis(next.saturating_sub(now_ms()).max(0) as u64)
            });
            if wait.is_none() {
                if let Ok(mut status) = server.jobs.status.lock() {
                    status.next_run = None;
                }
            }
            let changed = server.jobs.changed.notified();
            match wait {
                Some(wait) => {
                    tokio::select! {
                        () = tokio::time::sleep(wait) => {
                            run_update(&server, Vec::new()).await;
                        }
                        () = changed => {}
                    }
                }
                None => changed.await,
            }
        }
    });
}

/// Updates the books with these sync keys (all updatable books when
/// empty), fetches new chapters ahead, and logs the changes for devices.
async fn run_update(server: &Arc<Server>, keys: Vec<String>) -> ShelfUpdateReply {
    let _running = server.jobs.run.lock().await;
    if let Ok(mut status) = server.jobs.status.lock() {
        status.running = true;
    }
    let prefetch = load_settings(server).prefetch;
    let keys_given = !keys.is_empty();
    let storage = server.core.storage.clone();
    let reply = tokio::task::spawn_blocking(move || update_books(&storage, &keys, prefetch))
        .await
        .unwrap_or_default();
    if let Ok(mut status) = server.jobs.status.lock() {
        *status = JobStatus {
            running: false,
            last_run: Some(now_ms()),
            next_run: status.next_run,
            updated: reply
                .books
                .iter()
                .filter(|book| book.error.is_none())
                .count() as u32,
            new_chapters: reply.books.iter().map(|book| book.added).sum(),
            failed: reply
                .books
                .iter()
                .filter(|book| book.error.is_some())
                .count() as u32,
            failures: reply
                .books
                .iter()
                .filter_map(|book| {
                    Some(JobFailure {
                        title: book.title.clone(),
                        error: book.error.clone()?,
                    })
                })
                .collect(),
        };
    }
    let added: u32 = reply.books.iter().map(|book| book.added).sum();
    log(
        if keys_given {
            "shelfUpdated"
        } else {
            "scheduledUpdate"
        },
        &[
            ("books", reply.books.len().to_string()),
            ("chapters", added.to_string()),
        ],
        format!(
            "{}：{} 本书，新章节 {added} 章",
            if keys_given {
                "更新书架"
            } else {
                "定时追更"
            },
            reply.books.len()
        ),
    );
    // The new directories and details go out as sync records.
    server.edits.notify_one();
    server.jobs.changed.notify_one();
    reply
}

fn update_books(
    storage: &Arc<Mutex<gripread_core::storage::Storage>>,
    keys: &[String],
    prefetch: u32,
) -> ShelfUpdateReply {
    let books: Vec<(String, String)> = {
        let Ok(guard) = storage.lock() else {
            return ShelfUpdateReply::default();
        };
        // Books in private groups are left to their devices.
        let private = guard.private_book_ids().unwrap_or_default();
        let found = if keys.is_empty() {
            guard.scheduled_online_books().map(|ids| {
                ids.into_iter()
                    .filter_map(|id| Some((guard.online_sync_key(&id).ok()?, id)))
                    .collect()
            })
        } else {
            Ok(keys
                .iter()
                .filter_map(|key| Some((key.clone(), guard.online_book_id_for_key(key).ok()??)))
                .filter(|(_, id)| !private.contains(id))
                .collect())
        };
        found.unwrap_or_default()
    };
    let queue = Mutex::new(books);
    let results = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..WORKERS {
            let _ = std::thread::Builder::new()
                .name("server-update".into())
                .stack_size(ENGINE_STACK)
                .spawn_scoped(scope, || {
                    while let Some((key, id)) = queue.lock().ok().and_then(|mut queue| queue.pop())
                    {
                        let result = update_book(storage, &id, prefetch);
                        let title = storage
                            .lock()
                            .ok()
                            .and_then(|guard| {
                                let title = guard.online_record(&id).ok()?.title;
                                Some(guard.log_title(&id, &title))
                            })
                            .unwrap_or_default();
                        if let Ok(mut results) = results.lock() {
                            results.push(match result {
                                Ok(added) => BookUpdate {
                                    key,
                                    title,
                                    added,
                                    error: None,
                                },
                                Err(error) => BookUpdate {
                                    key,
                                    title,
                                    added: 0,
                                    error: Some(error.message),
                                },
                            });
                        }
                    }
                });
        }
    });
    ShelfUpdateReply {
        books: results.into_inner().unwrap_or_default(),
    }
}

fn update_book(
    storage: &Arc<Mutex<gripread_core::storage::Storage>>,
    id: &str,
    prefetch: u32,
) -> Result<u32, AppError> {
    let before = storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
        .online_chapter_count(id)?;
    let added = match gripread_core::online_reader::refresh_toc(
        storage,
        id,
        Arc::new(AtomicBool::new(false)),
    ) {
        Ok(added) => added,
        Err(error) => {
            if let Ok(guard) = storage.lock() {
                let _ = guard.record_online_update_error(id, &error.message);
                let title = guard
                    .online_record(id)
                    .map(|record| guard.log_title(id, &record.title))
                    .unwrap_or_default();
                gripread_core::log_keyed!(
                    Warn,
                    "server",
                    "bookUpdateFailed",
                    format!("《{title}》更新失败：{}", error.message),
                    @error error,
                    title = title,
                );
            }
            return Err(error);
        }
    };
    // A book that only grew gets its new chapters ready to read.
    for index in before..before + added.min(prefetch) {
        if gripread_core::online_reader::raw_chapter(storage, id, index).is_err() {
            break;
        }
    }
    Ok(added)
}

async fn get_jobs(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let status = server
        .jobs
        .status
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default();
    Json(json!({ "settings": load_settings(&server), "status": status })).into_response()
}

async fn save_jobs(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(settings): Json<JobSettings>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let settings = JobSettings {
        interval_hours: settings.interval_hours.min(24 * 7),
        prefetch: settings.prefetch.min(50),
        rss_interval_minutes: settings.rss_interval_minutes.min(24 * 60),
    };
    let text = serde_json::to_string_pretty(&settings).unwrap_or_default();
    if let Err(error) = std::fs::write(settings_path(&server), text) {
        return failure(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string());
    }
    server.jobs.changed.notify_one();
    Json(settings).into_response()
}

async fn update_now(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    body: Option<Json<ShelfUpdateRequest>>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let keys = body.map(|Json(request)| request.keys).unwrap_or_default();
    Json(run_update(&server, keys).await).into_response()
}

/// 通过服务器访问: one request a device's book source sends through the
/// server, to a public address only; cookies and redirects stay with the
/// device, which sends each hop.
async fn source_fetch(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(hop): Json<gripread_core::sources::http::RelayHop>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let hop = match hop.to_hop() {
        Ok(hop) => hop,
        Err(message) => {
            return failure_keyed(
                StatusCode::BAD_REQUEST,
                "invalid_argument",
                "badRequest",
                &message,
            )
        }
    };
    let answer =
        tokio::task::spawn_blocking(move || gripread_core::sources::http::relay_hop(&hop)).await;
    match answer {
        Ok(Ok(answer)) => Json(gripread_core::sources::http::RelayAnswer::from_answer(
            &answer,
        ))
        .into_response(),
        Ok(Err(message)) => failure_keyed(StatusCode::BAD_GATEWAY, "io", "sourceRelay", &message),
        Err(error) => failure_keyed(
            StatusCode::INTERNAL_SERVER_ERROR,
            "io",
            "sourceRelay",
            &error.to_string(),
        ),
    }
}

/// A chapter of the server's copy of an online book, matched by its address
/// (or title), from the server's cache or fetched from the source now.
async fn chapter(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let (Some(key), Some(url)) = (query.get("key").cloned(), query.get("url").cloned()) else {
        return failure_keyed(
            StatusCode::BAD_REQUEST,
            "invalid_argument",
            "missingParam",
            "缺少参数",
        );
    };
    let title = query.get("title").cloned().unwrap_or_default();
    let storage = server.core.storage.clone();
    let found = tokio::task::spawn_blocking(move || {
        std::thread::Builder::new()
            .name("server-chapter".into())
            .stack_size(ENGINE_STACK)
            .spawn(move || -> Result<Option<String>, AppError> {
                let id = {
                    let guard = storage.lock().map_err(|_| {
                        AppError::new(ErrorCode::Database, "storage lock is poisoned")
                    })?;
                    guard.online_book_id_for_key(&key)?
                };
                let Some(id) = id else {
                    return Ok(None);
                };
                gripread_core::online_reader::ensure_toc(&storage, &id)?;
                let chapters = storage
                    .lock()
                    .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
                    .online_chapters(&id)?;
                let index = chapters
                    .iter()
                    .position(|chapter| !url.is_empty() && chapter.url == url)
                    .or_else(|| chapters.iter().position(|chapter| chapter.title == title));
                match index {
                    Some(index) => {
                        gripread_core::online_reader::raw_chapter(&storage, &id, index as u32)
                            .map(Some)
                    }
                    None => Ok(None),
                }
            })
            .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?
            .join()
            .map_err(|_| AppError::new(ErrorCode::Io, "chapter worker stopped"))?
    })
    .await;
    match found {
        Ok(Ok(Some(text))) => {
            ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response()
        }
        Ok(Ok(None)) => failure_keyed(
            StatusCode::NOT_FOUND,
            "not_found",
            "serverNoChapter",
            "服务器上没有这一章",
        ),
        Ok(Err(error)) => failure(StatusCode::BAD_GATEWAY, "upstream", &error.message),
        Err(error) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            &error.to_string(),
        ),
    }
}
