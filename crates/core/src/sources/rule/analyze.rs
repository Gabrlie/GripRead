//! Legado's `AnalyzeRule`: runs a rule chain over the current content.
//!
//! A rule is split into segments at `<js>…</js>` and `@js:`; each segment's
//! output is the next one's `result`. Within a segment, `@put`, `@get`,
//! `{{…}}` templates, and `$N` groups are expanded first, then the segment
//! runs in its mode (default, JSON, XPath, JS, or plain text), then its
//! `##regex##replacement` suffix applies.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::OnceLock;

use super::regex as java_regex;
use super::{json, jsoup, xpath};
use crate::sources::context::{BookRef, ChapterRef, Env, VarsRef};
use crate::sources::error::{SourceError, SourceResult};
use crate::sources::lenient_json;
use crate::sources::util::{absolute_url, unescape_html};
use crate::sources::value::{format_f64, Val};

/// Runs source scripts for a rule. The JS host implements it; rules that
/// need no scripts can run with [`NoScripts`].
pub trait Scripts {
    fn eval(&self, rule: &AnalyzeRule, script: &str, result: &Val) -> SourceResult<Val>;
}

/// A script host that refuses scripts.
pub struct NoScripts;

impl Scripts for NoScripts {
    fn eval(&self, _rule: &AnalyzeRule, _script: &str, _result: &Val) -> SourceResult<Val> {
        Err(SourceError::unsupported("此处不能运行脚本"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Default,
    Json,
    XPath,
    Js,
    Regex,
}

#[derive(Debug, Clone)]
enum Param {
    Text(String),
    Group(usize),
    Js(String),
    Get(String),
}

/// One segment of a rule chain, as Legado's inner `SourceRule`.
#[derive(Debug, Clone)]
pub struct SourceRule {
    pub mode: Mode,
    pub rule: String,
    put_map: Vec<(String, String)>,
    params: Vec<Param>,
    replace_regex: String,
    replacement: String,
    replace_first: bool,
}

fn starts_with_ci(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.is_char_boundary(prefix.len())
        && text[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn js_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"(?is)<js>(.*?)</js>|@js:(.*)").expect("valid"))
}

fn put_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"(?i)@put:(\{[^}]+?\})").expect("valid"))
}

fn eval_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"(?is)@get:\{[^}]+?\}|\{\{.*?\}\}").expect("valid"))
}

fn group_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"\$\d{1,2}").expect("valid"))
}

/// Whether an inner `{{…}}` expression is a nested rule rather than JS.
fn is_rule(text: &str) -> bool {
    text.starts_with('@')
        || text.starts_with("$.")
        || text.starts_with("$[")
        || text.starts_with("//")
}

impl SourceRule {
    fn new(rule_str: &str, mode: Mode, is_json: bool) -> Self {
        let (mut mode, rule) = match mode {
            Mode::Js | Mode::Regex => (mode, rule_str.to_string()),
            _ if starts_with_ci(rule_str, "@CSS:") => (Mode::Default, rule_str.to_string()),
            _ if rule_str.starts_with("@@") => (Mode::Default, rule_str[2..].to_string()),
            _ if starts_with_ci(rule_str, "@XPath:") => (Mode::XPath, rule_str[7..].to_string()),
            _ if starts_with_ci(rule_str, "@Json:") => (Mode::Json, rule_str[6..].to_string()),
            _ if is_json || rule_str.starts_with("$.") || rule_str.starts_with("$[") => {
                (Mode::Json, rule_str.to_string())
            }
            _ if rule_str.starts_with('/') => (Mode::XPath, rule_str.to_string()),
            _ => (Mode::Default, rule_str.to_string()),
        };
        let mut put_map = Vec::new();
        let rule = split_put_rule(&rule, &mut put_map);
        let mut params = Vec::new();
        let mut start = 0;
        let matches: Vec<regex::Match<'_>> = eval_pattern().find_iter(&rule).collect();
        if let Some(first) = matches.first() {
            let before = &rule[..first.start()];
            if mode != Mode::Js
                && mode != Mode::Regex
                && (first.start() == 0 || !before.contains("##"))
            {
                mode = Mode::Regex;
            }
            for found in &matches {
                if found.start() > start {
                    split_regex(&rule[start..found.start()], &mut mode, &mut params);
                }
                let text = found.as_str();
                if starts_with_ci(text, "@get:") {
                    params.push(Param::Get(text[6..text.len() - 1].to_string()));
                } else if text.starts_with("{{") {
                    params.push(Param::Js(text[2..text.len() - 2].to_string()));
                } else {
                    split_regex(text, &mut mode, &mut params);
                }
                start = found.end();
            }
        }
        if rule.len() > start {
            split_regex(&rule[start..], &mut mode, &mut params);
        }
        SourceRule {
            mode,
            rule,
            put_map,
            params,
            replace_regex: String::new(),
            replacement: String::new(),
            replace_first: false,
        }
    }

