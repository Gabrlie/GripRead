//! 订阅: RSS/Atom feeds and their articles. Articles are keyed by a hash of
//! the feed's first address (its `id_base`, which a new address keeps) and
//! the entry's identity, so a refresh updates what it already has and keeps
//! its read and starred state. Each feed keeps its newest `keep_articles`
//! articles, or those of the last `keep_days` days if that is more (its own
//! settings, or [`RssSettings`]'); starred articles stay until unstarred.

use super::*;
use crate::models::{
    Article, ArticleCursor, ArticleFilter, ArticlePage, ArticleQuery, ArticleSummary, Feed,
    FeedGroup, FeedOptions, RssSettings, UpdateFeedRequest,
};
use serde_json::Value;
use std::collections::HashSet;

pub const KEEP_ARTICLES: u32 = 500;
pub const KEEP_DAYS: u32 = 90;
/// The choices for how many days of articles are kept.
pub const KEEP_DAY_CHOICES: [u32; 4] = [30, 90, 180, 365];
/// The newest articles kept: at least this many, at most [`MAX_KEEP`];
/// 0 keeps every article.
pub const MIN_KEEP: u32 = 50;
pub const MAX_KEEP: u32 = 100_000;
/// Refresh intervals: off (0), or between these minutes.
pub const MIN_REFRESH: u32 = 5;
pub const MAX_REFRESH: u32 = 24 * 60;
const PAGE: u32 = 50;
const SETTINGS_FILE: &str = "rss.json";

/// A feed's stored fetch state, for conditional requests.
#[derive(Debug, Clone, Default)]
pub struct FeedFetchState {
    pub title: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    /// What its article ids are made from: its first address.
    pub id_base: String,
    pub enabled: bool,
    pub via_server: bool,
}

