//! Online books: a `books` row with its source details, the chapter list,
//! and chapter texts kept under `online/<book id>/`. A chapter's text is
//! stored as the source gave it; replace rules and 简繁 apply when it is
//! read, so changing them never re-downloads anything.

use super::*;
use crate::models::{OnlineBook, OnlineChapter, OnlineShelfInfo};

/// The reader resource of chapter `index`.
pub fn chapter_resource(index: u32) -> String {
    format!("chapter-{index}")
}

/// The chapter a reader resource names.
pub fn resource_chapter(resource_id: &str) -> Option<u32> {
    resource_id.strip_prefix("chapter-")?.parse().ok()
}

/// An online book as stored, with what reading and updating need.
#[derive(Debug, Clone)]
pub struct OnlineRecord {
    pub book_id: String,
    pub title: String,
    pub book: OnlineBook,
    pub on_shelf: bool,
    pub can_update: bool,
}

fn chapter_file_name(chapter: &OnlineChapter) -> String {
    format!(
        "{:05}-{}.txt",
        chapter.index,
        crate::sources::js::crypto::md5_hex(chapter.title.as_bytes())
    )
}

impl Storage {
    pub fn is_online_book(&self, book_id: &str) -> Result<bool, AppError> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM online_books WHERE book_id = ?1)",
            params![book_id],
            |row| row.get(0),
        )?)
    }

    /// Adds an online book with its contents, or refreshes the one already
    /// kept for the same source and address. Returns its book id.
    pub fn add_online_book(
        &mut self,
        book: &OnlineBook,
        chapters: &[OnlineChapter],
        on_shelf: bool,
    ) -> Result<String, AppError> {
        if book.source_url.trim().is_empty() || book.book_url.trim().is_empty() {
            return Err(AppError::invalid_argument("网络书籍缺少书源或地址"));
        }
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT book_id FROM online_books WHERE source_url = ?1 AND book_url = ?2",
                params![book.source_url, book.book_url],
                |row| row.get(0),
            )
            .optional()?;
        let now = now_millis();
        let tx = self.conn.transaction()?;
        let book_id = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE books SET title = ?2, author = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id, book.name, nonempty(&book.author), now],
                )?;
                if on_shelf {
                    tx.execute(
                        "UPDATE online_books SET on_shelf = 1 WHERE book_id = ?1",
                        params![id],
                    )?;
                }
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO books(id, title, author, content_version, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'online', ?4, ?4)",
                    params![id, book.name, nonempty(&book.author), now],
                )?;
                tx.execute(
                    "INSERT INTO online_books(book_id, source_url, book_json, on_shelf,
                        can_update, total_chapters, new_chapters, created_at)
                     VALUES (?1, ?2, ?3, ?4, 1, 0, 0, ?5)",
                    params![
                        id,
                        book.source_url,
                        serde_json::to_string(book)?,
                        on_shelf,
                        now
                    ],
                )?;
                id
            }
        };
        store_book_json(&tx, &book_id, book)?;
        if !chapters.is_empty() {
            store_chapters(&tx, &book_id, chapters)?;
        }
        tx.commit()?;
        Ok(book_id)
    }

    /// The shelf's online book with this name and author, which Legado treats
    /// as the same book whatever its source.
    pub fn find_online_book(&self, name: &str, author: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT b.id FROM books b JOIN online_books o ON o.book_id = b.id
                 WHERE o.on_shelf = 1 AND b.title = ?1 AND COALESCE(b.author, '') = ?2
                 ORDER BY b.updated_at DESC LIMIT 1",
                params![name.trim(), author.trim()],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn online_record(&self, book_id: &str) -> Result<OnlineRecord, AppError> {
        self.conn
            .query_row(
                "SELECT b.title, o.book_json, o.on_shelf, o.can_update
                 FROM online_books o JOIN books b ON b.id = o.book_id WHERE o.book_id = ?1",
                params![book_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                        row.get::<_, bool>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "网络书籍不存在"))
            .and_then(|(title, json, on_shelf, can_update)| {
                Ok(OnlineRecord {
                    book_id: book_id.to_string(),
                    title,
                    book: serde_json::from_str(&json)?,
                    on_shelf,
                    can_update,
                })
            })
    }

    pub fn online_chapters(&self, book_id: &str) -> Result<Vec<OnlineChapter>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT idx, title, url, base_url, is_volume, is_vip, is_pay, tag, variables
             FROM online_chapters WHERE book_id = ?1 ORDER BY idx",
        )?;
        let rows = statement
            .query_map(params![book_id], chapter_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn online_chapter(
        &self,
        book_id: &str,
        index: u32,
    ) -> Result<Option<OnlineChapter>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT idx, title, url, base_url, is_volume, is_vip, is_pay, tag, variables
                 FROM online_chapters WHERE book_id = ?1 AND idx = ?2",
                params![book_id, index],
                chapter_from_row,
            )
            .optional()?)
    }

    pub fn online_chapter_count(&self, book_id: &str) -> Result<u32, AppError> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM online_chapters WHERE book_id = ?1",
            params![book_id],
            |row| row.get(0),
        )?)
    }

    /// Replaces the contents after 更新目录 and records how many chapters it
    /// added. Cached texts of chapters that kept their position and title
    /// stay valid, since their file names derive from both.
    pub fn replace_online_toc(
        &mut self,
        book_id: &str,
        book: &OnlineBook,
        chapters: &[OnlineChapter],
    ) -> Result<u32, AppError> {
        let before = self.online_chapter_count(book_id)?;
        let tx = self.conn.transaction()?;
        store_book_json(&tx, book_id, book)?;
        store_chapters(&tx, book_id, chapters)?;
        let added = (chapters.len() as u32).saturating_sub(before);
        tx.execute(
            "UPDATE online_books SET new_chapters = CASE WHEN ?2 > 0 THEN ?2 ELSE new_chapters END,
                last_check_time = ?3, update_error = NULL WHERE book_id = ?1",
            params![book_id, added, now_millis()],
        )?;
        tx.commit()?;
        Ok(added)
    }

    pub fn record_online_update_error(&self, book_id: &str, error: &str) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE online_books SET update_error = ?2, last_check_time = ?3 WHERE book_id = ?1",
            params![book_id, error, now_millis()],
        )?;
        Ok(())
    }

    /// Opening a book clears its new-chapter mark, as Legado does.
    pub fn clear_online_new_chapters(&self, book_id: &str) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE online_books SET new_chapters = 0 WHERE book_id = ?1",
            params![book_id],
        )?;
        Ok(())
    }

    pub fn set_online_on_shelf(&self, book_id: &str, on: bool) -> Result<(), AppError> {
        self.online_record(book_id)?;
        self.conn.execute(
            "UPDATE online_books SET on_shelf = ?2 WHERE book_id = ?1",
            params![book_id, on],
        )?;
        Ok(())
    }

    pub fn set_online_can_update(&self, book_id: &str, on: bool) -> Result<(), AppError> {
        self.online_record(book_id)?;
        self.conn.execute(
            "UPDATE online_books SET can_update = ?2 WHERE book_id = ?1",
            params![book_id, on],
        )?;
        Ok(())
    }

    /// Shelf books 更新目录 covers: on the shelf, allowed to update.
    pub fn updatable_online_books(&self) -> Result<Vec<String>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT o.book_id FROM online_books o
             LEFT JOIN shelf_removals r ON r.book_id = o.book_id
             WHERE o.on_shelf = 1 AND o.can_update = 1 AND r.book_id IS NULL
             ORDER BY o.created_at",
        )?;
        let rows = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(rows)
    }

    pub fn online_cache_dir(&self, book_id: &str) -> PathBuf {
        self.root.join("online").join(book_id)
    }

    /// Where a chapter's text is kept, whether or not it is there yet.
    pub fn online_chapter_path(&self, book_id: &str, chapter: &OnlineChapter) -> PathBuf {
        self.online_cache_dir(book_id)
            .join(chapter_file_name(chapter))
    }

    /// The cached chapter positions, from the files present.
    pub fn cached_online_chapters(&self, book_id: &str) -> Result<HashSet<u32>, AppError> {
        let mut cached = HashSet::new();
        let chapters = self.online_chapters(book_id)?;
        let dir = self.online_cache_dir(book_id);
        let names: HashSet<String> = match fs::read_dir(&dir) {
            Ok(entries) => entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect(),
            Err(_) => return Ok(cached),
        };
        for chapter in chapters {
            if names.contains(&chapter_file_name(&chapter)) {
                cached.insert(chapter.index);
            }
        }
        Ok(cached)
    }

    pub fn clear_online_cache(&self, book_id: &str) -> Result<(), AppError> {
        let dir = self.online_cache_dir(book_id);
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Deletes an online book with its cached chapters, as Legado's 删除.
    pub fn delete_online_book(&mut self, book_id: &str) -> Result<(), AppError> {
        self.online_record(book_id)?;
        let cover = self.book_cover(book_id)?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM books WHERE id = ?1", params![book_id])?;
        tx.commit()?;
        self.clear_online_cache(book_id)?;
        if let Some(cover) = cover {
            self.delete_reader_asset(&cover)?;
        }
        Ok(())
    }

    /// Books read from search but never added are dropped when the reader
    /// leaves them, unless they are on the shelf by then.
    pub fn drop_unshelved_online_book(&mut self, book_id: &str) -> Result<bool, AppError> {
        let record = self.online_record(book_id)?;
        if record.on_shelf {
            return Ok(false);
        }
        self.delete_online_book(book_id)?;
        Ok(true)
    }

    pub(crate) fn online_shelf_info(
        &self,
        book_id: &str,
        locator: Option<&ReaderLocator>,
    ) -> Result<Option<OnlineShelfInfo>, AppError> {
        let row: Option<ShelfRow> = self
            .conn
            .query_row(
                "SELECT book_json, new_chapters, last_check_time, update_error, can_update,
                        on_shelf FROM online_books WHERE book_id = ?1",
                params![book_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((json, new_chapters, last_check_time, update_error, can_update, on_shelf)) = row
        else {
            return Ok(None);
        };
        let read_chapter = locator.and_then(|locator| resource_chapter(&locator.resource_id));
        let read_chapter_title = match read_chapter {
            Some(index) => self
                .online_chapter(book_id, index)?
                .map(|chapter| chapter.title)
                .unwrap_or_default(),
            None => String::new(),
        };
        Ok(Some(OnlineShelfInfo {
            book: serde_json::from_str(&json)?,
            total_chapters: self.online_chapter_count(book_id)?,
            new_chapters,
            last_check_time,
            update_error,
            can_update,
            on_shelf,
            read_chapter,
            read_chapter_title,
            cached_chapters: self.cached_online_chapters(book_id)?.len() as u32,
        }))
    }
}

/// `online_books` columns the shelf shows: details JSON, new chapters, last
/// check, update error, 允许更新, and on the shelf.
type ShelfRow = (String, u32, Option<i64>, Option<String>, bool, bool);

fn nonempty(text: &str) -> Option<&str> {
    let text = text.trim();
    (!text.is_empty()).then_some(text)
}

fn store_book_json(
    tx: &rusqlite::Transaction<'_>,
    book_id: &str,
    book: &OnlineBook,
) -> Result<(), AppError> {
    tx.execute(
        "UPDATE online_books SET source_url = ?2, book_url = ?3, book_json = ?4 WHERE book_id = ?1",
        params![
            book_id,
            book.source_url,
            book.book_url,
            serde_json::to_string(book)?
        ],
    )?;
    Ok(())
}

fn store_chapters(
    tx: &rusqlite::Transaction<'_>,
    book_id: &str,
    chapters: &[OnlineChapter],
) -> Result<(), AppError> {
    tx.execute(
        "DELETE FROM online_chapters WHERE book_id = ?1",
        params![book_id],
    )?;
    let mut insert = tx.prepare(
        "INSERT INTO online_chapters(book_id, idx, title, url, base_url, is_volume, is_vip,
            is_pay, tag, variables) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for (index, chapter) in chapters.iter().enumerate() {
        insert.execute(params![
            book_id,
            index as u32,
            chapter.title,
            chapter.url,
            chapter.base_url,
            chapter.is_volume,
            chapter.is_vip,
            chapter.is_pay,
            chapter.tag,
            chapter.variables,
        ])?;
    }
    tx.execute(
        "UPDATE online_books SET total_chapters = ?2 WHERE book_id = ?1",
        params![book_id, chapters.len() as u32],
    )?;
    Ok(())
}

fn chapter_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OnlineChapter> {
    Ok(OnlineChapter {
        index: row.get(0)?,
        title: row.get(1)?,
        url: row.get(2)?,
        base_url: row.get(3)?,
        is_volume: row.get(4)?,
        is_vip: row.get(5)?,
        is_pay: row.get(6)?,
        tag: row.get(7)?,
        variables: row.get(8)?,
    })
}
