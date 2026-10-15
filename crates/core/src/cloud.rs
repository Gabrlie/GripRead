//! Backups and the cloud bookshelf over WebDAV (Sync specification).
//!
//! Everything lives in the application folder under the configured address
//! (`GripRead/` unless 子文件夹 is set): backups in `Backups/`, book files
//! and their index in `Books/`, cover images in `Covers/`, and reading
//! progress in `Progress/`, each with its own job. A backup never contains
//! books, and uploading a book does not back anything up. Storage is locked
//! only to read or apply records; network transfers run without the lock.

use std::collections::HashSet;
use std::fs::{self, File};
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, ErrorCode};
use crate::models::{CloudBook, CloudUploadReport, PickedFile, RemoteBackup, WebDavCheck};
use crate::storage::{
    backup_digest, parse_backup, BackupDocument, CloudMetadata, CoverRef, Storage, StoredWebDav,
};
use crate::webdav::WebDav;

/// Automatic backups kept on the server; manual ones are never pruned.
const AUTOMATIC_KEPT: usize = 7;
const DAY_MILLIS: i64 = 24 * 60 * 60 * 1000;
const BACKUP_LIMIT: u64 = 64 * 1024 * 1024;
const INDEX_FILE: &str = "index.json";
const COVER_LIMIT: u64 = 8 * 1024 * 1024;
/// Round trips slower than this make progress sync unpleasant.
pub const SLOW_LATENCY_MS: u32 = 800;
/// The automatic backup in a local backup folder, replaced each time.
pub const LOCAL_AUTOMATIC_NAME: &str = "gripread-backup-auto.json";

pub(crate) fn lock(
    storage: &Mutex<Storage>,
) -> Result<std::sync::MutexGuard<'_, Storage>, AppError> {
    storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
}

pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// `YYYYMMDD-HHMMSS` in UTC.
fn stamp(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let time = seconds.rem_euclid(86_400);
    // Civil date from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        time / 3600,
        time / 60 % 60,
        time % 60
    )
}

/// The folders of one account.
pub(crate) struct Folders {
    pub backups: String,
    pub books: String,
    pub covers: String,
    pub progress: String,
}

impl Folders {
    pub fn of(settings: &StoredWebDav) -> Self {
        let root = settings.root_folder();
        Self {
            backups: format!("{root}/Backups"),
            books: format!("{root}/Books"),
            covers: format!("{root}/Covers"),
            progress: format!("{root}/Progress"),
        }
    }
}

pub fn client(settings: &StoredWebDav) -> Result<WebDav, AppError> {
    if !settings.configured() {
        return Err(AppError::invalid_argument("WebDAV is not set up"));
    }
    WebDav::new(&settings.address(), &settings.username, &settings.password)
}

pub(crate) fn connect(storage: &Mutex<Storage>) -> Result<(WebDav, Folders), AppError> {
    let settings = lock(storage)?.stored_webdav()?;
    Ok((client(&settings)?, Folders::of(&settings)))
}

/// Checks the account and measures the median round trip of three requests.
pub fn check(settings: &StoredWebDav) -> Result<WebDavCheck, AppError> {
    let dav = client(settings)?;
    let mut times = Vec::new();
    for _ in 0..3 {
        let started = Instant::now();
        dav.check()?;
        times.push(started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32);
    }
    times.sort_unstable();
    let latency_ms = times[1];
    Ok(WebDavCheck {
        latency_ms,
        slow: latency_ms > SLOW_LATENCY_MS,
    })
}

fn is_backup_name(name: &str) -> bool {
    (name.starts_with("auto-") || name.starts_with("manual-"))
        && name.ends_with(".json")
        && !name.contains(['/', '\\'])
}

/// The time stamp and device name in a backup file name.
fn backup_parts(name: &str) -> (String, Option<String>) {
    let rest = name
        .split_once('-')
        .map_or("", |(_, rest)| rest)
        .trim_end_matches(".json");
    let stamp: String = rest.chars().take(15).collect();
    let device = rest
        .get(stamp.len()..)
        .and_then(|tail| tail.strip_prefix('-'))
        .filter(|device| !device.is_empty())
        .map(str::to_string);
    (stamp, device)
}

pub fn backup_file_name(document: &BackupDocument, automatic: bool) -> String {
    let device = if document.device.trim().is_empty() {
        String::new()
    } else {
        format!("-{}", file_name(&document.device))
    };
    format!(
        "{}-{}{device}.json",
        if automatic { "auto" } else { "manual" },
        stamp(document.created_at)
    )
}

/// Uploads the covers a backup names that the server does not have yet.
fn upload_backup_covers(
    storage: &Mutex<Storage>,
    dav: &WebDav,
    folders: &Folders,
    document: &BackupDocument,
) -> Result<(), AppError> {
    let wanted: Vec<(String, CoverRef)> = {
        let guard = lock(storage)?;
        let mut wanted = Vec::new();
        for (book_id, _) in guard.shelf_sources()? {
            if let Some((_, cover)) = guard.book_cover_file(&book_id)? {
                if document
                    .books
                    .iter()
                    .any(|book| book.cover.as_ref() == Some(&cover))
                {
                    wanted.push((book_id, cover));
                }
            }
        }
        wanted
    };
    if wanted.is_empty() {
        return Ok(());
    }
    dav.create_folder(&folders.covers)?;
    let present: HashSet<String> = dav
        .list(&folders.covers)?
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    for (book_id, cover) in wanted {
        if present.contains(&cover.file_name()) {
            continue;
        }
        let path = lock(storage)?
            .book_cover_file(&book_id)?
            .map(|(path, _)| path);
        if let Some(path) = path {
            dav.put(
                &format!("{}/{}", folders.covers, cover.file_name()),
                File::open(path)?,
            )?;
        }
    }
    Ok(())
}

