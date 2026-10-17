//! The app log (设置 › 日志): failures and key steps the reader can send
//! when something goes wrong. Entries go to one JSON-lines file per local
//! day under `logs/`, kept for seven days, and to a ring buffer the log page
//! reads. 详细日志 also records every source request and engine step; it
//! turns itself off after a day. Cookies, authorization and login headers,
//! and passwords never enter the log.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

const KEPT_DAYS: usize = 7;
const RING: usize = 2000;
const DETAIL_HOURS: i64 = 24;
const MESSAGE_LIMIT: usize = 4000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Detail,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Milliseconds since the epoch.
    pub time: i64,
    pub level: LogLevel,
    /// What wrote it: `source`, `reader`, `sync`, `library`, `app`, `ui`.
    pub area: String,
    /// The text as written (Chinese); shown when the entry has no key, as
    /// older entries and engine traces do not.
    pub message: String,
    /// What the entry says, as a `log.<key>` the page shows in its own
    /// language with `params`; an error among them is `error` (its text),
    /// `errorKey`, and `errorParams` (JSON).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    #[ts(as = "Option<std::collections::BTreeMap<String, String>>", optional)]
    pub params: std::collections::BTreeMap<String, String>,
}

struct Log {
    dir: PathBuf,
    ring: VecDeque<LogEntry>,
    /// 详细日志 is on until this time.
    detail_until: i64,
}

fn log() -> &'static Mutex<Option<Log>> {
    static LOG: OnceLock<Mutex<Option<Log>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(None))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn day_of(time: i64) -> String {
    chrono::DateTime::from_timestamp_millis(time)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(|| "unknown".into())
}

/// Starts the log in `root/logs`, loading today's entries into the ring
/// and dropping files older than a week.
pub fn init(root: &Path) {
    let dir = root.join("logs");
    let _ = fs::create_dir_all(&dir);
    let mut files = day_files(&dir);
    while files.len() > KEPT_DAYS {
        let _ = fs::remove_file(files.remove(0));
    }
    let mut ring = VecDeque::new();
    for file in files.iter().rev().take(2).rev() {
        for entry in read_file(file) {
            ring.push_back(entry);
            if ring.len() > RING {
                ring.pop_front();
            }
        }
    }
    let detail_until = fs::read_to_string(dir.join("detail-until"))
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0);
    if let Ok(mut guard) = log().lock() {
        *guard = Some(Log {
            dir,
            ring,
            detail_until,
        });
    }
}

fn day_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "log"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

fn read_file(path: &Path) -> Vec<LogEntry> {
    fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Removes header values and secrets a message might carry.
pub fn redact(text: &str) -> String {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(
            r#"(?i)("?(?:cookie|set-cookie|authorization|proxy-authorization|password|passwd|token|loginheader)"?\s*[:=]\s*)("[^"]*"|[^\n"}&]+)"#,
        )
        .expect("redaction pattern")
    });
    pattern.replace_all(text, "$1***").into_owned()
}

fn write(level: LogLevel, area: &str, message: &str) {
    write_entry(level, area, message, None, Default::default());
}

/// A log entry the page shows in its language: `key` names `log.<key>`,
/// `params` fill it, and `text` is the Chinese kept for older readers.
pub fn keyed(
    level: LogLevel,
    area: &str,
    key: &str,
    params: &[(&str, String)],
    text: impl AsRef<str>,
) {
    let params = params
        .iter()
        .map(|(name, value)| (name.to_string(), redact(value)))
        .collect();
    write_entry(level, area, text.as_ref(), Some(key.to_string()), params);
}

/// An error as log params: its text, and its key for the page to translate.
pub fn error_params(error: &crate::error::AppError) -> Vec<(&'static str, String)> {
    let mut params = vec![("error", error.message.clone())];
    if let Some(key) = &error.key {
        params.push(("errorKey", key.clone()));
        params.push((
            "errorParams",
            serde_json::to_string(&error.params).unwrap_or_default(),
        ));
    }
    params
}

/// `app_log::keyed` written as `log_keyed!(Warn, "area", "key", text, name = value, …)`;
/// `@error e` adds an [`AppError`](crate::error::AppError)'s params.
#[macro_export]
macro_rules! log_keyed {
    ($level:ident, $area:expr, $key:expr, $text:expr $(, @error $error:expr)? $(, $name:ident = $value:expr)* $(,)?) => {{
        #[allow(unused_mut)]
        let mut params: Vec<(&str, String)> = vec![$((stringify!($name), ($value).to_string())),*];
        $(params.extend($crate::app_log::error_params(&$error));)?
        $crate::app_log::keyed($crate::app_log::LogLevel::$level, $area, $key, &params, $text)
    }};
}

fn write_entry(
    level: LogLevel,
    area: &str,
    message: &str,
    key: Option<String>,
    params: std::collections::BTreeMap<String, String>,
) {
    let Ok(mut guard) = log().lock() else {
        return;
    };
    let Some(state) = guard.as_mut() else {
        return;
    };
    let time = now();
    if level == LogLevel::Detail && state.detail_until <= time {
        return;
    }
    let mut message = redact(message);
    if message.len() > MESSAGE_LIMIT {
        let mut end = MESSAGE_LIMIT;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push('…');
    }
    let entry = LogEntry {
        time,
        level,
        area: area.to_string(),
        message,
        key,
        params,
    };
    if let Ok(line) = serde_json::to_string(&entry) {
        let path = state.dir.join(format!("{}.log", day_of(time)));
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }
    state.ring.push_back(entry);
    if state.ring.len() > RING {
        state.ring.pop_front();
    }
}

