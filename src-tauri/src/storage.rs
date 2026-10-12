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
use crate::models::{
    AssetAvailability, AssetKind, Book, BookAsset, BookInfo, BookTocSettings, Bookmark,
    BookmarkRequest, ContentWindow, ImportPhase, ImportResult, LibraryBook, LibraryGroup,
    ReadContentRequest, ReaderAsset, ReaderLocator, ReaderPreferences, ResolveLocatorRequest,
    ResolveOffsetRequest, SearchMatch, SearchRequest, SearchResponse, TxtDecodeState, TxtEncoding,
    TxtEncodingInfo, TxtTocRule, WindowDirection,
};
use crate::models::{
    BookReadingTime, DayReadingTime, ReadingStats, ReplaceRule, ShelfPlacement, ShelfPreferences,
    ShelfState, UpdateBookRequest,
};
use crate::transform::{self, TextTransform, TransformRule};
use crate::txt::detect_and_decode;
use crate::txt_toc::{
    build_toc, compile_rule, parse_name_author, RuleSpec, TocBuild, TocBuildRule,
};

mod online;
mod online_cache;
mod portable;
mod sources;
pub use online::{
    chapter_resource, chapter_version, forget_cached_chapters, map_chapter, mark_chapter_cached,
    online_key, resource_chapter, ChapterPosition, OnlineRecord,
};
pub use online_cache::{book_cache_key, cover_key, CachedCover};
pub use portable::{
    backup_digest, parse_backup, BackupDocument, CloudMetadata, CoverRef, PortableLocator,
    ProgressState, StoredWebDav,
};
pub use sources::{split_groups, SqliteSourceStore, CHECK_GROUPS};