/// Downloads the covers a backup names into the local cover cache, so a
/// restore (or a later import of a book that is not here yet) can use them.
pub fn fetch_backup_covers(
    storage: &Mutex<Storage>,
    document: &BackupDocument,
) -> Result<(), AppError> {
    let (dav, folders) = connect(storage)?;
    let cache = lock(storage)?.cover_cache();
    fs::create_dir_all(&cache)?;
    for cover in document.books.iter().filter_map(|book| book.cover.as_ref()) {
        let path = cache.join(cover.file_name());
        if !path.is_file() {
            download_cover(&dav, &folders, cover, &path)?;
        }
    }
    Ok(())
}

fn download_cover(
    dav: &WebDav,
    folders: &Folders,
    cover: &CoverRef,
    path: &Path,
) -> Result<(), AppError> {
    let remote = format!("{}/{}", folders.covers, cover.file_name());
    if !dav.exists(&remote)? {
        return Ok(());
    }
    let bytes = dav.download_bytes(&remote, COVER_LIMIT)?;
    let partial = path.with_extension("part");
    fs::write(&partial, bytes)?;
    fs::rename(&partial, path)?;
    Ok(())
}

/// Uploads the current records as a new manual backup; returns it with its records.
pub fn backup_now(
    storage: &Mutex<Storage>,
    fallback_device: &str,
) -> Result<(RemoteBackup, BackupDocument), AppError> {
    let (dav, folders, document) = {
        let guard = lock(storage)?;
        let settings = guard.stored_webdav()?;
        (
            client(&settings)?,
            Folders::of(&settings),
            guard.export_backup(&settings.device(fallback_device))?,
        )
    };
    let backup = upload_backup(storage, &dav, &folders, &document, false)?;
    Ok((backup, document))
}

pub(crate) fn upload_backup(
    storage: &Mutex<Storage>,
    dav: &WebDav,
    folders: &Folders,
    document: &BackupDocument,
    automatic: bool,
) -> Result<RemoteBackup, AppError> {
    let bytes = serde_json::to_vec(document)?;
    let name = backup_file_name(document, automatic);
    dav.create_folder(&folders.backups)?;
    upload_backup_covers(storage, dav, folders, document)?;
    dav.put(&format!("{}/{name}", folders.backups), bytes.clone())?;
    if automatic {
        let mut automatic_names: Vec<String> = dav
            .list(&folders.backups)?
            .into_iter()
            .filter(|entry| !entry.directory && entry.name.starts_with("auto-"))
            .map(|entry| entry.name)
            .collect();
        automatic_names.sort_by_key(|name| backup_parts(name).0);
        while automatic_names.len() > AUTOMATIC_KEPT {
            let oldest = automatic_names.remove(0);
            dav.delete(&format!("{}/{oldest}", folders.backups))?;
        }
    }
    let guard = lock(storage)?;
    let mut settings = guard.stored_webdav()?;
    settings.last_backup_at = Some(document.created_at);
    settings.last_error = None;
    if automatic {
        settings.last_backup_digest = Some(backup_digest(document)?);
    }
    guard.save_stored_webdav(&settings)?;
    Ok(RemoteBackup {
        size: bytes.len() as u64,
        modified: Some(document.created_at),
        automatic,
        device: (!document.device.is_empty()).then(|| document.device.clone()),
        name,
    })
}

/// The daily automatic backup: runs when it is enabled, a day has passed
/// since the last one, and the records changed. It goes to WebDAV when an
/// account is set and to the local backup folder when one is chosen
/// (`write_local` receives the file name and bytes). A failure is kept for
/// the settings page instead of interrupting reading.
pub fn automatic_backup(
    storage: &Mutex<Storage>,
    fallback_device: &str,
    write_local: impl Fn(&str, &str, &[u8]) -> Result<(), AppError>,
) -> Result<Option<RemoteBackup>, AppError> {
    let (settings, document) = {
        let guard = lock(storage)?;
        let settings = guard.stored_webdav()?;
        if !settings.auto_backup || !(settings.configured() || settings.local_folder.is_some()) {
            return Ok(None);
        }
        if settings
            .last_backup_at
            .is_some_and(|last| now_millis() - last < DAY_MILLIS)
        {
            return Ok(None);
        }
        let document = guard.export_backup(&settings.device(fallback_device))?;
        if settings.last_backup_digest.as_deref() == Some(backup_digest(&document)?.as_str()) {
            return Ok(None);
        }
        (settings, document)
    };
    let result = (|| {
        if let Some(folder) = &settings.local_folder {
            // The copy kept on the device carries the WebDAV account.
            let mut local = document.clone();
            local.webdav = lock(storage)?.portable_webdav()?;
            write_local(folder, LOCAL_AUTOMATIC_NAME, &serde_json::to_vec(&local)?)?;
        }
        if settings.configured() {
            let dav = client(&settings)?;
            return upload_backup(storage, &dav, &Folders::of(&settings), &document, true)
                .map(Some);
        }
        let guard = lock(storage)?;
        let mut stored = guard.stored_webdav()?;
        stored.last_backup_at = Some(document.created_at);
        stored.last_backup_digest = Some(backup_digest(&document)?);
        stored.last_error = None;
        guard.save_stored_webdav(&stored)?;
        Ok(None)
    })();
    if let Err(error) = &result {
        let guard = lock(storage)?;
        let mut stored = guard.stored_webdav()?;
        stored.last_error = Some(error.message.clone());
        guard.save_stored_webdav(&stored)?;
    }
    result
}

/// Backups on the server, newest first.
pub fn list_backups(storage: &Mutex<Storage>) -> Result<Vec<RemoteBackup>, AppError> {
    let (dav, folders) = connect(storage)?;
    let mut backups: Vec<RemoteBackup> = dav
        .list(&folders.backups)?
        .into_iter()
        .filter(|entry| !entry.directory && is_backup_name(&entry.name))
        .map(|entry| RemoteBackup {
            automatic: entry.name.starts_with("auto-"),
            device: backup_parts(&entry.name).1,
            name: entry.name,
            size: entry.size,
            modified: entry.modified,
        })
        .collect();
    backups.sort_by_key(|backup| std::cmp::Reverse(backup_parts(&backup.name).0));
    Ok(backups)
}

