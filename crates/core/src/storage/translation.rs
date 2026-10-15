//! Book translation's stored state: each book's language and the language it
//! is read in, and the cache of translated lines shared by all books.

use super::*;

/// One cached translation: the hash of a source line, the target language,
/// and the engine that made it (kind, model, prompt).
pub struct CachedLine {
    pub source_hash: String,
    pub text: String,
}

impl Storage {
    /// The book's own language (detected or chosen) and the language it is
    /// read in, if translated.
    pub fn book_translation(
        &self,
        book_id: &str,
    ) -> Result<(Option<String>, Option<String>), AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT language, translate_to FROM book_translation WHERE book_id = ?1",
                params![book_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None)))
    }

    pub fn set_book_language(&self, book_id: &str, language: Option<&str>) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT INTO book_translation(book_id, language) VALUES (?1, ?2)
             ON CONFLICT(book_id) DO UPDATE SET language = excluded.language",
            params![book_id, language],
        )?;
        Ok(())
    }

    pub fn set_book_translate_to(
        &self,
        book_id: &str,
        target: Option<&str>,
    ) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT INTO book_translation(book_id, translate_to) VALUES (?1, ?2)
             ON CONFLICT(book_id) DO UPDATE SET translate_to = excluded.translate_to",
            params![book_id, target],
        )?;
        Ok(())
    }

    /// The beginning of a local book's text, to detect its language.
    pub fn local_text_sample(&self, book_id: &str) -> Result<Option<String>, AppError> {
        let Ok(record) = self.asset_for_book(book_id) else {
            return Ok(None);
        };
        let path = managed_path(&self.root, &record.relative_path, "books")?;
        let mut bytes = vec![0; 16 * 1024];
        let read = {
            use std::io::Read;
            let mut file = fs::File::open(path)?;
            file.read(&mut bytes)?
        };
        bytes.truncate(read);
        Ok(Some(String::from_utf8_lossy(&bytes).to_string()))
    }

    /// The cached translations of these source hashes.
    pub fn cached_translations(
        &self,
        hashes: &[String],
        target: &str,
        engine: &str,
    ) -> Result<HashMap<String, String>, AppError> {
        let mut found = HashMap::new();
        let mut statement = self.conn.prepare_cached(
            "SELECT text FROM translations WHERE source_hash = ?1 AND target = ?2 AND engine = ?3",
        )?;
        for hash in hashes {
            if found.contains_key(hash) {
                continue;
            }
            if let Some(text) = statement
                .query_row(params![hash, target, engine], |row| row.get::<_, String>(0))
                .optional()?
            {
                found.insert(hash.clone(), text);
            }
        }
        Ok(found)
    }

    pub fn store_translations(
        &mut self,
        lines: &[CachedLine],
        target: &str,
        engine: &str,
    ) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        {
            let mut statement = tx.prepare_cached(
                "INSERT OR REPLACE INTO translations(source_hash, target, engine, text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            let now = now_millis();
            for line in lines {
                statement.execute(params![line.source_hash, target, engine, line.text, now])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The translation cache's size in bytes, for 数据管理.
    pub fn translation_cache_bytes(&self) -> Result<u64, AppError> {
        Ok(self.conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(text) + LENGTH(source_hash)), 0) FROM translations",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64)
    }

    pub fn clear_translation_cache(&self) -> Result<(), AppError> {
        self.conn.execute("DELETE FROM translations", [])?;
        Ok(())
    }
}
