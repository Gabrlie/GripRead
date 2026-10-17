//! Commands for book sources: management over storage, and engine runs
//! (login, debug, check) on threads of their own, reported by events.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value as Json;

use crate::commands::{with_storage, AppState};
use crate::error::{AppError, ErrorCode};
use crate::models::{
    BookSourceDetail, BookSourceSummary, CancelResult, CheckSourcesRequest, DebugSourceRequest,
    ExportSourcesFileRequest, FetchTextRequest, ImportOperationRequest, ImportSourcesRequest,
    MoveSourcesRequest, PathRequest, PreviewSourceImportRequest, SaveBookSourceRequest,
    SetSourcesSwitchRequest, SourceCheckEvent, SourceDebugEvent, SourceGroupRequest,
    SourceImportPreview, SourceLoginForm, SourceLoginRequest, SourceLoginRow, SourceScriptReport,
    SourceUrlRequest, SourceUrlsRequest, SourceVariableRequest,
};
use crate::sources::context::{
    login_info_key, login_result_key, source_custom_variable_key, BookData, Control, MemoryStore,
    SourceStore,
};
use crate::sources::error::{SourceError, SourceErrorKind};
use crate::sources::http::{self, cookie_domain};
use crate::sources::lenient_json;
use crate::sources::model::BookSource;
use crate::sources::value::json_text;
use crate::sources::web_book::{chapter_absolute_url, SourceSession};
use crate::storage::{SqliteSourceStore, Storage};

/// Each source operation's cancel flag, by operation id.
#[derive(Default)]
pub struct SourceOperations {
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl SourceOperations {
    pub(crate) fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.insert(id.to_string(), flag.clone());
        }
        flag
    }

    pub(crate) fn cancels(&self) -> Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> {
        self.cancels.clone()
    }

    pub(crate) fn finish(cancels: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>, id: &str) {
        if let Ok(mut cancels) = cancels.lock() {
            cancels.remove(id);
        }
    }
}

const ENGINE_STACK: usize = 16 * 1024 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(180);
const CHECK_WORKERS: usize = 4;

pub(crate) fn engine_error(error: SourceError) -> AppError {
    let code = match error.kind {
        SourceErrorKind::Cancelled => ErrorCode::ImportCancelled,
        _ => ErrorCode::InvalidArgument,
    };
    let readable = readable_script_error(&error.message);
    if readable == error.message {
        return AppError::new(code, error.message);
    }
    // A source script's own error: the reader sees its message, the log
    // keeps where it was thrown.
    crate::log_keyed!(
        Warn,
        "source",
        "sourceScriptError",
        &error.message,
        message = error.message
    );
    AppError::keyed(code, "sourceScript", readable.clone()).with("message", readable)
}

/// A script error as a reader reads it: without the place it was thrown
/// (`（at body (eval_script:15:35)）`) or a plain `Error:` prefix.
pub(crate) fn readable_script_error(text: &str) -> String {
    let mut text = text.trim();
    if text.ends_with('）') {
        if let Some(start) = text.rfind("（at ") {
            text = text[..start].trim_end();
        }
    }
    let text = text.strip_prefix("Error: ").unwrap_or(text);
    text.to_string()
}

/// Runs engine work on a thread with room for nested scripts, and waits.
pub(crate) async fn on_engine_thread<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(move || {
        std::thread::Builder::new()
            .name("source-engine".into())
            .stack_size(ENGINE_STACK)
            .spawn(work)
            .map_err(|error| {
                AppError::new(
                    ErrorCode::Io,
                    format!("source thread failed to start: {error}"),
                )
            })?
            .join()
            .map_err(|_| AppError::new(ErrorCode::Io, "source thread stopped unexpectedly"))
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("source worker stopped: {error}")))?
}

pub(crate) fn spawn_engine(work: impl FnOnce() + Send + 'static) -> Result<(), AppError> {
    std::thread::Builder::new()
        .name("source-engine".into())
        .stack_size(ENGINE_STACK)
        .spawn(work)
        .map(|_| ())
        .map_err(|error| {
            AppError::new(
                ErrorCode::Io,
                format!("source thread failed to start: {error}"),
            )
        })
}

pub(crate) fn load_source(
    storage: &Arc<Mutex<Storage>>,
    url: &str,
) -> Result<BookSource, AppError> {
    let guard = storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
    guard.book_source(url)?.ok_or_else(|| {
        AppError::keyed(
            ErrorCode::NotFound,
            "sourceMissingUrl",
            format!("没有这个书源：{url}"),
        )
        .with("url", url)
    })
}

