//! Reading online books chapter by chapter. Each chapter is a reader
//! resource (`chapter-<n>`) whose text is its title line and the content
//! the source gave, kept on the device once fetched. Replace rules and 简繁
//! apply when a chapter is read. Positions are offsets inside one chapter;
//! the reader moves to a neighbouring resource at a chapter's edge.

use std::cell::RefCell;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::rc::Rc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::error::{AppError, ErrorCode};
use crate::models::{
    ContentWindow, OnlineChapter, ReadContentRequest, ReaderLocator, ResolveOffsetRequest,
    SearchMatch, SearchRequest, SearchResponse, TocEntry, TocListing, WindowDirection,
};
use crate::online_commands::{book_data, chapter_data};
use crate::source_commands::{engine_error, load_source, session_for, spawn_engine};
use crate::sources::context::Control;
use crate::sources::web_book::chapter_absolute_url;
use crate::storage::{chapter_resource, chapter_version, resource_chapter, Storage};
use crate::transform;

const CONTEXT_UNITS: usize = 32;
const FETCH_TIMEOUT: Duration = Duration::from_secs(90);
/// Legado's 预下载章节数: chapters fetched ahead of the one being read.
const PRE_DOWNLOAD_AHEAD: u32 = 10;
/// A chapter that failed this many times is skipped by pre-download.
const PRE_DOWNLOAD_FAILURES: u32 = 3;

type Shared = Arc<Mutex<Storage>>;

fn lock(storage: &Shared) -> Result<std::sync::MutexGuard<'_, Storage>, AppError> {
    storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
}

/// A chapter's displayed text with what identifies it.
pub struct ChapterText {
    pub index: u32,
    pub count: u32,
    pub version: String,
    pub units: Vec<u16>,
}

/// Fetches a book's details and contents again from its source (更新目录)
/// and returns how many chapters were added.
pub fn refresh_toc(
    storage: &Shared,
    book_id: &str,
    cancel: Arc<std::sync::atomic::AtomicBool>,
) -> Result<u32, AppError> {
    let record = lock(storage)?.online_record(book_id)?;
    let source = load_source(storage, &record.book.source_url)?;
    let control = Control::new(cancel, Some(Instant::now() + FETCH_TIMEOUT));
    let session = session_for(storage, source, control).map_err(engine_error)?;
    let book = Rc::new(RefCell::new(book_data(&record.book)));
    // Legado refreshes the details first, then the contents they point at.
    session.book_info(&book, false).map_err(engine_error)?;
    let chapters = session.chapters(&book).map_err(engine_error)?;
    let updated = crate::online_commands::online_book(&book.borrow());
    let chapters: Vec<OnlineChapter> = chapters
        .iter()
        .map(crate::online_commands::online_chapter)
        .collect();
    lock(storage)?.replace_online_toc(book_id, &updated, &chapters)
}

/// A book restored from a backup has no contents yet; they are fetched
/// before it is first read.
pub fn ensure_toc(storage: &Shared, book_id: &str) -> Result<(), AppError> {
    if lock(storage)?.online_chapter_count(book_id)? > 0 {
        return Ok(());
    }
    refresh_toc(storage, book_id, Default::default()).map(|_| ())
}

