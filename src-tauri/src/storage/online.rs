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

/// Stable while the chapter keeps its address and title; a changed
/// transform only moves offsets slightly, which positions tolerate.
pub fn chapter_version(book_id: &str, chapter: &OnlineChapter) -> String {
    let mut hasher = sha2::Sha256::new();
    sha2::Digest::update(&mut hasher, book_id.as_bytes());
    sha2::Digest::update(&mut hasher, [0]);
    sha2::Digest::update(&mut hasher, chapter.url.as_bytes());
    sha2::Digest::update(&mut hasher, [0]);
    sha2::Digest::update(&mut hasher, chapter.title.as_bytes());
    let digest = sha2::Digest::finalize(hasher);
    format!("online-{}", hex::encode(&digest[..8]))
}

/// An online book's identity across sources and devices: its name and
/// author, as Legado matches books.
pub fn online_key(name: &str, author: &str) -> String {
    format!(
        "online-{}",
        sha256_bytes(format!("online\n{}\n{}", name.trim(), author.trim()).as_bytes())
    )
}

/// A position in an online book that does not depend on its source: the
/// chapter's place and title, and the offset in it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChapterPosition {
    pub index: u32,
    pub title: String,
    pub offset: u64,
    /// Chapters the contents had, for placing the position proportionally.
    #[serde(default)]
    pub count: u32,
}

/// A bookmark by chapter position, kept until the contents are known.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingBookmark {
    pub position: ChapterPosition,
    pub excerpt: String,
    #[serde(default)]
    pub note: String,
    pub created_at: i64,
}

/// Legado's `BookHelp.getChapterNum`: the number in 第…章/节/回/卷, in
/// Arabic or Chinese numerals; 0 when there is none.
fn chapter_number(title: &str) -> i64 {
    let chars: Vec<char> = title.chars().collect();
    let Some(start) = chars.iter().position(|c| *c == '第') else {
        return 0;
    };
    let digits: String = chars[start + 1..]
        .iter()
        .take_while(|c| !matches!(c, '章' | '节' | '回' | '卷' | '集' | '话' | '部' | '篇'))
        .collect();
    let digits = digits.trim();
    if digits.is_empty() {
        return 0;
    }
    if let Ok(number) = digits.parse::<i64>() {
        return number;
    }
    chinese_number(digits).unwrap_or(0)
}

fn chinese_number(text: &str) -> Option<i64> {
    let digit = |c: char| -> Option<i64> {
        Some(match c {
            '零' | '〇' => 0,
            '一' | '壹' => 1,
            '二' | '两' | '贰' => 2,
            '三' | '叁' => 3,
            '四' | '肆' => 4,
            '五' | '伍' => 5,
            '六' | '陆' => 6,
            '七' | '柒' => 7,
            '八' | '捌' => 8,
            '九' | '玖' => 9,
            '0'..='9' => c.to_digit(10)? as i64,
            _ => return None,
        })
    };
    let (mut total, mut section, mut number) = (0i64, 0i64, 0i64);
    let mut seen = false;
    for c in text.chars() {
        if let Some(value) = digit(c) {
            number = number * 10 + value;
            seen = true;
            continue;
        }
        let unit = match c {
            '十' | '拾' => 10,
            '百' | '佰' => 100,
            '千' | '仟' => 1000,
            '万' => 10_000,
            '亿' => 100_000_000,
            _ => return None,
        };
        seen = true;
        if unit >= 10_000 {
            total = (total + section + number) * unit;
            section = 0;
        } else {
            section += number.max(1) * unit;
        }
        number = 0;
    }
    seen.then_some(total + section + number)
}

