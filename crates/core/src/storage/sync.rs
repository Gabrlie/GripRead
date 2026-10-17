//! Native sync records (the server stage, P2): the library as one record
//! per piece of state, keyed like backups so devices agree on identity.
//!
//! - `book:<sha256>`, `online:<name key>`: a book's details and placement
//! - `chapters:online:<name key>`: an online book's chapter list, so a
//!   directory updated on the server or another device arrives without
//!   asking the source
//! - `progress:`, `bookmarks:`, `time:` + `book:<sha256>` or `online:<key>`
//! - `group:<name>`, `replace:<id>`, `toc:<id>`, `source:<url>`
//! - `prefs:reading`, `prefs:theme`, `prefs:shelf`
//!
//! A device finds its changes by comparing the records it builds now with
//! the last ones it synced (`sync_records`), and applies others' records
//! through the restore paths. The 恢复忽略列表 doubles as the exclusion list:
//! excluded records are neither sent nor applied. The server keeps the
//! latest record per key in `sync_log`, numbered in the order it took them.

use super::portable::{
    merge_preferences, strip_device_assets, Parts, PortableBook, PortableBookmark,
    PortableOnlineBook,
};
use super::*;
use crate::models::{RestoreCategory, RestoreReport, ShelfPreferences, TxtTocRule};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

/// One record's new value, or `None` when it was removed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncChange {
    pub key: String,
    pub value: Option<Value>,
}

/// A record as the server keeps it: its place in the log and who wrote it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoggedChange {
    pub seq: i64,
    pub key: String,
    pub value: Option<Value>,
    pub device: String,
}

/// The categories a record belongs to; excluding any of them leaves it out.
pub fn record_categories(key: &str) -> Vec<RestoreCategory> {
    let online = key.contains("online:");
    let mut categories = match key.split(':').next().unwrap_or_default() {
        "book" => vec![RestoreCategory::BookInfo],
        "online" => vec![RestoreCategory::BookInfo],
        "progress" => vec![RestoreCategory::Progress],
        "bookmarks" => vec![RestoreCategory::Bookmarks],
        "time" => vec![RestoreCategory::ReadingTime],
        "group" => vec![RestoreCategory::Groups],
        "replace" => vec![RestoreCategory::ReplaceRules],
        "toc" => vec![RestoreCategory::TocRules],
        "source" => vec![RestoreCategory::Sources],
        "prefs" => match key {
            "prefs:theme" => vec![RestoreCategory::Theme],
            "prefs:shelf" => vec![RestoreCategory::ShelfLayout],
            _ => vec![RestoreCategory::ReadingSettings],
        },
        _ => vec![],
    };
    if online {
        categories.push(RestoreCategory::OnlineBooks);
    }
    categories
}

pub fn record_hash(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    hex_digest(&Sha256::digest(value.to_string().as_bytes()))
}

/// The hash a record is compared by. An online book's details (addresses
/// some sources sign per request, the latest chapter, the introduction)
/// change with every refresh on each side, so they do not count as a
/// change: only its source does. Without this the two sides send the
/// record back and forth for ever.
pub fn stable_hash(key: &str, value: &Value) -> String {
    if !is_online_book_record(key) {
        return record_hash(value);
    }
    let mut stable = value.clone();
    if let Some(book) = stable.get_mut("book") {
        let source = book.get("sourceUrl").cloned().unwrap_or(Value::Null);
        *book = json!({ "sourceUrl": source });
    }
    record_hash(&stable)
}

fn is_online_book_record(key: &str) -> bool {
    key.starts_with("online:")
}

/// Records whose fields are merged one by one with what this device holds:
/// a book's details and placement, and the preferences.
fn merged_by_field(key: &str) -> bool {
    is_online_book_record(key) || key.starts_with("book:") || key.starts_with("prefs:")
}

