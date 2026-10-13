//! Online books: multi-source search, explore, details, contents, and
//! chapter text, run on engine threads. Pages a source fetched once (a
//! details page that also lists the contents) are kept briefly so the next
//! step does not fetch them again.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};

use crate::commands::with_storage;
use crate::commands::AppState;
use crate::error::{AppError, ErrorCode};
use crate::models::{
    AddOnlineBookRequest, BookRequest, ExploreBooksRequest, ExploreKindsRequest, LibraryBook,
    OnlineBook, OnlineBookRequest, OnlineChapter, OnlineContent, OnlineContentRequest,
    OnlineCoverRequest, OnlineSearchEvent, OnlineSearchResult, OnlineTocEvent, SearchOnlineRequest,
    SetOnlineBookFlagRequest, SourceFailure, UpdateOnlineTocRequest,
};
use crate::source_commands::{
    engine_error, load_source, on_engine_thread, session_for, spawn_engine, SourceOperations,
};
use crate::sources::context::{BookData, ChapterData, Control};
use crate::sources::error::SourceError;
use crate::sources::model::BookSource;
use crate::sources::url::AnalyzeUrl;
use crate::sources::web_book::{ExploreKind, SourceSession};
use crate::storage::split_groups;

const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const STEP_TIMEOUT: Duration = Duration::from_secs(90);
const PAGE_CACHE_LIMIT: usize = 64;
const UPDATE_WORKERS: usize = 4;
/// Details and contents kept from a source are used for an hour.
const BOOK_KEEP_MS: i64 = 3_600_000;
const EXPLORE_KEEP_MS: i64 = 600_000;
/// Covers are fetched a few at a time, each within its own limit.
const COVER_WORKERS: usize = 4;
const COVER_TIMEOUT: Duration = Duration::from_secs(30);

/// A book's details page and contents page, as one source fetched them.
type KeptPages = (String, Option<String>, Option<String>);

/// Details and contents pages kept between steps, by source and book.
#[derive(Default)]
pub struct OnlinePages {
    pages: Mutex<Vec<KeptPages>>,
}

impl OnlinePages {
    fn key(source_url: &str, book_url: &str) -> String {
        format!("{source_url}\n{book_url}")
    }

    fn remember(&self, source_url: &str, book: &BookData) {
        if book.info_html.is_none() && book.toc_html.is_none() {
            return;
        }
        let key = Self::key(source_url, &book.book_url);
        if let Ok(mut pages) = self.pages.lock() {
            pages.retain(|(existing, _, _)| *existing != key);
            pages.push((key, book.info_html.clone(), book.toc_html.clone()));
            let excess = pages.len().saturating_sub(PAGE_CACHE_LIMIT);
            pages.drain(..excess);
        }
    }

    fn restore(&self, source_url: &str, book: &mut BookData) {
        let key = Self::key(source_url, &book.book_url);
        if let Ok(pages) = self.pages.lock() {
            if let Some((_, info, toc)) = pages.iter().find(|(existing, _, _)| *existing == key) {
                if book.info_html.is_none() {
                    book.info_html = info.clone();
                }
                if book.toc_html.is_none() {
                    book.toc_html = toc.clone();
                }
            }
        }
    }
}

fn variables_json(variables: &crate::sources::context::VarMap) -> String {
    if variables.is_empty() {
        String::new()
    } else {
        serde_json::to_string(variables).unwrap_or_default()
    }
}

fn parse_variables(text: &str) -> crate::sources::context::VarMap {
    serde_json::from_str::<BTreeMap<String, serde_json::Value>>(text)
        .map(|map| {
            map.into_iter()
                .map(|(key, value)| (key, crate::sources::value::json_text(&value)))
                .collect()
        })
        .unwrap_or_default()
}

pub fn online_book(book: &BookData) -> OnlineBook {
    OnlineBook {
        source_url: book.origin.clone(),
        source_name: book.origin_name.clone(),
        name: book.name.clone(),
        author: book.author.clone(),
        kind: book.kind.clone(),
        cover_url: book.cover_url.clone(),
        intro: book.intro.clone(),
        word_count: book.word_count.clone(),
        latest_chapter_title: book.latest_chapter_title.clone(),
        book_url: book.book_url.clone(),
        toc_url: book.toc_url.clone(),
        variables: variables_json(&book.variables),
        reverse_toc: book.reverse_toc,
    }
}

pub fn book_data(book: &OnlineBook) -> BookData {
    BookData {
        name: book.name.clone(),
        author: book.author.clone(),
        kind: book.kind.clone(),
        cover_url: book.cover_url.clone(),
        intro: book.intro.clone(),
        word_count: book.word_count.clone(),
        latest_chapter_title: book.latest_chapter_title.clone(),
        update_time: String::new(),
        book_url: book.book_url.clone(),
        toc_url: book.toc_url.clone(),
        origin: book.source_url.clone(),
        origin_name: book.source_name.clone(),
        variables: parse_variables(&book.variables),
        info_html: None,
        toc_html: None,
        reverse_toc: book.reverse_toc,
    }
}

pub fn online_chapter(chapter: &ChapterData) -> OnlineChapter {
    OnlineChapter {
        index: chapter.index as u32,
        title: chapter.title.clone(),
        url: chapter.url.clone(),
        base_url: chapter.base_url.clone(),
        is_volume: chapter.is_volume,
        is_vip: chapter.is_vip,
        is_pay: chapter.is_pay,
        tag: chapter.tag.clone(),
        variables: variables_json(&chapter.variables),
    }
}