/// Legado's `getPureChapterName`: the title without its 第…章 prefix,
/// brackets, and punctuation, for comparing chapters across sources.
fn pure_title(title: &str) -> String {
    let mut text = title.to_string();
    if let Some(start) = text.find('第') {
        if let Some(end) = text[start..]
            .find(['章', '节', '回', '卷', '集', '话'])
            .map(|end| start + end)
        {
            let unit_len = text[end..].chars().next().map_or(0, char::len_utf8);
            text = format!("{}{}", &text[..start], &text[end + unit_len..]);
        }
    }
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

fn jaro_winkler(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let window = (a.len().max(b.len()) / 2).saturating_sub(1);
    let mut a_match = vec![false; a.len()];
    let mut b_match = vec![false; b.len()];
    let mut matches = 0usize;
    for i in 0..a.len() {
        let low = i.saturating_sub(window);
        let high = (i + window + 1).min(b.len());
        for j in low..high {
            if !b_match[j] && a[i] == b[j] {
                a_match[i] = true;
                b_match[j] = true;
                matches += 1;
                break;
            }
        }
    }
    if matches == 0 {
        return 0.0;
    }
    let (mut transpositions, mut k) = (0usize, 0usize);
    for i in 0..a.len() {
        if !a_match[i] {
            continue;
        }
        while !b_match[k] {
            k += 1;
        }
        if a[i] != b[k] {
            transpositions += 1;
        }
        k += 1;
    }
    let m = matches as f64;
    let jaro =
        (m / a.len() as f64 + m / b.len() as f64 + (m - transpositions as f64 / 2.0) / m) / 3.0;
    let prefix = a.iter().zip(&b).take(4).take_while(|(x, y)| x == y).count() as f64;
    jaro + prefix * 0.1 * (1.0 - jaro)
}

/// Legado's `getDurChapter`: the chapter of `chapters` that matches the
/// one at `index` titled `title` in a list of `count`, looking ten either
/// side of the same place for the closest title, then the same number.
/// Returns it and whether the match is certain; an uncertain match keeps
/// the old place.
pub fn map_chapter(index: u32, title: &str, count: u32, chapters: &[OnlineChapter]) -> (u32, bool) {
    if chapters.is_empty() {
        return (index, false);
    }
    let size = chapters.len() as u32;
    let last = size - 1;
    if index == 0 && count <= 1 {
        return (0, true);
    }
    let scaled = if count == 0 {
        index
    } else {
        ((index as u64 * size as u64) / count.max(1) as u64) as u32
    };
    let low = index.min(scaled).saturating_sub(10) as usize;
    let high = (index.max(scaled) + 10).min(last) as usize;
    let old_pure = pure_title(title);
    let (mut best, mut similarity) = (index.min(last) as usize, 0.0f64);
    if !old_pure.is_empty() {
        for (offset, chapter) in chapters[low..=high].iter().enumerate() {
            let score = jaro_winkler(&old_pure, &pure_title(&chapter.title));
            if score > similarity {
                similarity = score;
                best = low + offset;
            }
        }
    }
    if similarity >= 0.96 {
        return (best as u32, true);
    }
    let old_number = chapter_number(title);
    if old_number > 0 {
        let mut closest: Option<(usize, i64)> = None;
        for (offset, chapter) in chapters[low..=high].iter().enumerate() {
            let number = chapter_number(&chapter.title);
            let distance = (number - old_number).abs();
            if closest.is_none_or(|(_, best)| distance < best) {
                closest = Some((low + offset, distance));
            }
            if distance == 0 {
                break;
            }
        }
        if let Some((found, 0)) = closest {
            return (found as u32, true);
        }
    }
    (index.min(last), false)
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

/// The chapter files kept for each book, read once and kept current.
fn cached_files() -> &'static std::sync::Mutex<HashMap<String, HashSet<String>>> {
    static FILES: std::sync::OnceLock<std::sync::Mutex<HashMap<String, HashSet<String>>>> =
        std::sync::OnceLock::new();
    FILES.get_or_init(Default::default)
}

/// Records a chapter written to the cache.
pub fn mark_chapter_cached(book_id: &str, chapter: &OnlineChapter) {
    if let Ok(mut map) = cached_files().lock() {
        if let Some(names) = map.get_mut(book_id) {
            names.insert(chapter_file_name(chapter));
        }
    }
}

pub fn forget_cached_chapters(book_id: &str) {
    if let Ok(mut map) = cached_files().lock() {
        map.remove(book_id);
    }
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

    /// The kept online book with this name and author, which Legado treats
    /// as the same book whatever its source: the shelf's copy first, else one
    /// read from search without adding it.
    pub fn find_online_book(&self, name: &str, author: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT b.id FROM books b JOIN online_books o ON o.book_id = b.id
                 WHERE b.title = ?1 AND COALESCE(b.author, '') = ?2
                 ORDER BY o.on_shelf DESC, b.updated_at DESC LIMIT 1",
                params![name.trim(), author.trim()],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// The saved position as a source-independent chapter position.
    pub fn online_position(&self, book_id: &str) -> Result<Option<ChapterPosition>, AppError> {
        let Some(locator) = self.saved_position(book_id)? else {
            return self.pending_online_position(book_id);
        };
        let Some(index) = resource_chapter(&locator.resource_id) else {
            return Ok(None);
        };
        let title = self
            .online_chapter(book_id, index)?
            .map(|chapter| chapter.title)
            .unwrap_or_default();
        Ok(Some(ChapterPosition {
            index,
            title,
            offset: locator.offset,
            count: self.online_chapter_count(book_id)?,
        }))
    }

    pub fn pending_online_position(
        &self,
        book_id: &str,
    ) -> Result<Option<ChapterPosition>, AppError> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT pending_position FROM online_books WHERE book_id = ?1",
                params![book_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(json.and_then(|json| serde_json::from_str(&json).ok()))
    }

    /// Keeps a position until the book's contents are known (after a
    /// restore, before the first fetch).
    pub fn set_pending_online_position(
        &self,
        book_id: &str,
        position: Option<&ChapterPosition>,
    ) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE online_books SET pending_position = ?2 WHERE book_id = ?1",
            params![book_id, position.map(serde_json::to_string).transpose()?],
        )?;
        Ok(())
    }

    /// The locator for a chapter position in the contents as they are now,
    /// with whether the chapter was matched with certainty.
    pub fn locate_online_position(
        &self,
        book_id: &str,
        position: &ChapterPosition,
    ) -> Result<Option<(ReaderLocator, bool)>, AppError> {
        let chapters = self.online_chapters(book_id)?;
        if chapters.is_empty() {
            return Ok(None);
        }
        let (index, certain) =
            map_chapter(position.index, &position.title, position.count, &chapters);
        let chapter = &chapters[index as usize];
        Ok(Some((
            ReaderLocator {
                book_id: book_id.to_string(),
                content_version: chapter_version(book_id, chapter),
                resource_id: chapter_resource(index),
                offset: if index == position.index || certain {
                    position.offset
                } else {
                    0
                },
                context_before: String::new(),
                context_after: String::new(),
            },
            certain,
        )))
    }

    /// Bookmarks restored before the contents are known.
    pub fn add_pending_online_bookmarks(
        &self,
        book_id: &str,
        bookmarks: &[PendingBookmark],
    ) -> Result<(), AppError> {
        let mut kept = self.pending_online_bookmarks(book_id)?;
        for bookmark in bookmarks {
            if !kept.contains(bookmark) {
                kept.push(bookmark.clone());
            }
        }
        self.conn.execute(
            "UPDATE online_books SET pending_bookmarks = ?2 WHERE book_id = ?1",
            params![
                book_id,
                (!kept.is_empty())
                    .then(|| serde_json::to_string(&kept))
                    .transpose()?
            ],
        )?;
        Ok(())
    }

    fn pending_online_bookmarks(&self, book_id: &str) -> Result<Vec<PendingBookmark>, AppError> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT pending_bookmarks FROM online_books WHERE book_id = ?1",
                params![book_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(json
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default())
    }

    /// Places a pending position and bookmarks once the contents are known.
    /// Returns how many bookmarks were added.
    pub fn settle_pending_online_position(&self, book_id: &str) -> Result<u32, AppError> {
        if self.online_chapter_count(book_id)? == 0 {
            return Ok(0);
        }
        if let Some(position) = self.pending_online_position(book_id)? {
            if let Some((locator, _)) = self.locate_online_position(book_id, &position)? {
                self.save_position_record(&locator)?;
                self.set_pending_online_position(book_id, None)?;
            }
        }
        let mut added = 0;
        for bookmark in self.pending_online_bookmarks(book_id)? {
            if let Some((locator, _)) = self.locate_online_position(book_id, &bookmark.position)? {
                self.insert_bookmark(&crate::models::BookmarkRequest {
                    book_id: book_id.to_string(),
                    locator,
                    excerpt: bookmark.excerpt.clone(),
                    note: Some(bookmark.note.clone()),
                })?;
                added += 1;
            }
        }
        self.conn.execute(
            "UPDATE online_books SET pending_bookmarks = NULL WHERE book_id = ?1",
            params![book_id],
        )?;
        Ok(added)
    }

    /// 换源: the book keeps its identity, shelf place, and records; its
    /// details and contents come from the new source, the cached chapters
    /// go, and the position and bookmarks move to the matching chapters.
    /// Returns the chapter the position moved to and whether that match is
    /// certain.
    pub fn switch_online_source(
        &mut self,
        book_id: &str,
        book: &OnlineBook,
        chapters: &[OnlineChapter],
    ) -> Result<Option<(u32, bool)>, AppError> {
        self.online_record(book_id)?;
        if chapters.is_empty() {
            return Err(AppError::invalid_argument("新书源的目录为空"));
        }
        let position = self.online_position(book_id)?;
        let old_chapters = self.online_chapters(book_id)?;
        let old_count = old_chapters.len() as u32;
        let bookmarks = self.list_bookmarks(book_id)?;
        let tx = self.conn.transaction()?;
        store_book_json(&tx, book_id, book)?;
        store_chapters(&tx, book_id, chapters)?;
        tx.execute(
            "UPDATE online_books SET new_chapters = 0, update_error = NULL, last_check_time = ?2
             WHERE book_id = ?1",
            params![book_id, now_millis()],
        )?;
        tx.execute(
            "UPDATE books SET title = ?2, author = COALESCE(NULLIF(?3, ''), author), updated_at = ?4
             WHERE id = ?1",
            params![book_id, book.name, book.author, now_millis()],
        )?;
        tx.commit()?;
        self.clear_online_cache(book_id)?;
        for bookmark in bookmarks {
            let Some(index) = resource_chapter(&bookmark.locator.resource_id) else {
                continue;
            };
            let title = old_chapters
                .get(index as usize)
                .map(|chapter| chapter.title.clone())
                .unwrap_or_default();
            let mark = ChapterPosition {
                index,
                title,
                offset: bookmark.locator.offset,
                count: old_count,
            };
            if let Some((locator, _)) = self.locate_online_position(book_id, &mark)? {
                let moved = ReaderLocator {
                    context_before: bookmark.locator.context_before.clone(),
                    context_after: bookmark.locator.context_after.clone(),
                    ..locator.clone()
                };
                self.conn.execute(
                    "UPDATE OR IGNORE bookmarks SET content_version = ?2, offset = ?3, locator_json = ?4
                     WHERE id = ?1",
                    params![
                        bookmark.id,
                        locator.content_version,
                        locator.offset as i64,
                        serde_json::to_string(&moved)?
                    ],
                )?;
            }
        }
        let Some(position) = position else {
            return Ok(None);
        };
        let Some((locator, certain)) = self.locate_online_position(book_id, &position)? else {
            return Ok(None);
        };
        let index = resource_chapter(&locator.resource_id).unwrap_or(0);
        self.save_position_record(&locator)?;
        self.set_pending_online_position(book_id, None)?;
        Ok(Some((index, certain)))
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
        let position = self.online_position(book_id)?;
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
        self.settle_pending_online_position(book_id)?;
        // Legado maps the position again when the contents change around it.
        if let Some(position) = position {
            let moved = chapters
                .get(position.index as usize)
                .is_none_or(|chapter| chapter.title != position.title);
            if moved || self.saved_position(book_id)?.is_none() {
                if let Some((locator, _)) = self.locate_online_position(book_id, &position)? {
                    self.save_position_record(&locator)?;
                    self.set_pending_online_position(book_id, None)?;
                }
            }
        }
        Ok(added)
    }

    pub fn record_online_update_error(&self, book_id: &str, error: &str) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE online_books SET update_error = ?2, last_check_time = ?3 WHERE book_id = ?1",
            params![book_id, error, now_millis()],
        )?;
        Ok(())
    }

    /// Opening a book clears its new-chapter mark, as Legado does, and
    /// keeps a book read off the shelf for another 30 days.
    pub fn clear_online_new_chapters(&self, book_id: &str) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE online_books SET new_chapters = 0, last_opened_at = ?2 WHERE book_id = ?1",
            params![book_id, now_millis()],
        )?;
        Ok(())
    }

    /// Deletes books read from search but not added that were not opened
    /// for 30 days. Returns how many went.
    pub fn purge_unshelved_online_books(&mut self) -> Result<u32, AppError> {
        let cutoff = now_millis() - 30 * 24 * 3_600_000;
        let ids: Vec<String> = {
            let mut statement = self.conn.prepare(
                "SELECT book_id FROM online_books
                 WHERE on_shelf = 0 AND COALESCE(last_opened_at, created_at) < ?1",
            )?;
            let rows = statement
                .query_map(params![cutoff], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            rows
        };
        for id in &ids {
            self.delete_online_book(id)?;
        }
        Ok(ids.len() as u32)
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

    /// The cached chapter positions, from the files present. The folder is
    /// read once per book and session; writes keep the set current.
    pub fn cached_online_chapters(&self, book_id: &str) -> Result<HashSet<u32>, AppError> {
        let mut cached = HashSet::new();
        let names = {
            let known = cached_files()
                .lock()
                .ok()
                .and_then(|map| map.get(book_id).cloned());
            match known {
                Some(names) => names,
                None => {
                    let names: HashSet<String> = match fs::read_dir(self.online_cache_dir(book_id))
                    {
                        Ok(entries) => entries
                            .flatten()
                            .filter_map(|entry| entry.file_name().into_string().ok())
                            .filter(|name| name.ends_with(".txt"))
                            .collect(),
                        Err(_) => HashSet::new(),
                    };
                    if let Ok(mut map) = cached_files().lock() {
                        map.insert(book_id.to_string(), names.clone());
                    }
                    names
                }
            }
        };
        if names.is_empty() {
            return Ok(cached);
        }
        let chapters = self.online_chapters(book_id)?;
        for chapter in chapters {
            if names.contains(&chapter_file_name(&chapter)) {
                cached.insert(chapter.index);
            }
        }
        Ok(cached)
    }

    pub fn clear_online_cache(&self, book_id: &str) -> Result<(), AppError> {
        forget_cached_chapters(book_id);
        let dir = self.online_cache_dir(book_id);
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Deletes an online book with its cached chapters, as Legado's 删除.
    pub fn delete_online_book(&mut self, book_id: &str) -> Result<(), AppError> {
        let record = self.online_record(book_id)?;
        // 阅读记录 keeps its time under the name key progress sync uses.
        self.retire_reading_time(book_id, &online_key(&record.title, &record.book.author))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn storage() -> (Dir, Storage) {
        let dir = Dir(std::env::temp_dir().join(format!("gripread-online-{}", Uuid::new_v4())));
        fs::create_dir_all(&dir.0).unwrap();
        let storage = Storage::open(&dir.0).unwrap();
        (dir, storage)
    }

    fn chapters(titles: &[&str], site: &str) -> Vec<OnlineChapter> {
        titles
            .iter()
            .enumerate()
            .map(|(index, title)| OnlineChapter {
                index: index as u32,
                title: title.to_string(),
                url: format!("{site}/{index}.html"),
                base_url: site.to_string(),
                is_volume: false,
                is_vip: false,
                is_pay: false,
                tag: String::new(),
                variables: String::new(),
            })
            .collect()
    }

    fn book(site: &str) -> OnlineBook {
        OnlineBook {
            source_url: site.into(),
            source_name: site.into(),
            name: "剑来".into(),
            author: "烽火".into(),
            kind: String::new(),
            cover_url: String::new(),
            intro: String::new(),
            word_count: String::new(),
            latest_chapter_title: String::new(),
            book_url: format!("{site}/book/1"),
            toc_url: String::new(),
            variables: String::new(),
            reverse_toc: false,
        }
    }

    #[test]
    fn chapters_match_by_title_then_number_like_legado() {
        assert_eq!(chapter_number("第一百二十三章 雨"), 123);
        assert_eq!(chapter_number("第十章"), 10);
        assert_eq!(chapter_number("第2050章 终"), 2050);
        assert_eq!(pure_title("第十章 惊蛰（求月票）"), "惊蛰求月票");
        let other = chapters(
            &[
                "序章",
                "第1章 惊蛰",
                "第2章 开门",
                "第3章 春风",
                "第4章 远行",
            ],
            "b",
        );
        // The same title one place later in another source's contents.
        assert_eq!(map_chapter(2, "第三章 春风", 5, &other), (3, true));
        // A different title with the same number.
        assert_eq!(map_chapter(3, "第4章 下山", 5, &other), (4, true));
        // Nothing alike: keep the place, uncertain.
        assert_eq!(map_chapter(2, "番外 一", 5, &other), (2, false));
    }

    #[test]
    fn switching_sources_keeps_the_book_and_moves_its_records() {
        let (_dir, mut storage) = storage();
        let old = chapters(&["第1章 惊蛰", "第2章 开门", "第3章 春风"], "a");
        let id = storage.add_online_book(&book("a"), &old, true).unwrap();
        let at = |index: u32, offset: u64| ReaderLocator {
            book_id: id.clone(),
            content_version: chapter_version(&id, &old[index as usize]),
            resource_id: chapter_resource(index),
            offset,
            context_before: String::new(),
            context_after: String::new(),
        };
        storage.save_position_record(&at(2, 5)).unwrap();
        storage
            .insert_bookmark(&crate::models::BookmarkRequest {
                book_id: id.clone(),
                locator: at(1, 3),
                excerpt: "开门".into(),
                note: None,
            })
            .unwrap();
        let new = chapters(&["引子", "第一章 惊蛰", "第二章 开门", "第三章 春风"], "b");
        let moved = storage.switch_online_source(&id, &book("b"), &new).unwrap();
        assert_eq!(moved, Some((3, true)));
        let saved = storage.saved_position(&id).unwrap().unwrap();
        assert_eq!((saved.resource_id.as_str(), saved.offset), ("chapter-3", 5));
        assert_eq!(saved.content_version, chapter_version(&id, &new[3]));
        let bookmark = &storage.list_bookmarks(&id).unwrap()[0];
        assert_eq!(bookmark.locator.resource_id, "chapter-2");
        assert_eq!(storage.online_record(&id).unwrap().book.source_url, "b");
        assert_eq!(storage.online_chapter_count(&id).unwrap(), 4);
    }

    #[test]
    fn backups_carry_online_books_and_sources_by_chapter() {
        let (_dir, mut storage) = storage();
        storage
            .save_book_source(r#"{"bookSourceUrl":"a","bookSourceName":"甲"}"#, None)
            .unwrap();
        let toc = chapters(&["第1章 惊蛰", "第2章 开门"], "a");
        let id = storage.add_online_book(&book("a"), &toc, true).unwrap();
        storage
            .save_position_record(&ReaderLocator {
                book_id: id.clone(),
                content_version: chapter_version(&id, &toc[1]),
                resource_id: chapter_resource(1),
                offset: 7,
                context_before: String::new(),
                context_after: String::new(),
            })
            .unwrap();
        let backup = storage.export_backup("phone").unwrap();
        assert_eq!(backup.book_sources.len(), 1);
        assert_eq!(backup.online_books.len(), 1);
        assert_eq!(
            backup.online_books[0].position.as_ref().unwrap().title,
            "第2章 开门"
        );

        let (_other, mut fresh) = super::tests::storage();
        let report = fresh.restore_backup(&backup).unwrap();
        assert_eq!(
            (report.sources_restored, report.online_books_restored),
            (1, 1)
        );
        let shelf = fresh.list_library_books().unwrap();
        let restored = &shelf[0].book.id;
        assert!(shelf[0].online.is_some());
        // The contents are fetched later; the position waits for them.
        assert_eq!(fresh.saved_position(restored).unwrap(), None);
        assert!(fresh.pending_online_position(restored).unwrap().is_some());
        fresh
            .replace_online_toc(
                restored,
                &book("a"),
                &chapters(&["第1章 惊蛰", "第2章 开门"], "a"),
            )
            .unwrap();
        let saved = fresh.saved_position(restored).unwrap().unwrap();
        assert_eq!((saved.resource_id.as_str(), saved.offset), ("chapter-1", 7));
        assert!(fresh.pending_online_position(restored).unwrap().is_none());
    }

    #[test]
    fn deleted_books_stay_in_the_reading_records() {
        let (_dir, mut storage) = storage();
        let id = storage
            .add_online_book(&book("a"), &chapters(&["第1章"], "a"), true)
            .unwrap();
        storage.add_reading_time(&id, "2026-10-12", 600).unwrap();
        storage.delete_online_book(&id).unwrap();
        let stats = storage.reading_stats("2026-10-12").unwrap();
        assert_eq!(stats.total_seconds, 600);
        assert_eq!(stats.days.len(), 1);
        let record = &stats.books[0];
        assert!(record.deleted);
        assert_eq!(record.title, "剑来");
        assert_eq!(record.seconds, 600);
    }

    #[test]
    fn books_read_off_the_shelf_keep_their_place_for_30_days() {
        let (_dir, mut storage) = storage();
        let toc = chapters(&["第1章"], "a");
        let old = storage.add_online_book(&book("a"), &toc, false).unwrap();
        let mut other = book("b");
        other.name = "雪中".into();
        let fresh = storage.add_online_book(&other, &toc, false).unwrap();
        storage.clear_online_new_chapters(&fresh).unwrap();
        storage
            .conn
            .execute(
                "UPDATE online_books SET created_at = 0, last_opened_at = 0 WHERE book_id = ?1",
                params![old],
            )
            .unwrap();
        // Found again from search even though it is off the shelf.
        assert_eq!(
            storage.find_online_book("雪中", "烽火").unwrap(),
            Some(fresh.clone())
        );
        assert_eq!(storage.purge_unshelved_online_books().unwrap(), 1);
        assert!(storage.online_record(&old).is_err());
        assert!(storage.online_record(&fresh).is_ok());
    }

    #[test]
    fn reading_records_can_be_deleted_completely() {
        let (_dir, mut storage) = storage();
        let id = storage
            .add_online_book(&book("a"), &chapters(&["第1章"], "a"), true)
            .unwrap();
        storage.add_reading_time(&id, "2026-10-12", 600).unwrap();
        let other = storage
            .add_online_book(
                &{
                    let mut b = book("b");
                    b.name = "雪中".into();
                    b
                },
                &chapters(&["第1章"], "b"),
                true,
            )
            .unwrap();
        storage.add_reading_time(&other, "2026-10-12", 300).unwrap();
        storage.delete_online_book(&other).unwrap();
        assert_eq!(
            storage.reading_stats("2026-10-12").unwrap().total_seconds,
            900
        );
        storage.delete_reading_record(&id).unwrap();
        let retired = storage.reading_stats("2026-10-12").unwrap().books[0]
            .book_id
            .clone();
        storage.delete_reading_record(&retired).unwrap();
        let stats = storage.reading_stats("2026-10-12").unwrap();
        assert_eq!(stats.total_seconds, 0);
        assert!(stats.books.is_empty() && stats.days.is_empty());
    }
}