pub fn fetch_backup(storage: &Mutex<Storage>, name: &str) -> Result<BackupDocument, AppError> {
    if !is_backup_name(name) {
        return Err(AppError::invalid_argument("unknown backup"));
    }
    let (dav, folders) = connect(storage)?;
    parse_backup(&dav.download_bytes(&format!("{}/{name}", folders.backups), BACKUP_LIMIT)?)
}

pub fn delete_backup(storage: &Mutex<Storage>, name: &str) -> Result<(), AppError> {
    if !is_backup_name(name) {
        return Err(AppError::invalid_argument("unknown backup"));
    }
    let (dav, folders) = connect(storage)?;
    dav.delete(&format!("{}/{name}", folders.backups))
}

/// The cloud book folder's index: which file holds which book, with its
/// hash and the book information to restore when it is downloaded.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct BookIndex {
    version: u32,
    books: Vec<IndexedBook>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct IndexedBook {
    name: String,
    source_sha256: String,
    title: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    intro: Option<String>,
    #[serde(default)]
    cover: Option<CoverRef>,
    size: u64,
    uploaded_at: i64,
    #[serde(default)]
    updated_at: i64,
    /// The device that uploaded or last updated the entry.
    #[serde(default)]
    device: String,
}

fn read_index(dav: &WebDav, folders: &Folders) -> Result<BookIndex, AppError> {
    let path = format!("{}/{INDEX_FILE}", folders.books);
    if !dav.exists(&path)? {
        return Ok(BookIndex::default());
    }
    let bytes = dav.download_bytes(&path, 16 * 1024 * 1024)?;
    // An unreadable index is rebuilt from the uploads that follow.
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn write_index(dav: &WebDav, folders: &Folders, index: &BookIndex) -> Result<(), AppError> {
    let mut index = index.clone();
    index.version = 2;
    dav.put(
        &format!("{}/{INDEX_FILE}", folders.books),
        serde_json::to_vec_pretty(&index)?,
    )
}

/// A file name part without characters servers reject.
pub(crate) fn file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|character| {
            if r#"/\:*?"<>|"#.contains(character) || character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    let cleaned: String = cleaned.chars().take(80).collect();
    if cleaned.is_empty() {
        "book".into()
    } else {
        cleaned
    }
}

/// `书名 - 作者` for a cloud file, so books of the same title stay apart.
fn book_file_stem(title: &str, author: Option<&str>) -> String {
    match author.map(str::trim).filter(|author| !author.is_empty()) {
        Some(author) => format!("{} - {}", file_name(title), file_name(author)),
        None => file_name(title),
    }
}

/// Book files the cloud folder holds.
fn is_book_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".txt") || lower.ends_with(".epub")
}

fn title_of(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    [".txt", ".epub"]
        .iter()
        .find(|extension| lower.ends_with(*extension))
        .map_or(name, |extension| &name[..name.len() - extension.len()])
        .to_string()
}

/// Book files (TXT and EPUB) in the cloud book folder, with what the index knows of them
/// and the local book that has the same file. Also records which books are
/// in the cloud for the shelf's marks.
pub fn list_cloud_books(storage: &Mutex<Storage>) -> Result<Vec<CloudBook>, AppError> {
    let (dav, folders) = connect(storage)?;
    let index = read_index(&dav, &folders)?;
    let entries = dav.list(&folders.books)?;
    let mut guard = lock(storage)?;
    let mut books = Vec::new();
    let mut present = Vec::new();
    for entry in entries {
        if entry.directory || !is_book_name(&entry.name) {
            continue;
        }
        let indexed = index.books.iter().find(|book| book.name == entry.name);
        let local = match indexed {
            Some(book) => guard.local_book_for_source(&book.source_sha256)?,
            None => None,
        };
        if let Some(book) = indexed {
            present.push((
                book.source_sha256.clone(),
                book.name.clone(),
                book.uploaded_at,
            ));
        }
        books.push(CloudBook {
            title: indexed.map_or_else(|| title_of(&entry.name), |book| book.title.clone()),
            author: indexed.and_then(|book| book.author.clone()),
            size: entry.size,
            source_sha256: indexed.map(|book| book.source_sha256.clone()),
            uploaded_at: indexed.map(|book| book.uploaded_at).or(entry.modified),
            local_book_id: local
                .as_ref()
                .filter(|(_, removed)| !removed)
                .map(|(id, _)| id.clone()),
            local_removed: local.as_ref().is_some_and(|(_, removed)| *removed),
            name: entry.name,
        });
    }
    guard.set_cloud_books(&present)?;
    books.sort_by_key(|book| std::cmp::Reverse(book.uploaded_at));
    Ok(books)
}

enum Upload {
    Uploaded,
    Updated,
    Unchanged,
}

