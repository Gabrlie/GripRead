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

pub type Shared = Arc<Mutex<Storage>>;

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
            .ok_or_else(|| AppError::keyed(ErrorCode::NotFound, "chapterMissing", "没有这一章"))?;
        let path = guard.online_chapter_path(book_id, &chapter);
        (chapter, path)
    };
    // A kept chapter needs no more than its file. A web page kept in its
    // place (an older server answered the relay with its page) is dropped.
    if let Ok(text) = fs::read_to_string(&path) {
        if !is_web_page(&text) {
            return Ok(text);
        }
        let _ = fs::remove_file(&path);
        crate::storage::forget_cached_chapters(book_id);
    }
    if chapter.is_volume && chapter.url.trim().is_empty() {
        return Ok(String::new());
    }
    let (record, chapters, relay) = {
        let guard = lock(storage)?;
        let relay = match guard.chapter_relay() {
            Some(relay) => Some((relay, guard.online_sync_key(book_id)?)),
            None => None,
        };
        (
            guard.online_record(book_id)?,
            guard.online_chapters(book_id)?,
            relay,
        )
    };
    // A connected server may have it already, or reach the source when
    // this device cannot.
    if let Some((relay, key)) = relay {
        if let Some(text) = (relay.0)(&key, &chapter).filter(|text| !is_web_page(text)) {
            write_cache(&path, &text)?;
            crate::storage::mark_chapter_cached(book_id, &chapter);
            return Ok(text);
        }
    }
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
            crate::log_keyed!(
                Error,
                "reader",
                "chapterFailed",
                format!(
                    "《{}》{} 读取失败（{}）：{}",
                    record.title, chapter.title, record.book.source_name, error.message
                ),
                @error engine_error(error.clone()),
                title = record.title,
                chapter = chapter.title,
                source = record.book.source_name,
            );
            engine_error(error)
        })?;
    write_cache(&path, &content.text)?;
    crate::storage::mark_chapter_cached(book_id, &chapter);
    Ok(content.text)
}

