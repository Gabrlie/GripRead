//! 订阅账号: feeds kept on a Google Reader API service (FreshRSS,
//! Miniflux, and others) and read here. An account's feeds are rows of
//! `rss_feeds` named `account:<account>:<stream>`, its articles rows of
//! `rss_articles` with the item's id there (`remote_id`), so lists, search,
//! and 过滤规则 treat them as any other. The account decides what is read
//! and starred: marks made here wait in `rss_account_changes` (a trigger
//! puts them there) until they are written to it. Accounts, their feeds,
//! and their articles stay out of sync records and backups; the password
//! stays on this device.

use super::*;
use crate::models::{FeedAccount, FeedAccountKind, SaveFeedAccountRequest};
use std::collections::HashSet;

/// An account feed's `url`.
pub fn account_feed_url(account: &str, stream: &str) -> String {
    format!("account:{account}:{stream}")
}

/// The account and stream an account feed's `url` names.
pub fn feed_account(url: &str) -> Option<(&str, &str)> {
    url.strip_prefix("account:")?.split_once(':')
}

/// An account item's article id: the same on every device, whichever
/// feed the item is in.
pub fn account_article_id(account: &str, remote_id: &str) -> String {
    article_id(&format!("account:{account}"), remote_id)
}

/// The id an account is known by: its service and user, so every device
/// that adds it names its feeds and articles alike.
pub fn account_id(server: &str, username: &str) -> String {
    let key = format!(
        "{}\n{}",
        server.trim().trim_end_matches('/').to_ascii_lowercase(),
        username.trim()
    );
    sha256_bytes(key.as_bytes())[..16].to_string()
}

/// What signing in to an account and syncing it take.
#[derive(Debug, Clone)]
pub struct AccountLogin {
    pub id: String,
    pub kind: FeedAccountKind,
    pub name: String,
    pub server: String,
    pub username: String,
    pub password: String,
    pub token: Option<String>,
    /// Items crawled before this (seconds) were seen by the last sync.
    pub since: Option<i64>,
    pub filter_read: bool,
}

/// A feed as its account lists it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccountFeed {
    pub stream: String,
    pub title: String,
    pub address: Option<String>,
    pub site_url: Option<String>,
    pub icon_url: Option<String>,
    pub group: Option<String>,
}

/// An item as its account sends it, with its marks there.
#[derive(Debug, Clone, Default)]
pub struct AccountItem {
    pub remote_id: String,
    pub stream: String,
    pub article: FetchedArticle,
    pub read: bool,
    pub starred: bool,
}

/// A mark made here, to write to the account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingMark {
    pub article_id: String,
    pub remote_id: String,
    pub read: Option<bool>,
    pub starred: Option<bool>,
}

/// What a sync stored.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredItems {
    pub added: u32,
    /// Items a 过滤规则 kept out.
    pub dropped: u32,
}

fn no_account() -> AppError {
    AppError::keyed(ErrorCode::NotFound, "rssNoAccount", "没有这个订阅账号")
}

fn kind_name(kind: FeedAccountKind) -> &'static str {
    match kind {
        FeedAccountKind::FreshRss => "freshRss",
        FeedAccountKind::Miniflux => "miniflux",
        FeedAccountKind::GoogleReader => "googleReader",
    }
}

fn kind_of(name: &str) -> FeedAccountKind {
    match name {
        "miniflux" => FeedAccountKind::Miniflux,
        "googleReader" => FeedAccountKind::GoogleReader,
        _ => FeedAccountKind::FreshRss,
    }
}

/// `url LIKE` pattern of an account's feeds.
fn feeds_of(account: &str) -> String {
    format!("account:{account}:%")
}