pub(crate) fn session_for(
    storage: &Arc<Mutex<Storage>>,
    source: BookSource,
    control: Control,
) -> Result<SourceSession, SourceError> {
    let store: Arc<dyn SourceStore> = Arc::new(SqliteSourceStore::new(storage.clone()));
    SourceSession::new(source, store, control)
}

pub async fn list_book_sources(state: &Arc<AppState>) -> Result<Vec<BookSourceSummary>, AppError> {
    with_storage(state, |storage| storage.list_book_sources()).await
}

pub async fn get_book_source(
    state: &Arc<AppState>,
    request: SourceUrlRequest,
) -> Result<BookSourceDetail, AppError> {
    with_storage(state, move |storage| {
        storage.book_source_detail(&request.url)
    })
    .await
}

pub async fn preview_source_import(
    state: &Arc<AppState>,
    request: PreviewSourceImportRequest,
) -> Result<SourceImportPreview, AppError> {
    with_storage(state, move |storage| {
        storage.preview_source_import(&request.json)
    })
    .await
}

pub async fn import_book_sources(
    state: &Arc<AppState>,
    request: ImportSourcesRequest,
) -> Result<Vec<BookSourceSummary>, AppError> {
    with_storage(state, move |storage| storage.import_sources(&request)).await
}

pub async fn save_book_source(
    state: &Arc<AppState>,
    request: SaveBookSourceRequest,
) -> Result<BookSourceSummary, AppError> {
    with_storage(state, move |storage| {
        storage.save_book_source(&request.json, request.previous_url.as_deref())
    })
    .await
}

pub async fn delete_book_sources(
    state: &Arc<AppState>,
    request: SourceUrlsRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.delete_book_sources(&request.urls)
    })
    .await
}

pub async fn set_book_sources_switch(
    state: &Arc<AppState>,
    request: SetSourcesSwitchRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.set_sources_switch(&request.urls, request.switch, request.on)
    })
    .await
}

pub async fn change_book_sources_group(
    state: &Arc<AppState>,
    request: SourceGroupRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.change_sources_group(&request.urls, &request.group, request.add)
    })
    .await
}

pub async fn move_book_sources(
    state: &Arc<AppState>,
    request: MoveSourcesRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.move_sources(&request.urls, request.top)
    })
    .await
}

pub async fn export_book_sources(
    state: &Arc<AppState>,
    request: SourceUrlsRequest,
) -> Result<String, AppError> {
    with_storage(state, move |storage| {
        storage.export_book_sources(&request.urls)
    })
    .await
}

/// Downloads source JSON from an address, as 网络导入 does.
pub async fn fetch_source_text(
    _state: &Arc<AppState>,
    request: FetchTextRequest,
) -> Result<String, AppError> {
    on_engine_thread(move || {
        let url = request.url.trim().to_string();
        if !crate::sources::util::is_absolute_url(&url) {
            return Err(AppError::invalid_argument(
                "地址必须以 http:// 或 https:// 开头",
            ));
        }
        let source = BookSource::from_value(
            serde_json::json!({ "bookSourceUrl": url, "bookSourceName": "导入" }),
        )
        .map_err(AppError::invalid_argument)?;
        let env = crate::sources::context::Env::new(
            source,
            Arc::new(MemoryStore::default()),
            Control::new(
                Arc::new(AtomicBool::new(false)),
                Some(Instant::now() + Duration::from_secs(60)),
            ),
        );
        let mut request = http::HttpRequest::get(&url);
        request.timeout = Duration::from_secs(45);
        let response = http::execute(&env, &request).map_err(engine_error)?;
        if !response.is_success() {
            return Err(AppError::new(
                ErrorCode::Io,
                format!("下载失败（{}）", response.code),
            ));
        }
        Ok(response.body)
    })
    .await?
}

/// Reads a picked source file (a path, or an Android document).
pub async fn read_source_file(
    state: &Arc<AppState>,
    request: PathRequest,
) -> Result<String, AppError> {
    let app = state.clone();
    let data_root = state.data_root.clone();
    tokio::task::spawn_blocking(move || {
        let operation = uuid::Uuid::new_v4().to_string();
        let (path, _, _staged) = crate::documents::resolve_named_source(
            &*app.platform,
            &data_root,
            &request.path,
            &operation,
        )?;
        let bytes = std::fs::read(&path)?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "sourceFileTooBig",
                "文件太大，不像书源文件",
            ));
        }
        Ok(http::decode_body(&bytes, None, None))
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("file worker stopped: {error}")))?
}