/// Uploads the original files of `book_ids` (every shelf book when empty)
/// with their information and covers. A book already on the cloud
/// bookshelf only has its information brought up to date.
pub fn upload_books(
    storage: &Mutex<Storage>,
    book_ids: &[String],
    fallback_device: &str,
) -> Result<CloudUploadReport, AppError> {
    let (dav, folders) = connect(storage)?;
    let device = lock(storage)?.stored_webdav()?.device(fallback_device);
    dav.create_folder(&folders.books)?;
    let mut index = read_index(&dav, &folders)?;
    let names: HashSet<String> = dav
        .list(&folders.books)?
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    let mut covers: Option<HashSet<String>> = None;
    let ids: Vec<String> = if book_ids.is_empty() {
        lock(storage)?
            .shelf_sources()?
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    } else {
        book_ids.to_vec()
    };
    let mut report = CloudUploadReport::default();
    for id in ids {
        let source = {
            let guard = lock(storage)?;
            guard.book_source_file(&id).and_then(|(path, hash, title)| {
                let book = guard.get_book(&id)?;
                let intro = guard.book_intro(&id)?;
                let cover = guard.book_cover_file(&id)?;
                Ok((path, hash, title, book.author, intro, cover))
            })
        };
        let (path, hash, title, author, intro, cover) = match source {
            Ok(source) => source,
            Err(error) => {
                report.failed.push(format!("{id}: {}", error.message));
                continue;
            }
        };
        let result = (|| -> Result<Upload, AppError> {
            if let Some((cover_path, cover)) = &cover {
                let present = match &mut covers {
                    Some(present) => present,
                    None => {
                        dav.create_folder(&folders.covers)?;
                        covers.insert(
                            dav.list(&folders.covers)?
                                .into_iter()
                                .map(|entry| entry.name)
                                .collect(),
                        )
                    }
                };
                if !present.contains(&cover.file_name()) {
                    dav.put(
                        &format!("{}/{}", folders.covers, cover.file_name()),
                        File::open(cover_path)?,
                    )?;
                    present.insert(cover.file_name());
                }
            }
            let cover = cover.map(|(_, cover)| cover);
            let existing = index
                .books
                .iter()
                .position(|book| book.source_sha256 == hash && names.contains(&book.name));
            let now = now_millis();
            if let Some(position) = existing {
                let entry = &mut index.books[position];
                let changed = entry.title != title
                    || entry.author != author
                    || entry.intro != intro
                    || entry.cover != cover;
                if changed {
                    entry.title = title.clone();
                    entry.author = author.clone();
                    entry.intro = intro.clone();
                    entry.cover = cover.clone();
                    entry.updated_at = now;
                    entry.device = device.clone();
                    write_index(&dav, &folders, &index)?;
                }
                let entry = &index.books[position];
                lock(storage)?.add_cloud_book(&hash, &entry.name, entry.uploaded_at)?;
                return Ok(if changed {
                    Upload::Updated
                } else {
                    Upload::Unchanged
                });
            }
            let stem = book_file_stem(&title, author.as_deref());
            let taken = |name: &str| {
                names.contains(name) || index.books.iter().any(|book| book.name == name)
            };
            let extension = if crate::epub::is_epub_file(&path) {
                "epub"
            } else {
                "txt"
            };
            let name = if taken(&format!("{stem}.{extension}")) {
                format!("{stem}-{}.{extension}", &hash[..8.min(hash.len())])
            } else {
                format!("{stem}.{extension}")
            };
            let size = fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            dav.put(&format!("{}/{name}", folders.books), File::open(&path)?)?;
            index
                .books
                .retain(|book| book.name != name && book.source_sha256 != hash);
            index.books.push(IndexedBook {
                name: name.clone(),
                source_sha256: hash.clone(),
                title: title.clone(),
                author: author.clone(),
                intro: intro.clone(),
                cover,
                size,
                uploaded_at: now,
                updated_at: now,
                device: device.clone(),
            });
            // Keep the index current, so an interrupted batch loses nothing.
            write_index(&dav, &folders, &index)?;
            lock(storage)?.add_cloud_book(&hash, &name, now)?;
            Ok(Upload::Uploaded)
        })();
        match result {
            Ok(Upload::Uploaded) => report.uploaded += 1,
            Ok(Upload::Updated) => report.updated += 1,
            Ok(Upload::Unchanged) => report.skipped += 1,
            Err(error) => report.failed.push(format!("{title}: {}", error.message)),
        }
    }
    Ok(report)
}

