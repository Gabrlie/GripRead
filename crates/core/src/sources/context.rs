//! The state a source operation reads and writes: the book and chapter
//! being worked on, variables, persistent source data, logs, and limits.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::error::{SourceError, SourceResult};
use super::model::BookSource;

pub type VarMap = BTreeMap<String, String>;

/// A book as Legado's `Book`/`SearchBook` exposes it to rules and scripts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BookData {
    pub name: String,
    pub author: String,
    pub kind: String,
    pub cover_url: String,
    pub intro: String,
    pub word_count: String,
    pub latest_chapter_title: String,
    pub update_time: String,
    pub book_url: String,
    pub toc_url: String,
    pub origin: String,
    pub origin_name: String,
    pub variables: VarMap,
    /// The details page when the search result already was one.
    pub info_html: Option<String>,
    /// The contents page when it is the details page.
    pub toc_html: Option<String>,
    /// `book.setReverseToc(true)`: the contents come newest first.
    pub reverse_toc: bool,
    /// Found through an image (comic) source.
    pub comic: bool,
}

/// A chapter as Legado's `BookChapter` exposes it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChapterData {
    pub title: String,
    pub url: String,
    pub base_url: String,
    pub index: usize,
    pub is_volume: bool,
    pub is_vip: bool,
    pub is_pay: bool,
    pub tag: String,
    pub variables: VarMap,
}

pub type BookRef = Rc<RefCell<BookData>>;
pub type ChapterRef = Rc<RefCell<ChapterData>>;
pub type VarsRef = Rc<RefCell<VarMap>>;

/// Persistent per-source data: the script cache (which also holds source
/// variables), cookies, and login state. Login state never leaves the
/// device.
pub trait SourceStore: Send + Sync {
    fn cache_get(&self, key: &str) -> Option<String>;
    /// `save_seconds` of 0 or less keeps the value until it is replaced.
    fn cache_put(&self, key: &str, value: &str, save_seconds: i64);
    fn cache_delete(&self, key: &str);
    fn cookie_get(&self, domain: &str) -> Option<String>;
    fn cookie_put(&self, domain: &str, cookie: &str);
    fn cookie_remove(&self, domain: &str);
}

/// A store kept in memory, for tests and for checks that must not persist.
#[derive(Default)]
pub struct MemoryStore {
    cache: Mutex<HashMap<String, String>>,
    cookies: Mutex<HashMap<String, String>>,
}

impl SourceStore for MemoryStore {
    fn cache_get(&self, key: &str) -> Option<String> {
        self.cache.lock().ok()?.get(key).cloned()
    }

    fn cache_put(&self, key: &str, value: &str, _save_seconds: i64) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(key.to_string(), value.to_string());
        }
    }

    fn cache_delete(&self, key: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.remove(key);
        }
    }

    fn cookie_get(&self, domain: &str) -> Option<String> {
        self.cookies.lock().ok()?.get(domain).cloned()
    }

    fn cookie_put(&self, domain: &str, cookie: &str) {
        if let Ok(mut cookies) = self.cookies.lock() {
            cookies.insert(domain.to_string(), cookie.to_string());
        }
    }

    fn cookie_remove(&self, domain: &str) {
        if let Ok(mut cookies) = self.cookies.lock() {
            cookies.remove(domain);
        }
    }
}

/// Cancellation and a deadline shared by everything one operation runs.
#[derive(Clone)]
pub struct Control {
    pub cancel: Arc<AtomicBool>,
    pub deadline: Option<Instant>,
}

impl Control {
    pub fn new(cancel: Arc<AtomicBool>, deadline: Option<Instant>) -> Self {
        Self { cancel, deadline }
    }

    pub fn unlimited() -> Self {
        Self::new(Arc::new(AtomicBool::new(false)), None)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn is_expired(&self) -> bool {
        self.deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
    }

    pub fn check(&self) -> SourceResult<()> {
        if self.is_cancelled() {
            return Err(SourceError::cancelled());
        }
        if self.is_expired() {
            return Err(SourceError::timeout("书源操作超时"));
        }
        Ok(())
    }
}

/// Keys of the source cache, as Legado's `BaseSource` names them.
pub fn source_variable_key(source_url: &str, key: &str) -> String {
    format!("v_{source_url}_{key}")
}

pub fn login_info_key(source_url: &str) -> String {
    format!("userInfo_{source_url}")
}

/// The source's last successful login: `{"text": …, "at": ms}`.
pub fn login_result_key(source_url: &str) -> String {
    format!("loginResult_{source_url}")
}

pub fn login_header_key(source_url: &str) -> String {
    format!("loginHeader_{source_url}")
}

pub fn source_custom_variable_key(source_url: &str) -> String {
    format!("sourceVariable_{source_url}")
}

/// The source, its store, and what one operation collects.
pub struct Env {
    pub source: BookSource,
    pub store: Arc<dyn SourceStore>,
    pub control: Control,
    pub logs: RefCell<Vec<String>>,
    /// `cache.putMemory`, kept for the operation only.
    pub memory: RefCell<HashMap<String, String>>,
}

impl Env {
    pub fn new(source: BookSource, store: Arc<dyn SourceStore>, control: Control) -> Rc<Self> {
        Rc::new(Self {
            source,
            store,
            control,
            logs: RefCell::new(Vec::new()),
            memory: RefCell::new(HashMap::new()),
        })
    }

    pub fn log(&self, message: impl Into<String>) {
        let message = message.into();
        // 详细日志 mirrors every engine step and request into the app log.
        if crate::app_log::detailed() {
            crate::app_log::detail("source", format!("{}：{}", self.source.name(), message));
        }
        let mut logs = self.logs.borrow_mut();
        // Logs are for debugging; a runaway script must not grow them forever.
        if logs.len() < 2000 {
            logs.push(message);
        }
    }

    pub fn source_get(&self, key: &str) -> Option<String> {
        self.store
            .cache_get(&source_variable_key(&self.source.url(), key))
    }

    pub fn source_put(&self, key: &str, value: &str) {
        self.store
            .cache_put(&source_variable_key(&self.source.url(), key), value, 0);
    }
}