pub fn chapter_data(chapter: &OnlineChapter) -> ChapterData {
    ChapterData {
        title: chapter.title.clone(),
        url: chapter.url.clone(),
        base_url: chapter.base_url.clone(),
        index: chapter.index as usize,
        is_volume: chapter.is_volume,
        is_vip: chapter.is_vip,
        is_pay: chapter.is_pay,
        tag: chapter.tag.clone(),
        variables: parse_variables(&chapter.variables),
    }
}

/// Legado's `SearchModel.mergeItems`: results with the same name and author
/// fold into one; exact matches of the key come first, then results that
/// contain it, each ordered by how many sources have them, then the rest in
/// arrival order (left out by precise search).
pub fn merge_results(key: &str, books: &[OnlineBook], precise: bool) -> Vec<OnlineSearchResult> {
    let key = key.trim();
    let mut tiers: [Vec<OnlineSearchResult>; 3] = Default::default();
    for book in books {
        let tier = if book.name == key || book.author == key {
            0
        } else if book.name.contains(key) || book.author.contains(key) {
            1
        } else if precise {
            continue;
        } else {
            2
        };
        let list = &mut tiers[tier];
        match list
            .iter_mut()
            .find(|result| result.name == book.name && result.author == book.author)
        {
            Some(result) => {
                if !result
                    .origins
                    .iter()
                    .any(|origin| origin.source_url == book.source_url)
                {
                    result.origins.push(book.clone());
                }
                if result.cover_url.is_empty() {
                    result.cover_url = book.cover_url.clone();
                }
                if result.intro.is_empty() {
                    result.intro = book.intro.clone();
                }
            }
            None => list.push(OnlineSearchResult {
                name: book.name.clone(),
                author: book.author.clone(),
                kind: book.kind.clone(),
                cover_url: book.cover_url.clone(),
                intro: book.intro.clone(),
                word_count: book.word_count.clone(),
                latest_chapter_title: book.latest_chapter_title.clone(),
                origins: vec![book.clone()],
            }),
        }
    }
    let [mut equal, mut contains, other] = tiers;
    equal.sort_by_key(|result| std::cmp::Reverse(result.origins.len()));
    contains.sort_by_key(|result| std::cmp::Reverse(result.origins.len()));
    equal.extend(contains);
    equal.extend(other);
    equal
}

/// The sources a search asks, in the manual order.
fn search_sources(
    storage: &crate::storage::Storage,
    request: &SearchOnlineRequest,
) -> Result<Vec<BookSource>, AppError> {
    let all = storage.book_sources()?;
    let has_search = |source: &BookSource| {
        source
            .search_url()
            .is_some_and(|url| !url.trim().is_empty())
    };
    let scope = &request.scope;
    Ok(all
        .into_iter()
        .filter(|source| {
            if !scope.source_urls.is_empty() {
                // A source asked for by name is searched even when disabled.
                return scope.source_urls.contains(&source.url()) && has_search(source);
            }
            if !(source.enabled() && has_search(source)) {
                return false;
            }
            scope.groups.is_empty()
                || split_groups(&source.group())
                    .iter()
                    .any(|group| scope.groups.contains(group))
        })
        .collect())
}

#[tauri::command]
pub async fn search_online_books(
    request: SearchOnlineRequest,
    app: AppHandle,
    state: State<'_, AppState>,
    operations: State<'_, SourceOperations>,
    pages: State<'_, Arc<OnlinePages>>,
) -> Result<(), AppError> {
    let storage = state.storage.clone();
    let sources = {
        let guard = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        search_sources(&guard, &request)?
    };
    let total = sources.len() as u32;
    let cancel = operations.register(&request.operation_id);
    let cancels = operations.cancels();
    let found: Arc<Mutex<(Vec<OnlineBook>, Vec<SourceFailure>)>> = Arc::default();
    let searched = Arc::new(AtomicU32::new(0));
    let queue = Arc::new(Mutex::new(sources.into_iter().rev().collect::<Vec<_>>()));
    // 网络设置 decides how many sources are asked at once.
    let workers = usize::from(crate::network::limits().search).min(total.max(1) as usize);
    let running = Arc::new(AtomicU32::new(workers as u32));
    let emit = {
        let app = app.clone();
        let request = request.clone();
        let found = found.clone();
        let searched = searched.clone();
        Arc::new(move |done: bool| {
            let Ok(found) = found.lock() else { return };
            let _ = app.emit(
                "online-search",
                OnlineSearchEvent {
                    operation_id: request.operation_id.clone(),
                    searched: searched.load(Ordering::Acquire),
                    total,
                    done,
                    results: merge_results(&request.key, &found.0, request.precise),
                    failures: found.1.clone(),
                },
            );
        })
    };
    if total == 0 {
        emit(true);
        SourceOperations::finish(&cancels, &request.operation_id);
        return Ok(());
    }
    for _ in 0..workers {
        let (storage, cancel, cancels, queue, found, searched, running, emit, pages) = (
            storage.clone(),
            cancel.clone(),
            cancels.clone(),
            queue.clone(),
            found.clone(),
            searched.clone(),
            running.clone(),
            emit.clone(),
            pages.inner().clone(),
        );
        let request = request.clone();
        spawn_engine(move || {
            loop {
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                let Some(source) = queue.lock().ok().and_then(|mut queue| queue.pop()) else {
                    break;
                };
                let name = source.name();
                let url = source.url();
                let control = Control::new(cancel.clone(), Some(Instant::now() + SEARCH_TIMEOUT));
                let outcome = session_for(&storage, source, control)
                    .and_then(|session| session.search(&request.key, request.page.max(1) as i64));
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                searched.fetch_add(1, Ordering::AcqRel);
                if let Ok(mut found) = found.lock() {
                    match outcome {
                        Ok(books) => {
                            for book in &books {
                                pages.remember(&url, book);
                            }
                            found.0.extend(books.iter().map(online_book));
                        }
                        Err(error) => {
                            crate::app_log::warn(
                                "source",
                                format!("{name} 搜索失败：{}", error.message),
                            );
                            found.1.push(SourceFailure {
                                source_name: name,
                                message: error.message,
                            })
                        }
                    }
                }
                emit(false);
            }
            if running.fetch_sub(1, Ordering::AcqRel) == 1 {
                SourceOperations::finish(&cancels, &request.operation_id);
                emit(true);
            }
        })?;
    }
    Ok(())
}