    /// Expands the segment's parameters with the current result, then
    /// separates its `##` replacement.
    fn make_up(
        &mut self,
        analyze: &AnalyzeRule,
        scripts: &dyn Scripts,
        result: &Val,
    ) -> SourceResult<()> {
        if !self.params.is_empty() {
            let mut out = String::new();
            for param in &self.params {
                match param {
                    Param::Group(group) => match result {
                        Val::List(items) => {
                            if let Some(item) = items.get(*group) {
                                out.push_str(&item.to_text());
                            }
                        }
                        _ => out.push_str(&format!("${group}")),
                    },
                    Param::Js(script) => {
                        if is_rule(script) {
                            let rule = SourceRule::new(script, Mode::Default, analyze.is_json());
                            out.push_str(&analyze.get_string_rules(
                                scripts,
                                vec![rule],
                                None,
                                false,
                                true,
                            )?);
                        } else {
                            match analyze.eval_js(scripts, script, result)? {
                                Val::Null => {}
                                value => out.push_str(&value.to_text()),
                            }
                        }
                    }
                    Param::Get(key) => out.push_str(&analyze.get(key)),
                    Param::Text(text) => out.push_str(text),
                }
            }
            self.rule = out;
        }
        let parts: Vec<&str> = self.rule.split("##").collect();
        let first = parts[0].trim().to_string();
        if parts.len() > 1 {
            self.replace_regex = parts[1].to_string();
        }
        if parts.len() > 2 {
            self.replacement = parts[2].to_string();
        }
        if parts.len() > 3 {
            self.replace_first = true;
        }
        self.rule = first;
        Ok(())
    }
}

/// Removes `@put:{…}` from a rule and records its key/rule pairs.
fn split_put_rule(rule: &str, put_map: &mut Vec<(String, String)>) -> String {
    let mut out = rule.to_string();
    for captures in put_pattern().captures_iter(rule) {
        let whole = captures.get(0).expect("group 0").as_str();
        out = out.replace(whole, "");
        if let Ok(serde_json::Value::Object(map)) = lenient_json::parse(&captures[1]) {
            for (key, value) in map {
                let value = match value {
                    serde_json::Value::String(text) => text,
                    other => other.to_string(),
                };
                put_map.push((key, value));
            }
        }
    }
    out
}

/// Splits literal text at `$N` capture references.
fn split_regex(text: &str, mode: &mut Mode, params: &mut Vec<Param>) {
    let head = text.split("##").next().unwrap_or("");
    let mut start = 0;
    let groups: Vec<regex::Match<'_>> = group_pattern().find_iter(head).collect();
    if !groups.is_empty() {
        if *mode != Mode::Js && *mode != Mode::Regex {
            *mode = Mode::Regex;
        }
        for found in groups {
            if found.start() > start {
                params.push(Param::Text(text[start..found.start()].to_string()));
            }
            let number: usize = found.as_str()[1..].parse().unwrap_or(0);
            params.push(if number > 0 {
                Param::Group(number)
            } else {
                Param::Text(found.as_str().to_string())
            });
            start = found.end();
        }
    }
    if text.len() > start {
        params.push(Param::Text(text[start..].to_string()));
    }
}