/// What one fetch of a feed found.
#[derive(Debug, Clone, Default)]
pub struct FetchedFeed {
    pub title: String,
    pub site_url: Option<String>,
    pub icon_url: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub articles: Vec<FetchedArticle>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FetchedArticle {
    pub id: String,
    pub title: String,
    pub link: Option<String>,
    pub author: Option<String>,
    pub published_at: i64,
    pub excerpt: String,
    pub image: Option<String>,
    /// Sanitized HTML.
    pub content: String,
}

/// An article id: the feed and the entry's own identity.
pub fn article_id(feed_url: &str, entry: &str) -> String {
    sha256_bytes(format!("{feed_url}\n{entry}").as_bytes())
}

fn summary_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArticleSummary> {
    Ok(ArticleSummary {
        id: row.get(0)?,
        feed_url: row.get(1)?,
        feed_title: row.get(2)?,
        title: row.get(3)?,
        link: row.get(4)?,
        author: row.get(5)?,
        published_at: row.get(6)?,
        excerpt: row.get(7)?,
        image: row.get(8)?,
        read: row.get(9)?,
        starred: row.get(10)?,
        keep_unread: row.get(11)?,
    })
}

const SUMMARY_COLUMNS: &str = "a.id, a.feed_url, COALESCE(f.title, a.feed_title), a.title, a.link,
    a.author, a.published_at, a.excerpt, a.image, a.read, a.starred, a.keep_unread";

const FEED_COLUMNS: &str = "f.url, f.title, f.site_url, f.icon_url, f.group_name, f.sort,
    f.added_at, f.last_fetch, f.last_error, COALESCE(c.unread, 0), COALESCE(c.total, 0),
    f.enabled, f.refresh_minutes, f.keep_articles, f.keep_days, f.full_text, f.via_server,
    f.keep_unread, f.account_id, f.address";

fn feed_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Feed> {
    Ok(Feed {
        url: row.get(0)?,
        title: row.get(1)?,
        site_url: row.get(2)?,
        icon_url: row.get(3)?,
        group: row.get(4)?,
        sort: row.get(5)?,
        added_at: row.get(6)?,
        last_fetch: row.get(7)?,
        last_error: row.get(8)?,
        unread: row.get(9)?,
        total: row.get(10)?,
        enabled: row.get(11)?,
        options: FeedOptions {
            refresh_minutes: row.get(12)?,
            keep_articles: row.get(13)?,
            keep_days: row.get(14)?,
            full_text: row.get(15)?,
            via_server: row.get(16)?,
            keep_unread: row.get(17)?,
        },
        account: row.get(18)?,
        address: row.get(19)?,
    })
}

fn invalid(key: &'static str, message: &str) -> AppError {
    AppError::keyed(ErrorCode::InvalidArgument, key, message.to_string())
}

/// A refresh interval as kept: off, or within its bounds.
fn refresh_minutes(minutes: u32) -> u32 {
    if minutes == 0 {
        0
    } else {
        minutes.clamp(MIN_REFRESH, MAX_REFRESH)
    }
}

/// How many of the newest articles are kept: all (0), or within bounds.
fn keep_articles(count: u32) -> u32 {
    if count == 0 {
        0
    } else {
        count.clamp(MIN_KEEP, MAX_KEEP)
    }
}

fn keep_days(days: u32) -> u32 {
    if KEEP_DAY_CHOICES.contains(&days) {
        days
    } else {
        KEEP_DAYS
    }
}

/// A feed's own settings as kept.
fn checked_options(options: &FeedOptions) -> FeedOptions {
    FeedOptions {
        refresh_minutes: options.refresh_minutes.map(refresh_minutes),
        keep_articles: options.keep_articles.map(keep_articles),
        keep_days: options.keep_days.map(keep_days),
        full_text: options.full_text,
        via_server: options.via_server,
        keep_unread: options.keep_unread,
    }
}

/// Image cache limits offered, in megabytes; 0 keeps every picture.
pub const IMAGE_CACHE_CHOICES: [u32; 4] = [100, 500, 1000, 0];
/// Article text indexed for search, in characters.
const SEARCH_BODY_CHARS: usize = 20_000;
/// Searches shorter than this (in characters) cannot use the index.
const SEARCH_MIN_CHARS: usize = 3;

/// What search finds an article by: its text without markup, cut short.
fn search_body(content: &str, full_text: Option<&str>, excerpt: &str) -> String {
    let html = full_text
        .filter(|text| !text.is_empty())
        .unwrap_or(if content.is_empty() { excerpt } else { content });
    let text = crate::rss::plain_text(html);
    match text.char_indices().nth(SEARCH_BODY_CHARS) {
        Some((end, _)) => text[..end].to_string(),
        None => text,
    }
}

/// Puts an article (again) into the search index.
pub(super) fn index_article(conn: &rusqlite::Connection, id: &str) -> Result<(), AppError> {
    type Indexed = (i64, String, Option<String>, String, Option<String>, String);
    let row: Option<Indexed> = conn
        .query_row(
            "SELECT rowid, title, author, content, full_text, excerpt FROM rss_articles
             WHERE id = ?1",
            params![id],
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
    let Some((rowid, title, author, content, full_text, excerpt)) = row else {
        return Ok(());
    };
    conn.execute("DELETE FROM rss_search WHERE rowid = ?1", params![rowid])?;
    conn.execute(
        "INSERT INTO rss_search(rowid, title, author, body) VALUES (?1, ?2, ?3, ?4)",
        params![
            rowid,
            title,
            author.unwrap_or_default(),
            search_body(&content, full_text.as_deref(), &excerpt)
        ],
    )?;
    Ok(())
}

/// Whether 过滤规则 let an article in.
pub(super) fn admitted(filters: &crate::rss::filter::FilterSet, article: &FetchedArticle) -> bool {
    let body = if filters.reads_body() {
        crate::rss::plain_text(if article.content.is_empty() {
            &article.excerpt
        } else {
            &article.content
        })
    } else {
        String::new()
    };
    filters.admits(&crate::rss::filter::ArticleText {
        title: &article.title,
        author: article.author.as_deref().unwrap_or_default(),
        body: &body,
    })
}

/// An RSSHub instance's address, without a trailing slash; the public one
/// when empty.
fn rsshub_instance(address: &str) -> String {
    let address = address.trim().trim_end_matches('/');
    if address.is_empty() {
        RssSettings::default().rsshub_instance
    } else if address.contains("://") {
        address.to_string()
    } else {
        format!("https://{address}")
    }
}

fn group_name(group: Option<&str>) -> Option<&str> {
    group.map(str::trim).filter(|group| !group.is_empty())
}

impl Storage {
    pub(super) fn create_rss_tables(tx: &rusqlite::Transaction<'_>) -> Result<(), AppError> {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS rss_feeds (
                url TEXT PRIMARY KEY NOT NULL,
                title TEXT NOT NULL,
                site_url TEXT,
                icon_url TEXT,
                group_name TEXT,
                sort INTEGER NOT NULL DEFAULT 0,
                added_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_fetch INTEGER,
                last_error TEXT,
                etag TEXT,
                last_modified TEXT,
                server_cursor INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS rss_articles (
                id TEXT PRIMARY KEY NOT NULL,
                feed_url TEXT NOT NULL,
                feed_title TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL,
                link TEXT,
                author TEXT,
                published_at INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL,
                excerpt TEXT NOT NULL DEFAULT '',
                image TEXT,
                content TEXT NOT NULL DEFAULT '',
                full_text TEXT,
                read INTEGER NOT NULL DEFAULT 0,
                read_at INTEGER,
                starred INTEGER NOT NULL DEFAULT 0,
                starred_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS rss_articles_feed ON rss_articles(feed_url, published_at);
             CREATE INDEX IF NOT EXISTS rss_articles_time ON rss_articles(published_at, id);",
        )?;
        Ok(())
    }

    /// Schema 30: each feed's own settings, ordered groups, and 保持未读.
    /// Columns already there (a database rolled back to an older schema
    /// keeps its tables) are left as they are.
    pub(super) fn upgrade_rss_tables(tx: &rusqlite::Transaction<'_>) -> Result<(), AppError> {
        let columns = [
            ("rss_feeds", "enabled", "INTEGER NOT NULL DEFAULT 1"),
            ("rss_feeds", "refresh_minutes", "INTEGER"),
            ("rss_feeds", "keep_articles", "INTEGER"),
            ("rss_feeds", "keep_days", "INTEGER"),
            ("rss_feeds", "full_text", "INTEGER"),
            ("rss_feeds", "via_server", "INTEGER NOT NULL DEFAULT 0"),
            ("rss_feeds", "id_base", "TEXT"),
            ("rss_articles", "keep_unread", "INTEGER NOT NULL DEFAULT 0"),
        ];
        for (table, column, kind) in columns {
            let present: bool = tx.query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1)"
                ),
                params![column],
                |row| row.get(0),
            )?;
            if !present {
                tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind}"))?;
            }
        }
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS rss_groups (
                name TEXT PRIMARY KEY NOT NULL,
                sort INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS rss_cleared (
                id TEXT PRIMARY KEY NOT NULL,
                cleared_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS rss_articles_unread ON rss_articles(feed_url, read);",
        )?;
        Ok(())
    }

    /// Schema 31: 过滤规则, 未读不清理 for each feed, and the search index
    /// (a trigram index, so text in any language is found inside words; it
    /// keeps the articles' rowids, which nothing renumbers). Articles
    /// already there are indexed now.
    pub(super) fn upgrade_rss_search(tx: &rusqlite::Transaction<'_>) -> Result<(), AppError> {
        let present: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('rss_feeds') WHERE name = 'keep_unread')",
            [],
            |row| row.get(0),
        )?;
        if !present {
            tx.execute_batch("ALTER TABLE rss_feeds ADD COLUMN keep_unread INTEGER")?;
        }
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS rss_filters (
                id TEXT PRIMARY KEY NOT NULL,
                scope TEXT NOT NULL,
                target TEXT,
                field TEXT NOT NULL,
                mode TEXT NOT NULL,
                pattern TEXT NOT NULL,
                ignore_case INTEGER NOT NULL DEFAULT 1,
                enabled INTEGER NOT NULL DEFAULT 1,
                sort INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS rss_search USING fts5(
                title, author, body, content='', contentless_delete=1, tokenize='trigram'
             );
             CREATE TRIGGER IF NOT EXISTS rss_articles_unindex AFTER DELETE ON rss_articles
             BEGIN
                DELETE FROM rss_search WHERE rowid = old.rowid;
             END;
             INSERT INTO rss_search(rss_search) VALUES ('delete-all');",
        )?;
        let ids: Vec<String> = tx
            .prepare("SELECT id FROM rss_articles")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        for id in ids {
            index_article(tx, &id)?;
        }
        Ok(())
    }

    pub fn rss_settings(&self) -> RssSettings {
        fs::read_to_string(self.root.join(SETTINGS_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save_rss_settings(&self, settings: &RssSettings) -> Result<RssSettings, AppError> {
        let settings = RssSettings {
            refresh_minutes: refresh_minutes(settings.refresh_minutes),
            font_size: settings.font_size.clamp(12, 32),
            keep_days: keep_days(settings.keep_days),
            keep_articles: keep_articles(settings.keep_articles),
            image_cache_mb: if IMAGE_CACHE_CHOICES.contains(&settings.image_cache_mb) {
                settings.image_cache_mb
            } else {
                RssSettings::default().image_cache_mb
            },
            rsshub_instance: rsshub_instance(&settings.rsshub_instance),
            rsshub_key: settings.rsshub_key.trim().to_string(),
            ..settings.clone()
        };
        fs::write(
            self.root.join(SETTINGS_FILE),
            serde_json::to_string_pretty(&settings)?,
        )?;
        Ok(settings)
    }

    pub fn list_feeds(&self) -> Result<Vec<Feed>, AppError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {FEED_COLUMNS} FROM rss_feeds f
             LEFT JOIN (SELECT feed_url, SUM(read = 0) AS unread, COUNT(*) AS total
                        FROM rss_articles GROUP BY feed_url) c ON c.feed_url = f.url
             ORDER BY f.sort, f.added_at, f.url"
        ))?;
        let feeds = statement
            .query_map([], feed_of)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(feeds)
    }

    pub fn feed_urls(&self) -> Result<Vec<String>, AppError> {
        let mut statement = self
            .conn
            .prepare("SELECT url FROM rss_feeds ORDER BY sort, added_at, url")?;
        let urls = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(urls)
    }

    /// The feeds a refresh fetches: of `urls` (every feed when empty), the
    /// enabled ones; with `due`, only those whose interval (their own, or
    /// `default_minutes`) has passed since they were last fetched.
    pub fn refresh_targets(
        &self,
        urls: &[String],
        due: bool,
        default_minutes: u32,
    ) -> Result<Vec<String>, AppError> {
        let now = now_millis();
        let mut statement = self.conn.prepare(
            "SELECT url, last_fetch, refresh_minutes FROM rss_feeds
             WHERE enabled = 1 AND account_id IS NULL ORDER BY sort, added_at, url",
        )?;
        let feeds = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<u32>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(feeds
            .into_iter()
            .filter(|(url, _, _)| urls.is_empty() || urls.contains(url))
            .filter(|(_, last, minutes)| {
                let minutes = minutes.unwrap_or(default_minutes);
                !due || (minutes > 0
                    && last.is_none_or(|last| now - last >= i64::from(minutes) * 60_000))
            })
            .map(|(url, _, _)| url)
            .collect())
    }

    pub fn feed_fetch_state(&self, url: &str) -> Result<Option<FeedFetchState>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT title, etag, last_modified, COALESCE(id_base, url), enabled, via_server
                 FROM rss_feeds WHERE url = ?1",
                params![url],
                |row| {
                    Ok(FeedFetchState {
                        title: row.get(0)?,
                        etag: row.get(1)?,
                        last_modified: row.get(2)?,
                        id_base: row.get(3)?,
                        enabled: row.get(4)?,
                        via_server: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// Subscribes to a feed; `false` when it was subscribed already (its
    /// title and group stay as they are).
    pub fn add_feed(
        &self,
        url: &str,
        title: &str,
        group: Option<&str>,
        site_url: Option<&str>,
    ) -> Result<bool, AppError> {
        let now = now_millis();
        let next_sort: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort), -1) + 1 FROM rss_feeds",
            [],
            |row| row.get(0),
        )?;
        let added = self.conn.execute(
            "INSERT OR IGNORE INTO rss_feeds(url, title, site_url, group_name, sort, added_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                url,
                title.trim(),
                site_url,
                group_name(group),
                next_sort,
                now
            ],
        )?;
        Ok(added > 0)
    }

    pub fn feed(&self, url: &str) -> Result<Feed, AppError> {
        self.list_feeds()?
            .into_iter()
            .find(|feed| feed.url == url)
            .ok_or_else(|| AppError::keyed(ErrorCode::NotFound, "rssNoFeed", "没有这个订阅"))
    }

    /// Changes a feed: its title and group, and what the request carries
    /// of its address, whether it is refreshed, and its own settings. A new
    /// address (checked to be a feed by the caller) keeps its articles.
    pub fn update_feed(&mut self, request: &UpdateFeedRequest) -> Result<(), AppError> {
        let title = request.title.trim();
        if title.is_empty() {
            return Err(invalid("rssFeedTitleEmpty", "订阅名称不能为空"));
        }
        let mut url = request.url.clone();
        let tx = self.conn.transaction()?;
        let on_account: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM rss_feeds WHERE url = ?1 AND account_id IS NOT NULL)",
            params![url],
            |row| row.get(0),
        )?;
        if let Some(new_url) = request
            .new_url
            .as_deref()
            .map(str::trim)
            .filter(|new_url| *new_url != url && !on_account)
        {
            move_feed(&tx, &url, new_url)?;
            url = new_url.to_string();
        }
        let changed = tx.execute(
            "UPDATE rss_feeds SET title = ?2, group_name = ?3, updated_at = ?4 WHERE url = ?1",
            params![
                url,
                title,
                group_name(request.group.as_deref()),
                now_millis()
            ],
        )?;
        if changed == 0 {
            return Err(AppError::keyed(
                ErrorCode::NotFound,
                "rssNoFeed",
                "没有这个订阅",
            ));
        }
        if let Some(enabled) = request.enabled {
            tx.execute(
                "UPDATE rss_feeds SET enabled = ?2 WHERE url = ?1",
                params![url, enabled],
            )?;
        }
        if let Some(options) = &request.options {
            set_options(&tx, &url, &checked_options(options))?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Unsubscribes; starred articles stay, under the feed's last title.
    pub fn remove_feeds(&mut self, urls: &[String]) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        for url in urls {
            tx.execute(
                "UPDATE rss_articles SET feed_title = COALESCE(
                    (SELECT title FROM rss_feeds WHERE url = ?1), feed_title)
                 WHERE feed_url = ?1 AND starred = 1",
                params![url],
            )?;
            tx.execute(
                "DELETE FROM rss_articles WHERE feed_url = ?1 AND starred = 0",
                params![url],
            )?;
            tx.execute("DELETE FROM rss_feeds WHERE url = ?1", params![url])?;
            tx.execute(
                "DELETE FROM rss_filters WHERE scope = 'feed' AND target = ?1",
                params![url],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_feed_error(&self, url: &str, error: &str) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE rss_feeds SET last_fetch = ?2, last_error = ?3 WHERE url = ?1",
            params![url, now_millis(), error],
        )?;
        Ok(())
    }

    /// The feed had not changed (HTTP 304).
    pub fn record_feed_unchanged(&self, url: &str) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE rss_feeds SET last_fetch = ?2, last_error = NULL WHERE url = ?1",
            params![url, now_millis()],
        )?;
        Ok(())
    }

    /// Stores what a fetch found and returns how many articles are new.
    /// Known articles take the feed's newer text and keep their state.
    pub fn store_feed_fetch(&mut self, url: &str, fetched: &FetchedFeed) -> Result<u32, AppError> {
        let now = now_millis();
        let settings = self.rss_settings();
        let tx = self.conn.transaction()?;
        type Kept = (String, Option<u32>, Option<u32>, Option<bool>);
        let feed: Option<Kept> = tx
            .query_row(
                "SELECT title, keep_articles, keep_days, keep_unread FROM rss_feeds WHERE url = ?1",
                params![url],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((feed_title, keep_count, days, keep_unread)) = feed else {
            return Err(AppError::keyed(
                ErrorCode::NotFound,
                "rssNoFeed",
                "没有这个订阅",
            ));
        };
        // A feed added before its title was known takes the feed's own.
        let title = if feed_title.trim().is_empty() || feed_title == url {
            fetched.title.trim()
        } else {
            feed_title.as_str()
        };
        tx.execute(
            "UPDATE rss_feeds SET title = ?2, site_url = COALESCE(?3, site_url),
                icon_url = COALESCE(?4, icon_url), etag = ?5, last_modified = ?6,
                last_fetch = ?7, last_error = NULL WHERE url = ?1",
            params![
                url,
                if title.is_empty() { url } else { title },
                fetched.site_url,
                fetched.icon_url,
                fetched.etag,
                fetched.last_modified,
                now
            ],
        )?;
        let filters = Self::feed_filter_set(&tx, url)?;
        let mut inserted = Vec::new();
        for article in &fetched.articles {
            let (known, cleared): (bool, bool) = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM rss_articles WHERE id = ?1),
                        EXISTS(SELECT 1 FROM rss_cleared WHERE id = ?1)",
                params![article.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if cleared {
                continue;
            }
            if !known && !filters.is_empty() && !admitted(&filters, article) {
                continue;
            }
            if known {
                tx.execute(
                    "UPDATE rss_articles SET title = ?2, link = ?3, author = ?4, excerpt = ?5,
                        image = ?6, content = ?7 WHERE id = ?1",
                    params![
                        article.id,
                        article.title,
                        article.link,
                        article.author,
                        article.excerpt,
                        article.image,
                        article.content
                    ],
                )?;
                index_article(&tx, &article.id)?;
                continue;
            }
            tx.execute(
                "INSERT INTO rss_articles(id, feed_url, feed_title, title, link, author,
                    published_at, fetched_at, excerpt, image, content)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    article.id,
                    url,
                    title,
                    article.title,
                    article.link,
                    article.author,
                    if article.published_at > 0 {
                        article.published_at
                    } else {
                        now
                    },
                    now,
                    article.excerpt,
                    article.image,
                    article.content
                ],
            )?;
            index_article(&tx, &article.id)?;
            inserted.push(article.id.as_str());
        }
        prune_feed(
            &tx,
            url,
            now,
            keep_count.unwrap_or(settings.keep_articles),
            days.unwrap_or(settings.keep_days),
            keep_unread.unwrap_or(settings.keep_unread_articles),
        )?;
        // Entries too old to keep come and go at once; they are not new.
        let mut added = 0;
        let mut kept_ids = Vec::new();
        for id in inserted {
            let kept: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM rss_articles WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )?;
            added += u32::from(kept);
            if kept {
                kept_ids.push(id);
            }
        }
        tx.commit()?;
        self.apply_synced_reads(url, &kept_ids)?;
        Ok(added)
    }

    pub fn list_articles(&self, query: &ArticleQuery) -> Result<ArticlePage, AppError> {
        let limit = query.limit.unwrap_or(PAGE).clamp(1, 200);
        let (mut conditions, mut values) = list_conditions(query);
        if let Some(after) = &query.after {
            values.push(after.published_at.into());
            let time = values.len();
            values.push(after.id.clone().into());
            let id = values.len();
            conditions.push(format!(
                "(a.published_at < ?{time} OR (a.published_at = ?{time} AND a.id < ?{id}))"
            ));
        }
        let sql = format!(
            "SELECT {SUMMARY_COLUMNS} FROM rss_articles a
             LEFT JOIN rss_feeds f ON f.url = a.feed_url
             {} ORDER BY a.published_at DESC, a.id DESC LIMIT {}",
            where_clause(&conditions),
            limit + 1
        );
        let mut statement = self.conn.prepare(&sql)?;
        let mut articles = statement
            .query_map(rusqlite::params_from_iter(values), summary_of)?
            .collect::<Result<Vec<_>, _>>()?;
        let next = (articles.len() > limit as usize).then(|| {
            articles.truncate(limit as usize);
            let last = articles.last().expect("a full page has a last article");
            ArticleCursor {
                published_at: last.published_at,
                id: last.id.clone(),
            }
        });
        Ok(ArticlePage { articles, next })
    }

    /// 以上/以下标为已读: marks the list's unread articles from `from` up
    /// (newer) or down (older), `from` included, except those kept unread;
    /// returns how many changed.
    pub fn mark_read_range(
        &self,
        query: &ArticleQuery,
        from: &ArticleCursor,
        newer: bool,
    ) -> Result<u32, AppError> {
        let (mut conditions, mut values) = list_conditions(query);
        values.push(from.published_at.into());
        let time = values.len();
        values.push(from.id.clone().into());
        let id = values.len();
        let (side, edge) = if newer { (">", ">=") } else { ("<", "<=") };
        conditions.push(format!(
            "(a.published_at {side} ?{time} OR (a.published_at = ?{time} AND a.id {edge} ?{id}))"
        ));
        conditions.push("a.read = 0 AND a.keep_unread = 0".into());
        values.push(now_millis().into());
        let now = values.len();
        let changed = self.conn.execute(
            &format!(
                "UPDATE rss_articles SET read = 1, read_at = ?{now} WHERE id IN
                    (SELECT a.id FROM rss_articles a LEFT JOIN rss_feeds f ON f.url = a.feed_url
                     {})",
                where_clause(&conditions)
            ),
            rusqlite::params_from_iter(values),
        )?;
        Ok(changed as u32)
    }

    pub fn rss_article(&self, id: &str) -> Result<Article, AppError> {
        self.conn
            .query_row(
                &format!(
                    "SELECT {SUMMARY_COLUMNS}, a.content, a.full_text FROM rss_articles a
                     LEFT JOIN rss_feeds f ON f.url = a.feed_url WHERE a.id = ?1"
                ),
                params![id],
                |row| {
                    Ok(Article {
                        summary: summary_of(row)?,
                        content: row.get(12)?,
                        full_text: row.get(13)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::keyed(ErrorCode::NotFound, "rssNoArticle", "没有这篇文章"))
    }

    pub fn save_full_text(&self, id: &str, html: &str) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE rss_articles SET full_text = ?2 WHERE id = ?1",
            params![id, html],
        )?;
        index_article(&self.conn, id)
    }

    /// Marks articles. 保持未读 also marks them unread; marking them read
    /// takes it off.
    pub fn set_article_state(
        &mut self,
        ids: &[String],
        read: Option<bool>,
        starred: Option<bool>,
        keep_unread: Option<bool>,
    ) -> Result<(), AppError> {
        let now = now_millis();
        let read = match keep_unread {
            Some(true) => Some(false),
            _ => read,
        };
        let tx = self.conn.transaction()?;
        for id in ids {
            if let Some(read) = read {
                tx.execute(
                    "UPDATE rss_articles SET read = ?2, read_at = CASE WHEN ?2 THEN ?3 ELSE NULL END
                     WHERE id = ?1 AND read != ?2",
                    params![id, read, now],
                )?;
            }
            let keep = keep_unread.or(read.filter(|read| *read).map(|_| false));
            if let Some(keep) = keep {
                tx.execute(
                    "UPDATE rss_articles SET keep_unread = ?2 WHERE id = ?1",
                    params![id, keep],
                )?;
            }
            if let Some(starred) = starred {
                tx.execute(
                    "UPDATE rss_articles SET starred = ?2,
                        starred_at = CASE WHEN ?2 THEN ?3 ELSE NULL END
                     WHERE id = ?1 AND starred != ?2",
                    params![id, starred, now],
                )?;
            }
        }
        // An unstarred article of a removed feed has nothing to keep it.
        tx.execute(
            "DELETE FROM rss_articles WHERE starred = 0
               AND feed_url NOT IN (SELECT url FROM rss_feeds)",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 全部标为已读 (but those kept unread); returns how many changed.
    pub fn mark_all_read(
        &self,
        feed: Option<&str>,
        group: Option<&str>,
        account: Option<&str>,
    ) -> Result<u32, AppError> {
        let now = now_millis();
        let changed = match (feed, group, account) {
            (Some(feed), _, _) => self.conn.execute(
                "UPDATE rss_articles SET read = 1, read_at = ?2
                 WHERE read = 0 AND keep_unread = 0 AND feed_url = ?1",
                params![feed, now],
            )?,
            (None, Some(group), account) => self.conn.execute(
                "UPDATE rss_articles SET read = 1, read_at = ?2
                 WHERE read = 0 AND keep_unread = 0 AND feed_url IN
                    (SELECT url FROM rss_feeds WHERE group_name = ?1 AND account_id IS ?3)",
                params![group, now, account],
            )?,
            (None, None, Some(account)) => self.conn.execute(
                "UPDATE rss_articles SET read = 1, read_at = ?2
                 WHERE read = 0 AND keep_unread = 0 AND feed_url IN
                    (SELECT url FROM rss_feeds WHERE account_id = ?1)",
                params![account, now],
            )?,
            (None, None, None) => self.conn.execute(
                "UPDATE rss_articles SET read = 1, read_at = ?1 WHERE read = 0 AND keep_unread = 0",
                params![now],
            )?,
        };
        Ok(changed as u32)
    }

    /// Articles the server fetched after `since` (its own clock), for a
    /// connected device; `None` when the feed is not subscribed here.
    pub fn feed_articles_since(
        &self,
        url: &str,
        since: i64,
    ) -> Result<Option<Vec<FetchedArticle>>, AppError> {
        if self.feed_fetch_state(url)?.is_none() {
            return Ok(None);
        }
        let mut statement = self.conn.prepare(
            "SELECT id, title, link, author, published_at, excerpt, image, content
             FROM rss_articles WHERE feed_url = ?1 AND fetched_at > ?2
             ORDER BY published_at DESC, id DESC LIMIT ?3",
        )?;
        let articles = statement
            .query_map(params![url, since, KEEP_ARTICLES], |row| {
                Ok(FetchedArticle {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    link: row.get(2)?,
                    author: row.get(3)?,
                    published_at: row.get(4)?,
                    excerpt: row.get(5)?,
                    image: row.get(6)?,
                    content: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(articles))
    }

    /// Where the device last left off with the server's articles of a feed.
    pub fn feed_server_cursor(&self, url: &str) -> Result<i64, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT server_cursor FROM rss_feeds WHERE url = ?1",
                params![url],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    /// Stores articles the server sent and where to continue next time.
    pub fn store_server_articles(
        &mut self,
        url: &str,
        articles: Vec<FetchedArticle>,
        cursor: i64,
    ) -> Result<u32, AppError> {
        let state = self.feed_fetch_state(url)?.unwrap_or_default();
        let added = self.store_feed_fetch(
            url,
            &FetchedFeed {
                title: state.title,
                etag: state.etag,
                last_modified: state.last_modified,
                articles,
                ..FetchedFeed::default()
            },
        )?;
        self.conn.execute(
            "UPDATE rss_feeds SET server_cursor = ?2 WHERE url = ?1",
            params![url, cursor],
        )?;
        Ok(added)
    }

    /// What the articles' text takes (an estimate inside the database).
    pub fn rss_article_bytes(&self) -> Result<u64, AppError> {
        let bytes: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(content) + LENGTH(COALESCE(full_text, ''))
                + LENGTH(excerpt) + LENGTH(title)), 0) FROM rss_articles",
            [],
            |row| row.get(0),
        )?;
        Ok(bytes.max(0) as u64)
    }

    /// 清理订阅文章: drops read articles that are not starred, and the
    /// 全文 kept of the rest; feeds and unread articles stay. A dropped
    /// article is remembered, so a refresh does not bring it back unread.
    pub fn clear_rss_articles(&mut self) -> Result<(), AppError> {
        let now = now_millis();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO rss_cleared(id, cleared_at)
             SELECT id, ?1 FROM rss_articles WHERE read = 1 AND starred = 0",
            params![now],
        )?;
        tx.execute(
            "DELETE FROM rss_articles WHERE read = 1 AND starred = 0",
            [],
        )?;
        let fetched: Vec<String> = tx
            .prepare("SELECT id FROM rss_articles WHERE full_text IS NOT NULL")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        tx.execute(
            "UPDATE rss_articles SET full_text = NULL WHERE full_text IS NOT NULL",
            [],
        )?;
        for id in fetched {
            index_article(&tx, &id)?;
        }
        // A year on, a feed no longer carries them.
        tx.execute(
            "DELETE FROM rss_cleared WHERE cleared_at < ?1",
            params![now - 365 * 86_400_000],
        )?;
        tx.commit()?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn conn_for_tests(&self) -> &rusqlite::Connection {
        &self.conn
    }

    /// Where article images are kept.
    pub fn rss_image_cache(&self) -> PathBuf {
        self.root.join("rss-images")
    }
}

/// Drops a feed's oldest unstarred articles beyond what is kept: those
/// older than `keep_days` and not among the newest `keep_count` (0 keeps
/// them all).
pub(super) fn prune_feed(
    tx: &rusqlite::Transaction<'_>,
    url: &str,
    now: i64,
    keep_count: u32,
    keep_days: u32,
    keep_unread: bool,
) -> Result<(), AppError> {
    if keep_count == 0 {
        return Ok(());
    }
    let since = now - i64::from(keep_days) * 86_400_000;
    tx.execute(
        "DELETE FROM rss_articles WHERE feed_url = ?1 AND starred = 0 AND keep_unread = 0
           AND (?4 = 0 OR read = 1) AND published_at < ?2
           AND id NOT IN (SELECT id FROM rss_articles WHERE feed_url = ?1
                          ORDER BY published_at DESC, id DESC LIMIT ?3)",
        params![url, since, keep_count, keep_unread],
    )?;
    Ok(())
}

/// The filters of an article list (its feed or group, filter, and search),
/// with their values bound in order.
fn list_conditions(query: &ArticleQuery) -> (Vec<String>, Vec<rusqlite::types::Value>) {
    let mut conditions = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    let mut bind = |value: rusqlite::types::Value| {
        values.push(value);
        format!("?{}", values.len())
    };
    let account: rusqlite::types::Value = query.account.clone().into();
    if let Some(feed) = &query.feed {
        conditions.push(format!("a.feed_url = {}", bind(feed.clone().into())));
    } else if let Some(group) = &query.group {
        let group = bind(group.clone().into());
        conditions.push(format!(
            "f.group_name = {group} AND f.account_id IS {}",
            bind(account)
        ));
    } else if query.account.is_some() {
        conditions.push(format!("f.account_id = {}", bind(account)));
    }
    match query.filter {
        ArticleFilter::All => {}
        ArticleFilter::Unread => conditions.push("a.read = 0".into()),
        ArticleFilter::Starred => conditions.push("a.starred = 1".into()),
    }
    // Articles of removed feeds show only among the starred.
    if query.filter != ArticleFilter::Starred && query.feed.is_none() {
        conditions.push("f.url IS NOT NULL".into());
    }
    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|search| !search.is_empty())
    {
        if search.chars().count() >= SEARCH_MIN_CHARS {
            // One phrase, matched anywhere in the title, author, or text.
            let phrase = format!("\"{}\"", search.replace('"', "\"\""));
            let at = bind(phrase.into());
            conditions.push(format!(
                "a.rowid IN (SELECT rowid FROM rss_search WHERE rss_search MATCH {at})"
            ));
            return (conditions, values);
        }
        let pattern = format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let at = bind(pattern.into());
        conditions.push(format!(
            "(a.title LIKE {at} ESCAPE '\\' OR a.excerpt LIKE {at} ESCAPE '\\')"
        ));
    }
    (conditions, values)
}

fn where_clause(conditions: &[String]) -> String {
    if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    }
}

