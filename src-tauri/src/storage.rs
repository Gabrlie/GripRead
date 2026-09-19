use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, ErrorCode};
use crate::m1_txt::build_toc;
use crate::models::{
    AssetAvailability, AssetKind, Book, BookAsset, Bookmark, BookmarkRequest, ContentWindow,
    ImportPhase, ImportResult, LibraryBook, LibraryGroup, ReadContentRequest, ReaderLocator,
    ReaderPreferences, ResolveLocatorRequest, SearchMatch, SearchRequest, SearchResponse, TocEntry,
    TxtDecodeState, TxtEncoding, TxtEncodingInfo, WindowDirection,
};
use crate::txt::detect_and_decode;

const CURRENT_SCHEMA_VERSION: i64 = 6;
const MAX_WINDOW_UNITS: u64 = 1_000_000;
const INDEX_SCHEMA_VERSION: u8 = 1;
const INDEX_STRIDE_UNITS: u64 = 4096;
const CONTEXT_BYTES: u64 = 512;
const DUPLICATE_VALIDATION_RETRY: &str = "duplicate import target requires revalidation";

/// A storage handle owns an OS lock for the complete lifetime of the handle.
/// The SQLite connection is accessed by commands through the application's
/// mutex; no storage method depends on Tauri.
#[derive(Debug)]
pub struct Storage {
    root: PathBuf,
    conn: Connection,
    // The field is intentionally retained for its Drop-based lock lifetime.
    #[allow(dead_code)]
    data_lock: File,
    /// A process-local cache of indexes that have been checked against the
    /// complete asset bytes. A persisted index is never trusted until this
    /// cache has been populated for the current file fingerprint.
    verified_indexes: Mutex<HashMap<String, VerifiedContentIndex>>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedImport {
    operation_id: String,
    source: PathBuf,
    stage_relative_path: String,
    raw_stage_relative_path: String,
    pub(crate) sha256: String,
    pub(crate) source_sha256: String,
    byte_length: u64,
    index_json: String,
    source_byte_length: u64,
    detected_encoding: TxtEncoding,
    selected_encoding: TxtEncoding,
    decode_state: TxtDecodeState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TxtDecodeSnapshot {
    pub(crate) book_id: String,
    pub(crate) asset_id: String,
    pub(crate) relative_path: String,
    pub(crate) source_relative_path: String,
    pub(crate) source_sha256: String,
    pub(crate) content_version: String,
    pub(crate) selected_encoding: TxtEncoding,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedTxtDecode {
    pub(crate) operation_id: String,
    pub(crate) snapshot: TxtDecodeSnapshot,
    pub(crate) stage_relative_path: String,
    pub(crate) backup_relative_path: String,
    pub(crate) content_version: String,
    pub(crate) byte_length: u64,
    pub(crate) index_json: String,
    pub(crate) source_sha256: String,
    pub(crate) detected_encoding: TxtEncoding,
    pub(crate) selected_encoding: TxtEncoding,
    pub(crate) decode_state: TxtDecodeState,
}

#[derive(Debug, Clone)]
pub(crate) struct TxtReassociationSnapshot {
    pub(crate) asset_id: String,
    pub(crate) source_relative_path: String,
    pub(crate) content_version: String,
    pub(crate) selected_encoding: TxtEncoding,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedTxtReassociation {
    pub(crate) snapshot: TxtReassociationSnapshot,
    pub(crate) stage_relative_path: String,
    pub(crate) source_sha256: String,
}

#[derive(Debug, Clone)]
struct AssetRecord {
    asset: BookAsset,
    relative_path: String,
}

/// A short database/filesystem snapshot used to validate a duplicate import
/// outside the application's storage mutex. The fingerprint is metadata only;
/// `validate_import_target` hashes the file while no SQLite lock is held.
#[derive(Debug, Clone)]
pub(crate) struct ImportTargetSnapshot {
    relative_path: String,
    sha256: String,
    fingerprint: Option<String>,
    source_sha256: Option<String>,
    selected_encoding: Option<TxtEncoding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SparseIndex {
    schema_version: u8,
    stride_units: u64,
    byte_length: u64,
    utf16_length: u64,
    entries: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct IndexEntry {
    utf16_offset: u64,
    byte_offset: u64,
}

#[derive(Debug, Clone)]
struct JournalRecord {
    operation_id: String,
    book_id: String,
    asset_id: String,
    title: String,
    sha256: String,
    byte_length: u64,
    content_version: String,
    relative_path: String,
    stage_path: String,
    raw_stage_path: String,
    source_relative_path: String,
    source_sha256: String,
    detected_encoding: TxtEncoding,
    selected_encoding: TxtEncoding,
    decode_state: TxtDecodeState,
    index_json: String,
    source_byte_length: u64,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct TxtDecodeJournal {
    operation_id: String,
    book_id: String,
    asset_id: String,
    old_content_version: String,
    relative_path: String,
    stage_path: String,
    backup_path: String,
    new_content_version: String,
    byte_length: u64,
    index_json: String,
    source_sha256: String,
    detected_encoding: TxtEncoding,
    selected_encoding: TxtEncoding,
    decode_state: TxtDecodeState,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct PersistedIndex {
    index: SparseIndex,
    fingerprint: String,
}

/// The database portion of a content request. Commands keep the application
/// mutex only while constructing this snapshot, then verify and read files
/// without holding it.
#[derive(Debug, Clone)]
pub(crate) struct ContentReadContext {
    root: PathBuf,
    record: AssetRecord,
    persisted: Option<PersistedIndex>,
    verified: Option<VerifiedContentIndex>,
}

#[derive(Debug, Clone)]
pub(crate) struct VerifiedContentIndex {
    index: SparseIndex,
    fingerprint: String,
}

#[derive(Debug, Clone, Copy)]
enum BoundaryMode {
    Exact,
    Floor,
    Ceiling,
}

#[derive(Debug, Clone, Copy)]
struct Boundary {
    utf16_offset: u64,
    byte_offset: u64,
}

struct SearchParameters<'a> {
    book_id: &'a str,
    content_version: &'a str,
    query: &'a str,
    case_sensitive: bool,
    cursor: u64,
    limit: u32,
}

impl Storage {
    pub fn open(root: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(root)?;
        fs::create_dir_all(root.join("books"))?;
        fs::create_dir_all(root.join("sources"))?;
        fs::create_dir_all(root.join("staging"))?;

        let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let lock_path = root.join(".data.lock");
        let data_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        data_lock.try_lock_exclusive().map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                AppError::new(
                    ErrorCode::Database,
                    "the GripRead data directory is already in use",
                )
            } else {
                AppError::new(
                    ErrorCode::Io,
                    format!("unable to lock data directory: {error}"),
                )
            }
        })?;

        let conn = Connection::open(root.join("gripread.sqlite3"))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;

        let mut storage = Self {
            root,
            conn,
            data_lock,
            verified_indexes: Mutex::new(HashMap::new()),
        };
        storage.apply_migrations()?;
        storage.recover_pending_imports()?;
        storage.recover_pending_txt_decodes()?;
        storage.remove_orphan_managed_files()?;
        storage.cleanup_staging_dir();
        Ok(storage)
    }

    pub fn root_path(&self) -> &Path {
        &self.root
    }

    fn apply_migrations(&mut self) -> Result<(), AppError> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY NOT NULL,
                applied_at INTEGER NOT NULL
            );",
        )?;

        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if current > CURRENT_SCHEMA_VERSION {
            return Err(AppError::new(
                ErrorCode::Database,
                format!("unsupported future storage schema version {current}"),
            ));
        }

        if current < 1 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE books (
                    id TEXT PRIMARY KEY NOT NULL,
                    title TEXT NOT NULL,
                    author TEXT,
                    content_version TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE book_assets (
                    id TEXT PRIMARY KEY NOT NULL,
                    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    sha256 TEXT NOT NULL UNIQUE,
                    byte_length INTEGER NOT NULL,
                    content_version TEXT NOT NULL,
                    relative_path TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL
                );

                CREATE INDEX book_assets_book_id_idx ON book_assets(book_id);

                CREATE TABLE reading_positions (
                    book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    locator_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![1_i64, now_millis()],
            )?;
            tx.commit()?;
        }

        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if current < 2 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS import_journal (
                    operation_id TEXT PRIMARY KEY NOT NULL,
                    book_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    byte_length INTEGER NOT NULL,
                    content_version TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    stage_path TEXT NOT NULL,
                    index_json TEXT NOT NULL,
                    source_byte_length INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS import_journal_created_at_idx
                    ON import_journal(created_at);

                CREATE TABLE IF NOT EXISTS content_indexes (
                    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES book_assets(id) ON DELETE CASCADE,
                    schema_version INTEGER NOT NULL,
                    stride_units INTEGER NOT NULL,
                    byte_length INTEGER NOT NULL,
                    utf16_length INTEGER NOT NULL,
                    fingerprint TEXT NOT NULL,
                    index_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS reader_preferences (
                    id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
                    preferences_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![2_i64, now_millis()],
            )?;
            tx.commit()?;
        }

        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if current < 3 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "ALTER TABLE import_journal ADD COLUMN raw_stage_path TEXT NOT NULL DEFAULT '';
                ALTER TABLE import_journal ADD COLUMN source_relative_path TEXT NOT NULL DEFAULT '';
                ALTER TABLE import_journal ADD COLUMN source_sha256 TEXT NOT NULL DEFAULT '';
                ALTER TABLE import_journal ADD COLUMN detected_encoding TEXT NOT NULL DEFAULT 'utf8';
                ALTER TABLE import_journal ADD COLUMN selected_encoding TEXT NOT NULL DEFAULT 'utf8';
                ALTER TABLE import_journal ADD COLUMN decode_state TEXT NOT NULL DEFAULT 'clean';

                CREATE TABLE IF NOT EXISTS txt_assets (
                    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES book_assets(id) ON DELETE CASCADE,
                    detected_encoding TEXT NOT NULL,
                    selected_encoding TEXT NOT NULL,
                    decode_state TEXT NOT NULL,
                    source_relative_path TEXT,
                    source_sha256 TEXT,
                    toc_json TEXT,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS bookmarks (
                    id TEXT PRIMARY KEY NOT NULL,
                    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    content_version TEXT NOT NULL,
                    offset INTEGER NOT NULL,
                    locator_json TEXT NOT NULL,
                    excerpt TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(book_id, content_version, offset)
                );
                CREATE INDEX IF NOT EXISTS bookmarks_book_idx ON bookmarks(book_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS toc_cache (
                    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES book_assets(id) ON DELETE CASCADE,
                    content_version TEXT NOT NULL,
                    entries_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![3_i64, now_millis()],
            )?;
            tx.commit()?;
        }

        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if current < 4 {
            // `sha256` is the current normalized content version, so a manual
            // re-decode may legitimately produce a value already used by a
            // different asset. Keep normalized hashes for diagnostics while
            // moving import de-duplication to the nullable `dedup_hash` key.
            // Rebuild the three dependent tables together so their foreign
            // keys continue to point at the replacement parent table.
            self.conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
            let migration = (|| -> Result<(), AppError> {
                let tx = self.conn.transaction()?;
                tx.execute_batch(
                    "CREATE TABLE book_assets_rebuild (
                        id TEXT PRIMARY KEY NOT NULL,
                        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                        kind TEXT NOT NULL,
                        sha256 TEXT NOT NULL,
                        dedup_hash TEXT,
                        byte_length INTEGER NOT NULL,
                        content_version TEXT NOT NULL,
                        relative_path TEXT NOT NULL UNIQUE,
                        created_at INTEGER NOT NULL
                    );
                    INSERT INTO book_assets_rebuild(
                        id, book_id, kind, sha256, dedup_hash, byte_length,
                        content_version, relative_path, created_at
                    )
                    SELECT id, book_id, kind, sha256, sha256, byte_length,
                           content_version, relative_path, created_at
                    FROM book_assets;

                    CREATE TABLE content_indexes_rebuild (
                        asset_id TEXT PRIMARY KEY NOT NULL REFERENCES book_assets(id) ON DELETE CASCADE,
                        schema_version INTEGER NOT NULL,
                        stride_units INTEGER NOT NULL,
                        byte_length INTEGER NOT NULL,
                        utf16_length INTEGER NOT NULL,
                        fingerprint TEXT NOT NULL,
                        index_json TEXT NOT NULL,
                        updated_at INTEGER NOT NULL
                    );
                    INSERT INTO content_indexes_rebuild
                    SELECT asset_id, schema_version, stride_units, byte_length,
                           utf16_length, fingerprint, index_json, updated_at
                    FROM content_indexes;

                    CREATE TABLE txt_assets_rebuild (
                        asset_id TEXT PRIMARY KEY NOT NULL REFERENCES book_assets(id) ON DELETE CASCADE,
                        detected_encoding TEXT NOT NULL,
                        selected_encoding TEXT NOT NULL,
                        decode_state TEXT NOT NULL,
                        source_relative_path TEXT,
                        source_sha256 TEXT,
                        toc_json TEXT,
                        updated_at INTEGER NOT NULL
                    );
                    INSERT INTO txt_assets_rebuild
                    SELECT asset_id, detected_encoding, selected_encoding,
                           decode_state, source_relative_path, source_sha256,
                           toc_json, updated_at
                    FROM txt_assets;

                    DROP TABLE content_indexes;
                    DROP TABLE txt_assets;
                    DROP TABLE book_assets;
                    ALTER TABLE book_assets_rebuild RENAME TO book_assets;
                    ALTER TABLE content_indexes_rebuild RENAME TO content_indexes;
                    ALTER TABLE txt_assets_rebuild RENAME TO txt_assets;
                    CREATE INDEX book_assets_book_id_idx ON book_assets(book_id);
                    CREATE UNIQUE INDEX book_assets_dedup_hash_idx
                        ON book_assets(dedup_hash) WHERE dedup_hash IS NOT NULL;
                    CREATE INDEX IF NOT EXISTS bookmarks_book_idx
                        ON bookmarks(book_id, created_at DESC);
                    CREATE INDEX IF NOT EXISTS content_indexes_asset_idx
                        ON content_indexes(asset_id);
                    CREATE INDEX IF NOT EXISTS txt_assets_asset_idx
                        ON txt_assets(asset_id);
                ")?;
                tx.execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                    params![4_i64, now_millis()],
                )?;
                tx.commit()?;
                Ok(())
            })();
            self.conn.execute_batch("PRAGMA foreign_keys = ON;")?;
            migration?;
        }

        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if current < 5 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS txt_decode_journal (
                    operation_id TEXT PRIMARY KEY NOT NULL,
                    book_id TEXT NOT NULL,
                    asset_id TEXT NOT NULL,
                    old_content_version TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    stage_path TEXT NOT NULL,
                    backup_path TEXT NOT NULL,
                    new_content_version TEXT NOT NULL,
                    byte_length INTEGER NOT NULL,
                    index_json TEXT NOT NULL,
                    source_sha256 TEXT NOT NULL,
                    detected_encoding TEXT NOT NULL,
                    selected_encoding TEXT NOT NULL,
                    decode_state TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS txt_decode_journal_created_at_idx
                    ON txt_decode_journal(created_at);",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![5_i64, now_millis()],
            )?;
            tx.commit()?;
        }

        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if current < 6 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE library_groups (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL UNIQUE CHECK(length(trim(name)) > 0)
                );
                CREATE TABLE book_groups (
                    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    group_id TEXT NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
                    PRIMARY KEY(book_id, group_id)
                );
                CREATE INDEX book_groups_group_idx ON book_groups(group_id);",
            )?;
            // Editable template groups are seeded only by this migration.
            // Membership always comes from an explicit user selection.
            for name in [
                "玄幻修真",
                "科幻未来",
                "悬疑灵异",
                "历史架空",
                "都市生活",
                "游戏竞技",
                "完结归档",
            ] {
                tx.execute(
                    "INSERT INTO library_groups(id, name) VALUES (?1, ?2)",
                    params![Uuid::new_v4().to_string(), name],
                )?;
            }
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (6, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        Ok(())
    }

    /// Prepare all blocking import work without borrowing the SQLite handle.
    /// The stage file is owned by the operation ID and remains recoverable if
    /// the process exits before the journal transaction is registered.
    pub(crate) fn prepare_import<F>(
        root: &Path,
        source: &Path,
        operation_id: &str,
        cancel: &AtomicBool,
        mut report: F,
    ) -> Result<PreparedImport, AppError>
    where
        F: FnMut(ImportPhase, u64, u64),
    {
        let metadata = fs::metadata(source).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::new(
                    ErrorCode::FileNotFound,
                    "the selected TXT file was not found",
                )
            } else {
                AppError::new(ErrorCode::InvalidPath, error.to_string())
            }
        })?;
        if !metadata.is_file() {
            return Err(AppError::new(
                ErrorCode::InvalidPath,
                "the selected import path is not a file",
            ));
        }

        let total_bytes = metadata.len();
        let source_fingerprint = fingerprint_for_metadata(&metadata);
        report(ImportPhase::Reading, 0, total_bytes);
        let mut file = File::open(source)?;
        let mut input = Vec::with_capacity(total_bytes.min(8 * 1024 * 1024) as usize);
        let mut chunk = [0_u8; 64 * 1024];
        let mut bytes_read = 0_u64;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(import_cancelled());
            }
            let read = file.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            input.extend_from_slice(&chunk[..read]);
            bytes_read += read as u64;
            report(ImportPhase::Reading, bytes_read, total_bytes);
        }

        if cancel.load(Ordering::Acquire) {
            return Err(import_cancelled());
        }

        let final_metadata = fs::metadata(source).map_err(|error| {
            AppError::new(
                ErrorCode::ContentVersionMismatch,
                format!("selected TXT changed while reading: {error}"),
            )
        })?;
        if bytes_read != total_bytes
            || final_metadata.len() != total_bytes
            || fingerprint_for_metadata(&final_metadata) != source_fingerprint
        {
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "selected TXT changed while reading",
            ));
        }

        report(ImportPhase::Normalizing, bytes_read, total_bytes);
        let decoded = detect_and_decode(&input, TxtEncoding::Auto)?;
        let normalized = decoded.text;
        if cancel.load(Ordering::Acquire) {
            return Err(import_cancelled());
        }

        let normalized_bytes = normalized.as_bytes();
        let hash = Sha256::digest(normalized_bytes);
        let sha256 = format!("{hash:x}");
        let source_hash = Sha256::digest(&input);
        let source_sha256 = format!("{source_hash:x}");
        let sparse_index = build_sparse_index(&normalized);
        if cancel.load(Ordering::Acquire) {
            return Err(import_cancelled());
        }
        let index_json = serde_json::to_string(&sparse_index)?;
        let stage_relative_path = format!("staging/{operation_id}.part");
        let raw_stage_relative_path = format!("staging/{operation_id}.raw");
        let stage_path = managed_path(root, &stage_relative_path, "staging")?;
        let raw_stage_path = managed_path(root, &raw_stage_relative_path, "staging")?;
        let result = (|| -> Result<PreparedImport, AppError> {
            let mut stage = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&stage_path)?;
            stage.write_all(normalized_bytes)?;
            stage.sync_all()?;
            drop(stage);
            let mut raw_stage = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&raw_stage_path)?;
            raw_stage.write_all(&input)?;
            raw_stage.sync_all()?;
            drop(raw_stage);
            if cancel.load(Ordering::Acquire) {
                return Err(import_cancelled());
            }
            report(ImportPhase::Persisting, total_bytes, total_bytes);
            Ok(PreparedImport {
                operation_id: operation_id.to_string(),
                source: source.to_path_buf(),
                stage_relative_path,
                raw_stage_relative_path,
                sha256,
                source_sha256,
                byte_length: normalized_bytes.len() as u64,
                index_json,
                source_byte_length: total_bytes,
                detected_encoding: decoded.detected,
                selected_encoding: decoded.selected,
                decode_state: decoded.state,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(stage_path);
            let _ = fs::remove_file(raw_stage_path);
        }
        result
    }

    /// Commit a prepared import. The journal row is durable before the final
    /// rename. Once the rename begins cancellation is intentionally ignored so
    /// the operation cannot report cancellation while leaving a half-published
    /// asset in the current process.
    pub(crate) fn commit_import<F>(
        &mut self,
        prepared: PreparedImport,
        cancel: &AtomicBool,
        mut report: F,
        validated_existing: Option<&ImportTargetSnapshot>,
    ) -> Result<ImportResult, AppError>
    where
        F: FnMut(ImportPhase, u64, u64),
    {
        let stage_path = managed_path(&self.root, &prepared.stage_relative_path, "staging")?;
        let raw_stage_path =
            managed_path(&self.root, &prepared.raw_stage_relative_path, "staging")?;
        if !stage_path.is_file() {
            let _ = remove_owned_file(&raw_stage_path);
            return Err(AppError::new(
                ErrorCode::AssetMissing,
                "prepared import staging file is missing",
            ));
        }
        if cancel.load(Ordering::Acquire) {
            let _ = fs::remove_file(stage_path);
            let _ = fs::remove_file(raw_stage_path);
            return Err(import_cancelled());
        }

        let existing = self.find_import_target(&prepared.sha256, &prepared.source_sha256)?;

        let (book_id, asset_id, relative_path, title, duplicate, needs_publish, created_at) =
            if let Some(existing) = existing {
                if existing.asset.sha256 != prepared.sha256 {
                    return Err(AppError::new(
                        ErrorCode::ContentVersionMismatch,
                        DUPLICATE_VALIDATION_RETRY,
                    ));
                }
                let final_path = managed_path(&self.root, &existing.relative_path, "books")?;
                let needs_publish = !final_path.is_file();
                (
                    existing.asset.book_id.clone(),
                    existing.asset.id.clone(),
                    existing.relative_path,
                    self.get_book(&existing.asset.book_id)?.title,
                    true,
                    needs_publish,
                    existing.asset.created_at,
                )
            } else {
                let book_id = Uuid::new_v4().to_string();
                let asset_id = Uuid::new_v4().to_string();
                (
                    book_id.clone(),
                    asset_id.clone(),
                    format!("books/{book_id}/{asset_id}.txt"),
                    title_from_path(&prepared.source),
                    false,
                    true,
                    now_millis(),
                )
            };

        let content_version = prepared.sha256.clone();
        let source_byte_length = prepared.source_byte_length;
        // A duplicate may be restoring missing source bytes. Give that
        // publication its own path so rollback never needs to infer ownership
        // of an older, committed source from hashes or missing stage files.
        let source_relative_path = if duplicate {
            format!("sources/{asset_id}-{}.txt", prepared.operation_id)
        } else {
            format!("sources/{asset_id}.txt")
        };
        let mut journal = JournalRecord {
            operation_id: prepared.operation_id.clone(),
            book_id: book_id.clone(),
            asset_id: asset_id.clone(),
            title,
            sha256: prepared.sha256.clone(),
            byte_length: prepared.byte_length,
            content_version: content_version.clone(),
            relative_path: relative_path.clone(),
            stage_path: prepared.stage_relative_path.clone(),
            raw_stage_path: prepared.raw_stage_relative_path.clone(),
            source_relative_path: source_relative_path.clone(),
            source_sha256: prepared.source_sha256.clone(),
            detected_encoding: prepared.detected_encoding.clone(),
            selected_encoding: prepared.selected_encoding.clone(),
            decode_state: prepared.decode_state.clone(),
            index_json: prepared.index_json.clone(),
            source_byte_length,
            created_at,
        };
        let existing_source: Option<(Option<String>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT source_relative_path, source_sha256 FROM txt_assets WHERE asset_id = ?1",
                params![asset_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let keep_existing_source = existing_source.as_ref().is_some_and(|(path, hash)| {
            path.as_deref()
                .and_then(|value| managed_path(&self.root, value, "sources").ok())
                .is_some_and(|path| {
                    path.is_file() && hash.as_deref().is_some_and(|h| !h.is_empty())
                })
        });
        if keep_existing_source {
            // This operation does not own the retained source; recovery may
            // only remove or publish files actually owned by its journal.
            journal.source_relative_path.clear();
        }

        if needs_publish {
            let tx = self.conn.transaction()?;
            insert_journal(&tx, &journal)?;
            tx.commit()?;
            maybe_inject_failure(&self.root, cancel, FailurePoint::AfterJournal)?;
            if cancel.load(Ordering::Acquire) {
                return Err(import_cancelled());
            }

            let final_path = managed_path(&self.root, &relative_path, "books")?;
            let raw_stage_path = managed_path(&self.root, &journal.raw_stage_path, "staging")?;
            let source_path = managed_path(&self.root, &source_relative_path, "sources")?;
            if let Some(parent) = final_path.parent() {
                fs::create_dir_all(parent)?;
            }
            if final_path.exists() {
                fs::remove_file(&final_path)?;
            }
            fs::rename(&stage_path, &final_path)?;
            sync_parent(&final_path)?;
            if keep_existing_source {
                remove_owned_file(&raw_stage_path)?;
            } else if raw_stage_path.is_file() {
                if source_path.exists() {
                    remove_owned_file(&source_path)?;
                }
                if let Some(parent) = source_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(&raw_stage_path, &source_path)?;
                sync_parent(&source_path)?;
            }
            maybe_inject_failure(&self.root, cancel, FailurePoint::AfterRename)?;

            let tx = self.conn.transaction()?;
            if !duplicate {
                tx.execute(
                    "INSERT INTO books(id, title, author, content_version, created_at, updated_at)
                     VALUES (?1, ?2, NULL, ?3, ?4, ?5)",
                    params![
                        journal.book_id,
                        journal.title,
                        journal.content_version,
                        journal.created_at,
                        journal.created_at
                    ],
                )?;
                tx.execute(
                    "INSERT INTO book_assets(
                        id, book_id, kind, sha256, dedup_hash, byte_length,
                        content_version, relative_path, created_at
                     ) VALUES (?1, ?2, 'txt', ?3, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        journal.asset_id,
                        journal.book_id,
                        journal.sha256,
                        journal.byte_length as i64,
                        journal.content_version,
                        journal.relative_path,
                        journal.created_at
                    ],
                )?;
            }
            let fingerprint = file_fingerprint(&final_path)?.1;
            insert_content_index(
                &tx,
                &journal.asset_id,
                &parse_index(&journal.index_json)?,
                &fingerprint,
            )?;
            if !keep_existing_source {
                tx.execute(
                    "INSERT INTO txt_assets(
                    asset_id, detected_encoding, selected_encoding, decode_state,
                    source_relative_path, source_sha256, toc_json, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)
                 ON CONFLICT(asset_id) DO UPDATE SET
                    detected_encoding = excluded.detected_encoding,
                    selected_encoding = excluded.selected_encoding,
                    decode_state = excluded.decode_state,
                    source_relative_path = excluded.source_relative_path,
                    source_sha256 = excluded.source_sha256,
                    updated_at = excluded.updated_at",
                    params![
                        journal.asset_id,
                        encoding_name(&journal.detected_encoding),
                        encoding_name(&journal.selected_encoding),
                        decode_state_name(&journal.decode_state),
                        journal.source_relative_path,
                        journal.source_sha256,
                        now_millis(),
                    ],
                )?;
            }
            // Keep the journal until the same transaction that publishes the
            // book, asset, and index commits. If the final commit fails, the
            // journal still names the newly renamed file so the in-process
            // cleanup and next-start recovery can remove it immediately.
            tx.execute(
                "DELETE FROM import_journal WHERE operation_id = ?1",
                params![journal.operation_id],
            )?;
            tx.commit()?;

            report(
                ImportPhase::Completed,
                source_byte_length,
                source_byte_length,
            );
            let asset = BookAsset {
                id: asset_id,
                book_id: book_id.clone(),
                kind: AssetKind::Txt,
                sha256: prepared.sha256,
                byte_length: prepared.byte_length,
                content_version,
                availability: AssetAvailability::Ready,
                created_at,
            };
            let book = self.get_book(&book_id)?;
            Ok(ImportResult {
                book,
                asset,
                duplicate,
                source_byte_length,
            })
        } else {
            // A duplicate whose managed path is already present has no file
            // publication to recover. The command path validates the existing
            // bytes before taking the storage mutex. If another import won the
            // race after that preflight, its committed content index gives us
            // a cheap metadata check; a missing or stale index asks the caller
            // to repeat validation outside the storage mutex.
            let final_path = managed_path(&self.root, &relative_path, "books")?;
            let (_, current_fingerprint) = file_fingerprint(&final_path)?;
            let preflight_matches = validated_existing.is_some_and(|snapshot| {
                snapshot.relative_path == relative_path
                    && snapshot.fingerprint.as_deref() == Some(current_fingerprint.as_str())
            });
            if validated_existing.is_some() && !preflight_matches {
                return Err(content_changed_error(
                    &asset_id,
                    "while validating a duplicate import",
                ));
            }
            if validated_existing.is_none() {
                let persisted_fingerprint: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT fingerprint FROM content_indexes WHERE asset_id = ?1",
                        params![asset_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if persisted_fingerprint.as_deref() != Some(current_fingerprint.as_str()) {
                    return Err(AppError::new(
                        ErrorCode::ContentVersionMismatch,
                        DUPLICATE_VALIDATION_RETRY,
                    ));
                }
            }
            if cancel.load(Ordering::Acquire) {
                return Err(import_cancelled());
            }
            // Source restoration is publication as well. Its journal lets a
            // failed metadata commit discard unassociated raw bytes safely.
            let tx = self.conn.transaction()?;
            insert_journal(&tx, &journal)?;
            tx.commit()?;
            fs::remove_file(stage_path)?;
            let source_path = managed_path(&self.root, &source_relative_path, "sources")?;
            if keep_existing_source {
                // A normalized duplicate must keep the original raw source
                // and selected encoding. Replacing it with another byte
                // representation would make the stored source hash stale and
                // silently change the book's future decode choices.
                remove_owned_file(&raw_stage_path)?;
            } else if raw_stage_path.is_file() {
                if source_path.exists() {
                    remove_owned_file(&source_path)?;
                }
                if let Some(parent) = source_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(&raw_stage_path, &source_path)?;
                sync_parent(&source_path)?;
            }
            let fingerprint = file_fingerprint(&final_path)?.1;
            let tx = self.conn.transaction()?;
            if !keep_existing_source {
                insert_content_index(
                    &tx,
                    &asset_id,
                    &parse_index(&prepared.index_json)?,
                    &fingerprint,
                )?;
            }
            if keep_existing_source {
                // Preserve the existing selected encoding and source
                // association for a normalized duplicate.
                tx.execute(
                    "UPDATE txt_assets SET updated_at = ?1 WHERE asset_id = ?2",
                    params![now_millis(), asset_id],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO txt_assets(
                        asset_id, detected_encoding, selected_encoding, decode_state,
                        source_relative_path, source_sha256, toc_json, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)
                     ON CONFLICT(asset_id) DO UPDATE SET
                        detected_encoding = excluded.detected_encoding,
                        selected_encoding = excluded.selected_encoding,
                        decode_state = excluded.decode_state,
                        source_relative_path = excluded.source_relative_path,
                        source_sha256 = excluded.source_sha256,
                        updated_at = excluded.updated_at",
                    params![
                        asset_id,
                        encoding_name(&prepared.detected_encoding),
                        encoding_name(&prepared.selected_encoding),
                        decode_state_name(&prepared.decode_state),
                        source_relative_path,
                        prepared.source_sha256,
                        now_millis(),
                    ],
                )?;
            }
            tx.execute(
                "DELETE FROM import_journal WHERE operation_id = ?1",
                params![prepared.operation_id],
            )?;
            tx.commit()?;
            let existing = self
                .conn
                .query_row(
                    "SELECT id, book_id, kind, sha256, byte_length, content_version, relative_path, created_at
                     FROM book_assets WHERE id = ?1",
                    params![asset_id],
                    asset_from_row,
                )?;
            report(
                ImportPhase::Completed,
                source_byte_length,
                source_byte_length,
            );
            Ok(ImportResult {
                book: self.get_book(&existing.asset.book_id)?,
                asset: BookAsset {
                    availability: AssetAvailability::Ready,
                    ..existing.asset
                },
                duplicate: true,
                source_byte_length,
            })
        }
    }

    /// Compatibility helper for storage-level callers. IPC commands use the
    /// two-phase methods above so normalization and indexing do not hold the
    /// application storage mutex.
    pub fn import_txt<F>(
        &mut self,
        source: &Path,
        operation_id: &str,
        cancel: &AtomicBool,
        report: F,
    ) -> Result<ImportResult, AppError>
    where
        F: FnMut(ImportPhase, u64, u64),
    {
        let mut prepared = Self::prepare_import(&self.root, source, operation_id, cancel, report)?;
        let result = (|| -> Result<ImportResult, AppError> {
            for attempt in 0..=1 {
                let target =
                    self.snapshot_import_target(&prepared.sha256, &prepared.source_sha256)?;
                if let Some(target) = target.as_ref() {
                    prepare_import_for_target(&self.root, &mut prepared, target, cancel)?;
                }
                let validated_target = target
                    .as_ref()
                    .map(|target| validate_import_target(&self.root, target, cancel))
                    .transpose()?;
                before_import_commit(&self.root, cancel)?;
                match self.commit_import(
                    prepared.clone(),
                    cancel,
                    |_, _, _| {},
                    validated_target.as_ref(),
                ) {
                    Err(error) if attempt == 0 && duplicate_validation_retry(&error) => {
                        continue;
                    }
                    result => return result,
                }
            }
            unreachable!("duplicate validation retry loop always returns")
        })();
        if result.is_err() && !self.journal_exists(operation_id)? {
            self.cleanup_import(operation_id)?;
        }
        result
    }

    /// Remove the exact files and journal row owned by a failed in-process
    /// operation. This is intentionally separate from startup recovery: a
    /// killed process never reaches this method, so its durable journal is
    /// available for the next open to reconcile.
    pub(crate) fn cleanup_import(&mut self, operation_id: &str) -> Result<(), AppError> {
        let journal = self
            .conn
            .query_row(
                "SELECT operation_id, book_id, asset_id, title, sha256, byte_length,
                        content_version, relative_path, stage_path, index_json,
                        source_byte_length, created_at, raw_stage_path,
                        source_relative_path, source_sha256, detected_encoding,
                        selected_encoding, decode_state
                 FROM import_journal WHERE operation_id = ?1",
                params![operation_id],
                journal_from_row,
            )
            .optional()?;
        if let Some(journal) = journal {
            let stage = managed_path(&self.root, &journal.stage_path, "staging")?;
            let raw_stage = (!journal.raw_stage_path.is_empty())
                .then(|| managed_path(&self.root, &journal.raw_stage_path, "staging"))
                .transpose()?;
            let final_path = managed_path(&self.root, &journal.relative_path, "books")?;
            let source_path = (!journal.source_relative_path.is_empty())
                .then(|| managed_path(&self.root, &journal.source_relative_path, "sources"))
                .transpose()?;
            let committed: Option<(String, String)> = self
                .conn
                .query_row(
                    "SELECT relative_path, sha256 FROM book_assets WHERE id = ?1",
                    params![journal.asset_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            remove_owned_file(&stage)?;
            self.cleanup_uncommitted_import_source(&journal)?;
            if let Some(raw_stage) = raw_stage.as_ref() {
                remove_owned_file(raw_stage)?;
            }
            // A duplicate operation can have a journal while its asset row is
            // already committed. Its final path belongs to that asset and
            // must survive an ordinary query/commit failure.
            if committed.as_ref().map_or(true, |(path, hash)| {
                path != &journal.relative_path || hash != &journal.sha256
            }) {
                let references: i64 = self.conn.query_row(
                    "SELECT COUNT(*) FROM book_assets WHERE relative_path = ?1",
                    params![journal.relative_path],
                    |row| row.get(0),
                )?;
                if references == 0 {
                    remove_owned_file(&final_path)?;
                    if let Some(source_path) = source_path.as_ref() {
                        remove_owned_file(source_path)?;
                    }
                }
            }
            self.conn.execute(
                "DELETE FROM import_journal WHERE operation_id = ?1",
                params![operation_id],
            )?;
        } else {
            let stage = self
                .root
                .join("staging")
                .join(format!("{operation_id}.part"));
            let raw_stage = self
                .root
                .join("staging")
                .join(format!("{operation_id}.raw"));
            remove_owned_file(&stage)?;
            remove_owned_file(&raw_stage)?;
        }
        Ok(())
    }

    /// Snapshot the managed target for a duplicate import. Only the database
    /// lookup and one metadata fingerprint happen while the caller holds the
    /// application mutex; byte hashing is performed by
    /// `validate_import_target` after the mutex is released.
    pub(crate) fn snapshot_import_target(
        &self,
        sha256: &str,
        source_sha256: &str,
    ) -> Result<Option<ImportTargetSnapshot>, AppError> {
        let target: Option<(String, String, Option<String>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT a.relative_path, a.sha256, t.source_sha256, t.selected_encoding
                 FROM book_assets a
                 LEFT JOIN txt_assets t ON t.asset_id = a.id
                 WHERE a.sha256 = ?1 OR t.source_sha256 = ?2
                 ORDER BY CASE WHEN t.source_sha256 = ?2 THEN 0 ELSE 1 END,
                          a.created_at ASC
                 LIMIT 1",
                params![sha256, source_sha256],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((relative_path, target_sha256, source_sha256, selected_encoding)) = target else {
            return Ok(None);
        };
        let path = managed_path(&self.root, &relative_path, "books")?;
        let fingerprint = match file_fingerprint(&path) {
            Ok((_, fingerprint)) => Some(fingerprint),
            Err(error) if error.code == ErrorCode::AssetMissing => None,
            Err(error) => return Err(error),
        };
        Ok(Some(ImportTargetSnapshot {
            relative_path,
            // The target may have been found by source bytes after a manual
            // re-decode, so validation must use the hash currently committed
            // for that asset rather than the incoming automatic decode hash.
            sha256: target_sha256,
            fingerprint,
            source_sha256,
            selected_encoding: selected_encoding.map(parse_encoding),
        }))
    }

    fn find_import_target(
        &self,
        sha256: &str,
        source_sha256: &str,
    ) -> Result<Option<AssetRecord>, AppError> {
        self.conn
            .query_row(
                "SELECT a.id, a.book_id, a.kind, a.sha256, a.byte_length,
                        a.content_version, a.relative_path, a.created_at
                 FROM book_assets a
                 LEFT JOIN txt_assets t ON t.asset_id = a.id
                 WHERE a.sha256 = ?1 OR t.source_sha256 = ?2
                 ORDER BY CASE WHEN t.source_sha256 = ?2 THEN 0 ELSE 1 END,
                          a.created_at ASC
                 LIMIT 1",
                params![sha256, source_sha256],
                asset_from_row,
            )
            .optional()
            .map_err(AppError::from)
    }

    pub fn list_books(&self) -> Result<Vec<Book>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, title, author, content_version, created_at, updated_at
             FROM books ORDER BY updated_at DESC, id ASC",
        )?;
        let books = statement
            .query_map([], book_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(books)
    }

    pub fn list_groups(&self) -> Result<Vec<LibraryGroup>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT g.id, g.name, m.book_id FROM library_groups g
             LEFT JOIN book_groups m ON m.group_id = g.id ORDER BY g.rowid, m.book_id",
        )?;
        let mut rows = statement.query([])?;
        let mut groups: Vec<LibraryGroup> = Vec::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let book_id: Option<String> = row.get(2)?;
            if groups.last().map_or(true, |group| group.id != id) {
                groups.push(LibraryGroup {
                    id,
                    name: row.get(1)?,
                    book_ids: Vec::new(),
                });
            }
            if let Some(book_id) = book_id {
                if let Some(group) = groups.last_mut() {
                    group.book_ids.push(book_id);
                }
            }
        }
        Ok(groups)
    }

    pub fn create_group(&self, name: &str) -> Result<LibraryGroup, AppError> {
        let name = self.validate_group_name(name, None)?;
        let id = Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO library_groups(id, name) VALUES (?1, ?2)",
            params![id, name],
        )?;
        Ok(LibraryGroup {
            id,
            name,
            book_ids: Vec::new(),
        })
    }

    pub fn rename_group(&self, id: &str, name: &str) -> Result<LibraryGroup, AppError> {
        let name = self.validate_group_name(name, Some(id))?;
        if self.conn.execute(
            "UPDATE library_groups SET name = ?1 WHERE id = ?2",
            params![name, id],
        )? == 0
        {
            return Err(AppError::new(
                ErrorCode::NotFound,
                "library group was not found",
            ));
        }
        self.list_groups()?
            .into_iter()
            .find(|group| group.id == id)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "library group was not found"))
    }

    pub fn delete_group(&self, id: &str) -> Result<(), AppError> {
        if self
            .conn
            .execute("DELETE FROM library_groups WHERE id = ?1", params![id])?
            == 0
        {
            return Err(AppError::new(
                ErrorCode::NotFound,
                "library group was not found",
            ));
        }
        Ok(())
    }

    pub fn set_book_groups(&mut self, book_id: &str, group_ids: &[String]) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        let book_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)",
            params![book_id],
            |row| row.get(0),
        )?;
        if !book_exists {
            return Err(AppError::new(ErrorCode::NotFound, "book was not found"));
        }
        let unique_ids: HashSet<&String> = group_ids.iter().collect();
        for group_id in &unique_ids {
            let group_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_groups WHERE id = ?1)",
                params![group_id],
                |row| row.get(0),
            )?;
            if !group_exists {
                return Err(AppError::new(
                    ErrorCode::NotFound,
                    "library group was not found",
                ));
            }
        }
        tx.execute(
            "DELETE FROM book_groups WHERE book_id = ?1",
            params![book_id],
        )?;
        for group_id in unique_ids {
            tx.execute(
                "INSERT INTO book_groups(book_id, group_id) VALUES (?1, ?2)",
                params![book_id, group_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn validate_group_name(&self, name: &str, except_id: Option<&str>) -> Result<String, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::invalid_argument("group name cannot be empty"));
        }
        let duplicate: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_groups WHERE name = ?1 AND (?2 IS NULL OR id != ?2))",
            params![name, except_id], |row| row.get(0),
        )?;
        if duplicate {
            return Err(AppError::invalid_argument("group name already exists"));
        }
        Ok(name.to_string())
    }

    pub fn list_library_books(&self) -> Result<Vec<LibraryBook>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT b.id, b.title, b.author, b.content_version, b.created_at, b.updated_at,
                    a.id, a.book_id, a.kind, a.sha256, a.byte_length, a.content_version,
                    a.relative_path, a.created_at
             FROM books b JOIN book_assets a ON a.book_id = b.id
             ORDER BY b.updated_at DESC, b.id ASC, a.created_at ASC",
        )?;
        let rows = statement
            .query_map([], |row| {
                let book = Book {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    author: row.get(2)?,
                    content_version: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                };
                let record = asset_from_columns(row, 6)?;
                Ok((book, record))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        rows.into_iter()
            .map(|(book, mut record)| {
                let path = managed_path(&self.root, &record.relative_path, "books")?;
                record.asset.availability = if is_regular_file(&path) {
                    AssetAvailability::Ready
                } else {
                    AssetAvailability::Missing
                };
                let locator = self.saved_position(&book.id)?;
                let total_length = if record.asset.availability == AssetAvailability::Ready {
                    self.trusted_content_length(&record)?
                } else {
                    None
                };
                let txt_encoding = self.txt_encoding_for_asset(&record.asset.id)?;
                Ok(LibraryBook {
                    book,
                    asset: record.asset,
                    locator,
                    total_length,
                    txt_encoding,
                })
            })
            .collect()
    }

    /// Return a cached length only when its persisted index still matches the
    /// managed file metadata. The complete hash and UTF-8/index rebuild stay
    /// on the content-read path, outside the application mutex.
    fn trusted_content_length(&self, record: &AssetRecord) -> Result<Option<u64>, AppError> {
        let Some(persisted) = self.persisted_index(&record.asset.id)? else {
            return Ok(None);
        };
        if persisted.index.byte_length != record.asset.byte_length || !valid_index(&persisted.index)
        {
            return Ok(None);
        }
        let path = managed_path(&self.root, &record.relative_path, "books")?;
        let fingerprint = match file_fingerprint(&path) {
            Ok((metadata, fingerprint)) if metadata.len() == record.asset.byte_length => {
                fingerprint
            }
            Ok(_) | Err(_) => return Ok(None),
        };
        if persisted.fingerprint != fingerprint {
            return Ok(None);
        }
        Ok(Some(persisted.index.utf16_length))
    }

    pub fn get_book(&self, book_id: &str) -> Result<Book, AppError> {
        self.conn
            .query_row(
                "SELECT id, title, author, content_version, created_at, updated_at
                 FROM books WHERE id = ?1",
                params![book_id],
                book_from_row,
            )
            .optional()?
            .ok_or_else(|| {
                AppError::new(ErrorCode::NotFound, format!("book {book_id} was not found"))
            })
    }

    pub fn txt_encoding_for_book(&self, book_id: &str) -> Result<TxtEncodingInfo, AppError> {
        let asset_id: String = self.conn.query_row(
            "SELECT id FROM book_assets WHERE book_id = ?1 ORDER BY created_at ASC LIMIT 1",
            params![book_id],
            |row| row.get(0),
        )?;
        Ok(self
            .txt_encoding_for_asset(&asset_id)?
            .unwrap_or(TxtEncodingInfo {
                detected: TxtEncoding::Utf8,
                selected: TxtEncoding::Utf8,
                state: TxtDecodeState::Clean,
                can_change: false,
            }))
    }

    fn txt_encoding_for_asset(&self, asset_id: &str) -> Result<Option<TxtEncodingInfo>, AppError> {
        let row: Option<(String, String, String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT detected_encoding, selected_encoding, decode_state, source_relative_path
                 FROM txt_assets WHERE asset_id = ?1",
                params![asset_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        Ok(
            row.map(|(detected, selected, state, source)| TxtEncodingInfo {
                detected: parse_encoding(detected),
                selected: parse_encoding(selected),
                state: parse_decode_state(state),
                can_change: source
                    .as_deref()
                    .and_then(|value| managed_path(&self.root, value, "sources").ok())
                    .is_some_and(|path| path.is_file()),
            }),
        )
    }

    pub fn list_toc(&mut self, book_id: &str) -> Result<Vec<TocEntry>, AppError> {
        let context = self.content_read_context(book_id)?;
        let verified = verify_content_context(&context)?;
        if let Some(entries) = self.cached_toc(&context)? {
            return Ok(entries);
        }
        let entries = build_toc_from_context(&context, &verified, book_id)?;
        self.persist_content_index(&context, &verified)?;
        self.cache_toc(&context, &entries)?;
        Ok(entries)
    }

    pub(crate) fn cached_toc(
        &self,
        context: &ContentReadContext,
    ) -> Result<Option<Vec<TocEntry>>, AppError> {
        let cached: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT content_version, entries_json FROM toc_cache WHERE asset_id = ?1",
                params![context.record.asset.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((version, json)) = cached else {
            return Ok(None);
        };
        if version != context.record.asset.content_version {
            return Ok(None);
        }
        let mut entries = serde_json::from_str::<Vec<TocEntry>>(&json).ok();
        if let Some(entries) = entries.as_mut() {
            entries.iter_mut().for_each(|entry| {
                entry.locator.resource_id = context.record.asset.id.clone();
            });
        }
        Ok(entries)
    }

    pub(crate) fn cache_toc(
        &self,
        context: &ContentReadContext,
        entries: &[TocEntry],
    ) -> Result<(), AppError> {
        let serialized = serde_json::to_string(&entries)?;
        self.conn.execute(
            "INSERT INTO toc_cache(asset_id, content_version, entries_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(asset_id) DO UPDATE SET content_version = excluded.content_version,
                entries_json = excluded.entries_json, updated_at = excluded.updated_at",
            params![
                context.record.asset.id,
                context.record.asset.content_version,
                serialized,
                now_millis()
            ],
        )?;
        Ok(())
    }

    pub fn list_bookmarks(&self, book_id: &str) -> Result<Vec<Bookmark>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, book_id, content_version, locator_json, excerpt, created_at
             FROM bookmarks WHERE book_id = ?1 ORDER BY created_at DESC, id ASC",
        )?;
        let result = statement
            .query_map(params![book_id], |row| {
                let locator_json: String = row.get(3)?;
                let locator = serde_json::from_str(&locator_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        error.into(),
                    )
                })?;
                Ok(Bookmark {
                    id: row.get(0)?,
                    book_id: row.get(1)?,
                    content_version: row.get(2)?,
                    locator,
                    excerpt: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from);
        result
    }

    pub fn add_bookmark(&mut self, request: &BookmarkRequest) -> Result<Bookmark, AppError> {
        let context = self.content_read_context(&request.book_id)?;
        let verified = verify_content_context(&context)?;
        self.add_bookmark_from_context(&context, &verified, request)
    }

    pub(crate) fn add_bookmark_from_context(
        &self,
        context: &ContentReadContext,
        verified: &VerifiedContentIndex,
        request: &BookmarkRequest,
    ) -> Result<Bookmark, AppError> {
        validate_content_locator(context, verified, &request.locator)?;
        if request.locator.content_version != context.record.asset.content_version {
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "bookmark belongs to an older content version",
            ));
        }
        let current_version: Option<String> = self
            .conn
            .query_row(
                "SELECT content_version FROM book_assets WHERE id = ?1",
                params![context.record.asset.id],
                |row| row.get(0),
            )
            .optional()?;
        if current_version.as_deref() != Some(context.record.asset.content_version.as_str()) {
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "book content changed while creating the bookmark",
            ));
        }
        let id = Uuid::new_v4().to_string();
        let bookmark = Bookmark {
            id: id.clone(),
            book_id: request.book_id.clone(),
            content_version: request.locator.content_version.clone(),
            locator: request.locator.clone(),
            excerpt: request.excerpt.clone(),
            created_at: now_millis(),
        };
        self.conn.execute(
            "INSERT INTO bookmarks(id, book_id, content_version, offset, locator_json, excerpt, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(book_id, content_version, offset) DO NOTHING",
            params![
                bookmark.id,
                bookmark.book_id,
                bookmark.content_version,
                bookmark.locator.offset as i64,
                serde_json::to_string(&bookmark.locator)?,
                bookmark.excerpt,
                bookmark.created_at
            ],
        )?;
        self.conn
            .query_row(
                "SELECT id, book_id, content_version, locator_json, excerpt, created_at
                 FROM bookmarks WHERE book_id = ?1 AND content_version = ?2 AND offset = ?3",
                params![
                    request.book_id,
                    request.locator.content_version,
                    request.locator.offset as i64
                ],
                |row| {
                    let locator: ReaderLocator = serde_json::from_str(&row.get::<_, String>(3)?)
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                3,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?;
                    Ok(Bookmark {
                        id: row.get(0)?,
                        book_id: row.get(1)?,
                        content_version: row.get(2)?,
                        locator,
                        excerpt: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                },
            )
            .map_err(AppError::from)
    }

    pub fn delete_bookmark(&mut self, bookmark_id: &str) -> Result<(), AppError> {
        let changed = self
            .conn
            .execute("DELETE FROM bookmarks WHERE id = ?1", params![bookmark_id])?;
        if changed == 0 {
            return Err(AppError::new(ErrorCode::NotFound, "bookmark was not found"));
        }
        Ok(())
    }

    pub fn search_book(&self, request: &SearchRequest) -> Result<SearchResponse, AppError> {
        let context = self.content_read_context(&request.book_id)?;
        let verified = verify_content_context(&context)?;
        Self::search_book_from_context(request, &context, &verified)
    }

    pub(crate) fn search_book_from_context(
        request: &SearchRequest,
        context: &ContentReadContext,
        verified: &VerifiedContentIndex,
    ) -> Result<SearchResponse, AppError> {
        Self::search_book_from_context_cancelable(request, context, verified, None)
    }

    pub(crate) fn search_book_from_context_cancelable(
        request: &SearchRequest,
        context: &ContentReadContext,
        verified: &VerifiedContentIndex,
        cancel: Option<&AtomicBool>,
    ) -> Result<SearchResponse, AppError> {
        let limit = request.limit.clamp(1, 100);
        let (matches, next_cursor, has_more) = search_text_stream(
            context,
            verified,
            SearchParameters {
                book_id: &request.book_id,
                content_version: &context.record.asset.content_version,
                query: &request.query,
                case_sensitive: request.case_sensitive,
                cursor: request.cursor.unwrap_or(0),
                limit,
            },
            cancel,
        )?;
        Ok(SearchResponse {
            content_version: context.record.asset.content_version.clone(),
            matches,
            next_cursor,
            has_more,
        })
    }

    pub(crate) fn snapshot_txt_decode(&self, book_id: &str) -> Result<TxtDecodeSnapshot, AppError> {
        let context = self.content_read_context(book_id)?;
        let source: Option<(Option<String>, Option<String>, String)> = self
            .conn
            .query_row(
                "SELECT source_relative_path, source_sha256, selected_encoding
                 FROM txt_assets WHERE asset_id = ?1",
                params![context.record.asset.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((Some(source_relative_path), source_sha256, selected_encoding)) = source else {
            return Err(AppError::new(
                ErrorCode::UnsupportedEncoding,
                "this book has no retained source bytes",
            ));
        };
        Ok(TxtDecodeSnapshot {
            book_id: context.record.asset.book_id,
            asset_id: context.record.asset.id,
            relative_path: context.record.relative_path,
            source_relative_path,
            source_sha256: source_sha256.unwrap_or_default(),
            content_version: context.record.asset.content_version,
            selected_encoding: parse_encoding(selected_encoding),
        })
    }

    pub(crate) fn snapshot_txt_reassociation(
        &self,
        book_id: &str,
    ) -> Result<TxtReassociationSnapshot, AppError> {
        let context = self.content_read_context(book_id)?;
        let selected_encoding: String = self
            .conn
            .query_row(
                "SELECT selected_encoding FROM txt_assets WHERE asset_id = ?1",
                params![context.record.asset.id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_else(|| "utf8".to_string());
        let source_relative_path = format!("sources/{}.txt", context.record.asset.id);
        Ok(TxtReassociationSnapshot {
            asset_id: context.record.asset.id,
            source_relative_path,
            content_version: context.record.asset.content_version,
            selected_encoding: parse_encoding(selected_encoding),
        })
    }

    pub(crate) fn prepare_txt_reassociation(
        root: &Path,
        snapshot: &TxtReassociationSnapshot,
        source: &Path,
        operation_id: &str,
    ) -> Result<PreparedTxtReassociation, AppError> {
        let cancel = AtomicBool::new(false);
        let (bytes, _) = read_cancelable_file(source, &cancel, |_, _| {})?;
        let decoded = detect_and_decode(&bytes, snapshot.selected_encoding.clone())?;
        let content_version = sha256_bytes(decoded.text.as_bytes());
        if content_version != snapshot.content_version {
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "selected source does not reproduce the current normalized text",
            ));
        }
        let source_sha256 = sha256_bytes(&bytes);
        let stage_relative_path = format!("staging/reassociate-{operation_id}.raw");
        let stage_path = managed_path(root, &stage_relative_path, "staging")?;
        let result = (|| -> Result<PreparedTxtReassociation, AppError> {
            let mut stage = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&stage_path)?;
            stage.write_all(&bytes)?;
            stage.sync_all()?;
            Ok(PreparedTxtReassociation {
                snapshot: snapshot.clone(),
                stage_relative_path,
                source_sha256,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(stage_path);
        }
        result
    }

    pub(crate) fn commit_txt_reassociation(
        &mut self,
        prepared: PreparedTxtReassociation,
    ) -> Result<TxtEncodingInfo, AppError> {
        let stage_path = managed_path(&self.root, &prepared.stage_relative_path, "staging")?;
        let source_path = managed_path(
            &self.root,
            &prepared.snapshot.source_relative_path,
            "sources",
        )?;
        if !stage_path.is_file() {
            return Err(AppError::new(
                ErrorCode::AssetMissing,
                "prepared TXT source staging file is missing",
            ));
        }
        if source_path.exists() {
            remove_owned_file(&stage_path)?;
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "the book already has a retained TXT source",
            ));
        }
        if let Some(parent) = source_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&stage_path, &source_path)?;
        let transaction = (|| -> Result<(), AppError> {
            self.conn.execute(
                "INSERT INTO txt_assets(
                    asset_id, detected_encoding, selected_encoding, decode_state,
                    source_relative_path, source_sha256, toc_json, updated_at
                 ) VALUES (?1, ?2, ?2, 'clean', ?3, ?4, NULL, ?5)
                 ON CONFLICT(asset_id) DO UPDATE SET
                    source_relative_path = excluded.source_relative_path,
                    source_sha256 = excluded.source_sha256,
                    updated_at = excluded.updated_at",
                params![
                    prepared.snapshot.asset_id,
                    encoding_name(&prepared.snapshot.selected_encoding),
                    prepared.snapshot.source_relative_path,
                    prepared.source_sha256,
                    now_millis(),
                ],
            )?;
            Ok(())
        })();
        if let Err(error) = transaction {
            remove_owned_file(&source_path)?;
            return Err(error);
        }
        Ok(TxtEncodingInfo {
            detected: prepared.snapshot.selected_encoding.clone(),
            selected: prepared.snapshot.selected_encoding,
            state: TxtDecodeState::Clean,
            can_change: true,
        })
    }

    pub(crate) fn prepare_txt_decode(
        root: &Path,
        snapshot: &TxtDecodeSnapshot,
        requested: TxtEncoding,
        operation_id: &str,
        cancel: &AtomicBool,
        mut report: impl FnMut(ImportPhase, u64, u64),
    ) -> Result<PreparedTxtDecode, AppError> {
        let source_path = managed_path(root, &snapshot.source_relative_path, "sources")?;
        let (bytes, total_bytes) = read_cancelable_file(&source_path, cancel, |read, total| {
            report(ImportPhase::Reading, read, total)
        })?;
        let source_sha256 = sha256_bytes(&bytes);
        if !snapshot.source_sha256.is_empty() && source_sha256 != snapshot.source_sha256 {
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "retained TXT source bytes changed",
            ));
        }
        report(ImportPhase::Normalizing, total_bytes, total_bytes);
        let decoded = detect_and_decode(&bytes, requested)?;
        if cancel.load(Ordering::Acquire) {
            return Err(import_cancelled());
        }
        let normalized_bytes = decoded.text.as_bytes();
        let content_version = sha256_bytes(normalized_bytes);
        let index_json = serde_json::to_string(&build_sparse_index(&decoded.text))?;
        let stage_relative_path = format!("staging/redecode-{operation_id}.part");
        let backup_relative_path = format!("staging/redecode-{operation_id}.old");
        let stage_path = managed_path(root, &stage_relative_path, "staging")?;
        let result = (|| -> Result<PreparedTxtDecode, AppError> {
            let mut stage = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&stage_path)?;
            stage.write_all(normalized_bytes)?;
            stage.sync_all()?;
            report(ImportPhase::Persisting, total_bytes, total_bytes);
            Ok(PreparedTxtDecode {
                operation_id: operation_id.to_string(),
                snapshot: snapshot.clone(),
                stage_relative_path,
                backup_relative_path,
                content_version,
                byte_length: normalized_bytes.len() as u64,
                index_json,
                source_sha256,
                detected_encoding: decoded.detected,
                selected_encoding: decoded.selected,
                decode_state: decoded.state,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(stage_path);
        }
        result
    }

    pub(crate) fn commit_txt_decode(
        &mut self,
        prepared: PreparedTxtDecode,
        cancel: &AtomicBool,
    ) -> Result<TxtEncodingInfo, AppError> {
        let stage_path = managed_path(&self.root, &prepared.stage_relative_path, "staging")?;
        let backup_path = managed_path(&self.root, &prepared.backup_relative_path, "staging")?;
        let final_path = managed_path(&self.root, &prepared.snapshot.relative_path, "books")?;
        if !stage_path.is_file() {
            return Err(AppError::new(
                ErrorCode::AssetMissing,
                "prepared TXT decode staging file is missing",
            ));
        }
        if cancel.load(Ordering::Acquire) {
            remove_owned_file(&stage_path)?;
            return Err(import_cancelled());
        }
        let journal = TxtDecodeJournal {
            operation_id: prepared.operation_id.clone(),
            book_id: prepared.snapshot.book_id.clone(),
            asset_id: prepared.snapshot.asset_id.clone(),
            old_content_version: prepared.snapshot.content_version.clone(),
            relative_path: prepared.snapshot.relative_path.clone(),
            stage_path: prepared.stage_relative_path.clone(),
            backup_path: prepared.backup_relative_path.clone(),
            new_content_version: prepared.content_version.clone(),
            byte_length: prepared.byte_length,
            index_json: prepared.index_json.clone(),
            source_sha256: prepared.source_sha256.clone(),
            detected_encoding: prepared.detected_encoding.clone(),
            selected_encoding: prepared.selected_encoding.clone(),
            decode_state: prepared.decode_state.clone(),
            created_at: now_millis(),
        };
        let register = (|| -> Result<(), AppError> {
            // The preparation runs without the storage lock. Reject a stale
            // snapshot before touching the live file or writing a journal;
            // otherwise a crash could associate stale bytes with a newer DB.
            if self.snapshot_txt_decode(&prepared.snapshot.book_id)? != prepared.snapshot {
                return Err(AppError::new(
                    ErrorCode::ContentVersionMismatch,
                    "book content or source changed while decoding",
                ));
            }
            let tx = self.conn.transaction()?;
            insert_txt_decode_journal(&tx, &journal)?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = register {
            remove_owned_file(&stage_path)?;
            return Err(error);
        }
        // Once the journal is durable, finish publication even if cancellation
        // arrives. Recovery can then distinguish old and new content safely.
        let fingerprint = match (|| -> Result<String, AppError> {
            if final_path.exists() {
                remove_owned_file(&backup_path)?;
                fs::rename(&final_path, &backup_path)?;
                sync_parent(&backup_path)?;
            }
            fs::rename(&stage_path, &final_path)?;
            sync_parent(&final_path)?;
            maybe_inject_failure(&self.root, cancel, FailurePoint::AfterRename)?;
            Ok(file_fingerprint(&final_path)?.1)
        })() {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                if let Err(recovery_error) = self.recover_txt_decode(&journal) {
                    return Err(AppError::new(
                        error.code.clone(),
                        format!(
                            "{}; TXT decode recovery failed: {}",
                            error.message, recovery_error.message
                        ),
                    ));
                }
                return Err(error);
            }
        };
        let transaction = (|| -> Result<(), AppError> {
            let tx = self.conn.transaction()?;
            let current: String = tx.query_row(
                "SELECT content_version FROM book_assets WHERE id = ?1",
                params![prepared.snapshot.asset_id],
                |row| row.get(0),
            )?;
            if current != prepared.snapshot.content_version {
                return Err(AppError::new(
                    ErrorCode::ContentVersionMismatch,
                    "book content changed while decoding",
                ));
            }
            tx.execute(
                "UPDATE books SET content_version = ?1, updated_at = ?2 WHERE id = ?3",
                params![
                    prepared.content_version,
                    now_millis(),
                    prepared.snapshot.book_id
                ],
            )?;
            tx.execute(
                "UPDATE book_assets SET sha256 = ?1, dedup_hash = NULL, byte_length = ?2,
                    content_version = ?3 WHERE id = ?4",
                params![
                    prepared.content_version,
                    prepared.byte_length as i64,
                    prepared.content_version,
                    prepared.snapshot.asset_id
                ],
            )?;
            insert_content_index(
                &tx,
                &prepared.snapshot.asset_id,
                &parse_index(&prepared.index_json)?,
                &fingerprint,
            )?;
            tx.execute(
                "UPDATE txt_assets SET detected_encoding = ?1, selected_encoding = ?2,
                    decode_state = ?3, source_sha256 = ?4, toc_json = NULL, updated_at = ?5
                 WHERE asset_id = ?6",
                params![
                    encoding_name(&prepared.detected_encoding),
                    encoding_name(&prepared.selected_encoding),
                    decode_state_name(&prepared.decode_state),
                    prepared.source_sha256,
                    now_millis(),
                    prepared.snapshot.asset_id
                ],
            )?;
            tx.execute(
                "DELETE FROM toc_cache WHERE asset_id = ?1",
                params![prepared.snapshot.asset_id],
            )?;
            tx.execute(
                "DELETE FROM txt_decode_journal WHERE operation_id = ?1",
                params![prepared.operation_id],
            )?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = transaction {
            if let Err(recovery_error) = self.recover_txt_decode(&journal) {
                return Err(AppError::new(
                    error.code,
                    format!(
                        "{}; TXT decode recovery failed: {}",
                        error.message, recovery_error.message
                    ),
                ));
            }
            return Err(error);
        }
        let _ = remove_owned_file(&backup_path);
        self.verified_indexes
            .lock()
            .map_err(|_| {
                AppError::new(ErrorCode::Database, "content verification lock is poisoned")
            })?
            .remove(&prepared.snapshot.asset_id);
        Ok(TxtEncodingInfo {
            detected: prepared.detected_encoding,
            selected: prepared.selected_encoding,
            state: prepared.decode_state,
            can_change: true,
        })
    }

    pub fn set_txt_encoding(
        &mut self,
        book_id: &str,
        requested: TxtEncoding,
    ) -> Result<TxtEncodingInfo, AppError> {
        let operation_id = Uuid::new_v4().to_string();
        let snapshot = self.snapshot_txt_decode(book_id)?;
        let prepared = Self::prepare_txt_decode(
            &self.root,
            &snapshot,
            requested,
            &operation_id,
            &AtomicBool::new(false),
            |_, _, _| {},
        )?;
        verify_prepared_txt_decode_source(&self.root, &prepared, &AtomicBool::new(false))?;
        self.commit_txt_decode(prepared, &AtomicBool::new(false))
    }

    pub fn read_content_window(
        &self,
        book_id: &str,
        locator: Option<&ReaderLocator>,
        max_units: u64,
    ) -> Result<ContentWindow, AppError> {
        self.read_content_window_request(&ReadContentRequest {
            book_id: book_id.to_string(),
            locator: locator.cloned(),
            max_units,
            direction: WindowDirection::Forward,
        })
    }

    pub fn read_content_window_request(
        &self,
        request: &ReadContentRequest,
    ) -> Result<ContentWindow, AppError> {
        if request.book_id.trim().is_empty() {
            return Err(AppError::invalid_argument("book_id cannot be empty"));
        }
        if request.max_units == 0 || request.max_units > MAX_WINDOW_UNITS {
            return Err(AppError::invalid_argument(format!(
                "content window must contain between 1 and {MAX_WINDOW_UNITS} UTF-16 units"
            )));
        }

        let context = self.content_read_context(&request.book_id)?;
        let verified = verify_content_context(&context)?;
        self.persist_content_index(&context, &verified)?;
        read_content_window_from_context(request, &context, &verified)
    }

    pub fn resolve_reader_locator(
        &self,
        request: &ResolveLocatorRequest,
    ) -> Result<ReaderLocator, AppError> {
        if !request.progress.is_finite() || !(0.0..=1.0).contains(&request.progress) {
            return Err(AppError::invalid_argument(
                "reader progress must be a finite number between 0 and 1",
            ));
        }
        let context = self.content_read_context(&request.book_id)?;
        let verified = verify_content_context(&context)?;
        self.persist_content_index(&context, &verified)?;
        let target = (verified.index.utf16_length as f64 * request.progress).floor() as u64;
        let boundary = boundary_for_offset(
            &context.root,
            &context.record.relative_path,
            &verified.index,
            target,
            BoundaryMode::Floor,
            &verified.fingerprint,
        )?;
        locator_for(
            &context.root,
            &context.record,
            &verified.index,
            boundary.utf16_offset,
            boundary.byte_offset,
            &verified.fingerprint,
        )
    }

    pub fn save_position(&self, locator: &ReaderLocator) -> Result<ReaderLocator, AppError> {
        let context = self.content_read_context(&locator.book_id)?;
        let verified = verify_content_context(&context)?;
        self.persist_content_index(&context, &verified)?;
        validate_locator(
            &context.root,
            &context.record,
            &verified.index,
            locator,
            &verified.fingerprint,
        )?;
        self.save_position_record(locator)?;
        Ok(locator.clone())
    }

    pub(crate) fn save_position_record(&self, locator: &ReaderLocator) -> Result<(), AppError> {
        let serialized = serde_json::to_string(locator)?;
        maybe_inject_save_failure(&self.root)?;
        self.conn.execute(
            "INSERT INTO reading_positions(book_id, locator_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(book_id) DO UPDATE SET locator_json = excluded.locator_json,
                 updated_at = excluded.updated_at",
            params![locator.book_id, serialized, now_millis()],
        )?;
        Ok(())
    }

    pub fn saved_position(&self, book_id: &str) -> Result<Option<ReaderLocator>, AppError> {
        let serialized = self
            .conn
            .query_row(
                "SELECT locator_json FROM reading_positions WHERE book_id = ?1",
                params![book_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        serialized
            .map(|value| {
                serde_json::from_str(&value).map_err(|error| {
                    AppError::new(
                        ErrorCode::Database,
                        format!("saved locator is invalid: {error}"),
                    )
                })
            })
            .transpose()
    }

    pub fn get_settings(&self) -> Result<ReaderPreferences, AppError> {
        let serialized = self
            .conn
            .query_row(
                "SELECT preferences_json FROM reader_preferences WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match serialized {
            None => Ok(ReaderPreferences::default()),
            Some(value) => {
                let preferences: ReaderPreferences =
                    serde_json::from_str(&value).map_err(|error| {
                        AppError::new(
                            ErrorCode::Database,
                            format!("saved reader preferences are invalid: {error}"),
                        )
                    })?;
                preferences.validate()?;
                Ok(preferences)
            }
        }
    }

    pub fn save_settings(
        &self,
        preferences: &ReaderPreferences,
    ) -> Result<ReaderPreferences, AppError> {
        preferences.validate()?;
        let serialized = serde_json::to_string(preferences)?;
        self.conn.execute(
            "INSERT INTO reader_preferences(id, preferences_json, updated_at)
             VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET preferences_json = excluded.preferences_json,
                 updated_at = excluded.updated_at",
            params![serialized, now_millis()],
        )?;
        Ok(preferences.clone())
    }

    fn asset_for_book(&self, book_id: &str) -> Result<AssetRecord, AppError> {
        self.conn
            .query_row(
                "SELECT id, book_id, kind, sha256, byte_length, content_version, relative_path, created_at
                 FROM book_assets WHERE book_id = ?1 ORDER BY created_at ASC LIMIT 1",
                params![book_id],
                asset_from_row,
            )
            .optional()?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, format!("book {book_id} has no asset")))
    }

    /// Read the database metadata needed for a content request. This method
    /// deliberately does no filesystem work so callers can release the
    /// application storage mutex before hashing or indexing an asset.
    pub(crate) fn content_read_context(
        &self,
        book_id: &str,
    ) -> Result<ContentReadContext, AppError> {
        if book_id.trim().is_empty() {
            return Err(AppError::invalid_argument("book_id cannot be empty"));
        }
        let record = self.asset_for_book(book_id)?;
        self.content_read_context_for_record(record)
    }

    fn content_read_context_for_record(
        &self,
        record: AssetRecord,
    ) -> Result<ContentReadContext, AppError> {
        let persisted = self.persisted_index(&record.asset.id)?;
        let verified = self
            .verified_indexes
            .lock()
            .map_err(|_| {
                AppError::new(ErrorCode::Database, "content verification lock is poisoned")
            })?
            .get(&record.asset.id)
            .cloned();
        Ok(ContentReadContext {
            root: self.root.clone(),
            record,
            persisted,
            verified,
        })
    }

    fn persisted_index(&self, asset_id: &str) -> Result<Option<PersistedIndex>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT schema_version, stride_units, byte_length, utf16_length, fingerprint, index_json
                 FROM content_indexes WHERE asset_id = ?1",
                params![asset_id],
                |row| {
                    let schema_version: i64 = row.get(0)?;
                    let stride_units: i64 = row.get(1)?;
                    let byte_length: i64 = row.get(2)?;
                    let utf16_length: i64 = row.get(3)?;
                    let fingerprint: String = row.get(4)?;
                    let index_json: String = row.get(5)?;
                    Ok((
                        schema_version,
                        stride_units,
                        byte_length,
                        utf16_length,
                        fingerprint,
                        index_json,
                    ))
                },
            )
            .optional()?
            .and_then(|(
                schema_version,
                stride_units,
                byte_length,
                utf16_length,
                fingerprint,
                serialized,
            )| {
                let index = serde_json::from_str::<SparseIndex>(&serialized).ok()?;
                if schema_version != i64::from(INDEX_SCHEMA_VERSION)
                    || stride_units != i64::try_from(index.stride_units).ok()?
                    || index.stride_units != INDEX_STRIDE_UNITS
                    || byte_length < 0
                    || utf16_length < 0
                    || index.byte_length != u64::try_from(byte_length).ok()?
                    || index.utf16_length != u64::try_from(utf16_length).ok()?
                {
                    return None;
                }
                Some(PersistedIndex { index, fingerprint })
            }))
    }

    /// Persist an index after file verification. The asset identity is
    /// rechecked because a request may have spent a long time outside the
    /// database mutex while another in-process operation changed the row.
    pub(crate) fn persist_content_index(
        &self,
        context: &ContentReadContext,
        verified: &VerifiedContentIndex,
    ) -> Result<(), AppError> {
        let current: Option<(String, String, i64)> = self
            .conn
            .query_row(
                "SELECT sha256, relative_path, byte_length FROM book_assets WHERE id = ?1",
                params![context.record.asset.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((sha256, relative_path, byte_length)) = current else {
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "content asset was removed while it was being read",
            ));
        };
        if sha256 != context.record.asset.sha256
            || relative_path != context.record.relative_path
            || byte_length < 0
            || u64::try_from(byte_length).ok() != Some(verified.index.byte_length)
        {
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                format!(
                    "managed asset {} changed while it was being read",
                    context.record.asset.id
                ),
            ));
        }
        insert_content_index(
            &self.conn,
            &context.record.asset.id,
            &verified.index,
            &verified.fingerprint,
        )?;
        self.verified_indexes
            .lock()
            .map_err(|_| {
                AppError::new(ErrorCode::Database, "content verification lock is poisoned")
            })?
            .insert(context.record.asset.id.clone(), verified.clone());
        Ok(())
    }

    fn journal_exists(&self, operation_id: &str) -> Result<bool, AppError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM import_journal WHERE operation_id = ?1",
            params![operation_id],
            |row| row.get(0),
        )?;
        Ok(count != 0)
    }

    fn recover_pending_txt_decodes(&mut self) -> Result<(), AppError> {
        let journals = {
            let mut statement = self.conn.prepare(
                "SELECT operation_id, book_id, asset_id, old_content_version,
                        relative_path, stage_path, backup_path, new_content_version,
                        byte_length, index_json, source_sha256, detected_encoding,
                        selected_encoding, decode_state, created_at
                 FROM txt_decode_journal ORDER BY created_at ASC, operation_id ASC",
            )?;
            let rows = statement
                .query_map([], txt_decode_journal_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for journal in journals {
            self.recover_txt_decode(&journal)?;
        }
        Ok(())
    }

    fn recover_txt_decode(&mut self, journal: &TxtDecodeJournal) -> Result<(), AppError> {
        let final_path = managed_path(&self.root, &journal.relative_path, "books")?;
        let stage_path = managed_path(&self.root, &journal.stage_path, "staging")?;
        let backup_path = managed_path(&self.root, &journal.backup_path, "staging")?;
        let current_version: Option<String> = self
            .conn
            .query_row(
                "SELECT content_version FROM book_assets WHERE id = ?1",
                params![journal.asset_id],
                |row| row.get(0),
            )
            .optional()?;
        let final_is_new = final_path.is_file()
            && hash_file(&final_path).ok().as_deref() == Some(journal.new_content_version.as_str());
        if current_version.as_deref() == Some(journal.new_content_version.as_str()) && final_is_new
        {
            remove_owned_file(&stage_path)?;
            remove_owned_file(&backup_path)?;
        } else {
            // The database still names the old version, or the new file was
            // not fully published. Restore the old backup before removing the
            // journal so readers never observe a mismatched pair.
            if backup_path.is_file() {
                if final_path.exists() {
                    remove_owned_file(&final_path)?;
                }
                if let Some(parent) = final_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(&backup_path, &final_path)?;
                sync_parent(&final_path)?;
            } else if current_version.as_deref() != Some(journal.new_content_version.as_str())
                && final_is_new
            {
                remove_owned_file(&final_path)?;
            }
            remove_owned_file(&stage_path)?;
        }
        self.conn.execute(
            "DELETE FROM txt_decode_journal WHERE operation_id = ?1",
            params![journal.operation_id],
        )?;
        Ok(())
    }

    fn recover_pending_imports(&mut self) -> Result<(), AppError> {
        let journals = {
            let mut statement = self.conn.prepare(
                "SELECT operation_id, book_id, asset_id, title, sha256, byte_length,
                        content_version, relative_path, stage_path, index_json,
                        source_byte_length, created_at, raw_stage_path,
                        source_relative_path, source_sha256, detected_encoding,
                        selected_encoding, decode_state
                 FROM import_journal ORDER BY created_at ASC, operation_id ASC",
            )?;
            let journals = statement
                .query_map([], journal_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            journals
        };
        for journal in journals {
            self.recover_journal(&journal)?;
        }
        Ok(())
    }

    fn recover_journal(&mut self, journal: &JournalRecord) -> Result<(), AppError> {
        let final_path = managed_path(&self.root, &journal.relative_path, "books")?;
        let stage_path = managed_path(&self.root, &journal.stage_path, "staging")?;
        let raw_stage_path = (!journal.raw_stage_path.is_empty())
            .then(|| managed_path(&self.root, &journal.raw_stage_path, "staging"))
            .transpose()?;
        let source_path = (!journal.source_relative_path.is_empty())
            .then(|| managed_path(&self.root, &journal.source_relative_path, "sources"))
            .transpose()?;
        let committed: Option<(String, String, String)> = self
            .conn
            .query_row(
                "SELECT book_id, relative_path, sha256 FROM book_assets WHERE id = ?1",
                params![journal.asset_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        if let Some((_, committed_path, committed_hash)) = committed {
            self.cleanup_uncommitted_import_source(journal)?;
            // A duplicate import can journal an already committed asset. Keep
            // that identity and repair its missing file only when the staged
            // bytes match the committed hash. Never let an unfinished journal
            // create a new Book or BookAsset after restart.
            if committed_path == journal.relative_path && committed_hash == journal.sha256 {
                let final_valid = final_path.is_file()
                    && hash_file(&final_path).ok().as_deref() == Some(journal.sha256.as_str());
                let stage_valid = stage_path.is_file()
                    && hash_file(&stage_path).ok().as_deref() == Some(journal.sha256.as_str());
                if !final_valid && stage_valid {
                    if final_path.exists() {
                        remove_owned_file(&final_path)?;
                    }
                    if let Some(parent) = final_path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::rename(&stage_path, &final_path)?;
                    sync_parent(&final_path)?;
                }
                remove_owned_file(&stage_path)?;
                if let Some(raw_stage_path) = raw_stage_path.as_ref() {
                    remove_owned_file(raw_stage_path)?;
                }
            } else {
                remove_owned_file(&stage_path)?;
                if let Some(raw_stage_path) = raw_stage_path.as_ref() {
                    remove_owned_file(raw_stage_path)?;
                }
            }
            self.conn.execute(
                "DELETE FROM import_journal WHERE operation_id = ?1",
                params![journal.operation_id],
            )?;
            return Ok(());
        }

        // No asset row means the operation never committed. The journal owns
        // these exact managed paths; clean them and discard the journal.
        remove_owned_file(&stage_path)?;
        if let Some(raw_stage_path) = raw_stage_path.as_ref() {
            remove_owned_file(raw_stage_path)?;
        }
        let references: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM book_assets WHERE relative_path = ?1",
            params![journal.relative_path],
            |row| row.get(0),
        )?;
        if references == 0 {
            remove_owned_file(&final_path)?;
            if let Some(source_path) = source_path.as_ref() {
                remove_owned_file(source_path)?;
            }
        }
        self.conn.execute(
            "DELETE FROM import_journal WHERE operation_id = ?1",
            params![journal.operation_id],
        )?;
        Ok(())
    }

    fn cleanup_uncommitted_import_source(&self, journal: &JournalRecord) -> Result<(), AppError> {
        if journal.source_relative_path.is_empty() {
            return Ok(());
        }
        // Older journals also named existing sources. If the staged raw
        // bytes remain, their rename never happened and the live source is
        // not owned by this operation.
        if !journal.raw_stage_path.is_empty()
            && managed_path(&self.root, &journal.raw_stage_path, "staging")?.exists()
        {
            return Ok(());
        }
        let associated: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM txt_assets
             WHERE source_relative_path = ?1)",
            params![journal.source_relative_path],
            |row| row.get(0),
        )?;
        // An older duplicate journal may name a committed source with a
        // different byte representation and already have discarded its raw
        // stage. A database reference always takes precedence over that
        // ambiguous journal; new restorations use an operation-owned path.
        if !associated {
            remove_owned_file(&managed_path(
                &self.root,
                &journal.source_relative_path,
                "sources",
            )?)?;
        }
        Ok(())
    }

    fn remove_orphan_managed_files(&self) -> Result<(), AppError> {
        let referenced_books: HashSet<String> = {
            let mut statement = self.conn.prepare("SELECT relative_path FROM book_assets")?;
            let paths = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            paths
        };
        let referenced_sources: HashSet<String> = {
            let mut statement = self
                .conn
                .prepare("SELECT source_relative_path FROM txt_assets WHERE source_relative_path IS NOT NULL")?;
            let result = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            result
        };
        let books_root = self.root.join("books");
        remove_orphans_recursive(&books_root, &self.root, &referenced_books)?;
        let sources_root = self.root.join("sources");
        remove_orphans_recursive(&sources_root, &self.root, &referenced_sources)?;
        Ok(())
    }

    fn cleanup_staging_dir(&self) {
        let staging_dir = self.root.join("staging");
        let Ok(entries) = fs::read_dir(staging_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path.extension().is_some_and(|extension| {
                    extension == "part" || extension == "raw" || extension == "old"
                })
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// Run the optional test-only pause/failure hook before the application
/// storage mutex is acquired for the final commit. This keeps cancellation
/// responsive while a native test waits at the commit boundary.
pub(crate) fn before_import_commit(root: &Path, cancel: &AtomicBool) -> Result<(), AppError> {
    maybe_inject_failure(root, cancel, FailurePoint::BeforeFinalCommit)
}

pub(crate) fn duplicate_validation_retry(error: &AppError) -> bool {
    error.code == ErrorCode::ContentVersionMismatch && error.message == DUPLICATE_VALIDATION_RETRY
}

/// Re-importing identical source bytes must honor the book's current encoding,
/// including when its normalized file needs to be restored. Decode and index
/// that source outside the shared storage mutex before publication.
pub(crate) fn prepare_import_for_target(
    root: &Path,
    prepared: &mut PreparedImport,
    target: &ImportTargetSnapshot,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    if target.source_sha256.as_deref() != Some(prepared.source_sha256.as_str()) {
        return Ok(());
    }
    let Some(selected) = target.selected_encoding.as_ref() else {
        return Ok(());
    };
    if selected == &prepared.selected_encoding && prepared.sha256 == target.sha256 {
        return Ok(());
    }
    let raw_path = managed_path(root, &prepared.raw_stage_relative_path, "staging")?;
    let (bytes, _) = read_cancelable_file(&raw_path, cancel, |_, _| {})?;
    let decoded = detect_and_decode(&bytes, selected.clone())?;
    let sha256 = sha256_bytes(decoded.text.as_bytes());
    if sha256 != target.sha256 {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "the retained encoding no longer reproduces the committed book",
        ));
    }
    let index_json = serde_json::to_string(&build_sparse_index(&decoded.text))?;
    if cancel.load(Ordering::Acquire) {
        return Err(import_cancelled());
    }
    let stage_path = managed_path(root, &prepared.stage_relative_path, "staging")?;
    let mut stage = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(stage_path)?;
    stage.write_all(decoded.text.as_bytes())?;
    stage.sync_all()?;
    prepared.sha256 = sha256;
    prepared.byte_length = decoded.text.len() as u64;
    prepared.index_json = index_json;
    prepared.selected_encoding = decoded.selected;
    prepared.detected_encoding = decoded.detected;
    prepared.decode_state = decoded.state;
    Ok(())
}

/// Validate a duplicate import target without borrowing `Storage`. A missing
/// managed file is returned as an empty fingerprint so the commit path can
/// republish the staged bytes; an existing file must still match the stored
/// normalized hash.
pub(crate) fn validate_import_target(
    root: &Path,
    snapshot: &ImportTargetSnapshot,
    cancel: &AtomicBool,
) -> Result<ImportTargetSnapshot, AppError> {
    let path = managed_path(root, &snapshot.relative_path, "books")?;
    let Some(expected_fingerprint) = snapshot.fingerprint.as_ref() else {
        return Ok(snapshot.clone());
    };
    let actual_hash = match hash_file_with_cancel(&path, Some(cancel)) {
        Ok(hash) => hash,
        Err(error) if error.code == ErrorCode::AssetMissing => {
            return Ok(ImportTargetSnapshot {
                fingerprint: None,
                ..snapshot.clone()
            });
        }
        Err(error) => return Err(error),
    };
    if actual_hash != snapshot.sha256 {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "managed duplicate target changed while being validated",
        ));
    }
    let (_, fingerprint) = file_fingerprint(&path)?;
    if &fingerprint != expected_fingerprint {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "managed duplicate target changed while being validated",
        ));
    }
    Ok(ImportTargetSnapshot {
        fingerprint: Some(fingerprint),
        ..snapshot.clone()
    })
}