/// Runs one step of a source's chain with a deadline.
async fn run_step<T: Send + 'static>(
    state: &State<'_, AppState>,
    source_url: String,
    step: impl FnOnce(&SourceSession) -> Result<T, SourceError> + Send + 'static,
) -> Result<T, AppError> {
    let storage = state.storage.clone();
    on_engine_thread(move || {
        let source = load_source(&storage, &source_url)?;
        let name = source.name();
        let control = Control::new(Default::default(), Some(Instant::now() + STEP_TIMEOUT));
        let session = session_for(&storage, source, control).map_err(engine_error)?;
        step(&session).map_err(|error| {
            crate::app_log::error(
                "source",
                format!("{name}（{source_url}）：{}", error.message),
            );
            engine_error(error)
        })
    })
    .await?
}

#[tauri::command]
pub async fn explore_kinds(
    request: ExploreKindsRequest,
    state: State<'_, AppState>,
) -> Result<Vec<ExploreKind>, AppError> {
    let refresh = request.refresh;
    run_step(&state, request.source_url, move |session| {
        if refresh {
            crate::sources::web_book::clear_explore_cache(session.env());
        }
        session.explore_kinds()
    })
    .await
}

#[tauri::command]
pub async fn explore_books(
    request: ExploreBooksRequest,
    state: State<'_, AppState>,
    pages: State<'_, Arc<OnlinePages>>,
) -> Result<Vec<OnlineBook>, AppError> {
    let pages = pages.inner().clone();
    let source_url = request.source_url.clone();
    // A category page is kept for ten minutes, so going back and forth
    // does not ask the source again.
    let key = format!(
        "explore:{}\n{}\n{}",
        request.source_url, request.url, request.page
    );
    let kept = with_storage(&state, {
        let key = key.clone();
        move |storage| storage.cached_book_part(&key, "info", Some(EXPLORE_KEEP_MS))
    })
    .await?;
    if let Some(books) = kept.and_then(|json| serde_json::from_str::<Vec<OnlineBook>>(&json).ok()) {
        return Ok(books);
    }
    let books: Vec<OnlineBook> = run_step(&state, request.source_url, move |session| {
        let books = session.explore(&request.url, request.page.max(1) as i64)?;
        for book in &books {
            pages.remember(&source_url, book);
        }
        Ok(books.iter().map(online_book).collect())
    })
    .await?;
    let json = serde_json::to_string(&books)?;
    with_storage(&state, move |storage| {
        storage.keep_book_part(&key, "info", &json)
    })
    .await?;
    Ok(books)
}

#[tauri::command]
pub async fn online_book_info(
    request: OnlineBookRequest,
    state: State<'_, AppState>,
    pages: State<'_, Arc<OnlinePages>>,
) -> Result<OnlineBook, AppError> {
    let pages = pages.inner().clone();
    let source_url = request.book.source_url.clone();
    let key = crate::storage::book_cache_key(&source_url, &request.book.book_url);
    if !request.refresh.unwrap_or(false) {
        let kept = with_storage(&state, {
            let key = key.clone();
            move |storage| storage.cached_book_part(&key, "info", Some(BOOK_KEEP_MS))
        })
        .await?;
        if let Some(book) = kept.and_then(|json| serde_json::from_str::<OnlineBook>(&json).ok()) {
            return Ok(book);
        }
    }
    let book = run_step(&state, source_url.clone(), move |session| {
        let mut data = book_data(&request.book);
        pages.restore(&source_url, &mut data);
        let book = Rc::new(RefCell::new(data));
        session.book_info(&book, false)?;
        let data = book.borrow().clone();
        pages.remember(&source_url, &data);
        Ok(online_book(&data))
    })
    .await?;
    let json = serde_json::to_string(&book)?;
    with_storage(&state, move |storage| {
        storage.keep_book_part(&key, "info", &json)
    })
    .await?;
    Ok(book)
}