const CURRENT_SCHEMA_VERSION: i64 = 18;
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
    position: Option<ReaderLocator>,
    bookmarks: Vec<Bookmark>,
    /// The transform that produced the current text, and the one to apply.
    pub(crate) applied: TextTransform,
    pub(crate) target: TextTransform,
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
    relocated: Vec<(Option<String>, ReaderLocator)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TxtReassociationSnapshot {
    pub(crate) book_id: String,
    pub(crate) asset_id: String,
    pub(crate) source_relative_path: Option<String>,
    pub(crate) source_sha256: Option<String>,
    pub(crate) target_relative_path: String,
    pub(crate) content_version: String,
    pub(crate) selected_encoding: TxtEncoding,
    pub(crate) transform: TextTransform,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedTxtReassociation {
    pub(crate) snapshot: TxtReassociationSnapshot,
    pub(crate) stage_relative_path: String,
    pub(crate) source_sha256: String,
    pub(crate) stage_fingerprint: Option<String>,
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
    transform: TextTransform,
}

/// Relative path, normalized hash, source hash, encoding, and transform.
type ImportTargetRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);
/// Source path, source hash, encoding, and transform of a TXT asset.
type TxtSourceRow = (Option<String>, Option<String>, String, Option<String>);

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
    /// Treat `query` as a regular expression matched within each line.
    regex: bool,
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
        storage.remove_unused_backgrounds()?;
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

        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if current < 7 {
            let tx = self.conn.transaction()?;
            tx.execute_batch("CREATE TABLE shelf_removals (book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE, removed_at INTEGER NOT NULL); CREATE TABLE shelf_preferences (id INTEGER PRIMARY KEY CHECK(id = 1), preferences_json TEXT NOT NULL);")?;
            tx.execute(
                "INSERT INTO schema_migrations(version,applied_at) VALUES(7,?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        let current: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        if current < 8 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE book_toc_rules (
                    book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    mode TEXT NOT NULL CHECK(mode IN ('automatic', 'chinese', 'english', 'custom')),
                    pattern TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision > 0),
                    updated_at INTEGER NOT NULL
                );
                ALTER TABLE toc_cache ADD COLUMN rule_identity TEXT NOT NULL DEFAULT '';
                ALTER TABLE toc_cache ADD COLUMN rule_revision INTEGER NOT NULL DEFAULT 0;",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (8, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        if current < 9 {
            let tx = self.conn.transaction()?;
            migrate_to_legado_toc_rules(&tx)?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (9, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        // Schema 10: authors parsed before 作者 separators and edition notes
        // were understood keep only the author's name. No table changes.
        if current < 10 {
            let tx = self.conn.transaction()?;
            let authors: Vec<(String, String)> = {
                let mut statement =
                    tx.prepare("SELECT id, author FROM books WHERE author IS NOT NULL")?;
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for (id, author) in authors {
                let cleaned = crate::txt_toc::format_author(&author);
                if cleaned.as_deref() != Some(author.as_str()) {
                    tx.execute(
                        "UPDATE books SET author = ?2 WHERE id = ?1",
                        params![id, cleaned],
                    )?;
                }
            }
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (10, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        // Schema 11: reading-state shelf groups replace the seeded genre
        // groups (all existing groups are removed, as the reader chose);
        // manual reading states, covers, bookmark notes, reading time, and
        // image assets.
        if current < 11 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "DELETE FROM book_groups;
                 DELETE FROM library_groups;
                 ALTER TABLE books ADD COLUMN shelf_state TEXT
                    CHECK(shelf_state IN ('reading', 'unread', 'finished'));
                 ALTER TABLE books ADD COLUMN cover_asset_id TEXT;
                 ALTER TABLE bookmarks ADD COLUMN note TEXT NOT NULL DEFAULT '';
                 CREATE TABLE reading_time (
                    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    day TEXT NOT NULL,
                    seconds INTEGER NOT NULL CHECK(seconds >= 0),
                    PRIMARY KEY(book_id, day)
                 );
                 CREATE TABLE reader_assets_v11 (
                    id TEXT PRIMARY KEY NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('font', 'cover', 'background')),
                    name TEXT NOT NULL,
                    relative_path TEXT NOT NULL UNIQUE,
                    byte_length INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                 );
                 INSERT INTO reader_assets_v11
                    SELECT id, kind, name, relative_path, byte_length, created_at FROM reader_assets;
                 DROP TABLE reader_assets;
                 ALTER TABLE reader_assets_v11 RENAME TO reader_assets;
                 UPDATE shelf_preferences SET preferences_json =
                    json_set(preferences_json, '$.groupId', 'all');",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (11, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        // Schema 12: Legado replace rules and the text transform each book's
        // managed text was produced with (NULL: the decoded text as is).
        if current < 12 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE replace_rules (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    rule_group TEXT NOT NULL DEFAULT '',
                    pattern TEXT NOT NULL,
                    replacement TEXT NOT NULL,
                    is_regex INTEGER NOT NULL CHECK(is_regex IN (0, 1)),
                    scope TEXT NOT NULL DEFAULT '',
                    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
                    serial INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 ALTER TABLE txt_assets ADD COLUMN transform_json TEXT;
                 ALTER TABLE books ADD COLUMN use_replace_rules INTEGER NOT NULL DEFAULT 1
                    CHECK(use_replace_rules IN (0, 1));",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (12, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        // Schema 13: backup records waiting for their book to be imported,
        // and this device's WebDAV account and backup state.
        if current < 13 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE pending_book_restores (
                    source_sha256 TEXT PRIMARY KEY NOT NULL,
                    record_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                 );
                 CREATE TABLE sync_settings (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    settings_json TEXT NOT NULL
                 );",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (13, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        // Schema 14: the books this device last saw on the cloud bookshelf
        // (marked on the shelf without a network request), cloud book
        // information waiting for its import, and reading progress sync state.
        if current < 14 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE cloud_books (
                    source_sha256 TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    uploaded_at INTEGER NOT NULL
                 );
                 CREATE TABLE pending_book_metadata (
                    source_sha256 TEXT PRIMARY KEY NOT NULL,
                    metadata_json TEXT NOT NULL
                 );
                 CREATE TABLE progress_sync (
                    book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    handled_device TEXT NOT NULL,
                    handled_revision INTEGER NOT NULL,
                    local_revision INTEGER NOT NULL,
                    synced_version TEXT,
                    synced_offset INTEGER
                 );",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (14, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        // Schema 15: reading time of deleted books, kept in the totals until
        // the same book is imported again and takes it back.
        if current < 15 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE retired_reading_time (
                    source_sha256 TEXT NOT NULL,
                    day TEXT NOT NULL,
                    seconds INTEGER NOT NULL CHECK(seconds >= 0),
                    PRIMARY KEY(source_sha256, day)
                 );",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (15, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        if current < 16 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE book_sources (
                    url TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    source_group TEXT NOT NULL DEFAULT '',
                    enabled INTEGER NOT NULL,
                    enabled_explore INTEGER NOT NULL,
                    custom_order INTEGER NOT NULL DEFAULT 0,
                    weight INTEGER NOT NULL DEFAULT 0,
                    last_update_time INTEGER NOT NULL DEFAULT 0,
                    respond_time INTEGER NOT NULL DEFAULT 180000,
                    raw_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX book_sources_order ON book_sources(custom_order, name);
                 CREATE TABLE source_cache (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    expires_at INTEGER
                 );
                 CREATE TABLE source_cookies (
                    domain TEXT PRIMARY KEY,
                    cookie TEXT NOT NULL
                 );",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (16, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        if current < 17 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE online_books (
                    book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    source_url TEXT NOT NULL,
                    book_url TEXT NOT NULL DEFAULT '',
                    book_json TEXT NOT NULL,
                    on_shelf INTEGER NOT NULL,
                    can_update INTEGER NOT NULL DEFAULT 1,
                    total_chapters INTEGER NOT NULL DEFAULT 0,
                    new_chapters INTEGER NOT NULL DEFAULT 0,
                    last_check_time INTEGER,
                    update_error TEXT,
                    pending_position TEXT,
                    pending_bookmarks TEXT,
                    created_at INTEGER NOT NULL
                 );
                 CREATE INDEX online_books_origin ON online_books(source_url, book_url);
                 CREATE TABLE online_chapters (
                    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    idx INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    url TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    is_volume INTEGER NOT NULL,
                    is_vip INTEGER NOT NULL,
                    is_pay INTEGER NOT NULL,
                    tag TEXT NOT NULL,
                    variables TEXT NOT NULL,
                    PRIMARY KEY (book_id, idx)
                 );",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (17, ?1)",
                params![now_millis()],
            )?;
            tx.commit()?;
        }

        if current < 18 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE retired_books (
                    key TEXT PRIMARY KEY NOT NULL,
                    title TEXT NOT NULL,
                    author TEXT,
                    deleted_at INTEGER NOT NULL
                 );
                 CREATE TABLE online_book_cache (
                    key TEXT PRIMARY KEY NOT NULL,
                    info_json TEXT,
                    toc_json TEXT,
                    fetched_at INTEGER NOT NULL
                 );
                 CREATE TABLE online_cover_cache (
                    key TEXT PRIMARY KEY NOT NULL,
                    relative_path TEXT,
                    failed_at INTEGER
                 );
                 ALTER TABLE online_books ADD COLUMN last_opened_at INTEGER;",
            )?;
            tx.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (18, ?1)",
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
        requested_encoding: TxtEncoding,
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
        let decoded = detect_and_decode(&input, requested_encoding)?;
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
            // The journal keeps the file name; the shelf shows its parsed parts.
            let parsed_name = parse_name_author(&journal.title);
            if !duplicate {
                tx.execute(
                    "INSERT INTO books(id, title, author, content_version, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        journal.book_id,
                        parsed_name.name,
                        parsed_name.author,
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
            tx.execute(
                "DELETE FROM shelf_removals WHERE book_id = ?1",
                params![journal.book_id],
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
            tx.execute(
                "DELETE FROM shelf_removals WHERE book_id = ?1",
                params![book_id],
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
        let mut prepared = Self::prepare_import(
            &self.root,
            source,
            operation_id,
            TxtEncoding::Auto,
            cancel,
            report,
        )?;
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
            if committed.as_ref().is_none_or(|(path, hash)| {
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
        let target: Option<ImportTargetRow> = self
            .conn
            .query_row(
                "SELECT a.relative_path, a.sha256, t.source_sha256, t.selected_encoding,
                        t.transform_json
                 FROM book_assets a
                 LEFT JOIN txt_assets t ON t.asset_id = a.id
                 WHERE a.sha256 = ?1 OR t.source_sha256 = ?2
                 ORDER BY CASE WHEN t.source_sha256 = ?2 THEN 0 ELSE 1 END,
                          a.created_at ASC
                 LIMIT 1",
                params![sha256, source_sha256],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((relative_path, target_sha256, source_sha256, selected_encoding, transform_json)) =
            target
        else {
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
            transform: TextTransform::from_stored(transform_json.as_deref()),
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
            if groups.last().is_none_or(|group| group.id != id) {
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

    /// Moves a book to automatic grouping, a reading state, or one user
    /// group. A manual placement stays until the book is moved again.
    pub fn move_book(&mut self, book_id: &str, placement: &ShelfPlacement) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        let book_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM books WHERE id = ?1)",
            params![book_id],
            |row| row.get(0),
        )?;
        if !book_exists {
            return Err(AppError::new(ErrorCode::NotFound, "book was not found"));
        }
        if let ShelfPlacement::Group(group_id) = placement {
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
        let state = match placement {
            ShelfPlacement::State(state) => Some(shelf_state_name(*state)),
            _ => None,
        };
        tx.execute(
            "UPDATE books SET shelf_state = ?2 WHERE id = ?1",
            params![book_id, state],
        )?;
        if let ShelfPlacement::Group(group_id) = placement {
            tx.execute(
                "INSERT INTO book_groups(book_id, group_id) VALUES (?1, ?2)",
                params![book_id, group_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn update_bookmark_note(&mut self, bookmark_id: &str, note: &str) -> Result<(), AppError> {
        if note.chars().count() > 2000 {
            return Err(AppError::invalid_argument(
                "bookmark notes allow 2000 characters",
            ));
        }
        let changed = self.conn.execute(
            "UPDATE bookmarks SET note = ?2 WHERE id = ?1",
            params![bookmark_id, note.trim()],
        )?;
        if changed == 0 {
            return Err(AppError::new(ErrorCode::NotFound, "bookmark was not found"));
        }
        Ok(())
    }

    /// Adds reading time for a local calendar day.
    pub fn add_reading_time(
        &mut self,
        book_id: &str,
        day: &str,
        seconds: u32,
    ) -> Result<(), AppError> {
        let valid_day = day.len() == 10
            && day.chars().enumerate().all(|(index, character)| {
                if index == 4 || index == 7 {
                    character == '-'
                } else {
                    character.is_ascii_digit()
                }
            });
        if !valid_day || seconds == 0 || seconds > 3600 {
            return Err(AppError::invalid_argument(
                "reading time needs a YYYY-MM-DD day and 1 to 3600 seconds",
            ));
        }
        self.get_book(book_id)?;
        self.conn.execute(
            "INSERT INTO reading_time(book_id, day, seconds) VALUES (?1, ?2, ?3)
             ON CONFLICT(book_id, day) DO UPDATE SET seconds = seconds + excluded.seconds",
            params![book_id, day, seconds],
        )?;
        Ok(())
    }

    pub fn reading_stats(&self, today: &str) -> Result<ReadingStats, AppError> {
        let (total, today_seconds): (i64, i64) = self.conn.query_row(
            "SELECT COALESCE(SUM(seconds), 0), COALESCE(SUM(CASE WHEN day = ?1 THEN seconds END), 0)
             FROM (SELECT day, seconds FROM reading_time
                   UNION ALL SELECT day, seconds FROM retired_reading_time)",
            params![today],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        // The activity matrix covers 26 weeks back from today.
        let since = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d")
            .map(|day| {
                (day - chrono::Duration::days(26 * 7))
                    .format("%Y-%m-%d")
                    .to_string()
            })
            .unwrap_or_default();
        let mut days = self.conn.prepare(
            "SELECT day, SUM(seconds) FROM (SELECT day, seconds FROM reading_time
                   UNION ALL SELECT day, seconds FROM retired_reading_time)
             WHERE day > ?1 GROUP BY day ORDER BY day DESC",
        )?;
        let days = days
            .query_map(params![since], |row| {
                Ok(DayReadingTime {
                    day: row.get(0)?,
                    seconds: row.get::<_, i64>(1)?.max(0) as u64,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        // Deleted books keep their time under their retired key.
        let mut books = self.conn.prepare(
            "SELECT * FROM (
                SELECT r.book_id, SUM(r.seconds) AS seconds, MAX(r.day) AS last_day, b.title,
                       b.author, 0,
                       (SELECT p.updated_at FROM reading_positions p WHERE p.book_id = r.book_id)
                       AS last_read
                FROM reading_time r JOIN books b ON b.id = r.book_id GROUP BY r.book_id
                UNION ALL
                SELECT 'retired:' || t.source_sha256, SUM(t.seconds), MAX(t.day), d.title,
                       d.author, 1, d.deleted_at
                FROM retired_reading_time t JOIN retired_books d ON d.key = t.source_sha256
                GROUP BY t.source_sha256)
             ORDER BY last_day DESC, COALESCE(last_read, 0) DESC, seconds DESC",
        )?;
        let books = books
            .query_map([], |row| {
                Ok(BookReadingTime {
                    book_id: row.get(0)?,
                    seconds: row.get::<_, i64>(1)?.max(0) as u64,
                    last_day: row.get(2)?,
                    title: row.get(3)?,
                    author: row.get(4)?,
                    deleted: row.get(5)?,
                    last_read_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ReadingStats {
            total_seconds: total.max(0) as u64,
            today_seconds: today_seconds.max(0) as u64,
            days,
            books,
        })
    }

    /// Stores an image as the book's cover, replacing and removing any previous one.
    pub fn set_book_cover(
        &mut self,
        book_id: &str,
        source: &Path,
        name: &str,
    ) -> Result<ReaderAsset, AppError> {
        self.get_book(book_id)?;
        let previous = self.book_cover(book_id)?;
        let asset = self.import_reader_asset(source, name, "cover")?;
        self.conn.execute(
            "UPDATE books SET cover_asset_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![book_id, asset.id, now_millis()],
        )?;
        if let Some(previous) = previous {
            self.delete_reader_asset(&previous)?;
        }
        Ok(asset)
    }

    pub fn clear_book_cover(&mut self, book_id: &str) -> Result<(), AppError> {
        self.get_book(book_id)?;
        let previous = self.book_cover(book_id)?;
        self.conn.execute(
            "UPDATE books SET cover_asset_id = NULL WHERE id = ?1",
            params![book_id],
        )?;
        if let Some(previous) = previous {
            self.delete_reader_asset(&previous)?;
        }
        Ok(())
    }

    fn book_cover(&self, book_id: &str) -> Result<Option<String>, AppError> {
        Ok(self.conn.query_row(
            "SELECT cover_asset_id FROM books WHERE id = ?1",
            params![book_id],
            |row| row.get(0),
        )?)
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
        self.list_shelf_books(false, None)
    }
    pub fn list_removed_books(&self) -> Result<Vec<LibraryBook>, AppError> {
        self.list_shelf_books(true, None)
    }
    /// One book as the shelf shows it, including an online book only being
    /// read from search.
    pub fn library_book(&self, book_id: &str) -> Result<LibraryBook, AppError> {
        self.list_shelf_books(false, Some(book_id))?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "书籍不存在"))
    }
    fn list_shelf_books(
        &self,
        removed: bool,
        only: Option<&str>,
    ) -> Result<Vec<LibraryBook>, AppError> {
        // Online books have no asset; ones only being tried from search stay
        // off the shelf until added.
        let mut statement = self.conn.prepare(
            "SELECT b.id, b.title, b.author, b.content_version, b.created_at, b.updated_at,
                    a.id, a.book_id, a.kind, a.sha256, a.byte_length, a.content_version,
                    a.relative_path, a.created_at, p.updated_at, r.removed_at,
                    b.shelf_state, b.cover_asset_id, b.use_replace_rules,
                    EXISTS(SELECT 1 FROM txt_assets t JOIN cloud_books c
                           ON c.source_sha256 = t.source_sha256 WHERE t.asset_id = a.id),
                    o.book_id IS NOT NULL
             FROM books b LEFT JOIN book_assets a ON a.book_id = b.id
             LEFT JOIN online_books o ON o.book_id = b.id
             LEFT JOIN reading_positions p ON p.book_id = b.id
             LEFT JOIN shelf_removals r ON r.book_id = b.id
             WHERE (r.book_id IS NOT NULL) = ?1
               AND (a.id IS NOT NULL OR o.on_shelf = 1 OR b.id = ?2)
               AND (?2 IS NULL OR b.id = ?2)
             ORDER BY b.updated_at DESC, b.id ASC, a.created_at ASC",
        )?;
        let rows = statement
            .query_map(params![removed, only], |row| {
                let book = Book {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    author: row.get(2)?,
                    content_version: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                };
                let record = if row.get::<_, Option<String>>(6)?.is_some() {
                    Some(asset_from_columns(row, 6)?)
                } else {
                    None
                };
                Ok((
                    book,
                    record,
                    row.get::<_, Option<i64>>(14)?,
                    row.get::<_, Option<i64>>(15)?,
                    row.get::<_, Option<String>>(16)?,
                    row.get::<_, Option<String>>(17)?,
                    row.get::<_, bool>(18)?,
                    row.get::<_, bool>(19)?,
                    row.get::<_, bool>(20)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        rows.into_iter()
            .filter(|row| row.1.is_some() || row.8)
            .map(
                |(
                    book,
                    record,
                    last_read_at,
                    removed_at,
                    shelf_state,
                    cover_asset_id,
                    use_replace_rules,
                    in_cloud,
                    _online,
                )| {
                    let locator = self.saved_position(&book.id)?;
                    let (asset, total_length, txt_encoding) = match record {
                        Some(mut record) => {
                            let path = managed_path(&self.root, &record.relative_path, "books")?;
                            record.asset.availability = if is_regular_file(&path) {
                                AssetAvailability::Ready
                            } else {
                                AssetAvailability::Missing
                            };
                            let total_length =
                                if record.asset.availability == AssetAvailability::Ready {
                                    self.trusted_content_length(&record)?
                                } else {
                                    None
                                };
                            let txt_encoding = self.txt_encoding_for_asset(&record.asset.id)?;
                            (Some(record.asset), total_length, txt_encoding)
                        }
                        None => (None, None, None),
                    };
                    let online = self.online_shelf_info(&book.id, locator.as_ref())?;
                    Ok(LibraryBook {
                        book,
                        asset,
                        online,
                        locator,
                        total_length,
                        txt_encoding,
                        last_read_at,
                        removed_at,
                        shelf_state: shelf_state.as_deref().and_then(parse_shelf_state),
                        cover_asset_id,
                        use_replace_rules,
                        in_cloud,
                    })
                },
            )
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

    pub fn list_txt_toc_rules(&self) -> Result<Vec<TxtTocRule>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, pattern, example, serial, enabled, builtin
             FROM txt_toc_rules ORDER BY serial, id",
        )?;
        let rules = statement
            .query_map([], txt_toc_rule_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rules)
    }

    /// Adds a rule when `id` is empty, otherwise updates it. Built-in rules
    /// may be edited; patterns must compile.
    pub fn save_txt_toc_rule(&mut self, rule: &TxtTocRule) -> Result<TxtTocRule, AppError> {
        let name = rule.name.trim();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(AppError::invalid_argument(
                "rule names need 1 to 64 characters",
            ));
        }
        if rule.pattern.chars().count() > 2048 || rule.example.chars().count() > 2048 {
            return Err(AppError::invalid_argument("rule text is too long"));
        }
        if !rule.pattern.is_empty() {
            compile_rule(&rule.pattern)?;
        }
        let tx = self.conn.transaction()?;
        let saved_id = if rule.id.is_empty() {
            let id = Uuid::new_v4().to_string();
            let serial: i64 = tx.query_row(
                "SELECT COALESCE(MAX(serial), -1) + 1 FROM txt_toc_rules",
                [],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO txt_toc_rules(id, name, pattern, example, serial, enabled, builtin, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
                params![id, name, rule.pattern, rule.example, serial, rule.enabled, now_millis()],
            )?;
            id
        } else {
            let changed = tx.execute(
                "UPDATE txt_toc_rules SET name = ?2, pattern = ?3, example = ?4, enabled = ?5,
                    updated_at = ?6 WHERE id = ?1",
                params![
                    rule.id,
                    name,
                    rule.pattern,
                    rule.example,
                    rule.enabled,
                    now_millis()
                ],
            )?;
            if changed == 0 {
                return Err(AppError::new(ErrorCode::NotFound, "TOC rule was not found"));
            }
            rule.id.clone()
        };
        let saved = tx.query_row(
            "SELECT id, name, pattern, example, serial, enabled, builtin
             FROM txt_toc_rules WHERE id = ?1",
            params![saved_id],
            txt_toc_rule_from_row,
        )?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn delete_txt_toc_rule(&mut self, id: &str) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        let builtin: Option<bool> = tx
            .query_row(
                "SELECT builtin FROM txt_toc_rules WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        match builtin {
            None => return Err(AppError::new(ErrorCode::NotFound, "TOC rule was not found")),
            Some(true) => {
                return Err(AppError::invalid_argument(
                    "built-in rules can be disabled but not deleted",
                ))
            }
            Some(false) => {}
        }
        // Books that used the rule return to automatic detection.
        tx.execute(
            "UPDATE book_toc_settings SET rule_id = NULL, revision = revision + 1,
                updated_at = ?2 WHERE rule_id = ?1",
            params![id, now_millis()],
        )?;
        tx.execute("DELETE FROM txt_toc_rules WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn order_txt_toc_rules(&mut self, ids: &[String]) -> Result<Vec<TxtTocRule>, AppError> {
        let tx = self.conn.transaction()?;
        let existing: HashSet<String> = {
            let mut statement = tx.prepare("SELECT id FROM txt_toc_rules")?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            ids
        };
        let requested: HashSet<&String> = ids.iter().collect();
        if requested.len() != ids.len()
            || ids.len() != existing.len()
            || ids.iter().any(|id| !existing.contains(id))
        {
            return Err(AppError::invalid_argument(
                "rule order must list every rule exactly once",
            ));
        }
        for (serial, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE txt_toc_rules SET serial = ?2 WHERE id = ?1",
                params![id, serial as i64],
            )?;
        }
        tx.commit()?;
        self.list_txt_toc_rules()
    }

    /// Imports rules exported by Legado (`name`, `rule`, `example`, `enable`)
    /// or by GripRead (`name`, `pattern`, …). Identical rules are skipped.
    pub fn import_txt_toc_rules(&mut self, json: &str) -> Result<Vec<TxtTocRule>, AppError> {
        let value: serde_json::Value = serde_json::from_str(json).map_err(|error| {
            AppError::invalid_argument(format!("not a rule JSON file: {error}"))
        })?;
        let items = match value {
            serde_json::Value::Array(items) => items,
            item @ serde_json::Value::Object(_) => vec![item],
            _ => return Err(AppError::invalid_argument("not a rule JSON file")),
        };
        let existing = self.list_txt_toc_rules()?;
        let mut imported = Vec::new();
        for item in items.iter().take(500) {
            let text = |key: &str| item.get(key).and_then(|value| value.as_str());
            let Some(name) = text("name") else { continue };
            let pattern = text("rule").or_else(|| text("pattern")).unwrap_or("");
            if existing
                .iter()
                .chain(imported.iter())
                .any(|rule: &TxtTocRule| rule.name == name.trim() && rule.pattern == pattern)
            {
                continue;
            }
            let enabled = item
                .get("enable")
                .or_else(|| item.get("enabled"))
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            imported.push(self.save_txt_toc_rule(&TxtTocRule {
                id: String::new(),
                name: name.to_string(),
                pattern: pattern.to_string(),
                example: text("example").unwrap_or("").to_string(),
                serial: 0,
                enabled,
                builtin: false,
            })?);
        }
        Ok(imported)
    }

    /// Exports every rule in Legado's format.
    pub fn export_txt_toc_rules(&self) -> Result<String, AppError> {
        let rules: Vec<_> = self
            .list_txt_toc_rules()?
            .into_iter()
            .map(|rule| {
                serde_json::json!({
                    "name": rule.name,
                    "rule": rule.pattern,
                    "example": rule.example,
                    "enable": rule.enabled,
                    "serialNumber": rule.serial,
                })
            })
            .collect();
        Ok(serde_json::to_string_pretty(&rules)?)
    }

    pub fn list_replace_rules(&self) -> Result<Vec<ReplaceRule>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, rule_group, pattern, replacement, is_regex, scope, enabled, serial
             FROM replace_rules ORDER BY serial, rowid",
        )?;
        let rules = statement
            .query_map([], |row| {
                Ok(ReplaceRule {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    group: row.get(2)?,
                    pattern: row.get(3)?,
                    replacement: row.get(4)?,
                    is_regex: row.get(5)?,
                    scope: row.get(6)?,
                    enabled: row.get(7)?,
                    serial: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rules)
    }

    /// Adds a rule when `id` is empty, otherwise updates it.
    pub fn save_replace_rule(&mut self, rule: &ReplaceRule) -> Result<ReplaceRule, AppError> {
        let name = rule.name.trim();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(AppError::invalid_argument(
                "replace rule names need 1 to 64 characters",
            ));
        }
        if rule.pattern.chars().count() > 4000 || rule.replacement.chars().count() > 4000 {
            return Err(AppError::invalid_argument(
                "replace rule patterns allow 4000 characters",
            ));
        }
        transform::validate_rule(&TransformRule {
            pattern: rule.pattern.clone(),
            replacement: rule.replacement.clone(),
            regex: rule.is_regex,
        })?;
        let mut saved = ReplaceRule {
            name: name.to_string(),
            ..rule.clone()
        };
        if saved.id.is_empty() {
            saved.id = Uuid::new_v4().to_string();
            saved.serial = self.conn.query_row(
                "SELECT COALESCE(MAX(serial), 0) + 1 FROM replace_rules",
                [],
                |row| row.get(0),
            )?;
        } else {
            let exists: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM replace_rules WHERE id = ?1)",
                params![saved.id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(AppError::new(
                    ErrorCode::NotFound,
                    "replace rule was not found",
                ));
            }
        }
        self.conn.execute(
            "INSERT INTO replace_rules(id, name, rule_group, pattern, replacement, is_regex,
                scope, enabled, serial, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                rule_group = excluded.rule_group, pattern = excluded.pattern,
                replacement = excluded.replacement, is_regex = excluded.is_regex,
                scope = excluded.scope, enabled = excluded.enabled,
                updated_at = excluded.updated_at",
            params![
                saved.id,
                saved.name,
                saved.group.trim(),
                saved.pattern,
                saved.replacement,
                saved.is_regex,
                saved.scope.trim(),
                saved.enabled,
                saved.serial,
                now_millis()
            ],
        )?;
        Ok(saved)
    }

    pub fn delete_replace_rules(&mut self, ids: &[String]) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM replace_rules WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Rewrites the order of every rule; `ids` must list each exactly once.
    pub fn order_replace_rules(&mut self, ids: &[String]) -> Result<Vec<ReplaceRule>, AppError> {
        let existing: HashSet<String> = self
            .list_replace_rules()?
            .into_iter()
            .map(|rule| rule.id)
            .collect();
        let requested: HashSet<&String> = ids.iter().collect();
        if requested.len() != ids.len()
            || existing.len() != ids.len()
            || !ids.iter().all(|id| existing.contains(id))
        {
            return Err(AppError::invalid_argument(
                "the rule order must list every replace rule once",
            ));
        }
        let tx = self.conn.transaction()?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE replace_rules SET serial = ?1 WHERE id = ?2",
                params![index as i64 + 1, id],
            )?;
        }
        tx.commit()?;
        self.list_replace_rules()
    }

    /// Imports Legado replace rules (one object or an array); skips rules that
    /// already exist with the same pattern and replacement, and rules whose
    /// expressions do not compile.
    pub fn import_replace_rules(&mut self, json: &str) -> Result<Vec<ReplaceRule>, AppError> {
        let value: serde_json::Value = serde_json::from_str(json).map_err(|error| {
            AppError::invalid_argument(format!("not a replace rule JSON file: {error}"))
        })?;
        let items = match value {
            serde_json::Value::Array(items) => items,
            item @ serde_json::Value::Object(_) => vec![item],
            _ => return Err(AppError::invalid_argument("not a replace rule JSON file")),
        };
        let existing = self.list_replace_rules()?;
        let mut imported: Vec<ReplaceRule> = Vec::new();
        for item in items.iter().take(1000) {
            let text = |key: &str| item.get(key).and_then(|value| value.as_str()).unwrap_or("");
            let flag = |key: &str, default: bool| {
                item.get(key)
                    .and_then(|value| value.as_bool())
                    .unwrap_or(default)
            };
            let pattern = text("pattern");
            let replacement = text("replacement");
            // Title-only rules have nothing to change in the stored text.
            if pattern.is_empty() || !flag("scopeContent", true) {
                continue;
            }
            if existing
                .iter()
                .chain(imported.iter())
                .any(|rule| rule.pattern == pattern && rule.replacement == replacement)
            {
                continue;
            }
            let name = if text("name").trim().is_empty() {
                pattern.chars().take(32).collect()
            } else {
                text("name").to_string()
            };
            let rule = ReplaceRule {
                id: String::new(),
                name,
                group: text("group").to_string(),
                pattern: pattern.to_string(),
                replacement: replacement.to_string(),
                is_regex: flag("isRegex", true),
                scope: text("scope").to_string(),
                enabled: flag("isEnabled", true),
                serial: 0,
            };
            match self.save_replace_rule(&rule) {
                Ok(saved) => imported.push(saved),
                Err(error) if error.code == ErrorCode::InvalidArgument => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(imported)
    }

    /// Exports every rule in Legado's format.
    pub fn export_replace_rules(&self) -> Result<String, AppError> {
        let rules: Vec<_> = self
            .list_replace_rules()?
            .into_iter()
            .map(|rule| {
                serde_json::json!({
                    "name": rule.name,
                    "group": rule.group,
                    "pattern": rule.pattern,
                    "replacement": rule.replacement,
                    "isRegex": rule.is_regex,
                    "scope": rule.scope,
                    "scopeTitle": false,
                    "scopeContent": true,
                    "isEnabled": rule.enabled,
                    "order": rule.serial,
                })
            })
            .collect();
        Ok(serde_json::to_string_pretty(&rules)?)
    }

    pub fn set_book_replace_rules(&mut self, book_id: &str, enabled: bool) -> Result<(), AppError> {
        self.get_book(book_id)?;
        self.conn.execute(
            "UPDATE books SET use_replace_rules = ?2 WHERE id = ?1",
            params![book_id, enabled],
        )?;
        Ok(())
    }

    /// The transform a book's text should carry now: its enabled, in-scope
    /// replace rules (unless the book turned them off) and the reading
    /// style's Chinese conversion.
    pub(crate) fn book_transform(&self, book_id: &str) -> Result<TextTransform, AppError> {
        let (title, use_rules): (String, bool) = self.conn.query_row(
            "SELECT title, use_replace_rules FROM books WHERE id = ?1",
            params![book_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let rules = if use_rules {
            self.list_replace_rules()?
                .into_iter()
                .filter(|rule| rule.enabled && rule_in_scope(&rule.scope, &title))
                .map(|rule| TransformRule {
                    pattern: rule.pattern,
                    replacement: rule.replacement,
                    regex: rule.is_regex,
                })
                .collect()
        } else {
            Vec::new()
        };
        Ok(TextTransform {
            rules,
            chinese: self.get_settings()?.style.chinese_conversion,
        })
    }

    /// Whether the managed text was produced with a different transform than
    /// the book should carry now, so a re-decode must apply it.
    pub fn text_transform_pending(&self, book_id: &str) -> Result<bool, AppError> {
        let record = self.asset_for_book(book_id)?;
        let stored: Option<(Option<String>, Option<String>)> = self
            .conn
            .query_row(
                "SELECT transform_json, source_relative_path FROM txt_assets WHERE asset_id = ?1",
                params![record.asset.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((stored, Some(_source))) = stored else {
            // Without retained source bytes the text cannot be re-derived.
            return Ok(false);
        };
        Ok(TextTransform::from_stored(stored.as_deref()) != self.book_transform(book_id)?)
    }

    pub fn book_toc_settings(&self, book_id: &str) -> Result<(BookTocSettings, i64), AppError> {
        self.get_book(book_id)?;
        let saved: Option<(Option<String>, bool, i64)> = self
            .conn
            .query_row(
                "SELECT rule_id, split_long_chapters, revision FROM book_toc_settings
                 WHERE book_id = ?1",
                params![book_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        Ok(saved.map_or(
            (BookTocSettings::default(), 0),
            |(rule_id, split, revision)| {
                (
                    BookTocSettings {
                        rule_id,
                        split_long_chapters: split,
                    },
                    revision,
                )
            },
        ))
    }

    pub fn save_book_toc_settings(
        &mut self,
        book_id: &str,
        settings: &BookTocSettings,
    ) -> Result<BookTocSettings, AppError> {
        self.get_book(book_id)?;
        let tx = self.conn.transaction()?;
        if let Some(rule_id) = settings.rule_id.as_deref() {
            let exists: Option<String> = tx
                .query_row(
                    "SELECT id FROM txt_toc_rules WHERE id = ?1",
                    params![rule_id],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(AppError::new(ErrorCode::NotFound, "TOC rule was not found"));
            }
        }
        tx.execute(
            "INSERT INTO book_toc_settings(book_id, rule_id, split_long_chapters, revision, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4)
             ON CONFLICT(book_id) DO UPDATE SET rule_id = excluded.rule_id,
                split_long_chapters = excluded.split_long_chapters,
                revision = book_toc_settings.revision + 1, updated_at = excluded.updated_at",
            params![book_id, settings.rule_id, settings.split_long_chapters, now_millis()],
        )?;
        tx.commit()?;
        Ok(settings.clone())
    }

    /// The resolved build input: the selected rule, or every enabled rule for
    /// automatic choice. Its JSON identifies cached TOCs, so editing, toggling,
    /// or reordering rules invalidates exactly the books they can affect.
    pub(crate) fn toc_rule_snapshot(&self, book_id: &str) -> Result<(TocBuildRule, i64), AppError> {
        let (settings, revision) = self.book_toc_settings(book_id)?;
        let rules = self.list_txt_toc_rules()?;
        let spec = |rule: &TxtTocRule| RuleSpec {
            id: rule.id.clone(),
            name: rule.name.clone(),
            pattern: rule.pattern.clone(),
        };
        let selected = settings
            .rule_id
            .as_deref()
            .and_then(|id| rules.iter().find(|rule| rule.id == id));
        let build = match selected {
            Some(rule) => TocBuildRule {
                automatic: false,
                rules: vec![spec(rule)],
                split_long_chapters: settings.split_long_chapters,
            },
            None => TocBuildRule {
                automatic: true,
                rules: rules.iter().filter(|rule| rule.enabled).map(spec).collect(),
                split_long_chapters: settings.split_long_chapters,
            },
        };
        Ok((build, revision))
    }

    pub fn book_info(&self, book_id: &str) -> Result<BookInfo, AppError> {
        if self.is_online_book(book_id)? {
            let record = self.online_record(book_id)?;
            let reading_seconds: i64 = self.conn.query_row(
                "SELECT COALESCE(SUM(seconds), 0) FROM reading_time WHERE book_id = ?1",
                params![book_id],
                |row| row.get(0),
            )?;
            // An introduction the reader edited wins over the source's.
            let own = self
                .book_intro(book_id)?
                .filter(|intro| !intro.trim().is_empty());
            return Ok(BookInfo {
                book_id: book_id.to_string(),
                intro: own.or(Some(record.book.intro).filter(|intro| !intro.trim().is_empty())),
                source_byte_length: 0,
                chapter_count: Some(u64::from(self.online_chapter_count(book_id)?)),
                reading_seconds: reading_seconds.max(0) as u64,
            });
        }
        let record = self.asset_for_book(book_id)?;
        let (intro, entries_json): (Option<String>, Option<String>) = self.conn.query_row(
            "SELECT b.intro, t.entries_json FROM books b
             LEFT JOIN toc_cache t ON t.asset_id = ?2
             WHERE b.id = ?1",
            params![book_id, record.asset.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        // The retained original file gives the size the reader imported.
        let source_path: Option<String> = self
            .conn
            .query_row(
                "SELECT source_relative_path FROM txt_assets WHERE asset_id = ?1",
                params![record.asset.id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let source_byte_length = source_path
            .and_then(|path| managed_path(&self.root, &path, "sources").ok())
            .and_then(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len() as i64);
        let chapter_count = entries_json
            .and_then(|json| serde_json::from_str::<TocBuild>(&json).ok())
            .map(|build| build.entries.len() as u64);
        let reading_seconds: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(seconds), 0) FROM reading_time WHERE book_id = ?1",
            params![book_id],
            |row| row.get(0),
        )?;
        Ok(BookInfo {
            book_id: book_id.to_string(),
            reading_seconds: reading_seconds.max(0) as u64,
            intro: intro.filter(|intro| !intro.is_empty()),
            source_byte_length: source_byte_length
                .map_or(record.asset.byte_length, |length| length.max(0) as u64),
            chapter_count,
        })
    }

    /// Records the introduction found by a TOC build unless the book has one.
    pub(crate) fn remember_intro(
        &self,
        book_id: &str,
        intro: Option<&str>,
    ) -> Result<(), AppError> {
        if let Some(intro) = intro {
            self.conn.execute(
                "UPDATE books SET intro = ?2 WHERE id = ?1 AND intro IS NULL",
                params![book_id, intro],
            )?;
        }
        Ok(())
    }

    pub fn list_toc(&mut self, book_id: &str) -> Result<TocBuild, AppError> {
        let context = self.content_read_context(book_id)?;
        let verified = verify_content_context(&context)?;
        let (rule, revision) = self.toc_rule_snapshot(book_id)?;
        if let Some(build) = self.cached_toc(&context, &rule, revision)? {
            self.persist_content_index(&context, &verified)?;
            return Ok(build);
        }
        let build = build_toc_from_context(&context, &verified, book_id, &rule)?;
        self.persist_content_index(&context, &verified)?;
        self.cache_toc(&context, &build, &rule, revision)?;
        Ok(build)
    }

    pub(crate) fn cached_toc(
        &self,
        context: &ContentReadContext,
        rule: &TocBuildRule,
        revision: i64,
    ) -> Result<Option<TocBuild>, AppError> {
        self.validate_toc_snapshot(context, rule, revision)?;
        let identity = toc_rule_identity(rule)?;
        let cached: Option<(String, String, i64, String)> = self
            .conn
            .query_row(
                "SELECT content_version, rule_identity, rule_revision, entries_json
                 FROM toc_cache WHERE asset_id = ?1",
                params![context.record.asset.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((version, cached_identity, cached_revision, json)) = cached else {
            return Ok(None);
        };
        if version != context.record.asset.content_version
            || cached_identity != identity
            || cached_revision != revision
        {
            return Ok(None);
        }
        // Caches written before schema 9 hold a bare entry array and rebuild.
        let mut build = serde_json::from_str::<TocBuild>(&json).ok();
        if let Some(build) = build.as_mut() {
            build.entries.iter_mut().for_each(|entry| {
                entry.locator.resource_id = context.record.asset.id.clone();
            });
        }
        Ok(build)
    }

    pub(crate) fn cache_toc(
        &self,
        context: &ContentReadContext,
        build: &TocBuild,
        rule: &TocBuildRule,
        revision: i64,
    ) -> Result<(), AppError> {
        self.validate_toc_snapshot(context, rule, revision)?;
        let serialized = serde_json::to_string(build)?;
        self.remember_intro(&context.record.asset.book_id, build.intro.as_deref())?;
        let identity = toc_rule_identity(rule)?;
        self.conn.execute(
            "INSERT INTO toc_cache(
                asset_id, content_version, rule_identity, rule_revision, entries_json, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(asset_id) DO UPDATE SET content_version = excluded.content_version,
                rule_identity = excluded.rule_identity, rule_revision = excluded.rule_revision,
                entries_json = excluded.entries_json, updated_at = excluded.updated_at",
            params![
                context.record.asset.id,
                context.record.asset.content_version,
                identity,
                revision,
                serialized,
                now_millis()
            ],
        )?;
        Ok(())
    }

    /// TOC workers release the storage mutex while scanning text. Check both
    /// inputs again under that mutex before publishing or returning a result.
    pub(crate) fn toc_snapshot_is_current(
        &self,
        context: &ContentReadContext,
        rule: &TocBuildRule,
        revision: i64,
    ) -> Result<bool, AppError> {
        if !self.content_snapshot_is_current(context)? {
            return Ok(false);
        }
        let (current_rule, current_revision) =
            self.toc_rule_snapshot(&context.record.asset.book_id)?;
        Ok(current_rule == *rule && current_revision == revision)
    }

    fn validate_toc_snapshot(
        &self,
        context: &ContentReadContext,
        rule: &TocBuildRule,
        revision: i64,
    ) -> Result<(), AppError> {
        if !self.toc_snapshot_is_current(context, rule, revision)? {
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "content or TOC rule changed while the directory was being read",
            ));
        }
        Ok(())
    }

    pub fn list_bookmarks(&self, book_id: &str) -> Result<Vec<Bookmark>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, book_id, content_version, locator_json, excerpt, created_at, note
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
                    note: row.get(6)?,
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
        self.insert_bookmark(request)
    }

    /// Stores a bookmark whose locator the caller has checked.
    pub(crate) fn insert_bookmark(&self, request: &BookmarkRequest) -> Result<Bookmark, AppError> {
        let id = Uuid::new_v4().to_string();
        let bookmark = Bookmark {
            id: id.clone(),
            book_id: request.book_id.clone(),
            content_version: request.locator.content_version.clone(),
            locator: request.locator.clone(),
            excerpt: request.excerpt.clone(),
            note: request.note.clone().unwrap_or_default(),
            created_at: now_millis(),
        };
        if bookmark.note.chars().count() > 2000 {
            return Err(AppError::invalid_argument(
                "bookmark notes allow 2000 characters",
            ));
        }
        self.conn.execute(
            "INSERT INTO bookmarks(id, book_id, content_version, offset, locator_json, excerpt, created_at, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(book_id, content_version, offset) DO UPDATE SET
                note = CASE WHEN excluded.note = '' THEN bookmarks.note ELSE excluded.note END",
            params![
                bookmark.id,
                bookmark.book_id,
                bookmark.content_version,
                bookmark.locator.offset as i64,
                serde_json::to_string(&bookmark.locator)?,
                bookmark.excerpt,
                bookmark.created_at,
                bookmark.note
            ],
        )?;
        self.conn
            .query_row(
                "SELECT id, book_id, content_version, locator_json, excerpt, created_at, note
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
                        note: row.get(6)?,
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
                regex: request.regex,
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
        let source: Option<TxtSourceRow> = self
            .conn
            .query_row(
                "SELECT source_relative_path, source_sha256, selected_encoding, transform_json
                 FROM txt_assets WHERE asset_id = ?1",
                params![context.record.asset.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((Some(source_relative_path), source_sha256, selected_encoding, transform_json)) =
            source
        else {
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
            position: self.saved_position(book_id)?,
            bookmarks: self.list_bookmarks(book_id)?,
            applied: TextTransform::from_stored(transform_json.as_deref()),
            target: self.book_transform(book_id)?,
        })
    }

    pub(crate) fn snapshot_txt_reassociation(
        &self,
        book_id: &str,
    ) -> Result<TxtReassociationSnapshot, AppError> {
        let context = self.content_read_context(book_id)?;
        let source: (Option<String>, Option<String>, String, Option<String>) = self
            .conn
            .query_row(
                "SELECT source_relative_path, source_sha256, selected_encoding, transform_json
                 FROM txt_assets WHERE asset_id = ?1",
                params![context.record.asset.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .unwrap_or((None, None, "utf8".to_string(), None));
        let (source_relative_path, source_sha256, selected_encoding, transform_json) = source;
        let default_relative_path = format!("sources/{}.txt", context.record.asset.id);
        let target_relative_path = source_relative_path
            .clone()
            .unwrap_or_else(|| default_relative_path.clone());
        if let Some(relative_path) = source_relative_path.as_deref() {
            let source_path = managed_path(&self.root, relative_path, "sources")?;
            if source_path.is_file() {
                return Err(AppError::new(
                    ErrorCode::ContentVersionMismatch,
                    "the book already has retained TXT source bytes",
                ));
            }
        }
        Ok(TxtReassociationSnapshot {
            book_id: context.record.asset.book_id,
            asset_id: context.record.asset.id,
            source_relative_path,
            source_sha256,
            target_relative_path,
            content_version: context.record.asset.content_version,
            selected_encoding: parse_encoding(selected_encoding),
            transform: TextTransform::from_stored(transform_json.as_deref()),
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
        let text = transform::apply(&decoded.text, &snapshot.transform).0;
        let content_version = sha256_bytes(text.as_bytes());
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
                stage_fingerprint: None,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(stage_path);
        }
        result
    }

    /// Verify the operation-owned staging bytes before acquiring the storage
    /// mutex. The locked commit only compares this metadata fingerprint, so a
    /// large retained source is never hashed while readers are blocked.
    pub(crate) fn verify_prepared_txt_reassociation(
        root: &Path,
        prepared: &mut PreparedTxtReassociation,
    ) -> Result<(), AppError> {
        let stage_path = managed_path(root, &prepared.stage_relative_path, "staging")?;
        let result = (|| -> Result<String, AppError> {
            if !stage_path.is_file() {
                return Err(AppError::new(
                    ErrorCode::AssetMissing,
                    "prepared TXT source staging file is missing",
                ));
            }
            let fingerprint_before = file_fingerprint(&stage_path)?.1;
            let actual_hash = hash_file(&stage_path)?;
            let fingerprint_after = file_fingerprint(&stage_path)?.1;
            if fingerprint_before != fingerprint_after {
                return Err(AppError::new(
                    ErrorCode::ContentVersionMismatch,
                    "prepared TXT source changed during verification",
                ));
            }
            if actual_hash != prepared.source_sha256 {
                return Err(AppError::new(
                    ErrorCode::ContentVersionMismatch,
                    "prepared TXT source bytes changed",
                ));
            }
            Ok(fingerprint_after)
        })();
        match result {
            Ok(fingerprint) => {
                prepared.stage_fingerprint = Some(fingerprint);
                Ok(())
            }
            Err(error) => {
                let _ = remove_owned_file(&stage_path);
                Err(error)
            }
        }
    }

    pub(crate) fn commit_txt_reassociation(
        &mut self,
        prepared: PreparedTxtReassociation,
    ) -> Result<TxtEncodingInfo, AppError> {
        let stage_path = managed_path(&self.root, &prepared.stage_relative_path, "staging")?;
        let source_path = managed_path(
            &self.root,
            &prepared.snapshot.target_relative_path,
            "sources",
        )?;
        if !stage_path.is_file() {
            return Err(AppError::new(
                ErrorCode::AssetMissing,
                "prepared TXT source staging file is missing",
            ));
        }
        // Preparation reads and hashes the candidate outside the storage
        // mutex. Recheck the complete database association and the cheap file
        // fingerprint while the mutex is held before publishing the source.
        match self.snapshot_txt_reassociation(&prepared.snapshot.book_id) {
            Ok(current) if current == prepared.snapshot => {}
            Ok(_) => {
                remove_owned_file(&stage_path)?;
                return Err(AppError::new(
                    ErrorCode::ContentVersionMismatch,
                    "book content or source changed while associating TXT",
                ));
            }
            Err(error) => {
                remove_owned_file(&stage_path)?;
                return Err(error);
            }
        }
        let Some(expected_fingerprint) = prepared.stage_fingerprint.as_deref() else {
            remove_owned_file(&stage_path)?;
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "prepared TXT source was not verified",
            ));
        };
        let current_fingerprint = match file_fingerprint(&stage_path) {
            Ok((_, fingerprint)) => fingerprint,
            Err(error) => {
                remove_owned_file(&stage_path)?;
                return Err(error);
            }
        };
        if current_fingerprint != expected_fingerprint {
            remove_owned_file(&stage_path)?;
            return Err(AppError::new(
                ErrorCode::ContentVersionMismatch,
                "prepared TXT source bytes changed",
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
            if let Err(error) = fs::create_dir_all(parent) {
                remove_owned_file(&stage_path)?;
                return Err(error.into());
            }
        }
        if let Err(error) = fs::rename(&stage_path, &source_path) {
            remove_owned_file(&stage_path)?;
            return Err(error.into());
        }
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
                    prepared.snapshot.target_relative_path,
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
        let mut decoded = detect_and_decode(&bytes, requested)?;
        if cancel.load(Ordering::Acquire) {
            return Err(import_cancelled());
        }
        // Positions map through the old transform back to decoded text, across
        // decodings, then forward through the new transform.
        let base_new = decoded.text.clone();
        let (transformed, new_map) = transform::apply(&base_new, &snapshot.target);
        decoded.text = transformed;
        let normalized_bytes = decoded.text.as_bytes();
        let content_version = sha256_bytes(normalized_bytes);
        let index_json = serde_json::to_string(&build_sparse_index(&decoded.text))?;
        let targets: Vec<(Option<String>, &ReaderLocator)> = snapshot
            .position
            .iter()
            .map(|locator| (None, locator))
            .chain(
                snapshot
                    .bookmarks
                    .iter()
                    .map(|bookmark| (Some(bookmark.id.clone()), &bookmark.locator)),
            )
            .filter(|(_, locator)| {
                locator.content_version == snapshot.content_version
                    && locator.resource_id == snapshot.asset_id
            })
            .collect();
        let mut relocated = Vec::new();
        if content_version != snapshot.content_version && !targets.is_empty() {
            if let Ok(old) = detect_and_decode(&bytes, snapshot.selected_encoding.clone()) {
                let (old_text, old_map) = transform::apply(&old.text, &snapshot.applied);
                if sha256_bytes(old_text.as_bytes()) == snapshot.content_version {
                    let offsets: Vec<u64> = targets
                        .iter()
                        .map(|(_, locator)| old_map.backward(locator.offset))
                        .collect();
                    let mapped = crate::relocation::map_offsets(
                        &bytes,
                        snapshot.selected_encoding.clone(),
                        decoded.selected.clone(),
                        &old.text,
                        &base_new,
                        &offsets,
                        cancel,
                    )?;
                    let boundaries = crate::txt::utf16_boundaries(&decoded.text);
                    for ((id, locator), mapped_offset) in targets.into_iter().zip(mapped) {
                        // Offsets inside a replaced line map proportionally;
                        // land on the character boundary at or before them.
                        let mapped_offset = mapped_offset.map(|offset| {
                            let offset = new_map.forward(offset);
                            let at = boundaries.partition_point(|(units, _)| *units <= offset);
                            boundaries[at.saturating_sub(1)].0
                        });
                        if let Some(offset) = mapped_offset {
                            if let Ok(index) =
                                boundaries.binary_search_by_key(&offset, |(units, _)| *units)
                            {
                                let before = boundaries.partition_point(|(units, _)| {
                                    *units < offset.saturating_sub(32)
                                });
                                let after = boundaries
                                    .partition_point(|(units, _)| {
                                        *units <= offset.saturating_add(32)
                                    })
                                    .saturating_sub(1);
                                relocated.push((
                                    id,
                                    ReaderLocator {
                                        content_version: content_version.clone(),
                                        offset,
                                        context_before: decoded.text
                                            [boundaries[before].1..boundaries[index].1]
                                            .to_string(),
                                        context_after: decoded.text
                                            [boundaries[index].1..boundaries[after].1]
                                            .to_string(),
                                        ..locator.clone()
                                    },
                                ));
                            }
                        }
                    }
                }
            }
        }

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
                relocated,
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
                    "book content, source or reading records changed while decoding",
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
                    decode_state = ?3, source_sha256 = ?4, toc_json = NULL, updated_at = ?5,
                    transform_json = ?7
                 WHERE asset_id = ?6",
                params![
                    encoding_name(&prepared.detected_encoding),
                    encoding_name(&prepared.selected_encoding),
                    decode_state_name(&prepared.decode_state),
                    prepared.source_sha256,
                    now_millis(),
                    prepared.snapshot.asset_id,
                    prepared.snapshot.target.to_stored()?
                ],
            )?;
            tx.execute(
                "DELETE FROM toc_cache WHERE asset_id = ?1",
                params![prepared.snapshot.asset_id],
            )?;
            for (bookmark_id, locator) in &prepared.relocated {
                let json = serde_json::to_string(locator)?;
                if let Some(id) = bookmark_id {
                    tx.execute("UPDATE bookmarks SET content_version = ?1, locator_json = ?2, excerpt = ?3 WHERE id = ?4 AND NOT EXISTS(SELECT 1 FROM bookmarks other WHERE other.book_id = ?5 AND other.content_version = ?1 AND json_extract(other.locator_json,'$.offset') = ?6 AND other.id != ?4)", params![locator.content_version,json,locator.context_after,id,locator.book_id,locator.offset as i64])?;
                } else {
                    // Preserve recency: encoding repair is not a new reading session.
                    tx.execute(
                        "UPDATE reading_positions SET locator_json = ?1 WHERE book_id = ?2",
                        params![json, locator.book_id],
                    )?;
                }
            }
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
            resource_id: None,
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

    pub fn update_book(&self, request: &UpdateBookRequest) -> Result<Book, AppError> {
        let title = request.title.trim();
        let author = request
            .author
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if title.is_empty()
            || title.chars().count() > 512
            || author.is_some_and(|value| value.chars().count() > 256)
        {
            return Err(AppError::invalid_argument(
                "title is required (max 512 characters); author allows 256 characters",
            ));
        }
        self.get_book(&request.book_id)?;
        if request
            .intro
            .as_ref()
            .is_some_and(|intro| intro.chars().count() > 5000)
        {
            return Err(AppError::invalid_argument(
                "introductions allow 5000 characters",
            ));
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE books SET title = ?1, author = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, author, now_millis(), request.book_id],
        )?;
        if let Some(intro) = request.intro.as_deref() {
            let intro = intro.trim();
            tx.execute(
                "UPDATE books SET intro = ?2 WHERE id = ?1",
                // An empty intro is kept, so chapter detection does not refill it.
                params![request.book_id, intro],
            )?;
        }
        tx.commit()?;
        self.get_book(&request.book_id)
    }
    pub fn remove_book(&self, book_id: &str) -> Result<(), AppError> {
        self.get_book(book_id)?;
        self.conn.execute("INSERT INTO shelf_removals(book_id,removed_at) VALUES(?1,?2) ON CONFLICT(book_id) DO NOTHING",params![book_id,now_millis()])?;
        Ok(())
    }
    /// Deletes a book from the app: the app's own copies of its text,
    /// original file, and cover. Its progress, bookmarks, and reading time
    /// are kept by its original file's hash and return when the same book
    /// is imported again. Files outside the app — the
    /// reader's own TXT and the cloud bookshelf copy — are untouched.
    pub fn delete_book(&mut self, book_id: &str) -> Result<(), AppError> {
        self.get_book(book_id)?;
        let cover = self.book_cover(book_id)?;
        let files: Vec<(String, String, Option<String>)> = {
            let mut statement = self.conn.prepare(
                "SELECT a.id, a.relative_path, t.source_relative_path FROM book_assets a
                 LEFT JOIN txt_assets t ON t.asset_id = a.id WHERE a.book_id = ?1",
            )?;
            let rows = statement
                .query_map(params![book_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        self.keep_records_for_reimport(book_id)?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM books WHERE id = ?1", params![book_id])?;
        tx.commit()?;
        if let Ok(mut indexes) = self.verified_indexes.lock() {
            for (asset_id, _, _) in &files {
                indexes.remove(asset_id);
            }
        }
        for (_, text, source) in &files {
            if let Ok(path) = managed_path(&self.root, text, "books") {
                let _ = remove_owned_file(&path);
                if let Some(parent) = path.parent() {
                    let _ = fs::remove_dir(parent);
                }
            }
            if let Some(source) = source.as_deref().filter(|value| !value.is_empty()) {
                if let Ok(path) = managed_path(&self.root, source, "sources") {
                    let _ = remove_owned_file(&path);
                }
            }
        }
        if let Some(cover) = cover {
            self.delete_reader_asset(&cover)?;
        }
        Ok(())
    }

    pub fn restore_book(&self, book_id: &str) -> Result<(), AppError> {
        self.get_book(book_id)?;
        self.conn.execute(
            "DELETE FROM shelf_removals WHERE book_id = ?1",
            params![book_id],
        )?;
        Ok(())
    }
    /// Built-in shelf tabs (全部 and the reading states) or a user group.
    fn shelf_group_exists(&self, id: &str) -> Result<bool, AppError> {
        if matches!(id, "all" | "reading" | "unread" | "finished") {
            return Ok(true);
        }
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_groups WHERE id = ?1)",
            params![id],
            |row| row.get::<_, bool>(0),
        )?)
    }
    pub fn get_shelf_preferences(&self) -> Result<ShelfPreferences, AppError> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT preferences_json FROM shelf_preferences WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let mut value: ShelfPreferences = json
            .map(|json| serde_json::from_str(&json))
            .transpose()?
            .unwrap_or_default();
        if !self.shelf_group_exists(&value.group_id)? {
            value.group_id = "all".into();
        }
        Ok(value)
    }
    pub fn save_shelf_preferences(
        &self,
        value: &ShelfPreferences,
    ) -> Result<ShelfPreferences, AppError> {
        if !self.shelf_group_exists(&value.group_id)? {
            return Err(AppError::new(
                ErrorCode::NotFound,
                "shelf group does not exist",
            ));
        }
        self.conn.execute("INSERT INTO shelf_preferences(id,preferences_json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET preferences_json = excluded.preferences_json",params![serde_json::to_string(value)?])?;
        Ok(value.clone())
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

    /// Copies a font into managed `assets/fonts` after checking its signature.
    /// Assets never affect book identity or content versions.
    pub fn import_reader_font(
        &mut self,
        source: &Path,
        name: &str,
    ) -> Result<ReaderAsset, AppError> {
        self.import_reader_asset(source, name, "font")
    }

    /// Copies a font (`font`) or an image (`cover`, `background`) into
    /// managed `assets/<kind>s` after checking its file signature.
    pub fn import_reader_asset(
        &mut self,
        source: &Path,
        name: &str,
        kind: &str,
    ) -> Result<ReaderAsset, AppError> {
        let bytes = fs::read(source)?;
        let (extension, limit, label) = match kind {
            "font" => (
                font_extension(&bytes).ok_or_else(|| {
                    AppError::invalid_argument("the file is not a TrueType, OpenType, or WOFF font")
                })?,
                64 * 1024 * 1024,
                "fonts larger than 64 MB are not supported",
            ),
            "cover" | "background" => (
                image_extension(&bytes).ok_or_else(|| {
                    AppError::invalid_argument("the file is not a PNG, JPEG, WebP, or GIF image")
                })?,
                20 * 1024 * 1024,
                "images larger than 20 MB are not supported",
            ),
            _ => return Err(AppError::invalid_argument("unknown asset kind")),
        };
        if bytes.len() > limit {
            return Err(AppError::invalid_argument(label));
        }
        let id = Uuid::new_v4().to_string();
        let relative_path = format!("assets/{kind}s/{id}.{extension}");
        let path = managed_path(&self.root, &relative_path, "assets")?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let stem = Path::new(name)
            .file_stem()
            .map(|stem| stem.to_string_lossy().trim().to_string())
            .filter(|stem| !stem.is_empty())
            .unwrap_or_else(|| "导入文件".to_string());
        let stage = path.with_extension("part");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage)?;
        let written = file.write_all(&bytes).and_then(|()| file.sync_all());
        drop(file);
        if let Err(error) = written {
            let _ = fs::remove_file(&stage);
            return Err(error.into());
        }
        fs::rename(&stage, &path)?;
        let asset = ReaderAsset {
            id,
            name: stem.chars().take(64).collect(),
            byte_length: bytes.len() as u64,
            created_at: now_millis(),
        };
        if let Err(error) = self.conn.execute(
            "INSERT INTO reader_assets(id, kind, name, relative_path, byte_length, created_at)
             VALUES (?1, ?6, ?2, ?3, ?4, ?5)",
            params![
                asset.id,
                asset.name,
                relative_path,
                asset.byte_length as i64,
                asset.created_at,
                kind
            ],
        ) {
            let _ = fs::remove_file(&path);
            return Err(error.into());
        }
        Ok(asset)
    }

    pub fn list_reader_fonts(&self) -> Result<Vec<ReaderAsset>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, byte_length, created_at FROM reader_assets
             WHERE kind = 'font' ORDER BY created_at, id",
        )?;
        let fonts = statement
            .query_map([], |row| {
                Ok(ReaderAsset {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    byte_length: row.get::<_, i64>(2)?.max(0) as u64,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(fonts)
    }

    /// Bytes of any managed asset: fonts, covers, and backgrounds.
    pub fn read_reader_font(&self, id: &str) -> Result<Vec<u8>, AppError> {
        let relative_path: String = self
            .conn
            .query_row(
                "SELECT relative_path FROM reader_assets WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "asset was not found"))?;
        let path = managed_path(&self.root, &relative_path, "assets")?;
        fs::read(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::new(ErrorCode::AssetMissing, "asset file is missing")
            } else {
                error.into()
            }
        })
    }

    pub fn import_reader_background(
        &mut self,
        source: &Path,
        name: &str,
    ) -> Result<ReaderAsset, AppError> {
        self.import_reader_asset(source, name, "background")
    }

    /// Background images are referenced only by saved reading styles, which
    /// are written after a debounce; unused images are therefore removed at
    /// startup, never while an unsaved style may still name a new image.
    fn remove_unused_backgrounds(&self) -> Result<(), AppError> {
        let preferences = self.get_settings()?;
        let used: HashSet<String> = preferences
            .style
            .presets
            .iter()
            .flat_map(|preset| [&preset.background_image, &preset.night_background_image])
            .flatten()
            .cloned()
            .collect();
        let ids: Vec<String> = {
            let mut statement = self
                .conn
                .prepare("SELECT id FROM reader_assets WHERE kind = 'background'")?;
            let rows = statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for id in ids.into_iter().filter(|id| !used.contains(id)) {
            self.delete_reader_asset(&id)?;
        }
        Ok(())
    }

    /// Removes an asset record and its file; callers clear references first.
    fn delete_reader_asset(&self, id: &str) -> Result<(), AppError> {
        let relative_path: Option<String> = self
            .conn
            .query_row(
                "SELECT relative_path FROM reader_assets WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(relative_path) = relative_path else {
            return Ok(());
        };
        self.conn
            .execute("DELETE FROM reader_assets WHERE id = ?1", params![id])?;
        let path = managed_path(&self.root, &relative_path, "assets")?;
        match fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    /// Deletes a font and, in the same transaction, clears any preference
    /// that selected it, so saved preferences never name a missing font.
    pub fn delete_reader_font(&mut self, id: &str) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        let relative_path: String = tx
            .query_row(
                "SELECT relative_path FROM reader_assets WHERE id = ?1 AND kind = 'font'",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "font was not found"))?;
        let saved: Option<String> = tx
            .query_row(
                "SELECT preferences_json FROM reader_preferences WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(saved) = saved {
            let mut preferences: ReaderPreferences = serde_json::from_str(&saved)?;
            if preferences.style.font_asset_id.as_deref() == Some(id) {
                preferences.style.font_asset_id = None;
                tx.execute(
                    "UPDATE reader_preferences SET preferences_json = ?1, updated_at = ?2 WHERE id = 1",
                    params![serde_json::to_string(&preferences)?, now_millis()],
                )?;
            }
        }
        tx.execute("DELETE FROM reader_assets WHERE id = ?1", params![id])?;
        tx.commit()?;
        let path = managed_path(&self.root, &relative_path, "assets")?;
        match fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
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

    pub(crate) fn content_snapshot_is_current(
        &self,
        context: &ContentReadContext,
    ) -> Result<bool, AppError> {
        let record = self.asset_for_book(&context.record.asset.book_id)?;
        Ok(record.asset.id == context.record.asset.id
            && record.asset.content_version == context.record.asset.content_version
            && record.asset.sha256 == context.record.asset.sha256
            && record.asset.byte_length == context.record.asset.byte_length
            && record.relative_path == context.record.relative_path)
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
        // A font copied but not recorded (or a leftover .part) is unreachable.
        let referenced_assets: HashSet<String> = {
            let mut statement = self
                .conn
                .prepare("SELECT relative_path FROM reader_assets")?;
            let result = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()?;
            result
        };
        remove_orphans_recursive(&self.root.join("assets"), &self.root, &referenced_assets)?;
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
    let mut decoded = detect_and_decode(&bytes, selected.clone())?;
    // The committed text may carry replace rules or Chinese conversion.
    decoded.text = transform::apply(&decoded.text, &target.transform).0;
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
        previous_resource_id: None,
        next_resource_id: None,
        resource_index: None,
        resource_count: None,
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

pub(crate) fn resolve_offset_from_context(
    request: &ResolveOffsetRequest,
    context: &ContentReadContext,
    verified: &VerifiedContentIndex,
) -> Result<ReaderLocator, AppError> {
    if request.content_version != context.record.asset.content_version {
        return Err(AppError::new(
            ErrorCode::ContentVersionMismatch,
            "reader content version changed",
        ));
    }
    if request.resource_id != context.record.asset.id
        || request.offset > verified.index.utf16_length
    {
        return Err(AppError::new(
            ErrorCode::InvalidLocator,
            "reader offset or resource is invalid",
        ));
    }
    let boundary = boundary_for_offset(
        &context.root,
        &context.record.relative_path,
        &verified.index,
        request.offset,
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
    rule: &TocBuildRule,
) -> Result<TocBuild, AppError> {
    let text = read_verified_text(context, verified)?;
    let mut build = build_toc(&text, book_id, &context.record.asset.content_version, rule)?;
    build.entries.iter_mut().for_each(|entry| {
        entry.locator.resource_id = context.record.asset.id.clone();
    });
    Ok(build)
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
        regex,
        cursor,
        limit,
    } = parameters;
    if query.is_empty() || limit == 0 {
        return Ok((Vec::new(), None, false));
    }
    let needle: Vec<char> = query.chars().collect();
    // Regular expressions match within one line, as Legado searches by line;
    // a line that exceeds the backtracking limit is skipped.
    let pattern = if regex {
        let source = if case_sensitive {
            query.to_string()
        } else {
            format!("(?i){query}")
        };
        Some(fancy_regex::Regex::new(&source).map_err(|error| {
            AppError::invalid_argument(format!("invalid regular expression: {error}"))
        })?)
    } else {
        None
    };
    let path = managed_path(&context.root, &context.record.relative_path, "books")?;
    let mut pending = Vec::new();
    let mut utf16_offset = 0_u64;
    let mut ring: Vec<(char, u64)> = Vec::with_capacity(needle.len());
    let mut line = String::new();
    let mut line_start = 0_u64;
    let mut seen = 0_u64;
    let mut matches = Vec::new();
    let mut byte_offset = 0_u64;
    let build = |match_start: u64, match_end: u64, ordinal: u64| -> Result<SearchMatch, AppError> {
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
        Ok(SearchMatch {
            ordinal,
            locator,
            excerpt,
            match_start,
            match_end,
        })
    };
    // Records one match; `Some` ends the search with a cursor for more.
    let mut accept = |match_start: u64,
                      match_end: u64,
                      matches: &mut Vec<SearchMatch>|
     -> Result<Option<u64>, AppError> {
        if seen < cursor {
            seen += 1;
            return Ok(None);
        }
        if matches.len() >= limit as usize {
            return Ok(Some(seen));
        }
        matches.push(build(match_start, match_end, seen)?);
        seen += 1;
        Ok(None)
    };
    let line_matches = |line: &str, line_start: u64| -> Vec<(u64, u64)> {
        let Some(pattern) = &pattern else {
            return Vec::new();
        };
        let units = |text: &str| text.encode_utf16().count() as u64;
        pattern
            .find_iter(line)
            .map_while(Result::ok)
            .filter(|found| found.start() < found.end())
            .map(|found| {
                let start = line_start + units(&line[..found.start()]);
                (start, start + units(found.as_str()))
            })
            .collect()
    };
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
            if pattern.is_some() {
                if character != '\n' {
                    line.push(character);
                    continue;
                }
                for (start, end) in line_matches(&line, line_start) {
                    if let Some(next) = accept(start, end, &mut matches)? {
                        return Ok((matches, Some(next), true));
                    }
                }
                line.clear();
                line_start = utf16_offset;
                continue;
            }
            ring.push((character, start_offset));
            if ring.len() > needle.len() {
                ring.remove(0);
            }
            if ring.len() != needle.len() || !chars_match(&ring, &needle, case_sensitive) {
                continue;
            }
            if let Some(next) = accept(ring[0].1, utf16_offset, &mut matches)? {
                return Ok((matches, Some(next), true));
            }
        }
        pending = remainder;
    }
    if !pending.is_empty() {
        return Err(AppError::new(
            ErrorCode::UnsupportedEncoding,
            "managed TXT asset ends with an incomplete UTF-8 sequence",
        ));
    }
    for (start, end) in line_matches(&line, line_start) {
        if let Some(next) = accept(start, end, &mut matches)? {
            return Ok((matches, Some(next), true));
        }
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
        .is_none_or(|entry| entry.utf16_offset != utf16_length)
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

pub(crate) fn sha256_bytes(bytes: &[u8]) -> String {
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

/// Legado scopes list book titles separated by `;`, `,`, or new lines.
fn rule_in_scope(scope: &str, title: &str) -> bool {
    let names: Vec<&str> = scope
        .split([';', ',', '，', '；', '\n'])
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    names.is_empty() || names.iter().any(|name| title.contains(name))
}

fn shelf_state_name(state: ShelfState) -> &'static str {
    match state {
        ShelfState::Reading => "reading",
        ShelfState::Unread => "unread",
        ShelfState::Finished => "finished",
    }
}

fn parse_shelf_state(value: &str) -> Option<ShelfState> {
    match value {
        "reading" => Some(ShelfState::Reading),
        "unread" => Some(ShelfState::Unread),
        "finished" => Some(ShelfState::Finished),
        _ => None,
    }
}

/// The extension for an image file identified by its signature.
fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// The extension for a font file identified by its signature.
fn font_extension(bytes: &[u8]) -> Option<&'static str> {
    match bytes.get(..4)? {
        [0x00, 0x01, 0x00, 0x00] | b"true" => Some("ttf"),
        b"OTTO" => Some("otf"),
        b"ttcf" => Some("ttc"),
        b"wOFF" => Some("woff"),
        b"wOF2" => Some("woff2"),
        _ => None,
    }
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

/// Bumped when the chapter algorithm changes, so cached directories rebuild.
const TOC_ALGORITHM: u32 = 2;

fn toc_rule_identity(rule: &TocBuildRule) -> Result<String, AppError> {
    Ok(format!("v{TOC_ALGORITHM}:{}", serde_json::to_string(rule)?))
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

fn txt_toc_rule_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TxtTocRule> {
    Ok(TxtTocRule {
        id: row.get(0)?,
        name: row.get(1)?,
        pattern: row.get(2)?,
        example: row.get(3)?,
        serial: row.get(4)?,
        enabled: row.get(5)?,
        builtin: row.get(6)?,
    })
}

/// Schema 9: Legado's rule table seeded with its 26 defaults, per-book
/// settings migrated from the schema 8 modes, book introductions, managed
/// reading assets, and authors parsed from existing titles.
fn migrate_to_legado_toc_rules(tx: &rusqlite::Transaction<'_>) -> Result<(), AppError> {
    tx.execute_batch(
        "CREATE TABLE txt_toc_rules (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            pattern TEXT NOT NULL,
            example TEXT NOT NULL DEFAULT '',
            serial INTEGER NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            builtin INTEGER NOT NULL CHECK(builtin IN (0, 1)),
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE book_toc_settings (
            book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            rule_id TEXT REFERENCES txt_toc_rules(id) ON DELETE SET NULL,
            split_long_chapters INTEGER NOT NULL DEFAULT 0 CHECK(split_long_chapters IN (0, 1)),
            revision INTEGER NOT NULL CHECK(revision > 0),
            updated_at INTEGER NOT NULL
        );
        ALTER TABLE books ADD COLUMN intro TEXT;
        CREATE TABLE reader_assets (
            id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('font')),
            name TEXT NOT NULL,
            relative_path TEXT NOT NULL UNIQUE,
            byte_length INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );",
    )?;
    let now = now_millis();
    for rule in crate::txt_toc::default_rules() {
        tx.execute(
            "INSERT INTO txt_toc_rules(id, name, pattern, example, serial, enabled, builtin, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
            params![rule.id, rule.name, rule.pattern, rule.example, rule.serial, rule.enabled, now],
        )?;
    }
    // Schema 8 modes map onto the nearest Legado rule; a custom pattern
    // becomes a disabled user rule so it does not affect other books.
    let legacy: Vec<(String, String, String, i64)> = {
        let mut statement =
            tx.prepare("SELECT book_id, mode, pattern, revision FROM book_toc_rules")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (book_id, mode, pattern, revision) in legacy {
        let rule_id = match mode.as_str() {
            "chinese" => Some("legado-2".to_string()),
            "english" => Some("legado-12".to_string()),
            "custom" if !pattern.is_empty() => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO txt_toc_rules(id, name, pattern, example, serial, enabled, builtin, updated_at)
                     VALUES (?1, '自定义规则（已迁移）', ?2, '', 100 + (SELECT COUNT(*) FROM txt_toc_rules), 0, 0, ?3)",
                    params![id, pattern, now],
                )?;
                Some(id)
            }
            _ => None,
        };
        tx.execute(
            "INSERT INTO book_toc_settings(book_id, rule_id, split_long_chapters, revision, updated_at)
             VALUES (?1, ?2, 0, ?3, ?4)",
            params![book_id, rule_id, revision.max(1) + 1, now],
        )?;
    }
    tx.execute_batch("DROP TABLE book_toc_rules; DELETE FROM toc_cache;")?;
    let untitled: Vec<(String, String)> = {
        let mut statement = tx.prepare("SELECT id, title FROM books WHERE author IS NULL")?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (id, title) in untitled {
        let parsed = parse_name_author(&title);
        if let Some(author) = parsed.author {
            tx.execute(
                "UPDATE books SET title = ?2, author = ?3 WHERE id = ?1",
                params![id, parsed.name, author],
            )?;
        }
    }
    Ok(())
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

    /// Prints import phase timings for a 6 MiB novel. Run with
    /// `cargo test import_timing -- --ignored --nocapture` (add `--release`
    /// to compare optimized dependencies).
    #[test]
    #[ignore]
    fn import_timing() {
        use std::time::Instant;
        let mut text = String::new();
        let mut chapter = 1;
        while text.len() < 6 * 1024 * 1024 {
            text.push_str(&format!("第{chapter}章 风起云涌\r\n"));
            for _ in 0..40 {
                text.push_str("　　少年站在山门之前，望着云海翻腾，心中暗暗发誓，此生定要踏上那九天之巅。Hello 😀\r\n");
            }
            chapter += 1;
        }
        let (gbk, _, _) = encoding_rs::GBK.encode(&text);
        for (name, bytes) in [
            ("utf8", text.as_bytes().to_vec()),
            ("gbk", gbk.into_owned()),
        ] {
            let root = TestRoot::new();
            let source = write_source(&root.0, &format!("{name}.txt"), &bytes);
            let started = Instant::now();
            let decoded = detect_and_decode(&bytes, TxtEncoding::Auto).unwrap();
            let decode = started.elapsed();
            let hashed = Instant::now();
            let _ = Sha256::digest(decoded.text.as_bytes());
            let _ = Sha256::digest(&bytes);
            let hash = hashed.elapsed();
            let indexed = Instant::now();
            let _ = build_sparse_index(&decoded.text);
            let index = indexed.elapsed();
            let mut storage = Storage::open(&root.0.join("data")).unwrap();
            let imported = Instant::now();
            let book = import(&mut storage, &source, name);
            let total = imported.elapsed();
            let listed = Instant::now();
            let toc = storage.list_toc(&book.book.id).unwrap();
            let directory = listed.elapsed();
            eprintln!(
                "{name} {} bytes: decode {decode:?}, hash {hash:?}, index {index:?}, full import {total:?}, directory {directory:?} ({} chapters by {})",
                bytes.len(),
                toc.entries.len(),
                toc.rule_name
            );
        }
    }

    #[test]
    fn exact_reader_offsets_floor_surrogates_and_validate_identity() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "offset.txt", "a😀b".as_bytes());
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let book = import(&mut storage, &source, "offset");
        let context = storage.content_read_context(&book.book.id).unwrap();
        let verified = verify_content_context(&context).unwrap();
        let mut request = ResolveOffsetRequest {
            book_id: book.book.id,
            content_version: book.asset.content_version,
            resource_id: book.asset.id,
            offset: 2,
        };
        let locator = resolve_offset_from_context(&request, &context, &verified).unwrap();
        assert_eq!(locator.offset, 1);
        assert_eq!(locator.context_before, "a");
        assert_eq!(locator.context_after, "😀b");
        request.offset = 4;
        assert_eq!(
            resolve_offset_from_context(&request, &context, &verified)
                .unwrap()
                .offset,
            4
        );
        request.offset = 5;
        assert_eq!(
            resolve_offset_from_context(&request, &context, &verified)
                .unwrap_err()
                .code,
            ErrorCode::InvalidLocator
        );
        request.content_version = "old".into();
        assert_eq!(
            resolve_offset_from_context(&request, &context, &verified)
                .unwrap_err()
                .code,
            ErrorCode::ContentVersionMismatch
        );
    }

    #[test]
    fn reading_modes_round_trip_without_a_schema_migration() {
        let root = TestRoot::new();
        let data = root.0.join("data");
        let storage = Storage::open(&data).unwrap();
        let preferences = ReaderPreferences {
            reading_mode: crate::models::ReaderMode::Scroll,
            page_turn_effect: crate::models::PageTurnEffect::Fade,
            auto_scroll_speed: 75,
            ..ReaderPreferences::default()
        };
        storage.save_settings(&preferences).unwrap();
        assert!(storage
            .save_settings(&ReaderPreferences {
                auto_scroll_speed: 0,
                ..preferences.clone()
            })
            .is_err());
        drop(storage);
        let reopened = Storage::open(&data).unwrap();
        assert_eq!(reopened.get_settings().unwrap(), preferences);
        assert_eq!(CURRENT_SCHEMA_VERSION, 18);
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
            "第一章 开始😀\n内容中文\nChapter 2\n结尾\n".as_bytes(),
        );
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "m1");
        let info = storage.txt_encoding_for_book(&imported.book.id).unwrap();
        assert!(info.can_change);
        assert_eq!(info.selected, TxtEncoding::Auto);

        let toc = storage.list_toc(&imported.book.id).unwrap().entries;
        // Both rule families match once; Legado's tie goes to the earlier rule.
        assert_eq!(toc.len(), 1);
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
                note: None,
            })
            .unwrap();
        assert_eq!(storage.list_bookmarks(&imported.book.id).unwrap().len(), 1);
        let result = storage
            .search_book(&SearchRequest {
                book_id: imported.book.id.clone(),
                query: "中文".to_string(),
                case_sensitive: true,
                regex: false,
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
    fn regex_search_matches_within_lines_with_utf16_offsets() {
        let root = TestRoot::new();
        let text = "第一章 开始\n😀他说：“你好”。\nABC abc\n第二章 结束";
        let source = write_source(&root.0, "regex.txt", text.as_bytes());
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let imported = import(&mut storage, &source, "regex");
        let search = |query: &str, case_sensitive: bool| {
            storage.search_book(&SearchRequest {
                book_id: imported.book.id.clone(),
                query: query.to_string(),
                case_sensitive,
                regex: true,
                cursor: None,
                limit: 10,
                operation_id: None,
            })
        };
        let chapters = search("^第.章", true).unwrap();
        assert_eq!(chapters.matches.len(), 2);
        let last = &chapters.matches[1];
        let utf16: Vec<u16> = text.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&utf16[last.match_start as usize..last.match_end as usize]).unwrap(),
            "第二章"
        );
        let quote = search("“.+?”", true).unwrap();
        assert_eq!(quote.matches.len(), 1);
        assert_eq!(
            String::from_utf16(
                &utf16[quote.matches[0].match_start as usize..quote.matches[0].match_end as usize]
            )
            .unwrap(),
            "“你好”"
        );
        assert_eq!(search("abc", true).unwrap().matches.len(), 1);
        assert_eq!(search("abc", false).unwrap().matches.len(), 2);
        // Matches never cross a line break.
        assert!(search("开始.结束", true).unwrap().matches.is_empty());
        assert_eq!(
            search("(", true).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
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
                regex: false,
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
        let mut prepared = Storage::prepare_txt_reassociation(
            &app_root,
            &snapshot,
            &replacement,
            "legacy-reassociate",
        )
        .unwrap();
        Storage::verify_prepared_txt_reassociation(&app_root, &mut prepared).unwrap();
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
    fn stale_reassociation_is_rejected_before_source_publication() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "stale-source.txt", "中文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "stale-source");
        let managed_source = app_root.join(format!("sources/{}.txt", imported.asset.id));
        fs::remove_file(&managed_source).unwrap();
        storage
            .conn
            .execute(
                "UPDATE txt_assets SET source_relative_path = NULL, source_sha256 = NULL
                 WHERE asset_id = ?1",
                params![imported.asset.id],
            )
            .unwrap();
        let replacement = write_source(&root.0, "replacement-source.txt", "中文".as_bytes());
        let snapshot = storage
            .snapshot_txt_reassociation(&imported.book.id)
            .unwrap();
        let mut prepared = Storage::prepare_txt_reassociation(
            &app_root,
            &snapshot,
            &replacement,
            "stale-reassociate",
        )
        .unwrap();
        Storage::verify_prepared_txt_reassociation(&app_root, &mut prepared).unwrap();
        fs::write(&managed_source, "中文".as_bytes()).unwrap();
        let error = storage.commit_txt_reassociation(prepared).unwrap_err();
        assert_eq!(error.code, ErrorCode::ContentVersionMismatch);
        assert!(!app_root.join("staging/stale-reassociate.raw").exists());
        assert!(managed_source.is_file());
    }

    #[test]
    fn reassociation_rejects_stage_changed_after_unlocked_verification() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "stage.txt", b"valid text");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "first");
        fs::remove_file(app_root.join(format!("sources/{}.txt", imported.asset.id))).unwrap();
        let snapshot = storage
            .snapshot_txt_reassociation(&imported.book.id)
            .unwrap();
        let mut prepared =
            Storage::prepare_txt_reassociation(&app_root, &snapshot, &source, "changed-stage")
                .unwrap();
        Storage::verify_prepared_txt_reassociation(&app_root, &mut prepared).unwrap();
        let stage = app_root.join(&prepared.stage_relative_path);
        fs::write(&stage, b"other text").unwrap();
        assert_eq!(
            storage.commit_txt_reassociation(prepared).unwrap_err().code,
            ErrorCode::ContentVersionMismatch
        );
        assert!(!stage.exists());
        assert!(!app_root.join(&snapshot.target_relative_path).exists());
        assert_eq!(
            storage
                .read_content_window(&imported.book.id, None, 64)
                .unwrap()
                .text,
            "valid text"
        );
    }

    #[test]
    fn reassociation_refuses_a_nondefault_retained_source() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "nondefault-source.txt", "中文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "nondefault-source");
        let default_path = app_root.join(format!("sources/{}.txt", imported.asset.id));
        let custom_relative = format!("sources/{}-retained.txt", imported.asset.id);
        let custom_path = app_root.join(&custom_relative);
        fs::rename(&default_path, &custom_path).unwrap();
        storage
            .conn
            .execute(
                "UPDATE txt_assets SET source_relative_path = ?1, source_sha256 = ?2
                 WHERE asset_id = ?3",
                params![
                    custom_relative,
                    sha256_bytes("中文".as_bytes()),
                    imported.asset.id
                ],
            )
            .unwrap();

        let error = storage
            .snapshot_txt_reassociation(&imported.book.id)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ContentVersionMismatch);
        assert!(custom_path.is_file());
        assert_eq!(fs::read(&custom_path).unwrap(), "中文".as_bytes());
    }

    #[test]
    fn stale_reassociation_cannot_replace_a_concurrent_operation_owned_source() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "concurrent-source.txt", "中文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "concurrent-source");
        let default_path = app_root.join(format!("sources/{}.txt", imported.asset.id));
        fs::remove_file(&default_path).unwrap();
        storage
            .conn
            .execute(
                "UPDATE txt_assets SET source_relative_path = NULL, source_sha256 = NULL
                 WHERE asset_id = ?1",
                params![imported.asset.id],
            )
            .unwrap();

        let replacement = write_source(&root.0, "concurrent-replacement.txt", "中文".as_bytes());
        let snapshot = storage
            .snapshot_txt_reassociation(&imported.book.id)
            .unwrap();
        let mut prepared = Storage::prepare_txt_reassociation(
            &app_root,
            &snapshot,
            &replacement,
            "concurrent-reassociate",
        )
        .unwrap();
        Storage::verify_prepared_txt_reassociation(&app_root, &mut prepared).unwrap();

        let duplicate = import(&mut storage, &source, "concurrent-import");
        assert!(duplicate.duplicate);
        let operation_source: String = storage
            .conn
            .query_row(
                "SELECT source_relative_path FROM txt_assets WHERE asset_id = ?1",
                params![imported.asset.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(
            operation_source,
            format!("sources/{}.txt", imported.asset.id)
        );
        let error = storage.commit_txt_reassociation(prepared).unwrap_err();
        assert_eq!(error.code, ErrorCode::ContentVersionMismatch);
        assert!(!app_root.join("staging/concurrent-reassociate.raw").exists());
        assert!(app_root.join(&operation_source).is_file());
        assert_eq!(
            fs::read(app_root.join(&operation_source)).unwrap(),
            "中文".as_bytes()
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
    fn failed_automatic_import_can_retry_with_an_explicit_encoding() {
        let root = TestRoot::new();
        let source_bytes = [0xf0, 0x28, 0x8c, 0x28];
        let source = write_source(&root.0, "manual.txt", &source_bytes);
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let error = Storage::prepare_import(
            &app_root,
            &source,
            "auto",
            TxtEncoding::Auto,
            &no_cancel(),
            |_, _, _| {},
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsupportedEncoding);
        let prepared = Storage::prepare_import(
            &app_root,
            &source,
            "manual",
            TxtEncoding::Utf16Le,
            &no_cancel(),
            |_, _, _| {},
        )
        .unwrap();
        let imported = storage
            .commit_import(prepared, &no_cancel(), |_, _, _| {}, None)
            .unwrap();
        assert_eq!(
            storage
                .read_content_window(&imported.book.id, None, 64)
                .unwrap()
                .text,
            "\u{28f0}\u{288c}"
        );
        assert_eq!(
            fs::read(
                app_root
                    .join("sources")
                    .join(format!("{}.txt", imported.asset.id))
            )
            .unwrap(),
            source_bytes
        );
        drop(storage);
        let reopened = Storage::open(&app_root).unwrap();
        let info = reopened.txt_encoding_for_book(&imported.book.id).unwrap();
        assert_eq!(info.selected, TxtEncoding::Utf16Le);
        assert_eq!(info.state, TxtDecodeState::Clean);
        assert!(info.can_change);
    }

    #[test]
    fn toc_rules_persist_without_changing_content_positions_or_bookmarks() {
        let root = TestRoot::new();
        let source = write_source(
            &root.0,
            "rules.txt",
            "第一章 开始\n内容😀\nChapter 2\nPart 3\n".as_bytes(),
        );
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "rules");
        let initial = storage.list_toc(&imported.book.id).unwrap();
        assert_eq!(initial.rule_id.as_deref(), Some("legado-1"));
        let position = initial.entries[0].locator.clone();
        storage.save_position(&position).unwrap();
        let bookmark = storage
            .add_bookmark(&BookmarkRequest {
                book_id: imported.book.id.clone(),
                locator: position.clone(),
                excerpt: "第一章".to_string(),
                note: None,
            })
            .unwrap();
        let rule = storage
            .save_txt_toc_rule(&TxtTocRule {
                id: String::new(),
                name: "Part".to_string(),
                pattern: "^Part [0-9]+$".to_string(),
                example: String::new(),
                serial: 0,
                enabled: false,
                builtin: false,
            })
            .unwrap();
        let settings = BookTocSettings {
            rule_id: Some(rule.id.clone()),
            split_long_chapters: false,
        };
        storage
            .save_book_toc_settings(&imported.book.id, &settings)
            .unwrap();
        let entries = storage.list_toc(&imported.book.id).unwrap();
        assert_eq!(
            entries
                .entries
                .iter()
                .map(|entry| entry.title.as_str())
                .collect::<Vec<_>>(),
            ["前言", "Part 3"]
        );
        let snapshot = storage.toc_rule_snapshot(&imported.book.id).unwrap();
        let invalid = TxtTocRule {
            pattern: "[".to_string(),
            ..rule.clone()
        };
        assert_eq!(
            storage.save_txt_toc_rule(&invalid).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            storage.delete_txt_toc_rule("legado-2").unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            storage.toc_rule_snapshot(&imported.book.id).unwrap(),
            snapshot
        );
        assert_eq!(storage.list_toc(&imported.book.id).unwrap(), entries);
        assert_eq!(
            storage.saved_position(&imported.book.id).unwrap(),
            Some(position.clone())
        );
        assert_eq!(
            storage.list_bookmarks(&imported.book.id).unwrap(),
            std::slice::from_ref(&bookmark)
        );
        drop(storage);
        let mut reopened = Storage::open(&app_root).unwrap();
        assert_eq!(
            reopened.book_toc_settings(&imported.book.id).unwrap().0,
            settings
        );
        assert_eq!(reopened.list_toc(&imported.book.id).unwrap(), entries);
        assert_eq!(
            reopened.saved_position(&imported.book.id).unwrap(),
            Some(position)
        );
        assert_eq!(
            reopened.list_bookmarks(&imported.book.id).unwrap(),
            [bookmark]
        );
        // Deleting the selected rule returns the book to automatic detection.
        reopened.delete_txt_toc_rule(&rule.id).unwrap();
        assert_eq!(
            reopened.book_toc_settings(&imported.book.id).unwrap().0,
            BookTocSettings::default()
        );
        assert_eq!(reopened.list_toc(&imported.book.id).unwrap(), initial);
    }

    #[test]
    fn schema_nine_migrates_rule_modes_and_parses_existing_authors() {
        let root = TestRoot::new();
        let app_root = root.0.join("data");
        let mut ids = Vec::new();
        {
            let mut storage = Storage::open(&app_root).unwrap();
            for (name, text) in [
                ("《斗破苍穹》作者：天蚕土豆.txt", "第一章 开始\n内容\n"),
                ("english.txt", "Chapter 1 A\nText\n"),
                ("custom.txt", "Part 1\nText\n"),
            ] {
                let source = write_source(&root.0, name, text.as_bytes());
                ids.push(import(&mut storage, &source, name).book.id);
            }
            // Recreate the schema 8 state: legacy titles and per-book modes.
            storage
                .conn
                .execute_batch(
                    "DROP TABLE online_cover_cache; DROP TABLE online_book_cache; DROP TABLE retired_books; DROP TABLE online_chapters; DROP TABLE online_books; DROP TABLE source_cookies; DROP TABLE source_cache; DROP TABLE book_sources; DROP TABLE retired_reading_time; DROP TABLE progress_sync; DROP TABLE cloud_books; DROP TABLE pending_book_metadata; DROP TABLE pending_book_restores; DROP TABLE sync_settings; DROP TABLE replace_rules; ALTER TABLE txt_assets DROP COLUMN transform_json; ALTER TABLE books DROP COLUMN use_replace_rules; DROP TABLE reading_time; ALTER TABLE books DROP COLUMN shelf_state; ALTER TABLE books DROP COLUMN cover_asset_id; ALTER TABLE bookmarks DROP COLUMN note; DROP TABLE book_toc_settings; DROP TABLE txt_toc_rules; DROP TABLE reader_assets;
                     ALTER TABLE books DROP COLUMN intro;
                     UPDATE books SET author = NULL;
                     CREATE TABLE book_toc_rules (
                        book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                        mode TEXT NOT NULL, pattern TEXT NOT NULL,
                        revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                     DELETE FROM schema_migrations WHERE version >= 9;",
                )
                .unwrap();
            storage
                .conn
                .execute(
                    "UPDATE books SET title = '《斗破苍穹》作者：天蚕土豆' WHERE id = ?1",
                    params![ids[0]],
                )
                .unwrap();
            for (id, mode, pattern) in [
                (&ids[1], "english", ""),
                (&ids[2], "custom", "^Part [0-9]+$"),
            ] {
                storage
                    .conn
                    .execute(
                        "INSERT INTO book_toc_rules VALUES (?1, ?2, ?3, 3, 1)",
                        params![id, mode, pattern],
                    )
                    .unwrap();
            }
        }
        let mut storage = Storage::open(&app_root).unwrap();
        let book = storage.get_book(&ids[0]).unwrap();
        assert_eq!(book.title, "斗破苍穹");
        assert_eq!(book.author.as_deref(), Some("天蚕土豆"));
        let english = storage.book_toc_settings(&ids[1]).unwrap();
        assert_eq!(english.0.rule_id.as_deref(), Some("legado-12"));
        assert!(english.1 > 3);
        let custom = storage.book_toc_settings(&ids[2]).unwrap().0;
        let rule = storage
            .list_txt_toc_rules()
            .unwrap()
            .into_iter()
            .find(|rule| Some(&rule.id) == custom.rule_id.as_ref())
            .unwrap();
        assert_eq!(rule.pattern, "^Part [0-9]+$");
        assert!(!rule.enabled && !rule.builtin);
        assert_eq!(
            storage.list_toc(&ids[2]).unwrap().entries[0].title,
            "Part 1"
        );
        assert_eq!(
            storage.book_toc_settings(&ids[0]).unwrap().0,
            BookTocSettings::default()
        );
    }

    #[test]
    fn reader_fonts_import_validate_and_clear_preferences_on_delete() {
        let root = TestRoot::new();
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let fake = write_source(&root.0, "fake.ttf", b"not a font at all");
        assert_eq!(
            storage
                .import_reader_font(&fake, "fake.ttf")
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        let mut bytes = vec![0x00, 0x01, 0x00, 0x00];
        bytes.extend_from_slice(&[7; 64]);
        let font = write_source(&root.0, "宋体.ttf", &bytes);
        let asset = storage.import_reader_font(&font, "宋体.ttf").unwrap();
        assert_eq!(asset.name, "宋体");
        assert_eq!(
            storage.list_reader_fonts().unwrap(),
            std::slice::from_ref(&asset)
        );
        assert_eq!(storage.read_reader_font(&asset.id).unwrap(), bytes);
        let mut preferences = ReaderPreferences::default();
        preferences.style.font_asset_id = Some(asset.id.clone());
        storage.save_settings(&preferences).unwrap();
        drop(storage);
        // Orphan cleanup on open keeps recorded fonts.
        let mut storage = Storage::open(&app_root).unwrap();
        assert_eq!(storage.read_reader_font(&asset.id).unwrap(), bytes);
        storage.delete_reader_font(&asset.id).unwrap();
        assert!(storage.list_reader_fonts().unwrap().is_empty());
        assert_eq!(storage.get_settings().unwrap().style.font_asset_id, None);
        assert_eq!(
            storage.read_reader_font(&asset.id).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn preferences_saved_before_reading_styles_load_with_defaults() {
        let root = TestRoot::new();
        let storage = Storage::open(&root.0.join("data")).unwrap();
        let mut legacy = serde_json::to_value(ReaderPreferences::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("style");
        storage
            .conn
            .execute(
                "INSERT INTO reader_preferences(id, preferences_json, updated_at) VALUES(1, ?1, 1)",
                params![legacy.to_string()],
            )
            .unwrap();
        let loaded = storage.get_settings().unwrap();
        assert_eq!(loaded.style, crate::models::ReadingStyle::default());
        let mut invalid = loaded.clone();
        invalid.style.selected = 99;
        assert_eq!(
            storage.save_settings(&invalid).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        // Styles saved with a session brightness load without it, and the
        // bottom bar gets Legado's buttons.
        let mut saved = serde_json::to_value(ReaderPreferences::default()).unwrap();
        let style = saved["style"].as_object_mut().unwrap();
        style.remove("bottomTools");
        style.insert("brightness".into(), serde_json::json!(0.4));
        storage
            .conn
            .execute(
                "UPDATE reader_preferences SET preferences_json = ?1 WHERE id = 1",
                params![saved.to_string()],
            )
            .unwrap();
        let loaded = storage.get_settings().unwrap();
        assert_eq!(
            loaded.style.bottom_tools,
            crate::models::default_bottom_tools()
        );
        use crate::models::ReaderTool;
        for tools in [
            vec![],
            vec![ReaderTool::Search, ReaderTool::Search],
            vec![ReaderTool::Search; 8],
        ] {
            let mut invalid = loaded.clone();
            invalid.style.bottom_tools = tools;
            assert_eq!(
                storage.save_settings(&invalid).unwrap_err().code,
                ErrorCode::InvalidArgument
            );
        }
        let mut custom = loaded.clone();
        custom.style.bottom_tools = vec![ReaderTool::Bookmark, ReaderTool::MoreSettings];
        storage.save_settings(&custom).unwrap();
        assert_eq!(
            storage.get_settings().unwrap().style.bottom_tools,
            custom.style.bottom_tools
        );
    }

    #[test]
    fn schema_ten_keeps_only_the_author_name() {
        let root = TestRoot::new();
        let app_root = root.0.join("data");
        let id = {
            let mut storage = Storage::open(&app_root).unwrap();
            let source = write_source(&root.0, "a.txt", "第一章 开始\n内容\n".as_bytes());
            let id = import(&mut storage, &source, "a").book.id;
            storage
                .conn
                .execute_batch(
                    "UPDATE books SET author = '（校对版全本） 作者_零下十九度';
                     DROP TABLE online_cover_cache; DROP TABLE online_book_cache; DROP TABLE retired_books; DROP TABLE online_chapters; DROP TABLE online_books; DROP TABLE source_cookies; DROP TABLE source_cache; DROP TABLE book_sources; DROP TABLE retired_reading_time; DROP TABLE progress_sync; DROP TABLE cloud_books; DROP TABLE pending_book_metadata; DROP TABLE pending_book_restores; DROP TABLE sync_settings; DROP TABLE replace_rules; ALTER TABLE txt_assets DROP COLUMN transform_json; ALTER TABLE books DROP COLUMN use_replace_rules; DROP TABLE reading_time; ALTER TABLE books DROP COLUMN shelf_state; ALTER TABLE books DROP COLUMN cover_asset_id; ALTER TABLE bookmarks DROP COLUMN note; 
                     DELETE FROM schema_migrations WHERE version >= 10;",
                )
                .unwrap();
            id
        };
        let storage = Storage::open(&app_root).unwrap();
        assert_eq!(
            storage.get_book(&id).unwrap().author.as_deref(),
            Some("零下十九度")
        );
        let info = storage.book_info(&id).unwrap();
        assert_eq!(info.source_byte_length, "第一章 开始\n内容\n".len() as u64);
    }

    #[test]
    fn rule_tables_reorder_toggle_import_and_export() {
        let root = TestRoot::new();
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let rules = storage.list_txt_toc_rules().unwrap();
        assert_eq!(rules.len(), 26);
        assert!(rules.iter().all(|rule| rule.builtin));
        assert_eq!(rules.iter().filter(|rule| rule.enabled).count(), 12);
        let mut ids: Vec<String> = rules.iter().map(|rule| rule.id.clone()).collect();
        ids.reverse();
        let ordered = storage.order_txt_toc_rules(&ids).unwrap();
        assert_eq!(ordered[0].id, "legado-100");
        assert!(storage.order_txt_toc_rules(&ids[1..]).is_err());
        let toggled = storage
            .save_txt_toc_rule(&TxtTocRule {
                enabled: true,
                ..ordered[1].clone()
            })
            .unwrap();
        assert!(toggled.enabled && toggled.builtin);
        let imported = storage
            .import_txt_toc_rules(
                r#"[{"name":"Legado 导出","rule":"^卷.+$","example":"卷一","enable":true,"serialNumber":3},
                   {"name":"Legado 导出","rule":"^卷.+$"}]"#,
            )
            .unwrap();
        assert_eq!(imported.len(), 1);
        assert!(!imported[0].builtin);
        assert!(storage.import_txt_toc_rules("{").is_err());
        let exported: serde_json::Value =
            serde_json::from_str(&storage.export_txt_toc_rules().unwrap()).unwrap();
        assert_eq!(exported.as_array().unwrap().len(), 27);
        assert!(exported[0].get("rule").is_some());
    }

    #[test]
    fn stale_toc_builds_cannot_read_or_replace_a_newer_rule_or_content_cache() {
        let root = TestRoot::new();
        let source = write_source(
            &root.0,
            "stale-toc.txt",
            "第一章 开始\nChapter 2\n".as_bytes(),
        );
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let imported = import(&mut storage, &source, "stale-toc");
        let context = storage.content_read_context(&imported.book.id).unwrap();
        let (old_rule, old_revision) = storage.toc_rule_snapshot(&imported.book.id).unwrap();
        let old_entries = storage.list_toc(&imported.book.id).unwrap();
        storage
            .save_book_toc_settings(
                &imported.book.id,
                &BookTocSettings {
                    rule_id: Some("legado-12".to_string()),
                    split_long_chapters: false,
                },
            )
            .unwrap();
        let (new_rule, _) = storage.toc_rule_snapshot(&imported.book.id).unwrap();
        let current_entries = storage.list_toc(&imported.book.id).unwrap();
        assert_eq!(current_entries.entries.len(), 2);
        assert_eq!(
            storage
                .cache_toc(&context, &old_entries, &old_rule, old_revision)
                .unwrap_err()
                .code,
            ErrorCode::ContentVersionMismatch
        );
        assert_eq!(
            storage
                .cached_toc(&context, &old_rule, old_revision)
                .unwrap_err()
                .code,
            ErrorCode::ContentVersionMismatch
        );
        assert_eq!(
            storage.list_toc(&imported.book.id).unwrap(),
            current_entries
        );

        let (_, revision) = storage.toc_rule_snapshot(&imported.book.id).unwrap();
        storage
            .set_txt_encoding(&imported.book.id, TxtEncoding::Utf16Le)
            .unwrap();
        let decoded_entries = storage.list_toc(&imported.book.id).unwrap();
        assert_eq!(
            storage
                .cache_toc(&context, &current_entries, &new_rule, revision)
                .unwrap_err()
                .code,
            ErrorCode::ContentVersionMismatch
        );
        assert_eq!(
            storage
                .cached_toc(&context, &new_rule, revision)
                .unwrap_err()
                .code,
            ErrorCode::ContentVersionMismatch
        );
        assert_eq!(
            storage.list_toc(&imported.book.id).unwrap(),
            decoded_entries
        );
    }

    #[test]
    fn persisted_toc_hits_retain_verified_indexes_but_reject_replaced_content() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "cached-toc.txt", b"Chapter 1\nBody\n");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "cached-toc");
        let entries = storage.list_toc(&imported.book.id).unwrap();
        drop(storage);
        let mut reopened = Storage::open(&app_root).unwrap();
        assert!(reopened
            .content_read_context(&imported.book.id)
            .unwrap()
            .verified
            .is_none());
        assert_eq!(reopened.list_toc(&imported.book.id).unwrap(), entries);
        assert!(reopened
            .content_read_context(&imported.book.id)
            .unwrap()
            .verified
            .is_some());
        let path = app_root.join(format!(
            "books/{}/{}.txt",
            imported.book.id, imported.asset.id
        ));
        fs::write(path, b"Chapter 2\nBody\n").unwrap();
        assert_eq!(
            reopened.list_toc(&imported.book.id).unwrap_err().code,
            ErrorCode::ContentVersionMismatch
        );
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
            resource_id: None,
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
        // Reading states are the default groups; no genre groups are seeded.
        assert!(storage.list_groups().unwrap().is_empty());
        let group = storage.create_group("  我的阅读  ").unwrap();
        assert_eq!(group.name, "我的阅读");
        let other = storage.create_group("其他").unwrap();
        storage
            .move_book(&imported.book.id, &ShelfPlacement::Group(other.id.clone()))
            .unwrap();
        storage
            .move_book(&imported.book.id, &ShelfPlacement::Group(group.id.clone()))
            .unwrap();
        // A book belongs to one group at a time.
        let renamed = storage.rename_group(&group.id, "最近阅读").unwrap();
        assert_eq!(renamed.book_ids, vec![imported.book.id.clone()]);
        assert!(storage.list_groups().unwrap()[1].book_ids.is_empty());
        drop(storage);
        let mut storage = Storage::open(&app_root).unwrap();
        assert_eq!(storage.list_groups().unwrap().first(), Some(&renamed));
        storage
            .move_book(
                &imported.book.id,
                &ShelfPlacement::State(ShelfState::Finished),
            )
            .unwrap();
        assert!(storage.list_groups().unwrap()[0].book_ids.is_empty());
        let shelf = storage.list_shelf_books(false, None).unwrap();
        assert_eq!(shelf[0].shelf_state, Some(ShelfState::Finished));
        storage
            .move_book(&imported.book.id, &ShelfPlacement::Group(group.id.clone()))
            .unwrap();
        assert_eq!(
            storage.list_shelf_books(false, None).unwrap()[0].shelf_state,
            None
        );
        // Deleting the group returns the book to automatic grouping.
        storage.delete_group(&group.id).unwrap();
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
        assert_eq!(remaining.len(), 1);
        assert!(remaining.iter().all(|group| group.book_ids.is_empty()));
        assert_eq!(
            storage.list_shelf_books(false, None).unwrap()[0].shelf_state,
            None
        );
    }

    #[test]
    fn reading_time_notes_and_covers_are_stored() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "time.txt", "第一章\n正文".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "time");
        let id = imported.book.id.clone();
        storage.add_reading_time(&id, "2026-10-09", 90).unwrap();
        storage.add_reading_time(&id, "2026-10-10", 30).unwrap();
        storage.add_reading_time(&id, "2026-10-10", 30).unwrap();
        for bad in [("2026-1-10", 30), ("2026-10-10", 0), ("2026-10-10", 4000)] {
            assert_eq!(
                storage
                    .add_reading_time(&id, bad.0, bad.1)
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidArgument
            );
        }
        let stats = storage.reading_stats("2026-10-10").unwrap();
        assert_eq!((stats.total_seconds, stats.today_seconds), (150, 60));
        assert_eq!(stats.days[0].day, "2026-10-10");
        assert_eq!(stats.books[0].seconds, 150);
        assert_eq!(storage.book_info(&id).unwrap().reading_seconds, 150);

        let locator = storage.read_content_window(&id, None, 16).unwrap().locator;
        let request = BookmarkRequest {
            book_id: id.clone(),
            locator,
            excerpt: "正文".into(),
            note: Some("想法".into()),
        };
        let bookmark = storage.add_bookmark(&request).unwrap();
        assert_eq!(bookmark.note, "想法");
        storage
            .update_bookmark_note(&bookmark.id, " 新想法 ")
            .unwrap();
        assert_eq!(storage.list_bookmarks(&id).unwrap()[0].note, "新想法");
        assert_eq!(
            storage
                .update_bookmark_note("absent", "x")
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );

        let not_image = write_source(&root.0, "cover.png", b"plain text");
        assert_eq!(
            storage
                .set_book_cover(&id, &not_image, "cover.png")
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        let png = write_source(&root.0, "cover.png", b"\x89PNG\r\n\x1a\nrest");
        let first = storage.set_book_cover(&id, &png, "cover.png").unwrap();
        let second = storage.set_book_cover(&id, &png, "cover.png").unwrap();
        assert_eq!(storage.read_reader_font(&second.id).unwrap().len(), 12);
        assert_eq!(
            storage.read_reader_font(&first.id).unwrap_err().code,
            ErrorCode::NotFound
        );
        let shelf = storage.list_shelf_books(false, None).unwrap();
        assert_eq!(shelf[0].cover_asset_id.as_deref(), Some(second.id.as_str()));
        storage.clear_book_cover(&id).unwrap();
        assert_eq!(
            storage.list_shelf_books(false, None).unwrap()[0].cover_asset_id,
            None
        );
        assert!(storage.list_reader_fonts().unwrap().is_empty());

        let intro = UpdateBookRequest {
            book_id: id.clone(),
            title: "time".into(),
            author: None,
            intro: Some("  自己写的简介  ".into()),
        };
        storage.update_book(&intro).unwrap();
        assert_eq!(
            storage.book_info(&id).unwrap().intro.as_deref(),
            Some("自己写的简介")
        );
    }

    #[test]
    fn unused_background_images_are_removed_on_startup() {
        let root = TestRoot::new();
        let app_root = root.0.join("data");
        let png = write_source(&root.0, "bg.png", b"\x89PNG\r\n\x1a\nrest");
        let (kept, dropped) = {
            let mut storage = Storage::open(&app_root).unwrap();
            let kept = storage.import_reader_background(&png, "bg.png").unwrap();
            let dropped = storage.import_reader_background(&png, "bg.png").unwrap();
            let mut preferences = storage.get_settings().unwrap();
            preferences.style.presets[0].night_background_image = Some(kept.id.clone());
            storage.save_settings(&preferences).unwrap();
            (kept, dropped)
        };
        let storage = Storage::open(&app_root).unwrap();
        assert_eq!(storage.read_reader_font(&kept.id).unwrap().len(), 12);
        assert_eq!(
            storage.read_reader_font(&dropped.id).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn deleted_books_keep_progress_and_reading_time_for_their_return() {
        let root = TestRoot::new();
        let source = write_source(
            &root.0,
            "kept.txt",
            "第一章\n开头\n第二章\n后来门开了。".as_bytes(),
        );
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let id = import(&mut storage, &source, "first").book.id;
        let context = storage.content_read_context(&id).unwrap();
        let verified = verify_content_context(&context).unwrap();
        let text = read_verified_text(&context, &verified).unwrap();
        let offset = text[..text.find("后来").unwrap()].encode_utf16().count() as u64;
        let locator = resolve_offset_from_context(
            &ResolveOffsetRequest {
                book_id: id.clone(),
                content_version: context.record.asset.content_version.clone(),
                resource_id: context.record.asset.id.clone(),
                offset,
            },
            &context,
            &verified,
        )
        .unwrap();
        storage.save_position(&locator).unwrap();
        storage.add_reading_time(&id, "2026-10-11", 420).unwrap();
        storage.delete_book(&id).unwrap();
        assert!(storage.list_library_books().unwrap().is_empty());
        // The totals still count the deleted book's time.
        assert_eq!(
            storage.reading_stats("2026-10-11").unwrap().total_seconds,
            420
        );
        // Even with progress ignored for backups, the book's own records return.
        let mut settings = storage.stored_webdav().unwrap();
        settings.restore_ignore = vec![crate::models::RestoreCategory::Progress];
        storage.save_stored_webdav(&settings).unwrap();
        let again = import(&mut storage, &source, "again").book.id;
        assert!(storage.apply_pending_restore(&again).unwrap());
        assert_eq!(
            storage.saved_position(&again).unwrap().unwrap().offset,
            offset
        );
        let stats = storage.reading_stats("2026-10-11").unwrap();
        assert_eq!((stats.total_seconds, stats.books.len()), (420, 1));
    }

    #[test]
    fn backups_restore_records_by_source_and_wait_for_missing_books() {
        let root = TestRoot::new();
        let text = "第一章 开始\n头发里的云\n第二章 结束\n后来门开了。";
        let source = write_source(&root.0, "backup.txt", text.as_bytes());
        let other = write_source(&root.0, "other.txt", "另一本书\n正文".as_bytes());
        let mut storage = Storage::open(&root.0.join("first")).unwrap();
        let id = import(&mut storage, &source, "first").book.id;
        let other_id = import(&mut storage, &other, "other").book.id;
        let at = |storage: &Storage, id: &str, needle: &str| {
            let context = storage.content_read_context(id).unwrap();
            let verified = verify_content_context(&context).unwrap();
            let text = read_verified_text(&context, &verified).unwrap();
            let offset = text[..text.find(needle).unwrap()].encode_utf16().count() as u64;
            resolve_offset_from_context(
                &ResolveOffsetRequest {
                    book_id: id.into(),
                    content_version: context.record.asset.content_version.clone(),
                    resource_id: context.record.asset.id.clone(),
                    offset,
                },
                &context,
                &verified,
            )
            .unwrap()
        };
        storage.save_position(&at(&storage, &id, "后来")).unwrap();
        storage
            .add_bookmark(&BookmarkRequest {
                book_id: id.clone(),
                locator: at(&storage, &id, "头发"),
                excerpt: "头发".into(),
                note: Some("记一笔".into()),
            })
            .unwrap();
        let group = storage.create_group("收藏").unwrap();
        storage
            .move_book(&id, &ShelfPlacement::Group(group.id))
            .unwrap();
        storage
            .move_book(&other_id, &ShelfPlacement::State(ShelfState::Finished))
            .unwrap();
        storage.add_reading_time(&id, "2026-10-11", 300).unwrap();
        storage
            .update_book(&UpdateBookRequest {
                book_id: id.clone(),
                title: "云海".into(),
                author: Some("作者".into()),
                intro: Some("简介".into()),
            })
            .unwrap();
        let backup = storage.export_backup("Linux").unwrap();
        assert_eq!(backup.books.len(), 2);
        // Positions carry only a short context for finding them again.
        assert!(backup
            .books
            .iter()
            .flat_map(|book| &book.bookmarks)
            .all(|mark| {
                mark.locator.context_before.chars().count() <= 32
                    && mark.locator.context_after.chars().count() <= 32
            }));
        let backup = parse_backup(&serde_json::to_vec(&backup).unwrap()).unwrap();

        // Another device has one of the two books, converted to traditional
        // characters, so its text differs and positions are found by context.
        let mut second = Storage::open(&root.0.join("second")).unwrap();
        let mut preferences = second.get_settings().unwrap();
        preferences.style.chinese_conversion = crate::models::ChineseConversion::ToTraditional;
        second.save_settings(&preferences).unwrap();
        let local = import(&mut second, &source, "second").book.id;
        second.set_txt_encoding(&local, TxtEncoding::Auto).unwrap();
        second.add_reading_time(&local, "2026-10-11", 900).unwrap();
        let preview = second.preview_backup(&backup).unwrap();
        assert_eq!(
            (preview.books, preview.books_on_device, preview.bookmarks),
            (2, 1, 1)
        );
        let report = second.restore_backup(&backup).unwrap();
        assert_eq!(report.books_restored, 1);
        assert_eq!(report.books_pending, 1);
        assert_eq!(report.groups_created, 1);
        assert!(report.preferences_restored);
        let book = second.get_book(&local).unwrap();
        assert_eq!(
            (book.title.as_str(), book.author.as_deref()),
            ("云海", Some("作者"))
        );
        let window = second.read_content_window(&local, None, 200).unwrap();
        // Restored preferences turned conversion off again, but the text is
        // only rewritten when the book is next opened.
        assert!(window.text.contains("後來"));
        let saved = second.saved_position(&local).unwrap().unwrap();
        assert!(window
            .text
            .encode_utf16()
            .skip(saved.offset as usize)
            .take(2)
            .eq("後來".encode_utf16()));
        let marks = second.list_bookmarks(&local).unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].note, "记一笔");
        assert!(window
            .text
            .encode_utf16()
            .skip(marks[0].locator.offset as usize)
            .take(2)
            .eq("頭髮".encode_utf16()));
        let groups = second.list_groups().unwrap();
        assert!(groups
            .iter()
            .any(|g| g.name == "收藏" && g.book_ids == vec![local.clone()]));
        // The larger time of each day is kept.
        assert_eq!(
            second.reading_stats("2026-10-11").unwrap().today_seconds,
            900
        );
        // Restoring again adds nothing twice.
        let again = second.restore_backup(&backup).unwrap();
        assert_eq!((again.bookmarks_added, again.groups_created), (0, 0));
        assert_eq!(second.list_bookmarks(&local).unwrap().len(), 1);

        // The missing book takes its records when it is imported.
        assert_eq!(second.pending_restore_count().unwrap(), 1);
        let arrived = import(&mut second, &other, "arrived").book.id;
        assert!(second.apply_pending_restore(&arrived).unwrap());
        assert_eq!(second.pending_restore_count().unwrap(), 0);
        assert!(second
            .list_library_books()
            .unwrap()
            .iter()
            .any(|book| book.book.id == arrived && book.shelf_state == Some(ShelfState::Finished)));
        // Recovery points keep what was there before.
        let point = second.write_recovery_point("Linux").unwrap();
        assert_eq!(second.list_recovery_points().unwrap(), vec![point.clone()]);
        assert_eq!(second.read_recovery_point(&point).unwrap().books.len(), 2);
        assert!(second.read_recovery_point("../x.json").is_err());
    }

    #[test]
    fn replace_rules_and_chinese_conversion_rewrite_text_and_relocate_positions() {
        let root = TestRoot::new();
        let text = "第一章 开始\n广告：点击这里\n头发里的云\n第二章 结束\n后来门开了。";
        let source = write_source(&root.0, "rules.txt", text.as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "rules");
        let id = imported.book.id.clone();
        let locate = |storage: &Storage, needle: &str| {
            let context = storage.content_read_context(&id).unwrap();
            let verified = verify_content_context(&context).unwrap();
            let text = read_verified_text(&context, &verified).unwrap();
            let byte = text.find(needle).unwrap();
            let offset = text[..byte].encode_utf16().count() as u64;
            resolve_offset_from_context(
                &ResolveOffsetRequest {
                    book_id: id.clone(),
                    content_version: context.record.asset.content_version.clone(),
                    resource_id: context.record.asset.id.clone(),
                    offset,
                },
                &context,
                &verified,
            )
            .unwrap()
        };
        let position = locate(&storage, "后来");
        storage.save_position(&position).unwrap();
        storage
            .add_bookmark(&BookmarkRequest {
                book_id: id.clone(),
                locator: locate(&storage, "头发"),
                excerpt: "头发".into(),
                note: None,
            })
            .unwrap();
        assert!(!storage.text_transform_pending(&id).unwrap());
        let rule = |pattern: &str, scope: &str| ReplaceRule {
            id: String::new(),
            name: pattern.into(),
            group: String::new(),
            pattern: pattern.into(),
            replacement: String::new(),
            is_regex: true,
            scope: scope.into(),
            enabled: true,
            serial: 0,
        };
        storage.save_replace_rule(&rule("^广告.*$", "")).unwrap();
        storage.save_replace_rule(&rule("结束", "别的书")).unwrap();
        assert_eq!(
            storage.save_replace_rule(&rule("(", "")).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        let mut preferences = storage.get_settings().unwrap();
        preferences.style.chinese_conversion = crate::models::ChineseConversion::ToTraditional;
        storage.save_settings(&preferences).unwrap();
        assert!(storage.text_transform_pending(&id).unwrap());
        storage.set_txt_encoding(&id, TxtEncoding::Auto).unwrap();
        assert!(!storage.text_transform_pending(&id).unwrap());
        let window = storage.read_content_window(&id, None, 200).unwrap();
        // The out-of-scope rule left 结束 alone; conversion keeps lengths.
        assert_eq!(
            window.text,
            "第一章 開始\n\n頭髮裏的雲\n第二章 結束\n後來門開了。"
        );
        let saved = storage.saved_position(&id).unwrap().unwrap();
        assert!(window
            .text
            .encode_utf16()
            .skip(saved.offset as usize)
            .take(2)
            .eq("後來".encode_utf16()));
        let mark = &storage.list_bookmarks(&id).unwrap()[0];
        assert_eq!(mark.locator.content_version, window.content_version);
        assert!(window
            .text
            .encode_utf16()
            .skip(mark.locator.offset as usize)
            .take(2)
            .eq("頭髮".encode_utf16()));
        // Reimporting the same file still finds the transformed book.
        let again = import(&mut storage, &source, "again");
        assert_eq!(again.book.id, id);
        assert_eq!(
            storage.read_content_window(&id, None, 200).unwrap().text,
            window.text
        );
        // The book's own switch turns its rules off.
        storage.set_book_replace_rules(&id, false).unwrap();
        assert!(storage
            .list_shelf_books(false, None)
            .unwrap()
            .iter()
            .all(|book| !book.use_replace_rules));
        assert!(storage.text_transform_pending(&id).unwrap());
        storage.set_txt_encoding(&id, TxtEncoding::Auto).unwrap();
        assert!(storage
            .read_content_window(&id, None, 200)
            .unwrap()
            .text
            .contains("廣告：點擊這裏"));
        let exported = storage.export_replace_rules().unwrap();
        storage
            .delete_replace_rules(
                &storage
                    .list_replace_rules()
                    .unwrap()
                    .into_iter()
                    .map(|rule| rule.id)
                    .collect::<Vec<_>>(),
            )
            .unwrap();
        assert_eq!(storage.import_replace_rules(&exported).unwrap().len(), 2);
        assert!(storage.import_replace_rules(&exported).unwrap().is_empty());
    }

    #[test]
    fn group_validation_and_membership_failure_preserve_existing_groups() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "membership.txt", b"membership");
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let imported = import(&mut storage, &source, "membership");
        let group = storage.create_group("自定义").unwrap();
        storage.create_group("已有分组").unwrap();
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
                .rename_group(&group.id, "已有分组")
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
            .move_book(&imported.book.id, &ShelfPlacement::Group(group.id.clone()))
            .unwrap();
        let before = storage.list_groups().unwrap();
        assert_eq!(
            storage
                .move_book(&imported.book.id, &ShelfPlacement::Group("absent".into()))
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        assert_eq!(
            storage
                .move_book("absent", &ShelfPlacement::Group(group.id.clone()))
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        assert_eq!(storage.list_groups().unwrap(), before);
        storage
            .move_book(&imported.book.id, &ShelfPlacement::Automatic)
            .unwrap();
        assert!(storage
            .list_groups()
            .unwrap()
            .iter()
            .all(|group| group.book_ids.is_empty()));
    }

    #[test]
    fn metadata_archive_restore_and_reimport_preserve_identity() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "manage.txt", b"chapter one\nchapter two");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let first = import(&mut storage, &source, "first");
        let loc = storage
            .read_content_window(&first.book.id, None, 128)
            .unwrap()
            .locator;
        storage.save_position(&loc).unwrap();
        let bookmark = storage
            .add_bookmark(&BookmarkRequest {
                book_id: first.book.id.clone(),
                locator: loc.clone(),
                excerpt: "chapter one".into(),
                note: None,
            })
            .unwrap();
        let group = storage.create_group("Saved").unwrap();
        storage
            .move_book(&first.book.id, &ShelfPlacement::Group(group.id.clone()))
            .unwrap();
        let prefs = ShelfPreferences {
            layout: crate::models::ShelfLayout::Grid,
            sort: crate::models::ShelfSort::Title,
            group_id: group.id.clone(),
        };
        storage.save_shelf_preferences(&prefs).unwrap();
        let edited = storage
            .update_book(&UpdateBookRequest {
                book_id: first.book.id.clone(),
                title: "  Revised title  ".into(),
                author: Some(" Writer ".into()),
                intro: None,
            })
            .unwrap();
        assert_eq!(edited.content_version, first.book.content_version);
        assert_eq!(edited.title, "Revised title");
        assert_eq!(edited.author.as_deref(), Some("Writer"));
        assert!(storage
            .update_book(&UpdateBookRequest {
                book_id: first.book.id.clone(),
                title: " ".into(),
                author: None,
                intro: None,
            })
            .is_err());
        storage.remove_book(&first.book.id).unwrap();
        assert!(storage.list_library_books().unwrap().is_empty());
        assert_eq!(
            storage.list_removed_books().unwrap()[0]
                .asset
                .clone()
                .unwrap()
                .id,
            first.asset.id
        );
        drop(storage);
        let mut storage = Storage::open(&app_root).unwrap();
        assert_eq!(storage.get_shelf_preferences().unwrap(), prefs);
        assert_eq!(storage.saved_position(&first.book.id).unwrap(), Some(loc));
        assert_eq!(storage.list_bookmarks(&first.book.id).unwrap()[0], bookmark);
        assert!(storage
            .list_groups()
            .unwrap()
            .iter()
            .any(|g| g.id == group.id && g.book_ids.contains(&first.book.id)));
        fs::remove_file(app_root.join(format!("books/{}/{}.txt", first.book.id, first.asset.id)))
            .unwrap();
        let repeated = import(&mut storage, &source, "again");
        assert!(repeated.duplicate);
        assert_eq!(repeated.book.id, first.book.id);
        assert_eq!(repeated.asset.id, first.asset.id);
        assert_eq!(repeated.book.title, "Revised title");
        assert!(storage.list_removed_books().unwrap().is_empty());
        assert_eq!(
            storage.list_library_books().unwrap()[0]
                .asset
                .clone()
                .unwrap()
                .availability,
            AssetAvailability::Ready
        );
        storage.remove_book(&first.book.id).unwrap();
        storage.restore_book(&first.book.id).unwrap();
        assert_eq!(storage.list_library_books().unwrap().len(), 1);
        storage.delete_group(&group.id).unwrap();
        assert_eq!(storage.get_shelf_preferences().unwrap().group_id, "all");
        for tab in ["reading", "unread", "finished"] {
            let saved = ShelfPreferences {
                group_id: tab.into(),
                ..prefs.clone()
            };
            storage.save_shelf_preferences(&saved).unwrap();
            assert_eq!(storage.get_shelf_preferences().unwrap().group_id, tab);
        }
    }

    #[test]
    fn archived_duplicate_commit_failure_does_not_restore_the_shelf_entry() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "archive.txt", b"original content");
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let first = import(&mut storage, &source, "first");
        storage.remove_book(&first.book.id).unwrap();
        storage.conn.execute_batch("CREATE TRIGGER fail_restore BEFORE DELETE ON shelf_removals BEGIN SELECT RAISE(ABORT,'restore fault'); END;").unwrap();
        assert!(storage
            .import_txt(
                &source,
                "failed-restore",
                &AtomicBool::new(false),
                |_, _, _| {}
            )
            .is_err());
        assert_eq!(storage.list_removed_books().unwrap().len(), 1);
        assert!(storage.list_library_books().unwrap().is_empty());
        assert_eq!(
            storage
                .read_content_window(&first.book.id, None, 128)
                .unwrap()
                .text,
            "original content"
        );
    }

    #[test]
    fn decode_maps_positions_and_bookmarks_through_original_byte_boundaries() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "anchors.txt", "中文AB\r\n尾文".as_bytes());
        let mut storage = Storage::open(&root.0.join("data")).unwrap();
        let first = import(&mut storage, &source, "first");
        let loc = ReaderLocator {
            offset: 2,
            context_before: "中文".into(),
            context_after: "AB\n尾文".into(),
            ..storage
                .read_content_window(&first.book.id, None, 128)
                .unwrap()
                .locator
        };
        storage.save_position(&loc).unwrap();
        let bookmark = storage
            .add_bookmark(&BookmarkRequest {
                book_id: first.book.id.clone(),
                locator: loc,
                excerpt: "AB".into(),
                note: None,
            })
            .unwrap();
        storage
            .set_txt_encoding(&first.book.id, TxtEncoding::Gbk)
            .unwrap();
        let window = storage
            .read_content_window(&first.book.id, None, 128)
            .unwrap();
        let mapped = storage.saved_position(&first.book.id).unwrap().unwrap();
        assert_eq!(mapped.offset, 3);
        assert_eq!(mapped.content_version, window.content_version);
        assert!(mapped.context_after.starts_with("AB\n"));
        let mapped_bookmark = storage.list_bookmarks(&first.book.id).unwrap().remove(0);
        assert_eq!(mapped_bookmark.id, bookmark.id);
        assert_eq!(mapped_bookmark.locator, mapped);
        storage
            .set_txt_encoding(&first.book.id, TxtEncoding::Utf8)
            .unwrap();
        assert_eq!(
            storage
                .saved_position(&first.book.id)
                .unwrap()
                .unwrap()
                .offset,
            2
        );
    }

    #[test]
    fn ambiguous_decode_offsets_remain_unresolved_and_inflight_saves_conflict() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "uncertain.txt", "中文AB".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let first = import(&mut storage, &source, "first");
        let mut loc = storage
            .read_content_window(&first.book.id, None, 128)
            .unwrap()
            .locator;
        loc.offset = 1;
        storage.save_position(&loc).unwrap();
        storage
            .set_txt_encoding(&first.book.id, TxtEncoding::Gbk)
            .unwrap();
        assert_eq!(storage.saved_position(&first.book.id).unwrap(), Some(loc));
        let snapshot = storage.snapshot_txt_decode(&first.book.id).unwrap();
        let prepared = Storage::prepare_txt_decode(
            &app_root,
            &snapshot,
            TxtEncoding::Utf8,
            "conflict",
            &AtomicBool::new(false),
            |_, _, _| {},
        )
        .unwrap();
        let newer = storage
            .read_content_window(&first.book.id, None, 128)
            .unwrap()
            .locator;
        storage.save_position(&newer).unwrap();
        let error = storage
            .commit_txt_decode(prepared, &AtomicBool::new(false))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ContentVersionMismatch);
        assert_eq!(storage.saved_position(&first.book.id).unwrap(), Some(newer));
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
        storage.conn.execute_batch("DROP TABLE online_cover_cache; DROP TABLE online_book_cache; DROP TABLE retired_books; DROP TABLE online_chapters; DROP TABLE online_books; DROP TABLE source_cookies; DROP TABLE source_cache; DROP TABLE book_sources; DROP TABLE retired_reading_time; DROP TABLE progress_sync; DROP TABLE cloud_books; DROP TABLE pending_book_metadata; DROP TABLE pending_book_restores; DROP TABLE sync_settings; DROP TABLE replace_rules; ALTER TABLE txt_assets DROP COLUMN transform_json; ALTER TABLE books DROP COLUMN use_replace_rules; DROP TABLE reading_time; ALTER TABLE books DROP COLUMN shelf_state; ALTER TABLE books DROP COLUMN cover_asset_id; ALTER TABLE bookmarks DROP COLUMN note; DROP TABLE book_toc_settings; DROP TABLE txt_toc_rules; DROP TABLE reader_assets; ALTER TABLE books DROP COLUMN intro; DROP TABLE book_groups; DROP TABLE library_groups; DROP TABLE shelf_removals; DROP TABLE shelf_preferences; ALTER TABLE toc_cache DROP COLUMN rule_identity; ALTER TABLE toc_cache DROP COLUMN rule_revision; DELETE FROM schema_migrations WHERE version >= 6;").unwrap();
        drop(storage);
        let reopened = Storage::open(&app_root).unwrap();
        let library = reopened.list_library_books().unwrap();
        assert_eq!(library[0].book, imported.book);
        assert_eq!(library[0].asset.as_ref().unwrap().id, imported.asset.id);
        assert_eq!(
            reopened.saved_position(&imported.book.id).unwrap(),
            Some(locator)
        );
        assert_eq!(reopened.get_settings().unwrap(), saved_settings);
        // Schema 6 seeds genre groups; schema 11 removes every old group.
        assert!(reopened.list_groups().unwrap().is_empty());
    }

    #[test]
    fn toc_rule_migration_preserves_v7_reading_data_and_legacy_preferences() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "v7.txt", "第一章\n正文😀\nChapter 2\n".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = import(&mut storage, &source, "v7");
        let toc = storage.list_toc(&imported.book.id).unwrap().entries;
        let position = toc[1].locator.clone();
        storage.save_position(&position).unwrap();
        let bookmark = storage
            .add_bookmark(&BookmarkRequest {
                book_id: imported.book.id.clone(),
                locator: position.clone(),
                excerpt: "Chapter 2".to_string(),
                note: None,
            })
            .unwrap();
        let group = storage.create_group("Saved group").unwrap();
        storage
            .move_book(&imported.book.id, &ShelfPlacement::Group(group.id.clone()))
            .unwrap();
        let groups = storage.list_groups().unwrap();
        let preferences = ReaderPreferences {
            font_size: 24.0,
            ..ReaderPreferences::default()
        };
        let mut legacy_preferences = serde_json::to_value(&preferences).unwrap();
        legacy_preferences
            .as_object_mut()
            .unwrap()
            .remove("autoPageSeconds");
        legacy_preferences
            .as_object_mut()
            .unwrap()
            .remove("readingMode");
        legacy_preferences
            .as_object_mut()
            .unwrap()
            .remove("autoScrollSpeed");
        storage
            .conn
            .execute(
                "INSERT INTO reader_preferences(id, preferences_json, updated_at) VALUES(1,?1,1)",
                params![legacy_preferences.to_string()],
            )
            .unwrap();
        // Old directory JSON remains readable but must be rebuilt once under
        // the new explicit default-rule identity.
        storage
            .conn
            .execute("UPDATE toc_cache SET entries_json = '[]'", [])
            .unwrap();
        storage.conn.execute_batch("DROP TABLE online_cover_cache; DROP TABLE online_book_cache; DROP TABLE retired_books; DROP TABLE online_chapters; DROP TABLE online_books; DROP TABLE source_cookies; DROP TABLE source_cache; DROP TABLE book_sources; DROP TABLE retired_reading_time; DROP TABLE progress_sync; DROP TABLE cloud_books; DROP TABLE pending_book_metadata; DROP TABLE pending_book_restores; DROP TABLE sync_settings; DROP TABLE replace_rules; ALTER TABLE txt_assets DROP COLUMN transform_json; ALTER TABLE books DROP COLUMN use_replace_rules; DROP TABLE reading_time; ALTER TABLE books DROP COLUMN shelf_state; ALTER TABLE books DROP COLUMN cover_asset_id; ALTER TABLE bookmarks DROP COLUMN note; DROP TABLE book_toc_settings; DROP TABLE txt_toc_rules; DROP TABLE reader_assets; ALTER TABLE books DROP COLUMN intro; ALTER TABLE toc_cache DROP COLUMN rule_identity; ALTER TABLE toc_cache DROP COLUMN rule_revision; DELETE FROM schema_migrations WHERE version >= 8;").unwrap();
        drop(storage);
        let mut reopened = Storage::open(&app_root).unwrap();
        assert_eq!(
            reopened
                .conn
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            CURRENT_SCHEMA_VERSION
        );
        assert_eq!(reopened.get_book(&imported.book.id).unwrap(), imported.book);
        assert_eq!(
            reopened.saved_position(&imported.book.id).unwrap(),
            Some(position)
        );
        assert_eq!(
            reopened.list_bookmarks(&imported.book.id).unwrap(),
            [bookmark]
        );
        // Schema 11 replaces groups with reading states, as the reader chose.
        assert!(!groups.is_empty());
        assert!(reopened.list_groups().unwrap().is_empty());
        assert_eq!(
            reopened.list_shelf_books(false, None).unwrap()[0].shelf_state,
            None
        );
        assert_eq!(reopened.get_settings().unwrap(), preferences);
        assert_eq!(reopened.list_toc(&imported.book.id).unwrap().entries, toc);
        let mut updated = preferences.clone();
        updated.auto_page_seconds = 12;
        reopened.save_settings(&updated).unwrap();
        for interval in [0, 1, 61, u8::MAX] {
            let invalid = ReaderPreferences {
                auto_page_seconds: interval,
                ..updated.clone()
            };
            assert_eq!(
                reopened.save_settings(&invalid).unwrap_err().code,
                ErrorCode::InvalidArgument
            );
        }
        drop(reopened);
        assert_eq!(
            Storage::open(&app_root).unwrap().get_settings().unwrap(),
            updated
        );
    }
}
