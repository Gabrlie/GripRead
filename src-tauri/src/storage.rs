use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, ErrorCode};
use crate::models::{
    AssetAvailability, AssetKind, Book, BookAsset, ContentWindow, ImportPhase, ImportResult,
    ReaderLocator,
};
use crate::txt::{
    byte_index_for_offset, decode_and_normalize, floor_boundary, utf16_boundaries, utf16_length,
};

const MAX_WINDOW_UNITS: u64 = 1_000_000;

pub struct Storage {
    root: PathBuf,
    conn: Connection,
}

#[derive(Debug)]
struct AssetRecord {
    asset: BookAsset,
    relative_path: String,
}

struct FinalFileGuard(Option<PathBuf>);

impl FinalFileGuard {
    fn new() -> Self {
        Self(None)
    }

    fn track(&mut self, path: PathBuf) {
        self.0 = Some(path);
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for FinalFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

impl Storage {
    pub fn open(root: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(root)?;
        fs::create_dir_all(root.join("books"))?;
        fs::create_dir_all(root.join("staging"))?;

        let conn = Connection::open(root.join("gripread.sqlite3"))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Self::apply_migrations(&conn)?;
        Self::cleanup_staging_dir(&root.join("staging"));

        Ok(Self {
            root: root.to_path_buf(),
            conn,
        })
    }

    fn apply_migrations(conn: &Connection) -> Result<(), AppError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY NOT NULL,
                applied_at INTEGER NOT NULL
            );",
        )?;

        let current: i64 = conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;

        if current < 1 {
            let tx = conn.unchecked_transaction()?;
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

        Ok(())
    }

