//! Legado's `WebBook`: search, explore, book information, table of
//! contents, and chapter content for one source, in Legado's order.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value as Json;
use ts_rs::TS;

use super::context::{
    BookData, BookRef, ChapterData, ChapterRef, Control, Env, SourceStore, VarMap,
};
use super::error::{SourceError, SourceResult};
use super::http::HttpResponse;
use super::js::{JsHost, JsScope};
use super::lenient_json;
use super::model::BookSource;
use super::rule::analyze::{AnalyzeRule, SourceRule};
use super::url::AnalyzeUrl;
use super::util::{absolute_url, split_url_option, unescape_html};
use super::value::{json_text, Val};

/// One explore category.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExploreKind {
    pub title: String,
    pub url: Option<String>,
    /// Legado's flex layout hints, kept as given.
    #[ts(type = "Record<string, unknown> | null")]
    pub style: Option<Json>,
}

/// A chapter's text and the title the content page gave it, if any.
#[derive(Debug, Clone, PartialEq)]
pub struct ChapterContent {
    pub text: String,
    pub title: Option<String>,
}

/// Legado's `String.isTrue()`.
fn is_true(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() || text == "null" {
        return false;
    }
    !matches!(
        text.to_ascii_lowercase().as_str(),
        "false" | "no" | "not" | "0"
    )
}

/// `BookHelp.formatBookName`.
pub fn format_book_name(name: &str) -> String {
    let pattern = regex::Regex::new(r"\s+作\s*者.*|\s+\S+\s+著").expect("valid");
    pattern
        .replace_all(name, "")
        .trim_matches(|c: char| c <= ' ')
        .to_string()
}

/// `BookHelp.formatBookAuthor`.
pub fn format_book_author(author: &str) -> String {
    let pattern = regex::Regex::new(r"^\s*作\s*者[:：\s]+|\s+著").expect("valid");
    pattern
        .replace_all(author, "")
        .trim_matches(|c: char| c <= ' ')
        .to_string()
}

/// `StringUtils.wordCountFormat`.
pub fn word_count_format(text: &str) -> String {
    match text.trim().parse::<i64>() {
        Ok(words) if words > 10_000 => {
            let tens = (words as f64 / 10_000.0 * 10.0).round() / 10.0;
            let shown = if tens.fract() == 0.0 {
                format!("{tens:.0}")
            } else {
                format!("{tens:.1}")
            };
            format!("{shown}万字")
        }
        Ok(words) if words > 0 => format!("{words}字"),
        _ => text.to_string(),
    }
}

/// `HtmlFormatter.format`: tags out, paragraphs indented.
pub fn html_format(html: &str) -> String {
    format_html(html, false)
}

fn format_html(html: &str, keep_images: bool) -> String {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<[regex::Regex; 6]> = OnceLock::new();
    let [nbsp, esp, no_print, wrap, comment, indent] = PATTERNS.get_or_init(|| {
        [
            regex::Regex::new(r"(&nbsp;)+").expect("valid"),
            regex::Regex::new(r"(&ensp;|&emsp;)").expect("valid"),
            regex::Regex::new("(&thinsp;|&zwnj;|&zwj;|\u{2009}|\u{200C}|\u{200D})").expect("valid"),
            regex::Regex::new(r"(?i)</?(?:div|p|br|hr|h\d|article|dd|dl)[^>]*>").expect("valid"),
            regex::Regex::new(r"<!--[^>]*-->").expect("valid"),
            regex::Regex::new(r"\s*\n+\s*").expect("valid"),
        ]
    });
    let text = nbsp.replace_all(html, " ");
    let text = esp.replace_all(&text, " ");
    let text = no_print.replace_all(&text, "");
    let text = wrap.replace_all(&text, "\n");
    let text = comment.replace_all(&text, "");
    let tag = fancy_regex::Regex::new(if keep_images {
        r"</?(?!img)[a-zA-Z]+(?=[ >])[^<>]*>"
    } else {
        r"</?[a-zA-Z]+(?=[ >])[^<>]*>"
    })
    .expect("valid");
    let text = tag.replace_all(&text, "");
    let text = indent.replace_all(&text, "\n\u{3000}\u{3000}");
    let text = text
        .trim_start_matches(|c: char| c == '\n' || c.is_whitespace())
        .trim_end_matches(|c: char| c.is_whitespace() || c == '\u{3000}');
    if text.is_empty() {
        String::new()
    } else {
        format!("\u{3000}\u{3000}{text}")
    }
}