/// Saves sources as a Legado export file; `false` when the reader cancelled.
pub async fn export_book_sources_file(
    state: &Arc<AppState>,
    request: ExportSourcesFileRequest,
) -> Result<bool, AppError> {
    let app = state.clone();
    let urls = request.urls.clone();
    let json = with_storage(state, move |storage| storage.export_book_sources(&urls)).await?;
    tokio::task::spawn_blocking(move || {
        crate::documents::save_document(
            &*app.platform,
            request.path.as_deref(),
            "bookSource.json",
            "application/json",
            json.as_bytes(),
        )
    })
    .await
    .map_err(|error| AppError::new(ErrorCode::Io, format!("file worker stopped: {error}")))?
}

fn login_rows(ui: &str) -> Vec<SourceLoginRow> {
    let Ok(Json::Array(items)) = lenient_json::parse(ui) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| {
            let map = item.as_object()?;
            let text = |key: &str| {
                map.get(key)
                    .map(json_text)
                    .filter(|value| !value.is_empty())
            };
            Some(SourceLoginRow {
                name: text("name")?,
                kind: text("type").unwrap_or_else(|| "text".to_string()),
                action: text("action"),
                default_value: text("default"),
                chars: match map.get("chars") {
                    Some(Json::Array(chars)) => chars.iter().map(json_text).collect(),
                    _ => Vec::new(),
                },
            })
        })
        .collect()
}

fn login_script(source: &BookSource) -> Option<String> {
    let url = source.login_url()?;
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    Some(if lower.starts_with("@js:") {
        trimmed[4..].to_string()
    } else if lower.starts_with("<js>") {
        trimmed[4..trimmed.rfind('<').unwrap_or(trimmed.len()).max(4)].to_string()
    } else {
        trimmed.to_string()
    })
}

pub async fn get_source_login_form(
    state: &Arc<AppState>,
    request: SourceUrlRequest,
) -> Result<SourceLoginForm, AppError> {
    with_storage(state, move |storage| {
        let source = storage
            .book_source(&request.url)?
            .ok_or_else(|| AppError::keyed(ErrorCode::NotFound, "sourceMissing", "没有这个书源"))?;
        let rows = source
            .login_ui()
            .map(|ui| login_rows(&ui))
            .unwrap_or_default();
        let values: BTreeMap<String, String> = storage
            .source_cache_get(&login_info_key(&source.url()))?
            .and_then(|info| lenient_json::parse(&info).ok())
            .and_then(|value| value.as_object().cloned())
            .map(|map| {
                map.into_iter()
                    .map(|(key, value)| (key, json_text(&value)))
                    .collect()
            })
            .unwrap_or_default();
        let last: Option<Json> = storage
            .source_cache_get(&login_result_key(&source.url()))?
            .and_then(|stored| serde_json::from_str(&stored).ok());
        let login_url = source.login_url();
        let browser_only = rows.is_empty()
            && login_url
                .as_deref()
                .is_some_and(crate::sources::util::is_absolute_url);
        Ok(SourceLoginForm {
            rows,
            values,
            browser_only,
            login_url,
            last_login: last
                .as_ref()
                .and_then(|last| last["text"].as_str().map(str::to_string)),
            last_login_at: last.as_ref().and_then(|last| last["at"].as_i64()),
        })
    })
    .await
}

/// Saves the form and runs the source's `login()` or a button's action.
pub async fn login_book_source(
    state: &Arc<AppState>,
    request: SourceLoginRequest,
) -> Result<SourceScriptReport, AppError> {
    let storage = state.storage.clone();
    on_engine_thread(move || {
        let source = load_source(&storage, &request.url)?;
        let info = serde_json::to_string(&request.values)?;
        {
            let guard = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            guard.source_cache_put(&login_info_key(&source.url()), &info, 0)?;
        }
        let script = login_script(&source).unwrap_or_default();
        let control = Control::new(Arc::new(AtomicBool::new(false)), Some(Instant::now() + Duration::from_secs(120)));
        // A web login (Legado's loginUrl as an address, or a button that
        // opens one) is a page the reader logs in on; its cookies are kept.
        let page = match &request.action {
            Some(action) if crate::sources::util::is_absolute_url(action) => Some(action.clone()),
            None if source.login_ui().is_none() => source
                .login_url()
                .filter(|url| crate::sources::util::is_absolute_url(url)),
            _ => None,
        };
        let url = source.url();
        if let Some(page) = page {
            // The source's login() confirms a web login while the page is
            // open, unless it opens a page itself.
            let check = Some(script.as_str())
                .filter(|script| script.contains("login") && !script.contains("startBrowser"));
            let control = Control::new(Arc::new(AtomicBool::new(false)), None);
            let session = session_for(&storage, source, control).map_err(engine_error)?;
            let (_, answer) = session
                .login_in_page(&page, "登录", check)
                .map_err(engine_error)?;
            let logged_in = answer.is_some();
            let result = match answer {
                Some(text) => {
                    remember_login(&storage, &url, &text)?;
                    text
                }
                // The page closed without a confirmed login; its cookies are kept.
                None => String::new(),
            };
            return Ok(SourceScriptReport {
                result,
                logs: session.logs(),
                logged_in,
            });
        }
        let body = match &request.action {
            Some(action) => format!("{script}\n{action}"),
            None => format!(
                "{script}\nif (typeof login == 'function') {{ login.apply(this) }} else {{ throw new Error('书源没有 login 函数') }}"
            ),
        };
        let session = session_for(&storage, source, control).map_err(engine_error)?;
        let result = session.run_script(&body, None).map_err(engine_error)?.to_text();
        let logged_in = request.action.is_none();
        if logged_in {
            let text = if result.is_empty() || result == "undefined" { "已登录" } else { &result };
            remember_login(&storage, &url, text)?;
        }
        Ok(SourceScriptReport {
            result,
            logs: session.logs(),
            logged_in,
        })
    })
    .await?
}

