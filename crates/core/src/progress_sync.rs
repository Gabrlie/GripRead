//! Reading progress sync over WebDAV (Legado 同步阅读进度 and 同步增强).
//!
//! Each book has one record, `Progress/<source sha256>.json`, written by
//! whichever device read it last. A device recognizes its own uploads by
//! its random device id and remembers which remote version it already
//! answered, so a slow server never makes the reader ask about progress it
//! wrote itself, and each new remote position is asked about once. Online
//! books are keyed by name and author, as Legado does, so the same book on
//! another source still matches; their position is a chapter position.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::cloud::{connect, lock, now_millis};
use crate::error::{AppError, ErrorCode};
use crate::models::{ProgressPrompt, ReaderLocator};
use crate::storage::{ChapterPosition, PortableLocator, ProgressState, Storage};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RemoteProgress {
    version: u32,
    source_sha256: String,
    device_id: String,
    device_name: String,
    /// Counts this device's uploads for the book.
    revision: u64,
    written_at: i64,
    locator: PortableLocator,
    #[serde(default)]
    chapter_title: String,
    /// For an online book: the chapter position, independent of its source.
    #[serde(default)]
    chapter: Option<ChapterPosition>,
}

/// An online book's record name: its name and author, hashed for a safe path.
fn online_key(name: &str, author: &str) -> String {
    crate::storage::online_key(name, author)
}

/// The record key and position of a book: the original file's hash and
/// its text position, or for an online book its name key and chapter.
fn book_position(
    guard: &Storage,
    book_id: &str,
) -> Result<Option<(String, PortableLocator, Option<ChapterPosition>)>, AppError> {
    if guard.is_online_book(book_id)? {
        let record = guard.online_record(book_id)?;
        let Some(position) = guard.online_position(book_id)? else {
            return Ok(None);
        };
        let locator = PortableLocator {
            content_version: format!("chapter-{}", position.index),
            offset: position.offset,
            total_length: u64::from(position.count),
            context_before: String::new(),
            context_after: String::new(),
        };
        return Ok(Some((
            online_key(&record.title, &record.book.author),
            locator,
            Some(position),
        )));
    }
    let Some((portable, _)) = guard.portable_position(book_id)? else {
        return Ok(None);
    };
    Ok(Some((guard.book_source_file(book_id)?.1, portable, None)))
}

fn book_key(guard: &Storage, book_id: &str) -> Result<String, AppError> {
    if guard.is_online_book(book_id)? {
        let record = guard.online_record(book_id)?;
        return Ok(online_key(&record.title, &record.book.author));
    }
    Ok(guard.book_source_file(book_id)?.1)
}

const PROGRESS_LIMIT: u64 = 1024 * 1024;

fn record_path(folder: &str, source: &str) -> String {
    format!("{folder}/{source}.json")
}

/// Uploads the book's saved position when it changed since the last sync.
/// Returns whether anything was uploaded.
pub fn upload(
    storage: &Mutex<Storage>,
    book_id: &str,
    chapter_title: &str,
    fallback_device: &str,
) -> Result<bool, AppError> {
    let (settings, source, position, mut state) = {
        let guard = lock(storage)?;
        let settings = guard.stored_webdav()?;
        // A private group may keep its books' progress on the device.
        if !settings.configured() || !settings.sync_progress || guard.keeps_book_private(book_id)? {
            return Ok(false);
        }
        let Some((source, portable, chapter)) = book_position(&guard, book_id)? else {
            return Ok(false);
        };
        (
            settings,
            source,
            (portable, chapter),
            guard.progress_state(book_id)?,
        )
    };
    let (position, chapter) = position;
    if state.synced_version.as_deref() == Some(position.content_version.as_str())
        && state.synced_offset == Some(position.offset)
    {
        return Ok(false);
    }
    let (dav, folders) = connect(storage)?;
    let revision = state.local_revision + 1;
    let record = RemoteProgress {
        version: 1,
        source_sha256: source.clone(),
        device_id: settings.device_id.clone(),
        device_name: settings.device(fallback_device),
        revision,
        written_at: now_millis(),
        locator: position.clone(),
        chapter_title: chapter_title.chars().take(100).collect(),
        chapter,
    };
    let bytes = serde_json::to_vec(&record)?;
    let path = record_path(&folders.progress, &source);
    if dav.put(&path, bytes.clone()).is_err() {
        // The first upload creates the folder.
        dav.create_folder(&folders.progress)?;
        dav.put(&path, bytes)?;
    }
    state.local_revision = revision;
    state.handled_device = settings.device_id;
    state.handled_revision = revision;
    state.synced_version = Some(position.content_version);
    state.synced_offset = Some(position.offset);
    lock(storage)?.save_progress_state(book_id, &state)?;
    Ok(true)
}