fn replace_regex(text: &str, rule: &SourceRule) -> String {
    if rule.replace_regex.is_empty() {
        return text.to_string();
    }
    match java_regex::compile(&rule.replace_regex) {
        Ok(regex) if rule.replace_first => match regex.find(text) {
            Ok(Some(found)) => java_regex::replace_first(&regex, found.as_str(), &rule.replacement),
            _ => String::new(),
        },
        Ok(regex) => java_regex::replace_all(&regex, text, &rule.replacement),
        Err(_) if rule.replace_first => rule.replacement.clone(),
        Err(_) => text.replace(&rule.replace_regex, &rule.replacement),
    }
}

struct Inner {
    env: Rc<Env>,
    content: RefCell<Val>,
    base_url: RefCell<String>,
    redirect_url: RefCell<String>,
    is_json: Cell<bool>,
    is_regex: Cell<bool>,
    book: RefCell<Option<BookRef>>,
    chapter: RefCell<Option<ChapterRef>>,
    rule_data: RefCell<Option<VarsRef>>,
    next_chapter_url: RefCell<Option<String>>,
}

/// A rule analyzer over one piece of content. Cloning shares the analyzer,
/// so scripts can reach the one that runs them.
#[derive(Clone)]
pub struct AnalyzeRule(Rc<Inner>);

impl AnalyzeRule {
    pub fn new(env: Rc<Env>) -> Self {
        AnalyzeRule(Rc::new(Inner {
            env,
            content: RefCell::new(Val::Null),
            base_url: RefCell::new(String::new()),
            redirect_url: RefCell::new(String::new()),
            is_json: Cell::new(false),
            is_regex: Cell::new(false),
            book: RefCell::new(None),
            chapter: RefCell::new(None),
            rule_data: RefCell::new(None),
            next_chapter_url: RefCell::new(None),
        }))
    }

    pub fn env(&self) -> &Rc<Env> {
        &self.0.env
    }