/// A chapter's pictures as the reader's image marks (`U+E000 + n`, as an
/// EPUB's), each fetched through the source once and kept with the book's
/// cached chapters. A picture that cannot be fetched is left out.
pub fn with_image_marks(storage: &Shared, book_id: &str, text: &str) -> String {
    use crate::sources::web_book::image_of_line;
    if !text.lines().any(|line| image_of_line(line).is_some()) {
        return text.to_string();
    }
    let source_url = lock(storage)
        .and_then(|guard| guard.online_record(book_id))
        .map(|record| record.book.source_url)
        .unwrap_or_default();
    let mark = |url: &str| -> Option<char> {
        let known = lock(storage).ok()?.online_image_index(book_id, url).ok()?;
        let index = match known {
            Some(index) => index,
            None => {
                let bytes =
                    crate::online_commands::content_image_bytes(storage, &source_url, url).ok()?;
                let size = imagesize::blob_size(&bytes).ok()?;
                lock(storage)
                    .ok()?
                    .keep_online_image(book_id, url, &bytes, size.width as u32, size.height as u32)
                    .ok()?
            }
        };
        (index < IMAGE_LIMIT)
            .then(|| char::from_u32(crate::epub::IMAGE_BASE + index))
            .flatten()
    };
    text.split('\n')
        .filter_map(|line| match image_of_line(line) {
            Some(url) => mark(url).map(String::from),
            None => Some(line.to_string()),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Image marks run up to the directory marks (`src/reader/images.ts`).
const IMAGE_LIMIT: u32 = 0x1900;

/// A chapter's text without its pictures, for a TXT made from the book.
pub fn without_images(text: &str) -> String {
    text.split('\n')
        .filter(|line| crate::sources::web_book::image_of_line(line).is_none())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Text that is an HTML page rather than a chapter.
pub(crate) fn is_web_page(text: &str) -> bool {
    let start: String = text.trim_start().chars().take(15).collect();
    let start = start.to_ascii_lowercase();
    start.starts_with("<!doctype html") || start.starts_with("<html")
}

fn write_cache(path: &Path, text: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // The reader and the background download can fetch the same chapter at
    // once; each writes its own partial file and the last rename wins.
    let partial = path.with_extension(format!("part-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&partial, text)?;
    if let Err(error) = fs::rename(&partial, path) {
        let _ = fs::remove_file(&partial);
        return Err(error.into());
    }
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
    let (chapter, count, transform, titles, translation) = {
        let guard = lock(storage)?;
        let chapter = guard
            .online_chapter(book_id, index)?
            .ok_or_else(|| AppError::keyed(ErrorCode::NotFound, "chapterMissing", "没有这一章"))?;
        (
            chapter,
            guard.online_chapter_count(book_id)?,
            guard.book_transform(book_id)?,
            guard.title_transform(book_id)?,
            chapter_translation(&guard, book_id)?,
        )
    };
    let key = format!(
        "{book_id}\n{index}\n{}\n{count}\n{}\n{}\n{}",
        chapter_version(book_id, &chapter),
        serde_json::to_string(&transform).unwrap_or_default(),
        serde_json::to_string(&titles).unwrap_or_default(),
        translation
            .as_ref()
            .map(ChapterTranslation::spec)
            .unwrap_or_default()
    );
    if let Some(found) = shown().lock().ok().and_then(|list| {
        list.iter()
            .find(|(kept, _)| *kept == key)
            .map(|(_, text)| text.clone())
    }) {
        return Ok(found);
    }
    let (text, complete) = build_chapter_text(
        storage,
        book_id,
        index,
        &chapter,
        count,
        Transforms {
            text: &transform,
            titles: &titles,
        },
        translation.as_ref(),
    )?;
    let text = Arc::new(text);
    // A chapter whose translation failed is built again next time.
    if !complete {
        return Ok(text);
    }
    if let Ok(mut list) = shown().lock() {
        list.retain(|(kept, _)| *kept != key);
        list.push_back((key, text.clone()));
        while list.len() > SHOWN_CHAPTERS {
            list.pop_front();
        }
    }
    Ok(text)
}

/// How an online book is translated as it is read: the engine, its
/// target, and the display; `None` when it is read as written.
pub struct ChapterTranslation {
    pub engine: crate::models::TranslationEngine,
    pub source: Option<String>,
    pub target: String,
    pub display: crate::models::TranslationDisplay,
    pub root: std::path::PathBuf,
}

impl ChapterTranslation {
    fn spec(&self) -> String {
        crate::translation::spec(&self.engine, &self.target, self.display)
    }
}

/// The book's translation when it is on and an engine is set up.
pub fn chapter_translation(
    storage: &Storage,
    book_id: &str,
) -> Result<Option<ChapterTranslation>, AppError> {
    let (language, target) = storage.book_translation(book_id)?;
    let Some(target) = target else {
        return Ok(None);
    };
    let root = storage.root_path().to_path_buf();
    let settings = crate::translation::load_settings(&root);
    Ok(
        crate::translation::default_engine(&settings).map(|engine| ChapterTranslation {
            engine: engine.clone(),
            source: language,
            target,
            display: settings.display,
            root,
        }),
    )
}

thread_local! {
    /// Set while chapters are translated ahead of the reader, so their
    /// progress does not show as the chapter being opened.
    static AHEAD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// What a chapter's text and its title line go through.
struct Transforms<'a> {
    /// 作用于正文 rules and 简繁转换.
    text: &'a transform::TextTransform,
    /// 作用于标题 rules and 简繁转换.
    titles: &'a transform::TextTransform,
}

fn build_chapter_text(
    storage: &Shared,
    book_id: &str,
    index: u32,
    chapter: &OnlineChapter,
    count: u32,
    transforms: Transforms<'_>,
    translation: Option<&ChapterTranslation>,
) -> Result<(ChapterText, bool), AppError> {
    let raw = with_image_marks(storage, book_id, &raw_chapter(storage, book_id, index)?);
    let body = raw.trim_matches('\n');
    // The title line takes the 作用于标题 rules, the text the 作用于正文 ones.
    let title = transforms.titles.title(&chapter.title);
    let mut text = if body.is_empty() {
        title
    } else {
        format!("{title}\n{}", transform::apply(body, transforms.text).0)
    };
    let mut complete = true;
    // A translated book reads the translation; when the engine fails, the
    // chapter shows as written and says so in the log.
    if let Some(translation) = translation {
        let lines: Vec<&str> = text.split('\n').collect();
        let ahead = AHEAD.with(|ahead| ahead.get());
        let report = |done: usize, total: usize| {
            crate::translation::report_chapter(&crate::models::ChapterTranslationEvent {
                book_id: book_id.to_string(),
                index,
                done: done as u32,
                total: total as u32,
                ahead,
            })
        };
        match crate::translation::translate_lines_reporting(
            storage,
            &translation.root,
            &translation.engine,
            translation.source.as_deref(),
            &translation.target,
            &lines,
            &report,
        ) {
            Ok(translated) => {
                text = crate::translation::compose(&lines, &translated, translation.display)
            }
            Err(failure) => {
                complete = false;
                crate::log_keyed!(
                    Warn,
                    "translation",
                    "chapterUntranslated",
                    format!("《{}》翻译失败：{}", chapter.title, failure.message),
                    @error failure,
                    chapter = chapter.title,
                )
            }
        }
    }
    Ok((
        ChapterText {
            index,
            count,
            version: chapter_version(book_id, chapter),
            units: text.encode_utf16().collect(),
        },
        complete,
    ))
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
        Some(resource) => resource_chapter(&resource).ok_or_else(|| {
            AppError::keyed(
                ErrorCode::InvalidArgument,
                "notOnlineChapter",
                "不是网络书籍的章节",
            )
        })?,
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
    // A window holds the rest of its chapter (from the place asked for, or
    // up to it), never a part: a page cut where a window ended mid-chapter
    // would end short with the chapter going on (bilingual chapters run
    // past the reader's usual window size). The chapter is in memory anyway.
    let (start, end) = match request.direction {
        WindowDirection::Forward => (
            floor_boundary(
                &chapter.units,
                request.locator.as_ref().map_or(0, |l| l.offset as usize),
            ),
            total,
        ),
        WindowDirection::Backward => (
            0,
            ceil_boundary(
                &chapter.units,
                request
                    .locator
                    .as_ref()
                    .map_or(total, |l| l.offset as usize),
            ),
        ),
    };
    let end = end.min(total);
    let start = start.min(end);
    {
        let guard = lock(storage)?;
        guard.clear_online_new_chapters(book_id)?;
    }
    pre_download(storage.clone(), book_id.clone(), index);
    translate_ahead(storage.clone(), book_id.clone(), index);
    Ok(window_of(book_id, &chapter, start, end))
}

/// `resolve_reader_offset` for an online book.
pub fn resolve_offset(
    storage: &Shared,
    request: &ResolveOffsetRequest,
) -> Result<ReaderLocator, AppError> {
    let index = resource_chapter(&request.resource_id).ok_or_else(|| {
        AppError::keyed(
            ErrorCode::InvalidArgument,
            "notOnlineChapter",
            "不是网络书籍的章节",
        )
    })?;
    if request.offset == 0 {
        // A chapter's start needs no text: the reader opens at once and
        // fetches the chapter itself, showing its progress (and failure).
        let guard = lock(storage)?;
        if let Some(chapter) = guard
            .online_chapters(&request.book_id)?
            .iter()
            .find(|chapter| chapter.index == index)
        {
            return Ok(ReaderLocator {
                book_id: request.book_id.clone(),
                content_version: chapter_version(&request.book_id, chapter),
                resource_id: chapter_resource(index),
                offset: 0,
                context_before: String::new(),
                context_after: String::new(),
            });
        }
    }
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
        return Err(AppError::keyed(ErrorCode::NotFound, "tocEmpty", "目录为空"));
    }
    let index = ((progress.clamp(0.0, 1.0) * count as f64) as u32).min(count - 1);
    let chapter = chapter_text(storage, book_id, index)?;
    Ok(locator_in(book_id, &chapter, 0))
}

/// The contents for the reader: one entry per chapter, at its start, and
/// with 章内分章 on, the headings found inside kept chapters at theirs.
pub fn toc(storage: &Shared, book_id: &str) -> Result<TocListing, AppError> {
    ensure_toc(storage, book_id)?;
    let guard = lock(storage)?;
    let chapters = guard.online_chapters(book_id)?;
    let cached = guard.cached_online_chapters(book_id)?;
    let titles = guard.title_transform(book_id)?;
    let (settings, _) = guard.book_toc_settings(book_id)?;
    // Offsets into a translated chapter are not those of its text.
    let inner = if settings.inner_chapters && chapter_translation(&guard, book_id)?.is_none() {
        let rules = inner_rules(&guard, &settings)?;
        let transform = guard.book_transform(book_id)?;
        let sample = inner_sample(&guard, book_id, &transform)?;
        inner_rule(&sample, &rules, settings.rule_id.is_some())
            .map(|(rule, regex, _)| (rule.id.clone(), rule.name.clone(), regex, transform))
    } else {
        None
    };
    let mut entries = Vec::with_capacity(chapters.len());
    for chapter in &chapters {
        let title = titles.title(&chapter.title);
        let locator = |offset: u64| ReaderLocator {
            book_id: book_id.to_string(),
            content_version: chapter_version(book_id, chapter),
            resource_id: chapter_resource(chapter.index),
            offset,
            context_before: String::new(),
            context_after: String::new(),
        };
        let kept = cached.contains(&chapter.index);
        entries.push(TocEntry {
            ordinal: entries.len() as u64,
            title: title.clone(),
            volume: chapter.is_volume,
            // Unknown until the chapter is read; cached chapters count 1.
            length: u64::from(kept),
            locator: locator(0),
            tag: Some(chapter.tag.trim().to_string()).filter(|tag| !tag.is_empty()),
        });
        let Some((_, _, regex, transform)) = inner.as_ref().filter(|_| kept && !chapter.is_volume)
        else {
            continue;
        };
        let Ok(raw) = fs::read_to_string(guard.online_chapter_path(book_id, chapter)) else {
            continue;
        };
        for (offset, heading) in inner_headings(&title, &inner_body(&raw, transform), regex) {
            entries.push(TocEntry {
                ordinal: entries.len() as u64,
                title: titles.title(&heading),
                volume: false,
                length: 1,
                locator: locator(offset),
                tag: None,
            });
        }
    }
    let (rule_id, rule_name) = inner
        .map(|(id, name, _, _)| (Some(id), name))
        .unwrap_or_default();
    Ok(TocListing {
        entries,
        rule_id,
        rule_name,
        settings,
    })
}

/// The rules 章内分章 looks for headings with: the book's chosen rule, or
/// the enabled rules that are not loose enough to match prose.
fn inner_rules(
    storage: &Storage,
    settings: &crate::models::BookTocSettings,
) -> Result<Vec<crate::txt_toc::RuleSpec>, AppError> {
    Ok(storage
        .list_txt_toc_rules()?
        .into_iter()
        .filter(|rule| !rule.pattern.is_empty())
        .filter(|rule| match &settings.rule_id {
            Some(id) => &rule.id == id,
            None => rule.enabled && !crate::txt_toc::is_loose_rule(&rule.id),
        })
        .map(|rule| crate::txt_toc::RuleSpec {
            id: rule.id,
            name: rule.name,
            pattern: rule.pattern,
        })
        .collect())
}

/// A kept chapter's body as the reader shows it below the title line (the
/// transformed text; a picture is one mark).
fn inner_body(raw: &str, transform: &transform::TextTransform) -> String {
    let body: String = raw
        .trim_matches('\n')
        .split('\n')
        .map(|line| {
            if crate::sources::web_book::image_of_line(line).is_some() {
                "\u{E000}"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    transform::apply(&body, transform).0
}

/// Headings inside one kept chapter, at their UTF-16 offsets in the text
/// the reader shows (the title line, then the body). Fewer than two, or
/// numbers that do not count up, are no chapter split.
fn inner_headings(title: &str, body: &str, regex: &fancy_regex::Regex) -> Vec<(u64, String)> {
    let found = crate::txt_toc::heading_lines(body, regex, title);
    let titles: Vec<&str> = found.iter().map(|(_, line)| line.as_str()).collect();
    if found.len() < 2 || !crate::txt_toc::numbered_in_order(&titles) {
        return Vec::new();
    }
    // The title line and its newline come first in the shown text.
    let lead = title.encode_utf16().count() as u64 + 1;
    found
        .into_iter()
        .map(|(start, line)| (lead + body[..start].encode_utf16().count() as u64, line))
        .collect()
}

/// The rule 章内分章 uses for a book, with the headings it finds in the
/// sampled chapters. A rule the reader chose is used as it is; otherwise
/// the best scoring rule must find headings in two chapters, or three in
/// one, so a stray line in one chapter does not split a book.
fn inner_rule<'a>(
    chapters: &[(String, String)],
    rules: &'a [crate::txt_toc::RuleSpec],
    chosen: bool,
) -> Option<(
    &'a crate::txt_toc::RuleSpec,
    fancy_regex::Regex,
    Vec<String>,
)> {
    let mut best: Option<(&crate::txt_toc::RuleSpec, fancy_regex::Regex, Vec<String>)> = None;
    for rule in rules {
        let Ok(regex) = crate::txt_toc::compile_rule(&rule.pattern) else {
            continue;
        };
        if chosen {
            return Some((rule, regex, Vec::new()));
        }
        let mut titles = Vec::new();
        let (mut hit, mut strong) = (0, false);
        for (title, body) in chapters {
            let found = inner_headings(title, body, &regex);
            if found.is_empty() {
                continue;
            }
            hit += 1;
            strong |= found.len() >= 3;
            titles.extend(found.into_iter().map(|(_, line)| line));
        }
        if (hit >= 2 || strong)
            && best
                .as_ref()
                .is_none_or(|(_, _, best)| titles.len() > best.len())
        {
            best = Some((rule, regex, titles));
        }
    }
    best
}

/// The first kept chapters of an online book, as (shown title, body).
fn inner_sample(
    storage: &Storage,
    book_id: &str,
    transform: &transform::TextTransform,
) -> Result<Vec<(String, String)>, AppError> {
    let titles = storage.title_transform(book_id)?;
    let cached = storage.cached_online_chapters(book_id)?;
    let mut sample = Vec::new();
    for chapter in storage.online_chapters(book_id)?.iter() {
        if sample.len() >= 20 {
            break;
        }
        if chapter.is_volume || !cached.contains(&chapter.index) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(storage.online_chapter_path(book_id, chapter)) else {
            continue;
        };
        sample.push((titles.title(&chapter.title), inner_body(&raw, transform)));
    }
    Ok(sample)
}

/// The 章内分章 question for an online book: the first kept chapters hold
/// chapters of their own by a rule that is not loose.
pub fn toc_suggestion(
    storage: &Shared,
    book_id: &str,
) -> Result<Option<crate::models::TocSuggestion>, AppError> {
    let guard = lock(storage)?;
    let (settings, _) = guard.book_toc_settings(book_id)?;
    if settings.asked || settings.inner_chapters {
        return Ok(None);
    }
    let rules = inner_rules(&guard, &crate::models::BookTocSettings::default())?;
    let transform = guard.book_transform(book_id)?;
    let sample = inner_sample(&guard, book_id, &transform)?;
    Ok(
        inner_rule(&sample, &rules, false).map(|(rule, _, titles)| crate::models::TocSuggestion {
            kind: "inner".into(),
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
            count: titles.len() as u32,
            titles: titles.into_iter().take(8).collect(),
        }),
    )
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
                .map_err(|error| {
                    AppError::keyed(
                        ErrorCode::InvalidArgument,
                        "badRegex",
                        format!("正则表达式无效：{error}"),
                    )
                    .with("error", &error)
                })?,
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
        return Err(AppError::keyed(
            ErrorCode::InvalidArgument,
            "searchEmpty",
            "搜索内容不能为空",
        ));
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

/// A translated book translates the chapters after `index` in the
/// background (翻译设置's 提前翻译), so turning to them does not wait.
fn translate_ahead(storage: Shared, book_id: String, index: u32) {
    let ahead = {
        let Ok(guard) = storage.lock() else {
            return;
        };
        match chapter_translation(&guard, &book_id) {
            Ok(Some(_)) => crate::translation::load_settings(guard.root_path())
                .ahead
                .min(10),
            _ => return,
        }
    };
    let key = format!("translate\n{book_id}");
    if ahead == 0
        || !running()
            .lock()
            .map(|mut set| set.insert(key.clone()))
            .unwrap_or(false)
    {
        return;
    }
    let started = spawn_engine({
        let key = key.clone();
        move || {
            let count = storage
                .lock()
                .map(|guard| guard.online_chapter_count(&book_id).unwrap_or(0))
                .unwrap_or(0);
            AHEAD.with(|flag| flag.set(true));
            for next in index + 1..(index + 1 + ahead).min(count) {
                if chapter_text(&storage, &book_id, next).is_err() {
                    break;
                }
            }
            AHEAD.with(|flag| flag.set(false));
            if let Ok(mut set) = running().lock() {
                set.remove(&key);
            }
        }
    });
    if started.is_err() {
        if let Ok(mut set) = running().lock() {
            set.remove(&key);
        }
    }
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
    fn a_connected_server_gives_chapters_before_the_source() {
        // The site has no chapters: only the server can give them.
        let base = start(|_: &Request| Response::not_found());
        let (_dir, storage, id) = library(&base);
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        storage
            .lock()
            .unwrap()
            .set_chapter_relay(crate::storage::ChapterRelay(Arc::new(
                move |key: &str, chapter: &OnlineChapter| {
                    seen.lock()
                        .unwrap()
                        .push((key.to_string(), chapter.url.clone()));
                    (chapter.url == "/c/1.html").then(|| "来自服务器".to_string())
                },
            )));
        assert_eq!(raw_chapter(&storage, &id, 1).unwrap(), "来自服务器");
        let key = storage.lock().unwrap().online_sync_key(&id).unwrap();
        assert_eq!(asked.lock().unwrap()[0], (key, "/c/1.html".to_string()));
        // Kept on the device: the server is not asked again.
        assert_eq!(raw_chapter(&storage, &id, 1).unwrap(), "来自服务器");
        assert_eq!(asked.lock().unwrap().len(), 1);
        // When the server has nothing, the source is asked (and fails here).
        assert!(raw_chapter(&storage, &id, 2).is_err());
    }

    #[test]
    fn a_web_page_is_never_kept_as_a_chapter() {
        let base = start(|_: &Request| Response::not_found());
        let (_dir, storage, id) = library(&base);
        let page = "<!doctype html>\n<html lang=\"zh-Hans\"><head></head></html>";
        // A page kept by an older build is dropped and the chapter fetched again.
        let path = {
            let guard = storage.lock().unwrap();
            let chapter = guard.online_chapter(&id, 1).unwrap().unwrap();
            guard.online_chapter_path(&id, &chapter)
        };
        write_cache(&path, page).unwrap();
        storage
            .lock()
            .unwrap()
            .set_chapter_relay(crate::storage::ChapterRelay(Arc::new(
                move |_: &str, chapter: &OnlineChapter| {
                    Some(if chapter.url == "/c/1.html" {
                        "正文".to_string()
                    } else {
                        page.to_string()
                    })
                },
            )));
        assert_eq!(raw_chapter(&storage, &id, 1).unwrap(), "正文");
        // A relay answering with a page is not believed.
        assert!(raw_chapter(&storage, &id, 2).is_err());
        let path = {
            let guard = storage.lock().unwrap();
            let chapter = guard.online_chapter(&id, 2).unwrap().unwrap();
            guard.online_chapter_path(&id, &chapter)
        };
        assert!(!path.exists());
    }

    #[test]
    fn chapter_pictures_show_as_image_marks_with_their_size() {
        let base = start(|request: &Request| match request.path.as_str() {
            "/c/1.html" => Response::html(
                r#"<div id="content">第一段<img src="/p/1.png"><img src="/p/gone.png">第二段</div>"#,
            ),
            "/p/1.png" => {
                // A PNG header saying 3 × 2 pixels.
                let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
                png.extend([0, 0, 0, 13]);
                png.extend(b"IHDR");
                png.extend(3u32.to_be_bytes());
                png.extend(2u32.to_be_bytes());
                png.extend([8, 6, 0, 0, 0]);
                Response {
                    status: 200,
                    content_type: "image/png".into(),
                    headers: Vec::new(),
                    body: png,
                }
            }
            _ => Response::not_found(),
        });
        let (_dir, storage, id) = library(&base);
        let window = read_window(
            &storage,
            &request(&id, None, Some("chapter-1"), WindowDirection::Forward),
        )
        .unwrap();
        // The picture that could not be fetched is left out.
        assert_eq!(window.text, "第一章 惊蛰\n第一段\n\u{E000}\n第二段");
        let guard = storage.lock().unwrap();
        assert_eq!(
            guard.book_images(&id).unwrap(),
            vec![crate::models::BookImage {
                width: 3,
                height: 2
            }]
        );
        assert!(guard.online_image_path(&id, 0).is_file());
        // Clearing the cache takes the pictures with the chapters.
        guard.clear_online_cache(&id).unwrap();
        assert!(guard.book_images(&id).unwrap().is_empty());
    }

    #[test]
    fn title_rules_change_titles_and_content_rules_the_text() {
        let base = site();
        let (_dir, storage, id) = library(&base);
        let rule = |pattern: &str, replacement: &str, title: bool, content: bool| {
            crate::models::ReplaceRule {
                id: String::new(),
                name: pattern.into(),
                group: String::new(),
                pattern: pattern.into(),
                replacement: replacement.into(),
                is_regex: false,
                scope: String::new(),
                scope_title: title,
                scope_content: content,
                enabled: true,
                serial: 0,
            }
        };
        {
            let mut guard = storage.lock().unwrap();
            guard
                .save_replace_rule(&rule("惊蛰", "春分", true, false))
                .unwrap();
            guard
                .save_replace_rule(&rule("第一段", "首段", false, true))
                .unwrap();
            assert!(guard
                .save_replace_rule(&rule("x", "", false, false))
                .is_err());
        }
        let listing = toc(&storage, &id).unwrap();
        assert_eq!(listing.entries[1].title, "第一章 春分");
        let window = read_window(
            &storage,
            &request(&id, None, Some("chapter-1"), WindowDirection::Forward),
        )
        .unwrap();
        assert_eq!(window.text, "第一章 春分\n首段\n第二段");
    }

    #[test]
    fn chapters_inside_a_chapter_are_offered_once_and_listed() {
        let base = start(|request: &Request| match request.path.as_str() {
            "/c/1.html" => Response::html(
                r#"<div id="content">第一章 开端<br>甲的故事<br>第二章 转折<br>乙的故事<br>第三章 结局<br>丙的故事</div>"#,
            ),
            _ => Response::not_found(),
        });
        let (_dir, storage, id) = library(&base);
        // Nothing kept yet: nothing to ask.
        assert_eq!(toc_suggestion(&storage, &id).unwrap(), None);
        read_window(
            &storage,
            &request(&id, None, Some("chapter-1"), WindowDirection::Forward),
        )
        .unwrap();
        let asked = toc_suggestion(&storage, &id).unwrap().unwrap();
        assert_eq!(asked.kind, "inner");
        assert_eq!(asked.count, 3);
        assert_eq!(
            asked.titles,
            vec!["第一章 开端", "第二章 转折", "第三章 结局"]
        );
        let (settings, _) = storage.lock().unwrap().book_toc_settings(&id).unwrap();
        // Saying yes keeps the rule that found them.
        storage
            .lock()
            .unwrap()
            .save_book_toc_settings(
                &id,
                &crate::models::BookTocSettings {
                    asked: true,
                    inner_chapters: true,
                    rule_id: Some(asked.rule_id.clone()),
                    ..settings
                },
            )
            .unwrap();
        assert_eq!(toc_suggestion(&storage, &id).unwrap(), None);
        let listing = toc(&storage, &id).unwrap();
        let inner: Vec<&TocEntry> = listing
            .entries
            .iter()
            .filter(|entry| entry.locator.resource_id == "chapter-1" && entry.locator.offset > 0)
            .collect();
        assert_eq!(inner.len(), 3);
        assert_eq!(listing.rule_id.as_deref(), Some(asked.rule_id.as_str()));
        // Each entry opens where its heading is shown.
        let shown = chapter_text(&storage, &id, 1).unwrap();
        for entry in inner {
            let at = entry.locator.offset as usize;
            let text = String::from_utf16_lossy(&shown.units[at..]);
            assert!(text.starts_with(&entry.title), "{text:?} at {at}");
        }
        let ordinals: Vec<u64> = listing.entries.iter().map(|entry| entry.ordinal).collect();
        assert_eq!(
            ordinals,
            (0..listing.entries.len() as u64).collect::<Vec<_>>()
        );
    }

    #[test]
    fn prose_inside_a_chapter_is_not_split() {
        // Lines enabled rules match in ordinary text: numbered lists, 第N节课
        // in a sentence, a line opening with 后记, dialogue, and the
        // chapter's own title repeated; and two real headings in one chapter.
        let prose = concat!(
            r#"<div id="content">第一章 惊蛰<br>他列了几条：<br>1. 先去城里<br>2. 再去山上<br>"#,
            r#"一、带上剑<br>二、带上酒<br>这是第三节课的内容<br>翻到第五页<br>后记得要回信<br>"#,
            r#"“第二章写完了吗？”<br>番外篇还没写。<br>甲<br>第九章 外传<br>乙<br>第十章 外传<br>丙</div>"#,
        );
        let base = start(move |request: &Request| match request.path.as_str() {
            "/c/1.html" => Response::html(prose),
            _ => Response::not_found(),
        });
        let (_dir, storage, id) = library(&base);
        read_window(
            &storage,
            &request(&id, None, Some("chapter-1"), WindowDirection::Forward),
        )
        .unwrap();
        // Two headings in one chapter are not enough to ask.
        assert_eq!(toc_suggestion(&storage, &id).unwrap(), None);
        // Turned on by hand, the automatic choice finds nothing either.
        storage
            .lock()
            .unwrap()
            .save_book_toc_settings(
                &id,
                &crate::models::BookTocSettings {
                    asked: true,
                    inner_chapters: true,
                    ..Default::default()
                },
            )
            .unwrap();
        let listing = toc(&storage, &id).unwrap();
        assert!(listing
            .entries
            .iter()
            .all(|entry| entry.locator.offset == 0));
        // A loose rule chosen by hand still keeps to whole title lines.
        let regex =
            crate::txt_toc::compile_rule(r"^[ 　\t]{0,4}\d{1,5}[:：,.， 、_—\-].{1,30}$").unwrap();
        let body = "他说：\n1. 先去城里\n2. 再去山上。\n3. 第三条";
        let found = crate::txt_toc::heading_lines(body, &regex, "");
        let titles: Vec<&str> = found.iter().map(|(_, line)| line.as_str()).collect();
        assert_eq!(titles, vec!["1. 先去城里", "3. 第三条"]);
    }

    #[test]
    fn a_chapter_start_opens_before_its_text_is_fetched() {
        let base = site();
        let (_dir, storage, id) = library(&base);
        let locator = resolve_offset(
            &storage,
            &ResolveOffsetRequest {
                book_id: id.clone(),
                content_version: String::new(),
                resource_id: "chapter-2".into(),
                offset: 0,
            },
        )
        .unwrap();
        // Nothing fetched: the reader does that, showing its progress.
        let cached = storage.lock().unwrap().cached_online_chapters(&id).unwrap();
        assert!(!cached.contains(&2));
        // The reader opens there, the versions agreeing.
        let window = read_window(
            &storage,
            &request(&id, Some(locator), None, WindowDirection::Forward),
        )
        .unwrap();
        assert_eq!(window.resource_index, Some(2));
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
        // A window is the rest of its chapter, whatever size was asked for.
        assert_eq!(first.text, "第一章 惊蛰\n第一段\n第二段");
        assert!(!first.has_after);
        assert_eq!(first.next_resource_id.as_deref(), Some("chapter-2"));
        assert_eq!(first.end_offset, first.total_length);
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
        assert_eq!(rest.text, "惊蛰\n第一段\n第二段");
        // Backward from the resource's end reads it all, up to there.
        let end = read_window(
            &storage,
            &request(&id, None, Some("chapter-1"), WindowDirection::Backward),
        )
        .unwrap();
        assert_eq!(end.text, "第一章 惊蛰\n第一段\n第二段");
        assert_eq!(end.start_offset, 0);
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

    #[test]
    fn contents_update_from_the_source() {
        let base = start(|request: &Request| match request.path.as_str() {
            "/book/7/" => Response::html(
                r#"<h1>剑来</h1><div class="toc"><a href="/c/1.html">第一章 惊蛰</a><a href="/c/2.html">第二章 开门</a><a href="/c/3.html">第三章 立春</a></div>"#,
            ),
            "/c/1.html" => Response::html(r#"<div id="content">第一段</div>"#),
            _ => Response::not_found(),
        });
        let (_dir, storage, id) = library(&base);
        storage
            .lock()
            .unwrap()
            .save_book_source(
                &serde_json::json!({
                    "bookSourceUrl": base,
                    "bookSourceName": "甲站",
                    "ruleBookInfo": {"name": "tag.h1@text"},
                    "ruleToc": {"chapterList": "class.toc@tag.a", "chapterName": "text", "chapterUrl": "href"},
                    "ruleContent": {"content": "id.content@html"}
                })
                .to_string(),
                None,
            )
            .unwrap();
        let first = read_window(
            &storage,
            &request(&id, None, Some("chapter-1"), WindowDirection::Forward),
        )
        .unwrap();
        storage
            .lock()
            .unwrap()
            .save_position_record(&first.locator)
            .unwrap();
        // The volume line is gone, so every chapter moves up one place.
        let added = refresh_toc(&storage, &id, Default::default()).unwrap();
        assert_eq!(added, 0);
        let guard = storage.lock().unwrap();
        assert_eq!(guard.online_chapter_count(&id).unwrap(), 3);
        assert_eq!(
            guard
                .online_position(&id)
                .unwrap()
                .map(|position| position.title),
            Some("第一章 惊蛰".to_string())
        );
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