fn set_options(
    tx: &rusqlite::Transaction<'_>,
    url: &str,
    options: &FeedOptions,
) -> Result<(), AppError> {
    tx.execute(
        "UPDATE rss_feeds SET refresh_minutes = ?2, keep_articles = ?3, keep_days = ?4,
            full_text = ?5, via_server = ?6, keep_unread = ?7 WHERE url = ?1",
        params![
            url,
            options.refresh_minutes,
            options.keep_articles,
            options.keep_days,
            options.full_text,
            options.via_server,
            options.keep_unread
        ],
    )?;
    Ok(())
}

/// Gives a feed a new address. Its articles go with it and keep their ids
/// (it keeps its first address as `id_base`); the old address's fetch
/// state is dropped.
fn move_feed(tx: &rusqlite::Transaction<'_>, from: &str, to: &str) -> Result<(), AppError> {
    if to.is_empty() {
        return Err(invalid("rssFeedUrlEmpty", "订阅地址不能为空"));
    }
    let taken: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM rss_feeds WHERE url = ?1)",
        params![to],
        |row| row.get(0),
    )?;
    if taken {
        return Err(invalid("rssFeedExists", "已经订阅过这个地址"));
    }
    let moved = tx.execute(
        "INSERT INTO rss_feeds(url, title, site_url, icon_url, group_name, sort, added_at,
            updated_at, last_fetch, last_error, enabled, refresh_minutes, keep_articles,
            keep_days, full_text, via_server, keep_unread, id_base)
         SELECT ?2, title, site_url, icon_url, group_name, sort, added_at, ?3, NULL, NULL,
            enabled, refresh_minutes, keep_articles, keep_days, full_text, via_server,
            keep_unread, COALESCE(id_base, url)
         FROM rss_feeds WHERE url = ?1",
        params![from, to, now_millis()],
    )?;
    if moved == 0 {
        return Err(AppError::keyed(
            ErrorCode::NotFound,
            "rssNoFeed",
            "没有这个订阅",
        ));
    }
    tx.execute(
        "UPDATE rss_articles SET feed_url = ?2 WHERE feed_url = ?1",
        params![from, to],
    )?;
    tx.execute("DELETE FROM rss_feeds WHERE url = ?1", params![from])?;
    super::rss_filters::move_feed_filters(tx, from, to)
}