#[tauri::command]
pub async fn online_book_chapters(
    request: OnlineBookRequest,
    state: State<'_, AppState>,
    pages: State<'_, Arc<OnlinePages>>,
) -> Result<Vec<OnlineChapter>, AppError> {
    let pages = pages.inner().clone();
    let source_url = request.book.source_url.clone();
    let key = crate::storage::book_cache_key(&source_url, &request.book.book_url);
    if !request.refresh.unwrap_or(false) {
        let kept = with_storage(&state, {
            let key = key.clone();
            move |storage| storage.cached_book_part(&key, "toc", Some(BOOK_KEEP_MS))
        })
        .await?;
        if let Some(chapters) =
            kept.and_then(|json| serde_json::from_str::<Vec<OnlineChapter>>(&json).ok())
        {
            return Ok(chapters);
        }
    }
    let chapters: Vec<OnlineChapter> = run_step(&state, source_url.clone(), move |session| {
        let mut data = book_data(&request.book);
        pages.restore(&source_url, &mut data);
        let book = Rc::new(RefCell::new(data));
        if book.borrow().toc_url.is_empty() {
            session.book_info(&book, false)?;
        }
        let chapters = session.chapters(&book)?;
        Ok(chapters.iter().map(online_chapter).collect())
    })
    .await?;
    let json = serde_json::to_string(&chapters)?;
    with_storage(&state, move |storage| {
        storage.keep_book_part(&key, "toc", &json)
    })
    .await?;
    Ok(chapters)
}

#[tauri::command]
pub async fn online_chapter_content(
    request: OnlineContentRequest,
    state: State<'_, AppState>,
    pages: State<'_, Arc<OnlinePages>>,
) -> Result<OnlineContent, AppError> {
    let pages = pages.inner().clone();
    let source_url = request.book.source_url.clone();
    run_step(&state, source_url.clone(), move |session| {
        let mut data = book_data(&request.book);
        pages.restore(&source_url, &mut data);
        let book = Rc::new(RefCell::new(data));
        let chapter = chapter_data(&request.chapter);
        let content = session.content(&book, &chapter, request.next_chapter_url.as_deref(), &[])?;
        Ok(OnlineContent {
            title: content.title,
            text: content.text,
        })
    })
    .await
}

/// Waits for one of the cover fetch slots.
struct CoverSlot;

fn cover_slots() -> &'static (Mutex<usize>, std::sync::Condvar) {
    static SLOTS: std::sync::OnceLock<(Mutex<usize>, std::sync::Condvar)> =
        std::sync::OnceLock::new();
    SLOTS.get_or_init(|| (Mutex::new(0), std::sync::Condvar::new()))
}

impl CoverSlot {
    fn take() -> Self {
        let (count, ready) = cover_slots();
        let mut taken = count.lock().unwrap_or_else(|poison| poison.into_inner());
        while *taken >= COVER_WORKERS {
            taken = ready
                .wait(taken)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        *taken += 1;
        CoverSlot
    }
}

impl Drop for CoverSlot {
    fn drop(&mut self) {
        let (count, ready) = cover_slots();
        if let Ok(mut taken) = count.lock() {
            *taken = taken.saturating_sub(1);
        }
        ready.notify_one();
    }
}

/// A cover image: the kept copy, or fetched with the source's headers and
/// cookies and then kept. Runs on an engine thread.
fn cover_bytes(
    storage: &Arc<Mutex<crate::storage::Storage>>,
    source_url: &str,
    url: &str,
) -> Result<Vec<u8>, AppError> {
    use crate::storage::CachedCover;
    let key = crate::storage::cover_key(source_url, url);
    let lock = || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
    };
    match lock()?.cached_cover(&key)? {
        CachedCover::Kept(path) => return Ok(std::fs::read(path)?),
        CachedCover::RecentlyFailed => {
            return Err(AppError::new(ErrorCode::Io, "封面暂时无法下载"));
        }
        CachedCover::Unknown => {}
    }
    let _slot = CoverSlot::take();
    let source = load_source(storage, source_url)?;
    let decode = source.cover_decode_js().filter(|js| !js.trim().is_empty());
    let control = Control::new(Default::default(), Some(Instant::now() + COVER_TIMEOUT));
    let session = session_for(storage, source, control).map_err(engine_error)?;
    let fetched = session.run_with_rule(|scope, rule| {
        let page = session.env().source.url();
        let mut address = AnalyzeUrl::new(rule, scope, url, None, None, &page, None)?;
        let mut response = address.get_str_response(session.env())?;
        // Image hosts that refuse other sites' pages want the source as Referer.
        let has_referer = address
            .headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("referer"));
        if (!response.is_success() || !is_image(&response.bytes)) && !has_referer {
            address.headers.push(("Referer".to_string(), page.clone()));
            if let Ok(retried) = address.get_str_response(session.env()) {
                response = retried;
            }
        }
        let mut bytes = response.bytes;
        // Legado's coverDecodeJs: `result` is the image's bytes; it returns
        // the decoded bytes.
        if let Some(js) = &decode {
            let input = crate::sources::value::Val::Json(serde_json::Value::Array(
                bytes
                    .iter()
                    .map(|byte| serde_json::Value::from(*byte as i8))
                    .collect(),
            ));
            let output = rule.eval_js(scope, js, &input)?;
            bytes = decoded_bytes(&output).unwrap_or(bytes);
        }
        if !response.code.to_string().starts_with('2') && !is_image(&bytes) {
            return Err(SourceError::rule(format!(
                "封面下载失败（{}）",
                response.code
            )));
        }
        if !is_image(&bytes) {
            return Err(SourceError::rule("封面不是图片".to_string()));
        }
        Ok(bytes)
    });
    match fetched {
        Ok(bytes) => {
            lock()?.keep_cover(&key, &bytes)?;
            Ok(bytes)
        }
        Err(error) => {
            // Only a definite answer waits before asking again; a timeout or
            // dropped connection is tried again next time.
            if error.kind == crate::sources::error::SourceErrorKind::Rule {
                lock()?.record_cover_failure(&key)?;
            }
            crate::app_log::warn("source", format!("封面下载失败 {url}：{}", error.message));
            Err(engine_error(error))
        }
    }
}