/// Plain paragraphs for the reader: entities decoded, images dropped
/// (pictures in online chapters are not shown yet), each line trimmed,
/// empty lines removed.
pub fn content_paragraphs(html: &str) -> String {
    let formatted = format_html(html, false);
    let decoded = unescape_html(&formatted);
    decoded
        .lines()
        .map(|line| {
            line.trim_matches(|c: char| c.is_whitespace() || c == '\u{3000}' || c == '\u{a0}')
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// One source and the host its scripts run in, for one operation.
pub struct SourceSession {
    host: JsHost,
    env: Rc<Env>,
}

impl SourceSession {
    pub fn new(
        source: BookSource,
        store: Arc<dyn SourceStore>,
        control: Control,
    ) -> SourceResult<Self> {
        let env = Env::new(source, store, control);
        Ok(Self {
            host: JsHost::new(env.clone())?,
            env,
        })
    }

    pub fn env(&self) -> &Rc<Env> {
        &self.env
    }

    pub fn logs(&self) -> Vec<String> {
        self.env.logs.borrow().clone()
    }

    pub fn search(&self, key: &str, page: i64) -> SourceResult<Vec<BookData>> {
        self.host.run(|scope| search(scope, key, page))
    }

    pub fn explore_kinds(&self) -> SourceResult<Vec<ExploreKind>> {
        self.host.run(explore_kinds)
    }

    pub fn explore(&self, url: &str, page: i64) -> SourceResult<Vec<BookData>> {
        self.host.run(|scope| explore(scope, url, page))
    }

    /// Fills in the details of a search result, as `getBookInfo`.
    pub fn book_info(&self, book: &BookRef, can_rename: bool) -> SourceResult<()> {
        self.host.run(|scope| book_info(scope, book, can_rename))
    }

    pub fn chapters(&self, book: &BookRef) -> SourceResult<Vec<ChapterData>> {
        self.host.run(|scope| chapter_list(scope, book))
    }

    pub fn content(
        &self,
        book: &BookRef,
        chapter: &ChapterData,
        next_chapter_url: Option<&str>,
        chapter_urls: &[String],
    ) -> SourceResult<ChapterContent> {
        self.host
            .run(|scope| content(scope, book, chapter, next_chapter_url, chapter_urls))
    }

    /// Runs `work` with a fresh analyzer of this source, for requests made
    /// outside the usual chain such as covers.
    pub fn run_with_rule<R>(
        &self,
        work: impl for<'js> FnOnce(&JsScope<'js>, &AnalyzeRule) -> SourceResult<R>,
    ) -> SourceResult<R> {
        self.host
            .run(|scope| work(scope, &AnalyzeRule::new(self.env.clone())))
    }

    /// Runs a script with the source's bindings, as a login button or a
    /// source's own action does.
    pub fn run_script(&self, script: &str, book: Option<&BookRef>) -> SourceResult<Val> {
        self.host.run(|scope| {
            let rule = AnalyzeRule::new(self.env.clone());
            rule.set_book(book.cloned());
            rule.eval_js(scope, script, &Val::Null)
        })
    }
}

/// Fetches a URL rule and runs `loginCheckJs` on the response.
fn fetch(scope: &JsScope<'_>, rule: &AnalyzeRule, url: &AnalyzeUrl) -> SourceResult<HttpResponse> {
    let env = scope.env().clone();
    env.log(format!("请求 {}", url.url));
    let response = url.get_str_response(&env)?;
    env.log(format!(
        "响应 {} {}（{} 字节）",
        response.code,
        response.url,
        response.bytes.len()
    ));
    let response = match env
        .source
        .login_check_js()
        .filter(|js| !js.trim().is_empty())
    {
        Some(check) => scope.login_check(rule, &check, response)?,
        None => response,
    };
    if !response.is_success() && response.body.trim().is_empty() {
        return Err(SourceError::network(format!(
            "网站返回 {}：{}",
            response.code, response.url
        )));
    }
    Ok(response)
}

fn list_rule(source: &BookSource, search: bool, field: &str) -> Option<String> {
    let explore_list = source.rule("ruleExplore", "bookList");
    let section = if search || explore_list.is_none() {
        "ruleSearch"
    } else {
        "ruleExplore"
    };
    source.rule(section, field)
}

pub fn search(scope: &JsScope<'_>, key: &str, page: i64) -> SourceResult<Vec<BookData>> {
    let env = scope.env().clone();
    let search_url = env
        .source
        .search_url()
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| SourceError::rule("书源没有搜索地址"))?;
    let rule_data = Rc::new(RefCell::new(VarMap::new()));
    let rule = AnalyzeRule::new(env.clone());
    rule.set_rule_data(Some(rule_data.clone()));
    let url = AnalyzeUrl::new(
        &rule,
        scope,
        &search_url,
        Some(key),
        Some(page),
        &env.source.url(),
        None,
    )?;
    let response = fetch(scope, &rule, &url)?;
    let variables = rule_data.borrow().clone();
    analyze_book_list(scope, &url, &response, true, variables)
}

pub fn explore(scope: &JsScope<'_>, explore_url: &str, page: i64) -> SourceResult<Vec<BookData>> {
    let env = scope.env().clone();
    let rule_data = Rc::new(RefCell::new(VarMap::new()));
    let rule = AnalyzeRule::new(env.clone());
    rule.set_rule_data(Some(rule_data.clone()));
    let url = AnalyzeUrl::new(
        &rule,
        scope,
        explore_url,
        None,
        Some(page),
        &env.source.url(),
        None,
    )?;
    let response = fetch(scope, &rule, &url)?;
    let variables = rule_data.borrow().clone();
    analyze_book_list(scope, &url, &response, false, variables)
}

fn new_book(env: &Env, variables: VarMap) -> BookData {
    BookData {
        origin: env.source.url(),
        origin_name: env.source.name(),
        variables,
        ..Default::default()
    }
}

/// `BookList.analyzeBookList`.
fn analyze_book_list(
    scope: &JsScope<'_>,
    url: &AnalyzeUrl,
    response: &HttpResponse,
    is_search: bool,
    variables: VarMap,
) -> SourceResult<Vec<BookData>> {
    let env = scope.env().clone();
    let base_url = response.url.clone();
    let rule = AnalyzeRule::new(env.clone());
    rule.set_rule_data(Some(Rc::new(RefCell::new(variables.clone()))));
    rule.set_content(Val::Str(response.body.clone()), Some(&base_url));
    rule.set_redirect_url(&base_url);
    let is_redirect = split_url_option(&url.url).0 != response.url;
    if is_search {
        if let Some(pattern) = env.source.book_url_pattern() {
            if let Ok(regex) = fancy_regex::Regex::new(&format!("^(?:{pattern})$")) {
                if regex.is_match(&base_url).unwrap_or(false) {
                    env.log("搜索结果是详情页");
                    return Ok(
                        info_item(scope, &rule, url, response, is_redirect, variables)?
                            .into_iter()
                            .collect(),
                    );
                }
            }
        }
    }
    let mut list_text = list_rule(&env.source, is_search, "bookList").unwrap_or_default();
    let mut reverse = false;
    if let Some(rest) = list_text.strip_prefix('-') {
        reverse = true;
        list_text = rest.to_string();
    }
    if let Some(rest) = list_text.strip_prefix('+') {
        list_text = rest.to_string();
    }
    let items = rule.get_elements(scope, &list_text)?;
    env.log(format!("列表 {} 项", items.len()));
    if items.is_empty() && env.source.book_url_pattern().is_none() {
        return Ok(
            info_item(scope, &rule, url, response, is_redirect, variables)?
                .into_iter()
                .collect(),
        );
    }
    let split = |field: &str| {
        rule.split_source_rule(
            &list_rule(&env.source, is_search, field).unwrap_or_default(),
            false,
        )
    };
    let rules = ListRules {
        name: split("name"),
        author: split("author"),
        kind: split("kind"),
        word_count: split("wordCount"),
        last_chapter: split("lastChapter"),
        intro: split("intro"),
        cover_url: split("coverUrl"),
        book_url: split("bookUrl"),
    };
    let mut books: Vec<BookData> = Vec::new();
    for item in items {
        env.control.check()?;
        if let Some(mut book) = search_item(scope, &rule, item, &base_url, &variables, &rules)? {
            if book.book_url == base_url {
                book.info_html = Some(response.body.clone());
            }
            if !books
                .iter()
                .any(|existing| existing.book_url == book.book_url)
            {
                books.push(book);
            }
        }
    }
    if reverse {
        books.reverse();
    }
    Ok(books)
}

struct ListRules {
    name: Vec<SourceRule>,
    author: Vec<SourceRule>,
    kind: Vec<SourceRule>,
    word_count: Vec<SourceRule>,
    last_chapter: Vec<SourceRule>,
    intro: Vec<SourceRule>,
    cover_url: Vec<SourceRule>,
    book_url: Vec<SourceRule>,
}

fn rule_string(
    scope: &JsScope<'_>,
    rule: &AnalyzeRule,
    rules: &[SourceRule],
    is_url: bool,
) -> SourceResult<String> {
    if rules.is_empty() {
        return Ok(if is_url {
            rule.base_url()
        } else {
            String::new()
        });
    }
    rule.get_string_rules(scope, rules.to_vec(), None, is_url, true)
}

fn search_item(
    scope: &JsScope<'_>,
    rule: &AnalyzeRule,
    item: Val,
    base_url: &str,
    variables: &VarMap,
    rules: &ListRules,
) -> SourceResult<Option<BookData>> {
    let env = scope.env().clone();
    let book = Rc::new(RefCell::new(new_book(&env, variables.clone())));
    rule.set_book(Some(book.clone()));
    rule.set_rule_data(None);
    rule.set_content(item, None);
    let name = format_book_name(&rule_string(scope, rule, &rules.name, false)?);
    if name.is_empty() {
        return Ok(None);
    }
    book.borrow_mut().name = name;
    let author = format_book_author(&rule_string(scope, rule, &rules.author, false)?);
    book.borrow_mut().author = author;
    if !rules.kind.is_empty() {
        let kind = kind_list(scope, rule, &rules.kind)?;
        book.borrow_mut().kind = kind;
    }
    let word_count = word_count_format(&rule_string(scope, rule, &rules.word_count, false)?);
    book.borrow_mut().word_count = word_count;
    let last_chapter = rule_string(scope, rule, &rules.last_chapter, false)?;
    book.borrow_mut().latest_chapter_title = last_chapter;
    let intro = html_format(&rule_string(scope, rule, &rules.intro, false)?);
    book.borrow_mut().intro = intro;
    if !rules.cover_url.is_empty() {
        let cover = rule_string(scope, rule, &rules.cover_url, true)?;
        book.borrow_mut().cover_url = cover;
    }
    let mut book_url = if rules.book_url.is_empty() {
        String::new()
    } else {
        rule_string(scope, rule, &rules.book_url, true)?
    };
    if book_url.is_empty() {
        book_url = base_url.to_string();
    }
    book.borrow_mut().book_url = book_url;
    rule.set_book(None);
    let result = book.borrow().clone();
    Ok(Some(result))
}

/// A kind rule's list, joined by commas as Legado shows it.
fn kind_list(
    scope: &JsScope<'_>,
    rule: &AnalyzeRule,
    rules: &[SourceRule],
) -> SourceResult<String> {
    // `getStringList` with pre-split rules: run each segment like a string
    // rule but keep the list.
    let text = rule.get_string_rules(scope, rules.to_vec(), None, false, true)?;
    Ok(text
        .split('\n')
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .collect::<Vec<_>>()
        .join(","))
}

/// `BookList.getInfoItem`: the search page was itself a details page.
fn info_item(
    scope: &JsScope<'_>,
    rule: &AnalyzeRule,
    url: &AnalyzeUrl,
    response: &HttpResponse,
    is_redirect: bool,
    variables: VarMap,
) -> SourceResult<Option<BookData>> {
    let env = scope.env().clone();
    let mut data = new_book(&env, variables);
    data.book_url = if is_redirect {
        response.url.clone()
    } else {
        absolute_url(&url.url, &url.rule_url)
    };
    let book = Rc::new(RefCell::new(data));
    rule.set_book(Some(book.clone()));
    analyze_book_info(scope, &book, &response.body, rule, &response.url, false)?;
    book.borrow_mut().info_html = Some(response.body.clone());
    let result = book.borrow().clone();
    Ok((!result.name.trim().is_empty()).then_some(result))
}

pub fn book_info(scope: &JsScope<'_>, book: &BookRef, can_rename: bool) -> SourceResult<()> {
    let env = scope.env().clone();
    let cached = book.borrow().info_html.clone();
    let rule = AnalyzeRule::new(env.clone());
    rule.set_book(Some(book.clone()));
    match cached.filter(|html| !html.is_empty()) {
        Some(html) => {
            let base = book.borrow().book_url.clone();
            rule.set_content(Val::Str(html.clone()), Some(&base));
            rule.set_redirect_url(&base);
            analyze_book_info(scope, book, &html, &rule, &base, can_rename)
        }
        None => {
            let book_url = book.borrow().book_url.clone();
            let url =
                AnalyzeUrl::new(&rule, scope, &book_url, None, None, &env.source.url(), None)?;
            let response = fetch(scope, &rule, &url)?;
            rule.set_content(Val::Str(response.body.clone()), Some(&url.url));
            rule.set_redirect_url(&response.url);
            analyze_book_info(
                scope,
                book,
                &response.body,
                &rule,
                &response.url,
                can_rename,
            )
        }
    }
}

/// `BookInfo.analyzeBookInfo`.
fn analyze_book_info(
    scope: &JsScope<'_>,
    book: &BookRef,
    body: &str,
    rule: &AnalyzeRule,
    redirect_url: &str,
    can_rename: bool,
) -> SourceResult<()> {
    let env = scope.env().clone();
    let source = &env.source;
    let info = |field: &str| source.rule("ruleBookInfo", field).unwrap_or_default();
    let base_url = rule.base_url();
    if let Some(init) = source
        .rule("ruleBookInfo", "init")
        .filter(|init| !init.trim().is_empty())
    {
        let content = rule.get_element(scope, &init)?;
        rule.set_content(content, None);
    }
    let may_rename = can_rename && !info("canReName").trim().is_empty();
    let name = format_book_name(&rule.get_string(scope, &info("name"))?);
    if !name.is_empty() && (may_rename || book.borrow().name.is_empty()) {
        book.borrow_mut().name = name;
    }
    let author = format_book_author(&rule.get_string(scope, &info("author"))?);
    if !author.is_empty() && (may_rename || book.borrow().author.is_empty()) {
        book.borrow_mut().author = author;
    }
    let kind_rule = info("kind");
    if !kind_rule.is_empty() {
        let kinds = rule
            .get_string_list(scope, &kind_rule, None, false)?
            .unwrap_or_default();
        let kind = kinds
            .iter()
            .map(|kind| kind.trim())
            .filter(|kind| !kind.is_empty())
            .collect::<Vec<_>>()
            .join(",");
        if !kind.is_empty() {
            book.borrow_mut().kind = kind;
        }
    }
    let word_count = word_count_format(&rule.get_string(scope, &info("wordCount"))?);
    if !word_count.is_empty() {
        book.borrow_mut().word_count = word_count;
    }
    let last_chapter = rule.get_string(scope, &info("lastChapter"))?;
    if !last_chapter.is_empty() {
        book.borrow_mut().latest_chapter_title = last_chapter;
    }
    let intro = html_format(&rule.get_string(scope, &info("intro"))?);
    if !intro.is_empty() {
        book.borrow_mut().intro = intro;
    }
    let cover_rule = info("coverUrl");
    if !cover_rule.is_empty() {
        let cover = rule.get_url(scope, &cover_rule)?;
        if !cover.is_empty() {
            book.borrow_mut().cover_url = cover;
        }
    }
    let toc_rule = info("tocUrl");
    let mut toc_url = if toc_rule.is_empty() {
        String::new()
    } else {
        rule.get_url(scope, &toc_rule)?
    };
    if toc_url.is_empty() {
        toc_url = base_url.clone();
    }
    if toc_url == base_url || toc_url == redirect_url {
        book.borrow_mut().toc_html = Some(body.to_string());
    }
    book.borrow_mut().toc_url = toc_url;
    env.log(format!(
        "详情：{} / {}",
        book.borrow().name,
        book.borrow().author
    ));
    Ok(())
}

/// Runs `preUpdateJs` before the table of contents is fetched.
fn pre_update(scope: &JsScope<'_>, book: &BookRef) -> SourceResult<()> {
    let env = scope.env().clone();
    if let Some(script) = env
        .source
        .rule("ruleToc", "preUpdateJs")
        .filter(|js| !js.trim().is_empty())
    {
        let rule = AnalyzeRule::new(env.clone());
        rule.set_book(Some(book.clone()));
        rule.eval_js(scope, &script, &Val::Null)?;
    }
    Ok(())
}

/// `java.refreshTocUrl()`: the details page again, for a new `tocUrl`.
pub fn refresh_toc_url(scope: &JsScope<'_>, book: &BookRef) -> SourceResult<()> {
    book.borrow_mut().info_html = None;
    book_info(scope, book, false)
}

/// `java.reGetBook()`: finds the book again by name and author on this
/// source, then reads its details.
pub fn re_get_book(scope: &JsScope<'_>, book: &BookRef) -> SourceResult<()> {
    let (name, author) = {
        let data = book.borrow();
        (data.name.clone(), data.author.clone())
    };
    let found = search(scope, &name, 1)?
        .into_iter()
        .find(|candidate| candidate.name == name && candidate.author == author)
        .ok_or_else(|| SourceError::empty(format!("没有找到《{name}》")))?;
    {
        let mut data = book.borrow_mut();
        data.book_url = found.book_url;
        data.info_html = found.info_html;
        data.toc_html = None;
    }
    book_info(scope, book, false)
}

pub fn chapter_list(scope: &JsScope<'_>, book: &BookRef) -> SourceResult<Vec<ChapterData>> {
    let env = scope.env().clone();
    pre_update(scope, book)?;
    let (book_url, toc_url, toc_html) = {
        let data = book.borrow();
        (
            data.book_url.clone(),
            data.toc_url.clone(),
            data.toc_html.clone(),
        )
    };
    let toc_url = if toc_url.is_empty() {
        book_url.clone()
    } else {
        toc_url
    };
    let (redirect_url, body) = match toc_html.filter(|html| !html.is_empty() && toc_url == book_url)
    {
        Some(html) => (toc_url.clone(), html),
        None => {
            let rule = AnalyzeRule::new(env.clone());
            rule.set_book(Some(book.clone()));
            let url = AnalyzeUrl::new(&rule, scope, &toc_url, None, None, &book_url, None)?;
            let response = fetch(scope, &rule, &url)?;
            (response.url, response.body)
        }
    };
    let mut list_text = env
        .source
        .rule("ruleToc", "chapterList")
        .unwrap_or_default();
    let mut reverse = false;
    if let Some(rest) = list_text.strip_prefix('-') {
        reverse = true;
        list_text = rest.to_string();
    }
    if let Some(rest) = list_text.strip_prefix('+') {
        list_text = rest.to_string();
    }
    let (mut chapters, next_urls) = analyze_chapter_page(
        scope,
        book,
        &toc_url,
        &redirect_url,
        &body,
        &list_text,
        true,
    )?;
    let mut visited = vec![redirect_url.clone()];
    match next_urls.len() {
        0 => {}
        1 => {
            let mut next = next_urls[0].clone();
            while !next.is_empty() && !visited.contains(&next) {
                env.control.check()?;
                visited.push(next.clone());
                let rule = AnalyzeRule::new(env.clone());
                rule.set_book(Some(book.clone()));
                let url = AnalyzeUrl::new(&rule, scope, &next, None, None, &book_url, None)?;
                let response = fetch(scope, &rule, &url)?;
                let (page, urls) = analyze_chapter_page(
                    scope,
                    book,
                    &next,
                    &response.url,
                    &response.body,
                    &list_text,
                    true,
                )?;
                chapters.extend(page);
                next = urls.into_iter().next().unwrap_or_default();
            }
        }
        _ => {
            for next in next_urls {
                env.control.check()?;
                let rule = AnalyzeRule::new(env.clone());
                rule.set_book(Some(book.clone()));
                let url = AnalyzeUrl::new(&rule, scope, &next, None, None, &book_url, None)?;
                let response = fetch(scope, &rule, &url)?;
                let (page, _) = analyze_chapter_page(
                    scope,
                    book,
                    &next,
                    &response.url,
                    &response.body,
                    &list_text,
                    false,
                )?;
                chapters.extend(page);
            }
        }
    }
    if chapters.is_empty() {
        return Err(SourceError::empty("目录为空"));
    }
    // Duplicates keep the occurrence nearest the end of the book, as
    // Legado's reverse-dedupe-reverse does.
    if !reverse {
        chapters.reverse();
    }
    let mut unique: Vec<ChapterData> = Vec::with_capacity(chapters.len());
    for chapter in chapters {
        if !unique.iter().any(|existing| existing.url == chapter.url) {
            unique.push(chapter);
        }
    }
    unique.reverse();
    for (index, chapter) in unique.iter_mut().enumerate() {
        chapter.index = index;
    }
    if let Some(format_js) = env
        .source
        .rule("ruleToc", "formatJs")
        .filter(|js| !js.trim().is_empty())
    {
        format_titles(scope, book, &mut unique, &format_js)?;
    }
    if let Some(last) = unique.last() {
        book.borrow_mut().latest_chapter_title = last.title.clone();
    }
    env.log(format!("目录 {} 章", unique.len()));
    Ok(unique)
}

fn format_titles(
    scope: &JsScope<'_>,
    book: &BookRef,
    chapters: &mut [ChapterData],
    format_js: &str,
) -> SourceResult<()> {
    let env = scope.env().clone();
    // `gInt` is shared by every chapter's run, as Legado binds it once.
    AnalyzeRule::new(env.clone()).eval_js(scope, "gInt = 0", &Val::Null)?;
    let script = format!("var index = __gr_index; {format_js}");
    for (index, chapter) in chapters.iter_mut().enumerate() {
        let shared = Rc::new(RefCell::new(chapter.clone()));
        let rule = AnalyzeRule::new(env.clone());
        rule.set_book(Some(book.clone()));
        rule.set_chapter(Some(shared.clone()));
        let prepared = script.replace("__gr_index", &(index + 1).to_string());
        match rule.eval_js(scope, &prepared, &Val::Null) {
            Ok(Val::Null) => {}
            Ok(value) => chapter.title = value.to_text(),
            Err(error) => env.log(format!("formatJs 出错：{}", error.message)),
        }
    }
    Ok(())
}

fn analyze_chapter_page(
    scope: &JsScope<'_>,
    book: &BookRef,
    base_url: &str,
    redirect_url: &str,
    body: &str,
    list_rule: &str,
    want_next: bool,
) -> SourceResult<(Vec<ChapterData>, Vec<String>)> {
    let env = scope.env().clone();
    let source = &env.source;
    let rule = AnalyzeRule::new(env.clone());
    rule.set_book(Some(book.clone()));
    rule.set_content(Val::Str(body.to_string()), Some(base_url));
    rule.set_redirect_url(redirect_url);
    let items = rule.get_elements(scope, list_rule)?;
    let mut next_urls = Vec::new();
    if want_next {
        if let Some(next_rule) = source.rule("ruleToc", "nextTocUrl") {
            for url in rule
                .get_string_list(scope, &next_rule, None, true)?
                .unwrap_or_default()
            {
                if url != redirect_url {
                    next_urls.push(url);
                }
            }
        }
    }
    let toc = |field: &str| {
        rule.split_source_rule(&source.rule("ruleToc", field).unwrap_or_default(), false)
    };
    let name_rule = toc("chapterName");
    let url_rule = toc("chapterUrl");
    let vip_rule = toc("isVip");
    let pay_rule = toc("isPay");
    let time_rule = toc("updateTime");
    let volume_rule = toc("isVolume");
    let mut chapters = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        env.control.check()?;
        let item_volume = match &item {
            Val::Json(Json::Object(map)) => map.get("isVolume").map(json_text),
            _ => None,
        };
        rule.set_content(item, None);
        let chapter: ChapterRef = Rc::new(RefCell::new(ChapterData {
            base_url: redirect_url.to_string(),
            ..Default::default()
        }));
        rule.set_chapter(Some(chapter.clone()));
        let get = |rules: &Vec<SourceRule>| -> SourceResult<String> {
            if rules.is_empty() {
                Ok(String::new())
            } else {
                rule.get_string_rules(scope, rules.clone(), None, false, true)
            }
        };
        let title = get(&name_rule)?;
        let url = get(&url_rule)?;
        let tag = get(&time_rule)?;
        let volume = if volume_rule.is_empty() {
            item_volume.unwrap_or_default()
        } else {
            get(&volume_rule)?
        };
        {
            let mut data = chapter.borrow_mut();
            data.title = title;
            data.url = url;
            data.tag = tag;
            data.is_volume = is_true(&volume);
            if data.url.is_empty() {
                data.url = if data.is_volume {
                    format!("{}{index}", data.title)
                } else {
                    base_url.to_string()
                };
            }
        }
        if chapter.borrow().title.is_empty() {
            continue;
        }
        let vip = get(&vip_rule)?;
        let pay = get(&pay_rule)?;
        let mut data = chapter.borrow().clone();
        data.is_vip = is_true(&vip);
        data.is_pay = is_true(&pay);
        chapters.push(data);
    }
    rule.set_chapter(None);
    Ok((chapters, next_urls))
}