    fn cleanup_staging_dir(staging_dir: &Path) {
        let Ok(entries) = fs::read_dir(staging_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension == "part")
            {
                let _ = fs::remove_file(path);
            }
        }
    }

    pub fn list_books(&self) -> Result<Vec<Book>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, title, author, content_version, created_at, updated_at
             FROM books ORDER BY updated_at DESC, id ASC",
        )?;
        let books = statement
            .query_map([], book_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(books)
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

    pub fn import_txt<F>(
        &mut self,
        source: &Path,
        operation_id: &str,
        cancel: &AtomicBool,
        mut report: F,
    ) -> Result<ImportResult, AppError>
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
        report(ImportPhase::Reading, 0, total_bytes);
        let mut file = File::open(source)?;
        let mut input = Vec::with_capacity(total_bytes.min(8 * 1024 * 1024) as usize);
        let mut chunk = [0_u8; 64 * 1024];
        let mut bytes_read = 0_u64;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(AppError::new(
                    ErrorCode::ImportCancelled,
                    "TXT import was cancelled",
                ));
            }
            let read = file.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            input.extend_from_slice(&chunk[..read]);
            bytes_read += read as u64;
            report(ImportPhase::Reading, bytes_read, total_bytes);
        }

        report(ImportPhase::Normalizing, bytes_read, total_bytes);
        let normalized = decode_and_normalize(&input)?;
        if cancel.load(Ordering::Acquire) {
            return Err(AppError::new(
                ErrorCode::ImportCancelled,
                "TXT import was cancelled",
            ));
        }

        let stage_path = self
            .root
            .join("staging")
            .join(format!("{operation_id}.part"));
        let result = self.persist_staged(
            source,
            &stage_path,
            normalized.as_bytes(),
            total_bytes,
            cancel,
            &mut report,
        );
        if result.is_err() {
            let _ = fs::remove_file(&stage_path);
        }
        result
    }

    fn persist_staged<F>(
        &mut self,
        source: &Path,
        stage_path: &Path,
        normalized: &[u8],
        source_byte_length: u64,
        cancel: &AtomicBool,
        report: &mut F,
    ) -> Result<ImportResult, AppError>
    where
        F: FnMut(ImportPhase, u64, u64),
    {
        let mut stage = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage_path)?;
        stage.write_all(normalized)?;
        stage.sync_all()?;
        drop(stage);

        if cancel.load(Ordering::Acquire) {
            return Err(AppError::new(
                ErrorCode::ImportCancelled,
                "TXT import was cancelled",
            ));
        }

        let hash = Sha256::digest(normalized);
        let sha256 = format!("{hash:x}");
        report(
            ImportPhase::Persisting,
            source_byte_length,
            source_byte_length,
        );

        let root = self.root.clone();
        let mut final_file_guard = FinalFileGuard::new();
        let transaction = self.conn.transaction()?;
        let existing = transaction
            .query_row(
                "SELECT id, book_id, kind, sha256, byte_length, content_version, relative_path, created_at
                 FROM book_assets WHERE sha256 = ?1",
                params![sha256],
                asset_from_row,
            )
            .optional()?;

        let result = if let Some(existing) = existing {
            let final_path = root.join(&existing.relative_path);
            if final_path.exists() {
                fs::remove_file(stage_path)?;
            } else {
                if let Some(parent) = final_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(stage_path, &final_path)?;
                final_file_guard.track(final_path.clone());
            }

            if cancel.load(Ordering::Acquire) {
                return Err(AppError::new(
                    ErrorCode::ImportCancelled,
                    "TXT import was cancelled",
                ));
            }

            let book = transaction
                .query_row(
                    "SELECT id, title, author, content_version, created_at, updated_at
                     FROM books WHERE id = ?1",
                    params![existing.asset.book_id],
                    book_from_row,
                )
                .map_err(AppError::from)?;
            let asset = BookAsset {
                availability: AssetAvailability::Ready,
                ..existing.asset
            };
            ImportResult {
                book,
                asset,
                duplicate: true,
                source_byte_length,
            }
        } else {
            let book_id = Uuid::new_v4().to_string();
            let asset_id = Uuid::new_v4().to_string();
            let content_version = sha256.clone();
            let created_at = now_millis();
            let title = title_from_path(source);
            let relative_path = format!("books/{book_id}/{asset_id}.txt");
            let final_path = root.join(&relative_path);

            if let Some(parent) = final_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(stage_path, &final_path)?;
            final_file_guard.track(final_path.clone());

            if cancel.load(Ordering::Acquire) {
                let _ = fs::remove_file(&final_path);
                return Err(AppError::new(
                    ErrorCode::ImportCancelled,
                    "TXT import was cancelled",
                ));
            }

            let book = Book {
                id: book_id.clone(),
                title,
                author: None,
                content_version: content_version.clone(),
                created_at,
                updated_at: created_at,
            };
            transaction.execute(
                "INSERT INTO books(id, title, author, content_version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    book.id,
                    book.title,
                    book.author,
                    book.content_version,
                    book.created_at,
                    book.updated_at
                ],
            )?;

            let asset = BookAsset {
                id: asset_id,
                book_id: book_id.clone(),
                kind: AssetKind::Txt,
                sha256,
                byte_length: normalized.len() as u64,
                content_version,
                availability: AssetAvailability::Ready,
                created_at,
            };
            transaction.execute(
                "INSERT INTO book_assets(
                    id, book_id, kind, sha256, byte_length, content_version, relative_path, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    asset.id,
                    asset.book_id,
                    "txt",
                    asset.sha256,
                    asset.byte_length as i64,
                    asset.content_version,
                    relative_path,
                    asset.created_at
                ],
            )?;

            ImportResult {
                book,
                asset,
                duplicate: false,
                source_byte_length,
            }
        };

        if cancel.load(Ordering::Acquire) {
            return Err(AppError::new(
                ErrorCode::ImportCancelled,
                "TXT import was cancelled",
            ));
        }

        transaction.commit()?;
        final_file_guard.disarm();

        report(
            ImportPhase::Completed,
            source_byte_length,
            source_byte_length,
        );
        Ok(result)
    }

    pub fn read_content_window(
        &self,
        book_id: &str,
        locator: Option<&ReaderLocator>,
        max_units: u64,
    ) -> Result<ContentWindow, AppError> {
        if max_units == 0 || max_units > MAX_WINDOW_UNITS {
            return Err(AppError::invalid_argument(format!(
                "content window must contain between 1 and {MAX_WINDOW_UNITS} UTF-16 units"
            )));
        }
        let record = self.asset_for_book(book_id)?;
        let text = self.read_asset_text(&record)?;
        let boundaries = utf16_boundaries(&text);
        let total_length = utf16_length(&text);
        let start_offset = locator.map_or(0, |position| {
            if position.book_id != book_id {
                return u64::MAX;
            }
            position.offset
        });

        if let Some(position) = locator {
            self.validate_locator(&record, position, &boundaries)?;
        }
        if start_offset == u64::MAX {
            return Err(AppError::new(
                ErrorCode::InvalidLocator,
                "locator belongs to another book",
            ));
        }
        let start_byte = byte_index_for_offset(&boundaries, start_offset)?;
        let target_end = start_offset.saturating_add(max_units);
        let (mut end_offset, mut end_byte) =
            floor_boundary(&boundaries, target_end.min(total_length));
        if end_offset == start_offset && start_offset < total_length {
            let next = boundaries
                .iter()
                .find(|(offset, _)| *offset > start_offset)
                .copied()
                .ok_or_else(|| {
                    AppError::new(ErrorCode::InvalidLocator, "unable to advance locator")
                })?;
            end_offset = next.0;
            end_byte = next.1;
        }

        let page_text = text[start_byte..end_byte].to_string();
        let page_locator = self.locator_for(&record, &text, &boundaries, start_offset)?;
        Ok(ContentWindow {
            book_id: book_id.to_string(),
            resource_id: record.asset.id,
            content_version: record.asset.content_version,
            text: page_text,
            start_offset,
            end_offset,
            total_length,
            has_before: start_offset > 0,
            has_after: end_offset < total_length,
            locator: page_locator,
        })
    }

    pub fn save_position(&self, locator: &ReaderLocator) -> Result<ReaderLocator, AppError> {
        let record = self.asset_for_book(&locator.book_id)?;
        let text = self.read_asset_text(&record)?;
        let boundaries = utf16_boundaries(&text);
        self.validate_locator(&record, locator, &boundaries)?;
        let serialized = serde_json::to_string(locator)?;
        self.conn.execute(
            "INSERT INTO reading_positions(book_id, locator_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(book_id) DO UPDATE SET locator_json = excluded.locator_json,
                 updated_at = excluded.updated_at",
            params![locator.book_id, serialized, now_millis()],
        )?;
        Ok(locator.clone())
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
                        ErrorCode::InvalidLocator,
                        format!("saved locator is invalid: {error}"),
                    )
                })
            })
            .transpose()
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

    fn read_asset_text(&self, record: &AssetRecord) -> Result<String, AppError> {
        let path = self.root.join(&record.relative_path);
        if !path.is_file() {
            return Err(AppError::new(
                ErrorCode::AssetMissing,
                format!("local asset {} is missing", record.asset.id),
            ));
        }
        fs::read_to_string(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::InvalidData {
                AppError::new(
                    ErrorCode::UnsupportedEncoding,
                    "managed TXT asset is not UTF-8",
                )
            } else {
                AppError::new(ErrorCode::Io, error.to_string())
            }
        })
    }

    fn validate_locator(
        &self,
        record: &AssetRecord,
        locator: &ReaderLocator,
        boundaries: &[(u64, usize)],
    ) -> Result<(), AppError> {
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
        byte_index_for_offset(boundaries, locator.offset).map(|_| ())
    }

    fn locator_for(
        &self,
        record: &AssetRecord,
        text: &str,
        boundaries: &[(u64, usize)],
        offset: u64,
    ) -> Result<ReaderLocator, AppError> {
        let byte_index = byte_index_for_offset(boundaries, offset)?;
        let before = text[..byte_index]
            .chars()
            .rev()
            .take(32)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        let after = text[byte_index..].chars().take(32).collect();
        Ok(ReaderLocator {
            book_id: record.asset.book_id.clone(),
            content_version: record.asset.content_version.clone(),
            resource_id: record.asset.id.clone(),
            offset,
            context_before: before,
            context_after: after,
        })
    }
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
    let kind: String = row.get(2)?;
    let kind = match kind.as_str() {
        "txt" => AssetKind::Txt,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                format!("unsupported asset kind {kind}").into(),
            ));
        }
    };
    let byte_length: i64 = row.get(4)?;
    Ok(AssetRecord {
        asset: BookAsset {
            id: row.get(0)?,
            book_id: row.get(1)?,
            kind,
            sha256: row.get(3)?,
            byte_length: byte_length.max(0) as u64,
            content_version: row.get(5)?,
            availability: AssetAvailability::Missing,
            created_at: row.get(7)?,
        },
        relative_path: row.get(6)?,
    })
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Untitled".to_string())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

    #[test]
    fn import_normalizes_and_deduplicates_by_normalized_hash() {
        let root = TestRoot::new();
        let source_one = write_source(&root.0, "first.txt", b"\xef\xbb\xbfhello\r\nworld\r!\n");
        let source_two = write_source(&root.0, "renamed.txt", b"hello\nworld\n!\n");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();

        let first = storage
            .import_txt(&source_one, "one", &no_cancel(), |_, _, _| {})
            .unwrap();
        assert!(!first.duplicate);
        let window = storage
            .read_content_window(&first.book.id, None, 64)
            .unwrap();
        assert_eq!(window.text, "hello\nworld\n!\n");

        let second = storage
            .import_txt(&source_two, "two", &no_cancel(), |_, _, _| {})
            .unwrap();
        assert!(second.duplicate);
        assert_eq!(first.book.id, second.book.id);
        assert_eq!(first.asset.id, second.asset.id);
        assert_eq!(storage.list_books().unwrap().len(), 1);
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
    fn cancellation_happens_before_persisting() {
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
    }

    #[test]
    fn million_character_text_and_emoji_positions_are_stable() {
        let root = TestRoot::new();
        let content = "ab😀\n".repeat(250_000);
        assert_eq!(content.chars().count(), 1_000_000);
        let source = write_source(&root.0, "large.txt", content.as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = storage
            .import_txt(&source, "large", &no_cancel(), |_, _, _| {})
            .unwrap();
        let first = storage
            .read_content_window(&imported.book.id, None, 2)
            .unwrap();
        assert_eq!(first.text, "ab");
        assert_eq!(first.end_offset, 2);
        let next_locator = ReaderLocator {
            offset: first.end_offset,
            ..first.locator.clone()
        };
        let second = storage
            .read_content_window(&imported.book.id, Some(&next_locator), 2)
            .unwrap();
        assert_eq!(second.text, "😀");
        assert_eq!(second.start_offset, 2);
        assert_eq!(second.end_offset, 4);
        let bad_locator = ReaderLocator {
            offset: 3,
            ..second.locator.clone()
        };
        let error = storage
            .read_content_window(&imported.book.id, Some(&bad_locator), 3)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidLocator);
        assert_eq!(first.total_length, utf16_length(&content));
    }

    #[test]
    fn positions_restore_and_report_version_or_asset_errors() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "position.txt", "hello😀world".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = storage
            .import_txt(&source, "position", &no_cancel(), |_, _, _| {})
            .unwrap();
        let window = storage
            .read_content_window(&imported.book.id, None, 4)
            .unwrap();
        storage.save_position(&window.locator).unwrap();
        assert_eq!(
            storage.saved_position(&imported.book.id).unwrap(),
            Some(window.locator.clone())
        );

        let stale = ReaderLocator {
            content_version: "changed".to_string(),
            ..window.locator.clone()
        };
        let error = storage
            .read_content_window(&imported.book.id, Some(&stale), 4)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ContentVersionMismatch);

        let asset_path = app_root
            .join("books")
            .join(&imported.book.id)
            .join(format!("{}.txt", imported.asset.id));
        fs::remove_file(asset_path).unwrap();
        let error = storage
            .read_content_window(&imported.book.id, None, 4)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::AssetMissing);
    }

    #[test]
    fn migrations_are_reused_after_restart() {
        let root = TestRoot::new();
        let app_root = root.0.join("data");
        let storage = Storage::open(&app_root).unwrap();
        drop(storage);
        let reopened = Storage::open(&app_root).unwrap();
        let version: i64 = reopened
            .conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn saved_position_restores_after_storage_restart() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "restart.txt", "first\nsecond\nthird".as_bytes());
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let imported = storage
            .import_txt(&source, "restart", &no_cancel(), |_, _, _| {})
            .unwrap();
        let window = storage
            .read_content_window(&imported.book.id, None, 6)
            .unwrap();
        storage.save_position(&window.locator).unwrap();
        drop(storage);

        let reopened = Storage::open(&app_root).unwrap();
        let restored = reopened.saved_position(&imported.book.id).unwrap();
        assert_eq!(restored, Some(window.locator.clone()));
        let restored_window = reopened
            .read_content_window(&imported.book.id, restored.as_ref(), 6)
            .unwrap();
        assert_eq!(restored_window.text, window.text);
    }

    #[test]
    fn cancellation_during_persist_rolls_back_file_and_database() {
        let root = TestRoot::new();
        let source = write_source(&root.0, "persist-cancel.txt", b"cancel before commit");
        let app_root = root.0.join("data");
        let mut storage = Storage::open(&app_root).unwrap();
        let cancel = AtomicBool::new(false);
        let error = storage
            .import_txt(&source, "persist-cancel", &cancel, |phase, _, _| {
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
        assert!(fs::read_dir(app_root.join("books"))
            .unwrap()
            .all(|entry| entry.unwrap().path().read_dir().unwrap().next().is_none()));
    }
}
