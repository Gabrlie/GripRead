//! Portable records for backups (Sync specification, "Backup and recovery").
//!
//! A backup holds what the reader made on the shelf, not the books: book
//! metadata, placement, progress, bookmarks, and reading time keyed by the
//! SHA-256 of each book's original file bytes, plus groups, chapter and
//! replace rules, and preferences. Book files travel separately through the
//! cloud bookshelf. Restoring merges into the current library; records for
//! books that are not on this device wait until a book with the same source
//! bytes is imported.

use super::*;
use crate::models::{
    BackupPreview, RestoreCategory, RestoreReport, WebDavSettings, DEFAULT_WEBDAV_FOLDER,
    DEFAULT_WEBDAV_URL,
};

pub const BACKUP_FORMAT: &str = "gripread-backup";
pub const BACKUP_VERSION: u32 = 1;
/// Local recovery points written before each restore.
const RECOVERY_POINTS: usize = 5;
/// Characters of context kept on each side of a backed-up position.
const CONTEXT_CHARS: usize = 32;
/// Characters of context on each side used to find a position again.
const NEEDLE_CHARS: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupDocument {
    pub format: String,
    pub version: u32,
    pub created_at: i64,
    /// The platform that wrote the backup, for display.
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub books: Vec<PortableBook>,
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default)]
    pub replace_rules: Vec<ReplaceRule>,
    #[serde(default)]
    pub toc_rules: Vec<TxtTocRule>,
    #[serde(default)]
    pub preferences: Option<ReaderPreferences>,
    #[serde(default)]
    pub shelf_preferences: Option<ShelfPreferences>,
    /// Book sources as Legado JSON; login state and cookies stay on the device.
    #[serde(default)]
    pub book_sources: Vec<serde_json::Value>,
    #[serde(default)]
    pub online_books: Vec<PortableOnlineBook>,
    /// The WebDAV account, only in backup files kept by the reader (导出到文件
    /// and the local backup folder); backups sent to WebDAV never carry it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webdav: Option<PortableWebDav>,
    /// 订阅: the subscriptions and the starred articles.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feeds: Vec<super::rss::PortableFeed>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub starred_articles: Vec<super::rss::PortableStar>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableWebDav {
    pub url: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub folder: String,
}

/// An online book on the shelf: its source and details, and the records
/// kept by chapter position so they survive a different source's contents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortableOnlineBook {
    pub book: crate::models::OnlineBook,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub shelf_state: Option<ShelfState>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default = "default_true")]
    pub use_replace_rules: bool,
    #[serde(default = "default_true")]
    pub can_update: bool,
    #[serde(default)]
    pub position: Option<super::online::ChapterPosition>,
    #[serde(default)]
    pub position_updated_at: i64,
    #[serde(default)]
    pub bookmarks: Vec<super::online::PendingBookmark>,
    #[serde(default)]
    pub reading_time: Vec<(String, u64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortableBook {
    /// SHA-256 of the original file bytes: the book's identity across devices.
    pub source_sha256: String,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub intro: Option<String>,
    /// A reading state the reader chose by moving the book.
    #[serde(default)]
    pub shelf_state: Option<ShelfState>,
    /// The user group the book is in, by name.
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default = "default_true")]
    pub use_replace_rules: bool,
    #[serde(default)]
    pub toc: BookTocSettings,
    #[serde(default)]
    pub position: Option<PortableLocator>,
    #[serde(default)]
    pub position_updated_at: i64,
    #[serde(default)]
    pub bookmarks: Vec<PortableBookmark>,
    /// Seconds read per local calendar day (`YYYY-MM-DD`).
    #[serde(default)]
    pub reading_time: Vec<(String, u64)>,
    /// The book's own cover; the image travels in the cloud `Covers/` folder.
    #[serde(default)]
    pub cover: Option<CoverRef>,
    /// Kept by this device when the book was deleted, so the 恢复忽略列表
    /// does not apply when the same book returns.
    #[serde(default)]
    pub local: bool,
}

/// A cover image by content: `Covers/<sha256>.<ext>` on WebDAV, and the same
/// name in the local `cloud-covers/` cache.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoverRef {
    pub sha256: String,
    pub ext: String,
}

impl CoverRef {
    pub fn file_name(&self) -> String {
        format!("{}.{}", self.sha256, self.ext)
    }
}

/// What this device last did with a book's cloud progress: the remote
/// version it uploaded or answered, its own upload count, and the position
/// it last uploaded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProgressState {
    pub handled_device: String,
    pub handled_revision: u64,
    pub local_revision: u64,
    pub synced_version: Option<String>,
    pub synced_offset: Option<u64>,
}

/// Book information from the cloud bookshelf index, applied when the
/// downloaded book is imported.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudMetadata {
    pub title: String,
    pub author: Option<String>,
    pub intro: Option<String>,
    pub cover: Option<CoverRef>,
}

fn default_true() -> bool {
    true
}

/// A position in the text the book had on the device that made the backup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableLocator {
    pub content_version: String,
    pub offset: u64,
    /// UTF-16 length of that text, for placing a position proportionally.
    pub total_length: u64,
    pub context_before: String,
    pub context_after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableBookmark {
    pub locator: PortableLocator,
    pub excerpt: String,
    #[serde(default)]
    pub note: String,
    pub created_at: i64,
}

/// Reads a backup file, rejecting other files and newer formats.
pub fn parse_backup(bytes: &[u8]) -> Result<BackupDocument, AppError> {
    let document: BackupDocument = serde_json::from_slice(bytes)
        .map_err(|error| AppError::invalid_argument(format!("not a GripRead backup: {error}")))?;
    if document.format != BACKUP_FORMAT {
        return Err(AppError::invalid_argument("not a GripRead backup"));
    }
    if document.version > BACKUP_VERSION {
        return Err(AppError::invalid_argument(
            "this backup was made by a newer version of GripRead",
        ));
    }
    Ok(document)
}

/// This device's WebDAV account, sync switches, and backup state, kept out of backups.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredWebDav {
    pub url: String,
    pub username: String,
    pub password: String,
    pub folder: String,
    pub device_name: String,
    /// A random identity for this device, so its own progress uploads are recognized.
    pub device_id: String,
    /// A local folder (path or Android tree URI) that also receives backups.
    pub local_folder: Option<String>,
    pub local_folder_label: Option<String>,
    pub auto_backup: bool,
    pub sync_progress: bool,
    pub sync_progress_plus: bool,
    pub auto_sync_book_info: bool,
    pub restore_ignore: Vec<RestoreCategory>,
    pub last_backup_at: Option<i64>,
    /// Digest of the records of the last automatic backup, to skip unchanged days.
    pub last_backup_digest: Option<String>,
    pub last_error: Option<String>,
}

