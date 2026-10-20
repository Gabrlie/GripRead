//! 过滤规则 kept with the feeds: for all of them, a group, or one feed.
//! They sync as `rss-filter:<id>` records, so the server filters what it
//! fetches the same way. A feed's new address or a group's new name takes
//! its rules along.

use super::*;
use crate::models::{FeedFilter, FeedFilterField, FeedFilterMode, FeedFilterScope, FeedFilterTest};
use crate::rss::filter::{compile, ArticleText, FilterSet};
use serde_json::Value;

/// How many of the newest articles a rule is tried on before saving.
const TEST_ARTICLES: u32 = 2000;
const TEST_SAMPLES: usize = 5;

fn scope_name(scope: FeedFilterScope) -> &'static str {
    match scope {
        FeedFilterScope::All => "all",
        FeedFilterScope::Group => "group",
        FeedFilterScope::Feed => "feed",
    }
}

fn scope_of(name: &str) -> FeedFilterScope {
    match name {
        "group" => FeedFilterScope::Group,
        "feed" => FeedFilterScope::Feed,
        _ => FeedFilterScope::All,
    }
}

fn field_name(field: FeedFilterField) -> &'static str {
    match field {
        FeedFilterField::Title => "title",
        FeedFilterField::Author => "author",
        FeedFilterField::Content => "content",
        FeedFilterField::Any => "any",
    }
}

fn field_of(name: &str) -> FeedFilterField {
    match name {
        "author" => FeedFilterField::Author,
        "content" => FeedFilterField::Content,
        "any" => FeedFilterField::Any,
        _ => FeedFilterField::Title,
    }
}

fn filter_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedFilter> {
    Ok(FeedFilter {
        id: row.get(0)?,
        scope: scope_of(&row.get::<_, String>(1)?),
        target: row.get(2)?,
        field: field_of(&row.get::<_, String>(3)?),
        mode: if row.get::<_, String>(4)? == "keep" {
            FeedFilterMode::Keep
        } else {
            FeedFilterMode::Drop
        },
        pattern: row.get(5)?,
        ignore_case: row.get(6)?,
        enabled: row.get(7)?,
        sort: row.get(8)?,
    })
}

const FILTER_COLUMNS: &str = "id, scope, target, field, mode, pattern, ignore_case, enabled, sort";

/// A rule as kept: a known scope with a target, and an expression that
/// compiles.
fn checked(filter: &FeedFilter) -> Result<FeedFilter, AppError> {
    compile(&filter.pattern, filter.ignore_case)?;
    let target = filter
        .target
        .as_deref()
        .map(str::trim)
        .filter(|target| !target.is_empty())
        .map(str::to_string);
    if filter.scope != FeedFilterScope::All && target.is_none() {
        return Err(AppError::keyed(
            ErrorCode::InvalidArgument,
            "rssFilterTarget",
            "请选择规则适用的分组或订阅",
        ));
    }
    Ok(FeedFilter {
        target: if filter.scope == FeedFilterScope::All {
            None
        } else {
            target
        },
        ..filter.clone()
    })
}

/// What a rule matches in a stored article.
struct StoredText {
    id: String,
    title: String,
    author: String,
    starred: bool,
    html: String,
}

impl StoredText {
    fn admitted_by(&self, set: &FilterSet) -> bool {
        let body = if set.reads_body() {
            crate::rss::plain_text(&self.html)
        } else {
            String::new()
        };
        set.admits(&ArticleText {
            title: &self.title,
            author: &self.author,
            body: &body,
        })
    }
}