/// The chapter's text as the source gave it, from the device or fetched now.
pub fn raw_chapter(storage: &Shared, book_id: &str, index: u32) -> Result<String, AppError> {
    let (chapter, path) = {
        let guard = lock(storage)?;
        let chapter = guard
            .online_chapter(book_id, index)?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "没有这一章"))?;
        let path = guard.online_chapter_path(book_id, &chapter);
        (chapter, path)
    };
    // A kept chapter needs no more than its file.
    if let Ok(text) = fs::read_to_string(&path) {
        return Ok(text);
    }
    if chapter.is_volume && chapter.url.trim().is_empty() {
        return Ok(String::new());
    }
    let (record, chapters) = {
        let guard = lock(storage)?;
        (
            guard.online_record(book_id)?,
            guard.online_chapters(book_id)?,
        )
    };
    let source = load_source(storage, &record.book.source_url)?;
    let control = Control::new(Default::default(), Some(Instant::now() + FETCH_TIMEOUT));
    let session = session_for(storage, source, control).map_err(engine_error)?;
    let book = Rc::new(RefCell::new(book_data(&record.book)));
    let urls: Vec<String> = chapters
        .iter()
        .map(|item| chapter_absolute_url(&chapter_data(item)))
        .collect();
    let next = chapters
        .iter()
        .skip(index as usize + 1)
        .find(|item| !item.is_volume)
        .map(|item| chapter_absolute_url(&chapter_data(item)));
    let content = session
        .content(&book, &chapter_data(&chapter), next.as_deref(), &urls)
        .map_err(|error| {
            crate::app_log::error(
                "reader",
                format!(
                    "《{}》{} 读取失败（{}）：{}",
                    record.title, chapter.title, record.book.source_name, error.message
                ),
            );
            engine_error(error)
        })?;
    write_cache(&path, &content.text)?;
    crate::storage::mark_chapter_cached(book_id, &chapter);
    Ok(content.text)
}

fn write_cache(path: &Path, text: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("part");
    fs::write(&partial, text)?;
    fs::rename(&partial, path)?;
    Ok(())
}

/// The chapter as the reader shows it: the title line, then the content,
/// with the book's replace rules and 简繁 applied.
/// Chapters as last shown, so reads around a chapter's edges and the
/// neighbours the reader prepares do not read and transform the file again.
type Shown = Mutex<std::collections::VecDeque<(String, Arc<ChapterText>)>>;

fn shown() -> &'static Shown {
    static SHOWN: OnceLock<Shown> = OnceLock::new();
    SHOWN.get_or_init(Default::default)
}
const SHOWN_CHAPTERS: usize = 20;

/// Forgets the shown chapters of a book (after 换源, 更新目录, or clearing
/// its cache).
pub fn forget_shown(book_id: &str) {
    if let Ok(mut list) = shown().lock() {
        let prefix = format!("{book_id}\n");
        list.retain(|(key, _)| !key.starts_with(&prefix));
    }
}

pub fn chapter_text(
    storage: &Shared,
    book_id: &str,
    index: u32,
) -> Result<Arc<ChapterText>, AppError> {
    let (chapter, count, transform) = {
        let guard = lock(storage)?;
        let chapter = guard
            .online_chapter(book_id, index)?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "没有这一章"))?;
        (
            chapter,
            guard.online_chapter_count(book_id)?,
            guard.book_transform(book_id)?,
        )
    };
    let key = format!(
        "{book_id}\n{index}\n{}\n{count}\n{}",
        chapter_version(book_id, &chapter),
        serde_json::to_string(&transform).unwrap_or_default()
    );
    if let Some(found) = shown().lock().ok().and_then(|list| {
        list.iter()
            .find(|(kept, _)| *kept == key)
            .map(|(_, text)| text.clone())
    }) {
        return Ok(found);
    }
    let text = Arc::new(build_chapter_text(
        storage, book_id, index, &chapter, count, &transform,
    )?);
    if let Ok(mut list) = shown().lock() {
        list.retain(|(kept, _)| *kept != key);
        list.push_back((key, text.clone()));
        while list.len() > SHOWN_CHAPTERS {
            list.pop_front();
        }
    }
    Ok(text)
}

fn build_chapter_text(
    storage: &Shared,
    book_id: &str,
    index: u32,
    chapter: &OnlineChapter,
    count: u32,
    transform: &transform::TextTransform,
) -> Result<ChapterText, AppError> {
    let raw = raw_chapter(storage, book_id, index)?;
    let body = raw.trim_matches('\n');
    let joined = if body.is_empty() {
        chapter.title.clone()
    } else {
        format!("{}\n{}", chapter.title, body)
    };
    let text = transform::apply(&joined, transform).0;
    Ok(ChapterText {
        index,
        count,
        version: chapter_version(book_id, chapter),
        units: text.encode_utf16().collect(),
    })
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xdc00..=0xdfff).contains(&unit)
}