/// Downloads a cloud book completely into a staging folder, named by its
/// title, for the ordinary import (which matches it to a book with the
/// same file instead of adding a second copy). Its information and cover
/// wait to be applied when the import commits.
pub fn download_cloud_book(
    storage: &Mutex<Storage>,
    data_root: &Path,
    name: &str,
) -> Result<PickedFile, AppError> {
    if name.contains(['/', '\\']) || !is_book_name(name) {
        return Err(AppError::invalid_argument("unknown cloud book"));
    }
    let (dav, folders) = connect(storage)?;
    let index = read_index(&dav, &folders)?;
    let entry = index.books.iter().find(|book| book.name == name).cloned();
    let title = entry
        .as_ref()
        .map_or_else(|| title_of(name), |book| book.title.clone());
    let directory = data_root
        .join("document-staging")
        .join(format!("cloud-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory)?;
    let extension = if name.to_ascii_lowercase().ends_with(".epub") {
        "epub"
    } else {
        "txt"
    };
    let file = format!("{}.{extension}", file_name(&title));
    let path = directory.join(&file);
    let partial = directory.join(format!("{file}.part"));
    let result = (|| {
        let mut output = File::create(&partial)?;
        dav.download(&format!("{}/{name}", folders.books), &mut output)?;
        output.sync_all()?;
        fs::rename(&partial, &path)?;
        Ok::<_, AppError>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&directory);
        return Err(error);
    }
    if let Some(entry) = entry {
        if let Some(cover) = &entry.cover {
            let cache = lock(storage)?.cover_cache();
            fs::create_dir_all(&cache)?;
            let target = cache.join(cover.file_name());
            if !target.is_file() {
                // A missing cover does not stop the book.
                let _ = download_cover(&dav, &folders, cover, &target);
            }
        }
        lock(storage)?.queue_cloud_metadata(
            &entry.source_sha256,
            &CloudMetadata {
                title: entry.title,
                author: entry.author,
                intro: entry.intro,
                cover: entry.cover,
            },
        )?;
    }
    Ok(PickedFile {
        path: path.to_string_lossy().into_owned(),
        name: file,
    })
}

pub fn delete_cloud_book(storage: &Mutex<Storage>, name: &str) -> Result<(), AppError> {
    if name.contains(['/', '\\']) || name == INDEX_FILE {
        return Err(AppError::invalid_argument("unknown cloud book"));
    }
    let (dav, folders) = connect(storage)?;
    dav.delete(&format!("{}/{name}", folders.books))?;
    let mut index = read_index(&dav, &folders)?;
    let before = index.books.len();
    index.books.retain(|book| book.name != name);
    if index.books.len() != before {
        write_index(&dav, &folders, &index)?;
    }
    lock(storage)?.remove_cloud_book(name)?;
    Ok(())
}

/// Deletes the cloud copy of a local book, found by its original file.
pub fn delete_cloud_copy(storage: &Mutex<Storage>, book_id: &str) -> Result<(), AppError> {
    let hash = lock(storage)?.book_source_file(book_id)?.1;
    let (dav, folders) = connect(storage)?;
    let index = read_index(&dav, &folders)?;
    let names: Vec<String> = index
        .books
        .iter()
        .filter(|book| book.source_sha256 == hash)
        .map(|book| book.name.clone())
        .collect();
    for name in names {
        delete_cloud_book(storage, &name)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_server {
    //! A minimal in-memory WebDAV server for exercising the client.
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    pub struct Server {
        pub url: String,
        pub files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    }

    fn decode(path: &str) -> String {
        let bytes = path.as_bytes();
        let mut out = Vec::new();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' && index + 2 < bytes.len() {
                out.push(u8::from_str_radix(&path[index + 1..index + 3], 16).unwrap());
                index += 3;
            } else {
                out.push(bytes[index]);
                index += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }

    /// Serves `/dav/` for `user`/`pass`; folders are paths ending in `/`.
    pub fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/dav/", listener.local_addr().unwrap());
        let files: Arc<Mutex<BTreeMap<String, Vec<u8>>>> = Arc::default();
        files.lock().unwrap().insert("/dav/".into(), Vec::new());
        let shared = Arc::clone(&files);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = decode(parts.next().unwrap_or("/"));
                let mut headers = BTreeMap::new();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
                    }
                }
                let mut body = Vec::new();
                if let Some(length) = headers.get("content-length") {
                    body.resize(length.parse().unwrap(), 0);
                    reader.read_exact(&mut body).unwrap();
                } else if headers
                    .get("transfer-encoding")
                    .is_some_and(|v| v.contains("chunked"))
                {
                    loop {
                        let mut size = String::new();
                        reader.read_line(&mut size).unwrap();
                        let size = usize::from_str_radix(size.trim(), 16).unwrap();
                        let mut chunk = vec![0; size + 2];
                        reader.read_exact(&mut chunk).unwrap();
                        if size == 0 {
                            break;
                        }
                        body.extend_from_slice(&chunk[..size]);
                    }
                }
                let mut files = shared.lock().unwrap();
                let (status, payload) = if headers.get("authorization").map(String::as_str)
                    != Some("Basic dXNlcjpwYXNz")
                {
                    (401, Vec::new())
                } else {
                    match method.as_str() {
                        "MKCOL" => {
                            let folder = if path.ends_with('/') {
                                path.clone()
                            } else {
                                format!("{path}/")
                            };
                            match files.entry(folder) {
                                std::collections::btree_map::Entry::Occupied(_) => {
                                    (405, Vec::new())
                                }
                                std::collections::btree_map::Entry::Vacant(slot) => {
                                    slot.insert(Vec::new());
                                    (201, Vec::new())
                                }
                            }
                        }
                        "PUT" => {
                            files.insert(path, body);
                            (201, Vec::new())
                        }
                        "GET" => match files.get(&path) {
                            Some(bytes) => (200, bytes.clone()),
                            None => (404, Vec::new()),
                        },
                        "DELETE" => (
                            if files.remove(&path).is_some() {
                                204
                            } else {
                                404
                            },
                            Vec::new(),
                        ),
                        "PROPFIND" => {
                            let folder = if path.ends_with('/') {
                                path.clone()
                            } else {
                                format!("{path}/")
                            };
                            if headers.get("depth").map(String::as_str) == Some("0") {
                                let found =
                                    files.contains_key(&path) || files.contains_key(&folder);
                                (
                                    if found { 207 } else { 404 },
                                    b"<multistatus xmlns=\"DAV:\"/>".to_vec(),
                                )
                            } else if !files.contains_key(&folder) {
                                (404, Vec::new())
                            } else {
                                let mut xml = String::from(
                                    "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\">",
                                );
                                xml.push_str(&format!("<d:response><d:href>{folder}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>"));
                                for (name, bytes) in files.iter() {
                                    let Some(rest) = name.strip_prefix(&folder) else {
                                        continue;
                                    };
                                    let rest = rest.trim_end_matches('/');
                                    if rest.is_empty() || rest.contains('/') {
                                        continue;
                                    }
                                    let kind = if name.ends_with('/') {
                                        "<d:collection/>"
                                    } else {
                                        ""
                                    };
                                    xml.push_str(&format!("<d:response><d:href>{name}</d:href><d:propstat><d:prop><d:resourcetype>{kind}</d:resourcetype><d:getcontentlength>{}</d:getcontentlength></d:prop></d:propstat></d:response>", bytes.len()));
                                }
                                xml.push_str("</d:multistatus>");
                                (207, xml.into_bytes())
                            }
                        }
                        _ => (405, Vec::new()),
                    }
                };
                drop(files);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(&payload);
            }
        });
        Server { url, files }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RestoreCategory;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0";

    fn connected(root: &Path, url: &str) -> Mutex<Storage> {
        let storage = Storage::open(root).unwrap();
        let mut settings = storage.stored_webdav().unwrap();
        settings.url = url.into();
        settings.username = "user".into();
        settings.password = "pass".into();
        settings.auto_backup = true;
        storage.save_stored_webdav(&settings).unwrap();
        Mutex::new(storage)
    }

    fn import(storage: &Mutex<Storage>, path: &Path) -> String {
        let id = lock(storage)
            .unwrap()
            .import_txt(
                path,
                &Uuid::new_v4().to_string(),
                &std::sync::atomic::AtomicBool::new(false),
                |_, _, _| {},
            )
            .unwrap()
            .book
            .id;
        // As the import worker does after committing.
        lock(storage).unwrap().apply_pending_restore(&id).unwrap();
        id
    }

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("gripread-cloud-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn backups_and_the_cloud_bookshelf_over_webdav() {
        let server = test_server::start();
        let root = temp_root();
        let source = root.join("云海问道.txt");
        fs::write(&source, "第一章\n山门前的石阶。".as_bytes()).unwrap();
        let first = connected(&root.join("first"), &server.url);
        let book = import(&first, &source);

        // A wrong password is reported as such; a working account reports its latency.
        let mut wrong = lock(&first).unwrap().stored_webdav().unwrap();
        wrong.password = "nope".into();
        assert!(check(&wrong).unwrap_err().message.contains("401"));
        let measured = check(&lock(&first).unwrap().stored_webdav().unwrap()).unwrap();
        assert!(!measured.slow);

        // Manual backups stay and name the device; automatic ones are kept to seven.
        {
            let guard = lock(&first).unwrap();
            let mut settings = guard.stored_webdav().unwrap();
            settings.device_name = "书房平板".into();
            guard.save_stored_webdav(&settings).unwrap();
        }
        let (manual, _) = backup_now(&first, "Linux").unwrap();
        assert!(manual.name.starts_with("manual-") && manual.name.ends_with("-书房平板.json"));
        let (dav, folders) = connect(&first).unwrap();
        for day in 0..9 {
            let mut document = lock(&first).unwrap().export_backup("Linux").unwrap();
            document.created_at = 1_791_705_600_000 + day * DAY_MILLIS;
            upload_backup(&first, &dav, &folders, &document, true).unwrap();
        }
        let backups = list_backups(&first).unwrap();
        assert_eq!(backups.iter().filter(|backup| backup.automatic).count(), 7);
        let listed_manual = backups.iter().find(|backup| !backup.automatic).unwrap();
        assert_eq!(listed_manual.device.as_deref(), Some("书房平板"));
        assert_eq!(fetch_backup(&first, &manual.name).unwrap().books.len(), 1);
        // Today's automatic backup is done, and unchanged records are not uploaded again.
        assert!(automatic_backup(&first, "Linux", |_, _, _| Ok(()))
            .unwrap()
            .is_none());
        delete_backup(&first, &manual.name).unwrap();
        assert!(list_backups(&first)
            .unwrap()
            .iter()
            .all(|backup| backup.automatic));
        assert!(fetch_backup(&first, "../secret").is_err());

        // Uploading twice stores the file once; the listing and the shelf know it is local.
        let report = upload_books(&first, &[], "Linux").unwrap();
        assert_eq!((report.uploaded, report.skipped), (1, 0));
        assert_eq!(
            upload_books(&first, std::slice::from_ref(&book), "Linux")
                .unwrap()
                .skipped,
            1
        );
        assert!(lock(&first).unwrap().list_library_books().unwrap()[0].in_cloud);
        let cloud = list_cloud_books(&first).unwrap();
        assert_eq!(cloud.len(), 1);
        assert_eq!(cloud[0].name, "云海问道.txt");
        assert_eq!(cloud[0].local_book_id.as_deref(), Some(book.as_str()));

        // Another device pulls the whole file and imports it.
        let second = connected(&root.join("second"), &server.url);
        let listed = list_cloud_books(&second).unwrap();
        assert_eq!(listed[0].local_book_id, None);
        let pulled = download_cloud_book(&second, &root.join("second"), &listed[0].name).unwrap();
        assert_eq!(pulled.name, "云海问道.txt");
        let pulled_id = import(&second, Path::new(&pulled.path));
        assert_eq!(
            list_cloud_books(&second).unwrap()[0]
                .local_book_id
                .as_deref(),
            Some(pulled_id.as_str())
        );
        // Pulling again matches the same book instead of adding a copy.
        let again = download_cloud_book(&second, &root.join("second"), &listed[0].name).unwrap();
        assert_eq!(import(&second, Path::new(&again.path)), pulled_id);

        // A book in the 回收站 is not "on the shelf"; a deleted one can be downloaded again.
        lock(&second).unwrap().remove_book(&pulled_id).unwrap();
        let listed = list_cloud_books(&second).unwrap();
        assert_eq!(
            (listed[0].local_book_id.clone(), listed[0].local_removed),
            (None, true)
        );
        lock(&second).unwrap().delete_book(&pulled_id).unwrap();
        let listed = list_cloud_books(&second).unwrap();
        assert_eq!(
            (listed[0].local_book_id.clone(), listed[0].local_removed),
            (None, false)
        );

        // Deleting with the cloud copy removes the file and the index entry.
        delete_cloud_copy(&first, &book).unwrap();
        lock(&first).unwrap().delete_book(&book).unwrap();
        assert!(list_cloud_books(&first).unwrap().is_empty());
        assert!(lock(&first)
            .unwrap()
            .list_library_books()
            .unwrap()
            .is_empty());
        assert!(!String::from_utf8(
            server
                .files
                .lock()
                .unwrap()
                .get("/dav/GripRead/Books/index.json")
                .unwrap()
                .clone()
        )
        .unwrap()
        .contains("云海问道.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cloud_books_keep_authors_information_and_covers() {
        let server = test_server::start();
        let root = temp_root();
        let first = connected(&root.join("first"), &server.url);
        {
            // A custom folder under the address.
            let guard = lock(&first).unwrap();
            let mut settings = guard.stored_webdav().unwrap();
            settings.folder = "阅读/备份".into();
            guard.save_stored_webdav(&settings).unwrap();
        }
        let mut ids = Vec::new();
        for (file, text, author) in [
            ("a.txt", "第一章\n甲的书。", "甲"),
            ("b.txt", "第一章\n乙的书，不同的内容。", "乙"),
        ] {
            let path = root.join(file);
            fs::write(&path, text.as_bytes()).unwrap();
            let id = import(&first, &path);
            lock(&first)
                .unwrap()
                .update_book(&crate::models::UpdateBookRequest {
                    book_id: id.clone(),
                    title: "同名".into(),
                    author: Some(author.into()),
                    intro: Some(format!("{author}写的简介")),
                })
                .unwrap();
            ids.push(id);
        }
        let cover = root.join("cover.png");
        fs::write(&cover, PNG).unwrap();
        lock(&first)
            .unwrap()
            .set_book_cover(&ids[0], &cover, "cover.png")
            .unwrap();
        assert_eq!(upload_books(&first, &[], "Linux").unwrap().uploaded, 2);
        let mut names: Vec<String> = list_cloud_books(&first)
            .unwrap()
            .into_iter()
            .map(|book| book.name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["同名 - 乙.txt", "同名 - 甲.txt"]);
        assert!(server
            .files
            .lock()
            .unwrap()
            .keys()
            .any(|key| key.starts_with("/dav/阅读/备份/Covers/")));

        // Changed information is brought up to date without uploading the file again.
        lock(&first)
            .unwrap()
            .update_book(&crate::models::UpdateBookRequest {
                book_id: ids[1].clone(),
                title: "同名（修订）".into(),
                author: Some("乙".into()),
                intro: None,
            })
            .unwrap();
        let report = upload_books(&first, std::slice::from_ref(&ids[1]), "Linux").unwrap();
        assert_eq!((report.uploaded, report.updated), (0, 1));

        // Another device gets the information and the cover with the file.
        let second = connected(&root.join("second"), &server.url);
        {
            let guard = lock(&second).unwrap();
            let mut settings = guard.stored_webdav().unwrap();
            settings.folder = "阅读/备份".into();
            guard.save_stored_webdav(&settings).unwrap();
        }
        let pulled = download_cloud_book(&second, &root.join("second"), "同名 - 甲.txt").unwrap();
        let id = import(&second, Path::new(&pulled.path));
        let guard = lock(&second).unwrap();
        let book = guard.get_book(&id).unwrap();
        assert_eq!(
            (book.title.as_str(), book.author.as_deref()),
            ("同名", Some("甲"))
        );
        assert_eq!(
            guard.book_intro(&id).unwrap().as_deref(),
            Some("甲写的简介")
        );
        assert!(guard.book_cover_file(&id).unwrap().is_some());
        drop(guard);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restores_skip_ignored_parts_and_bring_covers() {
        let server = test_server::start();
        let root = temp_root();
        let source = root.join("书.txt");
        fs::write(&source, "第一章\n正文一段。\n第二章\n正文二段。".as_bytes()).unwrap();
        let first = connected(&root.join("first"), &server.url);
        let id = import(&first, &source);
        let cover = root.join("cover.png");
        fs::write(&cover, PNG).unwrap();
        {
            let mut guard = lock(&first).unwrap();
            guard.set_book_cover(&id, &cover, "cover.png").unwrap();
            guard.add_reading_time(&id, "2026-10-11", 600).unwrap();
            guard
                .update_book(&crate::models::UpdateBookRequest {
                    book_id: id.clone(),
                    title: "改过的书名".into(),
                    author: None,
                    intro: None,
                })
                .unwrap();
        }
        backup_now(&first, "Linux").unwrap();

        let second = connected(&root.join("second"), &server.url);
        let local = import(&second, &source);
        {
            let guard = lock(&second).unwrap();
            let mut settings = guard.stored_webdav().unwrap();
            settings.restore_ignore = vec![RestoreCategory::ReadingTime];
            guard.save_stored_webdav(&settings).unwrap();
        }
        let name = list_backups(&second).unwrap()[0].name.clone();
        let document = fetch_backup(&second, &name).unwrap();
        fetch_backup_covers(&second, &document).unwrap();
        lock(&second).unwrap().restore_backup(&document).unwrap();
        let guard = lock(&second).unwrap();
        assert_eq!(guard.get_book(&local).unwrap().title, "改过的书名");
        assert!(guard.book_cover_file(&local).unwrap().is_some());
        assert_eq!(guard.reading_stats("2026-10-11").unwrap().today_seconds, 0);
        drop(guard);

        // Ignoring book information keeps this device's title.
        {
            let guard = lock(&second).unwrap();
            guard
                .update_book(&crate::models::UpdateBookRequest {
                    book_id: local.clone(),
                    title: "本机书名".into(),
                    author: None,
                    intro: None,
                })
                .unwrap();
            let mut settings = guard.stored_webdav().unwrap();
            settings.restore_ignore = vec![RestoreCategory::BookInfo];
            guard.save_stored_webdav(&settings).unwrap();
        }
        lock(&second).unwrap().restore_backup(&document).unwrap();
        assert_eq!(
            lock(&second).unwrap().get_book(&local).unwrap().title,
            "本机书名"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn progress_sync_ignores_its_own_uploads_and_asks_once() {
        let server = test_server::start();
        let root = temp_root();
        let source = root.join("进度.txt");
        let text: String = (0..60)
            .map(|index| format!("第{index}段，云海翻涌。\n"))
            .collect();
        fs::write(&source, text.as_bytes()).unwrap();
        let first = connected(&root.join("first"), &server.url);
        let second = connected(&root.join("second"), &server.url);
        let a = import(&first, &source);
        let b = import(&second, &source);
        let save_at = |storage: &Mutex<Storage>, id: &str, needle: &str| {
            let guard = lock(storage).unwrap();
            let window = guard.read_content_window(id, None, 10_000).unwrap();
            let offset = window.text[..window.text.find(needle).unwrap()]
                .encode_utf16()
                .count() as u64;
            let context = guard.content_read_context(id).unwrap();
            let verified = crate::storage::verify_content_context(&context).unwrap();
            let locator = crate::storage::resolve_offset_from_context(
                &crate::models::ResolveOffsetRequest {
                    book_id: id.into(),
                    content_version: window.content_version.clone(),
                    resource_id: window.resource_id.clone(),
                    offset,
                },
                &context,
                &verified,
            )
            .unwrap();
            guard.save_position(&locator).unwrap();
            offset
        };

        save_at(&first, &a, "第10段");
        assert!(crate::progress_sync::upload(&first, &a, "第一章", "A").unwrap());
        // Nothing changed since: no second upload, and its own record is not news.
        assert!(!crate::progress_sync::upload(&first, &a, "第一章", "A").unwrap());
        assert!(crate::progress_sync::fetch(&first, &a).unwrap().is_none());

        // The other device is asked once, at its own copy of the position.
        let expected = save_at(&second, &b, "第2段");
        assert!(expected > 0);
        let prompt = crate::progress_sync::fetch(&second, &b).unwrap().unwrap();
        assert_eq!(prompt.device_name, "A");
        assert!(prompt.excerpt.starts_with("第10段"));
        crate::progress_sync::acknowledge(&second, &b, &prompt.device_id, prompt.revision).unwrap();
        assert!(crate::progress_sync::fetch(&second, &b).unwrap().is_none());

        // A newer position from the first device is asked about again.
        save_at(&first, &a, "第30段");
        crate::progress_sync::upload(&first, &a, "第一章", "A").unwrap();
        let newer = crate::progress_sync::fetch(&second, &b).unwrap().unwrap();
        assert!(newer.revision > prompt.revision);
        // Already being at that position needs no question.
        lock(&second)
            .unwrap()
            .save_position(&newer.locator)
            .unwrap();
        crate::progress_sync::upload(&first, &a, "第一章", "A").unwrap();
        save_at(&first, &a, "第40段");
        crate::progress_sync::upload(&first, &a, "第一章", "A").unwrap();
        let latest = crate::progress_sync::fetch(&second, &b).unwrap().unwrap();
        lock(&second)
            .unwrap()
            .save_position(&latest.locator)
            .unwrap();
        assert!(crate::progress_sync::fetch(&second, &b).unwrap().is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn names_and_stamps() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_791_705_600_000), "20261011-080000");
        assert_eq!(file_name(" 云海/问道: 第一卷? "), "云海_问道_ 第一卷_");
        assert_eq!(file_name("..."), "book");
        assert_eq!(title_of("云海.txt"), "云海");
        assert_eq!(book_file_stem("云海", Some(" 某人 ")), "云海 - 某人");
        assert_eq!(book_file_stem("云海", Some("")), "云海");
        assert!(is_backup_name("auto-20261011-080000.json"));
        assert!(!is_backup_name("../auto-1.json"));
        assert!(!is_backup_name("recovery-1.json"));
        assert_eq!(
            backup_parts("manual-20261011-080000-书房 平板.json"),
            ("20261011-080000".into(), Some("书房 平板".into()))
        );
        assert_eq!(backup_parts("auto-20261011-080000.json").1, None);
    }
}

/// 云书架 while connected to the GripRead server: the books whose files the
/// server keeps stand in for the WebDAV book folder, named by SHA-256.
pub mod server {
    use super::*;
    use crate::sync_client::SyncClient;

    pub fn list(sync: &SyncClient, storage: &Mutex<Storage>) -> Result<Vec<CloudBook>, AppError> {
        let books = sync.server_books()?;
        let guard = lock(storage)?;
        books
            .into_iter()
            .map(|book| {
                let local = guard.local_book_for_source(&book.sha256)?;
                Ok(CloudBook {
                    name: book.sha256.clone(),
                    title: book.title,
                    author: book.author,
                    size: book.size,
                    source_sha256: Some(book.sha256),
                    uploaded_at: Some(book.added_at),
                    local_book_id: local.as_ref().map(|(id, _)| id.clone()),
                    local_removed: local.is_some_and(|(_, removed)| removed),
                })
            })
            .collect()
    }

    /// Sends the books (all local shelf books when empty) the server lacks
    /// in the next sync round.
    pub fn upload(
        sync: &SyncClient,
        storage: &Mutex<Storage>,
        book_ids: &[String],
    ) -> Result<CloudUploadReport, AppError> {
        let on_server: HashSet<String> = sync
            .server_books()?
            .into_iter()
            .map(|book| book.sha256)
            .collect();
        let wanted: Vec<String> = lock(storage)?
            .shelf_book_sources()?
            .into_iter()
            .filter(|(id, _)| book_ids.is_empty() || book_ids.contains(id))
            .map(|(_, sha)| sha)
            .collect();
        let (present, missing): (Vec<String>, Vec<String>) =
            wanted.into_iter().partition(|sha| on_server.contains(sha));
        sync.queue_uploads(&missing);
        Ok(CloudUploadReport {
            uploaded: missing.len() as u32,
            skipped: present.len() as u32,
            ..CloudUploadReport::default()
        })
    }

    /// Downloads a server book for the ordinary import.
    pub fn download(
        sync: &SyncClient,
        data_root: &Path,
        sha256: &str,
    ) -> Result<PickedFile, AppError> {
        let book = sync
            .server_books()?
            .into_iter()
            .find(|book| book.sha256 == sha256)
            .ok_or_else(|| {
                AppError::keyed(ErrorCode::NotFound, "serverNoBook", "服务器上没有这本书")
            })?;
        let directory = data_root
            .join("document-staging")
            .join(format!("server-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory)?;
        let file = format!(
            "{}.{}",
            file_name(&book.title),
            if book.epub { "epub" } else { "txt" }
        );
        let path = directory.join(&file);
        if let Err(error) = sync.download_server_book(sha256, &path) {
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
        Ok(PickedFile {
            path: path.to_string_lossy().into_owned(),
            name: file,
        })
    }
}