/// Whether bytes start like an image the WebView shows.
pub(crate) fn is_image(bytes: &[u8]) -> bool {
    matches!(
        bytes,
        [0xff, 0xd8, 0xff, ..]
            | [0x89, b'P', b'N', b'G', ..]
            | [b'G', b'I', b'F', b'8', ..]
            | [b'B', b'M', ..]
            | [
                b'R',
                b'I',
                b'F',
                b'F',
                _,
                _,
                _,
                _,
                b'W',
                b'E',
                b'B',
                b'P',
                ..
            ]
            | [_, _, _, _, b'f', b't', b'y', b'p', ..]
            | [b'<', b's', b'v', b'g', ..]
    ) || bytes.starts_with(b"<?xml") && bytes.windows(4).take(256).any(|window| window == b"<svg")
}

/// The bytes a coverDecodeJs script returned (an array of byte values).
fn decoded_bytes(value: &crate::sources::value::Val) -> Option<Vec<u8>> {
    use crate::sources::value::Val;
    match value {
        Val::Json(serde_json::Value::Array(items)) => items
            .iter()
            .map(|item| item.as_f64().map(|byte| byte as i64 as u8))
            .collect(),
        Val::List(items) => items
            .iter()
            .map(|item| {
                item.to_text()
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .map(|byte| byte as i64 as u8)
            })
            .collect(),
        _ => None,
    }
}