    pub fn same(&self, other: &AnalyzeRule) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }

    pub fn set_content(&self, content: Val, base_url: Option<&str>) -> &Self {
        self.0.is_json.set(content.looks_like_json());
        *self.0.content.borrow_mut() = content;
        if let Some(base) = base_url {
            self.set_base_url(base);
        }
        self
    }

    pub fn content(&self) -> Val {
        self.0.content.borrow().clone()
    }

    pub fn is_json(&self) -> bool {
        self.0.is_json.get()
    }

    pub fn set_base_url(&self, base_url: &str) -> &Self {
        *self.0.base_url.borrow_mut() = base_url.to_string();
        self
    }

    pub fn base_url(&self) -> String {
        self.0.base_url.borrow().clone()
    }

    pub fn set_redirect_url(&self, url: &str) -> &Self {
        *self.0.redirect_url.borrow_mut() = url.to_string();
        self
    }

    pub fn redirect_url(&self) -> String {
        let redirect = self.0.redirect_url.borrow().clone();
        if redirect.is_empty() {
            self.base_url()
        } else {
            redirect
        }
    }

    pub fn set_book(&self, book: Option<BookRef>) -> &Self {
        *self.0.book.borrow_mut() = book;
        self
    }

    pub fn book(&self) -> Option<BookRef> {
        self.0.book.borrow().clone()
    }

    pub fn set_chapter(&self, chapter: Option<ChapterRef>) -> &Self {
        *self.0.chapter.borrow_mut() = chapter;
        self
    }

    pub fn chapter(&self) -> Option<ChapterRef> {
        self.0.chapter.borrow().clone()
    }

    pub fn set_rule_data(&self, vars: Option<VarsRef>) -> &Self {
        *self.0.rule_data.borrow_mut() = vars;
        self
    }

    pub fn rule_data(&self) -> Option<VarsRef> {
        self.0.rule_data.borrow().clone()
    }

    pub fn set_next_chapter_url(&self, url: Option<String>) -> &Self {
        *self.0.next_chapter_url.borrow_mut() = url;
        self
    }

    pub fn next_chapter_url(&self) -> Option<String> {
        self.0.next_chapter_url.borrow().clone()
    }

    /// Stores a variable on the innermost owner: the chapter, the book, the
    /// rule data, or else the source.
    pub fn put(&self, key: &str, value: &str) -> String {
        if let Some(chapter) = self.chapter() {
            chapter
                .borrow_mut()
                .variables
                .insert(key.to_string(), value.to_string());
        } else if let Some(book) = self.book() {
            book.borrow_mut()
                .variables
                .insert(key.to_string(), value.to_string());
        } else if let Some(vars) = self.rule_data() {
            vars.borrow_mut().insert(key.to_string(), value.to_string());
        } else {
            self.0.env.source_put(key, value);
        }
        value.to_string()
    }

    pub fn get(&self, key: &str) -> String {
        match key {
            "bookName" => {
                if let Some(book) = self.book() {
                    return book.borrow().name.clone();
                }
            }
            "title" => {
                if let Some(chapter) = self.chapter() {
                    return chapter.borrow().title.clone();
                }
            }
            _ => {}
        }
        let found = self
            .chapter()
            .and_then(|chapter| chapter.borrow().variables.get(key).cloned())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                self.book()
                    .and_then(|book| book.borrow().variables.get(key).cloned())
                    .filter(|value| !value.is_empty())
            })
            .or_else(|| {
                self.rule_data()
                    .and_then(|vars| vars.borrow().get(key).cloned())
                    .filter(|value| !value.is_empty())
            })
            .or_else(|| self.0.env.source_get(key).filter(|value| !value.is_empty()));
        found.unwrap_or_default()
    }

    pub fn eval_js(&self, scripts: &dyn Scripts, script: &str, result: &Val) -> SourceResult<Val> {
        self.0.env.control.check()?;
        scripts.eval(self, script, result)
    }

    fn put_rules(&self, scripts: &dyn Scripts, put_map: &[(String, String)]) -> SourceResult<()> {
        for (key, rule) in put_map {
            let value = self.get_string(scripts, rule)?;
            self.put(key, &value);
        }
        Ok(())
    }

    /// Splits a rule into its chain segments, as `splitSourceRule`. With
    /// `all_in_one`, a leading `:` makes the whole rule a regex list rule.
    pub fn split_source_rule(&self, rule: &str, all_in_one: bool) -> Vec<SourceRule> {
        if rule.is_empty() {
            return Vec::new();
        }
        let mut list = Vec::new();
        let mut mode = Mode::Default;
        let mut start = 0;
        if all_in_one && rule.starts_with(':') {
            mode = Mode::Regex;
            self.0.is_regex.set(true);
            start = 1;
        } else if self.0.is_regex.get() {
            mode = Mode::Regex;
        }
        let is_json = self.is_json();
        let trim = |text: &str| text.trim_matches(|c: char| c <= ' ').to_string();
        for captures in js_pattern().captures_iter(rule) {
            let whole = captures.get(0).expect("group 0");
            if whole.start() < start {
                continue;
            }
            if whole.start() > start {
                let text = trim(&rule[start..whole.start()]);
                if !text.is_empty() {
                    list.push(SourceRule::new(&text, mode, is_json));
                }
            }
            let script = captures
                .get(2)
                .or_else(|| captures.get(1))
                .map_or("", |m| m.as_str());
            list.push(SourceRule::new(script, Mode::Js, is_json));
            start = whole.end();
        }
        if rule.len() > start {
            let text = trim(&rule[start..]);
            if !text.is_empty() {
                list.push(SourceRule::new(&text, mode, is_json));
            }
        }
        list
    }

    /// `getString(rule)`.
    pub fn get_string(&self, scripts: &dyn Scripts, rule: &str) -> SourceResult<String> {
        self.get_string_with(scripts, rule, None, false)
    }

    /// `getString(rule, isUrl = true)`: an absolute URL.
    pub fn get_url(&self, scripts: &dyn Scripts, rule: &str) -> SourceResult<String> {
        self.get_string_with(scripts, rule, None, true)
    }

    pub fn get_string_with(
        &self,
        scripts: &dyn Scripts,
        rule: &str,
        content: Option<&Val>,
        is_url: bool,
    ) -> SourceResult<String> {
        if rule.is_empty() {
            return Ok(String::new());
        }
        let rules = self.split_source_rule(rule, false);
        self.get_string_rules(scripts, rules, content, is_url, true)
    }

    pub fn get_string_rules(
        &self,
        scripts: &dyn Scripts,
        rules: Vec<SourceRule>,
        content: Option<&Val>,
        is_url: bool,
        unescape: bool,
    ) -> SourceResult<String> {
        let content = content.cloned().unwrap_or_else(|| self.content());
        let mut result = Val::Null;
        if !content.is_null() && !rules.is_empty() {
            result = content;
            for mut rule in rules {
                self.put_rules(scripts, &rule.put_map)?;
                rule.make_up(self, scripts, &result)?;
                if result.is_null() {
                    continue;
                }
                if !rule.rule.trim().is_empty() || rule.replace_regex.is_empty() {
                    result = match rule.mode {
                        Mode::Js => self.eval_js(scripts, &rule.rule, &result)?,
                        Mode::Json => match json::parse_content(&result) {
                            Some(value) => {
                                json::get_string(&value, &rule.rule).map_or(Val::Null, Val::Str)
                            }
                            None => Val::Null,
                        },
                        Mode::XPath => {
                            let scope = jsoup::parse_content(&result, &self.redirect_url());
                            xpath::get_string(&scope, &rule.rule)?.map_or(Val::Null, Val::Str)
                        }
                        Mode::Default if is_object(&result) => object_key(&result, &rule.rule),
                        Mode::Default => {
                            let scope = jsoup::parse_content(&result, &self.redirect_url());
                            if is_url {
                                Val::Str(jsoup::get_string0(&scope, &rule.rule)?)
                            } else {
                                jsoup::get_string(&scope, &rule.rule)?.map_or(Val::Null, Val::Str)
                            }
                        }
                        Mode::Regex => Val::Str(rule.rule.clone()),
                    };
                }
                if !result.is_null() && !rule.replace_regex.is_empty() {
                    result = Val::Str(replace_regex(&string_of(&result), &rule));
                }
            }
        }
        let text = string_of(&result);
        let text = if unescape { unescape_html(&text) } else { text };
        if is_url {
            return Ok(if text.trim().is_empty() {
                self.base_url()
            } else {
                absolute_url(&self.redirect_url(), &text)
            });
        }
        Ok(text)
    }

    /// `getStringList(rule)`, `None` when the rule produced nothing.
    pub fn get_string_list(
        &self,
        scripts: &dyn Scripts,
        rule: &str,
        content: Option<&Val>,
        is_url: bool,
    ) -> SourceResult<Option<Vec<String>>> {
        if rule.is_empty() {
            return Ok(None);
        }
        let rules = self.split_source_rule(rule, false);
        let content = content.cloned().unwrap_or_else(|| self.content());
        let mut result = Val::Null;
        if !content.is_null() && !rules.is_empty() {
            result = content;
            for mut rule in rules {
                self.put_rules(scripts, &rule.put_map)?;
                rule.make_up(self, scripts, &result)?;
                if result.is_null() {
                    continue;
                }
                if !rule.rule.is_empty() {
                    result = match rule.mode {
                        Mode::Js => self.eval_js(scripts, &rule.rule, &result)?,
                        Mode::Json => match json::parse_content(&result) {
                            Some(value) => strings(json::get_string_list(&value, &rule.rule)),
                            None => Val::Null,
                        },
                        Mode::XPath => {
                            let scope = jsoup::parse_content(&result, &self.redirect_url());
                            strings(xpath::get_string_list(&scope, &rule.rule)?)
                        }
                        Mode::Default if is_object(&result) => object_key(&result, &rule.rule),
                        Mode::Default => {
                            let scope = jsoup::parse_content(&result, &self.redirect_url());
                            strings(jsoup::get_string_list(&scope, &rule.rule)?)
                        }
                        Mode::Regex => Val::Str(rule.rule.clone()),
                    };
                }
                if !rule.replace_regex.is_empty() {
                    result = match result {
                        Val::List(items) => Val::List(
                            items
                                .iter()
                                .map(|item| Val::Str(replace_regex(&item.to_text(), &rule)))
                                .collect(),
                        ),
                        Val::Null => Val::Null,
                        other => Val::Str(replace_regex(&string_of(&other), &rule)),
                    };
                }
            }
        }
        if result.is_null() {
            return Ok(None);
        }
        let list = result.into_strings();
        if is_url {
            let base = self.redirect_url();
            let mut urls: Vec<String> = Vec::new();
            for item in list {
                let url = absolute_url(&base, &item);
                if !url.is_empty() && !urls.contains(&url) {
                    urls.push(url);
                }
            }
            return Ok(Some(urls));
        }
        Ok(Some(list))
    }

    /// `getElement(rule)`: one value, such as a details page's `init`.
    pub fn get_element(&self, scripts: &dyn Scripts, rule: &str) -> SourceResult<Val> {
        if rule.is_empty() {
            return Ok(Val::Null);
        }
        let content = self.content();
        let rules = self.split_source_rule(rule, true);
        let mut result = Val::Null;
        if !content.is_null() && !rules.is_empty() {
            result = content;
            for mut rule in rules {
                self.put_rules(scripts, &rule.put_map)?;
                rule.make_up(self, scripts, &result)?;
                if result.is_null() {
                    continue;
                }
                result = match rule.mode {
                    Mode::Regex => {
                        let patterns = not_blank_parts(&rule.rule);
                        match java_regex::all_in_one_element(&result.to_text(), &patterns)? {
                            Some(groups) => Val::List(groups.into_iter().map(Val::Str).collect()),
                            None => Val::Null,
                        }
                    }
                    Mode::Js => self.eval_js(scripts, &rule.rule, &result)?,
                    Mode::Json => match json::parse_content(&result) {
                        Some(value) => json::get_object(&value, &rule.rule),
                        None => Val::Null,
                    },
                    Mode::XPath => {
                        let scope = jsoup::parse_content(&result, &self.redirect_url());
                        Val::List(
                            xpath::get_elements(&scope, &rule.rule)?
                                .into_iter()
                                .map(xpath::Hit::into_val)
                                .collect(),
                        )
                    }
                    Mode::Default => {
                        let scope = jsoup::parse_content(&result, &self.redirect_url());
                        Val::Elements(jsoup::get_elements(&scope, &rule.rule)?)
                    }
                };
                if !rule.replace_regex.is_empty() {
                    result = Val::Str(replace_regex(&result.to_text(), &rule));
                }
            }
        }
        Ok(result)
    }

    /// `getElements(rule)`: the items of a list rule.
    pub fn get_elements(&self, scripts: &dyn Scripts, rule: &str) -> SourceResult<Vec<Val>> {
        if rule.is_empty() {
            return Ok(Vec::new());
        }
        let content = self.content();
        let rules = self.split_source_rule(rule, true);
        let mut result = Val::Null;
        if !content.is_null() && !rules.is_empty() {
            result = content;
            for mut rule in rules {
                self.put_rules(scripts, &rule.put_map)?;
                // Legado runs a list script as written: `{{…}}` and `##` in
                // it are the script's own text, such as a regex literal.
                if rule.mode != Mode::Js {
                    rule.make_up(self, scripts, &result)?;
                }
                if result.is_null() {
                    continue;
                }
                result = match rule.mode {
                    Mode::Regex => {
                        let patterns = not_blank_parts(&rule.rule);
                        Val::List(
                            java_regex::all_in_one_elements(&result.to_text(), &patterns)?
                                .into_iter()
                                .map(|groups| Val::List(groups.into_iter().map(Val::Str).collect()))
                                .collect(),
                        )
                    }
                    Mode::Js => self.eval_js(scripts, &rule.rule, &result)?,
                    Mode::Json => match json::parse_content(&result) {
                        Some(value) => Val::List(json::get_list(&value, &rule.rule)),
                        None => Val::Null,
                    },
                    Mode::XPath => {
                        let scope = jsoup::parse_content(&result, &self.redirect_url());
                        Val::List(
                            xpath::get_elements(&scope, &rule.rule)?
                                .into_iter()
                                .map(xpath::Hit::into_val)
                                .collect(),
                        )
                    }
                    Mode::Default => {
                        let scope = jsoup::parse_content(&result, &self.redirect_url());
                        Val::Elements(jsoup::get_elements(&scope, &rule.rule)?)
                    }
                };
                if !rule.replace_regex.is_empty() && !result.is_null() {
                    result = Val::Str(replace_regex(&result.to_text(), &rule));
                }
            }
        }
        Ok(match result {
            Val::List(items) => items,
            Val::Elements(elements) => elements.into_iter().map(Val::Element).collect(),
            Val::Json(serde_json::Value::Array(items)) => {
                items.into_iter().map(Val::Json).collect()
            }
            _ => Vec::new(),
        })
    }
}

