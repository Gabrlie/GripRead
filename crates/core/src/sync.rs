//! Native sync between devices and the GripRead server: the protocol, and
//! the server's side of it over its own library. Records and their merge
//! rules live in `storage/sync.rs`; the server's HTTP routes in
//! `crates/server`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode};
use crate::storage::{LoggedChange, Storage, SyncChange};

/// Records the server returns at most at once.
pub const PULL_LIMIT: u32 = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    /// The device's own id, so it can skip its records when it pulls.
    pub device: String,
    pub changes: Vec<SyncChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PushReply {
    pub head: i64,
    /// Books named by the records whose files the server lacks (SHA-256).
    pub missing_books: Vec<String>,
    /// Covers named by the records the server lacks (`<sha256>.<ext>`).
    pub missing_covers: Vec<String>,
}

/// A book file the server keeps, as 云书架 lists it while connected
/// (`GET /api/cloud/books`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerBook {
    pub sha256: String,
    pub title: String,
    pub author: Option<String>,
    pub size: u64,
    pub added_at: i64,
    pub epub: bool,
}

/// The shelf's local books whose files the library keeps.
pub fn server_books(storage: &Storage) -> Result<Vec<ServerBook>, AppError> {
    let mut books = Vec::new();
    for (book_id, sha256) in storage.shelf_book_sources()? {
        let Ok((path, _, _)) = storage.book_source_file(&book_id) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let book = storage.get_book(&book_id)?;
        books.push(ServerBook {
            sha256,
            title: book.title,
            author: book.author,
            size: metadata.len(),
            added_at: book.created_at,
            epub: crate::epub::is_epub_file(&path),
        });
    }
    Ok(books)
}

/// 订阅 refreshed on the server (`POST /api/rss/refresh`): the feeds
/// named, every feed of the server's when empty.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RssRefreshRequest {
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RssFeedUpdate {
    pub url: String,
    pub added: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RssRefreshReply {
    pub feeds: Vec<RssFeedUpdate>,
}

/// A feed's articles the server fetched since the device's cursor
/// (`GET /api/rss/articles?feed=&since=`), and the cursor to send next.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RssArticlesReply {
    pub articles: Vec<crate::storage::FetchedArticle>,
    pub cursor: i64,
}

/// 更新书架 through the server (`POST /api/jobs/update`): the books by
/// their sync keys, all of the server's updatable books when empty.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShelfUpdateRequest {
    #[serde(default)]
    pub keys: Vec<String>,
}

/// One book's outcome of a server-side 更新书架.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookUpdate {
    pub key: String,
    /// The book's title, to say which one failed.
    #[serde(default)]
    pub title: String,
    pub added: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShelfUpdateReply {
    pub books: Vec<BookUpdate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullReply {
    pub changes: Vec<LoggedChange>,
    pub head: i64,
    /// More records wait after these.
    pub more: bool,
}

fn lock(storage: &Mutex<Storage>) -> Result<std::sync::MutexGuard<'_, Storage>, AppError> {
    storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
}