/// Read articles go into sync records by the start of their id, which is
/// enough to tell a feed's articles apart.
const READ_ID: usize = 16;

fn read_key(id: &str) -> &str {
    &id[..id.len().min(READ_ID)]
}

/// A subscription as a sync and backup record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableFeed {
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub site_url: Option<String>,
    #[serde(default)]
    pub sort: i64,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub options: FeedOptions,
    /// The first address, when it has a new one: its articles' ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_base: Option<String>,
}

fn enabled() -> bool {
    true
}

/// A starred article with its text, so it shows where it was never fetched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableStar {
    pub id: String,
    pub feed_url: String,
    pub feed_title: String,
    pub title: String,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    pub published_at: i64,
    #[serde(default)]
    pub excerpt: String,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub content: String,
}

impl Storage {
    pub fn portable_feeds(&self) -> Result<Vec<PortableFeed>, AppError> {
        let mut statement = self
            .conn
            .prepare("SELECT url, id_base FROM rss_feeds WHERE id_base IS NOT NULL")?;
        let bases: std::collections::HashMap<String, String> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        Ok(self
            .list_feeds()?
            .into_iter()
            .filter(|feed| feed.account.is_none())
            .map(|feed| PortableFeed {
                id_base: bases.get(&feed.url).cloned(),
                url: feed.url,
                title: feed.title,
                group: feed.group,
                site_url: feed.site_url,
                sort: feed.sort,
                enabled: feed.enabled,
                options: feed.options,
            })
            .collect())
    }