/// Re-hash a retained source after decoding preparation and before publication.
/// This stays outside the storage mutex in command workers, so a same-length
/// replacement cannot leave the new normalized asset paired with stale source
/// metadata.
pub(crate) fn verify_prepared_txt_decode_source(
    root: &Path,
    prepared: &PreparedTxtDecode,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let source_path = managed_path(root, &prepared.snapshot.source_relative_path, "sources")?;
    let result = hash_file_with_cancel(&source_path, Some(cancel)).and_then(|actual| {
        if actual != prepared.source_sha256 {
            Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "retained TXT source bytes changed after decoding",
            ))
        } else {
            Ok(())
        }
    });
    if let Err(error) = result {
        let stage_path = managed_path(root, &prepared.stage_relative_path, "staging")?;
        if let Err(cleanup_error) = remove_owned_file(&stage_path) {
            return Err(AppError::new(
                error.code,
                format!(
                    "{}; TXT decode staging cleanup failed: {}",
                    error.message, cleanup_error.message
                ),
            ));
        }
        return Err(error);
    }
    Ok(())
}

/// Verify an asset and produce the only index that readers may use. On the
/// first read in a process this reads the complete file once, hashes those
/// exact bytes, and builds the sparse index from the same UTF-8 string. A
/// persisted index with plausible monotonic offsets is therefore still
/// replaced when any checkpoint is wrong.
pub(crate) fn verify_content_context(
    context: &ContentReadContext,
) -> Result<VerifiedContentIndex, AppError> {
    let path = managed_path(&context.root, &context.record.relative_path, "books")?;
    let (metadata, fingerprint) = file_fingerprint(&path)?;
    if metadata.len() != context.record.asset.byte_length {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            format!(
                "managed asset {} has an unexpected byte length",
                context.record.asset.id
            ),
        ));
    }

    if let Some(verified) = context.verified.as_ref() {
        if verified.fingerprint == fingerprint
            && verified.index.byte_length == metadata.len()
            && valid_index(&verified.index)
        {
            // A metadata check before and after the cache lookup closes the
            // window where a same-length replacement is made during a read.
            let (_, after_fingerprint) = file_fingerprint(&path)?;
            if after_fingerprint != fingerprint {
                return Err(content_changed_error(
                    &context.record.asset.id,
                    "while being verified",
                ));
            }
            return Ok(verified.clone());
        }
    }

    let bytes = read_file_checked(&path, metadata.len(), &fingerprint)?;
    let actual_hash = sha256_bytes(&bytes);
    if actual_hash != context.record.asset.sha256 {
        return Err(content_changed_error(
            &context.record.asset.id,
            "since import",
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            ErrorCode::UnsupportedEncoding,
            "managed TXT asset is not UTF-8",
        )
    })?;
    let rebuilt = build_sparse_index(&text);
    if !valid_index(&rebuilt) {
        return Err(AppError::new(
            ErrorCode::Database,
            "content index builder produced an invalid index",
        ));
    }

    // Keep this comparison explicit: it documents that a valid-looking
    // persisted JSON record is only metadata, while `rebuilt` is authoritative
    // for byte/UTF-16 boundaries.
    let _persisted_matches = context.persisted.as_ref().is_some_and(|persisted| {
        persisted.fingerprint == fingerprint && persisted.index == rebuilt
    });

    Ok(VerifiedContentIndex {
        index: rebuilt,
        fingerprint,
    })
}