fn remember_login(
    storage: &Mutex<crate::storage::Storage>,
    url: &str,
    text: &str,
) -> Result<(), AppError> {
    let stored = serde_json::json!({ "text": text, "at": crate::cloud::now_millis() }).to_string();
    storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
        .source_cache_put(&login_result_key(url), &stored, 0)
}

/// 通过服务器访问 on or off for sources, on this device.
pub async fn set_sources_via_server(
    state: &Arc<AppState>,
    request: crate::models::SourceViaServerRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.set_sources_via_server(&request.urls, request.on)
    })
    .await
}

pub async fn get_source_variable(
    state: &Arc<AppState>,
    request: SourceUrlRequest,
) -> Result<Option<String>, AppError> {
    with_storage(state, move |storage| {
        storage.source_cache_get(&source_custom_variable_key(&request.url))
    })
    .await
}

pub async fn set_source_variable(
    state: &Arc<AppState>,
    request: SourceVariableRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        let key = source_custom_variable_key(&request.url);
        match request.value.filter(|value| !value.is_empty()) {
            Some(value) => storage.source_cache_put(&key, &value, 0),
            None => storage.source_cache_delete(&key),
        }
    })
    .await
}

pub async fn clear_source_cookies(
    state: &Arc<AppState>,
    request: SourceUrlRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.remove_source_cookie(&cookie_domain(&request.url))
    })
    .await
}

pub async fn cancel_source_operation(
    state: &Arc<AppState>,
    request: ImportOperationRequest,
) -> Result<CancelResult, AppError> {
    let operations = &state.operations;
    let flag = operations
        .cancels
        .lock()
        .ok()
        .and_then(|cancels| cancels.get(&request.operation_id).cloned());
    Ok(match flag {
        Some(flag) => {
            flag.store(true, Ordering::Release);
            CancelResult { requested: true }
        }
        None => CancelResult { requested: false },
    })
}

/// Logs added since the last report.
struct LogCursor(usize);

impl LogCursor {
    fn take(&mut self, session: &SourceSession) -> Vec<String> {
        let logs = session.logs();
        let fresh = logs[self.0.min(logs.len())..].to_vec();
        self.0 = logs.len();
        fresh
    }
}

fn preview(text: &str, limit: usize) -> String {
    let mut shown: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        shown.push('…');
    }
    shown
}