/// Moves `offset` back off the second half of a surrogate pair.
fn floor_boundary(units: &[u16], offset: usize) -> usize {
    let offset = offset.min(units.len());
    if offset > 0 && offset < units.len() && is_low_surrogate(units[offset]) {
        offset - 1
    } else {
        offset
    }
}

fn ceil_boundary(units: &[u16], offset: usize) -> usize {
    let offset = offset.min(units.len());
    if offset > 0 && offset < units.len() && is_low_surrogate(units[offset]) {
        offset + 1
    } else {
        offset
    }
}

fn text_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn locator_in(book_id: &str, chapter: &ChapterText, offset: usize) -> ReaderLocator {
    let offset = floor_boundary(&chapter.units, offset);
    let before = ceil_boundary(&chapter.units, offset.saturating_sub(CONTEXT_UNITS));
    let after = floor_boundary(&chapter.units, offset + CONTEXT_UNITS);
    ReaderLocator {
        book_id: book_id.to_string(),
        content_version: chapter.version.clone(),
        resource_id: chapter_resource(chapter.index),
        offset: offset as u64,
        context_before: text_of(&chapter.units[before..offset]),
        context_after: text_of(&chapter.units[offset..after]),
    }
}

fn window_of(book_id: &str, chapter: &ChapterText, start: usize, end: usize) -> ContentWindow {
    let total = chapter.units.len();
    ContentWindow {
        book_id: book_id.to_string(),
        resource_id: chapter_resource(chapter.index),
        content_version: chapter.version.clone(),
        text: text_of(&chapter.units[start..end]),
        start_offset: start as u64,
        end_offset: end as u64,
        total_length: total as u64,
        has_before: start > 0,
        has_after: end < total,
        locator: locator_in(book_id, chapter, start),
        previous_resource_id: (chapter.index > 0).then(|| chapter_resource(chapter.index - 1)),
        next_resource_id: (chapter.index + 1 < chapter.count)
            .then(|| chapter_resource(chapter.index + 1)),
        resource_index: Some(chapter.index),
        resource_count: Some(chapter.count),
    }
}

/// `read_content_window` for an online book.
pub fn read_window(
    storage: &Shared,
    request: &ReadContentRequest,
) -> Result<ContentWindow, AppError> {
    let book_id = &request.book_id;
    let resource = request
        .locator
        .as_ref()
        .map(|locator| locator.resource_id.clone())
        .or_else(|| request.resource_id.clone());
    let index = match resource {
        Some(resource) => resource_chapter(&resource)
            .ok_or_else(|| AppError::invalid_argument("不是网络书籍的章节"))?,
        None => 0,
    };
    ensure_toc(storage, book_id)?;
    let chapter = chapter_text(storage, book_id, index)?;
    if let Some(locator) = &request.locator {
        if locator.content_version != chapter.version {
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "章节已经变化，请从目录重新打开",
            ));
        }
    }
    let total = chapter.units.len();
    let max = (request.max_units.max(1) as usize).min(1_000_000);
    let (start, end) = match request.direction {
        WindowDirection::Forward => {
            let start = floor_boundary(
                &chapter.units,
                request.locator.as_ref().map_or(0, |l| l.offset as usize),
            );
            let mut end = floor_boundary(&chapter.units, start + max);
            if end <= start && start < total {
                end = ceil_boundary(&chapter.units, start + 1);
            }
            (start, end)
        }
        WindowDirection::Backward => {
            let end = ceil_boundary(
                &chapter.units,
                request
                    .locator
                    .as_ref()
                    .map_or(total, |l| l.offset as usize),
            );
            (ceil_boundary(&chapter.units, end.saturating_sub(max)), end)
        }
    };
    let end = end.min(total);
    let start = start.min(end);
    {
        let guard = lock(storage)?;
        guard.clear_online_new_chapters(book_id)?;
    }
    pre_download(storage.clone(), book_id.clone(), index);
    Ok(window_of(book_id, &chapter, start, end))
}