pub(crate) fn read_content_window_from_context(
    request: &ReadContentRequest,
    context: &ContentReadContext,
    verified: &VerifiedContentIndex,
) -> Result<ContentWindow, AppError> {
    let index = &verified.index;
    let fingerprint = &verified.fingerprint;
    if request.book_id.trim().is_empty() {
        return Err(AppError::invalid_argument("book_id cannot be empty"));
    }
    if request.max_units == 0 || request.max_units > MAX_WINDOW_UNITS {
        return Err(AppError::invalid_argument(format!(
            "content window must contain between 1 and {MAX_WINDOW_UNITS} UTF-16 units"
        )));
    }
    if let Some(locator) = request.locator.as_ref() {
        validate_locator(&context.root, &context.record, index, locator, fingerprint)?;
    }

    let total_length = index.utf16_length;
    let anchor = match request.direction {
        WindowDirection::Forward => request.locator.as_ref().map_or(0, |locator| locator.offset),
        WindowDirection::Backward => request
            .locator
            .as_ref()
            .map_or(total_length, |locator| locator.offset),
    };
    if anchor > total_length {
        return Err(AppError::new(
            ErrorCode::InvalidLocator,
            "locator offset is beyond the content length",
        ));
    }

    let (start_offset, end_offset) = match request.direction {
        WindowDirection::Forward => {
            let target = anchor.saturating_add(request.max_units).min(total_length);
            let end = boundary_for_offset(
                &context.root,
                &context.record.relative_path,
                index,
                target,
                BoundaryMode::Ceiling,
                fingerprint,
            )?;
            (anchor, end.utf16_offset)
        }
        WindowDirection::Backward => {
            let target = anchor.saturating_sub(request.max_units);
            let start = boundary_for_offset(
                &context.root,
                &context.record.relative_path,
                index,
                target,
                BoundaryMode::Floor,
                fingerprint,
            )?;
            (start.utf16_offset, anchor)
        }
    };

    let start_byte = boundary_for_offset(
        &context.root,
        &context.record.relative_path,
        index,
        start_offset,
        BoundaryMode::Exact,
        fingerprint,
    )?;
    let end_byte = boundary_for_offset(
        &context.root,
        &context.record.relative_path,
        index,
        end_offset,
        BoundaryMode::Exact,
        fingerprint,
    )?;
    let text = read_range(
        &context.root,
        &context.record.relative_path,
        start_byte.byte_offset,
        end_byte.byte_offset,
        fingerprint,
    )?;
    let locator = locator_for(
        &context.root,
        &context.record,
        index,
        start_offset,
        start_byte.byte_offset,
        fingerprint,
    )?;
    Ok(ContentWindow {
        book_id: request.book_id.clone(),
        resource_id: context.record.asset.id.clone(),
        content_version: context.record.asset.content_version.clone(),
        text,
        start_offset,
        end_offset,
        total_length,
        has_before: start_offset > 0,
        has_after: end_offset < total_length,
        locator,
    })
}

