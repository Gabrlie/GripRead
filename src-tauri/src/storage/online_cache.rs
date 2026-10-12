//! Kept copies of what sources return, so pages show at once and the
//! network is asked again only when a copy is old: cover images on disk by
//! source and address (kept until the cache is cleared; a failure is retried
//! after an hour), and a book's details and contents by source and book
//! address.

use super::*;

/// A failed cover is not asked for again sooner than this.
const COVER_RETRY_MS: i64 = 3_600_000;

pub fn cover_key(source_url: &str, url: &str) -> String {
    sha256_bytes(format!("{source_url}\n{url}").as_bytes())
}

pub fn book_cache_key(source_url: &str, book_url: &str) -> String {
    format!("book:{source_url}\n{book_url}")
}

/// What the cover cache knows of an image.
pub enum CachedCover {
    /// The image file.
    Kept(PathBuf),
    /// It failed less than an hour ago.
    RecentlyFailed,
    Unknown,
}

impl Storage {
    pub fn cached_cover(&self, key: &str) -> Result<CachedCover, AppError> {
        let row: Option<(Option<String>, Option<i64>)> = self
            .conn
            .query_row(
                "SELECT relative_path, failed_at FROM online_cover_cache WHERE key = ?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((Some(relative), _)) if self.root.join(&relative).is_file() => {
                CachedCover::Kept(self.root.join(relative))
            }
            Some((_, Some(failed))) if now_millis() - failed < COVER_RETRY_MS => {
                CachedCover::RecentlyFailed
            }
            _ => CachedCover::Unknown,
        })
    }

    /// Keeps a fetched cover image and returns its path.
    pub fn keep_cover(&self, key: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
        let relative = format!("online-covers/{key}");
        let path = self.root.join(&relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let partial = path.with_extension("part");
        fs::write(&partial, bytes)?;
        fs::rename(&partial, &path)?;
        self.conn.execute(
            "INSERT INTO online_cover_cache(key, relative_path, failed_at) VALUES (?1, ?2, NULL)
             ON CONFLICT(key) DO UPDATE SET relative_path = excluded.relative_path, failed_at = NULL",
            params![key, relative],
        )?;
        Ok(path)
    }

    pub fn record_cover_failure(&self, key: &str) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT INTO online_cover_cache(key, relative_path, failed_at) VALUES (?1, NULL, ?2)
             ON CONFLICT(key) DO UPDATE SET failed_at = excluded.failed_at",
            params![key, now_millis()],
        )?;
        Ok(())
    }

    /// A kept copy of `part` (`info` or `toc`) younger than `max_age_ms`,
    /// or any age when `max_age_ms` is `None`.
    pub fn cached_book_part(
        &self,
        key: &str,
        part: &str,
        max_age_ms: Option<i64>,
    ) -> Result<Option<String>, AppError> {
        let column = if part == "toc" {
            "toc_json"
        } else {
            "info_json"
        };
        let row: Option<(Option<String>, i64)> = self
            .conn
            .query_row(
                &format!("SELECT {column}, fetched_at FROM online_book_cache WHERE key = ?1"),
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(row.and_then(|(json, fetched)| {
            let fresh = max_age_ms.is_none_or(|age| now_millis() - fetched < age);
            json.filter(|_| fresh)
        }))
    }

    pub fn keep_book_part(&self, key: &str, part: &str, json: &str) -> Result<(), AppError> {
        let column = if part == "toc" {
            "toc_json"
        } else {
            "info_json"
        };
        self.conn.execute(
            &format!(
                "INSERT INTO online_book_cache(key, {column}, fetched_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET {column} = excluded.{column},
                    fetched_at = excluded.fetched_at"
            ),
            params![key, json, now_millis()],
        )?;
        // Keep the table from growing without bound.
        self.conn.execute(
            "DELETE FROM online_book_cache WHERE fetched_at < ?1",
            params![now_millis() - 30 * 24 * 3_600_000],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_and_book_pages_are_kept() {
        let dir = std::env::temp_dir().join(format!("gripread-cache-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir).unwrap();
        let key = cover_key("a", "https://a.com/c.jpg");
        assert!(matches!(
            storage.cached_cover(&key).unwrap(),
            CachedCover::Unknown
        ));
        storage.record_cover_failure(&key).unwrap();
        assert!(matches!(
            storage.cached_cover(&key).unwrap(),
            CachedCover::RecentlyFailed
        ));
        storage.keep_cover(&key, b"jpeg").unwrap();
        match storage.cached_cover(&key).unwrap() {
            CachedCover::Kept(path) => assert_eq!(fs::read(path).unwrap(), b"jpeg"),
            _ => panic!("the cover is kept"),
        }
        let book = book_cache_key("a", "https://a.com/b/1");
        storage.keep_book_part(&book, "info", "{}").unwrap();
        assert_eq!(
            storage
                .cached_book_part(&book, "info", Some(60_000))
                .unwrap()
                .as_deref(),
            Some("{}")
        );
        assert_eq!(storage.cached_book_part(&book, "toc", None).unwrap(), None);
        storage
            .conn
            .execute("UPDATE online_book_cache SET fetched_at = 0", [])
            .unwrap();
        assert_eq!(
            storage
                .cached_book_part(&book, "info", Some(60_000))
                .unwrap(),
            None
        );
        assert!(storage
            .cached_book_part(&book, "info", None)
            .unwrap()
            .is_some());
        let _ = fs::remove_dir_all(dir);
    }
}