/// Legado's 调试: a keyword searches; `::url` explores; an address reads a
/// book's details; `++url` a table of contents; `--url` one chapter.
fn debug_run(session: &SourceSession, key: &str, emit: &dyn Fn(String)) -> Result<(), SourceError> {
    let mut cursor = LogCursor(0);
    let flush = |cursor: &mut LogCursor| {
        for line in cursor.take(session) {
            emit(format!("  {line}"));
        }
    };
    let key = key.trim();
    let base = session.env().source.url();
    let mut book = BookData {
        origin: base.clone(),
        origin_name: session.env().source.name(),
        ..Default::default()
    };
    let mut chapters = Vec::new();
    if let Some(url) = key.strip_prefix("--") {
        let chapter = crate::sources::context::ChapterData {
            title: "调试章节".into(),
            url: url.to_string(),
            base_url: base.clone(),
            ..Default::default()
        };
        chapters.push(chapter);
    } else if let Some(url) = key.strip_prefix("++") {
        book.book_url = url.to_string();
        book.toc_url = url.to_string();
    } else {
        if let Some(url) = key.strip_prefix("::") {
            emit(format!("︽ 发现 {url}"));
            let list = session.explore(url, 1);
            flush(&mut cursor);
            let list = list?;
            emit(format!("发现 {} 本书", list.len()));
            book = list
                .into_iter()
                .next()
                .ok_or_else(|| SourceError::empty("发现列表为空"))?;
        } else if crate::sources::util::is_absolute_url(key) {
            book.book_url = key.to_string();
        } else {
            emit(format!("︽ 搜索「{key}」"));
            let list = session.search(key, 1);
            flush(&mut cursor);
            let list = list?;
            emit(format!("搜索到 {} 本书", list.len()));
            for item in list.iter().take(3) {
                emit(format!(
                    "  《{}》{} {}",
                    item.name, item.author, item.book_url
                ));
            }
            book = list
                .into_iter()
                .next()
                .ok_or_else(|| SourceError::empty("搜索结果为空"))?;
        }
        emit(format!("︽ 详情 {}", book.book_url));
        let shared = Rc::new(RefCell::new(book.clone()));
        let outcome = session.book_info(&shared, false);
        flush(&mut cursor);
        outcome?;
        book = shared.borrow().clone();
        emit(format!("书名：{}  作者：{}", book.name, book.author));
        if !book.kind.is_empty() {
            emit(format!("分类：{}", book.kind));
        }
        if !book.intro.is_empty() {
            emit(format!(
                "简介：{}",
                preview(&book.intro.replace('\n', " "), 80)
            ));
        }
        emit(format!("目录地址：{}", book.toc_url));
    }
    let shared = Rc::new(RefCell::new(book));
    if chapters.is_empty() {
        emit("︽ 目录".to_string());
        let outcome = session.chapters(&shared);
        flush(&mut cursor);
        chapters = outcome?;
        emit(format!("共 {} 章", chapters.len()));
        for chapter in chapters.iter().take(3) {
            emit(format!("  {}  {}", chapter.title, chapter.url));
        }
        if chapters.len() > 3 {
            let last = chapters.last().expect("not empty");
            emit(format!("  …  {}  {}", last.title, last.url));
        }
    }
    let Some(first) = chapters.iter().position(|chapter| !chapter.is_volume) else {
        return Err(SourceError::empty("目录里没有正文章节"));
    };
    let urls: Vec<String> = chapters.iter().map(chapter_absolute_url).collect();
    emit(format!("︽ 正文 {}", chapters[first].title));
    let content = session.content(
        &shared,
        &chapters[first],
        urls.get(first + 1).map(String::as_str),
        &urls,
    );
    flush(&mut cursor);
    let content = content?;
    emit(format!(
        "正文 {} 字：{}",
        content.text.chars().count(),
        preview(&content.text, 200)
    ));
    Ok(())
}

pub async fn debug_book_source(
    state: &Arc<AppState>,
    request: DebugSourceRequest,
) -> Result<(), AppError> {
    let app = state.clone();
    let operations = &state.operations;
    let storage = state.storage.clone();
    let source = load_source(&storage, &request.url)?;
    let cancel = operations.register(&request.operation_id);
    let cancels = operations.cancels.clone();
    spawn_engine(move || {
        let id = request.operation_id.clone();
        let emit = |line: String| {
            let _ = app.emit(
                "source-debug",
                SourceDebugEvent {
                    operation_id: id.clone(),
                    line,
                    done: false,
                    error: None,
                },
            );
        };
        let control = Control::new(cancel, Some(Instant::now() + CHECK_TIMEOUT));
        let outcome = session_for(&storage, source, control)
            .and_then(|session| debug_run(&session, &request.key, &emit));
        let error = outcome.err().map(|error| error.message);
        let _ = app.emit(
            "source-debug",
            SourceDebugEvent {
                operation_id: id.clone(),
                line: match &error {
                    Some(error) => format!("✗ {error}"),
                    None => "✓ 调试完成".to_string(),
                },
                done: true,
                error,
            },
        );
        SourceOperations::finish(&cancels, &id);
    })
}

/// Which group a failure at `stage` adds, as Legado's check names them.
fn failure_group(stage: &str, error: &SourceError) -> String {
    match error.kind {
        SourceErrorKind::Network => "网站失效".to_string(),
        SourceErrorKind::Script => "js失效".to_string(),
        SourceErrorKind::Timeout => "校验超时".to_string(),
        _ => format!("{stage}失效"),
    }
}