/// The cloud progress of a book when another device wrote a version this
/// device has not answered yet and it differs from the current position.
/// With the server: a prompt for the position record native sync holds for
/// the book; `None` when sync holds none.
pub fn fetch_synced(
    storage: &Mutex<Storage>,
    book_id: &str,
) -> Result<Option<Option<ProgressPrompt>>, AppError> {
    let guard = lock(storage)?;
    // A book a private group keeps on the device has no other device's place.
    if guard.keeps_book_private(book_id)? {
        return Ok(Some(None));
    }
    let Some(value) = guard.synced_progress(book_id)? else {
        return Ok(None);
    };
    let own = guard.stored_webdav()?.device_id;
    let updated = value["updatedAt"].as_i64().unwrap_or(0);
    let online = guard.is_online_book(book_id)?;
    let record = RemoteProgress {
        version: 1,
        source_sha256: String::new(),
        device_id: value["deviceId"].as_str().unwrap_or_default().to_string(),
        device_name: value["deviceName"].as_str().unwrap_or_default().to_string(),
        revision: updated.max(0) as u64,
        written_at: updated,
        locator: if online {
            PortableLocator {
                content_version: String::new(),
                offset: 0,
                total_length: 0,
                context_before: String::new(),
                context_after: String::new(),
            }
        } else {
            serde_json::from_value(value["position"].clone())?
        },
        chapter_title: String::new(),
        chapter: if online {
            serde_json::from_value(value["position"].clone()).ok()
        } else {
            None
        },
    };
    prompt(&guard, book_id, &own, record).map(Some)
}

pub fn fetch(storage: &Mutex<Storage>, book_id: &str) -> Result<Option<ProgressPrompt>, AppError> {
    if let Some(prompt) = fetch_synced(storage, book_id)? {
        return Ok(prompt);
    }
    let (settings, source) = {
        let guard = lock(storage)?;
        let settings = guard.stored_webdav()?;
        if !settings.configured() || !settings.sync_progress || guard.keeps_book_private(book_id)? {
            return Ok(None);
        }
        (settings, book_key(&guard, book_id)?)
    };
    let (dav, folders) = connect(storage)?;
    let path = record_path(&folders.progress, &source);
    if !dav.exists(&path)? {
        return Ok(None);
    }
    let record: RemoteProgress =
        serde_json::from_slice(&dav.download_bytes(&path, PROGRESS_LIMIT)?).map_err(|error| {
            AppError::new(ErrorCode::Io, format!("cloud progress is invalid: {error}"))
        })?;
    let guard = lock(storage)?;
    prompt(&guard, book_id, &settings.device_id, record)
}

/// A prompt for another device's position, unless this device wrote it,
/// already answered it, or is there already.
fn prompt(
    guard: &Storage,
    book_id: &str,
    own_device: &str,
    record: RemoteProgress,
) -> Result<Option<ProgressPrompt>, AppError> {
    let mut state = guard.progress_state(book_id)?;
    if record.device_id.is_empty()
        || record.device_id == own_device
        || (state.handled_device == record.device_id && state.handled_revision == record.revision)
    {
        return Ok(None);
    }
    let located = match &record.chapter {
        Some(position) if guard.is_online_book(book_id)? => guard
            .locate_online_position(book_id, position)?
            .map(|(locator, _)| locator),
        // A local book's record has no chapter position, and the reverse.
        Some(_) | None if guard.is_online_book(book_id)? => None,
        _ => guard.locator_from_portable(book_id, &record.locator)?,
    };
    // The device answered about already, still reading nearby: one
    // chapter on for an online book, about a chapter's text for a local one.
    if located.as_ref().is_some_and(|located| {
        state.handled_device == record.device_id && near_handled(&state, located)
    }) {
        // The answered place stays, so reading on far enough asks again.
        state.handled_revision = record.revision;
        guard.save_progress_state(book_id, &state)?;
        return Ok(None);
    }
    let current = guard.saved_position(book_id)?;
    let Some(located) = located.filter(|located| {
        current.as_ref().is_none_or(|current| {
            current.content_version != located.content_version || current.offset != located.offset
        })
    }) else {
        // Nothing to move to: the position is already the same here.
        state.handled_device = record.device_id;
        state.handled_revision = record.revision;
        guard.save_progress_state(book_id, &state)?;
        return Ok(None);
    };
    Ok(Some(ProgressPrompt {
        device_id: record.device_id,
        device_name: record.device_name,
        revision: record.revision,
        written_at: record.written_at,
        excerpt: if located.context_after.is_empty() {
            record.chapter_title.clone()
        } else {
            located.context_after.chars().take(40).collect()
        },
        chapter_title: record.chapter_title,
        locator: located,
    }))
}

/// About a chapter of a local book's text, in UTF-16 units.
const NEAR_UNITS: u64 = 10_000;

/// Whether `located` is within a chapter of the answered position.
fn near_handled(state: &ProgressState, located: &ReaderLocator) -> bool {
    let (Some(resource), Some(offset)) = (&state.handled_resource, state.handled_offset) else {
        return false;
    };
    match (
        crate::storage::resource_chapter(resource),
        crate::storage::resource_chapter(&located.resource_id),
    ) {
        (Some(handled), Some(now)) => handled.abs_diff(now) <= 1,
        (None, None) => {
            resource == &located.resource_id && offset.abs_diff(located.offset) <= NEAR_UNITS
        }
        _ => false,
    }
}

/// Records that the reader answered a cloud version, jumping or not, and
/// where that position was.
pub fn acknowledge(
    storage: &Mutex<Storage>,
    book_id: &str,
    device_id: &str,
    revision: u64,
    locator: Option<&ReaderLocator>,
) -> Result<(), AppError> {
    let guard = lock(storage)?;
    let mut state = guard.progress_state(book_id)?;
    state.handled_device = device_id.into();
    state.handled_revision = revision;
    state.handled_resource = locator.map(|locator| locator.resource_id.clone());
    state.handled_offset = locator.map(|locator| locator.offset);
    guard.save_progress_state(book_id, &state)
}