pub fn error(area: &str, message: impl AsRef<str>) {
    write(LogLevel::Error, area, message.as_ref());
}

pub fn warn(area: &str, message: impl AsRef<str>) {
    write(LogLevel::Warn, area, message.as_ref());
}

pub fn info(area: &str, message: impl AsRef<str>) {
    write(LogLevel::Info, area, message.as_ref());
}

/// Written only while 详细日志 is on.
pub fn detail(area: &str, message: impl AsRef<str>) {
    write(LogLevel::Detail, area, message.as_ref());
}

/// Whether 详细日志 is on, so callers can skip building detail messages.
pub fn detailed() -> bool {
    log()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|state| state.detail_until > now()))
        .unwrap_or(false)
}

/// Turns 详细日志 on for a day, or off; returns when it ends.
pub fn set_detailed(on: bool) -> Option<i64> {
    let mut guard = log().lock().ok()?;
    let state = guard.as_mut()?;
    state.detail_until = if on {
        now() + DETAIL_HOURS * 3_600_000
    } else {
        0
    };
    let _ = fs::write(
        state.dir.join("detail-until"),
        state.detail_until.to_string(),
    );
    (state.detail_until > 0).then_some(state.detail_until)
}

pub fn detail_until() -> Option<i64> {
    let guard = log().lock().ok()?;
    let until = guard.as_ref()?.detail_until;
    (until > now()).then_some(until)
}

/// Entries at `level` or above, newest last.
pub fn entries(level: LogLevel) -> Vec<LogEntry> {
    log()
        .lock()
        .ok()
        .and_then(|guard| {
            guard.as_ref().map(|state| {
                state
                    .ring
                    .iter()
                    .filter(|entry| entry.level >= level)
                    .cloned()
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// Every kept entry, oldest first, for an export the page writes in its
/// own language.
pub fn all_entries() -> Vec<LogEntry> {
    let Some(dir) = log()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|state| state.dir.clone()))
    else {
        return Vec::new();
    };
    day_files(&dir)
        .iter()
        .flat_map(|file| read_file(file))
        .collect()
}

/// Every kept entry as text, oldest first, for sending.
pub fn export_text() -> String {
    let Some(dir) = log()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|state| state.dir.clone()))
    else {
        return String::new();
    };
    let mut out = format!("GripRead {} 日志\n\n", env!("CARGO_PKG_VERSION"));
    for file in day_files(&dir) {
        for entry in read_file(&file) {
            out.push_str(&format_entry(&entry));
            out.push('\n');
        }
    }
    out
}

pub fn format_entry(entry: &LogEntry) -> String {
    let time = chrono::DateTime::from_timestamp_millis(entry.time)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%m-%d %H:%M:%S%.3f")
                .to_string()
        })
        .unwrap_or_default();
    let level = match entry.level {
        LogLevel::Detail => "D",
        LogLevel::Info => "I",
        LogLevel::Warn => "W",
        LogLevel::Error => "E",
    };
    format!("{time} {level} [{}] {}", entry.area, entry.message)
}

pub fn clear() {
    if let Ok(mut guard) = log().lock() {
        if let Some(state) = guard.as_mut() {
            state.ring.clear();
            for file in day_files(&state.dir) {
                let _ = fs::remove_file(file);
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn init_for_test(root: &Path) {
    init(root);
}

/// The log is one per process: tests that point it elsewhere (opening an
/// `AppState`) or count its entries hold this so they do not interleave.
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_redacted_and_detail_needs_the_switch() {
        let _log = test_lock();
        assert_eq!(
            redact(r#"请求失败 {"Cookie":"a=1; b=2","User-Agent":"x"} password=hunter2&u=1"#),
            r#"请求失败 {"Cookie":***,"User-Agent":"x"} password=***&u=1"#
        );
        assert_eq!(redact("Authorization: Bearer abc"), "Authorization: ***");
        assert_eq!(redact("Cookie: a=1; b=2"), "Cookie: ***");
        let dir = std::env::temp_dir().join(format!("gripread-log-{}", uuid::Uuid::new_v4()));
        init_for_test(&dir);
        error("source", "甲站 搜索失败：网站返回 403");
        // A keyed entry keeps what the page words it from.
        crate::log_keyed!(
            Warn,
            "source",
            "searchFailed",
            "乙站 搜索失败",
            source = "乙站"
        );
        let worded = entries(LogLevel::Warn);
        let last = worded.last().unwrap();
        assert_eq!(last.key.as_deref(), Some("searchFailed"));
        assert_eq!(last.params.get("source").map(String::as_str), Some("乙站"));
        detail("source", "请求 https://a.com");
        assert_eq!(entries(LogLevel::Detail).len(), 2, "detail is off");
        set_detailed(true);
        detail("source", "请求 https://a.com");
        assert_eq!(entries(LogLevel::Detail).len(), 3);
        assert_eq!(entries(LogLevel::Error).len(), 1);
        assert_eq!(entries(LogLevel::Warn).len(), 2);
        // A restart reads today's entries back.
        init(&dir);
        assert_eq!(entries(LogLevel::Detail).len(), 3);
        assert!(detailed());
        assert!(export_text().contains("甲站 搜索失败"));
        set_detailed(false);
        clear();
        assert!(entries(LogLevel::Detail).is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