pub(crate) fn resolve_locator_from_context(
    request: &ResolveLocatorRequest,
    context: &ContentReadContext,
    verified: &VerifiedContentIndex,
) -> Result<ReaderLocator, AppError> {
    let target = (verified.index.utf16_length as f64 * request.progress).floor() as u64;
    let boundary = boundary_for_offset(
        &context.root,
        &context.record.relative_path,
        &verified.index,
        target,
        BoundaryMode::Floor,
        &verified.fingerprint,
    )?;
    locator_for(
        &context.root,
        &context.record,
        &verified.index,
        boundary.utf16_offset,
        boundary.byte_offset,
        &verified.fingerprint,
    )
}

pub(crate) fn validate_content_locator(
    context: &ContentReadContext,
    verified: &VerifiedContentIndex,
    locator: &ReaderLocator,
) -> Result<(), AppError> {
    validate_locator(
        &context.root,
        &context.record,
        &verified.index,
        locator,
        &verified.fingerprint,
    )
}

fn read_verified_text(
    context: &ContentReadContext,
    verified: &VerifiedContentIndex,
) -> Result<String, AppError> {
    let path = managed_path(&context.root, &context.record.relative_path, "books")?;
    let bytes = read_bytes(
        &path,
        0,
        verified.index.byte_length,
        Some(&verified.fingerprint),
    )?;
    String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            ErrorCode::UnsupportedEncoding,
            "managed TXT asset is not valid normalized UTF-8",
        )
    })
}

