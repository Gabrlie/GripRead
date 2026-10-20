//! 数据管理: what the app's data folder holds, by part, and clearing the
//! parts that are caches. Clearing never touches books on the shelf unless
//! their own part is chosen.

use super::*;
use crate::models::{DataPart, DataUsage, ShelfBookCache};

/// Parts cleared by default and by 退出时清理缓存.
pub const DEFAULT_CLEARED: &[&str] = &["unshelved", "covers", "requests", "rss-images", "logs"];

fn folder_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => folder_size(&path),
                Ok(_) => entry.metadata().map(|meta| meta.len()).unwrap_or(0),
                Err(_) => 0,
            }
        })
        .sum()
}

impl Storage {
    /// Online books split by whether they are on the shelf: (id, title, on shelf).
    fn online_books_by_shelf(&self) -> Result<Vec<(String, String, bool)>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT o.book_id, b.title, o.on_shelf FROM online_books o
             JOIN books b ON b.id = o.book_id ORDER BY b.title",
        )?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn data_usage(&self) -> Result<DataUsage, AppError> {
        let size = |folders: &[&str]| -> u64 {
            folders
                .iter()
                .map(|folder| folder_size(&self.root.join(folder)))
                .sum()
        };
        let mut shelved = 0;
        let mut unshelved = 0;
        let mut books = Vec::new();
        for (id, title, on_shelf) in self.online_books_by_shelf()? {
            let bytes = folder_size(&self.online_cache_dir(&id));
            if on_shelf {
                shelved += bytes;
                books.push(ShelfBookCache {
                    book_id: id.clone(),
                    title,
                    bytes,
                    cached_chapters: self.cached_online_chapters(&id)?.len() as u32,
                    total_chapters: self.online_chapter_count(&id)?,
                });
            } else {
                unshelved += bytes;
            }
        }
        let requests: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(COALESCE(info_json, '')) + LENGTH(COALESCE(toc_json, ''))), 0)
             FROM online_book_cache",
            [],
            |row| row.get(0),
        )?;
        let database: u64 = fs::read_dir(&self.root)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| {
                        entry
                            .file_name()
                            .to_str()
                            .is_some_and(|name| name.starts_with("gripread.sqlite3"))
                    })
                    .map(|entry| entry.metadata().map(|meta| meta.len()).unwrap_or(0))
                    .sum()
            })
            .unwrap_or(0);
        let part = |key: &str, label: &str, bytes: u64, clearable: bool| DataPart {
            key: key.into(),
            label: label.into(),
            bytes,
            clearable,
        };
        Ok(DataUsage {
            parts: vec![
                part("unshelved", "未加入书架的网络书籍", unshelved, true),
                part("shelved", "书架书籍的章节缓存", shelved, true),
                part(
                    "covers",
                    "封面缓存",
                    size(&["online-covers", "cloud-covers"]),
                    true,
                ),
                part(
                    "requests",
                    "书源详情与目录缓存",
                    requests.max(0) as u64,
                    true,
                ),
                part("rss-articles", "订阅文章", self.rss_article_bytes()?, true),
                part("rss-images", "订阅文章图片", size(&["rss-images"]), true),
                part("logs", "日志", size(&["logs"]), true),
                part(
                    "translations",
                    "翻译缓存",
                    self.translation_cache_bytes()?,
                    true,
                ),
                part("books", "本地书籍", size(&["books", "sources"]), false),
                part("assets", "封面、字体与背景", size(&["assets"]), false),
                part("backups", "恢复点", size(&["backups"]), false),
                part("database", "数据库", database, false),
            ],
            books,
        })
    }

    /// Clears the chosen parts; returns the online books whose chapter
    /// caches went, so the reader can forget their texts.
    pub fn clear_data(&mut self, parts: &[String]) -> Result<Vec<String>, AppError> {
        let wants = |key: &str| parts.iter().any(|part| part == key);
        let mut cleared = Vec::new();
        for (id, _, on_shelf) in self.online_books_by_shelf()? {
            if (on_shelf && wants("shelved")) || (!on_shelf && wants("unshelved")) {
                self.clear_online_cache(&id)?;
                cleared.push(id);
            }
        }
        if wants("covers") {
            for folder in ["online-covers", "cloud-covers"] {
                match fs::remove_dir_all(self.root.join(folder)) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            self.conn.execute("DELETE FROM online_cover_cache", [])?;
        }
        if wants("rss-articles") {
            self.clear_rss_articles()?;
        }
        if wants("rss-images") {
            match fs::remove_dir_all(self.rss_image_cache()) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if wants("requests") {
            self.conn.execute("DELETE FROM online_book_cache", [])?;
        }
        if wants("logs") {
            crate::app_log::clear();
        }
        if wants("translations") {
            self.clear_translation_cache()?;
        }
        Ok(cleared)
    }
}