impl Default for StoredWebDav {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: String::new(),
            password: String::new(),
            folder: String::new(),
            device_name: String::new(),
            device_id: String::new(),
            local_folder: None,
            local_folder_label: None,
            auto_backup: false,
            // Legado turns progress sync on by default.
            sync_progress: true,
            sync_progress_plus: false,
            auto_sync_book_info: false,
            restore_ignore: Vec::new(),
            last_backup_at: None,
            last_backup_digest: None,
            last_error: None,
        }
    }
}

impl StoredWebDav {
    /// An account is set when an address or a user name is.
    pub fn configured(&self) -> bool {
        !self.url.trim().is_empty() || !self.username.trim().is_empty()
    }

    /// The address, with 坚果云 for an empty one.
    pub fn address(&self) -> String {
        let url = self.url.trim();
        if url.is_empty() {
            DEFAULT_WEBDAV_URL.into()
        } else {
            url.into()
        }
    }

    /// The application folder under the address.
    pub fn root_folder(&self) -> String {
        let folder = self.folder.trim().trim_matches('/');
        if folder.is_empty() {
            DEFAULT_WEBDAV_FOLDER.into()
        } else {
            folder.into()
        }
    }

    /// The device name for backups and progress, `fallback` when unset.
    pub fn device(&self, fallback: &str) -> String {
        let name = self.device_name.trim();
        if name.is_empty() {
            fallback.into()
        } else {
            name.into()
        }
    }

    pub fn ignores(&self, category: RestoreCategory) -> bool {
        self.restore_ignore.contains(&category)
    }

    pub fn view(&self) -> WebDavSettings {
        WebDavSettings {
            url: self.url.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
            folder: self.folder.clone(),
            device_name: self.device_name.clone(),
            local_folder: self
                .local_folder_label
                .clone()
                .or(self.local_folder.clone()),
            auto_backup: self.auto_backup,
            sync_progress: self.sync_progress,
            sync_progress_plus: self.sync_progress_plus,
            auto_sync_book_info: Some(self.auto_sync_book_info),
            restore_ignore: self.restore_ignore.clone(),
            last_backup_at: self.last_backup_at,
            last_error: self.last_error.clone(),
            configured: self.configured(),
        }
    }
}

/// A digest of a backup's records, ignoring when it was made.
pub fn backup_digest(document: &BackupDocument) -> Result<String, AppError> {
    let mut unstamped = document.clone();
    unstamped.created_at = 0;
    Ok(sha256_bytes(&serde_json::to_vec(&unstamped)?))
}

/// Shelf books with their managed asset and original-file hash.
pub(super) struct ShelfBook {
    pub(super) book_id: String,
    pub(super) source_sha256: String,
}

/// Which parts of a book record to apply: a restore takes all that the
/// 恢复忽略列表 allows, a sync record one part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Parts {
    pub(super) info: bool,
    pub(super) progress: bool,
    pub(super) marks: bool,
    pub(super) time: bool,
}

impl Parts {
    pub(super) const NONE: Parts = Parts {
        info: false,
        progress: false,
        marks: false,
        time: false,
    };

    /// What the 恢复忽略列表 allows; a book this device kept for reimport
    /// (`local`) comes back whole.
    fn allowed(settings: &StoredWebDav, local: bool) -> Parts {
        let wanted = |category| local || !settings.ignores(category);
        Parts {
            info: wanted(RestoreCategory::BookInfo),
            progress: wanted(RestoreCategory::Progress),
            marks: wanted(RestoreCategory::Bookmarks),
            time: wanted(RestoreCategory::ReadingTime),
        }
    }
}