pub(crate) fn build_toc_from_context(
    context: &ContentReadContext,
    verified: &VerifiedContentIndex,
    book_id: &str,
) -> Result<Vec<TocEntry>, AppError> {
    let text = read_verified_text(context, verified)?;
    let mut entries = build_toc(&text, book_id, &context.record.asset.content_version);
    entries.iter_mut().for_each(|entry| {
        entry.locator.resource_id = context.record.asset.id.clone();
    });
    Ok(entries)
}

fn search_text_stream(
    context: &ContentReadContext,
    verified: &VerifiedContentIndex,
    parameters: SearchParameters<'_>,
    cancel: Option<&AtomicBool>,
) -> Result<(Vec<SearchMatch>, Option<u64>, bool), AppError> {
    let SearchParameters {
        book_id,
        content_version,
        query,
        case_sensitive,
        cursor,
        limit,
    } = parameters;
    if query.is_empty() || limit == 0 {
        return Ok((Vec::new(), None, false));
    }
    let needle: Vec<char> = query.chars().collect();
    if needle.is_empty() {
        return Ok((Vec::new(), None, false));
    }
    let path = managed_path(&context.root, &context.record.relative_path, "books")?;
    let mut pending = Vec::new();
    let mut utf16_offset = 0_u64;
    let mut ring: Vec<(char, u64)> = Vec::with_capacity(needle.len());
    let mut seen = 0_u64;
    let mut matches = Vec::new();
    let mut byte_offset = 0_u64;
    const CHUNK_BYTES: u64 = 64 * 1024;
    while byte_offset < verified.index.byte_length {
        if cancel.is_some_and(|token| token.load(Ordering::Acquire)) {
            return Err(AppError::new(
                ErrorCode::ImportCancelled,
                "search was cancelled",
            ));
        }
        let chunk_length = CHUNK_BYTES.min(verified.index.byte_length - byte_offset);
        pending.extend(read_bytes(
            &path,
            byte_offset,
            chunk_length,
            Some(&verified.fingerprint),
        )?);
        byte_offset += chunk_length;
        let valid_length = match std::str::from_utf8(&pending) {
            Ok(text) => text.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => {
                return Err(AppError::new(
                    ErrorCode::UnsupportedEncoding,
                    "managed TXT asset is not valid normalized UTF-8",
                ));
            }
        };
        let remainder = pending.split_off(valid_length);
        let text = std::str::from_utf8(&pending).map_err(|_| {
            AppError::new(
                ErrorCode::UnsupportedEncoding,
                "managed TXT asset is not valid normalized UTF-8",
            )
        })?;
        for character in text.chars() {
            let start_offset = utf16_offset;
            utf16_offset += character.len_utf16() as u64;
            ring.push((character, start_offset));
            if ring.len() > needle.len() {
                ring.remove(0);
            }
            if ring.len() != needle.len() || !chars_match(&ring, &needle, case_sensitive) {
                continue;
            }
            let match_start = ring[0].1;
            let match_end = utf16_offset;
            if seen < cursor {
                seen += 1;
                continue;
            }
            if matches.len() >= limit as usize {
                return Ok((matches, Some(seen), true));
            }
            let start_boundary = boundary_for_offset(
                &context.root,
                &context.record.relative_path,
                &verified.index,
                match_start,
                BoundaryMode::Exact,
                &verified.fingerprint,
            )?;
            let excerpt_start = boundary_for_offset(
                &context.root,
                &context.record.relative_path,
                &verified.index,
                match_start.saturating_sub(32),
                BoundaryMode::Floor,
                &verified.fingerprint,
            )?;
            let excerpt_end = boundary_for_offset(
                &context.root,
                &context.record.relative_path,
                &verified.index,
                match_end
                    .saturating_add(32)
                    .min(verified.index.utf16_length),
                BoundaryMode::Ceiling,
                &verified.fingerprint,
            )?;
            let excerpt = read_range(
                &context.root,
                &context.record.relative_path,
                excerpt_start.byte_offset,
                excerpt_end.byte_offset,
                &verified.fingerprint,
            )?;
            let mut locator = locator_for(
                &context.root,
                &context.record,
                &verified.index,
                match_start,
                start_boundary.byte_offset,
                &verified.fingerprint,
            )?;
            locator.book_id = book_id.to_string();
            locator.content_version = content_version.to_string();
            matches.push(SearchMatch {
                ordinal: seen,
                locator,
                excerpt,
                match_start,
                match_end,
            });
            seen += 1;
        }
        pending = remainder;
    }
    if !pending.is_empty() {
        return Err(AppError::new(
            ErrorCode::UnsupportedEncoding,
            "managed TXT asset ends with an incomplete UTF-8 sequence",
        ));
    }
    Ok((matches, None, false))
}

fn chars_match(window: &[(char, u64)], needle: &[char], case_sensitive: bool) -> bool {
    window.iter().zip(needle).all(|((left, _), right)| {
        if case_sensitive {
            left == right
        } else {
            left.to_lowercase().eq(right.to_lowercase())
        }
    })
}

fn build_sparse_index(text: &str) -> SparseIndex {
    let mut entries = vec![IndexEntry {
        utf16_offset: 0,
        byte_offset: 0,
    }];
    let mut utf16_offset = 0_u64;
    let mut next_checkpoint = INDEX_STRIDE_UNITS;
    for (byte_offset, character) in text.char_indices() {
        utf16_offset += character.len_utf16() as u64;
        let next_byte = byte_offset + character.len_utf8();
        if utf16_offset >= next_checkpoint {
            entries.push(IndexEntry {
                utf16_offset,
                byte_offset: next_byte as u64,
            });
            next_checkpoint = ((utf16_offset / INDEX_STRIDE_UNITS) + 1) * INDEX_STRIDE_UNITS;
        }
    }
    let byte_length = text.len() as u64;
    let utf16_length = utf16_offset;
    if entries
        .last()
        .map_or(true, |entry| entry.utf16_offset != utf16_length)
    {
        entries.push(IndexEntry {
            utf16_offset: utf16_length,
            byte_offset: byte_length,
        });
    }
    SparseIndex {
        schema_version: INDEX_SCHEMA_VERSION,
        stride_units: INDEX_STRIDE_UNITS,
        byte_length,
        utf16_length,
        entries,
    }
}