/// A SHA-256 written as 64 lowercase hex digits.
pub fn valid_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A cover's file name: `<sha256>.<ext>` with a short alphanumeric extension.
pub fn valid_cover_name(name: &str) -> bool {
    name.split_once('.').is_some_and(|(sha, ext)| {
        valid_sha256(sha)
            && (1..=5).contains(&ext.len())
            && ext.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

fn cover_of(change: &SyncChange) -> Option<String> {
    let cover = change.value.as_ref()?.get("cover")?;
    let sha = cover.get("sha256")?.as_str()?;
    let ext = cover.get("ext")?.as_str()?;
    let name = format!("{sha}.{ext}");
    valid_cover_name(&name).then_some(name)
}

/// The server's library takes a device's records: applies them, logs them
/// in order, logs any difference applying made, and names the files it
/// still needs.
pub fn accept_push(storage: &Mutex<Storage>, request: &PushRequest) -> Result<PushReply, AppError> {
    let mut guard = lock(storage)?;
    let mut reply = PushReply::default();
    for change in &request.changes {
        guard.sync_apply(std::slice::from_ref(change))?;
        reply.head = guard.sync_log_append(change, &request.device)?;
        if change.value.is_none() {
            continue;
        }
        if let Some(sha) = change.key.strip_prefix("book:") {
            if guard.book_for_source(sha)?.is_none() {
                reply.missing_books.push(sha.to_string());
            }
            if let Some(cover) = cover_of(change) {
                if cover_file(&guard, &cover)?.is_none() {
                    reply.missing_covers.push(cover);
                }
            }
        }
    }
    if let Some(head) = log_own_changes(&mut guard, "server")? {
        reply.head = head;
    }
    Ok(reply)
}

/// Logs what changed in this library itself (the web version's edits, or
/// what applying records changed); returns the newest number when any.
pub fn log_own_changes(storage: &mut Storage, device: &str) -> Result<Option<i64>, AppError> {
    let mut head = None;
    for change in storage.sync_pending()? {
        head = Some(storage.sync_log_append(&change, device)?);
        storage.sync_mark(&change)?;
    }
    Ok(head)
}

pub fn pull(storage: &Mutex<Storage>, since: i64, limit: u32) -> Result<PullReply, AppError> {
    let limit = limit.clamp(1, PULL_LIMIT);
    let (changes, head) = lock(storage)?.sync_log_since(since, limit)?;
    let more = changes.last().is_some_and(|last| last.seq < head);
    Ok(PullReply {
        changes,
        head,
        more,
    })
}

/// The original file of the book with this hash, when the library has it.
pub fn book_file(storage: &Storage, sha256: &str) -> Result<Option<PathBuf>, AppError> {
    let Some(book_id) = storage.book_for_source(sha256)? else {
        return Ok(None);
    };
    match storage.book_source_file(&book_id) {
        Ok((path, _, _)) => Ok(Some(path)),
        Err(error) if error.code == ErrorCode::AssetMissing => Ok(None),
        Err(error) => Err(error),
    }
}

/// A cover by its file name: in the cover cache, or a shelf book's own.
pub fn cover_file(storage: &Storage, name: &str) -> Result<Option<PathBuf>, AppError> {
    if !valid_cover_name(name) {
        return Ok(None);
    }
    let cached = storage.cover_cache().join(name);
    if cached.is_file() {
        return Ok(Some(cached));
    }
    for (book_id, _) in storage.shelf_sources()? {
        if let Some((path, cover)) = storage.book_cover_file(&book_id)? {
            if cover.file_name() == name {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

fn sha256_file(path: &Path) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Imports a received book file unless the library has it already; the
/// records waiting for it apply. The file must have the hash it was sent as.
pub fn import_book_file(
    storage: &Mutex<Storage>,
    sha256: &str,
    file: &Path,
) -> Result<bool, AppError> {
    if !valid_sha256(sha256) || sha256_file(file)? != sha256 {
        return Err(AppError::keyed(
            ErrorCode::InvalidArgument,
            "bookHash",
            "书籍文件与它的校验值不符",
        ));
    }
    let mut guard = lock(storage)?;
    if guard.book_for_source(sha256)?.is_some() {
        return Ok(false);
    }
    let operation = uuid::Uuid::new_v4().to_string();
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let imported = guard.import_txt(file, &operation, &cancel, |_, _, _| {})?;
    guard.apply_pending_restore(&imported.book.id)?;
    Ok(true)
}

/// The server's import of a received book file, logging what it changed.
pub fn store_book(storage: &Mutex<Storage>, sha256: &str, file: &Path) -> Result<bool, AppError> {
    let imported = import_book_file(storage, sha256, file)?;
    if imported {
        log_own_changes(&mut *lock(storage)?, "server")?;
    }
    Ok(imported)
}

/// Keeps a received cover in the cover cache, checked against its name.
/// Devices send covers before the records that name them, so applying the
/// records finds them there.
pub fn store_cover(storage: &Mutex<Storage>, name: &str, bytes: &[u8]) -> Result<(), AppError> {
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if !valid_cover_name(name) || !name.starts_with(&digest) {
        return Err(AppError::keyed(
            ErrorCode::InvalidArgument,
            "coverHash",
            "封面文件与它的校验值不符",
        ));
    }
    let guard = lock(storage)?;
    let directory = guard.cover_cache();
    fs::create_dir_all(&directory)?;
    let partial = directory.join(format!("{name}.part"));
    fs::write(&partial, bytes)?;
    fs::rename(&partial, directory.join(name))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_checked() {
        let sha = "a".repeat(64);
        assert!(valid_sha256(&sha));
        assert!(!valid_sha256(&"A".repeat(64)));
        assert!(!valid_sha256("../etc"));
        assert!(valid_cover_name(&format!("{sha}.png")));
        assert!(!valid_cover_name(&format!("{sha}.png/../x")));
        assert!(!valid_cover_name("x.png"));
    }
}