/// `resolve_reader_offset` for an online book.
pub fn resolve_offset(
    storage: &Shared,
    request: &ResolveOffsetRequest,
) -> Result<ReaderLocator, AppError> {
    let index = resource_chapter(&request.resource_id)
        .ok_or_else(|| AppError::invalid_argument("不是网络书籍的章节"))?;
    let chapter = chapter_text(storage, &request.book_id, index)?;
    Ok(locator_in(
        &request.book_id,
        &chapter,
        request.offset as usize,
    ))
}

/// `resolve_reader_locator` for an online book: the chapter at that share
/// of the contents, at its start.
pub fn resolve_progress(
    storage: &Shared,
    book_id: &str,
    progress: f64,
) -> Result<ReaderLocator, AppError> {
    let count = lock(storage)?.online_chapter_count(book_id)?;
    if count == 0 {
        return Err(AppError::new(ErrorCode::NotFound, "目录为空"));
    }
    let index = ((progress.clamp(0.0, 1.0) * count as f64) as u32).min(count - 1);
    let chapter = chapter_text(storage, book_id, index)?;
    Ok(locator_in(book_id, &chapter, 0))
}

/// The contents for the reader: one entry per chapter, at its start.
pub fn toc(storage: &Shared, book_id: &str) -> Result<TocListing, AppError> {
    ensure_toc(storage, book_id)?;
    let guard = lock(storage)?;
    let chapters = guard.online_chapters(book_id)?;
    let cached = guard.cached_online_chapters(book_id)?;
    let entries = chapters
        .iter()
        .map(|chapter| TocEntry {
            ordinal: chapter.index as u64,
            title: chapter.title.clone(),
            volume: chapter.is_volume,
            // Unknown until the chapter is read; cached chapters count 1.
            length: u64::from(cached.contains(&chapter.index)),
            locator: ReaderLocator {
                book_id: book_id.to_string(),
                content_version: chapter_version(book_id, chapter),
                resource_id: chapter_resource(chapter.index),
                offset: 0,
                context_before: String::new(),
                context_after: String::new(),
            },
        })
        .collect();
    Ok(TocListing {
        entries,
        rule_id: None,
        rule_name: String::new(),
        settings: Default::default(),
    })
}

/// In-book search over the chapters kept on the device.
pub fn search(storage: &Shared, request: &SearchRequest) -> Result<SearchResponse, AppError> {
    let (count, cached) = {
        let guard = lock(storage)?;
        (
            guard.online_chapter_count(&request.book_id)?,
            guard.cached_online_chapters(&request.book_id)?,
        )
    };
    let pattern = if request.regex {
        Some(
            fancy_regex::RegexBuilder::new(&request.query)
                .case_insensitive(!request.case_sensitive)
                .build()
                .map_err(|error| AppError::invalid_argument(format!("正则表达式无效：{error}")))?,
        )
    } else {
        None
    };
    let needle = if request.case_sensitive {
        request.query.clone()
    } else {
        request.query.to_lowercase()
    };
    if needle.is_empty() {
        return Err(AppError::invalid_argument("搜索内容不能为空"));
    }
    let limit = request.limit.max(1) as usize;
    let mut matches = Vec::new();
    // The cursor is the chapter to continue from.
    let mut index = request.cursor.unwrap_or(0) as u32;
    while index < count && matches.len() < limit {
        if cached.contains(&index) {
            let chapter = chapter_text(storage, &request.book_id, index)?;
            let text = text_of(&chapter.units);
            for (start, end) in find_all(&text, &needle, pattern.as_ref(), request.case_sensitive) {
                let unit_start = text[..start].encode_utf16().count();
                let unit_end = unit_start + text[start..end].encode_utf16().count();
                let excerpt_start = floor_boundary(&chapter.units, unit_start.saturating_sub(20));
                let excerpt_end = floor_boundary(&chapter.units, unit_end + 40);
                matches.push(SearchMatch {
                    ordinal: matches.len() as u64,
                    locator: locator_in(&request.book_id, &chapter, unit_start),
                    excerpt: text_of(&chapter.units[excerpt_start..excerpt_end]),
                    match_start: unit_start as u64,
                    match_end: unit_end as u64,
                });
            }
        }
        index += 1;
    }
    Ok(SearchResponse {
        content_version: String::new(),
        matches,
        next_cursor: (index < count).then_some(index as u64),
        has_more: index < count,
    })
}