/// A cover image fetched with the source's headers and cookies, kept on
/// the device after the first time.
#[tauri::command]
pub async fn online_cover(
    request: OnlineCoverRequest,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, AppError> {
    let storage = state.storage.clone();
    let bytes = on_engine_thread(move || cover_bytes(&storage, &request.source_url, &request.url))
        .await??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Saves a source's cover as the book's own cover (加入书架, 换封面).
#[tauri::command]
pub async fn set_cover_from_source(
    request: crate::models::SourceCoverRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let storage = state.storage.clone();
    on_engine_thread(move || {
        let bytes = cover_bytes(&storage, &request.source_url, &request.url)?;
        let key = crate::storage::cover_key(&request.source_url, &request.url);
        let mut guard = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        let path = guard.keep_cover(&key, &bytes)?;
        let ext = image_extension(&bytes);
        guard.set_book_cover(&request.book_id, &path, &format!("cover.{ext}"))?;
        Ok(())
    })
    .await?
}

fn image_extension(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "png",
        [b'G', b'I', b'F', ..] => "gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "webp",
        _ => "jpg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_are_recognised_by_their_bytes() {
        assert!(is_image(&[0xff, 0xd8, 0xff, 0xe0, 0]));
        assert!(is_image(b"\x89PNG\r\n"));
        assert!(is_image(b"RIFF\0\0\0\0WEBPVP8"));
        assert!(is_image(b"\0\0\0\x20ftypavif"));
        assert!(!is_image(b"<html><body>403</body></html>"));
        assert!(!is_image(b""));
        let decoded = decoded_bytes(&crate::sources::value::Val::Json(serde_json::json!([
            -1, -40, 1
        ])));
        assert_eq!(decoded, Some(vec![0xff, 0xd8, 1]));
    }

    /// Explore → details → contents for sources named `GRIPREAD_SOURCE_NAME`,
    /// the way 发现 opens a book, printing each step's fields.
    #[test]
    #[ignore]
    fn live_explore_detail() {
        let path = std::env::var("GRIPREAD_SOURCES").expect("GRIPREAD_SOURCES");
        let only = std::env::var("GRIPREAD_SOURCE_NAME").expect("GRIPREAD_SOURCE_NAME");
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let dir =
                    std::env::temp_dir().join(format!("gripread-explore-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&dir).unwrap();
                let storage = Arc::new(Mutex::new(crate::storage::Storage::open(&dir).unwrap()));
                let text = std::fs::read_to_string(path).unwrap();
                for raw in crate::sources::model::parse_sources(&text).unwrap() {
                    let name = raw["bookSourceName"].as_str().unwrap_or("").to_string();
                    if !name.contains(&only) {
                        continue;
                    }
                    storage
                        .lock()
                        .unwrap()
                        .save_book_source(&raw.to_string(), None)
                        .unwrap();
                    let url = raw["bookSourceUrl"].as_str().unwrap_or("").to_string();
                    let source = load_source(&storage, &url).unwrap();
                    let session = session_for(&storage, source, Control::unlimited()).unwrap();
                    let kinds = session.explore_kinds().unwrap_or_default();
                    let Some(kind) = kinds.iter().find_map(|kind| kind.url.clone()) else {
                        eprintln!("{name}: 没有发现分类");
                        continue;
                    };
                    let books = match session.explore(&kind, 1) {
                        Ok(books) => books,
                        Err(error) => {
                            eprintln!("{name}: 发现失败 {}", error.message);
                            continue;
                        }
                    };
                    let Some(first) = books.into_iter().next() else {
                        eprintln!("{name}: 发现为空");
                        continue;
                    };
                    let listed = online_book(&first);
                    eprintln!(
                        "{name}: 列表 《{}》 cover={} url={} toc={}",
                        listed.name, listed.cover_url, listed.book_url, listed.toc_url
                    );
                    // The page sends the listed book back to the details step.
                    let book = Rc::new(RefCell::new(book_data(&listed)));
                    match session.book_info(&book, false) {
                        Ok(()) => {
                            let info = online_book(&book.borrow());
                            eprintln!(
                                "{name}: 详情 cover={} toc={} intro={}",
                                info.cover_url,
                                info.toc_url,
                                info.intro.chars().take(20).collect::<String>()
                            );
                        }
                        Err(error) => eprintln!("{name}: 详情失败 {}", error.message),
                    }
                    match session.chapters(&book) {
                        Ok(chapters) => eprintln!("{name}: 目录 {} 章", chapters.len()),
                        Err(error) => eprintln!("{name}: 目录失败 {}", error.message),
                    }
                }
                let _ = std::fs::remove_dir_all(dir);
            })
            .unwrap()
            .join()
            .unwrap();
    }

    /// For each source in `GRIPREAD_SOURCES` (optionally only those whose
    /// name contains `GRIPREAD_SOURCE_NAME`): search, then explore page 1,
    /// then fetch up to three covers the way the app does, printing why each
    /// one fails. A tool for cover problems on live sites.
    #[test]
    #[ignore]
    fn live_cover_report() {
        let path = std::env::var("GRIPREAD_SOURCES").expect("GRIPREAD_SOURCES");
        let only = std::env::var("GRIPREAD_SOURCE_NAME").unwrap_or_default();
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let dir =
                    std::env::temp_dir().join(format!("gripread-covers-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&dir).unwrap();
                let storage = Arc::new(Mutex::new(crate::storage::Storage::open(&dir).unwrap()));
                let text = std::fs::read_to_string(path).unwrap();
                for raw in crate::sources::model::parse_sources(&text).unwrap() {
                    let name = raw["bookSourceName"].as_str().unwrap_or("").to_string();
                    if !only.is_empty() && !name.contains(&only) {
                        continue;
                    }
                    storage
                        .lock()
                        .unwrap()
                        .save_book_source(&raw.to_string(), None)
                        .unwrap();
                    let url = raw["bookSourceUrl"].as_str().unwrap_or("").to_string();
                    let Ok(source) = load_source(&storage, &url) else {
                        continue;
                    };
                    let key = source
                        .rule("ruleSearch", "checkKeyWord")
                        .unwrap_or_else(|| "我的".into());
                    let control = Control::new(
                        Default::default(),
                        Some(Instant::now() + Duration::from_secs(40)),
                    );
                    let Ok(session) = session_for(&storage, source, control) else {
                        continue;
                    };
                    let mut books = session.search(&key, 1).unwrap_or_default();
                    if books.is_empty() {
                        if let Some(kind) = session
                            .explore_kinds()
                            .ok()
                            .and_then(|kinds| kinds.into_iter().find_map(|kind| kind.url))
                        {
                            books = session.explore(&kind, 1).unwrap_or_default();
                        }
                    }
                    if books.is_empty() {
                        eprintln!("{name}: 没有书");
                        continue;
                    }
                    for book in books.iter().take(3) {
                        if book.cover_url.is_empty() {
                            eprintln!("{name}: 《{}》没有封面地址", book.name);
                            continue;
                        }
                        let outcome = cover_bytes(&storage, &url, &book.cover_url);
                        match outcome {
                            Ok(bytes) => eprintln!(
                                "{name}: ok {} 字节 {:02x?} {}",
                                bytes.len(),
                                &bytes[..bytes.len().min(4)],
                                book.cover_url
                            ),
                            Err(error) => {
                                eprintln!("{name}: 失败 {} — {}", error.message, book.cover_url)
                            }
                        }
                    }
                }
                let _ = std::fs::remove_dir_all(dir);
            })
            .unwrap()
            .join()
            .unwrap();
    }

    fn book(source: &str, name: &str, author: &str) -> OnlineBook {
        OnlineBook {
            source_url: source.into(),
            source_name: source.into(),
            name: name.into(),
            author: author.into(),
            kind: String::new(),
            cover_url: String::new(),
            intro: String::new(),
            word_count: String::new(),
            latest_chapter_title: String::new(),
            book_url: format!("{source}/{name}"),
            toc_url: String::new(),
            variables: String::new(),
            reverse_toc: false,
        }
    }

    #[test]
    fn results_merge_by_name_and_author_in_legado_tiers() {
        let books = vec![
            book("a", "剑来外传", "某"),
            book("a", "剑来", "烽火"),
            book("b", "剑来", "烽火"),
            book("c", "剑来", "别人"),
            book("b", "雪中", "烽火"),
            book("c", "剑来外传", "某"),
            book("d", "剑来外传", "某"),
        ];
        let merged = merge_results("剑来", &books, false);
        let shown: Vec<(&str, &str, usize)> = merged
            .iter()
            .map(|result| {
                (
                    result.name.as_str(),
                    result.author.as_str(),
                    result.origins.len(),
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                ("剑来", "烽火", 2),
                ("剑来", "别人", 1),
                ("剑来外传", "某", 3),
                ("雪中", "烽火", 1)
            ]
        );
        let precise = merge_results("剑来", &books, true);
        assert_eq!(precise.len(), 3);
    }

    #[test]
    fn books_and_chapters_round_trip_their_variables() {
        let mut data = BookData {
            name: "书".into(),
            origin: "https://a.com".into(),
            ..Default::default()
        };
        data.variables.insert("bid".into(), "7".into());
        let back = book_data(&online_book(&data));
        assert_eq!(back.variables["bid"], "7");
        assert_eq!(back.origin, "https://a.com");
        let mut chapter = ChapterData {
            title: "第一章".into(),
            index: 3,
            ..Default::default()
        };
        chapter.variables.insert("cid".into(), "1".into());
        let back = chapter_data(&online_chapter(&chapter));
        assert_eq!(back.index, 3);
        assert_eq!(back.variables["cid"], "1");
    }
}

/// Puts an online book on the shelf with its contents, or opens it for
/// reading only (`on_shelf` false), as Legado's 加入书架 and 阅读 do.
#[tauri::command]
pub async fn add_online_book(
    request: AddOnlineBookRequest,
    state: State<'_, AppState>,
) -> Result<LibraryBook, AppError> {
    with_storage(&state, move |storage| {
        let id = storage.add_online_book(&request.book, &request.chapters, request.on_shelf)?;
        storage.library_book(&id)
    })
    .await
}

/// 换源 for a kept online book.
#[tauri::command]
pub async fn change_online_source(
    request: crate::models::ChangeOnlineSourceRequest,
    state: State<'_, AppState>,
) -> Result<crate::models::ChangeOnlineSourceResult, AppError> {
    with_storage(&state, move |storage| {
        let moved =
            storage.switch_online_source(&request.book_id, &request.book, &request.chapters)?;
        crate::online_reader::forget_shown(&request.book_id);
        crate::app_log::info(
            "source",
            format!(
                "换源：《{}》换到 {}，{}",
                request.book.name,
                request.book.source_name,
                match moved {
                    Some((index, true)) => format!("进度移到第 {} 章", index + 1),
                    Some((index, false)) => format!("没有找到对应章节，停在第 {} 章", index + 1),
                    None => "尚未阅读".into(),
                }
            ),
        );
        Ok(crate::models::ChangeOnlineSourceResult {
            book: storage.library_book(&request.book_id)?,
            chapter: moved.map(|(index, _)| index),
            certain: moved.is_none_or(|(_, certain)| certain),
            locator: storage.saved_position(&request.book_id)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn find_online_book(
    request: crate::models::FindOnlineBookRequest,
    state: State<'_, AppState>,
) -> Result<Option<LibraryBook>, AppError> {
    with_storage(&state, move |storage| {
        storage
            .find_online_book(&request.name, &request.author)?
            .map(|id| storage.library_book(&id))
            .transpose()
    })
    .await
}

#[tauri::command]
pub async fn get_library_book(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<LibraryBook, AppError> {
    with_storage(&state, move |storage| {
        storage.library_book(&request.book_id)
    })
    .await
}

#[tauri::command]
pub async fn set_online_on_shelf(
    request: SetOnlineBookFlagRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_storage(&state, move |storage| {
        storage.set_online_on_shelf(&request.book_id, request.on)
    })
    .await
}

#[tauri::command]
pub async fn set_online_can_update(
    request: SetOnlineBookFlagRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    with_storage(&state, move |storage| {
        storage.set_online_can_update(&request.book_id, request.on)
    })
    .await
}

/// Leaving a book read from search: it is dropped unless it was added.
/// Returns whether it was dropped.
#[tauri::command]
pub async fn leave_online_book(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<bool, AppError> {
    with_storage(&state, move |storage| {
        if !storage.is_online_book(&request.book_id)? {
            return Ok(false);
        }
        storage.drop_unshelved_online_book(&request.book_id)
    })
    .await
}

#[tauri::command]
pub async fn list_online_chapters(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<Vec<OnlineChapter>, AppError> {
    with_storage(&state, move |storage| {
        storage.online_chapters(&request.book_id)
    })
    .await
}

#[tauri::command]
pub async fn clear_online_cache(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    crate::online_reader::forget_shown(&request.book_id);
    with_storage(&state, move |storage| {
        storage.clear_online_cache(&request.book_id)
    })
    .await
}

/// Legado's 更新目录 over shelf books, a few at a time, streaming
/// `online-toc` per book and once when done.
#[tauri::command]
pub async fn update_online_toc(
    request: UpdateOnlineTocRequest,
    app: AppHandle,
    state: State<'_, AppState>,
    operations: State<'_, SourceOperations>,
) -> Result<(), AppError> {
    let storage = state.storage.clone();
    let ids = if request.book_ids.is_empty() {
        with_storage(&state, |storage| storage.updatable_online_books()).await?
    } else {
        request.book_ids.clone()
    };
    let cancel = operations.register(&request.operation_id);
    let cancels = operations.cancels();
    let total = ids.len() as u32;
    let queue = Arc::new(Mutex::new(ids));
    let updated = Arc::new(AtomicU32::new(0));
    let running = Arc::new(AtomicU32::new(UPDATE_WORKERS as u32));
    for _ in 0..UPDATE_WORKERS {
        let (storage, cancel, cancels, queue, updated, running, app) = (
            storage.clone(),
            cancel.clone(),
            cancels.clone(),
            queue.clone(),
            updated.clone(),
            running.clone(),
            app.clone(),
        );
        let id = request.operation_id.clone();
        spawn_engine(move || {
            loop {
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                let Some(book_id) = queue.lock().ok().and_then(|mut queue| queue.pop()) else {
                    break;
                };
                let outcome = crate::online_reader::refresh_toc(&storage, &book_id, cancel.clone());
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                let (new_chapters, error) = match outcome {
                    Ok(added) => (added, None),
                    Err(error) => {
                        crate::app_log::warn(
                            "source",
                            format!("更新目录失败（{book_id}）：{}", error.message),
                        );
                        if let Ok(guard) = storage.lock() {
                            let _ = guard.record_online_update_error(&book_id, &error.message);
                        }
                        (0, Some(error.message))
                    }
                };
                let done = updated.fetch_add(1, Ordering::AcqRel) + 1;
                let _ = app.emit(
                    "online-toc",
                    OnlineTocEvent {
                        operation_id: id.clone(),
                        book_id,
                        updated: done,
                        total,
                        new_chapters,
                        error,
                        done: false,
                    },
                );
            }
            if running.fetch_sub(1, Ordering::AcqRel) == 1 {
                SourceOperations::finish(&cancels, &id);
                let _ = app.emit(
                    "online-toc",
                    OnlineTocEvent {
                        operation_id: id.clone(),
                        book_id: String::new(),
                        updated: updated.load(Ordering::Acquire),
                        total,
                        new_chapters: 0,
                        error: None,
                        done: true,
                    },
                );
            }
        })?;
    }
    Ok(())
}

/// 数据管理: what the app's data folder holds.
#[tauri::command]
pub async fn data_usage(state: State<'_, AppState>) -> Result<crate::models::DataUsage, AppError> {
    with_storage(&state, |storage| storage.data_usage()).await
}

/// 清理所选 in 数据管理.
#[tauri::command]
pub async fn clear_data(
    request: crate::models::ClearDataRequest,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let cleared = with_storage(&state, move |storage| storage.clear_data(&request.parts)).await?;
    for id in cleared {
        crate::online_reader::forget_shown(&id);
    }
    Ok(())
}

/// 转为本地书籍 for an online book whose chapters are all cached; returns
/// the new local book.
#[tauri::command]
pub async fn convert_online_to_local(
    request: BookRequest,
    state: State<'_, AppState>,
) -> Result<LibraryBook, AppError> {
    let storage = state.storage.clone();
    on_engine_thread(move || {
        let (count, cached) = {
            let guard = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            (
                guard.online_chapter_count(&request.book_id)?,
                guard.cached_online_chapters(&request.book_id)?,
            )
        };
        let missing = count as usize - cached.len().min(count as usize);
        if missing > 0 {
            return Err(AppError::invalid_argument(format!(
                "还有 {missing} 章没有缓存"
            )));
        }
        let texts = (0..count)
            .map(|index| crate::online_reader::raw_chapter(&storage, &request.book_id, index))
            .collect::<Result<Vec<_>, _>>()?;
        let mut guard = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        let local = guard.convert_online_to_local(&request.book_id, &texts)?;
        crate::app_log::info("library", format!("网络书籍转为本地书籍：{local}"));
        guard.library_book(&local)
    })
    .await?
}

fn downloads(app: &AppHandle) -> tauri::State<'_, crate::downloads::Downloads> {
    use tauri::Manager;
    app.state::<crate::downloads::Downloads>()
}

/// 下载管理: adds a chapter range of an online book to the queue.
#[tauri::command]
pub async fn download_enqueue(
    request: crate::models::DownloadRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::models::DownloadJob, AppError> {
    let id = request.book_id.clone();
    let title = with_storage(&state, move |storage| Ok(storage.get_book(&id)?.title)).await?;
    let queue = downloads(&app).inner().clone();
    on_engine_thread(move || queue.enqueue(&request.book_id, &title, request.start, request.end))
        .await?
}

#[tauri::command]
pub fn download_list(app: AppHandle) -> Vec<crate::models::DownloadJob> {
    downloads(&app).list()
}

#[tauri::command]
pub fn download_pause(request: crate::models::DownloadJobRequest, app: AppHandle) {
    downloads(&app).pause(&request.id);
}

#[tauri::command]
pub fn download_resume(request: crate::models::DownloadJobRequest, app: AppHandle) {
    downloads(&app).resume(&request.id);
}

#[tauri::command]
pub fn download_cancel(request: crate::models::DownloadJobRequest, app: AppHandle) {
    downloads(&app).cancel(&request.id);
}

/// The notification's 停止.
#[tauri::command]
pub fn download_pause_all(app: AppHandle) {
    downloads(&app).pause_all();
}

#[tauri::command]
pub fn download_clear_finished(app: AppHandle) {
    downloads(&app).clear_finished();
}

/// 网络设置.
#[tauri::command]
pub fn get_network_settings(state: State<'_, AppState>) -> crate::models::NetworkSettings {
    crate::network::load(&state.data_root)
}

/// The device's proxy, checked again when asked.
#[tauri::command]
pub async fn network_state(
    state: State<'_, AppState>,
) -> Result<crate::models::NetworkState, AppError> {
    let root = state.data_root.clone();
    on_engine_thread(move || {
        crate::network::refresh(&root);
        crate::network::state()
    })
    .await
}

#[tauri::command]
pub async fn save_network_settings(
    request: crate::models::NetworkSettings,
    state: State<'_, AppState>,
) -> Result<crate::models::NetworkSettings, AppError> {
    let root = state.data_root.clone();
    on_engine_thread(move || {
        crate::network::save(&root, &request)?;
        Ok(request)
    })
    .await?
}

/// 测试 for DoH or the proxy, with the settings as entered (not yet saved).
#[tauri::command]
pub async fn check_network(
    request: crate::models::NetworkCheckRequest,
) -> Result<crate::models::NetworkCheck, AppError> {
    on_engine_thread(move || crate::network::check(&request.settings, &request.kind)).await?
}