    /// The groups in order: those arranged in 分组管理, then any other a
    /// feed is filed under, in the order of their first feed.
    pub fn feed_groups(&self) -> Result<Vec<FeedGroup>, AppError> {
        let mut statement = self
            .conn
            .prepare("SELECT name, sort FROM rss_groups ORDER BY sort, name")?;
        let mut groups = statement
            .query_map([], |row| {
                Ok(FeedGroup {
                    name: row.get(0)?,
                    sort: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut next = groups.last().map_or(0, |group| group.sort + 1);
        for feed in self.list_feeds()? {
            if feed.account.is_some() {
                continue;
            }
            if let Some(name) = feed.group {
                if !groups.iter().any(|group| group.name == name) {
                    groups.push(FeedGroup { name, sort: next });
                    next += 1;
                }
            }
        }
        Ok(groups)
    }

    /// Puts the groups in this order, creating any not there yet; the
    /// others follow.
    pub fn save_feed_groups(&mut self, names: &[String]) -> Result<(), AppError> {
        let mut order: Vec<String> = Vec::new();
        for name in names.iter().map(|name| name.trim()) {
            if name.is_empty() {
                return Err(invalid("rssGroupNameEmpty", "分组名称不能为空"));
            }
            if !order.iter().any(|known| known == name) {
                order.push(name.to_string());
            }
        }
        for group in self.feed_groups()? {
            if !order.contains(&group.name) {
                order.push(group.name);
            }
        }
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM rss_groups", [])?;
        for (sort, name) in order.iter().enumerate() {
            tx.execute(
                "INSERT INTO rss_groups(name, sort) VALUES (?1, ?2)",
                params![name, sort as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Renames a group; into one that exists, the two become one.
    pub fn rename_feed_group(&mut self, name: &str, new_name: &str) -> Result<(), AppError> {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err(invalid("rssGroupNameEmpty", "分组名称不能为空"));
        }
        if new_name == name {
            return Ok(());
        }
        let groups: Vec<String> = self
            .feed_groups()?
            .into_iter()
            .map(|group| group.name)
            .collect();
        // Into another group, it takes that one's place; else it keeps its own.
        let merging = groups.iter().any(|group| group == new_name);
        let order: Vec<String> = groups
            .into_iter()
            .filter(|group| !(merging && group == name))
            .map(|group| {
                if group == name {
                    new_name.to_string()
                } else {
                    group
                }
            })
            .collect();
        self.conn.execute(
            "UPDATE rss_feeds SET group_name = ?2, updated_at = ?3
             WHERE group_name = ?1 AND account_id IS NULL",
            params![name, new_name, now_millis()],
        )?;
        self.conn.execute(
            "UPDATE rss_filters SET target = ?2, updated_at = ?3
             WHERE scope = 'group' AND target = ?1",
            params![name, new_name, now_millis()],
        )?;
        self.conn
            .execute("DELETE FROM rss_groups WHERE name = ?1", params![name])?;
        self.save_feed_groups(&order)
    }

    /// Removes a group: its feeds become ungrouped, or are unsubscribed.
    pub fn remove_feed_group(&mut self, name: &str, unsubscribe: bool) -> Result<(), AppError> {
        if unsubscribe {
            let urls: Vec<String> = self
                .list_feeds()?
                .into_iter()
                .filter(|feed| feed.account.is_none() && feed.group.as_deref() == Some(name))
                .map(|feed| feed.url)
                .collect();
            self.remove_feeds(&urls)?;
        } else {
            self.conn.execute(
                "UPDATE rss_feeds SET group_name = NULL, updated_at = ?2
                 WHERE group_name = ?1 AND account_id IS NULL",
                params![name, now_millis()],
            )?;
        }
        self.conn
            .execute("DELETE FROM rss_groups WHERE name = ?1", params![name])?;
        self.conn.execute(
            "DELETE FROM rss_filters WHERE scope = 'group' AND target = ?1",
            params![name],
        )?;
        Ok(())
    }

    pub fn portable_stars(&self) -> Result<Vec<PortableStar>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT a.id, a.feed_url, COALESCE(f.title, a.feed_title), a.title, a.link, a.author,
                    a.published_at, a.excerpt, a.image, a.content
             FROM rss_articles a LEFT JOIN rss_feeds f ON f.url = a.feed_url
             WHERE a.starred = 1 AND a.remote_id IS NULL ORDER BY a.id",
        )?;
        let stars = statement
            .query_map([], |row| {
                Ok(PortableStar {
                    id: row.get(0)?,
                    feed_url: row.get(1)?,
                    feed_title: row.get(2)?,
                    title: row.get(3)?,
                    link: row.get(4)?,
                    author: row.get(5)?,
                    published_at: row.get(6)?,
                    excerpt: row.get(7)?,
                    image: row.get(8)?,
                    content: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(stars)
    }

    /// Read article ids (shortened) of a feed, sorted. Ids synced as read
    /// whose articles this device does not have stay in, so a device that
    /// has not fetched them yet does not mark them unread everywhere.
    fn read_ids(&self, url: &str) -> Result<Vec<String>, AppError> {
        let mut statement = self
            .conn
            .prepare("SELECT id, read FROM rss_articles WHERE feed_url = ?1")?;
        let rows = statement
            .query_map(params![url], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let known: HashSet<&str> = rows.iter().map(|(id, _)| read_key(id)).collect();
        let mut ids: std::collections::BTreeSet<String> = rows
            .iter()
            .filter(|(_, read)| *read)
            .map(|(id, _)| read_key(id).to_string())
            .collect();
        if let Some(value) = self.synced_value(&format!("rss-read:{url}"))? {
            let synced: Vec<String> = serde_json::from_value(value).unwrap_or_default();
            // Articles gone everywhere would stay in the record for good; a
            // feed keeps at most a few times what is kept of it.
            let room = (KEEP_ARTICLES as usize * 3).saturating_sub(ids.len());
            ids.extend(
                synced
                    .into_iter()
                    .filter(|key| !known.contains(key.as_str()))
                    .take(room),
            );
        }
        Ok(ids.into_iter().collect())
    }

    /// `feed:<url>`, `rss-read:<url>`, `rss-star:<id>`, and
    /// `rss-group:<name>` records.
    pub(super) fn rss_records(&self) -> Result<Vec<(String, Value)>, AppError> {
        let mut records = Vec::new();
        let mut statement = self.conn.prepare("SELECT name, sort FROM rss_groups")?;
        let groups = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (name, sort) in groups {
            records.push((
                format!("rss-group:{name}"),
                serde_json::json!({ "sort": sort }),
            ));
        }
        for feed in self.portable_feeds()? {
            records.push((
                format!("rss-read:{}", feed.url),
                serde_json::to_value(self.read_ids(&feed.url)?)?,
            ));
            records.push((format!("feed:{}", feed.url), serde_json::to_value(&feed)?));
        }
        for star in self.portable_stars()? {
            records.push((
                format!("rss-star:{}", star.id),
                serde_json::to_value(&star)?,
            ));
        }
        records.extend(self.filter_records()?);
        Ok(records)
    }

    /// A subscription added, changed, or removed elsewhere.
    pub(super) fn apply_feed_record(
        &mut self,
        url: &str,
        value: Option<&Value>,
    ) -> Result<(), AppError> {
        let Some(value) = value else {
            return self.remove_feeds(&[url.to_string()]);
        };
        let feed: PortableFeed = serde_json::from_value(value.clone())?;
        self.restore_feed(&feed)
    }

    /// A group arranged elsewhere, or removed there (its feeds' own records
    /// say where they went).
    pub(super) fn apply_feed_group_record(
        &mut self,
        name: &str,
        value: Option<&Value>,
    ) -> Result<(), AppError> {
        match value {
            Some(value) => {
                let sort = value.get("sort").and_then(Value::as_i64).unwrap_or(0);
                self.conn.execute(
                    "INSERT INTO rss_groups(name, sort) VALUES (?1, ?2)
                     ON CONFLICT(name) DO UPDATE SET sort = excluded.sort",
                    params![name, sort],
                )?;
            }
            None => {
                self.conn
                    .execute("DELETE FROM rss_groups WHERE name = ?1", params![name])?;
            }
        }
        Ok(())
    }

    /// Adds or updates a feed from a sync or backup record. A feed given a
    /// new address elsewhere is moved here too, with its articles.
    pub(super) fn restore_feed(&mut self, feed: &PortableFeed) -> Result<(), AppError> {
        // An account's feeds come from the account.
        if super::rss_accounts::feed_account(&feed.url).is_some() {
            return Ok(());
        }
        let now = now_millis();
        let tx = self.conn.transaction()?;
        if let Some(base) = &feed.id_base {
            let moved: Option<String> = tx
                .query_row(
                    "SELECT url FROM rss_feeds WHERE url != ?1 AND COALESCE(id_base, url) = ?2
                       AND NOT EXISTS(SELECT 1 FROM rss_feeds WHERE url = ?1)",
                    params![feed.url, base],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(from) = moved {
                move_feed(&tx, &from, &feed.url)?;
            }
        }
        tx.execute(
            "INSERT INTO rss_feeds(url, title, site_url, group_name, sort, added_at, updated_at,
                enabled, id_base)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
             ON CONFLICT(url) DO UPDATE SET title = excluded.title,
                group_name = excluded.group_name, sort = excluded.sort,
                site_url = COALESCE(excluded.site_url, site_url), updated_at = excluded.updated_at,
                enabled = excluded.enabled, id_base = COALESCE(excluded.id_base, id_base)",
            params![
                feed.url,
                feed.title,
                feed.site_url,
                feed.group,
                feed.sort,
                now,
                feed.enabled,
                feed.id_base
            ],
        )?;
        set_options(&tx, &feed.url, &checked_options(&feed.options))?;
        tx.commit()?;
        Ok(())
    }

    /// Another device's read articles of a feed: what it read since the
    /// last sync is read here, what it marked unread is unread here, and
    /// this device's own marks stay.
    pub(super) fn apply_read_record(
        &mut self,
        url: &str,
        value: Option<&Value>,
        base: Option<&Value>,
    ) -> Result<(), AppError> {
        let ids = |value: Option<&Value>| -> HashSet<String> {
            value
                .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
                .unwrap_or_default()
                .into_iter()
                .collect()
        };
        let incoming = ids(value);
        let base = ids(base);
        let read: Vec<&String> = incoming.difference(&base).collect();
        let unread: Vec<&String> = base.difference(&incoming).collect();
        self.mark_read_keys(url, &read, true)?;
        self.mark_read_keys(url, &unread, false)
    }

    fn mark_read_keys(&self, url: &str, keys: &[&String], read: bool) -> Result<(), AppError> {
        let now = now_millis();
        for key in keys {
            self.conn.execute(
                "UPDATE rss_articles SET read = ?3, read_at = CASE WHEN ?3 THEN ?4 ELSE NULL END
                 WHERE feed_url = ?1 AND substr(id, 1, ?5) = ?2 AND read != ?3",
                params![url, key, read, now, READ_ID as i64],
            )?;
        }
        Ok(())
    }

    /// Articles a fetch just added that another device has read already.
    fn apply_synced_reads(&self, url: &str, added: &[&str]) -> Result<(), AppError> {
        if added.is_empty() {
            return Ok(());
        }
        let Some(value) = self.synced_value(&format!("rss-read:{url}"))? else {
            return Ok(());
        };
        let read: HashSet<String> = serde_json::from_value(value).unwrap_or_default();
        let keys: Vec<String> = added
            .iter()
            .map(|id| read_key(id).to_string())
            .filter(|key| read.contains(key))
            .collect();
        let keys: Vec<&String> = keys.iter().collect();
        self.mark_read_keys(url, &keys, true)
    }

    /// An article starred elsewhere (kept with its text), or unstarred.
    pub(super) fn apply_star_record(
        &mut self,
        id: &str,
        value: Option<&Value>,
    ) -> Result<(), AppError> {
        let Some(value) = value else {
            return self.set_article_state(&[id.to_string()], None, Some(false), None);
        };
        let star: PortableStar = serde_json::from_value(value.clone())?;
        self.restore_star(&star)
    }

    pub(super) fn restore_star(&self, star: &PortableStar) -> Result<(), AppError> {
        let now = now_millis();
        self.conn.execute(
            "INSERT INTO rss_articles(id, feed_url, feed_title, title, link, author, published_at,
                fetched_at, excerpt, image, content, read, read_at, starred, starred_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?8, 1, ?8)
             ON CONFLICT(id) DO UPDATE SET starred = 1,
                starred_at = COALESCE(starred_at, excluded.starred_at)",
            params![
                star.id,
                star.feed_url,
                star.feed_title,
                star.title,
                star.link,
                star.author,
                star.published_at,
                now,
                star.excerpt,
                star.image,
                star.content
            ],
        )?;
        index_article(&self.conn, &star.id)
    }
}
