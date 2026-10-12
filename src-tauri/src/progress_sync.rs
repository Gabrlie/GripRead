//! Reading progress sync over WebDAV (Legado 同步阅读进度 and 同步增强).
//!
//! Each book has one record, `Progress/<source sha256>.json`, written by
//! whichever device read it last. A device recognizes its own uploads by
//! its random device id and remembers which remote version it already
//! answered, so a slow server never makes the reader ask about progress it
//! wrote itself, and each new remote position is asked about once.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::cloud::{connect, lock, now_millis};
use crate::error::{AppError, ErrorCode};
use crate::models::ProgressPrompt;
use crate::storage::{PortableLocator, Storage};

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
        if !settings.configured() || !settings.sync_progress {
            return Ok(false);
        }
        let Some((portable, _)) = guard.portable_position(book_id)? else {
            return Ok(false);
        };
        let source = guard.book_source_file(book_id)?.1;
        (settings, source, portable, guard.progress_state(book_id)?)
    };
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
pub fn fetch(storage: &Mutex<Storage>, book_id: &str) -> Result<Option<ProgressPrompt>, AppError> {
    let (settings, source) = {
        let guard = lock(storage)?;
        let settings = guard.stored_webdav()?;
        if !settings.configured() || !settings.sync_progress {
            return Ok(None);
        }
        (settings, guard.book_source_file(book_id)?.1)
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
    let mut state = guard.progress_state(book_id)?;
    if record.device_id == settings.device_id
        || (state.handled_device == record.device_id && state.handled_revision == record.revision)
    {
        return Ok(None);
    }
    let located = guard.locator_from_portable(book_id, &record.locator)?;
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
        chapter_title: record.chapter_title,
        excerpt: located.context_after.chars().take(40).collect(),
        locator: located,
    }))
}

/// Records that the reader answered a cloud version, jumping or not.
pub fn acknowledge(
    storage: &Mutex<Storage>,
    book_id: &str,
    device_id: &str,
    revision: u64,
) -> Result<(), AppError> {
    let guard = lock(storage)?;
    let mut state = guard.progress_state(book_id)?;
    state.handled_device = device_id.into();
    state.handled_revision = revision;
    guard.save_progress_state(book_id, &state)
}