fn find_all(
    text: &str,
    needle: &str,
    pattern: Option<&fancy_regex::Regex>,
    case_sensitive: bool,
) -> Vec<(usize, usize)> {
    if let Some(pattern) = pattern {
        return pattern
            .find_iter(text)
            .flatten()
            .filter(|found| found.end() > found.start())
            .map(|found| (found.start(), found.end()))
            .collect();
    }
    let haystack = if case_sensitive {
        text.to_string()
    } else {
        text.to_lowercase()
    };
    // Lowercasing keeps byte positions for the scripts novels use.
    if haystack.len() != text.len() {
        return Vec::new();
    }
    haystack
        .match_indices(needle)
        .map(|(start, found)| (start, start + found.len()))
        .collect()
}

fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

fn failures() -> &'static Mutex<std::collections::HashMap<(String, u32), u32>> {
    static FAILURES: OnceLock<Mutex<std::collections::HashMap<(String, u32), u32>>> =
        OnceLock::new();
    FAILURES.get_or_init(Default::default)
}

/// The chapter each book was last read at, which its pre-download follows.
fn reading_at() -> &'static Mutex<std::collections::HashMap<String, u32>> {
    static AT: OnceLock<Mutex<std::collections::HashMap<String, u32>>> = OnceLock::new();
    AT.get_or_init(Default::default)
}

/// Chapters behind the one being read that are also kept ready.
const PRE_DOWNLOAD_BEHIND: u32 = 3;

/// The next chapter to fetch around `index`: the one after it first, then
/// the rest ahead, then a few behind; `None` when all are kept or failing.
fn next_wanted(
    index: u32,
    count: u32,
    ahead: u32,
    cached: &HashSet<u32>,
    failing: &dyn Fn(u32) -> bool,
) -> Option<u32> {
    let forward = (index + 1..(index + 1 + ahead).min(count)).collect::<Vec<_>>();
    let backward = (index.saturating_sub(PRE_DOWNLOAD_BEHIND)..index).rev();
    forward
        .into_iter()
        .chain(backward)
        .find(|candidate| !cached.contains(candidate) && !failing(*candidate))
}

/// Fetches the chapters around the one being read in the background, one
/// worker per book that always follows the latest chapter read.
fn pre_download(storage: Shared, book_id: String, index: u32) {
    if let Ok(mut at) = reading_at().lock() {
        at.insert(book_id.clone(), index);
    }
    if !running()
        .lock()
        .map(|mut set| set.insert(book_id.clone()))
        .unwrap_or(false)
    {
        return;
    }
    let started = spawn_engine({
        let book_id = book_id.clone();
        move || {
            while let Some(at) = reading_at()
                .lock()
                .ok()
                .and_then(|map| map.get(&book_id).copied())
            {
                let next = {
                    let Ok(guard) = storage.lock() else {
                        break;
                    };
                    let ahead = guard
                        .get_settings()
                        .ok()
                        .and_then(|settings| settings.pre_download_chapters)
                        .map_or(PRE_DOWNLOAD_AHEAD, u32::from)
                        .min(50);
                    let count = guard.online_chapter_count(&book_id).unwrap_or(0);
                    let cached = guard.cached_online_chapters(&book_id).unwrap_or_default();
                    let failing = |candidate: u32| {
                        failures()
                            .lock()
                            .map(|map| {
                                map.get(&(book_id.clone(), candidate)).copied().unwrap_or(0)
                                    >= PRE_DOWNLOAD_FAILURES
                            })
                            .unwrap_or(true)
                    };
                    next_wanted(at, count, ahead, &cached, &failing)
                };
                let Some(next) = next else {
                    break;
                };
                if raw_chapter(&storage, &book_id, next).is_err() {
                    if let Ok(mut map) = failures().lock() {
                        *map.entry((book_id.clone(), next)).or_default() += 1;
                    }
                }
            }
            if let Ok(mut set) = running().lock() {
                set.remove(&book_id);
            }
        }
    });
    if started.is_err() {
        if let Ok(mut set) = running().lock() {
            set.remove(&book_id);
        }
    }
}