fn valid_index(index: &SparseIndex) -> bool {
    if index.schema_version != INDEX_SCHEMA_VERSION
        || index.stride_units != INDEX_STRIDE_UNITS
        || index.entries.is_empty()
        || index.entries[0].utf16_offset != 0
        || index.entries[0].byte_offset != 0
    {
        return false;
    }
    let mut previous = index.entries[0];
    for entry in index.entries.iter().skip(1) {
        if entry.utf16_offset <= previous.utf16_offset
            || entry.byte_offset <= previous.byte_offset
            || entry.utf16_offset > index.utf16_length
            || entry.byte_offset > index.byte_length
        {
            return false;
        }
        previous = *entry;
    }
    previous.utf16_offset == index.utf16_length && previous.byte_offset == index.byte_length
}

fn parse_index(serialized: &str) -> Result<SparseIndex, AppError> {
    let index: SparseIndex = serde_json::from_str(serialized).map_err(|error| {
        AppError::new(
            ErrorCode::Database,
            format!("content index is invalid: {error}"),
        )
    })?;
    if !valid_index(&index) {
        return Err(AppError::new(
            ErrorCode::Database,
            "content index failed validation",
        ));
    }
    Ok(index)
}

fn boundary_for_offset(
    root: &Path,
    relative_path: &str,
    index: &SparseIndex,
    target: u64,
    mode: BoundaryMode,
    fingerprint: &str,
) -> Result<Boundary, AppError> {
    if target > index.utf16_length {
        return Err(AppError::new(
            ErrorCode::InvalidLocator,
            format!("offset {target} is beyond the content length"),
        ));
    }
    let checkpoint = index
        .entries
        .iter()
        .rev()
        .find(|entry| entry.utf16_offset <= target)
        .copied()
        .ok_or_else(|| AppError::new(ErrorCode::Database, "content index has no base entry"))?;
    if checkpoint.utf16_offset == target {
        return Ok(Boundary {
            utf16_offset: target,
            byte_offset: checkpoint.byte_offset,
        });
    }

    let path = managed_path(root, relative_path, "books")?;
    let delta_units = target.saturating_sub(checkpoint.utf16_offset);
    let wanted_bytes = delta_units.saturating_mul(4).saturating_add(8);
    let available = index.byte_length.saturating_sub(checkpoint.byte_offset);
    let mut bytes = read_bytes(
        &path,
        checkpoint.byte_offset,
        wanted_bytes.min(available),
        Some(fingerprint),
    )?;
    loop {
        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            Err(error) if error.error_len().is_none() => {
                if bytes.len() as u64 >= available {
                    return Err(AppError::new(
                        ErrorCode::UnsupportedEncoding,
                        "managed TXT asset is not UTF-8",
                    ));
                }
                let more = read_bytes(
                    &path,
                    checkpoint.byte_offset + bytes.len() as u64,
                    (available - bytes.len() as u64).min(8),
                    Some(fingerprint),
                )?;
                if more.is_empty() {
                    return Err(AppError::new(
                        ErrorCode::UnsupportedEncoding,
                        "managed TXT asset is not UTF-8",
                    ));
                }
                bytes.extend_from_slice(&more);
                continue;
            }
            Err(_) => {
                return Err(AppError::new(
                    ErrorCode::UnsupportedEncoding,
                    "managed TXT asset is not UTF-8",
                ));
            }
        };

        let mut offset = checkpoint.utf16_offset;
        let mut byte = checkpoint.byte_offset;
        for character in text.chars() {
            let next_offset = offset + character.len_utf16() as u64;
            let next_byte = byte + character.len_utf8() as u64;
            if target == next_offset {
                return Ok(Boundary {
                    utf16_offset: target,
                    byte_offset: next_byte,
                });
            }
            if target < next_offset {
                return match mode {
                    BoundaryMode::Exact => Err(AppError::new(
                        ErrorCode::InvalidLocator,
                        format!("offset {target} is not a UTF-16 scalar boundary"),
                    )),
                    BoundaryMode::Floor => Ok(Boundary {
                        utf16_offset: offset,
                        byte_offset: byte,
                    }),
                    BoundaryMode::Ceiling => Ok(Boundary {
                        utf16_offset: next_offset,
                        byte_offset: next_byte,
                    }),
                };
            }
            offset = next_offset;
            byte = next_byte;
        }
        if offset >= target {
            return Ok(Boundary {
                utf16_offset: offset,
                byte_offset: byte,
            });
        }
        if bytes.len() as u64 >= available {
            return Err(AppError::new(
                ErrorCode::Database,
                "content index does not cover the requested offset",
            ));
        }
        let more = read_bytes(
            &path,
            checkpoint.byte_offset + bytes.len() as u64,
            (available - bytes.len() as u64).min(16 * 1024),
            Some(fingerprint),
        )?;
        if more.is_empty() {
            return Err(AppError::new(
                ErrorCode::Database,
                "content index does not cover the requested offset",
            ));
        }
        bytes.extend_from_slice(&more);
    }
}

fn locator_for(
    root: &Path,
    record: &AssetRecord,
    index: &SparseIndex,
    offset: u64,
    byte_offset: u64,
    fingerprint: &str,
) -> Result<ReaderLocator, AppError> {
    let path = managed_path(root, &record.relative_path, "books")?;
    let before_start = byte_offset.saturating_sub(CONTEXT_BYTES);
    let mut before_bytes = read_bytes(
        &path,
        before_start,
        byte_offset - before_start,
        Some(fingerprint),
    )?;
    while std::str::from_utf8(&before_bytes).is_err() && !before_bytes.is_empty() {
        before_bytes.remove(0);
    }
    let before_text = std::str::from_utf8(&before_bytes).unwrap_or_default();
    let context_before: String = before_text
        .chars()
        .rev()
        .take(32)
        .collect::<String>()
        .chars()
        .rev()
        .collect();

    let available_after = index.byte_length.saturating_sub(byte_offset);
    let mut after_bytes = read_bytes(
        &path,
        byte_offset,
        available_after.min(CONTEXT_BYTES),
        Some(fingerprint),
    )?;
    while std::str::from_utf8(&after_bytes).is_err() && !after_bytes.is_empty() {
        after_bytes.pop();
    }
    let after_text = std::str::from_utf8(&after_bytes).unwrap_or_default();
    let context_after: String = after_text.chars().take(32).collect();

    Ok(ReaderLocator {
        book_id: record.asset.book_id.clone(),
        content_version: record.asset.content_version.clone(),
        resource_id: record.asset.id.clone(),
        offset,
        context_before,
        context_after,
    })
}

fn validate_locator(
    root: &Path,
    record: &AssetRecord,
    index: &SparseIndex,
    locator: &ReaderLocator,
    fingerprint: &str,
) -> Result<(), AppError> {
    if locator.book_id != record.asset.book_id {
        return Err(AppError::new(
            ErrorCode::InvalidLocator,
            "locator belongs to another book",
        ));
    }
    if locator.content_version != record.asset.content_version {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            format!(
                "locator targets content version {}, current version is {}",
                locator.content_version, record.asset.content_version
            ),
        ));
    }
    if locator.resource_id != record.asset.id {
        return Err(AppError::new(
            ErrorCode::InvalidLocator,
            "locator targets an unknown resource",
        ));
    }
    boundary_for_offset(
        root,
        &record.relative_path,
        index,
        locator.offset,
        BoundaryMode::Exact,
        fingerprint,
    )
    .map(|_| ())
}

fn read_range(
    root: &Path,
    relative_path: &str,
    start: u64,
    end: u64,
    fingerprint: &str,
) -> Result<String, AppError> {
    if end < start {
        return Err(AppError::new(
            ErrorCode::Database,
            "invalid content byte range",
        ));
    }
    let path = managed_path(root, relative_path, "books")?;
    let bytes = read_bytes(&path, start, end - start, Some(fingerprint))?;
    String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            ErrorCode::UnsupportedEncoding,
            "managed TXT asset is not UTF-8",
        )
    })
}

fn read_bytes(
    path: &Path,
    start: u64,
    length: u64,
    expected_fingerprint: Option<&str>,
) -> Result<Vec<u8>, AppError> {
    let (_, before_fingerprint) = file_fingerprint(path)?;
    if expected_fingerprint.is_some_and(|expected| expected != before_fingerprint) {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "managed content changed while reading",
        ));
    }
    let mut file = File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(ErrorCode::AssetMissing, "managed content file is missing")
        } else {
            AppError::new(ErrorCode::Io, error.to_string())
        }
    })?;
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity(length.min(64 * 1024 * 1024) as usize);
    file.take(length).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != length {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "managed content changed while reading",
        ));
    }
    let (_, after_fingerprint) = file_fingerprint(path)?;
    if after_fingerprint != before_fingerprint
        || expected_fingerprint.is_some_and(|expected| expected != after_fingerprint)
    {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "managed content changed while reading",
        ));
    }
    Ok(bytes)
}

fn read_cancelable_file<F>(
    path: &Path,
    cancel: &AtomicBool,
    mut report: F,
) -> Result<(Vec<u8>, u64), AppError>
where
    F: FnMut(u64, u64),
{
    let metadata = fs::metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                ErrorCode::AssetMissing,
                "retained TXT source bytes are missing",
            )
        } else {
            AppError::new(ErrorCode::Io, error.to_string())
        }
    })?;
    if !metadata.is_file() {
        return Err(AppError::new(
            ErrorCode::AssetMissing,
            "retained TXT source path is not a file",
        ));
    }
    let total = metadata.len();
    let (_, fingerprint_before) = file_fingerprint(path)?;
    let mut file = File::open(path)?;
    let mut bytes = Vec::with_capacity(total.min(8 * 1024 * 1024) as usize);
    let mut chunk = [0_u8; 64 * 1024];
    let mut read_total = 0_u64;
    report(0, total);
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(import_cancelled());
        }
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        read_total += read as u64;
        report(read_total, total);
    }
    let final_metadata = fs::metadata(path)?;
    let (_, fingerprint_after) = file_fingerprint(path)?;
    if read_total != total
        || final_metadata.len() != total
        || fingerprint_before != fingerprint_after
    {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "retained TXT source bytes changed while reading",
        ));
    }
    Ok((bytes, total))
}

fn read_file_checked(
    path: &Path,
    expected_length: u64,
    expected_fingerprint: &str,
) -> Result<Vec<u8>, AppError> {
    let bytes = read_bytes(path, 0, expected_length, Some(expected_fingerprint))?;
    if bytes.len() as u64 != expected_length {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "managed content was truncated while reading",
        ));
    }
    Ok(bytes)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn content_changed_error(asset_id: &str, suffix: &str) -> AppError {
    AppError::new(
        ErrorCode::ContentVersionMismatch,
        format!("managed asset {asset_id} changed {suffix}"),
    )
}

fn hash_file(path: &Path) -> Result<String, AppError> {
    hash_file_with_cancel(path, None)
}

fn hash_file_with_cancel(path: &Path, cancel: Option<&AtomicBool>) -> Result<String, AppError> {
    let (metadata_before, fingerprint_before) = file_fingerprint(path)?;
    let mut file = File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(ErrorCode::AssetMissing, "managed content file is missing")
        } else {
            AppError::new(ErrorCode::Io, error.to_string())
        }
    })?;
    let mut hasher = Sha256::new();
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        if cancel.is_some_and(|cancel| cancel.load(Ordering::Acquire)) {
            return Err(import_cancelled());
        }
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    let (metadata_after, fingerprint_after) = file_fingerprint(path)?;
    if metadata_after.len() != metadata_before.len() || fingerprint_after != fingerprint_before {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "managed content changed while hashing",
        ));
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn file_fingerprint(path: &Path) -> Result<(Metadata, String), AppError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(ErrorCode::AssetMissing, "managed content file is missing")
        } else {
            AppError::new(ErrorCode::Io, error.to_string())
        }
    })?;
    if !metadata.is_file() {
        return Err(AppError::new(
            ErrorCode::AssetMissing,
            "managed content path is not a file",
        ));
    }
    let fingerprint = fingerprint_for_metadata(&metadata);
    Ok((metadata, fingerprint))
}

fn fingerprint_for_metadata(metadata: &Metadata) -> String {
    #[cfg(unix)]
    let fingerprint = format!(
        "{}:{}:{}:{}:{}:{}:{}",
        metadata.len(),
        metadata.dev(),
        metadata.ino(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    );
    #[cfg(not(unix))]
    let fingerprint = {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| format!("{}:{}", duration.as_secs(), duration.subsec_nanos()))
            .unwrap_or_default();
        format!("{}:{modified}", metadata.len())
    };
    fingerprint
}

fn managed_path(root: &Path, relative: &str, top_level: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(relative);
    if path.is_absolute()
        || !matches!(
            path.components().next(),
            Some(Component::Normal(value)) if value == top_level
        )
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::new(
            ErrorCode::Database,
            format!("invalid managed path {relative}"),
        ));
    }
    Ok(root.join(path))
}

fn remove_owned_file(path: &Path) -> Result<(), AppError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() {
        return Err(AppError::new(
            ErrorCode::Io,
            format!(
                "managed cleanup path is not a regular file: {}",
                path.display()
            ),
        ));
    }
    fs::remove_file(path)?;
    Ok(())
}

fn remove_orphans_recursive(
    directory: &Path,
    root: &Path,
    referenced: &HashSet<String>,
) -> Result<(), AppError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            remove_orphans_recursive(&path, root, referenced)?;
            let _ = fs::remove_dir(&path);
        } else if metadata.is_file() || metadata.file_type().is_symlink() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| {
                    AppError::new(ErrorCode::Database, "managed path escaped data directory")
                })?
                .to_string_lossy()
                .replace('\\', "/");
            if path.extension().is_some_and(|extension| extension == "txt")
                && !referenced.contains(&relative)
            {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn sync_parent(path: &Path) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        #[cfg(unix)]
        {
            let directory = File::open(parent)?;
            directory.sync_all()?;
        }
    }
    Ok(())
}

fn insert_txt_decode_journal(
    tx: &rusqlite::Transaction<'_>,
    journal: &TxtDecodeJournal,
) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO txt_decode_journal(
            operation_id, book_id, asset_id, old_content_version, relative_path,
            stage_path, backup_path, new_content_version, byte_length, index_json,
            source_sha256, detected_encoding, selected_encoding, decode_state, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            journal.operation_id,
            journal.book_id,
            journal.asset_id,
            journal.old_content_version,
            journal.relative_path,
            journal.stage_path,
            journal.backup_path,
            journal.new_content_version,
            journal.byte_length as i64,
            journal.index_json,
            journal.source_sha256,
            encoding_name(&journal.detected_encoding),
            encoding_name(&journal.selected_encoding),
            decode_state_name(&journal.decode_state),
            journal.created_at,
        ],
    )?;
    Ok(())
}

fn insert_journal(tx: &rusqlite::Transaction<'_>, journal: &JournalRecord) -> Result<(), AppError> {
    tx.execute(
        "INSERT INTO import_journal(
            operation_id, book_id, asset_id, title, sha256, byte_length, content_version,
            relative_path, stage_path, index_json, source_byte_length, created_at,
            raw_stage_path, source_relative_path, source_sha256,
            detected_encoding, selected_encoding, decode_state
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            journal.operation_id,
            journal.book_id,
            journal.asset_id,
            journal.title,
            journal.sha256,
            journal.byte_length as i64,
            journal.content_version,
            journal.relative_path,
            journal.stage_path,
            journal.index_json,
            journal.source_byte_length as i64,
            journal.created_at,
            journal.raw_stage_path,
            journal.source_relative_path,
            journal.source_sha256,
            encoding_name(&journal.detected_encoding),
            encoding_name(&journal.selected_encoding),
            decode_state_name(&journal.decode_state)
        ],
    )?;
    Ok(())
}

fn insert_content_index(
    conn: &Connection,
    asset_id: &str,
    index: &SparseIndex,
    fingerprint: &str,
) -> Result<(), AppError> {
    if !valid_index(index) {
        return Err(AppError::new(
            ErrorCode::Database,
            "refusing to persist an invalid content index",
        ));
    }
    let serialized = serde_json::to_string(index)?;
    conn.execute(
        "INSERT INTO content_indexes(
            asset_id, schema_version, stride_units, byte_length, utf16_length, fingerprint,
            index_json, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(asset_id) DO UPDATE SET schema_version = excluded.schema_version,
            stride_units = excluded.stride_units, byte_length = excluded.byte_length,
            utf16_length = excluded.utf16_length, fingerprint = excluded.fingerprint,
            index_json = excluded.index_json, updated_at = excluded.updated_at",
        params![
            asset_id,
            i64::from(index.schema_version),
            index.stride_units as i64,
            index.byte_length as i64,
            index.utf16_length as i64,
            fingerprint,
            serialized,
            now_millis()
        ],
    )?;
    Ok(())
}

fn book_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Book> {
    Ok(Book {
        id: row.get(0)?,
        title: row.get(1)?,
        author: row.get(2)?,
        content_version: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn asset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetRecord> {
    asset_from_columns(row, 0)
}

fn asset_from_columns(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<AssetRecord> {
    let kind: String = row.get(offset + 2)?;
    let kind = match kind.as_str() {
        "txt" => AssetKind::Txt,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                offset + 2,
                rusqlite::types::Type::Text,
                format!("unsupported asset kind {kind}").into(),
            ));
        }
    };
    let byte_length: i64 = row.get(offset + 4)?;
    Ok(AssetRecord {
        asset: BookAsset {
            id: row.get(offset)?,
            book_id: row.get(offset + 1)?,
            kind,
            sha256: row.get(offset + 3)?,
            byte_length: byte_length.max(0) as u64,
            content_version: row.get(offset + 5)?,
            availability: AssetAvailability::Missing,
            created_at: row.get(offset + 7)?,
        },
        relative_path: row.get(offset + 6)?,
    })
}

fn journal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JournalRecord> {
    let byte_length: i64 = row.get(5)?;
    let source_byte_length: i64 = row.get(10)?;
    Ok(JournalRecord {
        operation_id: row.get(0)?,
        book_id: row.get(1)?,
        asset_id: row.get(2)?,
        title: row.get(3)?,
        sha256: row.get(4)?,
        byte_length: byte_length.max(0) as u64,
        content_version: row.get(6)?,
        relative_path: row.get(7)?,
        stage_path: row.get(8)?,
        raw_stage_path: row.get(12).unwrap_or_default(),
        source_relative_path: row.get(13).unwrap_or_default(),
        source_sha256: row.get(14).unwrap_or_default(),
        detected_encoding: parse_encoding(
            row.get::<_, String>(15)
                .unwrap_or_else(|_| "utf8".to_string()),
        ),
        selected_encoding: parse_encoding(
            row.get::<_, String>(16)
                .unwrap_or_else(|_| "utf8".to_string()),
        ),
        decode_state: parse_decode_state(
            row.get::<_, String>(17)
                .unwrap_or_else(|_| "clean".to_string()),
        ),
        index_json: row.get(9)?,
        source_byte_length: source_byte_length.max(0) as u64,
        created_at: row.get(11)?,
    })
}

fn txt_decode_journal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TxtDecodeJournal> {
    let byte_length: i64 = row.get(8)?;
    Ok(TxtDecodeJournal {
        operation_id: row.get(0)?,
        book_id: row.get(1)?,
        asset_id: row.get(2)?,
        old_content_version: row.get(3)?,
        relative_path: row.get(4)?,
        stage_path: row.get(5)?,
        backup_path: row.get(6)?,
        new_content_version: row.get(7)?,
        byte_length: byte_length.max(0) as u64,
        index_json: row.get(9)?,
        source_sha256: row.get(10)?,
        detected_encoding: parse_encoding(row.get(11)?),
        selected_encoding: parse_encoding(row.get(12)?),
        decode_state: parse_decode_state(row.get(13)?),
        created_at: row.get(14)?,
    })
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Untitled".to_string())
}

fn encoding_name(encoding: &TxtEncoding) -> &'static str {
    match encoding {
        TxtEncoding::Auto => "auto",
        TxtEncoding::Utf8 => "utf8",
        TxtEncoding::Gb18030 => "gb18030",
        TxtEncoding::Gbk => "gbk",
        TxtEncoding::Utf16Le => "utf16le",
        TxtEncoding::Utf16Be => "utf16be",
    }
}