impl Storage {
    pub fn stored_webdav(&self) -> Result<StoredWebDav, AppError> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT settings_json FROM sync_settings WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let mut settings: StoredWebDav = json
            .map(|json| serde_json::from_str(&json))
            .transpose()?
            .unwrap_or_default();
        if settings.device_id.is_empty() {
            settings.device_id = Uuid::new_v4().to_string();
            self.save_stored_webdav(&settings)?;
        }
        Ok(settings)
    }

    pub fn save_stored_webdav(&self, settings: &StoredWebDav) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT INTO sync_settings(id, settings_json) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json",
            params![serde_json::to_string(settings)?],
        )?;
        Ok(())
    }

    pub(super) fn shelf_books_with_sources(&self) -> Result<Vec<ShelfBook>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT b.id, t.source_sha256 FROM books b
             JOIN book_assets a ON a.book_id = b.id
             JOIN txt_assets t ON t.asset_id = a.id
             WHERE NOT EXISTS(SELECT 1 FROM shelf_removals r WHERE r.book_id = b.id)
               AND t.source_sha256 IS NOT NULL AND t.source_sha256 != ''
             ORDER BY b.created_at, b.id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(ShelfBook {
                    book_id: row.get(0)?,
                    source_sha256: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Shelf books with their original file's SHA-256, oldest first.
    pub fn shelf_book_sources(&self) -> Result<Vec<(String, String)>, AppError> {
        Ok(self
            .shelf_books_with_sources()?
            .into_iter()
            .map(|book| (book.book_id, book.source_sha256))
            .collect())
    }

    /// The local book with this original file and whether it is in the 回收站.
    pub(crate) fn local_book_for_source(
        &self,
        source_sha256: &str,
    ) -> Result<Option<(String, bool)>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT a.book_id, EXISTS(SELECT 1 FROM shelf_removals r WHERE r.book_id = a.book_id)
                 FROM txt_assets t JOIN book_assets a ON a.id = t.asset_id
                 WHERE t.source_sha256 = ?1 ORDER BY a.created_at LIMIT 1",
                params![source_sha256],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    /// The book's cover image and its content reference.
    pub fn book_cover_file(&self, book_id: &str) -> Result<Option<(PathBuf, CoverRef)>, AppError> {
        let row: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT r.relative_path, r.name FROM books b JOIN reader_assets r ON r.id = b.cover_asset_id
                 WHERE b.id = ?1",
                params![book_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((relative, name)) = row else {
            return Ok(None);
        };
        let path = self.root.join(&relative);
        let Ok(bytes) = fs::read(&path) else {
            return Ok(None);
        };
        let ext = Path::new(&name)
            .extension()
            .or_else(|| Path::new(&relative).extension())
            .and_then(|ext| ext.to_str())
            .unwrap_or("jpg")
            .to_ascii_lowercase();
        Ok(Some((
            path,
            CoverRef {
                sha256: sha256_bytes(&bytes),
                ext,
            },
        )))
    }

    /// The book's own introduction, as edited or detected.
    pub fn book_intro(&self, book_id: &str) -> Result<Option<String>, AppError> {
        Ok(self.conn.query_row(
            "SELECT intro FROM books WHERE id = ?1",
            params![book_id],
            |row| row.get(0),
        )?)
    }

    /// The saved position as a portable locator, with the locator itself.
    pub fn portable_position(
        &self,
        book_id: &str,
    ) -> Result<Option<(PortableLocator, ReaderLocator)>, AppError> {
        let Some(locator) = self.saved_position(book_id)? else {
            return Ok(None);
        };
        let total_length = self
            .persisted_index(&self.asset_for_book(book_id)?.asset.id)?
            .map(|persisted| persisted.index.utf16_length)
            .unwrap_or(0);
        Ok(Some((
            self.portable_locator(&locator, total_length),
            locator,
        )))
    }

    /// A portable position in this device's text of the book: the same
    /// offset for the same text, otherwise found again by its context.
    pub fn locator_from_portable(
        &self,
        book_id: &str,
        portable: &PortableLocator,
    ) -> Result<Option<ReaderLocator>, AppError> {
        let context = self.content_read_context(book_id)?;
        let verified = verify_content_context(&context)?;
        self.persist_content_index(&context, &verified)?;
        let offset = if portable.content_version == context.record.asset.content_version {
            portable.offset
        } else {
            relocate(&read_verified_text(&context, &verified)?, portable)
        };
        let request = ResolveOffsetRequest {
            book_id: book_id.into(),
            content_version: context.record.asset.content_version.clone(),
            resource_id: context.record.asset.id.clone(),
            offset: offset.min(verified.index.utf16_length),
        };
        Ok(resolve_offset_from_context(&request, &context, &verified).ok())
    }

    /// The book's progress sync state; defaults before its first sync.
    pub fn progress_state(&self, book_id: &str) -> Result<ProgressState, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT handled_device, handled_revision, local_revision, synced_version, synced_offset
                 FROM progress_sync WHERE book_id = ?1",
                params![book_id],
                |row| {
                    Ok(ProgressState {
                        handled_device: row.get(0)?,
                        handled_revision: row.get::<_, i64>(1)? as u64,
                        local_revision: row.get::<_, i64>(2)? as u64,
                        synced_version: row.get(3)?,
                        synced_offset: row.get::<_, Option<i64>>(4)?.map(|offset| offset as u64),
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }

    pub fn save_progress_state(
        &self,
        book_id: &str,
        state: &ProgressState,
    ) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO progress_sync(book_id, handled_device, handled_revision,
                local_revision, synced_version, synced_offset) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                book_id,
                state.handled_device,
                state.handled_revision as i64,
                state.local_revision as i64,
                state.synced_version,
                state.synced_offset.map(|offset| offset as i64)
            ],
        )?;
        Ok(())
    }

    /// Where downloaded cover images wait to be applied.
    pub fn cover_cache(&self) -> PathBuf {
        self.root.join("cloud-covers")
    }

    /// Sets the cover from the local cache when it differs from the current one.
    fn apply_cover(&mut self, book_id: &str, cover: &CoverRef) -> Result<(), AppError> {
        if self
            .book_cover_file(book_id)?
            .is_some_and(|(_, current)| current.sha256 == cover.sha256)
        {
            return Ok(());
        }
        let path = self.cover_cache().join(cover.file_name());
        if path.is_file() {
            self.set_book_cover(book_id, &path, &format!("cover.{}", cover.ext))?;
        }
        Ok(())
    }

    /// Keeps cloud book information for a download until its import commits.
    pub fn queue_cloud_metadata(
        &self,
        source_sha256: &str,
        metadata: &CloudMetadata,
    ) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO pending_book_metadata(source_sha256, metadata_json) VALUES (?1, ?2)",
            params![source_sha256, serde_json::to_string(metadata)?],
        )?;
        Ok(())
    }

    /// Replaces the record of what the cloud bookshelf holds.
    pub fn set_cloud_books(&mut self, books: &[(String, String, i64)]) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM cloud_books", [])?;
        for (source, name, uploaded_at) in books {
            tx.execute(
                "INSERT OR REPLACE INTO cloud_books(source_sha256, name, uploaded_at) VALUES (?1, ?2, ?3)",
                params![source, name, uploaded_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn add_cloud_book(
        &self,
        source: &str,
        name: &str,
        uploaded_at: i64,
    ) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO cloud_books(source_sha256, name, uploaded_at) VALUES (?1, ?2, ?3)",
            params![source, name, uploaded_at],
        )?;
        Ok(())
    }

    pub fn remove_cloud_book(&self, name: &str) -> Result<(), AppError> {
        self.conn
            .execute("DELETE FROM cloud_books WHERE name = ?1", params![name])?;
        Ok(())
    }

    /// The cloud file name recorded for a book, if it was uploaded.
    pub fn cloud_name_for_book(&self, book_id: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT c.name FROM cloud_books c JOIN txt_assets t ON t.source_sha256 = c.source_sha256
                 JOIN book_assets a ON a.id = t.asset_id WHERE a.book_id = ?1 LIMIT 1",
                params![book_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// The local book whose original file has `source_sha256`, on the shelf or not.
    pub(crate) fn book_for_source(&self, source_sha256: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT a.book_id FROM txt_assets t JOIN book_assets a ON a.id = t.asset_id
                 WHERE t.source_sha256 = ?1 ORDER BY a.created_at LIMIT 1",
                params![source_sha256],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn portable_locator(&self, locator: &ReaderLocator, total_length: u64) -> PortableLocator {
        let before: Vec<char> = locator.context_before.chars().collect();
        PortableLocator {
            content_version: locator.content_version.clone(),
            offset: locator.offset,
            total_length,
            context_before: before[before.len().saturating_sub(CONTEXT_CHARS)..]
                .iter()
                .collect(),
            context_after: locator.context_after.chars().take(CONTEXT_CHARS).collect(),
        }
    }

    pub(super) fn portable_book(&self, shelf: &ShelfBook) -> Result<PortableBook, AppError> {
        let (title, author, intro, state, use_rules): (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            bool,
        ) = self.conn.query_row(
            "SELECT title, author, intro, shelf_state, use_replace_rules FROM books WHERE id = ?1",
            params![shelf.book_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        let group: Option<String> = self
            .conn
            .query_row(
                "SELECT g.name FROM book_groups m JOIN library_groups g ON g.id = m.group_id
                 WHERE m.book_id = ?1 LIMIT 1",
                params![shelf.book_id],
                |row| row.get(0),
            )
            .optional()?;
        let total_length = self
            .persisted_index(&self.asset_for_book(&shelf.book_id)?.asset.id)?
            .map(|persisted| persisted.index.utf16_length)
            .unwrap_or(0);
        let position: Option<(String, i64)> = self
            .conn
            .query_row(
                "SELECT locator_json, updated_at FROM reading_positions WHERE book_id = ?1",
                params![shelf.book_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (position, position_updated_at) = match position {
            Some((json, updated_at)) => match serde_json::from_str::<ReaderLocator>(&json) {
                Ok(locator) => (
                    Some(self.portable_locator(&locator, total_length)),
                    updated_at,
                ),
                Err(_) => (None, 0),
            },
            None => (None, 0),
        };
        let bookmarks = self
            .list_bookmarks(&shelf.book_id)?
            .into_iter()
            .map(|bookmark| PortableBookmark {
                locator: self.portable_locator(&bookmark.locator, total_length),
                excerpt: bookmark.excerpt,
                note: bookmark.note,
                created_at: bookmark.created_at,
            })
            .collect();
        let mut statement = self
            .conn
            .prepare("SELECT day, seconds FROM reading_time WHERE book_id = ?1 ORDER BY day")?;
        let reading_time = statement
            .query_map(params![shelf.book_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?.max(0) as u64,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let cover = self
            .book_cover_file(&shelf.book_id)?
            .map(|(_, cover)| cover);
        Ok(PortableBook {
            local: false,
            cover,
            source_sha256: shelf.source_sha256.clone(),
            title,
            author,
            intro,
            shelf_state: state.as_deref().and_then(parse_shelf_state),
            group,
            use_replace_rules: use_rules,
            toc: self.book_toc_settings(&shelf.book_id)?.0,
            position,
            position_updated_at,
            bookmarks,
            reading_time,
        })
    }

    /// The portable records of the whole library. Device files (fonts and
    /// background images) are not part of it.
    pub fn export_backup(&self, device: &str) -> Result<BackupDocument, AppError> {
        let books = self
            .shelf_books_with_sources()?
            .iter()
            .map(|shelf| self.portable_book(shelf))
            .collect::<Result<Vec<_>, _>>()?;
        let mut preferences = self.get_settings()?;
        strip_device_assets(&mut preferences);
        Ok(BackupDocument {
            format: BACKUP_FORMAT.into(),
            version: BACKUP_VERSION,
            created_at: now_millis(),
            device: device.into(),
            books,
            groups: self
                .list_groups()?
                .into_iter()
                .map(|group| group.name)
                .collect(),
            replace_rules: self.list_replace_rules()?,
            toc_rules: self.list_txt_toc_rules()?,
            preferences: Some(preferences),
            shelf_preferences: Some(self.get_shelf_preferences()?),
            book_sources: serde_json::from_str(&self.export_book_sources(&[])?)?,
            online_books: self.portable_online_books()?,
            webdav: None,
            feeds: self.portable_feeds()?,
            starred_articles: self.portable_stars()?,
        })
    }

    /// The records for a backup file the reader keeps: with the WebDAV
    /// account, so restoring it on a new device needs no typing.
    pub fn export_local_backup(&self, device: &str) -> Result<BackupDocument, AppError> {
        let mut document = self.export_backup(device)?;
        document.webdav = self.portable_webdav()?;
        Ok(document)
    }

    /// This device's WebDAV account, when it has one.
    pub fn portable_webdav(&self) -> Result<Option<PortableWebDav>, AppError> {
        let settings = self.stored_webdav()?;
        Ok(settings.configured().then_some(PortableWebDav {
            url: settings.url,
            username: settings.username,
            password: settings.password,
            folder: settings.folder,
        }))
    }

    pub(super) fn portable_online_books(&self) -> Result<Vec<PortableOnlineBook>, AppError> {
        let ids: Vec<String> = {
            let mut statement = self.conn.prepare(
                "SELECT o.book_id FROM online_books o JOIN books b ON b.id = o.book_id
                 WHERE o.on_shelf = 1
                   AND NOT EXISTS(SELECT 1 FROM shelf_removals r WHERE r.book_id = o.book_id)
                 ORDER BY b.created_at, b.id",
            )?;
            let rows = statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            rows
        };
        ids.iter()
            .map(|id| {
                let record = self.online_record(id)?;
                let (author, state, use_rules): (Option<String>, Option<String>, bool) =
                    self.conn.query_row(
                        "SELECT author, shelf_state, use_replace_rules FROM books WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )?;
                let group: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT g.name FROM book_groups m JOIN library_groups g ON g.id = m.group_id
                         WHERE m.book_id = ?1 LIMIT 1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let position_updated_at: i64 = self
                    .conn
                    .query_row(
                        "SELECT updated_at FROM reading_positions WHERE book_id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(0);
                let chapters = self.online_chapters(id)?;
                let count = chapters.len() as u32;
                let bookmarks = self
                    .list_bookmarks(id)?
                    .into_iter()
                    .filter_map(|bookmark| {
                        let index = super::online::resource_chapter(&bookmark.locator.resource_id)?;
                        Some(super::online::PendingBookmark {
                            position: super::online::ChapterPosition {
                                index,
                                title: chapters.get(index as usize)?.title.clone(),
                                offset: bookmark.locator.offset,
                                count,
                            },
                            excerpt: bookmark.excerpt,
                            note: bookmark.note,
                            created_at: bookmark.created_at,
                        })
                    })
                    .collect();
                let mut statement = self.conn.prepare(
                    "SELECT day, seconds FROM reading_time WHERE book_id = ?1 ORDER BY day",
                )?;
                let reading_time = statement
                    .query_map(params![id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?.max(0) as u64,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(PortableOnlineBook {
                    book: record.book,
                    title: record.title,
                    author,
                    shelf_state: state.as_deref().and_then(parse_shelf_state),
                    group,
                    use_replace_rules: use_rules,
                    can_update: record.can_update,
                    position: self.online_position(id)?,
                    position_updated_at,
                    bookmarks,
                    reading_time,
                })
            })
            .collect()
    }

    /// Restores an online book: the one kept for the same source address or
    /// name and author takes the newer position and the union of bookmarks;
    /// otherwise the book is added and its contents fetched when first read.
    /// Adds or finds the online book and applies `parts` of its record;
    /// returns its id.
    pub(super) fn restore_online_book(
        &mut self,
        portable: &PortableOnlineBook,
        parts: Parts,
        report: &mut RestoreReport,
    ) -> Result<String, AppError> {
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT book_id FROM online_books WHERE source_url = ?1 AND book_url = ?2",
                params![portable.book.source_url, portable.book.book_url],
                |row| row.get(0),
            )
            .optional()?
            .or(self.find_online_book(&portable.title, portable.author.as_deref().unwrap_or(""))?);
        let book_id = match existing {
            Some(id) => {
                self.set_online_on_shelf(&id, true)?;
                id
            }
            None => self.add_online_book(&portable.book, &[], true)?,
        };
        if parts.info {
            self.conn.execute(
                "UPDATE books SET title = ?2, author = ?3, shelf_state = ?4, use_replace_rules = ?5
                 WHERE id = ?1",
                params![
                    book_id,
                    portable.title,
                    portable.author,
                    portable.shelf_state.map(shelf_state_name),
                    portable.use_replace_rules
                ],
            )?;
            self.set_online_can_update(&book_id, portable.can_update)?;
            if let Some(group) = portable.group.as_deref() {
                let group_id: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT id FROM library_groups WHERE name = ?1",
                        params![group],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(group_id) = group_id {
                    self.conn.execute(
                        "DELETE FROM book_groups WHERE book_id = ?1",
                        params![book_id],
                    )?;
                    self.conn.execute(
                        "INSERT INTO book_groups(group_id, book_id) VALUES (?1, ?2)",
                        params![group_id, book_id],
                    )?;
                }
            }
        }
        if let Some(position) = portable.position.as_ref().filter(|_| parts.progress) {
            let local_updated: i64 = self
                .conn
                .query_row(
                    "SELECT updated_at FROM reading_positions WHERE book_id = ?1",
                    params![book_id],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if portable.position_updated_at > local_updated {
                match self.locate_online_position(&book_id, position)? {
                    Some((locator, _)) => self.save_position_record(&locator)?,
                    None => self.set_pending_online_position(&book_id, Some(position))?,
                }
                report.positions_restored += 1;
            }
        }
        if parts.marks && !portable.bookmarks.is_empty() {
            let existing: Vec<(u32, u64)> = self
                .list_bookmarks(&book_id)?
                .iter()
                .filter_map(|bookmark| {
                    Some((
                        super::online::resource_chapter(&bookmark.locator.resource_id)?,
                        bookmark.locator.offset,
                    ))
                })
                .collect();
            let missing: Vec<super::online::PendingBookmark> = portable
                .bookmarks
                .iter()
                .filter(|mark| !existing.contains(&(mark.position.index, mark.position.offset)))
                .cloned()
                .collect();
            report.bookmarks_added += missing.len() as u32;
            self.add_pending_online_bookmarks(&book_id, &missing)?;
            self.settle_pending_online_position(&book_id)?;
        }
        if parts.time {
            for (day, seconds) in &portable.reading_time {
                self.conn.execute(
                    "INSERT INTO reading_time(book_id, day, seconds) VALUES (?1, ?2, ?3)
                     ON CONFLICT(book_id, day) DO UPDATE SET seconds = MAX(seconds, excluded.seconds)",
                    params![book_id, day, *seconds as i64],
                )?;
            }
        }
        report.online_books_restored += 1;
        Ok(book_id)
    }

    /// What restoring `document` would do to this library.
    pub fn preview_backup(&self, document: &BackupDocument) -> Result<BackupPreview, AppError> {
        let mut matched = 0;
        for book in &document.books {
            if self.book_for_source(&book.source_sha256)?.is_some() {
                matched += 1;
            }
        }
        Ok(BackupPreview {
            created_at: document.created_at,
            device: document.device.clone(),
            books: document.books.len() as u32,
            books_on_device: matched,
            bookmarks: document
                .books
                .iter()
                .map(|book| book.bookmarks.len() as u32)
                .sum(),
            groups: document.groups.len() as u32,
            replace_rules: document.replace_rules.len() as u32,
            toc_rules: document
                .toc_rules
                .iter()
                .filter(|rule| !rule.builtin)
                .count() as u32,
            has_preferences: document.preferences.is_some(),
            book_sources: document.book_sources.len() as u32,
            online_books: document.online_books.len() as u32,
        })
    }

    /// Saves the current records under `backups/` before a restore,
    /// keeping the latest few. Returns the file name.
    pub fn write_recovery_point(&self, device: &str) -> Result<String, AppError> {
        let directory = self.root.join("backups");
        fs::create_dir_all(&directory)?;
        let document = self.export_backup(device)?;
        let name = format!("recovery-{}.json", document.created_at);
        let path = directory.join(&name);
        let temporary = directory.join(format!("{name}.part"));
        fs::write(&temporary, serde_json::to_vec(&document)?)?;
        fs::rename(&temporary, &path)?;
        let mut points: Vec<PathBuf> = fs::read_dir(&directory)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("recovery-") && name.ends_with(".json"))
            })
            .collect();
        points.sort();
        while points.len() > RECOVERY_POINTS {
            let _ = fs::remove_file(points.remove(0));
        }
        Ok(name)
    }

    /// Local recovery points, newest first.
    pub fn list_recovery_points(&self) -> Result<Vec<String>, AppError> {
        let directory = self.root.join("backups");
        if !directory.is_dir() {
            return Ok(Vec::new());
        }
        let mut names: Vec<String> = fs::read_dir(&directory)?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with("recovery-") && name.ends_with(".json"))
            .collect();
        names.sort();
        names.reverse();
        Ok(names)
    }

    pub fn read_recovery_point(&self, name: &str) -> Result<BackupDocument, AppError> {
        if !name.starts_with("recovery-") || !name.ends_with(".json") || name.contains(['/', '\\'])
        {
            return Err(AppError::invalid_argument("unknown recovery point"));
        }
        parse_backup(&fs::read(self.root.join("backups").join(name))?)
    }

    /// Merges `document` into the library. Books on this device take the
    /// backup's metadata and placement, the newer of the two positions, the
    /// union of bookmarks, and the larger reading time of each day; books
    /// that are not here are kept until a matching book is imported.
    pub fn restore_backup(&mut self, document: &BackupDocument) -> Result<RestoreReport, AppError> {
        let mut report = RestoreReport::default();
        let mut settings = self.stored_webdav()?;
        // A device without a WebDAV account takes the backup's.
        if let Some(account) = document.webdav.as_ref().filter(|_| !settings.configured()) {
            settings.url = account.url.clone();
            settings.username = account.username.clone();
            settings.password = account.password.clone();
            settings.folder = account.folder.clone();
            self.save_stored_webdav(&settings)?;
            report.webdav_restored = true;
        }
        let skip = |category| settings.ignores(category);
        let groups: &[String] = if skip(RestoreCategory::Groups) {
            &[]
        } else {
            &document.groups
        };
        let toc_rules: &[TxtTocRule] = if skip(RestoreCategory::TocRules) {
            &[]
        } else {
            &document.toc_rules
        };
        let tx = self.conn.transaction()?;
        for name in groups {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_groups WHERE name = ?1)",
                params![name],
                |row| row.get(0),
            )?;
            if !exists {
                tx.execute(
                    "INSERT INTO library_groups(id, name) VALUES (?1, ?2)",
                    params![Uuid::new_v4().to_string(), name],
                )?;
                report.groups_created += 1;
            }
        }
        for rule in toc_rules {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM txt_toc_rules WHERE id = ?1)",
                params![rule.id],
                |row| row.get(0),
            )?;
            if exists {
                // Built-in rules keep their definition; their switch and order follow the backup.
                tx.execute(
                    "UPDATE txt_toc_rules SET enabled = ?2, serial = ?3, updated_at = ?4,
                        name = CASE WHEN builtin = 1 THEN name ELSE ?5 END,
                        pattern = CASE WHEN builtin = 1 THEN pattern ELSE ?6 END,
                        example = CASE WHEN builtin = 1 THEN example ELSE ?7 END
                     WHERE id = ?1",
                    params![
                        rule.id,
                        rule.enabled,
                        rule.serial,
                        now_millis(),
                        rule.name,
                        rule.pattern,
                        rule.example
                    ],
                )?;
            } else if !rule.builtin && !rule.id.is_empty() && compile_rule(&rule.pattern).is_ok() {
                tx.execute(
                    "INSERT INTO txt_toc_rules(id, name, pattern, example, serial, enabled, builtin, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
                    params![
                        rule.id,
                        rule.name,
                        rule.pattern,
                        rule.example,
                        rule.serial,
                        rule.enabled,
                        now_millis()
                    ],
                )?;
            } else {
                continue;
            }
            report.rules_restored += 1;
        }
        tx.commit()?;
        for rule in &document.replace_rules {
            if rule.id.is_empty() || skip(RestoreCategory::ReplaceRules) {
                continue;
            }
            // Rules are validated by the same path as an edit.
            if self.save_replace_rule(rule).is_ok() {
                report.rules_restored += 1;
            }
        }
        if !skip(RestoreCategory::Rss) {
            for feed in &document.feeds {
                self.restore_feed(feed)?;
            }
            for star in &document.starred_articles {
                self.restore_star(star)?;
            }
            report.feeds_restored = document.feeds.len() as u32;
        }
        if let Some(preferences) = &document.preferences {
            let current = self.get_settings()?;
            let restored = merge_preferences(
                &current,
                preferences,
                !skip(RestoreCategory::ReadingSettings),
                !skip(RestoreCategory::Theme),
            );
            if restored != current && restored.validate().is_ok() {
                self.save_settings(&restored)?;
                report.preferences_restored = true;
            }
        }
        if let Some(shelf) = document
            .shelf_preferences
            .as_ref()
            .filter(|_| !skip(RestoreCategory::ShelfLayout))
        {
            if self.save_shelf_preferences(shelf).is_err() {
                let mut shelf = shelf.clone();
                shelf.group_id = "all".into();
                let _ = self.save_shelf_preferences(&shelf);
            }
        }
        if !skip(RestoreCategory::Sources) && !document.book_sources.is_empty() {
            let json = serde_json::to_string(&document.book_sources)?;
            let preview = self.preview_source_import(&json)?;
            // Sources already here keep their copy unless the backup's is newer.
            let urls: Vec<String> = preview
                .items
                .iter()
                .filter(|item| item.status != crate::models::SourceImportStatus::Existing)
                .map(|item| item.url.clone())
                .collect();
            if !urls.is_empty() {
                report.sources_restored += self
                    .import_sources(&crate::models::ImportSourcesRequest {
                        json,
                        urls,
                        keep_name: true,
                        keep_group: true,
                        keep_enabled: true,
                    })?
                    .len() as u32;
            }
        }
        if !skip(RestoreCategory::OnlineBooks) {
            let parts = Parts {
                info: !skip(RestoreCategory::BookInfo),
                progress: !skip(RestoreCategory::Progress),
                marks: !skip(RestoreCategory::Bookmarks),
                time: !skip(RestoreCategory::ReadingTime),
            };
            for book in &document.online_books {
                self.restore_online_book(book, parts, &mut report)?;
            }
        }
        for book in &document.books {
            match self.book_for_source(&book.source_sha256)? {
                Some(book_id) => {
                    let parts = Parts::allowed(&settings, book.local);
                    let applied = self.apply_portable_book(&book_id, book, parts)?;
                    report.books_restored += 1;
                    report.positions_restored += u32::from(applied.0);
                    report.bookmarks_added += applied.1;
                }
                None => {
                    self.conn.execute(
                        "INSERT INTO pending_book_restores(source_sha256, record_json, created_at)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(source_sha256) DO UPDATE SET record_json = excluded.record_json,
                            created_at = excluded.created_at",
                        params![
                            book.source_sha256,
                            serde_json::to_string(book)?,
                            now_millis()
                        ],
                    )?;
                    report.books_pending += 1;
                }
            }
        }
        Ok(report)
    }

    /// Before a book is deleted: keeps its records for when the same file is
    /// imported again, and its reading time in the totals. Returns whether
    /// the book had an original file to recognize it by.
    pub(crate) fn keep_records_for_reimport(&self, book_id: &str) -> Result<bool, AppError> {
        let source: Option<String> = self
            .conn
            .query_row(
                "SELECT t.source_sha256 FROM txt_assets t JOIN book_assets a ON a.id = t.asset_id
                 WHERE a.book_id = ?1 LIMIT 1",
                params![book_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten()
            .filter(|source: &String| !source.is_empty());
        let Some(source) = source else {
            return Ok(false);
        };
        let mut record = self.portable_book(&ShelfBook {
            book_id: book_id.into(),
            source_sha256: source.clone(),
        })?;
        record.local = true;
        self.conn.execute(
            "INSERT INTO pending_book_restores(source_sha256, record_json, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(source_sha256) DO UPDATE SET record_json = excluded.record_json,
                created_at = excluded.created_at",
            params![source, serde_json::to_string(&record)?, now_millis()],
        )?;
        self.retire_reading_time(book_id, &source)?;
        Ok(true)
    }

    /// Keeps a deleted book's reading time, and its title for 阅读记录,
    /// under `key` (the original file's hash, or an online book's name key).
    pub(crate) fn retire_reading_time(&self, book_id: &str, key: &str) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT INTO retired_reading_time(source_sha256, day, seconds)
             SELECT ?2, day, seconds FROM reading_time WHERE book_id = ?1
             ON CONFLICT(source_sha256, day) DO UPDATE SET
                seconds = MAX(retired_reading_time.seconds, excluded.seconds)",
            params![book_id, key],
        )?;
        self.conn.execute(
            "INSERT INTO retired_books(key, title, author, deleted_at)
             SELECT ?2, title, author, ?3 FROM books WHERE id = ?1
               AND EXISTS(SELECT 1 FROM reading_time WHERE book_id = ?1)
             ON CONFLICT(key) DO UPDATE SET title = excluded.title, author = excluded.author,
                deleted_at = excluded.deleted_at",
            params![book_id, key, now_millis()],
        )?;
        Ok(())
    }

    /// Applies records restored before this book was on the device.
    pub fn apply_pending_restore(&mut self, book_id: &str) -> Result<bool, AppError> {
        let source: Option<String> = self
            .conn
            .query_row(
                "SELECT t.source_sha256 FROM txt_assets t JOIN book_assets a ON a.id = t.asset_id
                 WHERE a.book_id = ?1 LIMIT 1",
                params![book_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let Some(source) = source else {
            return Ok(false);
        };
        let metadata: Option<String> = self
            .conn
            .query_row(
                "SELECT metadata_json FROM pending_book_metadata WHERE source_sha256 = ?1",
                params![source],
                |row| row.get(0),
            )
            .optional()?;
        let mut applied = false;
        if let Some(metadata) = metadata {
            let metadata: CloudMetadata = serde_json::from_str(&metadata)?;
            let title = metadata.title.trim();
            self.conn.execute(
                "UPDATE books SET title = CASE WHEN ?2 = '' THEN title ELSE ?2 END,
                    author = COALESCE(?3, author), intro = COALESCE(?4, intro) WHERE id = ?1",
                params![book_id, title, metadata.author, metadata.intro],
            )?;
            if let Some(cover) = &metadata.cover {
                self.apply_cover(book_id, cover)?;
            }
            self.conn.execute(
                "DELETE FROM pending_book_metadata WHERE source_sha256 = ?1",
                params![source],
            )?;
            applied = true;
        }
        let record: Option<String> = self
            .conn
            .query_row(
                "SELECT record_json FROM pending_book_restores WHERE source_sha256 = ?1",
                params![source],
                |row| row.get(0),
            )
            .optional()?;
        let Some(record) = record else {
            return Ok(applied);
        };
        let book: PortableBook = serde_json::from_str(&record)?;
        let parts = Parts::allowed(&self.stored_webdav()?, book.local);
        self.apply_portable_book(book_id, &book, parts)?;
        self.conn.execute(
            "DELETE FROM pending_book_restores WHERE source_sha256 = ?1",
            params![source],
        )?;
        // Its reading time is the book's own again.
        self.conn.execute(
            "DELETE FROM retired_reading_time WHERE source_sha256 = ?1",
            params![source],
        )?;
        self.conn
            .execute("DELETE FROM retired_books WHERE key = ?1", params![source])?;
        Ok(true)
    }

    /// Returns whether the position was restored and how many bookmarks were added.
    pub(super) fn apply_portable_book(
        &mut self,
        book_id: &str,
        book: &PortableBook,
        parts: Parts,
    ) -> Result<(bool, u32), AppError> {
        let Parts {
            info,
            progress,
            marks,
            time,
        } = parts;
        let title = book.title.trim();
        {
            let tx = self.conn.transaction()?;
            if info {
                tx.execute(
                    "UPDATE books SET title = CASE WHEN ?2 = '' THEN title ELSE ?2 END,
                        author = ?3, intro = COALESCE(?4, intro), use_replace_rules = ?5,
                        updated_at = ?6
                     WHERE id = ?1",
                    params![
                        book_id,
                        title,
                        book.author,
                        book.intro,
                        book.use_replace_rules,
                        now_millis()
                    ],
                )?;
                let group: Option<String> = match &book.group {
                    Some(name) => tx
                        .query_row(
                            "SELECT id FROM library_groups WHERE name = ?1",
                            params![name],
                            |row| row.get(0),
                        )
                        .optional()?,
                    None => None,
                };
                tx.execute(
                    "DELETE FROM book_groups WHERE book_id = ?1",
                    params![book_id],
                )?;
                if let Some(group) = &group {
                    tx.execute(
                        "INSERT INTO book_groups(book_id, group_id) VALUES (?1, ?2)",
                        params![book_id, group],
                    )?;
                }
                tx.execute(
                    "UPDATE books SET shelf_state = ?2 WHERE id = ?1",
                    params![
                        book_id,
                        if group.is_some() {
                            None
                        } else {
                            book.shelf_state.map(shelf_state_name)
                        }
                    ],
                )?;
            }
            if time {
                for (day, seconds) in &book.reading_time {
                    if seconds_valid_day(day) {
                        tx.execute(
                            "INSERT INTO reading_time(book_id, day, seconds) VALUES (?1, ?2, ?3)
                             ON CONFLICT(book_id, day) DO UPDATE SET
                                seconds = MAX(reading_time.seconds, excluded.seconds)",
                            params![book_id, day, (*seconds).min(86_400) as i64],
                        )?;
                    }
                }
            }
            tx.commit()?;
        }
        if info {
            let toc = BookTocSettings {
                rule_id: book.toc.rule_id.clone().filter(|id| {
                    self.conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM txt_toc_rules WHERE id = ?1)",
                            params![id],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap_or(false)
                }),
                split_long_chapters: book.toc.split_long_chapters,
            };
            if toc != self.book_toc_settings(book_id)?.0 {
                self.save_book_toc_settings(book_id, &toc)?;
            }
            if let Some(cover) = &book.cover {
                self.apply_cover(book_id, cover)?;
            }
        }
        if !progress && !marks {
            return Ok((false, 0));
        }

        let context = self.content_read_context(book_id)?;
        let verified = verify_content_context(&context)?;
        self.persist_content_index(&context, &verified)?;
        let mut text: Option<String> = None;
        let mut locate = |portable: &PortableLocator| -> Result<Option<ReaderLocator>, AppError> {
            let offset = if portable.content_version == context.record.asset.content_version {
                Some(portable.offset)
            } else {
                if text.is_none() {
                    text = Some(read_verified_text(&context, &verified)?);
                }
                text.as_deref().map(|text| relocate(text, portable))
            };
            let Some(offset) = offset else {
                return Ok(None);
            };
            let request = ResolveOffsetRequest {
                book_id: book_id.into(),
                content_version: context.record.asset.content_version.clone(),
                resource_id: context.record.asset.id.clone(),
                offset: offset.min(verified.index.utf16_length),
            };
            Ok(resolve_offset_from_context(&request, &context, &verified).ok())
        };

        let mut position_restored = false;
        if let Some(position) = book.position.as_ref().filter(|_| progress) {
            let local: Option<i64> = self
                .conn
                .query_row(
                    "SELECT updated_at FROM reading_positions WHERE book_id = ?1",
                    params![book_id],
                    |row| row.get(0),
                )
                .optional()?;
            if local.is_none_or(|local| book.position_updated_at > local) {
                if let Some(locator) = locate(position)? {
                    self.conn.execute(
                        "INSERT INTO reading_positions(book_id, locator_json, updated_at)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(book_id) DO UPDATE SET locator_json = excluded.locator_json,
                            updated_at = excluded.updated_at",
                        params![
                            book_id,
                            serde_json::to_string(&locator)?,
                            book.position_updated_at
                        ],
                    )?;
                    position_restored = true;
                }
            }
        }
        let mut added = 0;
        for bookmark in book.bookmarks.iter().filter(|_| marks) {
            let Some(locator) = locate(&bookmark.locator)? else {
                continue;
            };
            let exists: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM bookmarks WHERE book_id = ?1 AND content_version = ?2 AND offset = ?3)",
                params![book_id, locator.content_version, locator.offset as i64],
                |row| row.get(0),
            )?;
            if exists {
                continue;
            }
            self.conn.execute(
                "INSERT INTO bookmarks(id, book_id, content_version, offset, locator_json, excerpt, created_at, note)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    Uuid::new_v4().to_string(),
                    book_id,
                    locator.content_version,
                    locator.offset as i64,
                    serde_json::to_string(&locator)?,
                    bookmark.excerpt,
                    bookmark.created_at,
                    bookmark.note
                ],
            )?;
            added += 1;
        }
        Ok((position_restored, added))
    }

    /// Books whose records wait for the book to be imported.
    pub fn pending_restore_count(&self) -> Result<u32, AppError> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM pending_book_restores", [], |row| {
                row.get::<_, i64>(0)
            })? as u32)
    }

    /// The original bytes of a shelf book and the name it is uploaded under.
    pub fn book_source_file(&self, book_id: &str) -> Result<(PathBuf, String, String), AppError> {
        let (relative, source): (Option<String>, Option<String>) = self.conn.query_row(
            "SELECT t.source_relative_path, t.source_sha256 FROM txt_assets t
             JOIN book_assets a ON a.id = t.asset_id WHERE a.book_id = ?1 LIMIT 1",
            params![book_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (Some(relative), Some(source)) = (relative, source) else {
            return Err(AppError::new(
                ErrorCode::AssetMissing,
                "the original file of this book is not kept",
            ));
        };
        let path = managed_path(&self.root, &relative, "sources")?;
        if !path.is_file() {
            return Err(AppError::new(
                ErrorCode::AssetMissing,
                "the original file of this book is missing",
            ));
        }
        Ok((path, source, self.get_book(book_id)?.title))
    }

    /// Original-file hashes of the books on the shelf, by book.
    pub fn shelf_sources(&self) -> Result<Vec<(String, String)>, AppError> {
        Ok(self
            .shelf_books_with_sources()?
            .into_iter()
            .map(|book| (book.book_id, book.source_sha256))
            .collect())
    }
}

fn seconds_valid_day(day: &str) -> bool {
    day.len() == 10
        && day.bytes().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

/// The restored preferences: reading settings and the theme from the backup
/// where wanted, this device's otherwise, with this device's fonts and
/// background images.
pub(super) fn merge_preferences(
    current: &ReaderPreferences,
    backup: &ReaderPreferences,
    reading: bool,
    theme: bool,
) -> ReaderPreferences {
    let mut restored = if reading {
        backup.clone()
    } else {
        current.clone()
    };
    let source = if theme { backup } else { current };
    restored.theme = source.theme.clone();
    restored.paper_tone = source.paper_tone.clone();
    restored.oled_black = source.oled_black;
    if reading {
        keep_device_assets(&mut restored, current);
    }
    restored
}

/// Fonts and background images are files on one device; a backup names none.
pub(super) fn strip_device_assets(preferences: &mut ReaderPreferences) {
    preferences.style.font_asset_id = None;
    for preset in &mut preferences.style.presets {
        preset.background_image = None;
        preset.night_background_image = None;
    }
}

/// Restored preferences keep this device's font and the background images
/// of presets that are still in the same place.
fn keep_device_assets(restored: &mut ReaderPreferences, current: &ReaderPreferences) {
    restored.style.font_asset_id = current.style.font_asset_id.clone();
    for (index, preset) in restored.style.presets.iter_mut().enumerate() {
        let local = current.style.presets.get(index);
        preset.background_image = local.and_then(|preset| preset.background_image.clone());
        preset.night_background_image =
            local.and_then(|preset| preset.night_background_image.clone());
    }
}

/// Finds a position in `text` (another rendering of the same book) from its
/// surrounding context, preferring the match nearest its proportional place,
/// and falls back to that proportional place at a line start. Returns a
/// UTF-16 offset.
pub(crate) fn relocate(text: &str, locator: &PortableLocator) -> u64 {
    let total: u64 = text.encode_utf16().count() as u64;
    let expected = if locator.total_length > 0 {
        (locator.offset as f64 / locator.total_length as f64 * total as f64) as u64
    } else {
        locator.offset.min(total)
    };
    let before: String = {
        let chars: Vec<char> = locator.context_before.chars().collect();
        chars[chars.len().saturating_sub(NEEDLE_CHARS)..]
            .iter()
            .collect()
    };
    let after: String = locator.context_after.chars().take(NEEDLE_CHARS).collect();
    let utf16_at = |byte: usize| text[..byte].encode_utf16().count() as u64;
    let nearest = |needle: &str, shift: usize| -> Option<u64> {
        if needle.chars().count() < 4 {
            return None;
        }
        text.match_indices(needle)
            .map(|(byte, _)| utf16_at(byte + shift))
            .min_by_key(|offset| offset.abs_diff(expected))
    };
    let joined = format!("{before}{after}");
    nearest(&joined, before.len())
        .or_else(|| nearest(&after, 0))
        .or_else(|| nearest(&before, before.len()))
        .unwrap_or_else(|| {
            // The line start at or before the proportional place.
            let mut units = 0_u64;
            let mut line = 0_u64;
            for character in text.chars() {
                if units >= expected {
                    break;
                }
                units += character.len_utf16() as u64;
                if character == '\n' {
                    line = units;
                }
            }
            line
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator(offset: u64, total: u64, before: &str, after: &str) -> PortableLocator {
        PortableLocator {
            content_version: "other".into(),
            offset,
            total_length: total,
            context_before: before.into(),
            context_after: after.into(),
        }
    }

    #[test]
    fn positions_are_found_again_by_context() {
        let text = "第一章\n山门前的石阶。\n第二章\n云海翻涌，钟声敲在心上。\n第三章\n云海翻涌，钟声敲在心上。";
        // The second repetition is chosen by its proportional place.
        let found = relocate(text, &locator(40, 42, "第三章\n", "云海翻涌，钟声敲在心上"));
        assert_eq!(
            &text.encode_utf16().collect::<Vec<_>>()[found as usize..][..4],
            "云海翻涌".encode_utf16().collect::<Vec<_>>()
        );
        assert!(found > 20);
        // Only the text after survives an edit before the position.
        let edited = "第一章\n山门前的石阶覆着霜。\n第二章\n云海翻涌，钟声敲在心上。";
        let found = relocate(edited, &locator(17, 30, "改过的前文", "云海翻涌，钟声"));
        assert_eq!(
            found,
            edited
                .find("云海")
                .map(|byte| edited[..byte].encode_utf16().count() as u64)
                .unwrap()
        );
        // Without any context the proportional place snaps to a line start.
        let found = relocate(edited, &locator(15, 30, "", ""));
        assert!(edited.encode_utf16().nth(found as usize - 1) == Some('\n' as u16));
    }

    #[test]
    fn backups_reject_other_files_and_newer_formats() {
        assert!(parse_backup(b"{}").is_err());
        assert!(parse_backup(br#"{"format":"other","version":1,"createdAt":1}"#).is_err());
        assert!(
            parse_backup(br#"{"format":"gripread-backup","version":99,"createdAt":1}"#).is_err()
        );
        let parsed =
            parse_backup(br#"{"format":"gripread-backup","version":1,"createdAt":5}"#).unwrap();
        assert_eq!(parsed.created_at, 5);
        assert!(parsed.books.is_empty());
    }

    #[test]
    fn day_keys_are_checked() {
        assert!(seconds_valid_day("2026-10-11"));
        assert!(!seconds_valid_day("2026-1-11"));
        assert!(!seconds_valid_day("'; DROP"));
    }
}