/// Fetches chapters `start..end` that are not kept yet, for 离线缓存.
/// Reports each finished chapter; stops when `stop` says so.
pub fn cache_range(
    storage: &Shared,
    book_id: &str,
    start: u32,
    end: u32,
    stop: &dyn Fn() -> bool,
    report: &dyn Fn(u32, u32, u32),
) -> Result<(), AppError> {
    let (count, cached) = {
        let guard = lock(storage)?;
        (
            guard.online_chapter_count(book_id)?,
            guard.cached_online_chapters(book_id)?,
        )
    };
    let end = end.min(count);
    let wanted: Vec<u32> = (start..end)
        .filter(|index| !cached.contains(index))
        .collect();
    let total = wanted.len() as u32;
    let (mut done, mut failed) = (0, 0);
    for index in wanted {
        if stop() {
            break;
        }
        match raw_chapter(storage, book_id, index) {
            Ok(_) => done += 1,
            Err(_) => failed += 1,
        }
        report(done, failed, total);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::OnlineBook;
    use crate::sources::test_server::{start, Request, Response};

    struct Dir(std::path::PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn site() -> String {
        start(|request: &Request| match request.path.as_str() {
            "/c/1.html" => Response::html(r#"<div id="content">第一段<br>第二段</div>"#),
            "/c/2.html" => Response::html(r#"<div id="content">第三段</div>"#),
            _ => Response::not_found(),
        })
    }

    fn library(base: &str) -> (Dir, Shared, String) {
        let dir =
            Dir(std::env::temp_dir().join(format!("gripread-online-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let mut storage = Storage::open(&dir.0).unwrap();
        storage
            .save_book_source(
                &serde_json::json!({
                    "bookSourceUrl": base,
                    "bookSourceName": "甲站",
                    "ruleContent": {"content": "id.content@html"}
                })
                .to_string(),
                None,
            )
            .unwrap();
        let book = OnlineBook {
            source_url: base.to_string(),
            source_name: "甲站".into(),
            name: "剑来".into(),
            author: "烽火".into(),
            kind: String::new(),
            cover_url: String::new(),
            intro: "简介".into(),
            word_count: String::new(),
            latest_chapter_title: "第二章".into(),
            book_url: format!("{base}/book/7/"),
            toc_url: format!("{base}/book/7/"),
            variables: String::new(),
            reverse_toc: false,
        };
        let chapter = |index: u32, title: &str, url: &str, volume: bool| OnlineChapter {
            index,
            title: title.into(),
            url: url.into(),
            base_url: format!("{base}/book/7/"),
            is_volume: volume,
            is_vip: false,
            is_pay: false,
            tag: String::new(),
            variables: String::new(),
        };
        let chapters = vec![
            chapter(0, "第一卷", "", true),
            chapter(1, "第一章 惊蛰", "/c/1.html", false),
            chapter(2, "第二章 开门", "/c/2.html", false),
        ];
        let id = storage.add_online_book(&book, &chapters, false).unwrap();
        (dir, Arc::new(Mutex::new(storage)), id)
    }

    fn request(
        book_id: &str,
        locator: Option<ReaderLocator>,
        resource: Option<&str>,
        direction: WindowDirection,
    ) -> ReadContentRequest {
        ReadContentRequest {
            book_id: book_id.to_string(),
            locator,
            max_units: 4,
            direction,
            resource_id: resource.map(str::to_string),
        }
    }

    #[test]
    fn pre_download_fetches_the_next_chapter_first_then_ahead_then_behind() {
        let none = |_: u32| false;
        let cached: HashSet<u32> = [6].into_iter().collect();
        assert_eq!(next_wanted(5, 100, 10, &HashSet::new(), &none), Some(6));
        assert_eq!(next_wanted(5, 100, 10, &cached, &none), Some(7));
        let ahead: HashSet<u32> = (6..16).collect();
        assert_eq!(next_wanted(5, 100, 10, &ahead, &none), Some(4));
        let all: HashSet<u32> = (2..16).collect();
        assert_eq!(next_wanted(5, 100, 10, &all, &none), None);
        assert_eq!(
            next_wanted(5, 100, 10, &HashSet::new(), &|c| c == 6),
            Some(7)
        );
    }

    #[test]
    fn chapters_read_as_resources_and_stay_on_the_device() {
        let base = site();
        let (_dir, storage, id) = library(&base);
        // A shelf listing leaves out a book only being read.
        assert!(storage
            .lock()
            .unwrap()
            .list_library_books()
            .unwrap()
            .is_empty());
        assert!(storage
            .lock()
            .unwrap()
            .library_book(&id)
            .unwrap()
            .online
            .is_some());

        let volume = read_window(
            &storage,
            &request(&id, None, None, WindowDirection::Forward),
        )
        .unwrap();
        assert_eq!(volume.text, "第一卷");
        assert_eq!(volume.previous_resource_id, None);
        assert_eq!(volume.next_resource_id.as_deref(), Some("chapter-1"));

        let first = read_window(
            &storage,
            &request(&id, None, Some("chapter-1"), WindowDirection::Forward),
        )
        .unwrap();
        assert_eq!(first.text, "第一章 ");
        assert!(first.has_after);
        assert_eq!(first.resource_index, Some(1));
        let rest = read_window(
            &storage,
            &request(
                &id,
                Some(ReaderLocator {
                    offset: 4,
                    ..first.locator.clone()
                }),
                None,
                WindowDirection::Forward,
            ),
        )
        .unwrap();
        assert_eq!(rest.text, "惊蛰\n第");
        // Backward from the resource's end reads its last units.
        let end = read_window(
            &storage,
            &request(&id, None, Some("chapter-1"), WindowDirection::Backward),
        )
        .unwrap();
        assert_eq!(end.text, "\n第二段");
        assert_eq!(end.end_offset, end.total_length);

        let cached = storage.lock().unwrap().cached_online_chapters(&id).unwrap();
        assert!(cached.contains(&1));
        // A stale position names an older version of the chapter.
        let stale = ReaderLocator {
            content_version: "old".into(),
            ..first.locator.clone()
        };
        let error = read_window(
            &storage,
            &request(&id, Some(stale), None, WindowDirection::Forward),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ContentVersionMismatch);

        let toc = toc(&storage, &id).unwrap();
        assert_eq!(toc.entries.len(), 3);
        assert_eq!(toc.entries[2].locator.resource_id, "chapter-2");
        let middle = resolve_progress(&storage, &id, 0.7).unwrap();
        assert_eq!(middle.resource_id, "chapter-2");

        let found = search(
            &storage,
            &SearchRequest {
                book_id: id.clone(),
                query: "二段".into(),
                case_sensitive: false,
                regex: false,
                cursor: None,
                limit: 10,
                operation_id: None,
            },
        )
        .unwrap();
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].locator.resource_id, "chapter-1");
        // Every kept chapter is searched, not only the one being read.
        read_window(
            &storage,
            &request(&id, None, Some("chapter-2"), WindowDirection::Forward),
        )
        .unwrap();
        let across = search(
            &storage,
            &SearchRequest {
                book_id: id.clone(),
                query: "段".into(),
                case_sensitive: false,
                regex: false,
                cursor: None,
                limit: 10,
                operation_id: None,
            },
        )
        .unwrap();
        let resources: Vec<&str> = across
            .matches
            .iter()
            .map(|found| found.locator.resource_id.as_str())
            .collect();
        assert_eq!(resources, ["chapter-1", "chapter-1", "chapter-2"]);

        assert!(storage
            .lock()
            .unwrap()
            .drop_unshelved_online_book(&id)
            .unwrap());
        assert!(!storage.lock().unwrap().online_cache_dir(&id).exists());
    }

    /// Reads two chapters of a live book from `GRIPREAD_SOURCES` /
    /// `GRIPREAD_SOURCE_NAME` through the shelf path, then updates its
    /// contents. A tool for checking the whole online path by hand.
    #[test]
    #[ignore]
    fn live_online_reading() {
        let path = std::env::var("GRIPREAD_SOURCES").expect("GRIPREAD_SOURCES");
        let name = std::env::var("GRIPREAD_SOURCE_NAME").expect("GRIPREAD_SOURCE_NAME");
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let text = std::fs::read_to_string(path).unwrap();
                let raw = crate::sources::model::parse_sources(&text)
                    .unwrap()
                    .into_iter()
                    .find(|value| value["bookSourceName"] == name.as_str())
                    .unwrap();
                let dir =
                    Dir(std::env::temp_dir()
                        .join(format!("gripread-live-{}", uuid::Uuid::new_v4())));
                std::fs::create_dir_all(&dir.0).unwrap();
                let mut storage = Storage::open(&dir.0).unwrap();
                storage.save_book_source(&raw.to_string(), None).unwrap();
                let storage: Shared = Arc::new(Mutex::new(storage));
                let source = load_source(&storage, raw["bookSourceUrl"].as_str().unwrap()).unwrap();
                let key = source
                    .rule("ruleSearch", "checkKeyWord")
                    .unwrap_or_else(|| "我的".into());
                let session = session_for(&storage, source, Control::unlimited()).unwrap();
                let found = session.search(&key, 1).unwrap();
                let book = Rc::new(RefCell::new(found[0].clone()));
                session.book_info(&book, false).unwrap();
                let chapters: Vec<OnlineChapter> = session
                    .chapters(&book)
                    .unwrap()
                    .iter()
                    .map(crate::online_commands::online_chapter)
                    .collect();
                let online = crate::online_commands::online_book(&book.borrow());
                let id = storage
                    .lock()
                    .unwrap()
                    .add_online_book(&online, &chapters, true)
                    .unwrap();
                eprintln!("《{}》{} 章", online.name, chapters.len());
                let first = read_window(
                    &storage,
                    &ReadContentRequest {
                        book_id: id.clone(),
                        locator: None,
                        max_units: 200,
                        direction: WindowDirection::Forward,
                        resource_id: None,
                    },
                )
                .unwrap();
                eprintln!(
                    "{}: {}",
                    first.resource_id,
                    first.text.chars().take(60).collect::<String>()
                );
                let next = first.next_resource_id.clone().unwrap();
                let second = read_window(
                    &storage,
                    &ReadContentRequest {
                        book_id: id.clone(),
                        locator: None,
                        max_units: 200,
                        direction: WindowDirection::Forward,
                        resource_id: Some(next),
                    },
                )
                .unwrap();
                eprintln!(
                    "{}: {}",
                    second.resource_id,
                    second.text.chars().take(60).collect::<String>()
                );
                let added = refresh_toc(&storage, &id, Default::default()).unwrap();
                eprintln!("更新目录：新增 {added} 章");
                std::thread::sleep(Duration::from_secs(8));
                let cached = storage.lock().unwrap().cached_online_chapters(&id).unwrap();
                eprintln!("已缓存 {} 章", cached.len());
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