impl Storage {
    /// Schema 32: 订阅账号, their feeds' columns, item ids, and the marks
    /// waiting to be written to them.
    pub(super) fn create_rss_accounts(tx: &rusqlite::Transaction<'_>) -> Result<(), AppError> {
        let columns = [
            ("rss_feeds", "account_id", "TEXT"),
            ("rss_feeds", "address", "TEXT"),
            ("rss_articles", "remote_id", "TEXT"),
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
            "CREATE TABLE IF NOT EXISTS rss_accounts (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                server TEXT NOT NULL,
                username TEXT NOT NULL,
                password TEXT NOT NULL,
                token TEXT,
                filter_read INTEGER NOT NULL DEFAULT 0,
                sort INTEGER NOT NULL DEFAULT 0,
                added_at INTEGER NOT NULL,
                since INTEGER,
                last_sync INTEGER,
                last_error TEXT
             );
             CREATE TABLE IF NOT EXISTS rss_account_changes (
                article_id TEXT PRIMARY KEY NOT NULL,
                feed_url TEXT NOT NULL,
                remote_id TEXT NOT NULL,
                read INTEGER,
                starred INTEGER
             );
             CREATE INDEX IF NOT EXISTS rss_feeds_account ON rss_feeds(account_id);
             CREATE INDEX IF NOT EXISTS rss_articles_remote ON rss_articles(remote_id);
             CREATE TRIGGER IF NOT EXISTS rss_account_marks
             AFTER UPDATE OF read, starred ON rss_articles
             WHEN new.remote_id IS NOT NULL
               AND (old.read != new.read OR old.starred != new.starred)
             BEGIN
                INSERT INTO rss_account_changes(article_id, feed_url, remote_id, read, starred)
                VALUES (new.id, new.feed_url, new.remote_id,
                        CASE WHEN old.read != new.read THEN new.read END,
                        CASE WHEN old.starred != new.starred THEN new.starred END)
                ON CONFLICT(article_id) DO UPDATE SET
                    read = COALESCE(excluded.read, rss_account_changes.read),
                    starred = COALESCE(excluded.starred, rss_account_changes.starred);
             END;",
        )?;
        Ok(())
    }

    pub fn feed_accounts(&self) -> Result<Vec<FeedAccount>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, kind, name, server, username, filter_read, sort, last_sync, last_error,
                (SELECT COUNT(*) FROM rss_account_changes c
                 WHERE c.feed_url LIKE 'account:' || a.id || ':%')
             FROM rss_accounts a ORDER BY sort, added_at",
        )?;
        let accounts = statement
            .query_map([], |row| {
                Ok(FeedAccount {
                    id: row.get(0)?,
                    kind: kind_of(&row.get::<_, String>(1)?),
                    name: row.get(2)?,
                    server: row.get(3)?,
                    username: row.get(4)?,
                    filter_read: row.get(5)?,
                    sort: row.get(6)?,
                    last_sync: row.get(7)?,
                    last_error: row.get(8)?,
                    pending: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(accounts)
    }

    pub fn feed_account(&self, id: &str) -> Result<FeedAccount, AppError> {
        self.feed_accounts()?
            .into_iter()
            .find(|account| account.id == id)
            .ok_or_else(no_account)
    }

    pub fn account_login(&self, id: &str) -> Result<AccountLogin, AppError> {
        self.conn
            .query_row(
                "SELECT id, kind, name, server, username, password, token, since, filter_read
                 FROM rss_accounts WHERE id = ?1",
                params![id],
                |row| {
                    Ok(AccountLogin {
                        id: row.get(0)?,
                        kind: kind_of(&row.get::<_, String>(1)?),
                        name: row.get(2)?,
                        server: row.get(3)?,
                        username: row.get(4)?,
                        password: row.get(5)?,
                        token: row.get(6)?,
                        since: row.get(7)?,
                        filter_read: row.get(8)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(no_account)
    }

    /// Adds an account signed in to (`login`, with its token) or changes
    /// one; answers its id.
    pub fn save_feed_account(
        &self,
        request: &SaveFeedAccountRequest,
        login: &AccountLogin,
    ) -> Result<String, AppError> {
        let name = request.name.trim();
        let name = if name.is_empty() {
            login.username.as_str()
        } else {
            name
        };
        let sort: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort) + 1, 0) FROM rss_accounts",
            [],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO rss_accounts(id, kind, name, server, username, password, token,
                filter_read, sort, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
                password = excluded.password, token = excluded.token,
                filter_read = excluded.filter_read",
            params![
                login.id,
                kind_name(request.kind),
                name,
                login.server,
                login.username,
                login.password,
                login.token,
                request.filter_read,
                sort,
                now_millis()
            ],
        )?;
        Ok(login.id.clone())
    }

    pub fn set_account_token(&self, id: &str, token: Option<&str>) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE rss_accounts SET token = ?2 WHERE id = ?1",
            params![id, token],
        )?;
        Ok(())
    }

    /// A sync finished (`since` is where the next one starts) or failed.
    pub fn record_account_sync(
        &self,
        id: &str,
        since: Option<i64>,
        error: Option<&str>,
    ) -> Result<(), AppError> {
        self.conn.execute(
            "UPDATE rss_accounts SET last_sync = ?2, last_error = ?3,
                since = COALESCE(?4, since) WHERE id = ?1",
            params![id, now_millis(), error, since],
        )?;
        Ok(())
    }

    /// Removes an account from this device, with its feeds and articles
    /// (the service keeps them).
    pub fn remove_feed_account(&mut self, id: &str) -> Result<(), AppError> {
        let pattern = feeds_of(id);
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM rss_articles WHERE feed_url LIKE ?1",
            params![pattern],
        )?;
        tx.execute(
            "DELETE FROM rss_filters WHERE scope = 'feed' AND target LIKE ?1",
            params![pattern],
        )?;
        tx.execute("DELETE FROM rss_feeds WHERE account_id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM rss_account_changes WHERE feed_url LIKE ?1",
            params![pattern],
        )?;
        tx.execute("DELETE FROM rss_accounts WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// The accounts a refresh syncs: those named (all when `None`); with
    /// `due`, those whose last sync is `minutes` old.
    pub fn accounts_to_sync(
        &self,
        named: Option<&[String]>,
        due: bool,
        minutes: u32,
    ) -> Result<Vec<String>, AppError> {
        let now = now_millis();
        Ok(self
            .feed_accounts()?
            .into_iter()
            .filter(|account| named.is_none_or(|named| named.contains(&account.id)))
            .filter(|account| {
                !due || (minutes > 0
                    && account
                        .last_sync
                        .is_none_or(|last| now - last >= i64::from(minutes) * 60_000))
            })
            .map(|account| account.id)
            .collect())
    }

    /// The account's feeds as it lists them now: new ones added, changed
    /// ones updated (their own settings here stay), and those gone removed.
    pub fn store_account_feeds(
        &mut self,
        account: &str,
        feeds: &[AccountFeed],
    ) -> Result<(), AppError> {
        let now = now_millis();
        let tx = self.conn.transaction()?;
        let mut listed = HashSet::new();
        for (sort, feed) in feeds.iter().enumerate() {
            let url = account_feed_url(account, &feed.stream);
            tx.execute(
                "INSERT INTO rss_feeds(url, title, site_url, icon_url, group_name, sort, added_at,
                    updated_at, account_id, address)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9)
                 ON CONFLICT(url) DO UPDATE SET title = excluded.title,
                    site_url = excluded.site_url, icon_url = excluded.icon_url,
                    group_name = excluded.group_name, sort = excluded.sort,
                    address = excluded.address, updated_at = excluded.updated_at",
                params![
                    url,
                    feed.title,
                    feed.site_url,
                    feed.icon_url,
                    feed.group,
                    sort as i64,
                    now,
                    account,
                    feed.address
                ],
            )?;
            listed.insert(url);
        }
        tx.commit()?;
        let gone: Vec<String> = self
            .conn
            .prepare("SELECT url FROM rss_feeds WHERE account_id = ?1")?
            .query_map(params![account], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|url| !listed.contains(url))
            .collect();
        // Starred articles stay while the account keeps them starred.
        self.remove_feeds(&gone)
    }

    /// Of these item ids, those this device has neither stored nor cleared
    /// (nor kept out by a 过滤规则).
    pub fn unknown_account_items(
        &self,
        account: &str,
        remote_ids: &[String],
    ) -> Result<Vec<String>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT EXISTS(SELECT 1 FROM rss_articles WHERE id = ?1)
                 OR EXISTS(SELECT 1 FROM rss_cleared WHERE id = ?1)",
        )?;
        let mut unknown = Vec::new();
        for remote in remote_ids {
            let known: bool = statement
                .query_row(params![account_article_id(account, remote)], |row| {
                    row.get(0)
                })?;
            if !known {
                unknown.push(remote.clone());
            }
        }
        Ok(unknown)
    }

    /// Stores items the account sent. Those already here keep their marks
    /// (the sync's reconciling sets them); new ones pass the 过滤规则
    /// first, and those kept out are remembered so the account's lists do
    /// not bring them again (and, with `filter_read`, are marked read
    /// there).
    pub fn store_account_items(
        &mut self,
        account: &str,
        items: &[AccountItem],
        filter_read: bool,
    ) -> Result<StoredItems, AppError> {
        let now = now_millis();
        let settings = self.rss_settings();
        let tx = self.conn.transaction()?;
        let mut stored = StoredItems::default();
        let mut filters = std::collections::HashMap::new();
        let mut touched = std::collections::BTreeSet::new();
        for item in items {
            let url = account_feed_url(account, &item.stream);
            let id = account_article_id(account, &item.remote_id);
            let article = &item.article;
            let (known, cleared): (bool, bool) = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM rss_articles WHERE id = ?1),
                        EXISTS(SELECT 1 FROM rss_cleared WHERE id = ?1)",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if cleared {
                continue;
            }
            if known {
                tx.execute(
                    "UPDATE rss_articles SET title = ?2, link = ?3, author = ?4, excerpt = ?5,
                        image = ?6, content = ?7 WHERE id = ?1",
                    params![
                        id,
                        article.title,
                        article.link,
                        article.author,
                        article.excerpt,
                        article.image,
                        article.content
                    ],
                )?;
                super::rss::index_article(&tx, &id)?;
                continue;
            }
            if !filters.contains_key(&url) {
                filters.insert(url.clone(), Self::feed_filter_set(&tx, &url)?);
            }
            let set = &filters[&url];
            if !set.is_empty() && !super::rss::admitted(set, article) {
                tx.execute(
                    "INSERT OR IGNORE INTO rss_cleared(id, cleared_at) VALUES (?1, ?2)",
                    params![id, now],
                )?;
                if filter_read && !item.read {
                    tx.execute(
                        "INSERT INTO rss_account_changes(article_id, feed_url, remote_id, read)
                         VALUES (?1, ?2, ?3, 1)
                         ON CONFLICT(article_id) DO UPDATE SET read = 1",
                        params![id, url, item.remote_id],
                    )?;
                }
                stored.dropped += 1;
                continue;
            }
            let feed_title: String = tx
                .query_row(
                    "SELECT title FROM rss_feeds WHERE url = ?1",
                    params![url],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or_default();
            tx.execute(
                "INSERT INTO rss_articles(id, feed_url, feed_title, title, link, author,
                    published_at, fetched_at, excerpt, image, content, read, read_at, starred,
                    starred_at, remote_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                    CASE WHEN ?12 THEN ?8 END, ?13, CASE WHEN ?13 THEN ?8 END, ?14)",
                params![
                    id,
                    url,
                    feed_title,
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
                    article.content,
                    item.read,
                    item.starred,
                    item.remote_id
                ],
            )?;
            super::rss::index_article(&tx, &id)?;
            stored.added += 1;
            touched.insert(url);
        }
        // Unread articles are the account's to keep; read ones go as
        // a feed of the device's own would.
        for url in touched {
            let kept: (Option<u32>, Option<u32>) = tx
                .query_row(
                    "SELECT keep_articles, keep_days FROM rss_feeds WHERE url = ?1",
                    params![url],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .unwrap_or_default();
            super::rss::prune_feed(
                &tx,
                &url,
                now,
                kept.0.unwrap_or(settings.keep_articles),
                kept.1.unwrap_or(settings.keep_days),
                true,
            )?;
        }
        tx.commit()?;
        Ok(stored)
    }

    /// Takes the account's marks: an article is read unless it is among
    /// `unread`, and starred if it is among `starred`. A list the account
    /// gave only part of (`complete` false) only adds its marks. Marks made
    /// here and not written yet stay.
    pub fn reconcile_account(
        &mut self,
        account: &str,
        unread: &HashSet<String>,
        unread_complete: bool,
        starred: &HashSet<String>,
        starred_complete: bool,
    ) -> Result<(), AppError> {
        let now = now_millis();
        let tx = self.conn.transaction()?;
        type Marks = (String, String, bool, bool);
        let rows: Vec<Marks> = tx
            .prepare(
                "SELECT id, remote_id, read, starred FROM rss_articles
                 WHERE remote_id IS NOT NULL AND feed_url LIKE ?1
                   AND id NOT IN (SELECT article_id FROM rss_account_changes)",
            )?
            .query_map(params![feeds_of(account)], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?;
        let mut changed = Vec::new();
        for (id, remote, read, star) in rows {
            let is_unread = unread.contains(&remote);
            let read_now = if is_unread {
                false
            } else if unread_complete {
                true
            } else {
                read
            };
            let is_starred = starred.contains(&remote);
            let star_now = is_starred || (!starred_complete && star);
            if read_now != read {
                tx.execute(
                    "UPDATE rss_articles SET read = ?2,
                        read_at = CASE WHEN ?2 THEN ?3 END,
                        keep_unread = CASE WHEN ?2 THEN 0 ELSE keep_unread END
                     WHERE id = ?1",
                    params![id, read_now, now],
                )?;
            }
            if star_now != star {
                tx.execute(
                    "UPDATE rss_articles SET starred = ?2, starred_at = CASE WHEN ?2 THEN ?3 END
                     WHERE id = ?1",
                    params![id, star_now, now],
                )?;
            }
            if read_now != read || star_now != star {
                changed.push(id);
            }
        }
        // The account's own marks are not written back to it.
        for id in &changed {
            tx.execute(
                "DELETE FROM rss_account_changes WHERE article_id = ?1",
                params![id],
            )?;
        }
        // Unstarred, an article whose feed has gone has nothing to keep it.
        tx.execute(
            "DELETE FROM rss_articles WHERE starred = 0 AND remote_id IS NOT NULL
               AND feed_url LIKE ?1 AND feed_url NOT IN (SELECT url FROM rss_feeds)",
            params![feeds_of(account)],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Marks made here and not yet written to the account.
    pub fn pending_marks(&self, account: &str) -> Result<Vec<PendingMark>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT article_id, remote_id, read, starred FROM rss_account_changes
             WHERE feed_url LIKE ?1 ORDER BY article_id",
        )?;
        let marks = statement
            .query_map(params![feeds_of(account)], |row| {
                Ok(PendingMark {
                    article_id: row.get(0)?,
                    remote_id: row.get(1)?,
                    read: row.get(2)?,
                    starred: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(marks)
    }

    /// Marks written to the account; one changed again since stays.
    pub fn clear_pending_marks(&mut self, marks: &[PendingMark]) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        for mark in marks {
            tx.execute(
                "DELETE FROM rss_account_changes
                 WHERE article_id = ?1 AND read IS ?2 AND starred IS ?3",
                params![mark.article_id, mark.read, mark.starred],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The account of an account feed, with its stream there.
    pub fn account_feed(&self, url: &str) -> Result<Option<(String, String)>, AppError> {
        let Some((account, stream)) = feed_account(url) else {
            return Ok(None);
        };
        let known: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM rss_feeds WHERE url = ?1 AND account_id = ?2)",
            params![url, account],
            |row| row.get(0),
        )?;
        Ok(known.then(|| (account.to_string(), stream.to_string())))
    }
}