/// A chapter's address resolved against the page that listed it, keeping
/// any `,{…}` option.
pub fn chapter_absolute_url(chapter: &ChapterData) -> String {
    if chapter.is_volume && chapter.url.starts_with(&chapter.title) {
        return chapter.base_url.clone();
    }
    absolute_url(&chapter.base_url, &chapter.url)
}

pub fn content(
    scope: &JsScope<'_>,
    book: &BookRef,
    chapter: &ChapterData,
    next_chapter_url: Option<&str>,
    chapter_urls: &[String],
) -> SourceResult<ChapterContent> {
    let env = scope.env().clone();
    let source = &env.source;
    let Some(content_rule) = source.rule("ruleContent", "content") else {
        return Ok(ChapterContent {
            text: chapter.url.clone(),
            title: None,
        });
    };
    if chapter.is_volume && chapter.url.starts_with(&chapter.title) {
        return Ok(ChapterContent {
            text: chapter.tag.clone(),
            title: None,
        });
    }
    let shared: ChapterRef = Rc::new(RefCell::new(chapter.clone()));
    let chapter_url = chapter_absolute_url(chapter);
    let (book_url, toc_url, toc_html) = {
        let data = book.borrow();
        (
            data.book_url.clone(),
            data.toc_url.clone(),
            data.toc_html.clone(),
        )
    };
    let (base_url, redirect_url, body) = match toc_html
        .filter(|html| !html.is_empty() && chapter.url == book_url)
    {
        Some(html) => (chapter_url.clone(), chapter_url.clone(), html),
        None => {
            let rule = AnalyzeRule::new(env.clone());
            rule.set_book(Some(book.clone()));
            rule.set_chapter(Some(shared.clone()));
            let mut url = AnalyzeUrl::new(&rule, scope, &chapter_url, None, None, &toc_url, None)?;
            if url.web_js.is_none() {
                url.web_js = source.rule("ruleContent", "webJs");
            }
            let mut response = fetch(scope, &rule, &url)?;
            if let Some(pattern) = source.rule("ruleContent", "sourceRegex") {
                if let Ok(regex) = super::rule::regex::compile(&pattern) {
                    if let Ok(Some(found)) = regex.find(&response.body) {
                        response.body = found.as_str().to_string();
                    }
                }
            }
            (response.url.clone(), response.url, response.body)
        }
    };
    let next_chapter = next_chapter_url.map(str::to_string);
    let mut pages = Vec::new();
    let (first, next_urls) = analyze_content_page(
        scope,
        book,
        &shared,
        &base_url,
        &redirect_url,
        &body,
        &content_rule,
        next_chapter.as_deref(),
        true,
    )?;
    pages.push(first);
    let mut visited = vec![redirect_url.clone()];
    let stops = |url: &str| -> bool {
        let absolute = absolute_url(&redirect_url, url);
        next_chapter
            .as_deref()
            .is_some_and(|next| absolute_url(&redirect_url, next) == absolute)
            || chapter_urls
                .iter()
                .any(|other| *other == absolute && *other != chapter_url)
    };
    let next_urls: Vec<String> =
        next_urls
            .into_iter()
            .filter(|url| !stops(url))
            .fold(Vec::new(), |mut list, url| {
                if !list.contains(&url) {
                    list.push(url);
                }
                list
            });
    if next_urls.len() == 1 {
        let mut next = next_urls[0].clone();
        while !next.is_empty() && !visited.contains(&next) && !stops(&next) {
            env.control.check()?;
            visited.push(next.clone());
            let rule = AnalyzeRule::new(env.clone());
            rule.set_book(Some(book.clone()));
            rule.set_chapter(Some(shared.clone()));
            let url = AnalyzeUrl::new(&rule, scope, &next, None, None, &toc_url, None)?;
            let response = fetch(scope, &rule, &url)?;
            let (page, urls) = analyze_content_page(
                scope,
                book,
                &shared,
                &next,
                &response.url,
                &response.body,
                &content_rule,
                next_chapter.as_deref(),
                true,
            )?;
            pages.push(page);
            next = urls.into_iter().next().unwrap_or_default();
        }
    } else if next_urls.len() > 1 {
        for next in next_urls {
            env.control.check()?;
            let rule = AnalyzeRule::new(env.clone());
            rule.set_book(Some(book.clone()));
            rule.set_chapter(Some(shared.clone()));
            let url = AnalyzeUrl::new(&rule, scope, &next, None, None, &toc_url, None)?;
            let response = fetch(scope, &rule, &url)?;
            let (page, _) = analyze_content_page(
                scope,
                book,
                &shared,
                &next,
                &response.url,
                &response.body,
                &content_rule,
                next_chapter.as_deref(),
                false,
            )?;
            pages.push(page);
        }
    }
    let mut text = pages.join("\n");
    let rule = AnalyzeRule::new(env.clone());
    rule.set_book(Some(book.clone()));
    rule.set_chapter(Some(shared.clone()));
    rule.set_content(Val::Str(body.clone()), Some(&base_url));
    rule.set_redirect_url(&redirect_url);
    if let Some(replace) = source
        .rule("ruleContent", "replaceRegex")
        .filter(|rule| !rule.is_empty())
    {
        let trimmed = text.lines().map(str::trim).collect::<Vec<_>>().join("\n");
        text = rule.get_string_with(scope, &replace, Some(&Val::Str(trimmed)), false)?;
    }
    let title = match source
        .rule("ruleContent", "title")
        .filter(|rule| !rule.trim().is_empty())
    {
        Some(title_rule) => rule
            .get_string(scope, &title_rule)
            .ok()
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty()),
        None => None,
    };
    let mut paragraphs = content_paragraphs(&text);
    // A first line repeating the title is dropped, as Legado's processor does.
    let shown_title = title.clone().unwrap_or_else(|| chapter.title.clone());
    if let Some(first) = paragraphs.lines().next() {
        if normalize_title(first) == normalize_title(&shown_title) {
            paragraphs = paragraphs.lines().skip(1).collect::<Vec<_>>().join("\n");
        }
    }
    if paragraphs.trim().is_empty() && !chapter.is_volume {
        return Err(SourceError::empty("正文为空"));
    }
    Ok(ChapterContent {
        text: paragraphs,
        title,
    })
}

