//! 过滤规则: regular expressions new articles are checked against before
//! they are stored. A rule drops what it matches, or (`keep`) lets in only
//! what it matches; an article is stored when no drop rule matches it and,
//! if any keep rules apply, at least one of them does. Expressions are
//! compiled with size limits, once, and kept for the next fetch.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use regex::{Regex, RegexBuilder};

use crate::error::{AppError, ErrorCode};
use crate::models::{FeedFilter, FeedFilterField, FeedFilterMode};

/// The compiled program's size limit; larger expressions are refused.
const SIZE_LIMIT: usize = 1 << 20;
const DFA_SIZE_LIMIT: usize = 2 << 20;
/// Compiled expressions kept between fetches.
const CACHED: usize = 256;

/// Compiled expressions by pattern and whether case is ignored.
type Compiled = HashMap<(String, bool), Arc<Regex>>;

/// The text a rule matches, taken from an article once.
pub struct ArticleText<'a> {
    pub title: &'a str,
    pub author: &'a str,
    /// The article's text without markup.
    pub body: &'a str,
}

impl ArticleText<'_> {
    fn field(&self, field: FeedFilterField) -> std::borrow::Cow<'_, str> {
        match field {
            FeedFilterField::Title => self.title.into(),
            FeedFilterField::Author => self.author.into(),
            FeedFilterField::Content => self.body.into(),
            FeedFilterField::Any => {
                format!("{}\n{}\n{}", self.title, self.author, self.body).into()
            }
        }
    }
}

/// Compiles a rule's expression, or says why it cannot be.
pub fn compile(pattern: &str, ignore_case: bool) -> Result<Arc<Regex>, AppError> {
    static CACHE: OnceLock<Mutex<Compiled>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = (pattern.to_string(), ignore_case);
    if let Some(regex) = cache.lock().ok().and_then(|cache| cache.get(&key).cloned()) {
        return Ok(regex);
    }
    if pattern.trim().is_empty() {
        return Err(AppError::keyed(
            ErrorCode::InvalidArgument,
            "rssFilterEmpty",
            "过滤规则不能为空",
        ));
    }
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(ignore_case)
        .size_limit(SIZE_LIMIT)
        .dfa_size_limit(DFA_SIZE_LIMIT)
        .build()
        .map_err(|error| {
            AppError::keyed(
                ErrorCode::InvalidArgument,
                "rssFilterInvalid",
                format!("正则表达式有误：{error}"),
            )
            .with("error", error.to_string())
        })?;
    let regex = Arc::new(regex);
    if let Ok(mut cache) = cache.lock() {
        if cache.len() >= CACHED {
            cache.clear();
        }
        cache.insert(key, regex.clone());
    }
    Ok(regex)
}

/// The rules that apply to one feed, compiled.
#[derive(Default)]
pub struct FilterSet {
    drop: Vec<(FeedFilterField, Arc<Regex>)>,
    keep: Vec<(FeedFilterField, Arc<Regex>)>,
}

impl FilterSet {
    /// The set of these rules. A rule that no longer compiles (one made
    /// by a newer version, say) is left out rather than stopping fetches.
    pub fn new<'a>(rules: impl IntoIterator<Item = &'a FeedFilter>) -> Self {
        let mut set = Self::default();
        for rule in rules {
            let Ok(regex) = compile(&rule.pattern, rule.ignore_case) else {
                continue;
            };
            match rule.mode {
                FeedFilterMode::Drop => set.drop.push((rule.field, regex)),
                FeedFilterMode::Keep => set.keep.push((rule.field, regex)),
            }
        }
        set
    }

    pub fn is_empty(&self) -> bool {
        self.drop.is_empty() && self.keep.is_empty()
    }

    /// Whether any rule looks at the article's text (which takes parsing).
    pub fn reads_body(&self) -> bool {
        self.drop
            .iter()
            .chain(&self.keep)
            .any(|(field, _)| matches!(field, FeedFilterField::Content | FeedFilterField::Any))
    }

    /// Whether the article may be stored.
    pub fn admits(&self, article: &ArticleText<'_>) -> bool {
        let matches =
            |(field, regex): &(FeedFilterField, Arc<Regex>)| regex.is_match(&article.field(*field));
        !self.drop.iter().any(matches) && (self.keep.is_empty() || self.keep.iter().any(matches))
    }
}