fn parse_encoding(value: String) -> TxtEncoding {
    match value.to_ascii_lowercase().as_str() {
        "auto" => TxtEncoding::Auto,
        "gb18030" => TxtEncoding::Gb18030,
        "gbk" | "gb2312" => TxtEncoding::Gbk,
        "utf16le" | "utf-16le" => TxtEncoding::Utf16Le,
        "utf16be" | "utf-16be" => TxtEncoding::Utf16Be,
        _ => TxtEncoding::Utf8,
    }
}

fn decode_state_name(state: &TxtDecodeState) -> &'static str {
    match state {
        TxtDecodeState::Clean => "clean",
        TxtDecodeState::ReplacementCharacters => "replacement_characters",
    }
}

fn parse_decode_state(value: String) -> TxtDecodeState {
    if value == "replacement_characters" {
        TxtDecodeState::ReplacementCharacters
    } else {
        TxtDecodeState::Clean
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn import_cancelled() -> AppError {
    AppError::new(ErrorCode::ImportCancelled, "TXT import was cancelled")
}

#[derive(Debug, Clone, Copy)]
enum FailurePoint {
    AfterJournal = 1,
    AfterRename = 2,
    BeforeFinalCommit = 3,
    #[cfg(test)]
    SavePosition = 4,
}

#[cfg(test)]
thread_local! {
    static TEST_FAILURE_POINT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn set_test_failure(point: FailurePoint) {
    TEST_FAILURE_POINT.with(|value| value.set(point as u8));
}

fn maybe_inject_failure(
    root: &Path,
    cancel: &AtomicBool,
    point: FailurePoint,
) -> Result<(), AppError> {
    let _ = (root, cancel, point);
    #[cfg(feature = "native-test")]
    if let Some(fault) = native_fault(root) {
        match (point, fault.as_str()) {
            (FailurePoint::AfterRename, "crash-after-rename")
            | (FailurePoint::AfterRename, "after-rename") => {
                // This hook exists only in native-test builds and is accepted
                // only for the explicitly configured isolated test root.
                let _ = fs::write(root.join(".native-fault-reached"), b"after-rename\n");
                std::process::abort();
            }
            (FailurePoint::BeforeFinalCommit, "pause-before-commit") => {
                let marker = root.join(".native-paused");
                fs::write(&marker, b"pause-before-commit\n").map_err(|error| {
                    AppError::new(
                        ErrorCode::Io,
                        format!("unable to write native pause marker: {error}"),
                    )
                })?;
                while native_fault(root).as_deref() == Some("pause-before-commit") {
                    if cancel.load(Ordering::Acquire) {
                        let _ = fs::remove_file(marker);
                        return Err(import_cancelled());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                let _ = fs::remove_file(marker);
            }
            (FailurePoint::BeforeFinalCommit, "before-final-commit-error")
            | (FailurePoint::BeforeFinalCommit, "before-final-commit") => {
                return Err(AppError::new(
                    ErrorCode::Database,
                    "injected final import commit failure",
                ));
            }
            _ => {}
        }
    }
    #[cfg(not(feature = "native-test"))]
    let _ = (root, cancel);
    #[cfg(test)]
    if TEST_FAILURE_POINT.with(|value| value.get()) == point as u8 {
        TEST_FAILURE_POINT.with(|value| value.set(0));
        return Err(AppError::new(
            ErrorCode::Io,
            format!("injected import failure at {point:?}"),
        ));
    }
    Ok(())
}

fn maybe_inject_save_failure(root: &Path) -> Result<(), AppError> {
    let _ = root;
    #[cfg(feature = "native-test")]
    if native_fault(root).as_deref() == Some("save-position-error") {
        let _ = fs::write(root.join(".native-save-failed"), b"save-position-error\n");
        return Err(AppError::new(
            ErrorCode::Database,
            "injected save-position database failure",
        ));
    }
    #[cfg(test)]
    if TEST_FAILURE_POINT.with(|value| value.get()) == FailurePoint::SavePosition as u8 {
        TEST_FAILURE_POINT.with(|value| value.set(0));
        return Err(AppError::new(
            ErrorCode::Database,
            "injected save-position database failure",
        ));
    }
    Ok(())
}

#[cfg(feature = "native-test")]
fn native_fault(root: &Path) -> Option<String> {
    let configured_root = std::env::var_os("GRIPREAD_TEST_DATA_DIR")?;
    let configured_root = fs::canonicalize(configured_root).ok()?;
    let actual_root = fs::canonicalize(root).ok()?;
    if configured_root != actual_root {
        return None;
    }
    let marker_value = fs::read_to_string(root.join(".native-fault"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if marker_value.is_some() {
        return marker_value;
    }
    std::env::var("GRIPREAD_NATIVE_IMPORT_FAULT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("gripread-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_source(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn no_cancel() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn import(storage: &mut Storage, source: &Path, operation: &str) -> ImportResult {
        storage
            .import_txt(source, operation, &no_cancel(), |_, _, _| {})
            .unwrap()
    }

    #[test]
    fn import_normalizes_and_deduplicates_by_normalized_hash() {
        let root = TestRoot::new();
        let source_one = write_source(&root.0, "first.txt", b"\xef\xbb\xbfhello\r\nworld\r!\n");
        let source_two = write_source(&root.0, "renamed.txt", b"hello\nworld\n!\n");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();

        let first = import(&mut storage, &source_one, "one");
        let window = storage
            .read_content_window(&first.book.id, None, 64)
            .unwrap();
        assert_eq!(window.text, "hello\nworld\n!\n");

        let second = import(&mut storage, &source_two, "two");
        assert!(second.duplicate);
        assert_eq!(first.book.id, second.book.id);
        assert_eq!(first.asset.id, second.asset.id);
        assert_eq!(storage.list_books().unwrap().len(), 1);
    }

    #[test]
    fn m1_txt_metadata_tools_and_manual_encoding_switch_persist() {
        let root = TestRoot::new();
        let source = write_source(
            &root.0,
            "chapters.txt",
            "第一章 开始😀\n正文中文\nChapter 2\n结尾\n".as_bytes(),
        );
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "m1");
        let info = storage.txt_encoding_for_book(&imported.book.id).unwrap();
        assert!(info.can_change);
        assert_eq!(info.selected, TxtEncoding::Auto);

        let toc = storage.list_toc(&imported.book.id).unwrap();
        assert_eq!(toc.len(), 2);
        assert_eq!(toc[0].title, "第一章 开始😀");
        let locator = storage
            .read_content_window(&imported.book.id, None, 64)
            .unwrap()
            .locator;
        let bookmark = storage
            .add_bookmark(&BookmarkRequest {
                book_id: imported.book.id.clone(),
                locator: locator.clone(),
                excerpt: "开头".to_string(),
            })
            .unwrap();
        assert_eq!(storage.list_bookmarks(&imported.book.id).unwrap().len(), 1);
        let result = storage
            .search_book(&SearchRequest {
                book_id: imported.book.id.clone(),
                query: "中文".to_string(),
                case_sensitive: true,
                cursor: None,
                limit: 10,
                operation_id: None,
            })
            .unwrap();
        assert_eq!(result.matches.len(), 1);
        storage.delete_bookmark(&bookmark.id).unwrap();
        assert!(storage
            .list_bookmarks(&imported.book.id)
            .unwrap()
            .is_empty());

        let raw_path = app_root
            .join("sources")
            .join(format!("{}.txt", imported.asset.id));
        let replacement = [0xd6, 0xd0, 0xce, 0xc4];
        fs::write(&raw_path, replacement).unwrap();
        // This fixture models an explicit source re-association. Production
        // code refuses an unverified replacement before this metadata update.
        storage
            .conn
            .execute(
                "UPDATE txt_assets SET source_sha256 = ?1 WHERE asset_id = ?2",
                params![sha256_bytes(&replacement), imported.asset.id],
            )
            .unwrap();
        let switched = storage
            .set_txt_encoding(&imported.book.id, TxtEncoding::Gbk)
            .unwrap();
        assert_eq!(switched.selected, TxtEncoding::Gbk);
        let window = storage
            .read_content_window(&imported.book.id, None, 64)
            .unwrap();
        assert_eq!(window.text, "中文");
    }

    #[test]
    fn redecoded_content_can_share_a_hash_without_merging_book_identity() {
        let root = TestRoot::new();
        let first_source = write_source(&root.0, "first.txt", "中文".as_bytes());
        let second_source = write_source(&root.0, "second.txt", b"temporary");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let first = import(&mut storage, &first_source, "first");
        let second = import(&mut storage, &second_source, "second");
        assert_ne!(first.book.id, second.book.id);

        let second_raw = app_root
            .join("sources")
            .join(format!("{}.txt", second.asset.id));
        let replacement = [0xd6, 0xd0, 0xce, 0xc4];
        fs::write(&second_raw, replacement).unwrap();
        storage
            .conn
            .execute(
                "UPDATE txt_assets SET source_sha256 = ?1 WHERE asset_id = ?2",
                params![sha256_bytes(&replacement), second.asset.id],
            )
            .unwrap();
        storage
            .set_txt_encoding(&second.book.id, TxtEncoding::Gbk)
            .unwrap();

        assert_eq!(
            storage
                .read_content_window(&first.book.id, None, 64)
                .unwrap()
                .text,
            "中文"
        );
        assert_eq!(
            storage
                .read_content_window(&second.book.id, None, 64)
                .unwrap()
                .text,
            "中文"
        );
        assert_eq!(storage.list_books().unwrap().len(), 2);
    }

    #[test]
    fn normalized_duplicate_keeps_the_existing_raw_source_and_encoding() {
        let root = TestRoot::new();
        let first_source = write_source(&root.0, "utf8.txt", "中文".as_bytes());
        let second_source = write_source(&root.0, "gbk.txt", &[0xd6, 0xd0, 0xce, 0xc4]);
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let first = import(&mut storage, &first_source, "utf8");
        let second = import(&mut storage, &second_source, "gbk");
        assert!(second.duplicate);
        assert_eq!(first.book.id, second.book.id);
        let retained = fs::read(
            app_root
                .join("sources")
                .join(format!("{}.txt", first.asset.id)),
        )
        .unwrap();
        assert_eq!(retained, "中文".as_bytes());
        assert_eq!(
            storage
                .txt_encoding_for_book(&first.book.id)
                .unwrap()
                .selected,
            TxtEncoding::Auto
        );
    }

    #[test]
    fn reimporting_a_source_after_manual_decode_keeps_the_existing_asset() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "manual.txt", "中文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let first = import(&mut storage, &source, "manual-first");
        let switched = storage
            .set_txt_encoding(&first.book.id, TxtEncoding::Gbk)
            .unwrap();
        assert_eq!(switched.selected, TxtEncoding::Gbk);
        let manual_text = storage
            .read_content_window(&first.book.id, None, 128)
            .unwrap()
            .text;

        let repeated = import(&mut storage, &source, "manual-repeat");
        assert!(repeated.duplicate);
        assert_eq!(repeated.book.id, first.book.id);
        assert_eq!(repeated.asset.id, first.asset.id);
        assert_eq!(
            storage
                .txt_encoding_for_book(&first.book.id)
                .unwrap()
                .selected,
            TxtEncoding::Gbk
        );
        assert_eq!(
            storage
                .read_content_window(&first.book.id, None, 128)
                .unwrap()
                .text,
            manual_text
        );
    }

    #[test]
    fn repeat_import_repairs_missing_manual_assets_without_resetting_encoding() {
        for (remove_body, remove_source) in [(true, false), (false, true), (true, true)] {
            let root = TestRoot::new();
            let source = write_source(&root.0, "manual-repair.txt", "中文".as_bytes());
            let app_root = root.0.join("data");
            let mut storage = Storage::open(&app_root).unwrap();
            let first = import(&mut storage, &source, "manual-first");
            storage
                .set_txt_encoding(&first.book.id, TxtEncoding::Gbk)
                .unwrap();
            let original = storage
                .read_content_window(&first.book.id, None, 128)
                .unwrap();
            storage.save_position(&original.locator).unwrap();
            if remove_body {
                fs::remove_file(
                    app_root.join(format!("books/{}/{}.txt", first.book.id, first.asset.id)),
                )
                .unwrap();
            }
            if remove_source {
                fs::remove_file(app_root.join(format!("sources/{}.txt", first.asset.id))).unwrap();
            }
            let repeated = import(&mut storage, &source, "manual-repair");
            assert!(repeated.duplicate);
            assert_eq!(repeated.book.id, first.book.id);
            assert_eq!(repeated.asset.id, first.asset.id);
            assert_eq!(repeated.book.content_version, original.content_version);
            assert_eq!(
                storage
                    .txt_encoding_for_book(&first.book.id)
                    .unwrap()
                    .selected,
                TxtEncoding::Gbk
            );
            assert_eq!(
                storage
                    .read_content_window(&first.book.id, None, 128)
                    .unwrap()
                    .text,
                original.text
            );
            assert_eq!(
                storage.saved_position(&first.book.id).unwrap(),
                Some(original.locator)
            );
            drop(storage);
            let reopened = Storage::open(&app_root).unwrap();
            assert_eq!(
                reopened
                    .read_content_window(&first.book.id, None, 128)
                    .unwrap()
                    .text,
                original.text
            );
        }
    }

    #[test]
    fn import_dedup_prefers_source_identity_and_includes_redecoded_content() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "original.txt", "中文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let original = import(&mut storage, &source, "original");
        storage
            .set_txt_encoding(&original.book.id, TxtEncoding::Gbk)
            .unwrap();
        let other_source = write_source(&root.0, "other.txt", "\u{feff}中文".as_bytes());
        let other = import(&mut storage, &other_source, "other");
        assert_ne!(original.book.id, other.book.id);
        assert_eq!(
            import(&mut storage, &source, "repeat").book.id,
            original.book.id
        );
        let current = storage
            .read_content_window(&original.book.id, None, 128)
            .unwrap();
        let equivalent = write_source(&root.0, "equivalent.txt", current.text.as_bytes());
        let repeated = import(&mut storage, &equivalent, "equivalent");
        assert!(repeated.duplicate);
        assert_eq!(repeated.book.id, original.book.id);
        assert_eq!(storage.list_books().unwrap().len(), 2);
    }

    #[test]
    fn failed_duplicate_source_restore_discards_only_uncommitted_raw_bytes() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "original.txt", "中文".as_bytes());
        let replacement = write_source(&root.0, "replacement.txt", &[0xd6, 0xd0, 0xce, 0xc4]);
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let original = import(&mut storage, &source, "original");
        let raw_path = app_root.join(format!("sources/{}.txt", original.asset.id));
        fs::remove_file(&raw_path).unwrap();
        storage
            .conn
            .execute_batch(
                "CREATE TRIGGER fail_source_update BEFORE UPDATE ON txt_assets
             BEGIN SELECT RAISE(ABORT, 'injected source failure'); END;",
            )
            .unwrap();
        let error = storage
            .import_txt(&replacement, "failed-restore", &no_cancel(), |_, _, _| {})
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Database);
        storage.cleanup_import("failed-restore").unwrap();
        assert!(!raw_path.exists());
        assert!(fs::read_dir(app_root.join("sources"))
            .unwrap()
            .next()
            .is_none());
        assert!(!storage.journal_exists("failed-restore").unwrap());
        assert_eq!(
            storage
                .read_content_window(&original.book.id, None, 64)
                .unwrap()
                .text,
            "中文"
        );
    }

    #[test]
    fn interrupted_duplicate_repair_never_replaces_the_retained_source() {
        for (legacy_journal, raw_stage_removed) in [(false, false), (true, false), (true, true)] {
            let root = TestRoot::new();
            let source = write_source(&root.0, "original.txt", "中文".as_bytes());
            let equivalent = write_source(&root.0, "equivalent.txt", &[0xd6, 0xd0, 0xce, 0xc4]);
            let app_root = root.0.join("data");
            let mut storage = Storage::open(&app_root).unwrap();
            let original = import(&mut storage, &source, "original");
            fs::remove_file(app_root.join(format!(
                "books/{}/{}.txt",
                original.book.id, original.asset.id
            )))
            .unwrap();
            set_test_failure(FailurePoint::AfterJournal);
            assert!(storage
                .import_txt(
                    &equivalent,
                    "interrupted-repair",
                    &no_cancel(),
                    |_, _, _| {}
                )
                .is_err());
            if legacy_journal {
                storage.conn.execute(
                "UPDATE import_journal SET source_relative_path = ?1 WHERE operation_id = 'interrupted-repair'",
                params![format!("sources/{}.txt", original.asset.id)],
            ).unwrap();
            }
            if raw_stage_removed {
                fs::remove_file(app_root.join("staging/interrupted-repair.raw")).unwrap();
            }
            drop(storage);
            let reopened = Storage::open(&app_root).unwrap();
            assert_eq!(
                fs::read(app_root.join(format!("sources/{}.txt", original.asset.id))).unwrap(),
                "中文".as_bytes()
            );
            assert_eq!(
                reopened
                    .read_content_window(&original.book.id, None, 64)
                    .unwrap()
                    .text,
                "中文"
            );
        }
    }

    #[test]
    fn stale_decode_is_rejected_before_publication_and_cleans_its_stage() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "concurrent.txt", "中文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "original");
        let snapshot = storage.snapshot_txt_decode(&imported.book.id).unwrap();
        let prepared = Storage::prepare_txt_decode(
            &app_root,
            &snapshot,
            TxtEncoding::Utf8,
            "stale",
            &no_cancel(),
            |_, _, _| {},
        )
        .unwrap();
        storage
            .set_txt_encoding(&imported.book.id, TxtEncoding::Gbk)
            .unwrap();
        let live_path = app_root.join(&snapshot.relative_path);
        let fingerprint = file_fingerprint(&live_path).unwrap().1;
        // Publication must not be reached by the losing decode request.
        set_test_failure(FailurePoint::AfterRename);
        let error = storage
            .commit_txt_decode(prepared.clone(), &no_cancel())
            .unwrap_err();
        TEST_FAILURE_POINT.with(|value| value.set(0));
        assert_eq!(error.code, ErrorCode::ContentVersionMismatch);
        assert_eq!(file_fingerprint(&live_path).unwrap().1, fingerprint);
        assert!(!app_root.join(prepared.stage_relative_path).exists());
        assert!(!app_root.join(prepared.backup_relative_path).exists());
        assert_eq!(
            storage
                .txt_encoding_for_book(&imported.book.id)
                .unwrap()
                .selected,
            TxtEncoding::Gbk
        );
        assert!(storage
            .read_content_window(&imported.book.id, None, 64)
            .is_ok());
        assert_eq!(
            storage
                .conn
                .query_row("SELECT COUNT(*) FROM txt_decode_journal", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn decode_journal_failure_removes_staging_before_returning() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "decode-failure.txt", "中文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "original");
        storage
            .conn
            .execute_batch(
                "CREATE TRIGGER fail_decode_journal BEFORE INSERT ON txt_decode_journal
             BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;",
            )
            .unwrap();
        assert_eq!(
            storage
                .set_txt_encoding(&imported.book.id, TxtEncoding::Gbk)
                .unwrap_err()
                .code,
            ErrorCode::Database
        );
        assert!(fs::read_dir(app_root.join("staging"))
            .unwrap()
            .next()
            .is_none());
        assert_eq!(
            storage
                .read_content_window(&imported.book.id, None, 64)
                .unwrap()
                .text,
            "中文"
        );
    }

    #[test]
    fn concurrent_encoding_changes_conflict_even_when_text_is_unchanged() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "ascii.txt", b"same text");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "original");
        let snapshot = storage.snapshot_txt_decode(&imported.book.id).unwrap();
        let stale = Storage::prepare_txt_decode(
            &app_root,
            &snapshot,
            TxtEncoding::Gbk,
            "stale",
            &no_cancel(),
            |_, _, _| {},
        )
        .unwrap();
        storage
            .set_txt_encoding(&imported.book.id, TxtEncoding::Utf8)
            .unwrap();
        assert_eq!(
            storage
                .commit_txt_decode(stale, &no_cancel())
                .unwrap_err()
                .code,
            ErrorCode::ContentVersionMismatch
        );
        assert_eq!(
            storage
                .txt_encoding_for_book(&imported.book.id)
                .unwrap()
                .selected,
            TxtEncoding::Utf8
        );
        assert!(fs::read_dir(app_root.join("staging"))
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn search_honors_cancellation_before_scanning_chunks() {
        let root = TestRoot::new();
        let source = write_source(
            &root.0,
            "search-cancel.txt",
            "needle ".repeat(20_000).as_bytes(),
        );
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "search-cancel");
        let context = storage.content_read_context(&imported.book.id).unwrap();
        let verified = verify_content_context(&context).unwrap();
        let cancel = AtomicBool::new(true);
        let error = Storage::search_book_from_context_cancelable(
            &SearchRequest {
                book_id: imported.book.id,
                query: "needle".to_string(),
                case_sensitive: true,
                cursor: None,
                limit: 10,
                operation_id: None,
            },
            &context,
            &verified,
            Some(&cancel),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ImportCancelled);
    }

    #[test]
    fn legacy_book_can_reassociate_a_source_after_matching_text_is_verified() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "legacy.txt", "中文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "legacy");
        let managed_source = app_root
            .join("sources")
            .join(format!("{}.txt", imported.asset.id));
        fs::remove_file(&managed_source).unwrap();
        storage
            .conn
            .execute(
                "UPDATE txt_assets SET source_relative_path = NULL, source_sha256 = NULL
                 WHERE asset_id = ?1",
                params![imported.asset.id],
            )
            .unwrap();

        let replacement = write_source(&root.0, "reassociated.txt", "中文".as_bytes());
        let snapshot = storage
            .snapshot_txt_reassociation(&imported.book.id)
            .unwrap();
        let prepared = Storage::prepare_txt_reassociation(
            &app_root,
            &snapshot,
            &replacement,
            "legacy-reassociate",
        )
        .unwrap();
        let info = storage.commit_txt_reassociation(prepared).unwrap();
        assert!(info.can_change);
        assert!(managed_source.is_file());
        assert_eq!(
            storage
                .read_content_window(&imported.book.id, None, 64)
                .unwrap()
                .text,
            "中文"
        );
    }

    #[test]
    fn invalid_import_leaves_no_staging_or_database_record() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "invalid.txt", &[0xf0, 0x28, 0x8c, 0x28]);
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let error = storage
            .import_txt(&source, "failed", &no_cancel(), |_, _, _| {})
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsupportedEncoding);
        assert!(fs::read_dir(app_root.join("staging"))
            .unwrap()
            .next()
            .is_none());
        assert!(storage.list_books().unwrap().is_empty());
    }

    #[test]
    fn cancellation_before_commit_does_not_publish() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "cancel.txt", b"cancel me");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let cancel = AtomicBool::new(true);
        let error = storage
            .import_txt(&source, "cancelled", &cancel, |_, _, _| {})
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ImportCancelled);
        assert!(storage.list_books().unwrap().is_empty());
        assert!(fs::read_dir(app_root.join("staging"))
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn cancellation_during_persist_does_not_publish() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "cancel-persist.txt", b"cancel during persist");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let cancel = AtomicBool::new(false);
        let error = storage
            .import_txt(&source, "cancel-persist", &cancel, |phase, _, _| {
                if phase == ImportPhase::Persisting {
                    cancel.store(true, Ordering::Release);
                }
            })
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ImportCancelled);
        assert!(storage.list_books().unwrap().is_empty());
        assert!(fs::read_dir(app_root.join("staging"))
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn unicode_windows_concatenate_forward_and_backward_without_surrogate_splits() {
        let root = TestRoot::new();
        let content = "甲😀乙\n丙𐐷丁\n".repeat(4096);
        let source = write_source(&root.0, "unicode.txt", content.as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "unicode");

        let mut locator = None;
        let mut concatenated = String::new();
        loop {
            let window = storage
                .read_content_window(&imported.book.id, locator.as_ref(), 7)
                .unwrap();
            if window.text.is_empty() {
                break;
            }
            concatenated.push_str(&window.text);
            if !window.has_after {
                break;
            }
            locator = Some(ReaderLocator {
                offset: window.end_offset,
                ..window.locator.clone()
            });
        }
        assert_eq!(concatenated, content);

        let initial = storage
            .read_content_window(&imported.book.id, None, 4)
            .unwrap();
        let request = ReadContentRequest {
            book_id: imported.book.id.clone(),
            locator: Some(ReaderLocator {
                offset: 4,
                ..initial.locator
            }),
            max_units: 2,
            direction: WindowDirection::Backward,
        };
        let backward = storage.read_content_window_request(&request).unwrap();
        assert_eq!(backward.text, "😀乙");
        assert_eq!(backward.end_offset, 4);
    }

    #[test]
    fn same_length_replacement_is_reported_as_content_version_mismatch() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "replace.txt", b"hello world");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "replace");
        storage
            .read_content_window(&imported.book.id, None, 5)
            .unwrap();
        let asset_path = app_root.join(format!(
            "books/{}/{}.txt",
            imported.book.id, imported.asset.id
        ));
        fs::write(&asset_path, b"HELLO world").unwrap();
        let error = storage
            .read_content_window(&imported.book.id, None, 5)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ContentVersionMismatch);
    }

    #[test]
    fn corrupted_sparse_index_is_rebuilt_from_asset_bytes() {
        let root = TestRoot::new();
        let source = write_source(
            &root.0,
            "corrupt-index.txt",
            "甲😀乙\n".repeat(2_000).as_bytes(),
        );
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "corrupt-index");
        let first = storage
            .read_content_window(&imported.book.id, None, 20)
            .unwrap();
        assert_eq!(first.text, "甲😀乙\n".repeat(4));

        storage
            .conn
            .execute(
                "UPDATE content_indexes
                 SET index_json = ?1
                 WHERE asset_id = ?2",
                params![
                    serde_json::json!({
                        "schema_version": INDEX_SCHEMA_VERSION,
                        "stride_units": INDEX_STRIDE_UNITS,
                        "byte_length": imported.asset.byte_length,
                        "utf16_length": 8_000,
                        "entries": [
                            {"utf16_offset": 0, "byte_offset": 0},
                            {"utf16_offset": 8_000, "byte_offset": imported.asset.byte_length}
                        ]
                    })
                    .to_string(),
                    imported.asset.id
                ],
            )
            .unwrap();
        storage
            .conn
            .execute(
                "UPDATE content_indexes SET fingerprint = fingerprint || ':corrupt'
                 WHERE asset_id = ?1",
                params![imported.asset.id],
            )
            .unwrap();
        let rebuilt = storage
            .read_content_window(&imported.book.id, None, 20)
            .unwrap();
        assert_eq!(rebuilt.text, first.text);
        assert_eq!(rebuilt.end_offset, first.end_offset);
    }

    #[test]
    fn failed_duplicate_commit_preserves_committed_asset_on_recovery() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "duplicate-recovery.txt", b"duplicate recovery");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "first");
        let managed = app_root.join(format!(
            "books/{}/{}.txt",
            imported.book.id, imported.asset.id
        ));
        set_test_failure(FailurePoint::BeforeFinalCommit);
        let error = storage
            .import_txt(&source, "duplicate-failure", &no_cancel(), |_, _, _| {})
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        assert!(managed.is_file());
        drop(storage);

        let reopened = Storage::open(&app_root).unwrap();
        assert_eq!(reopened.list_books().unwrap().len(), 1);
        assert_eq!(
            reopened
                .read_content_window(&imported.book.id, None, 100)
                .unwrap()
                .text,
            "duplicate recovery"
        );
        assert!(!app_root.join("staging/duplicate-failure.part").exists());
    }

    #[test]
    fn sqlite_commit_failure_is_cleaned_without_creating_a_book() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "database-failure.txt", b"database failure");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        storage
            .conn
            .execute_batch(
                "CREATE TRIGGER fail_content_index
                 BEFORE INSERT ON content_indexes
                 BEGIN SELECT RAISE(ABORT, 'injected content index failure'); END;",
            )
            .unwrap();
        let error = storage
            .import_txt(&source, "database-failure", &no_cancel(), |_, _, _| {})
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Database);
        assert!(storage.list_books().unwrap().is_empty());
        assert!(storage.journal_exists("database-failure").unwrap());
        drop(storage);
        let reopened = Storage::open(&app_root).unwrap();
        assert!(reopened.list_books().unwrap().is_empty());
        assert!(!app_root.join("staging/database-failure.part").exists());
    }

    #[test]
    fn interrupted_imports_recover_after_journal_and_rename_boundaries() {
        for (operation, point) in [
            ("after-journal", FailurePoint::AfterJournal),
            ("after-rename", FailurePoint::AfterRename),
            ("before-commit", FailurePoint::BeforeFinalCommit),
        ] {
            let root = TestRoot::new();
            let source = write_source(&root.0, "recover.txt", b"recover me");
            let app_root = root.0.join("data");
            let mut storage = Storage::open(&app_root).unwrap();
            set_test_failure(point);
            let error = storage
                .import_txt(&source, operation, &no_cancel(), |_, _, _| {})
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::Io);
            drop(storage);
            let reopened = Storage::open(&app_root).unwrap();
            assert!(reopened.list_books().unwrap().is_empty());
            assert!(fs::read_dir(app_root.join("staging"))
                .unwrap()
                .next()
                .is_none());
            assert!(fs::read_dir(app_root.join("books"))
                .unwrap()
                .all(|entry| entry.unwrap().path().read_dir().unwrap().next().is_none()));
        }
    }

    #[test]
    fn interrupted_redecode_restores_the_previous_asset_on_reopen() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "redecode-recovery.txt", "中文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "redecode-recovery");
        let raw_path = app_root
            .join("sources")
            .join(format!("{}.txt", imported.asset.id));
        let replacement = [0xd6, 0xd0, 0xce, 0xc4];
        fs::write(&raw_path, replacement).unwrap();
        storage
            .conn
            .execute(
                "UPDATE txt_assets SET source_sha256 = ?1 WHERE asset_id = ?2",
                params![sha256_bytes(&replacement), imported.asset.id],
            )
            .unwrap();

        set_test_failure(FailurePoint::AfterRename);
        let error = storage
            .set_txt_encoding(&imported.book.id, TxtEncoding::Gbk)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        // Publication failures are recovered before the command returns, so
        // the current process remains readable without requiring a restart.
        assert_eq!(
            storage
                .read_content_window(&imported.book.id, None, 64)
                .unwrap()
                .text,
            "中文"
        );
        assert!(fs::read_dir(app_root.join("staging"))
            .unwrap()
            .flatten()
            .all(|entry| entry
                .path()
                .extension()
                .is_none_or(|extension| extension != "old")));
        drop(storage);

        let reopened = Storage::open(&app_root).unwrap();
        assert_eq!(
            reopened
                .read_content_window(&imported.book.id, None, 64)
                .unwrap()
                .text,
            "中文"
        );
        assert!(fs::read_dir(app_root.join("staging"))
            .unwrap()
            .flatten()
            .all(|entry| entry
                .path()
                .extension()
                .is_none_or(|extension| extension != "old")));
        assert!(fs::read_dir(app_root.join("staging"))
            .unwrap()
            .flatten()
            .all(|entry| entry
                .path()
                .extension()
                .is_none_or(|extension| extension != "part")));
        let journal_count: i64 = reopened
            .conn
            .query_row("SELECT COUNT(*) FROM txt_decode_journal", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(journal_count, 0);
    }

    #[test]
    fn migration_preserves_v1_records_and_rejects_future_schema() {
        let root = TestRoot::new();
        let app_root = root.0.join("data");
        fs::create_dir_all(app_root.join("books/b1")).unwrap();
        fs::create_dir_all(app_root.join("staging")).unwrap();
        let bytes = b"legacy\n";
        let asset_path = app_root.join("books/b1/a1.txt");
        fs::write(&asset_path, bytes).unwrap();
        let conn = Connection::open(app_root.join("gripread.sqlite3")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
             INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1);
             CREATE TABLE books(id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, author TEXT, content_version TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE book_assets(id TEXT PRIMARY KEY NOT NULL, book_id TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, byte_length INTEGER NOT NULL, content_version TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
             CREATE TABLE reading_positions(book_id TEXT PRIMARY KEY NOT NULL, locator_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO books VALUES ('b1', 'Legacy', NULL, 'legacy-version', 1, 1);",
        )
        .unwrap();
        let hash = format!("{:x}", Sha256::digest(bytes));
        conn.execute(
            "INSERT INTO book_assets VALUES ('a1', 'b1', 'txt', ?1, 7, ?1, 'books/b1/a1.txt', 1)",
            params![hash],
        )
        .unwrap();
        drop(conn);
        let storage = Storage::open(&app_root).unwrap();
        assert_eq!(storage.list_books().unwrap()[0].id, "b1");
        assert_eq!(
            storage.read_content_window("b1", None, 10).unwrap().text,
            "legacy\n"
        );
        drop(storage);

        let future_root = root.0.join("future");
        fs::create_dir_all(&future_root).unwrap();
        let conn = Connection::open(future_root.join("gripread.sqlite3")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
             INSERT INTO schema_migrations(version, applied_at) VALUES (99, 1);",
        )
        .unwrap();
        drop(conn);
        let error = Storage::open(&future_root).unwrap_err();
        assert_eq!(error.code, ErrorCode::Database);
        assert!(error.message.contains("future storage schema"));
    }

    #[test]
    fn orphan_files_are_removed_and_data_directory_is_exclusive() {
        let root = TestRoot::new();
        let app_root = root.0.join("data");
        let storage = Storage::open(&app_root).unwrap();
        let orphan = app_root.join("books/orphan/asset.txt");
        fs::create_dir_all(orphan.parent().unwrap()).unwrap();
        fs::write(&orphan, b"orphan").unwrap();
        let second = Storage::open(&app_root).unwrap_err();
        assert_eq!(second.code, ErrorCode::Database);
        drop(storage);
        let storage = Storage::open(&app_root).unwrap();
        assert!(!orphan.exists());
        drop(storage);
    }

    #[test]
    fn settings_and_library_summaries_persist() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "settings.txt", b"settings");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "settings");
        let settings = ReaderPreferences {
            font_size: 28.0,
            line_height: 2.0,
            ..ReaderPreferences::default()
        };
        storage.save_settings(&settings).unwrap();
        assert_eq!(storage.get_settings().unwrap(), settings);
        let summaries = storage.list_library_books().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].book.id, imported.book.id);
        assert_eq!(summaries[0].total_length, Some(8));
    }

    #[test]
    fn groups_persist_memberships_and_deletion_preserves_reading_data() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "groups.txt", "第一章\n阅读分组😀".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "groups");
        let window = storage
            .read_content_window(&imported.book.id, None, 64)
            .unwrap();
        storage.save_position(&window.locator).unwrap();
        let template = storage.list_groups().unwrap();
        assert_eq!(template.len(), 7);
        assert!(template.iter().all(|group| group.book_ids.is_empty()));
        assert_eq!(template[0].name, "玄幻修真");
        let group = storage.create_group("  我的阅读  ").unwrap();
        assert_eq!(group.name, "我的阅读");
        storage
            .set_book_groups(
                &imported.book.id,
                &[group.id.clone(), template[0].id.clone(), group.id.clone()],
            )
            .unwrap();
        let renamed = storage.rename_group(&group.id, "最近阅读").unwrap();
        assert_eq!(renamed.book_ids, vec![imported.book.id.clone()]);
        drop(storage);
        let storage = Storage::open(&app_root).unwrap();
        assert_eq!(storage.list_groups().unwrap().last(), Some(&renamed));
        storage.delete_group(&group.id).unwrap();
        storage.delete_group(&template[0].id).unwrap();
        assert_eq!(storage.list_books().unwrap(), vec![imported.book.clone()]);
        assert_eq!(
            storage.saved_position(&imported.book.id).unwrap(),
            Some(window.locator)
        );
        assert_eq!(
            storage
                .read_content_window(&imported.book.id, None, 64)
                .unwrap()
                .text,
            window.text
        );
        let remaining = storage.list_groups().unwrap();
        assert_eq!(remaining.len(), 6);
        assert!(remaining.iter().all(|group| group.book_ids.is_empty()));
        drop(storage);
        let reopened = Storage::open(&app_root).unwrap();
        assert_eq!(reopened.list_groups().unwrap(), remaining);
    }

    #[test]
    fn group_validation_and_membership_failure_preserve_existing_groups() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "membership.txt", b"membership");
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let imported = import(&mut storage, &source, "membership");
        let group = storage.create_group("自定义").unwrap();
        assert_eq!(
            storage.create_group("  ").unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            storage.create_group(" 自定义 ").unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            storage
                .rename_group(&group.id, "玄幻修真")
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            storage.rename_group("absent", "未知").unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            storage.delete_group("absent").unwrap_err().code,
            ErrorCode::NotFound
        );
        storage
            .set_book_groups(&imported.book.id, std::slice::from_ref(&group.id))
            .unwrap();
        let before = storage.list_groups().unwrap();
        assert_eq!(
            storage
                .set_book_groups(&imported.book.id, &[group.id.clone(), "absent".to_string()])
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        assert_eq!(
            storage
                .set_book_groups("absent", std::slice::from_ref(&group.id))
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        assert_eq!(storage.list_groups().unwrap(), before);
        storage.set_book_groups(&imported.book.id, &[]).unwrap();
        assert!(storage
            .list_groups()
            .unwrap()
            .iter()
            .all(|group| group.book_ids.is_empty()));
    }

    #[test]
    fn group_migration_preserves_v5_books_assets_positions_and_saved_preferences() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "upgrade.txt", b"upgrade");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "upgrade");
        assert_eq!(
            storage.get_settings().unwrap().theme,
            crate::models::ThemeMode::Light
        );
        assert_eq!(storage.get_settings().unwrap().font_size, 18.0);
        let saved_settings = ReaderPreferences {
            theme: crate::models::ThemeMode::System,
            font_size: 20.0,
            ..ReaderPreferences::default()
        };
        storage.save_settings(&saved_settings).unwrap();
        let locator = storage
            .read_content_window(&imported.book.id, None, 64)
            .unwrap()
            .locator;
        storage.save_position(&locator).unwrap();
        // Recreate the exact v5 boundary: group schema did not exist yet.
        storage.conn.execute_batch("DROP TABLE book_groups; DROP TABLE library_groups; DELETE FROM schema_migrations WHERE version = 6;").unwrap();
        drop(storage);
        let reopened = Storage::open(&app_root).unwrap();
        let library = reopened.list_library_books().unwrap();
        assert_eq!(library[0].book, imported.book);
        assert_eq!(library[0].asset.id, imported.asset.id);
        assert_eq!(
            reopened.saved_position(&imported.book.id).unwrap(),
            Some(locator)
        );
        assert_eq!(reopened.get_settings().unwrap(), saved_settings);
        assert_eq!(reopened.list_groups().unwrap().len(), 7);
        assert!(reopened
            .list_groups()
            .unwrap()
            .iter()
            .all(|group| group.book_ids.is_empty()));
    }
}