/// A record from elsewhere merged with this device's: each field the other
/// side changed since the last sync (`base`) comes in; the others keep this
/// device's value, so a change made here meanwhile (允许更新 turned off, a
/// custom style a server too old to know drops) is not lost.
fn merge_fields(local: &Value, base: &Value, incoming: &Value) -> Value {
    let (Value::Object(local), Value::Object(base), Value::Object(incoming)) =
        (local, base, incoming)
    else {
        return incoming.clone();
    };
    let mut merged = local.clone();
    for key in incoming.keys().chain(base.keys()) {
        let (theirs, before) = (incoming.get(key), base.get(key));
        if theirs != before {
            match theirs {
                Some(value) => merged.insert(key.clone(), value.clone()),
                None => merged.remove(key),
            };
        }
    }
    Value::Object(merged)
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The local book a record belongs to, by its file's hash.
fn book_of(key: &str) -> Option<&str> {
    let rest = key.strip_prefix("book:").or_else(|| {
        ["progress:book:", "bookmarks:book:", "time:book:"]
            .iter()
            .find_map(|prefix| key.strip_prefix(prefix))
    })?;
    Some(rest)
}

/// The order records apply in: what others refer to comes first.
fn apply_order(key: &str) -> u8 {
    match key.split(':').next().unwrap_or_default() {
        "group" => 0,
        "toc" | "replace" | "source" | "prefs" => 1,
        "book" | "online" => 2,
        _ => 3,
    }
}

/// A bookmark's identity across devices: when it was made and what it marks.
fn bookmark_identity(created_at: i64, excerpt: &str) -> (i64, String) {
    (created_at, excerpt.to_string())
}

fn without_records(mut book: PortableBook) -> PortableBook {
    book.position = None;
    book.position_updated_at = 0;
    book.bookmarks.clear();
    book.reading_time.clear();
    book.local = false;
    book
}

fn bare_book(source_sha256: &str) -> PortableBook {
    PortableBook {
        source_sha256: source_sha256.to_string(),
        title: String::new(),
        author: None,
        intro: None,
        shelf_state: None,
        group: None,
        use_replace_rules: true,
        toc: BookTocSettings::default(),
        position: None,
        position_updated_at: 0,
        bookmarks: Vec::new(),
        reading_time: Vec::new(),
        cover: None,
        local: false,
    }
}

const THEME_FIELDS: [&str; 13] = [
    "theme",
    "paperTone",
    "oledBlack",
    "customStyles",
    "customStyle",
    "pinnedStyles",
    "coverShowName",
    "coverShowAuthor",
    "coversWifiOnly",
    "homeTab",
    "showDiscover",
    "navLabels",
    "navAutohide",
];

/// The `prefs:reading`, `prefs:theme`, and `prefs:shelf` records.
fn preference_records(
    mut preferences: ReaderPreferences,
    shelf: &ShelfPreferences,
) -> Result<Vec<(String, Value)>, AppError> {
    strip_device_assets(&mut preferences);
    let mut reading = serde_json::to_value(&preferences)?;
    let mut theme = serde_json::Map::new();
    if let Value::Object(fields) = &mut reading {
        for field in THEME_FIELDS {
            if let Some(value) = fields.remove(field) {
                theme.insert(field.to_string(), value);
            }
        }
    }
    Ok(vec![
        ("prefs:reading".into(), reading),
        ("prefs:theme".into(), Value::Object(theme)),
        ("prefs:shelf".into(), shelf_record(shelf)?),
    ])
}

/// The shelf's layout and order; the group shown is this device's own, so
/// switching groups neither syncs nor moves other devices.
fn shelf_record(shelf: &ShelfPreferences) -> Result<Value, AppError> {
    let mut value = serde_json::to_value(shelf)?;
    if let Value::Object(fields) = &mut value {
        fields.remove("groupId");
    }
    Ok(value)
}

/// Whether a preferences record holds the defaults a new library starts with.
fn is_default_preference(key: &str, value: &Value) -> Result<bool, AppError> {
    Ok(
        preference_records(ReaderPreferences::default(), &ShelfPreferences::default())?
            .iter()
            .any(|(name, default)| name == key && default == value),
    )
}

impl Storage {
    fn sync_excluded(&self, key: &str) -> Result<bool, AppError> {
        let settings = self.stored_webdav()?;
        Ok(record_categories(key)
            .into_iter()
            .any(|category| settings.ignores(category)))
    }

    /// Every record this library has now, minus excluded ones.
    pub fn sync_snapshot(&self) -> Result<BTreeMap<String, Value>, AppError> {
        let mut records = BTreeMap::new();
        let settings = self.stored_webdav()?;
        // Progress names the device that read, for another device's prompt.
        let progress = |position: Value, updated_at: i64| {
            json!({
                "position": position,
                "updatedAt": updated_at,
                "deviceId": settings.device_id,
                "deviceName": settings.device("另一台设备"),
            })
        };
        for shelf in self.shelf_books_with_sources()? {
            let book = self.portable_book(&shelf)?;
            let key = format!("book:{}", shelf.source_sha256);
            if let Some(position) = &book.position {
                records.insert(
                    format!("progress:{key}"),
                    progress(serde_json::to_value(position)?, book.position_updated_at),
                );
            }
            records.insert(
                format!("bookmarks:{key}"),
                serde_json::to_value(&book.bookmarks)?,
            );
            records.insert(
                format!("time:{key}"),
                serde_json::to_value(&book.reading_time)?,
            );
            records.insert(key, serde_json::to_value(without_records(book))?);
        }
        for mut book in self.portable_online_books()? {
            let key = format!(
                "online:{}",
                online_key(&book.title, book.author.as_deref().unwrap_or(""))
            );
            if let Some(position) = &book.position {
                records.insert(
                    format!("progress:{key}"),
                    progress(serde_json::to_value(position)?, book.position_updated_at),
                );
            }
            records.insert(
                format!("bookmarks:{key}"),
                serde_json::to_value(&book.bookmarks)?,
            );
            records.insert(
                format!("time:{key}"),
                serde_json::to_value(&book.reading_time)?,
            );
            book.position = None;
            book.position_updated_at = 0;
            book.bookmarks.clear();
            book.reading_time.clear();
            records.insert(key, serde_json::to_value(book)?);
        }
        for (key, book_id) in self.online_ids_by_key()? {
            let chapters = self.online_chapters(&book_id)?;
            if !chapters.is_empty() {
                records.insert(
                    format!("chapters:online:{key}"),
                    serde_json::to_value(chapters)?,
                );
            }
        }
        for group in self.list_groups()? {
            records.insert(
                format!("group:{}", group.name),
                json!({ "name": group.name }),
            );
        }
        for rule in self.list_replace_rules()? {
            records.insert(format!("replace:{}", rule.id), serde_json::to_value(rule)?);
        }
        for rule in self.list_txt_toc_rules()? {
            records.insert(format!("toc:{}", rule.id), serde_json::to_value(rule)?);
        }
        let sources: Vec<Value> = serde_json::from_str(&self.export_book_sources(&[])?)?;
        for source in sources {
            if let Some(url) = source.get("bookSourceUrl").and_then(Value::as_str) {
                records.insert(format!("source:{url}"), source.clone());
            }
        }
        records.extend(preference_records(
            self.get_settings()?,
            &self.get_shelf_preferences()?,
        )?);
        records.retain(|key, _| {
            !record_categories(key)
                .into_iter()
                .any(|category| settings.ignores(category))
        });
        Ok(records)
    }

    fn synced_records(&self) -> Result<HashMap<String, (String, Option<Value>)>, AppError> {
        let mut statement = self
            .conn
            .prepare("SELECT key, hash, value FROM sync_records")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|(key, hash, value)| {
                let value = value.and_then(|text| serde_json::from_str(&text).ok());
                (key, (hash, value))
            })
            .collect())
    }

    /// What changed here since the last sync: new or changed records, and
    /// removed ones (`value: None`).
    pub fn sync_pending(&self) -> Result<Vec<SyncChange>, AppError> {
        let snapshot = self.sync_snapshot()?;
        let synced = self.synced_records()?;
        let updated = |value: &Value| value["updatedAt"].as_i64().unwrap_or(0);
        let mut changes: Vec<SyncChange> = snapshot
            .iter()
            .filter(|(key, value)| {
                let Some((hash, synced)) = synced.get(*key) else {
                    return true;
                };
                if hash == &stable_hash(key, value) {
                    return false;
                }
                // A position goes out only when newer than the one synced; an
                // older one here waits for the reader to answer the prompt.
                !key.starts_with("progress:")
                    || synced
                        .as_ref()
                        .is_none_or(|synced| updated(value) > updated(synced))
            })
            .map(|(key, value)| SyncChange {
                key: key.clone(),
                value: Some(value.clone()),
            })
            .collect();
        for key in synced.keys() {
            // A book whose file never came here only waits for it; its
            // records are not gone.
            let waiting = match book_of(key) {
                Some(sha256) => self.book_for_source(sha256)?.is_none(),
                None => false,
            };
            if !waiting && !snapshot.contains_key(key) && !self.sync_excluded(key)? {
                changes.push(SyncChange {
                    key: key.clone(),
                    value: None,
                });
            }
        }
        changes.sort_by(|left, right| left.key.cmp(&right.key));
        Ok(changes)
    }

    /// Notes a record as synced: the value both sides now hold.
    pub fn sync_mark(&self, change: &SyncChange) -> Result<(), AppError> {
        match &change.value {
            Some(value) => self.conn.execute(
                "INSERT INTO sync_records(key, hash, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, value = excluded.value",
                params![
                    change.key,
                    stable_hash(&change.key, value),
                    value.to_string()
                ],
            )?,
            None => self.conn.execute(
                "DELETE FROM sync_records WHERE key = ?1",
                params![change.key],
            )?,
        };
        Ok(())
    }

    /// Forgets what was synced, so the next sync sends every record.
    pub fn sync_forget(&self) -> Result<(), AppError> {
        self.conn.execute("DELETE FROM sync_records", [])?;
        Ok(())
    }

    /// Applies records from elsewhere and notes them as synced. Excluded
    /// records are skipped; returns how many were applied.
    pub fn sync_apply(&mut self, changes: &[SyncChange]) -> Result<u32, AppError> {
        let mut ordered: Vec<&SyncChange> = changes.iter().collect();
        ordered.sort_by_key(|change| apply_order(&change.key));
        let synced = self.synced_records()?;
        let local = if ordered.iter().any(|change| merged_by_field(&change.key)) {
            self.sync_snapshot()?
        } else {
            BTreeMap::new()
        };
        let mut applied = 0;
        for change in ordered {
            if self.sync_excluded(&change.key)? {
                continue;
            }
            let base = synced
                .get(&change.key)
                .and_then(|(_, value)| value.as_ref());
            let merged = match (&change.value, base, local.get(&change.key)) {
                (Some(incoming), Some(base), Some(local)) if merged_by_field(&change.key) => {
                    Some(merge_fields(local, base, incoming))
                }
                _ => change.value.clone(),
            };
            match self.apply_record(&change.key, merged.as_ref(), base) {
                Ok(()) => {
                    applied += 1;
                    self.sync_mark(change)?;
                }
                // Not marked: marking would make the record look removed
                // here and send that removal on; this device keeps its own.
                Err(error) => crate::app_log::warn(
                    "sync",
                    format!("同步记录未能应用（{}）：{}", change.key, error.message),
                ),
            }
        }
        Ok(applied)
    }

    fn apply_record(
        &mut self,
        key: &str,
        value: Option<&Value>,
        base: Option<&Value>,
    ) -> Result<(), AppError> {
        let (kind, rest) = key.split_once(':').unwrap_or((key, ""));
        match (kind, value) {
            ("group", Some(_)) => {
                if !self.list_groups()?.iter().any(|group| group.name == rest) {
                    self.create_group(rest)?;
                }
            }
            ("group", None) => {
                if let Some(group) = self
                    .list_groups()?
                    .into_iter()
                    .find(|group| group.name == rest)
                {
                    self.delete_group(&group.id)?;
                }
            }
            ("replace", Some(value)) => {
                let rule: crate::models::ReplaceRule = serde_json::from_value(value.clone())?;
                self.upsert_replace_rule(&rule)?;
            }
            ("replace", None) => self.delete_replace_rules(&[rest.to_string()])?,
            ("toc", Some(value)) => {
                let rule: TxtTocRule = serde_json::from_value(value.clone())?;
                self.upsert_toc_rule(&rule)?;
            }
            ("toc", None) => {
                // Built-in rules cannot be deleted; others follow.
                let _ = self.delete_txt_toc_rule(rest);
            }
            ("source", Some(value)) => {
                self.import_sources(&crate::models::ImportSourcesRequest {
                    json: Value::Array(vec![value.clone()]).to_string(),
                    urls: vec![rest.to_string()],
                    keep_name: false,
                    keep_group: false,
                    keep_enabled: false,
                })?;
            }
            ("source", None) => self.delete_book_sources(&[rest.to_string()])?,
            // A server that was never set up has default preferences; on
            // first contact they do not replace this device's own.
            ("prefs", Some(value)) if base.is_none() && is_default_preference(key, value)? => {}
            ("prefs", Some(value)) => self.apply_preferences(rest, value)?,
            ("prefs", None) => {}
            ("book", value) => self.apply_book_record(rest, value)?,
            ("online", value) => self.apply_online_record(rest, value)?,
            ("chapters", Some(value)) => {
                let key = rest.strip_prefix("online:").unwrap_or(rest);
                if let Some(book_id) = self.online_book_id_for_key(key)? {
                    let chapters: Vec<crate::models::OnlineChapter> =
                        serde_json::from_value(value.clone())?;
                    let book = self.online_record(&book_id)?.book;
                    self.replace_online_toc(&book_id, &book, &chapters)?;
                }
            }
            (part @ ("progress" | "bookmarks" | "time"), Some(value)) => {
                let (scope, id) = rest.split_once(':').unwrap_or(("", ""));
                match scope {
                    "book" => self.apply_book_part(part, id, value, base)?,
                    "online" => self.apply_online_part(part, id, value, base)?,
                    _ => {}
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn upsert_toc_rule(&mut self, rule: &TxtTocRule) -> Result<(), AppError> {
        if !rule.pattern.is_empty() {
            crate::txt_toc::compile_rule(&rule.pattern)?;
        }
        self.conn.execute(
            "INSERT INTO txt_toc_rules(id, name, pattern, example, serial, enabled, builtin, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, pattern = excluded.pattern,
                example = excluded.example, serial = excluded.serial, enabled = excluded.enabled,
                updated_at = excluded.updated_at",
            params![
                rule.id,
                rule.name,
                rule.pattern,
                rule.example,
                rule.serial,
                rule.enabled,
                now_millis()
            ],
        )?;
        Ok(())
    }

    fn apply_preferences(&mut self, which: &str, value: &Value) -> Result<(), AppError> {
        match which {
            "shelf" => {
                // Layout and order come in; the group shown stays this device's
                // (older devices still send theirs).
                let current = self.get_shelf_preferences()?;
                let mut merged = serde_json::to_value(&current)?;
                if let (Value::Object(target), Value::Object(fields)) = (&mut merged, value) {
                    for (key, field) in fields {
                        if key != "groupId" {
                            target.insert(key.clone(), field.clone());
                        }
                    }
                }
                let shelf: ShelfPreferences = serde_json::from_value(merged)?;
                if self.save_shelf_preferences(&shelf).is_err() {
                    let mut shelf = shelf;
                    shelf.group_id = "all".into();
                    self.save_shelf_preferences(&shelf)?;
                }
            }
            "theme" | "reading" => {
                let current = self.get_settings()?;
                let mut incoming = serde_json::to_value(&current)?;
                if let (Value::Object(target), Value::Object(fields)) = (&mut incoming, value) {
                    for (field, value) in fields {
                        target.insert(field.clone(), value.clone());
                    }
                }
                let incoming: ReaderPreferences = serde_json::from_value(incoming)?;
                let merged =
                    merge_preferences(&current, &incoming, which == "reading", which == "theme");
                if merged != current && merged.validate().is_ok() {
                    self.save_settings(&merged)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Book details: applied to the book here, or kept for when its file arrives.
    fn apply_book_record(&mut self, sha256: &str, value: Option<&Value>) -> Result<(), AppError> {
        let Some(value) = value else {
            if let Some(book_id) = self.book_for_source(sha256)? {
                if self.library_book(&book_id).is_ok() {
                    self.remove_book(&book_id)?;
                }
            }
            self.conn.execute(
                "DELETE FROM pending_book_restores WHERE source_sha256 = ?1",
                params![sha256],
            )?;
            return Ok(());
        };
        let incoming: PortableBook = serde_json::from_value(value.clone())?;
        match self.book_for_source(sha256)? {
            Some(book_id) => {
                let parts = Parts {
                    info: true,
                    ..Parts::NONE
                };
                self.apply_portable_book(&book_id, &incoming, parts)?;
            }
            None => self.merge_pending(sha256, |pending| {
                let kept = (
                    pending.position.take(),
                    pending.position_updated_at,
                    std::mem::take(&mut pending.bookmarks),
                    std::mem::take(&mut pending.reading_time),
                );
                *pending = incoming.clone();
                (
                    pending.position,
                    pending.position_updated_at,
                    pending.bookmarks,
                    pending.reading_time,
                ) = kept;
            })?,
        }
        Ok(())
    }

    /// Updates the record kept for a book whose file is not here yet.
    fn merge_pending(
        &mut self,
        sha256: &str,
        change: impl FnOnce(&mut PortableBook),
    ) -> Result<(), AppError> {
        let stored: Option<String> = self
            .conn
            .query_row(
                "SELECT record_json FROM pending_book_restores WHERE source_sha256 = ?1",
                params![sha256],
                |row| row.get(0),
            )
            .optional()?;
        let mut pending = stored
            .and_then(|text| serde_json::from_str::<PortableBook>(&text).ok())
            .unwrap_or_else(|| bare_book(sha256));
        change(&mut pending);
        self.conn.execute(
            "INSERT INTO pending_book_restores(source_sha256, record_json, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(source_sha256) DO UPDATE SET record_json = excluded.record_json",
            params![sha256, serde_json::to_string(&pending)?, now_millis()],
        )?;
        Ok(())
    }

    fn apply_book_part(
        &mut self,
        part: &str,
        sha256: &str,
        value: &Value,
        base: Option<&Value>,
    ) -> Result<(), AppError> {
        let mut book = bare_book(sha256);
        let mut parts = Parts::NONE;
        match part {
            "progress" => {
                book.position = serde_json::from_value(value["position"].clone())?;
                book.position_updated_at = value["updatedAt"].as_i64().unwrap_or(0);
                parts.progress = true;
            }
            "bookmarks" => {
                book.bookmarks = serde_json::from_value(value.clone())?;
                parts.marks = true;
            }
            _ => {
                book.reading_time = serde_json::from_value(value.clone())?;
                parts.time = true;
            }
        }
        let Some(book_id) = self.book_for_source(sha256)? else {
            return self.merge_pending(sha256, |pending| match part {
                "progress" => {
                    if book.position_updated_at > pending.position_updated_at {
                        pending.position = book.position.clone();
                        pending.position_updated_at = book.position_updated_at;
                    }
                }
                "bookmarks" => pending.bookmarks = book.bookmarks.clone(),
                _ => pending.reading_time = book.reading_time.clone(),
            });
        };
        // Another device's position is offered when the book opens (see
        // progress_sync); it applies only where this book was never read.
        if part == "progress" && self.saved_position(&book_id)?.is_some() {
            return Ok(());
        }
        if part == "bookmarks" {
            // Three-way: what the other side added comes in, what it removed
            // since the last sync goes, and bookmarks made here stay.
            let identity =
                |mark: &PortableBookmark| bookmark_identity(mark.created_at, &mark.excerpt);
            let base: Vec<PortableBookmark> = base
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default();
            let incoming: HashSet<_> = book.bookmarks.iter().map(identity).collect();
            let removed: HashSet<_> = base
                .iter()
                .map(identity)
                .filter(|mark| !incoming.contains(mark))
                .collect();
            for local in self.list_bookmarks(&book_id)? {
                if removed.contains(&bookmark_identity(local.created_at, &local.excerpt)) {
                    self.delete_bookmark(&local.id)?;
                }
            }
        }
        self.apply_portable_book(&book_id, &book, parts)?;
        Ok(())
    }

    /// The online book on the shelf with this name key.
    /// Shelf online books by their sync key.
    fn online_ids_by_key(&self) -> Result<Vec<(String, String)>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT o.book_id, b.title, b.author FROM online_books o JOIN books b ON b.id = o.book_id
             WHERE o.on_shelf = 1
               AND NOT EXISTS(SELECT 1 FROM shelf_removals r WHERE r.book_id = o.book_id)",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|(id, title, author)| (online_key(&title, author.as_deref().unwrap_or("")), id))
            .collect())
    }

    /// The shelf online book a sync key names.
    pub fn online_book_id_for_key(&self, key: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .online_ids_by_key()?
            .into_iter()
            .find(|(found, _)| found == key)
            .map(|(_, id)| id))
    }

    /// An online book's sync key (`online:<key>` records), from its title
    /// and author as the shelf has them.
    pub fn online_sync_key(&self, book_id: &str) -> Result<String, AppError> {
        let (title, author): (String, Option<String>) = self.conn.query_row(
            "SELECT title, author FROM books WHERE id = ?1",
            params![book_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(online_key(&title, author.as_deref().unwrap_or("")))
    }

    fn online_book_for_key(
        &self,
        key: &str,
    ) -> Result<Option<(String, PortableOnlineBook)>, AppError> {
        for book in self.portable_online_books()? {
            if online_key(&book.title, book.author.as_deref().unwrap_or("")) == key {
                let id =
                    self.find_online_book(&book.title, book.author.as_deref().unwrap_or(""))?;
                return Ok(id.map(|id| (id, book)));
            }
        }
        Ok(None)
    }

    fn apply_online_record(&mut self, key: &str, value: Option<&Value>) -> Result<(), AppError> {
        match value {
            Some(value) => {
                let incoming: PortableOnlineBook = serde_json::from_value(value.clone())?;
                let parts = Parts {
                    info: true,
                    ..Parts::NONE
                };
                self.restore_online_book(&incoming, parts, &mut RestoreReport::default())?;
            }
            None => {
                if let Some((book_id, _)) = self.online_book_for_key(key)? {
                    self.delete_online_book(&book_id)?;
                }
            }
        }
        Ok(())
    }

    fn apply_online_part(
        &mut self,
        part: &str,
        key: &str,
        value: &Value,
        base: Option<&Value>,
    ) -> Result<(), AppError> {
        let Some((book_id, mut book)) = self.online_book_for_key(key)? else {
            return Ok(());
        };
        let mut parts = Parts::NONE;
        match part {
            "progress" => {
                if self.saved_position(&book_id)?.is_some()
                    || self.pending_online_position(&book_id)?.is_some()
                {
                    return Ok(());
                }
                book.position = serde_json::from_value(value["position"].clone())?;
                book.position_updated_at = value["updatedAt"].as_i64().unwrap_or(0);
                parts.progress = true;
            }
            "bookmarks" => {
                book.bookmarks = serde_json::from_value(value.clone())?;
                parts.marks = true;
                let identity =
                    |created_at: i64, excerpt: &str| bookmark_identity(created_at, excerpt);
                let base: Vec<super::online::PendingBookmark> = base
                    .and_then(|value| serde_json::from_value(value.clone()).ok())
                    .unwrap_or_default();
                let incoming: HashSet<_> = book
                    .bookmarks
                    .iter()
                    .map(|mark| identity(mark.created_at, &mark.excerpt))
                    .collect();
                let removed: HashSet<_> = base
                    .iter()
                    .map(|mark| identity(mark.created_at, &mark.excerpt))
                    .filter(|mark| !incoming.contains(mark))
                    .collect();
                for local in self.list_bookmarks(&book_id)? {
                    if removed.contains(&identity(local.created_at, &local.excerpt)) {
                        self.delete_bookmark(&local.id)?;
                    }
                }
            }
            _ => {
                book.reading_time = serde_json::from_value(value.clone())?;
                parts.time = true;
            }
        }
        self.restore_online_book(&book, parts, &mut RestoreReport::default())?;
        Ok(())
    }

    /// The position record sync holds for this book (another device's, or
    /// this device's own when it sent the latest).
    pub fn synced_progress(&self, book_id: &str) -> Result<Option<Value>, AppError> {
        let key = if self.is_online_book(book_id)? {
            let book = self.get_book(book_id)?;
            format!(
                "progress:online:{}",
                online_key(&book.title, book.author.as_deref().unwrap_or(""))
            )
        } else {
            match self.book_source_file(book_id) {
                Ok((_, sha256, _)) => format!("progress:book:{sha256}"),
                Err(_) => return Ok(None),
            }
        };
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM sync_records WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(value.and_then(|text| serde_json::from_str(&text).ok()))
    }

    /// The server's log: keeps `change` as the latest record for its key.
    pub fn sync_log_append(&self, change: &SyncChange, device: &str) -> Result<i64, AppError> {
        // A fresh row numbers it after everything logged so far.
        self.conn
            .execute("DELETE FROM sync_log WHERE key = ?1", params![change.key])?;
        self.conn.execute(
            "INSERT INTO sync_log(key, value, device, at) VALUES (?1, ?2, ?3, ?4)",
            params![
                change.key,
                change.value.as_ref().map(Value::to_string),
                device,
                now_millis()
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Records after `since`, oldest first, and the newest number.
    pub fn sync_log_since(
        &self,
        since: i64,
        limit: u32,
    ) -> Result<(Vec<LoggedChange>, i64), AppError> {
        let mut statement = self.conn.prepare(
            "SELECT seq, key, value, device FROM sync_log WHERE seq > ?1 ORDER BY seq LIMIT ?2",
        )?;
        let rows = statement
            .query_map(params![since, limit], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let head: i64 =
            self.conn
                .query_row("SELECT COALESCE(MAX(seq), 0) FROM sync_log", [], |row| {
                    row.get(0)
                })?;
        let changes = rows
            .into_iter()
            .map(|(seq, key, value, device)| LoggedChange {
                seq,
                key,
                value: value.and_then(|text| serde_json::from_str(&text).ok()),
                device,
            })
            .collect();
        Ok((changes, head))
    }
}
