//! Book sources on the device: the imported JSON, Legado's management
//! fields, and the cache, cookies, and login state source scripts keep.
//! Login state and cookies never leave the device.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value as Json};

use super::*;
use crate::models::{
    BookSourceDetail, BookSourceSummary, ImportSourcesRequest, SourceImportItem,
    SourceImportPreview, SourceImportStatus, SourceSwitch,
};
use crate::sources::context::SourceStore;
use crate::sources::model::{parse_sources, BookSource};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::invalid_argument(message)
}

/// Splits Legado's group text (`,` `;` `，` separated) into names.
pub fn split_groups(group: &str) -> Vec<String> {
    group
        .split([',', ';', '，', '；'])
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

fn join_groups(groups: &[String]) -> String {
    groups.join(",")
}

pub fn summary_of(source: &BookSource) -> BookSourceSummary {
    BookSourceSummary {
        url: source.url(),
        name: source.name(),
        group: source.group(),
        enabled: source.enabled(),
        enabled_explore: source.enabled_explore(),
        has_explore: source
            .explore_url()
            .is_some_and(|url| !url.trim().is_empty()),
        has_search: source
            .search_url()
            .is_some_and(|url| !url.trim().is_empty()),
        has_login: source.login_url().is_some_and(|url| !url.trim().is_empty())
            || source.login_ui().is_some_and(|ui| !ui.trim().is_empty()),
        custom_order: source.custom_order(),
        weight: source.weight(),
        last_update_time: source.last_update_time(),
        respond_time: source.respond_time(),
        comment: source.comment().unwrap_or_default(),
    }
}

/// Reads one source for saving: an object with an address and a name, of
/// the text type GripRead reads.
fn validated(value: Json) -> Result<BookSource, String> {
    let source = BookSource::from_value(value)?;
    if source.name().trim().is_empty() {
        return Err(format!("书源 {} 没有名称", source.url()));
    }
    if source.source_type() != 0 {
        return Err(format!("{} 不是文本书源", source.name()));
    }
    Ok(source)
}

impl Storage {
    /// A stored source as the engine reads it.
    pub fn book_source(&self, url: &str) -> Result<Option<BookSource>, AppError> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT raw_json FROM book_sources WHERE url = ?1",
                params![url],
                |row| row.get(0),
            )
            .optional()?;
        match raw {
            Some(raw) => {
                let value: Json = serde_json::from_str(&raw)?;
                Ok(Some(BookSource::from_value(value).map_err(invalid)?))
            }
            None => Ok(None),
        }
    }

    fn required_source(&self, url: &str) -> Result<BookSource, AppError> {
        self.book_source(url)?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, format!("没有这个书源：{url}")))
    }

    /// Every stored source, in the manual order.
    pub fn book_sources(&self) -> Result<Vec<BookSource>, AppError> {
        let mut statement = self
            .conn
            .prepare("SELECT raw_json FROM book_sources ORDER BY custom_order, name, url")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut sources = Vec::new();
        for raw in rows {
            let value: Json = serde_json::from_str(&raw?)?;
            if let Ok(source) = BookSource::from_value(value) {
                sources.push(source);
            }
        }
        Ok(sources)
    }

    pub fn list_book_sources(&self) -> Result<Vec<BookSourceSummary>, AppError> {
        Ok(self.book_sources()?.iter().map(summary_of).collect())
    }

    pub fn book_source_detail(&self, url: &str) -> Result<BookSourceDetail, AppError> {
        let source = self.required_source(url)?;
        Ok(BookSourceDetail {
            summary: summary_of(&source),
            json: serde_json::to_string_pretty(&source.raw)?,
        })
    }

    /// What importing `json` would add or update, without saving.
    pub fn preview_source_import(&self, json: &str) -> Result<SourceImportPreview, AppError> {
        let values = parse_sources(json).map_err(invalid)?;
        let mut preview = SourceImportPreview {
            items: Vec::new(),
            skipped: 0,
            invalid: Vec::new(),
        };
        for value in values {
            let typed = value.get("bookSourceType").cloned();
            match validated(value) {
                Ok(source) => {
                    let existing = self.book_source(&source.url())?;
                    let status = match existing {
                        None => SourceImportStatus::New,
                        Some(local) if source.last_update_time() > local.last_update_time() => {
                            SourceImportStatus::Update
                        }
                        Some(_) => SourceImportStatus::Existing,
                    };
                    if preview.items.iter().any(|item| item.url == source.url()) {
                        continue;
                    }
                    preview.items.push(SourceImportItem {
                        url: source.url(),
                        name: source.name(),
                        group: source.group(),
                        status,
                    });
                }
                Err(_) if typed.is_some_and(|kind| kind.as_i64().unwrap_or(0) != 0) => {
                    preview.skipped += 1
                }
                Err(error) => preview.invalid.push(error),
            }
        }
        Ok(preview)
    }

    /// Saves the chosen sources from `json`, keeping local name, groups, or
    /// switches where asked.
    pub fn import_sources(
        &mut self,
        request: &ImportSourcesRequest,
    ) -> Result<Vec<BookSourceSummary>, AppError> {
        let values = parse_sources(&request.json).map_err(invalid)?;
        let tx = self.conn.transaction()?;
        let mut saved = Vec::new();
        {
            let storage = TransactionStorage(&tx);
            for value in values {
                let Ok(mut source) = validated(value) else {
                    continue;
                };
                let url = source.url();
                if !request.urls.contains(&url)
                    || saved.iter().any(|item: &BookSourceSummary| item.url == url)
                {
                    continue;
                }
                if let Some(local) = storage.source(&url)? {
                    if request.keep_name {
                        source
                            .raw
                            .insert("bookSourceName".into(), Json::String(local.name()));
                    }
                    if request.keep_group {
                        source
                            .raw
                            .insert("bookSourceGroup".into(), Json::String(local.group()));
                    }
                    if request.keep_enabled {
                        source
                            .raw
                            .insert("enabled".into(), Json::Bool(local.enabled()));
                        source
                            .raw
                            .insert("enabledExplore".into(), Json::Bool(local.enabled_explore()));
                    }
                    source
                        .raw
                        .insert("customOrder".into(), Json::from(local.custom_order()));
                }
                storage.store(&source)?;
                saved.push(summary_of(&source));
            }
        }
        tx.commit()?;
        Ok(saved)
    }

    /// Saves an edited source; a changed address replaces the old entry.
    pub fn save_book_source(
        &mut self,
        json: &str,
        previous_url: Option<&str>,
    ) -> Result<BookSourceSummary, AppError> {
        let value = crate::sources::lenient_json::parse(json)
            .map_err(|error| invalid(format!("书源 JSON 无法解析：{error}")))?;
        let mut source = validated(value).map_err(invalid)?;
        let url = source.url();
        if !source.raw.contains_key("customOrder") {
            let lowest: Option<i64> =
                self.conn
                    .query_row("SELECT MIN(custom_order) FROM book_sources", [], |row| {
                        row.get(0)
                    })?;
            source
                .raw
                .insert("customOrder".into(), Json::from(lowest.unwrap_or(0) - 1));
        }
        source
            .raw
            .insert("lastUpdateTime".into(), Json::from(now_millis()));
        let tx = self.conn.transaction()?;
        {
            let storage = TransactionStorage(&tx);
            if let Some(previous) = previous_url.filter(|previous| *previous != url) {
                tx.execute("DELETE FROM book_sources WHERE url = ?1", params![previous])?;
            }
            storage.store(&source)?;
        }
        tx.commit()?;
        Ok(summary_of(&source))
    }

    pub fn delete_book_sources(&mut self, urls: &[String]) -> Result<(), AppError> {
        let tx = self.conn.transaction()?;
        for url in urls {
            tx.execute("DELETE FROM book_sources WHERE url = ?1", params![url])?;
        }
        tx.commit()?;
        Ok(())
    }

    fn update_sources(
        &mut self,
        urls: &[String],
        mut change: impl FnMut(&mut Map<String, Json>, &BookSource),
    ) -> Result<(), AppError> {
        let sources: Vec<BookSource> = urls
            .iter()
            .filter_map(|url| self.book_source(url).transpose())
            .collect::<Result<_, _>>()?;
        let tx = self.conn.transaction()?;
        {
            let storage = TransactionStorage(&tx);
            for source in sources {
                let mut updated = source.clone();
                change(&mut updated.raw, &source);
                storage.store(&updated)?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_sources_switch(
        &mut self,
        urls: &[String],
        switch: SourceSwitch,
        on: bool,
    ) -> Result<(), AppError> {
        let field = match switch {
            SourceSwitch::Enabled => "enabled",
            SourceSwitch::Explore => "enabledExplore",
        };
        self.update_sources(urls, |raw, _| {
            raw.insert(field.into(), Json::Bool(on));
        })
    }

    pub fn change_sources_group(
        &mut self,
        urls: &[String],
        group: &str,
        add: bool,
    ) -> Result<(), AppError> {
        let wanted = split_groups(group);
        self.update_sources(urls, |raw, source| {
            let mut groups = split_groups(&source.group());
            for name in &wanted {
                if add {
                    if !groups.contains(name) {
                        groups.push(name.clone());
                    }
                } else {
                    groups.retain(|existing| existing != name);
                }
            }
            raw.insert("bookSourceGroup".into(), Json::String(join_groups(&groups)));
        })
    }

    /// Moves sources before or after all others in the manual order.
    pub fn move_sources(&mut self, urls: &[String], top: bool) -> Result<(), AppError> {
        let (low, high): (Option<i64>, Option<i64>) = self.conn.query_row(
            "SELECT MIN(custom_order), MAX(custom_order) FROM book_sources",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let count = urls.len() as i64;
        let start = if top {
            low.unwrap_or(0) - count
        } else {
            high.unwrap_or(0) + 1
        };
        let positions: Vec<(String, i64)> = urls
            .iter()
            .enumerate()
            .map(|(index, url)| (url.clone(), start + index as i64))
            .collect();
        self.update_sources(urls, |raw, source| {
            if let Some((_, order)) = positions.iter().find(|(url, _)| *url == source.url()) {
                raw.insert("customOrder".into(), Json::from(*order));
            }
        })
    }

    /// The sources as Legado's export: a JSON array.
    pub fn export_book_sources(&self, urls: &[String]) -> Result<String, AppError> {
        let mut list = Vec::new();
        for source in self.book_sources()? {
            if urls.is_empty() || urls.contains(&source.url()) {
                list.push(Json::Object(source.raw));
            }
        }
        Ok(serde_json::to_string_pretty(&Json::Array(list))?)
    }

    /// Records a check outcome as Legado does: failure groups and an error
    /// comment on failure, both removed on success, and the response time.
    pub fn record_source_check(
        &mut self,
        url: &str,
        failures: &[String],
        error: Option<&str>,
        respond_ms: i64,
        disable_failed: bool,
    ) -> Result<(), AppError> {
        let urls = vec![url.to_string()];
        self.update_sources(&urls, |raw, source| {
            // A source whose search chain passes is enabled again; a failed
            // 发现 only turns 发现 off.
            if disable_failed {
                let search_failed = failures.iter().any(|group| !group.starts_with("发现"));
                raw.insert("enabled".into(), Json::Bool(!search_failed));
                if !search_failed && !failures.is_empty() {
                    raw.insert("enabledExplore".into(), Json::Bool(false));
                }
            }
            let mut groups: Vec<String> = split_groups(&source.group())
                .into_iter()
                .filter(|group| !CHECK_GROUPS.contains(&group.as_str()))
                .collect();
            for failure in failures {
                if !groups.contains(failure) {
                    groups.push(failure.clone());
                }
            }
            raw.insert("bookSourceGroup".into(), Json::String(join_groups(&groups)));
            let comment = source.comment().unwrap_or_default();
            let kept: String = comment
                .split("\n\n")
                .filter(|part| !part.starts_with("// Error: "))
                .collect::<Vec<_>>()
                .join("\n\n");
            let comment = match error {
                Some(error) if kept.is_empty() => format!("// Error: {error}"),
                Some(error) => format!("// Error: {error}\n\n{kept}"),
                None => kept,
            };
            raw.insert("bookSourceComment".into(), Json::String(comment));
            raw.insert("respondTime".into(), Json::from(respond_ms));
        })
    }

    pub fn source_cache_get(&self, key: &str) -> Result<Option<String>, AppError> {
        let row: Option<(String, Option<i64>)> = self
            .conn
            .query_row(
                "SELECT value, expires_at FROM source_cache WHERE key = ?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((_, Some(expires))) if expires <= now_millis() => None,
            Some((value, _)) => Some(value),
            None => None,
        })
    }

    pub fn source_cache_put(
        &self,
        key: &str,
        value: &str,
        save_seconds: i64,
    ) -> Result<(), AppError> {
        let expires = (save_seconds > 0).then(|| now_millis() + save_seconds * 1000);
        self.conn.execute(
            "INSERT INTO source_cache(key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, value, expires],
        )?;
        Ok(())
    }

    pub fn source_cache_delete(&self, key: &str) -> Result<(), AppError> {
        self.conn
            .execute("DELETE FROM source_cache WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn source_cookie(&self, domain: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .conn
            .query_row(
                "SELECT cookie FROM source_cookies WHERE domain = ?1",
                params![domain],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn put_source_cookie(&self, domain: &str, cookie: &str) -> Result<(), AppError> {
        self.conn.execute(
            "INSERT INTO source_cookies(domain, cookie) VALUES (?1, ?2)
             ON CONFLICT(domain) DO UPDATE SET cookie = excluded.cookie",
            params![domain, cookie],
        )?;
        Ok(())
    }

    pub fn remove_source_cookie(&self, domain: &str) -> Result<(), AppError> {
        self.conn.execute(
            "DELETE FROM source_cookies WHERE domain = ?1",
            params![domain],
        )?;
        Ok(())
    }
}

/// Groups a source check adds and later clears, as Legado names them.
pub const CHECK_GROUPS: &[&str] = &[
    "失效",
    "网站失效",
    "js失效",
    "校验超时",
    "搜索失效",
    "发现失效",
    "详情失效",
    "目录失效",
    "正文失效",
    "搜索链接规则为空",
    "发现规则为空",
];

/// Source writes inside one transaction.
struct TransactionStorage<'a>(&'a rusqlite::Transaction<'a>);

impl TransactionStorage<'_> {
    fn source(&self, url: &str) -> Result<Option<BookSource>, AppError> {
        let raw: Option<String> = self
            .0
            .query_row(
                "SELECT raw_json FROM book_sources WHERE url = ?1",
                params![url],
                |row| row.get(0),
            )
            .optional()?;
        match raw {
            Some(raw) => Ok(BookSource::from_value(serde_json::from_str(&raw)?).ok()),
            None => Ok(None),
        }
    }

    fn store(&self, source: &BookSource) -> Result<(), AppError> {
        let summary = summary_of(source);
        let raw = serde_json::to_string(&source.raw)?;
        self.0.execute(
            "INSERT INTO book_sources(url, name, source_group, enabled, enabled_explore, custom_order,
                 weight, last_update_time, respond_time, raw_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(url) DO UPDATE SET name = excluded.name, source_group = excluded.source_group,
                 enabled = excluded.enabled, enabled_explore = excluded.enabled_explore,
                 custom_order = excluded.custom_order, weight = excluded.weight,
                 last_update_time = excluded.last_update_time, respond_time = excluded.respond_time,
                 raw_json = excluded.raw_json, updated_at = excluded.updated_at",
            params![
                summary.url,
                summary.name,
                summary.group,
                summary.enabled,
                summary.enabled_explore,
                summary.custom_order,
                summary.weight,
                summary.last_update_time,
                summary.respond_time,
                raw,
                now_millis(),
            ],
        )?;
        Ok(())
    }
}

/// The engine's view of source data, kept in the application database.
pub struct SqliteSourceStore {
    storage: Arc<Mutex<Storage>>,
}

impl SqliteSourceStore {
    pub fn new(storage: Arc<Mutex<Storage>>) -> Self {
        Self { storage }
    }

    fn with<T: Default>(&self, read: impl FnOnce(&Storage) -> Result<T, AppError>) -> T {
        match self.storage.lock() {
            Ok(storage) => read(&storage).unwrap_or_default(),
            Err(_) => T::default(),
        }
    }
}

impl SourceStore for SqliteSourceStore {
    fn cache_get(&self, key: &str) -> Option<String> {
        self.with(|storage| storage.source_cache_get(key))
    }

    fn cache_put(&self, key: &str, value: &str, save_seconds: i64) {
        self.with(|storage| storage.source_cache_put(key, value, save_seconds));
    }

    fn cache_delete(&self, key: &str) {
        self.with(|storage| storage.source_cache_delete(key));
    }

    fn cookie_get(&self, domain: &str) -> Option<String> {
        self.with(|storage| storage.source_cookie(domain))
    }

    fn cookie_put(&self, domain: &str, cookie: &str) {
        self.with(|storage| storage.put_source_cookie(domain, cookie));
    }

    fn cookie_remove(&self, domain: &str) {
        self.with(|storage| storage.remove_source_cookie(domain));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage() -> (tempfile_dir::Dir, Storage) {
        let dir = tempfile_dir::Dir::new();
        let storage = Storage::open(dir.path()).unwrap();
        (dir, storage)
    }

    mod tempfile_dir {
        pub struct Dir(std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let path =
                    std::env::temp_dir().join(format!("gripread-sources-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&path).unwrap();
                Dir(path)
            }
            pub fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    const SOURCES: &str = r#"[
      {"bookSourceUrl":"https://a.com","bookSourceName":"甲","bookSourceGroup":"常用","lastUpdateTime":10,"searchUrl":"/s?q={{key}}","unknownField":{"x":1}},
      {"bookSourceUrl":"https://b.com","bookSourceName":"乙","lastUpdateTime":5,"exploreUrl":"榜::/r","loginUrl":"function login(){}"},
      {"bookSourceUrl":"https://audio.com","bookSourceName":"音","bookSourceType":1},
      {"bookSourceName":"缺地址"}
    ]"#;

    #[test]
    fn import_previews_then_saves_chosen_sources_keeping_unknown_fields() {
        let (_dir, mut storage) = storage();
        let preview = storage.preview_source_import(SOURCES).unwrap();
        assert_eq!(preview.items.len(), 2);
        assert_eq!(preview.skipped, 1);
        assert_eq!(preview.invalid.len(), 1);
        assert!(preview
            .items
            .iter()
            .all(|item| item.status == SourceImportStatus::New));
        let saved = storage
            .import_sources(&ImportSourcesRequest {
                json: SOURCES.into(),
                urls: vec!["https://a.com".into(), "https://b.com".into()],
                keep_name: true,
                keep_group: true,
                keep_enabled: true,
            })
            .unwrap();
        assert_eq!(saved.len(), 2);
        let list = storage.list_book_sources().unwrap();
        let find = |url: &str| list.iter().find(|item| item.url == url).unwrap().clone();
        assert!(find("https://a.com").has_search && !find("https://a.com").has_explore);
        assert!(find("https://b.com").has_explore && find("https://b.com").has_login);
        assert!(storage
            .book_source_detail("https://a.com")
            .unwrap()
            .json
            .contains("unknownField"));

        // A newer copy is an update; local name and switches stay when asked.
        storage
            .set_sources_switch(&["https://a.com".into()], SourceSwitch::Enabled, false)
            .unwrap();
        let newer =
            r#"{"bookSourceUrl":"https://a.com","bookSourceName":"甲新","lastUpdateTime":20}"#;
        let preview = storage.preview_source_import(newer).unwrap();
        assert_eq!(preview.items[0].status, SourceImportStatus::Update);
        storage
            .import_sources(&ImportSourcesRequest {
                json: newer.into(),
                urls: vec!["https://a.com".into()],
                keep_name: true,
                keep_group: true,
                keep_enabled: true,
            })
            .unwrap();
        let a = storage.book_source("https://a.com").unwrap().unwrap();
        assert_eq!(a.name(), "甲");
        assert_eq!(a.group(), "常用");
        assert!(!a.enabled());
        assert_eq!(a.last_update_time(), 20);
    }

    #[test]
    fn groups_order_switches_and_checks_update_the_json() {
        let (_dir, mut storage) = storage();
        let urls: Vec<String> = vec!["https://a.com".into(), "https://b.com".into()];
        storage
            .import_sources(&ImportSourcesRequest {
                json: SOURCES.into(),
                urls: urls.clone(),
                keep_name: false,
                keep_group: false,
                keep_enabled: false,
            })
            .unwrap();
        storage
            .change_sources_group(&urls, "新;常用", true)
            .unwrap();
        assert_eq!(
            storage
                .book_source("https://a.com")
                .unwrap()
                .unwrap()
                .group(),
            "常用,新"
        );
        storage.change_sources_group(&urls, "常用", false).unwrap();
        assert_eq!(
            storage
                .book_source("https://b.com")
                .unwrap()
                .unwrap()
                .group(),
            "新"
        );
        storage
            .move_sources(&["https://b.com".into()], true)
            .unwrap();
        assert_eq!(storage.list_book_sources().unwrap()[0].url, "https://b.com");
        storage
            .record_source_check(
                "https://a.com",
                &["网站失效".into()],
                Some("连接失败"),
                900,
                false,
            )
            .unwrap();
        let a = storage.book_source("https://a.com").unwrap().unwrap();
        assert!(a.group().contains("网站失效"));
        assert!(a.comment().unwrap().starts_with("// Error: 连接失败"));
        storage
            .record_source_check("https://a.com", &[], None, 300, true)
            .unwrap();
        let a = storage.book_source("https://a.com").unwrap().unwrap();
        assert!(!a.group().contains("网站失效"));
        assert_eq!(a.comment().unwrap_or_default(), "");
        assert_eq!(a.respond_time(), 300);
        assert!(a.enabled(), "a passing check enables the source again");
        storage
            .set_sources_switch(&["https://a.com".into()], SourceSwitch::Enabled, false)
            .unwrap();
        storage
            .record_source_check("https://a.com", &[], None, 300, false)
            .unwrap();
        let a = storage.book_source("https://a.com").unwrap().unwrap();
        assert!(!a.enabled(), "without the option a check changes no switch");
        storage
            .record_source_check("https://a.com", &[], None, 300, true)
            .unwrap();
        storage
            .record_source_check("https://a.com", &["发现失效".into()], Some("空"), 300, true)
            .unwrap();
        let a = storage.book_source("https://a.com").unwrap().unwrap();
        assert!(a.enabled() && !a.enabled_explore(), "only explore fails");
        storage
            .record_source_check("https://a.com", &["目录失效".into()], Some("空"), 300, true)
            .unwrap();
        assert!(!storage
            .book_source("https://a.com")
            .unwrap()
            .unwrap()
            .enabled());
        let exported: Json =
            serde_json::from_str(&storage.export_book_sources(&[]).unwrap()).unwrap();
        assert_eq!(exported.as_array().unwrap().len(), 2);
    }

    #[test]
    fn edited_sources_replace_their_old_address_and_cache_expires() {
        let (_dir, mut storage) = storage();
        storage
            .save_book_source(
                r#"{"bookSourceUrl":"https://old.com","bookSourceName":"旧"}"#,
                None,
            )
            .unwrap();
        storage
            .save_book_source(
                r#"{"bookSourceUrl":"https://new.com","bookSourceName":"新"}"#,
                Some("https://old.com"),
            )
            .unwrap();
        let list = storage.list_book_sources().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].url, "https://new.com");
        assert!(storage
            .save_book_source(
                r#"{"bookSourceUrl":"https://x.com","bookSourceName":"x","bookSourceType":2}"#,
                None
            )
            .is_err());
        storage.source_cache_put("k", "v", 0).unwrap();
        storage.source_cache_put("gone", "v", -1).unwrap();
        assert_eq!(storage.source_cache_get("k").unwrap().as_deref(), Some("v"));
        storage
            .conn
            .execute("UPDATE source_cache SET expires_at = 1 WHERE key = 'k'", [])
            .unwrap();
        assert_eq!(storage.source_cache_get("k").unwrap(), None);
        storage.put_source_cookie("a.com", "sid=1").unwrap();
        assert_eq!(
            storage.source_cookie("a.com").unwrap().as_deref(),
            Some("sid=1")
        );
    }
}