fn normalize_title(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{3000}')
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn analyze_content_page(
    scope: &JsScope<'_>,
    book: &BookRef,
    chapter: &ChapterRef,
    base_url: &str,
    redirect_url: &str,
    body: &str,
    content_rule: &str,
    next_chapter_url: Option<&str>,
    want_next: bool,
) -> SourceResult<(String, Vec<String>)> {
    let env = scope.env().clone();
    let rule = AnalyzeRule::new(env.clone());
    rule.set_book(Some(book.clone()));
    rule.set_chapter(Some(chapter.clone()));
    rule.set_content(Val::Str(body.to_string()), Some(base_url));
    rule.set_redirect_url(redirect_url);
    rule.set_next_chapter_url(next_chapter_url.map(str::to_string));
    let rules = rule.split_source_rule(content_rule, false);
    let content = rule.get_string_rules(scope, rules, None, false, false)?;
    let mut next_urls = Vec::new();
    if want_next {
        if let Some(next_rule) = env
            .source
            .rule("ruleContent", "nextContentUrl")
            .filter(|rule| !rule.is_empty())
        {
            next_urls = rule
                .get_string_list(scope, &next_rule, None, true)?
                .unwrap_or_default();
        }
    }
    Ok((content, next_urls))
}

fn explore_cache_key(env: &Env) -> String {
    let explore_url = env.source.explore_url().unwrap_or_default();
    format!(
        "exploreKinds_{}",
        super::js::crypto::md5_hex(format!("{}{}", env.source.url(), explore_url).as_bytes())
    )
}

/// Forgets the categories an explore script produced, so they are built again.
pub fn clear_explore_cache(env: &Env) {
    env.store.cache_delete(&explore_cache_key(env));
}

pub fn explore_kinds(scope: &JsScope<'_>) -> SourceResult<Vec<ExploreKind>> {
    let env = scope.env().clone();
    let Some(explore_url) = env
        .source
        .explore_url()
        .filter(|url| !url.trim().is_empty())
    else {
        return Ok(Vec::new());
    };
    let cache_key = explore_cache_key(&env);
    let trimmed = explore_url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let text = if lower.starts_with("<js>") || lower.starts_with("@js:") {
        match env.store.cache_get(&cache_key) {
            Some(cached) if !cached.trim().is_empty() => cached,
            _ => {
                let script = if lower.starts_with("@js:") {
                    &trimmed[4..]
                } else {
                    &trimmed[4..trimmed.rfind('<').unwrap_or(trimmed.len()).max(4)]
                };
                let rule = AnalyzeRule::new(env.clone());
                match rule.eval_js(scope, script, &Val::Null) {
                    Ok(value) => {
                        let text = value.to_text().trim().to_string();
                        env.store.cache_put(&cache_key, &text, 0);
                        text
                    }
                    Err(error) => {
                        return Ok(vec![ExploreKind {
                            title: format!("ERROR:{}", error.message),
                            url: None,
                            style: None,
                        }])
                    }
                }
            }
        }
    } else {
        trimmed.to_string()
    };
    Ok(parse_explore_kinds(&text))
}

pub fn parse_explore_kinds(text: &str) -> Vec<ExploreKind> {
    let trimmed = text.trim();
    if trimmed.starts_with('[') {
        return match lenient_json::parse(trimmed) {
            Ok(Json::Array(items)) => items
                .into_iter()
                .filter_map(|item| {
                    let item = match item {
                        Json::String(text) => lenient_json::parse(&text).ok()?,
                        other => other,
                    };
                    let map = item.as_object()?;
                    Some(ExploreKind {
                        title: map.get("title").map(json_text).unwrap_or_default(),
                        url: map.get("url").map(json_text).filter(|url| !url.is_empty()),
                        style: map.get("style").cloned().filter(|style| !style.is_null()),
                    })
                })
                .collect(),
            Ok(_) | Err(_) => vec![ExploreKind {
                title: "ERROR:发现地址不是有效的 JSON".to_string(),
                url: None,
                style: None,
            }],
        };
    }
    let separator = regex::Regex::new(r"(&&|\n)+").expect("valid");
    separator
        .split(trimmed)
        .filter(|part| !part.trim().is_empty())
        .map(|part| {
            let mut pieces = part.splitn(2, "::");
            let title = pieces.next().unwrap_or("").trim().to_string();
            let url = pieces
                .next()
                .map(|url| url.trim().to_string())
                .filter(|url| !url.is_empty());
            ExploreKind {
                title,
                url,
                style: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests;
