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
    AddOnlineBookRequest, BookRequest, CacheOnlineChaptersRequest, ExploreBooksRequest,
    ExploreKindsRequest, LibraryBook, OnlineBook, OnlineBookRequest, OnlineCacheEvent,
    OnlineChapter, OnlineContent, OnlineContentRequest, OnlineCoverRequest, OnlineSearchEvent,
    OnlineSearchResult, OnlineTocEvent, SearchOnlineRequest, SetOnlineBookFlagRequest,
    SourceFailure, UpdateOnlineTocRequest,
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

const SEARCH_WORKERS: usize = 8;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const STEP_TIMEOUT: Duration = Duration::from_secs(90);
const PAGE_CACHE_LIMIT: usize = 64;
const UPDATE_WORKERS: usize = 4;

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
    let workers = SEARCH_WORKERS.min(total.max(1) as usize);
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
    run_step(&state, request.source_url, move |session| {
        let books = session.explore(&request.url, request.page.max(1) as i64)?;
        for book in &books {
            pages.remember(&source_url, book);
        }
        Ok(books.iter().map(online_book).collect())
    })
    .await
}

#[tauri::command]
pub async fn online_book_info(
    request: OnlineBookRequest,
    state: State<'_, AppState>,
    pages: State<'_, Arc<OnlinePages>>,
) -> Result<OnlineBook, AppError> {
    let pages = pages.inner().clone();
    let source_url = request.book.source_url.clone();
    run_step(&state, source_url.clone(), move |session| {
        let mut data = book_data(&request.book);
        pages.restore(&source_url, &mut data);
        let book = Rc::new(RefCell::new(data));
        session.book_info(&book, false)?;
        let data = book.borrow().clone();
        pages.remember(&source_url, &data);
        Ok(online_book(&data))
    })
    .await
}

#[tauri::command]
pub async fn online_book_chapters(
    request: OnlineBookRequest,
    state: State<'_, AppState>,
    pages: State<'_, Arc<OnlinePages>>,
) -> Result<Vec<OnlineChapter>, AppError> {
    let pages = pages.inner().clone();
    let source_url = request.book.source_url.clone();
    run_step(&state, source_url.clone(), move |session| {
        let mut data = book_data(&request.book);
        pages.restore(&source_url, &mut data);
        let book = Rc::new(RefCell::new(data));
        if book.borrow().toc_url.is_empty() {
            session.book_info(&book, false)?;
        }
        let chapters = session.chapters(&book)?;
        Ok(chapters.iter().map(online_chapter).collect())
    })
    .await
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

/// A cover image fetched with the source's headers and cookies.
#[tauri::command]
pub async fn online_cover(
    request: OnlineCoverRequest,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, AppError> {
    let bytes = run_step(&state, request.source_url, move |session| {
        session.run_with_rule(|scope, rule| {
            let url = AnalyzeUrl::new(
                rule,
                scope,
                &request.url,
                None,
                None,
                &session.env().source.url(),
                None,
            )?;
            let response = url.get_str_response(session.env())?;
            if !response.is_success() || response.bytes.is_empty() {
                return Err(SourceError::network(format!(
                    "封面下载失败（{}）",
                    response.code
                )));
            }
            Ok(response.bytes)
        })
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

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

/// Legado's 离线缓存: fetches a range of chapters in the background,
/// streaming `online-cache` as each one finishes.
#[tauri::command]
pub async fn cache_online_chapters(
    request: CacheOnlineChaptersRequest,
    app: AppHandle,
    state: State<'_, AppState>,
    operations: State<'_, SourceOperations>,
) -> Result<(), AppError> {
    let storage = state.storage.clone();
    let cancel = operations.register(&request.operation_id);
    let cancels = operations.cancels();
    spawn_engine(move || {
        let event = |cached, failed, total, done| OnlineCacheEvent {
            operation_id: request.operation_id.clone(),
            book_id: request.book_id.clone(),
            cached,
            failed,
            total,
            done,
        };
        let last = std::cell::Cell::new((0, 0, 0));
        let _ = crate::online_reader::cache_range(
            &storage,
            &request.book_id,
            request.start,
            request.end,
            &|| cancel.load(Ordering::Acquire),
            &|cached, failed, total| {
                last.set((cached, failed, total));
                let _ = app.emit("online-cache", event(cached, failed, total, false));
            },
        );
        SourceOperations::finish(&cancels, &request.operation_id);
        let (cached, failed, total) = last.get();
        let _ = app.emit("online-cache", event(cached, failed, total, true));
    })
}