fn strings(list: Vec<String>) -> Val {
    Val::List(list.into_iter().map(Val::Str).collect())
}

/// The text a chain step leaves: lists are joined line by line.
/// Whether the content is an object a script made. Legado reads a plain rule
/// on such an item (Rhino's NativeObject) as its key, `result[rule]`, so a
/// list script's `{name: …}` items work with a `name` rule whatever the page
/// around them was.
fn is_object(value: &Val) -> bool {
    matches!(value, Val::Json(serde_json::Value::Object(_)))
}

fn object_key(value: &Val, key: &str) -> Val {
    let Val::Json(serde_json::Value::Object(map)) = value else {
        return Val::Null;
    };
    match map.get(key) {
        None | Some(serde_json::Value::Null) => Val::Null,
        Some(serde_json::Value::String(text)) => Val::Str(text.clone()),
        Some(other) => Val::Json(other.clone()),
    }
}

fn string_of(value: &Val) -> String {
    match value {
        Val::List(items) => items
            .iter()
            .map(Val::to_text)
            .collect::<Vec<_>>()
            .join("\n"),
        Val::Json(serde_json::Value::Number(number)) => number
            .as_f64()
            .map(format_f64)
            .unwrap_or_else(|| number.to_string()),
        other => other.to_text(),
    }
}

