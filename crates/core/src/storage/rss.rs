//! 订阅: RSS/Atom feeds and their articles. Articles are keyed by a hash of
//! the feed and the entry's identity, so a refresh updates what it already
//! has and keeps its read and starred state. Each feed keeps its newest
//! [`KEEP_ARTICLES`] articles, or those of the last `keep_days` days (in
//! [`RssSettings`], [`KEEP_DAYS`] by default) if that is more; starred
//! articles stay until unstarred.

use super::*;
use crate::models::{
    Article, ArticleCursor, ArticleFilter, ArticlePage, ArticleQuery, ArticleSummary, Feed,
    RssSettings,
};
use serde_json::Value;
use std::collections::HashSet;

pub const KEEP_ARTICLES: i64 = 500;
pub const KEEP_DAYS: u32 = 90;
/// The choices for how many days of articles are kept.
pub const KEEP_DAY_CHOICES: [u32; 4] = [30, 90, 180, 365];
const PAGE: u32 = 50;
const SETTINGS_FILE: &str = "rss.json";

/// A feed's stored fetch state, for conditional requests.
#[derive(Debug, Clone, Default)]
pub struct FeedFetchState {
    pub title: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
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
    })
}

const SUMMARY_COLUMNS: &str = "a.id, a.feed_url, COALESCE(f.title, a.feed_title), a.title, a.link,
    a.author, a.published_at, a.excerpt, a.image, a.read, a.starred";

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

    pub fn rss_settings(&self) -> RssSettings {
        fs::read_to_string(self.root.join(SETTINGS_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save_rss_settings(&self, settings: &RssSettings) -> Result<RssSettings, AppError> {
        let settings = RssSettings {
            refresh_minutes: settings.refresh_minutes.min(24 * 60),
            mark_read_on_open: settings.mark_read_on_open,
            font_size: settings.font_size.clamp(12, 32),
            keep_days: if KEEP_DAY_CHOICES.contains(&settings.keep_days) {
                settings.keep_days
            } else {
                KEEP_DAYS
            },
            ..settings.clone()
        };
        fs::write(
            self.root.join(SETTINGS_FILE),
            serde_json::to_string_pretty(&settings)?,
        )?;
        Ok(settings)
    }

    pub fn list_feeds(&self) -> Result<Vec<Feed>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT f.url, f.title, f.site_url, f.icon_url, f.group_name, f.sort, f.added_at,
                    f.last_fetch, f.last_error,
                    (SELECT COUNT(*) FROM rss_articles a WHERE a.feed_url = f.url AND a.read = 0),
                    (SELECT COUNT(*) FROM rss_articles a WHERE a.feed_url = f.url)
             FROM rss_feeds f ORDER BY f.sort, f.added_at, f.url",
        )?;
        let feeds = statement
            .query_map([], |row| {
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
                })
            })?
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

    pub fn feed_fetch_state(&self, url: &str) -> Result<Option<FeedFetchState>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT title, etag, last_modified FROM rss_feeds WHERE url = ?1",
                params![url],
                |row| {
                    Ok(FeedFetchState {
                        title: row.get(0)?,
                        etag: row.get(1)?,
                        last_modified: row.get(2)?,
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
                group.map(str::trim).filter(|group| !group.is_empty()),
                next_sort,
                now
            ],
        )?;
        Ok(added > 0)
    }

    pub fn update_feed(&self, url: &str, title: &str, group: Option<&str>) -> Result<(), AppError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(AppError::keyed(
                ErrorCode::InvalidArgument,
                "rssFeedTitleEmpty",
                "订阅名称不能为空",
            ));
        }
        let changed = self.conn.execute(
            "UPDATE rss_feeds SET title = ?2, group_name = ?3, updated_at = ?4 WHERE url = ?1",
            params![
                url,
                title,
                group.map(str::trim).filter(|group| !group.is_empty()),
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
        let keep_days = self.rss_settings().keep_days;
        let tx = self.conn.transaction()?;
        let feed_title: Option<String> = tx
            .query_row(
                "SELECT title FROM rss_feeds WHERE url = ?1",
                params![url],
                |row| row.get(0),
            )
            .optional()?;
        let Some(feed_title) = feed_title else {
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
        let mut inserted = Vec::new();
        for article in &fetched.articles {
            let known: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM rss_articles WHERE id = ?1)",
                params![article.id],
                |row| row.get(0),
            )?;
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
            inserted.push(article.id.as_str());
        }
        prune_feed(&tx, url, now, keep_days)?;
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
        let mut conditions = Vec::new();
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        let mut bind = |value: rusqlite::types::Value| {
            values.push(value);
            format!("?{}", values.len())
        };
        if let Some(feed) = &query.feed {
            conditions.push(format!("a.feed_url = {}", bind(feed.clone().into())));
        } else if let Some(group) = &query.group {
            conditions.push(format!("f.group_name = {}", bind(group.clone().into())));
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
        if let Some(after) = &query.after {
            let time = bind(after.published_at.into());
            let id = bind(after.id.clone().into());
            conditions.push(format!(
                "(a.published_at < {time} OR (a.published_at = {time} AND a.id < {id}))"
            ));
        }
        let filter = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let sql = format!(
            "SELECT {SUMMARY_COLUMNS} FROM rss_articles a
             LEFT JOIN rss_feeds f ON f.url = a.feed_url
             {filter} ORDER BY a.published_at DESC, a.id DESC LIMIT {}",
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
                        content: row.get(11)?,
                        full_text: row.get(12)?,
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
        Ok(())
    }

    pub fn set_article_state(
        &mut self,
        ids: &[String],
        read: Option<bool>,
        starred: Option<bool>,
    ) -> Result<(), AppError> {
        let now = now_millis();
        let tx = self.conn.transaction()?;
        for id in ids {
            if let Some(read) = read {
                tx.execute(
                    "UPDATE rss_articles SET read = ?2, read_at = CASE WHEN ?2 THEN ?3 ELSE NULL END
                     WHERE id = ?1 AND read != ?2",
                    params![id, read, now],
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

    /// 全部标为已读; returns how many changed.
    pub fn mark_all_read(&self, feed: Option<&str>, group: Option<&str>) -> Result<u32, AppError> {
        let now = now_millis();
        let changed = match (feed, group) {
            (Some(feed), _) => self.conn.execute(
                "UPDATE rss_articles SET read = 1, read_at = ?2 WHERE read = 0 AND feed_url = ?1",
                params![feed, now],
            )?,
            (None, Some(group)) => self.conn.execute(
                "UPDATE rss_articles SET read = 1, read_at = ?2 WHERE read = 0 AND feed_url IN
                    (SELECT url FROM rss_feeds WHERE group_name = ?1)",
                params![group, now],
            )?,
            (None, None) => self.conn.execute(
                "UPDATE rss_articles SET read = 1, read_at = ?1 WHERE read = 0",
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

    /// Where article images are kept.
    pub fn rss_image_cache(&self) -> PathBuf {
        self.root.join("rss-images")
    }
}

/// Drops a feed's oldest unstarred articles beyond what is kept.
fn prune_feed(
    tx: &rusqlite::Transaction<'_>,
    url: &str,
    now: i64,
    keep_days: u32,
) -> Result<(), AppError> {
    let since = now - i64::from(keep_days) * 86_400_000;
    tx.execute(
        "DELETE FROM rss_articles WHERE feed_url = ?1 AND starred = 0 AND published_at < ?2
           AND id NOT IN (SELECT id FROM rss_articles WHERE feed_url = ?1
                          ORDER BY published_at DESC, id DESC LIMIT ?3)",
        params![url, since, KEEP_ARTICLES],
    )?;
    Ok(())
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
        Ok(self
            .list_feeds()?
            .into_iter()
            .map(|feed| PortableFeed {
                url: feed.url,
                title: feed.title,
                group: feed.group,
                site_url: feed.site_url,
                sort: feed.sort,
            })
            .collect())
    }

    pub fn portable_stars(&self) -> Result<Vec<PortableStar>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT a.id, a.feed_url, COALESCE(f.title, a.feed_title), a.title, a.link, a.author,
                    a.published_at, a.excerpt, a.image, a.content
             FROM rss_articles a LEFT JOIN rss_feeds f ON f.url = a.feed_url
             WHERE a.starred = 1 ORDER BY a.id",
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

    /// `feed:<url>`, `rss-read:<url>`, and `rss-star:<id>` records.
    pub(super) fn rss_records(&self) -> Result<Vec<(String, Value)>, AppError> {
        let mut records = Vec::new();
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

    pub(super) fn restore_feed(&self, feed: &PortableFeed) -> Result<(), AppError> {
        let now = now_millis();
        self.conn.execute(
            "INSERT INTO rss_feeds(url, title, site_url, group_name, sort, added_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(url) DO UPDATE SET title = excluded.title,
                group_name = excluded.group_name, sort = excluded.sort,
                site_url = COALESCE(excluded.site_url, site_url), updated_at = excluded.updated_at",
            params![
                feed.url,
                feed.title,
                feed.site_url,
                feed.group,
                feed.sort,
                now
            ],
        )?;
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
            return self.set_article_state(&[id.to_string()], None, Some(false));
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
        Ok(())
    }
}