/// Checks one source: search through content, and explore when it has one.
fn check_one(
    session: &SourceSession,
    keyword: &str,
    report: &dyn Fn(&str),
) -> Vec<(String, String)> {
    let source = session.env().source.clone();
    let mut failures = Vec::new();
    let chain = |book: BookData, stage: &str, failures: &mut Vec<(String, String)>| {
        let shared = Rc::new(RefCell::new(book));
        report(&format!("{stage}·详情"));
        if let Err(error) = session.book_info(&shared, false) {
            failures.push((failure_group("详情", &error), error.message));
            return;
        }
        report(&format!("{stage}·目录"));
        let chapters = match session.chapters(&shared) {
            Ok(chapters) => chapters,
            Err(error) => {
                failures.push((failure_group("目录", &error), error.message));
                return;
            }
        };
        let urls: Vec<String> = chapters.iter().map(chapter_absolute_url).collect();
        if let Some(first) = chapters.iter().position(|chapter| !chapter.is_volume) {
            report(&format!("{stage}·正文"));
            if let Err(error) = session.content(
                &shared,
                &chapters[first],
                urls.get(first + 1).map(String::as_str),
                &urls,
            ) {
                failures.push((failure_group("正文", &error), error.message));
            }
        }
    };
    match source.search_url().filter(|url| !url.trim().is_empty()) {
        Some(_) => {
            report("搜索");
            let keyword = if keyword.trim().is_empty() {
                source
                    .rule("ruleSearch", "checkKeyWord")
                    .unwrap_or_else(|| "我的".to_string())
            } else {
                keyword.to_string()
            };
            match session.search(&keyword, 1) {
                Ok(list) => match list.into_iter().next() {
                    Some(book) => chain(book, "搜索", &mut failures),
                    None => failures.push(("搜索失效".into(), "搜索结果为空".into())),
                },
                Err(error) => failures.push((failure_group("搜索", &error), error.message)),
            }
        }
        None => failures.push(("搜索链接规则为空".into(), "没有搜索地址".into())),
    }
    if source
        .explore_url()
        .is_some_and(|url| !url.trim().is_empty())
        && source.enabled_explore()
    {
        report("发现");
        match session.explore_kinds() {
            Ok(kinds) => match kinds.into_iter().find_map(|kind| kind.url) {
                Some(url) => match session.explore(&url, 1) {
                    Ok(list) if list.is_empty() => {
                        failures.push(("发现失效".into(), "发现列表为空".into()))
                    }
                    Ok(_) => {}
                    Err(error) => failures.push((failure_group("发现", &error), error.message)),
                },
                None => failures.push(("发现规则为空".into(), "发现没有分类地址".into())),
            },
            Err(error) => failures.push((failure_group("发现", &error), error.message)),
        }
    }
    failures
}