fn not_blank_parts(rule: &str) -> Vec<String> {
    rule.split("&&")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::context::{BookData, Control, MemoryStore};
    use crate::sources::model::BookSource;
    use std::sync::Arc;

    fn analyzer() -> AnalyzeRule {
        let source = BookSource::from_value(serde_json::json!({
            "bookSourceUrl": "https://example.com", "bookSourceName": "测试"
        }))
        .unwrap();
        AnalyzeRule::new(Env::new(
            source,
            Arc::new(MemoryStore::default()),
            Control::unlimited(),
        ))
    }

    const PAGE: &str = r#"<html><body><div class="book"><h1>  书名&amp;副题 </h1>
        <p class="author">作者：张三</p><a class="read" href="/b/7/">阅读</a>
        <ul id="toc"><li><a href="1.html">第一章 起</a></li><li><a href="2.html">第二章 承</a></li></ul>
        </div></body></html>"#;

    #[test]
    fn default_rules_with_replacements_and_urls() {
        let rule = analyzer();
        rule.set_content(Val::Str(PAGE.into()), Some("https://example.com/b/7/"));
        let s = |r: &str| rule.get_string(&NoScripts, r).unwrap();
        assert_eq!(s("tag.h1@text"), "书名&副题");
        assert_eq!(s("class.author@text##作者："), "张三");
        assert_eq!(s("class.author@text##.*：(.*)##$1"), "张三");
        assert_eq!(s("class.author@text##张##李###"), "李");
        assert_eq!(
            rule.get_url(&NoScripts, "class.read@href").unwrap(),
            "https://example.com/b/7/"
        );
        assert_eq!(
            rule.get_string_list(&NoScripts, "id.toc@tag.a@href", None, true)
                .unwrap()
                .unwrap(),
            vec![
                "https://example.com/b/7/1.html",
                "https://example.com/b/7/2.html"
            ]
        );
    }

    #[test]
    fn list_items_feed_field_rules() {
        let rule = analyzer();
        rule.set_content(Val::Str(PAGE.into()), Some("https://example.com/b/7/"));
        let items = rule.get_elements(&NoScripts, "id.toc@li").unwrap();
        assert_eq!(items.len(), 2);
        rule.set_content(items[1].clone(), None);
        assert_eq!(rule.get_string(&NoScripts, "a@text").unwrap(), "第二章 承");
        assert_eq!(
            rule.get_string(&NoScripts, "tag.a@text##第.章\\s*")
                .unwrap(),
            "承"
        );
    }

    #[test]
    fn json_content_switches_bare_rules_to_json_paths() {
        let rule = analyzer();
        rule.set_content(
            Val::Str(r#"{"data":[{"id":5,"title":"甲","author":"乙"}]}"#.into()),
            Some("https://api.example.com/search"),
        );
        let items = rule.get_elements(&NoScripts, "$.data[*]").unwrap();
        assert_eq!(items.len(), 1);
        rule.set_content(items[0].clone(), None);
        assert_eq!(rule.get_string(&NoScripts, "title").unwrap(), "甲");
        assert_eq!(rule.get_string(&NoScripts, "$.author").unwrap(), "乙");
        assert_eq!(
            rule.get_url(&NoScripts, "/book/{{$.id}}.html").unwrap(),
            "https://api.example.com/book/5.html"
        );
    }

    #[test]
    fn regex_lists_expose_groups() {
        let rule = analyzer();
        rule.set_content(
            Val::Str("<a href=\"/1\">一</a><a href=\"/2\">二</a>".into()),
            Some("https://example.com/"),
        );
        let items = rule
            .get_elements(&NoScripts, r#":<a href="([^"]+)">([^<]+)</a>"#)
            .unwrap();
        assert_eq!(items.len(), 2);
        rule.set_content(items[1].clone(), None);
        assert_eq!(rule.get_string(&NoScripts, "$2").unwrap(), "二");
        assert_eq!(
            rule.get_url(&NoScripts, "$1").unwrap(),
            "https://example.com/2"
        );
        assert_eq!(rule.get_string(&NoScripts, "第$2章").unwrap(), "第二章");
    }

    #[test]
    fn put_and_get_use_the_innermost_owner() {
        let rule = analyzer();
        rule.set_content(Val::Str(PAGE.into()), Some("https://example.com/b/7/"));
        assert_eq!(
            rule.get_string(&NoScripts, "@put:{bid:\"class.read@href\"}tag.h1@text")
                .unwrap(),
            "书名&副题"
        );
        assert_eq!(rule.get("bid"), "/b/7/");
        assert_eq!(
            rule.get_string(&NoScripts, "/x/@get:{bid}").unwrap(),
            "/x//b/7/"
        );
        let book = Rc::new(RefCell::new(BookData::default()));
        rule.set_book(Some(book.clone()));
        rule.put("k", "v");
        assert_eq!(book.borrow().variables["k"], "v");
        assert_eq!(rule.get("k"), "v");
    }

    #[test]
    fn xpath_and_css_prefixes() {
        let rule = analyzer();
        rule.set_content(Val::Str(PAGE.into()), Some("https://example.com/b/7/"));
        assert_eq!(
            rule.get_string(&NoScripts, "//h1/text()").unwrap(),
            "书名&副题"
        );
        assert_eq!(
            rule.get_string(&NoScripts, "@XPath://p[@class='author']/text()")
                .unwrap(),
            "作者：张三"
        );
        assert_eq!(
            rule.get_string(&NoScripts, "@css:.author@text").unwrap(),
            "作者：张三"
        );
    }
}
