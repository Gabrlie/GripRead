//! Saving a fully cached online book as a local TXT book.

use super::*;

/// A few characters around `offset` of `units`, to find the place again.
fn context(units: &[u16], offset: usize) -> (String, String) {
    let start = offset.saturating_sub(24);
    let end = (offset + 24).min(units.len());
    (
        String::from_utf16_lossy(&units[start..offset]),
        String::from_utf16_lossy(&units[offset..end]),
    )
}

impl Storage {
    /// 转为本地书籍: every chapter as one TXT imported like any other, then
    /// the position, bookmarks, reading time, group, state, and cover move to
    /// it and the online book goes. `texts` are the chapters' cached texts,
    /// in order.
    pub fn convert_online_to_local(
        &mut self,
        book_id: &str,
        texts: &[String],
    ) -> Result<String, AppError> {
        let record = self.online_record(book_id)?;
        let chapters = self.online_chapters(book_id)?;
        if chapters.is_empty() || texts.len() != chapters.len() {
            return Err(AppError::invalid_argument("章节还没有全部缓存"));
        }
        // Chapter starts in the written text, in UTF-16 units.
        let mut text = String::new();
        let mut starts = Vec::with_capacity(chapters.len());
        for (chapter, body) in chapters.iter().zip(texts) {
            starts.push(text.encode_utf16().count());
            text.push_str(chapter.title.trim());
            text.push('\n');
            let body = body.trim_matches('\n');
            if !body.is_empty() {
                text.push_str(body);
                text.push('\n');
            }
        }
        let units: Vec<u16> = text.encode_utf16().collect();
        let author = record.book.author.trim();
        let name = format!(
            "{}{}.txt",
            record.title.replace(['/', '\\', ':'], " "),
            if author.is_empty() {
                String::new()
            } else {
                format!(" 作者：{author}")
            }
        );
        let staging = self.root.join("staging-convert");
        fs::create_dir_all(&staging)?;
        let path = staging.join(name);
        fs::write(&path, text.as_bytes())?;
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let imported = self.import_txt(&path, &Uuid::new_v4().to_string(), &cancel, |_, _, _| {});
        let _ = fs::remove_file(&path);
        let imported = imported?;
        let local = imported.book.id.clone();
        let total = units.len() as u64;
        // A chapter position becomes the same place in the TXT, found again
        // by its context in case replace rules changed the text on import.
        let place = |index: u32, offset: u64| -> PortableLocator {
            let start = starts.get(index as usize).copied().unwrap_or(0);
            let at = (start + offset as usize).min(units.len());
            let (before, after) = context(&units, at);
            PortableLocator {
                content_version: String::new(),
                offset: at as u64,
                total_length: total,
                context_before: before,
                context_after: after,
            }
        };
        if let Some(position) = self.online_position(book_id)? {
            if let Some(locator) =
                self.locator_from_portable(&local, &place(position.index, position.offset))?
            {
                self.save_position_record(&locator)?;
            }
        }
        for bookmark in self.list_bookmarks(book_id)? {
            let Some(index) = resource_chapter(&bookmark.locator.resource_id) else {
                continue;
            };
            if let Some(locator) =
                self.locator_from_portable(&local, &place(index, bookmark.locator.offset))?
            {
                let _ = self.insert_bookmark(&crate::models::BookmarkRequest {
                    book_id: local.clone(),
                    locator,
                    excerpt: bookmark.excerpt,
                    note: Some(bookmark.note),
                });
            }
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO reading_time(book_id, day, seconds)
             SELECT ?2, day, seconds FROM reading_time WHERE book_id = ?1
             ON CONFLICT(book_id, day) DO UPDATE SET seconds = reading_time.seconds + excluded.seconds",
            params![book_id, local],
        )?;
        tx.execute(
            "DELETE FROM reading_time WHERE book_id = ?1",
            params![book_id],
        )?;
        tx.execute(
            "UPDATE book_groups SET book_id = ?2 WHERE book_id = ?1",
            params![book_id, local],
        )?;
        // The cover moves to the new book instead of being deleted with the old.
        tx.execute(
            "UPDATE books SET shelf_state = (SELECT shelf_state FROM books WHERE id = ?1),
                cover_asset_id = COALESCE(cover_asset_id, (SELECT cover_asset_id FROM books WHERE id = ?1)),
                author = COALESCE(NULLIF(author, ''), (SELECT author FROM books WHERE id = ?1)),
                intro = COALESCE(intro, ?3)
             WHERE id = ?2",
            params![book_id, local, record.book.intro],
        )?;
        tx.execute(
            "UPDATE books SET cover_asset_id = NULL WHERE id = ?1",
            params![book_id],
        )?;
        tx.commit()?;
        self.delete_online_book(book_id)?;
        Ok(local)
    }
}