pub async fn check_book_sources(
    state: &Arc<AppState>,
    request: CheckSourcesRequest,
) -> Result<(), AppError> {
    let app = state.clone();
    let operations = &state.operations;
    let storage = state.storage.clone();
    let cancel = operations.register(&request.operation_id);
    let cancels = operations.cancels.clone();
    let queue = Arc::new(Mutex::new(request.urls.clone()));
    let total = request.urls.len() as u32;
    let checked = Arc::new(AtomicU32::new(0));
    let running = Arc::new(AtomicU32::new(CHECK_WORKERS as u32));
    for _ in 0..CHECK_WORKERS {
        let (storage, cancel, cancels, queue, checked, running, app) = (
            storage.clone(),
            cancel.clone(),
            cancels.clone(),
            queue.clone(),
            checked.clone(),
            running.clone(),
            app.clone(),
        );
        let id = request.operation_id.clone();
        let keyword = request.keyword.clone();
        let disable_failed = request.disable_failed;
        spawn_engine(move || {
            loop {
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                let Some(url) = queue.lock().ok().and_then(|mut queue| queue.pop()) else {
                    break;
                };
                let Ok(source) = load_source(&storage, &url) else {
                    continue;
                };
                let name = source.name();
                let event = |message: &str, finished: bool, ok: bool| SourceCheckEvent {
                    operation_id: id.clone(),
                    url: url.clone(),
                    name: name.clone(),
                    message: message.to_string(),
                    finished,
                    ok,
                    checked: checked.load(Ordering::Acquire),
                    total,
                };
                let report = |message: &str| {
                    let _ = app.emit("source-check", event(message, false, false));
                };
                let started = Instant::now();
                let control = Control::new(cancel.clone(), Some(started + CHECK_TIMEOUT));
                let failures = match session_for(&storage, source, control) {
                    Ok(session) => check_one(&session, &keyword, &report),
                    Err(error) => vec![(failure_group("搜索", &error), error.message)],
                };
                if cancel.load(Ordering::Acquire) {
                    // A cancelled check says nothing about the source.
                    break;
                }
                let elapsed = started.elapsed().as_millis() as i64;
                let groups: Vec<String> = failures.iter().map(|(group, _)| group.clone()).fold(
                    Vec::new(),
                    |mut list, group| {
                        if !list.contains(&group) {
                            list.push(group);
                        }
                        list
                    },
                );
                let error = failures.first().map(|(_, message)| message.clone());
                let respond = if failures.is_empty() {
                    elapsed
                } else {
                    CHECK_TIMEOUT.as_millis() as i64 + elapsed
                };
                if let Ok(mut guard) = storage.lock() {
                    let _ = guard.record_source_check(
                        &url,
                        &groups,
                        error.as_deref(),
                        respond,
                        disable_failed,
                    );
                }
                checked.fetch_add(1, Ordering::AcqRel);
                let message = if failures.is_empty() {
                    format!("校验成功（{} ms）", elapsed)
                } else {
                    format!("{}：{}", groups.join("、"), error.unwrap_or_default())
                };
                let _ = app.emit("source-check", event(&message, true, failures.is_empty()));
            }
            if running.fetch_sub(1, Ordering::AcqRel) == 1 {
                SourceOperations::finish(&cancels, &id);
                let _ = app.emit(
                    "source-check",
                    SourceCheckEvent {
                        operation_id: id.clone(),
                        url: String::new(),
                        name: String::new(),
                        message: if cancel.load(Ordering::Acquire) {
                            "校验已停止".into()
                        } else {
                            "校验完成".into()
                        },
                        finished: true,
                        ok: true,
                        checked: checked.load(Ordering::Acquire),
                        total,
                    },
                );
            }
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn script_errors_read_without_their_place() {
        assert_eq!(
            readable_script_error("Error: 书源：请求无效。（at body (eval_script:15:35)）"),
            "书源：请求无效。"
        );
        assert_eq!(
            readable_script_error("TypeError: not a function（at listOf (eval_script:97:65)）"),
            "TypeError: not a function"
        );
        assert_eq!(readable_script_error("网站返回 404"), "网站返回 404");
        let error = engine_error(SourceError::script(
            "Error: 请先登录（at body (eval_script:1:1)）",
        ));
        assert_eq!(error.key.as_deref(), Some("sourceScript"));
        assert_eq!(error.message, "请先登录");
    }

    use super::*;

    #[test]
    fn login_ui_rows_parse_leniently() {
        let rows = login_rows(
            "[{name:'账号',type:'text'},{\"name\":\"密码\",\"type\":\"password\"},{\"name\":\"登录\",\"type\":\"button\",\"action\":\"login()\"},{\"type\":\"text\"}]",
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].kind, "password");
        assert_eq!(rows[2].action.as_deref(), Some("login()"));
    }

    #[test]
    fn login_scripts_strip_their_markers() {
        let source = |url: &str| {
            BookSource::from_value(serde_json::json!({"bookSourceUrl": "https://a.com", "bookSourceName": "a", "loginUrl": url})).unwrap()
        };
        assert_eq!(
            login_script(&source("@js:function login(){}")).unwrap(),
            "function login(){}"
        );
        assert_eq!(
            login_script(&source("<js>function login(){}</js>")).unwrap(),
            "function login(){}"
        );
    }

    #[test]
    fn failures_map_to_legado_groups() {
        assert_eq!(
            failure_group("目录", &SourceError::network("x")),
            "网站失效"
        );
        assert_eq!(failure_group("目录", &SourceError::empty("x")), "目录失效");
        assert_eq!(failure_group("正文", &SourceError::script("x")), "js失效");
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use crate::sources::test_server::{html_site, html_source};

    fn session(source: serde_json::Value) -> SourceSession {
        SourceSession::new(
            BookSource::from_value(source).unwrap(),
            Arc::new(MemoryStore::default()),
            Control::unlimited(),
        )
        .unwrap()
    }

    #[test]
    fn debugging_walks_from_search_to_content() {
        let base = html_site();
        let session = session(html_source(&base));
        let lines = RefCell::new(Vec::new());
        debug_run(&session, "剑来", &|line| lines.borrow_mut().push(line)).unwrap();
        let lines = lines.into_inner();
        assert!(
            lines.iter().any(|line| line == "搜索到 2 本书"),
            "{lines:?}"
        );
        assert!(lines.iter().any(|line| line.starts_with("书名：剑来")));
        assert!(lines.iter().any(|line| line == "共 3 章"));
        assert!(lines
            .iter()
            .any(|line| line.starts_with("正文 ") && line.contains("第一段")));
        assert!(
            lines.iter().any(|line| line.contains("请求 ")),
            "requests are logged"
        );
    }

    #[test]
    fn checks_report_failures_by_stage() {
        let base = html_site();
        let mut healthy = html_source(&base);
        healthy.as_object_mut().unwrap().remove("exploreUrl");
        assert!(check_one(&session(healthy), "剑来", &|_| ()).is_empty());
        let mut broken = html_source(&base);
        broken["ruleToc"]["chapterList"] = "id.missing@dd".into();
        broken["exploreUrl"] = "坏::/nothing".into();
        let failures = check_one(&session_with(broken), "剑来", &|_| ());
        let groups: Vec<&str> = failures.iter().map(|(group, _)| group.as_str()).collect();
        // The explore page answers 404 with a body, so its list is empty.
        assert_eq!(groups, vec!["目录失效", "发现失效"], "{failures:?}");
    }

    fn session_with(source: serde_json::Value) -> SourceSession {
        session(source)
    }

    /// Checks the sources in `GRIPREAD_SOURCES` (a Legado JSON array) against
    /// their live sites and writes one line per source to
    /// `GRIPREAD_SOURCES_REPORT`. Live sites change, so this is a tool for
    /// compatibility reports, not an acceptance test.
    #[test]
    #[ignore]
    fn live_source_report() {
        let path = std::env::var("GRIPREAD_SOURCES").expect("GRIPREAD_SOURCES");
        let out = std::env::var("GRIPREAD_SOURCES_REPORT").expect("GRIPREAD_SOURCES_REPORT");
        let text = std::fs::read_to_string(path).unwrap();
        let sources: Vec<BookSource> = crate::sources::model::parse_sources(&text)
            .unwrap()
            .into_iter()
            .filter_map(|value| BookSource::from_value(value).ok())
            .filter(|source| source.source_type() == 0)
            .collect();
        let queue = Arc::new(Mutex::new(sources));
        let lines = Arc::new(Mutex::new(Vec::new()));
        let workers: Vec<_> = (0..12)
            .map(|_| {
                let (queue, lines) = (queue.clone(), lines.clone());
                std::thread::Builder::new()
                    .stack_size(16 * 1024 * 1024)
                    .spawn(move || loop {
                        let Some(source) = queue.lock().unwrap().pop() else {
                            break;
                        };
                        let name = source.name();
                        let started = Instant::now();
                        let control = Control::new(
                            Arc::new(AtomicBool::new(false)),
                            Some(started + Duration::from_secs(120)),
                        );
                        let (failures, logs) = match SourceSession::new(
                            source,
                            Arc::new(MemoryStore::default()),
                            control,
                        ) {
                            Ok(session) => {
                                let failures = check_one(&session, "", &|_| ());
                                let logs = session.logs();
                                let tail = logs[logs.len().saturating_sub(4)..].to_vec();
                                (failures, tail)
                            }
                            Err(error) => {
                                (vec![(failure_group("搜索", &error), error.message)], vec![])
                            }
                        };
                        let line = serde_json::json!({
                            "name": name,
                            "ms": started.elapsed().as_millis() as u64,
                            "failures": failures,
                            "logs": logs,
                        });
                        eprintln!("{line}");
                        lines.lock().unwrap().push(line);
                    })
                    .unwrap()
            })
            .collect();
        for worker in workers {
            let _ = worker.join();
        }
        let lines = lines.lock().unwrap();
        std::fs::write(out, serde_json::to_string_pretty(&*lines).unwrap()).unwrap();
    }

    /// Runs 调试 for the sources in `GRIPREAD_SOURCES` whose name contains
    /// `GRIPREAD_SOURCE_NAME`, printing every line and request.
    #[test]
    #[ignore]
    fn live_source_debug() {
        let path = std::env::var("GRIPREAD_SOURCES").expect("GRIPREAD_SOURCES");
        let name = std::env::var("GRIPREAD_SOURCE_NAME").expect("GRIPREAD_SOURCE_NAME");
        let key = std::env::var("GRIPREAD_SOURCE_KEY").unwrap_or_default();
        let text = std::fs::read_to_string(path).unwrap();
        let sources = crate::sources::model::parse_sources(&text).unwrap();
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                for value in sources {
                    let Ok(source) = BookSource::from_value(value) else {
                        continue;
                    };
                    if source.name() != name || source.source_type() != 0 {
                        continue;
                    }
                    let key = if key.is_empty() {
                        source
                            .rule("ruleSearch", "checkKeyWord")
                            .unwrap_or_else(|| "我的".into())
                    } else {
                        key.clone()
                    };
                    let session = SourceSession::new(
                        source,
                        Arc::new(MemoryStore::default()),
                        Control::new(
                            Arc::new(AtomicBool::new(false)),
                            Some(Instant::now() + Duration::from_secs(120)),
                        ),
                    )
                    .unwrap();
                    let outcome = debug_run(&session, &key, &|line| eprintln!("{line}"));
                    eprintln!("== {outcome:?}");
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
