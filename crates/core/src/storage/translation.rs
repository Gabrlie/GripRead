//! Book translation's stored state: each book's language and the language it
//! is read in, and the cache of translated lines shared by all books.

use super::*;

/// Where a local book's text before translation comes from: its retained
/// source, the encoding, the transform without its translation, and how far
/// the reader is (0–1).
pub struct TranslationSource {
    path: PathBuf,
    encoding: crate::models::TxtEncoding,
    transform: crate::transform::TextTransform,
    pub reached: f64,
}

impl TranslationSource {
    /// The book's lines as translations are made from them (read and decoded
    /// outside the storage lock).
    pub fn lines(&self) -> Result<Vec<String>, AppError> {
        let bytes = fs::read(&self.path)?;
        let decoded = crate::txt::decode_source(&bytes, self.encoding.clone())?;
        let text = crate::transform::apply(&decoded.text, &self.transform).0;
        Ok(text.split('\n').map(str::to_string).collect())
    }
}

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

    /// A local book's text before translation; books without their source
    /// bytes (some EPUB conversions) cannot be translated.
    pub fn translation_source(&self, book_id: &str) -> Result<TranslationSource, AppError> {
        let snapshot = self.snapshot_txt_decode(book_id).map_err(|_| {
            AppError::keyed(
                ErrorCode::InvalidArgument,
                "noSourceToTranslate",
                "这本书没有保留原始文件，无法翻译",
            )
        })?;
        let total = self
            .library_book(book_id)
            .ok()
            .and_then(|book| book.total_length)
            .unwrap_or(0);
        let reached = match (self.saved_position(book_id)?, total) {
            (Some(position), total) if total > 0 => position.offset as f64 / total as f64,
            _ => 0.0,
        };
        Ok(TranslationSource {
            path: managed_path(&self.root, &snapshot.source_relative_path, "sources")?,
            encoding: snapshot.selected_encoding,
            transform: snapshot.target.untranslated(),
            reached: reached.clamp(0.0, 1.0),
        })
    }

    /// The snapshot of translations a local book reads, if any.
    pub fn book_snapshot(&self, book_id: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT snapshot FROM book_translation WHERE book_id = ?1",
                params![book_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    }

    pub fn set_book_snapshot(&self, book_id: &str, snapshot: Option<&str>) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT INTO book_translation(book_id, snapshot) VALUES (?1, ?2)
             ON CONFLICT(book_id) DO UPDATE SET snapshot = excluded.snapshot",
            params![book_id, snapshot],
        )?;
        Ok(())
    }

    /// Removes snapshot files that neither a book nor any book's current
    /// text names any more.
    pub fn prune_snapshots(&self) -> Result<(), AppError> {
        let folder = self.root.join("translations");
        let Ok(entries) = fs::read_dir(&folder) else {
            return Ok(());
        };
        let mut named: std::collections::HashSet<String> = self
            .conn
            .prepare("SELECT snapshot FROM book_translation WHERE snapshot IS NOT NULL")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let applied: Vec<String> = self
            .conn
            .prepare("SELECT transform_json FROM txt_assets WHERE transform_json IS NOT NULL")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        named.extend(applied.iter().filter_map(|json| {
            crate::transform::TextTransform::from_stored(Some(json))
                .translation
                .map(|spec| spec.snapshot)
        }));
        for entry in entries.flatten() {
            let path = entry.path();
            let digest = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default();
            let is_snapshot = path
                .extension()
                .is_some_and(|extension| extension == "json");
            if is_snapshot && !named.contains(digest) {
                let _ = fs::remove_file(&path);
            }
        }
        Ok(())
    }

    /// The translation a local book's text carries now: while it is
    /// translated and a snapshot exists, in the display of 设置 › 翻译.
    pub(crate) fn translation_spec(
        &self,
        book_id: &str,
    ) -> Result<Option<crate::transform::TranslationSpec>, AppError> {
        let (_, target) = self.book_translation(book_id)?;
        if target.is_none() {
            return Ok(None);
        }
        let Some(snapshot) = self.book_snapshot(book_id)? else {
            return Ok(None);
        };
        let settings = crate::translation::load_settings(&self.root);
        Ok(Some(crate::transform::TranslationSpec {
            snapshot,
            bilingual: settings.display == crate::models::TranslationDisplay::Bilingual,
        }))
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