impl Storage {
    pub fn feed_filters(&self) -> Result<Vec<FeedFilter>, AppError> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {FILTER_COLUMNS} FROM rss_filters ORDER BY sort, updated_at, id"
        ))?;
        let filters = statement
            .query_map([], filter_of)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(filters)
    }

    /// The rules new articles of this feed are checked against.
    pub(super) fn feed_filter_set(
        tx: &rusqlite::Connection,
        url: &str,
    ) -> Result<FilterSet, AppError> {
        let mut statement = tx.prepare(&format!(
            "SELECT {FILTER_COLUMNS} FROM rss_filters WHERE enabled = 1 AND (scope = 'all'
               OR (scope = 'feed' AND target = ?1)
               OR (scope = 'group' AND target =
                    (SELECT group_name FROM rss_feeds WHERE url = ?1 AND account_id IS NULL)))"
        ))?;
        let filters = statement
            .query_map(params![url], filter_of)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(FilterSet::new(&filters))
    }

    /// Adds or changes a rule (a new one gets an id and goes last); with
    /// `purge`, stored articles it would not let in go too.
    pub fn save_feed_filter(
        &mut self,
        filter: &FeedFilter,
        purge: bool,
    ) -> Result<FeedFilter, AppError> {
        let mut filter = checked(filter)?;
        if filter.id.is_empty() {
            filter.id = Uuid::new_v4().to_string();
            filter.sort = self.conn.query_row(
                "SELECT COALESCE(MAX(sort) + 1, 0) FROM rss_filters",
                [],
                |row| row.get(0),
            )?;
        }
        self.write_feed_filter(&filter)?;
        if purge {
            self.purge_filtered(&filter)?;
        }
        Ok(filter)
    }

    fn write_feed_filter(&self, filter: &FeedFilter) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT INTO rss_filters(id, scope, target, field, mode, pattern, ignore_case,
                enabled, sort, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, target = excluded.target,
                field = excluded.field, mode = excluded.mode, pattern = excluded.pattern,
                ignore_case = excluded.ignore_case, enabled = excluded.enabled,
                sort = excluded.sort, updated_at = excluded.updated_at",
            params![
                filter.id,
                scope_name(filter.scope),
                filter.target,
                field_name(filter.field),
                if filter.mode == FeedFilterMode::Keep {
                    "keep"
                } else {
                    "drop"
                },
                filter.pattern,
                filter.ignore_case,
                filter.enabled,
                filter.sort,
                now_millis()
            ],
        )?;
        Ok(())
    }

    pub fn remove_feed_filter(&self, id: &str) -> Result<(), AppError> {
        self.conn
            .execute("DELETE FROM rss_filters WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// The stored articles a rule applies to, newest first.
    fn filter_articles(
        &self,
        filter: &FeedFilter,
        limit: Option<u32>,
    ) -> Result<Vec<StoredText>, AppError> {
        let scope = match filter.scope {
            FeedFilterScope::All => "f.url IS NOT NULL AND ?1 IS NULL",
            FeedFilterScope::Group => "f.group_name = ?1 AND f.account_id IS NULL",
            FeedFilterScope::Feed => "a.feed_url = ?1",
        };
        let body = if matches!(
            filter.field,
            FeedFilterField::Content | FeedFilterField::Any
        ) {
            "CASE WHEN a.content != '' THEN a.content ELSE a.excerpt END"
        } else {
            "''"
        };
        let mut statement = self.conn.prepare(&format!(
            "SELECT a.id, a.title, COALESCE(a.author, ''), a.starred, {body}
             FROM rss_articles a LEFT JOIN rss_feeds f ON f.url = a.feed_url
             WHERE {scope}
             ORDER BY a.published_at DESC, a.id DESC LIMIT ?2"
        ))?;
        let rows = statement
            .query_map(params![filter.target, limit.map_or(-1, i64::from)], |row| {
                Ok(StoredText {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    author: row.get(2)?,
                    starred: row.get(3)?,
                    html: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// How many of the newest articles a rule would have kept out.
    pub fn test_feed_filter(&self, filter: &FeedFilter) -> Result<FeedFilterTest, AppError> {
        let filter = checked(filter)?;
        let set = FilterSet::new([&filter]);
        let mut test = FeedFilterTest::default();
        for article in self.filter_articles(&filter, Some(TEST_ARTICLES))? {
            test.checked += 1;
            if !article.admitted_by(&set) {
                test.dropped += 1;
                if test.samples.len() < TEST_SAMPLES {
                    test.samples.push(article.title);
                }
            }
        }
        Ok(test)
    }

    /// Removes the stored articles a rule would not let in, but starred.
    fn purge_filtered(&mut self, filter: &FeedFilter) -> Result<u32, AppError> {
        let set = FilterSet::new([filter]);
        let ids: Vec<String> = self
            .filter_articles(filter, None)?
            .into_iter()
            .filter(|article| !article.starred && !article.admitted_by(&set))
            .map(|article| article.id)
            .collect();
        let tx = self.conn.transaction()?;
        for id in &ids {
            tx.execute("DELETE FROM rss_articles WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(ids.len() as u32)
    }

    pub(super) fn filter_records(&self) -> Result<Vec<(String, Value)>, AppError> {
        self.feed_filters()?
            .into_iter()
            .map(|filter| {
                Ok((
                    format!("rss-filter:{}", filter.id),
                    serde_json::to_value(&filter)?,
                ))
            })
            .collect()
    }

    /// A rule made or changed elsewhere, or removed there.
    pub(super) fn apply_filter_record(
        &mut self,
        id: &str,
        value: Option<&Value>,
    ) -> Result<(), AppError> {
        let Some(value) = value else {
            return self.remove_feed_filter(id);
        };
        let filter = FeedFilter {
            id: id.to_string(),
            ..serde_json::from_value(value.clone())?
        };
        self.restore_feed_filter(&filter)
    }

    /// A rule from a sync or backup record; one this version cannot
    /// compile is kept as it is, but not used.
    pub(super) fn restore_feed_filter(&self, filter: &FeedFilter) -> Result<(), AppError> {
        if filter.id.is_empty() {
            return Ok(());
        }
        self.write_feed_filter(filter)
    }
}

/// A feed's rules follow it to its new address.
pub(super) fn move_feed_filters(
    tx: &rusqlite::Transaction<'_>,
    from: &str,
    to: &str,
) -> Result<(), AppError> {
    tx.execute(
        "UPDATE rss_filters SET target = ?2, updated_at = ?3 WHERE scope = 'feed' AND target = ?1",
        params![from, to, now_millis()],
    )?;
    Ok(())
}
