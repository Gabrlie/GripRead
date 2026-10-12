//! An HTML document with Jsoup's observable semantics, which Legado rules
//! are written against: `select` includes the element itself, Jsoup's own
//! pseudo-classes, `text()` whitespace rules, and pretty `outerHtml()`.

use std::collections::HashSet;
use std::rc::Rc;

use ego_tree::{NodeId, NodeRef};
use scraper::{ElementRef, Html, Node as HtmlNode, Selector};

struct Document {
    html: Html,
    base_url: String,
}

/// An element (or the document itself) inside a parsed page.
#[derive(Clone)]
pub struct Element {
    doc: Rc<Document>,
    id: NodeId,
}

impl std::fmt::Debug for Element {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Element({})", self.outer_html())
    }
}

impl PartialEq for Element {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.doc, &other.doc) && self.id == other.id
    }
}

/// Parses a page like `Jsoup.parse`, returning the document node.
pub fn parse(html: &str, base_url: &str) -> Element {
    let trimmed = html.trim_start();
    // Jsoup drops table fragments outside a table; wrap them as Legado's
    // XPath parser does so `<tr>` and `<td>` items keep their cells.
    let source = if starts_with_tag(trimmed, "tr") {
        format!("<table>{html}</table>")
    } else if starts_with_tag(trimmed, "td") || starts_with_tag(trimmed, "th") {
        format!("<table><tr>{html}</tr></table>")
    } else {
        html.to_string()
    };
    let html = Html::parse_document(&source);
    let id = html.tree.root().id();
    Element {
        doc: Rc::new(Document {
            html,
            base_url: base_url.to_string(),
        }),
        id,
    }
}

fn starts_with_tag(text: &str, tag: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.first() != Some(&b'<') || text.len() < tag.len() + 2 {
        return false;
    }
    let name = &text[1..1 + tag.len()];
    let after = bytes[1 + tag.len()];
    name.eq_ignore_ascii_case(tag)
        && (after == b'>' || after.is_ascii_whitespace() || after == b'/')
}

const BLOCK_TAGS: &[&str] = &[
    "html",
    "head",
    "body",
    "frameset",
    "script",
    "noscript",
    "style",
    "meta",
    "link",
    "title",
    "frame",
    "noframes",
    "section",
    "nav",
    "aside",
    "hgroup",
    "header",
    "footer",
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "pre",
    "div",
    "blockquote",
    "hr",
    "address",
    "figure",
    "figcaption",
    "form",
    "fieldset",
    "ins",
    "del",
    "dl",
    "dt",
    "dd",
    "li",
    "table",
    "caption",
    "thead",
    "tfoot",
    "tbody",
    "colgroup",
    "col",
    "tr",
    "th",
    "td",
    "video",
    "audio",
    "canvas",
    "details",
    "menu",
    "plaintext",
    "template",
    "article",
    "main",
    "svg",
    "math",
    "center",
    "dir",
    "applet",
    "marquee",
    "listing",
];

const VOID_TAGS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr", "basefont", "bgsound", "frame", "keygen",
];

fn is_block(name: &str) -> bool {
    BLOCK_TAGS.contains(&name)
}

fn is_whitespace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r')
}

fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200b}' | '\u{ad}')
}

/// Appends text with runs of whitespace collapsed to one space, as Jsoup's
/// `appendNormalisedWhitespace`.
fn append_normalised(out: &mut String, text: &str, strip_leading: bool) {
    let mut last_white = false;
    let mut reached_non_white = false;
    for c in text.chars() {
        if is_whitespace(c) {
            if (strip_leading && !reached_non_white) || last_white {
                continue;
            }
            out.push(' ');
            last_white = true;
        } else if !is_invisible(c) {
            out.push(c);
            last_white = false;
            reached_non_white = true;
        }
    }
}

fn ends_with_whitespace(out: &str) -> bool {
    out.ends_with(' ')
}

fn escape_text(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            _ => out.push(c),
        }
    }
}

fn escape_attr(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            _ => out.push(c),
        }
    }
}

impl Element {
    pub(crate) fn node(&self) -> NodeRef<'_, HtmlNode> {
        self.doc
            .html
            .tree
            .get(self.id)
            .expect("element ids come from their tree")
    }

    pub(crate) fn with_id(&self, id: NodeId) -> Element {
        Element {
            doc: self.doc.clone(),
            id,
        }
    }

    fn element_ref(&self) -> Option<ElementRef<'_>> {
        ElementRef::wrap(self.node())
    }

    /// The page this element was parsed from, for resolving relative links.
    pub fn base_url(&self) -> &str {
        &self.doc.base_url
    }

    pub fn is_document(&self) -> bool {
        self.node().value().is_document()
    }

    /// The document that holds this element.
    pub fn document(&self) -> Element {
        self.with_id(self.doc.html.tree.root().id())
    }

    pub fn tag_name(&self) -> String {
        match self.node().value() {
            HtmlNode::Element(element) => element.name().to_string(),
            _ => "#root".to_string(),
        }
    }

    pub fn attr(&self, name: &str) -> Option<String> {
        if let Some(name) = name.strip_prefix("abs:") {
            let value = self.attr(name)?;
            return Some(
                url::Url::parse(&self.doc.base_url)
                    .and_then(|base| base.join(value.trim()))
                    .map(|url| url.to_string())
                    .unwrap_or(value),
            );
        }
        match self.node().value() {
            HtmlNode::Element(element) => element
                .attrs()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.to_string()),
            _ => None,
        }
    }

    pub fn has_attr(&self, name: &str) -> bool {
        self.attr(name).is_some()
    }

    /// The attributes as name/value pairs, in document order.
    pub fn attributes(&self) -> Vec<(String, String)> {
        match self.node().value() {
            HtmlNode::Element(element) => element
                .attrs()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn id_attr(&self) -> String {
        self.attr("id").unwrap_or_default()
    }

    pub fn class_name(&self) -> String {
        self.attr("class").unwrap_or_default()
    }

    pub fn has_class(&self, class: &str) -> bool {
        let classes = self.class_name();
        class.split_whitespace().all(|wanted| {
            classes
                .split_whitespace()
                .any(|c| c.eq_ignore_ascii_case(wanted))
        }) && !class.trim().is_empty()
    }

    pub fn parent(&self) -> Option<Element> {
        self.node()
            .parent()
            .filter(|parent| parent.value().is_element() || parent.value().is_document())
            .map(|parent| self.with_id(parent.id()))
    }

    /// Element children, like Jsoup's `children()`.
    pub fn children(&self) -> Vec<Element> {
        self.node()
            .children()
            .filter(|child| child.value().is_element())
            .map(|child| self.with_id(child.id()))
            .collect()
    }

    /// The element's position among its element siblings.
    pub fn sibling_index(&self) -> usize {
        self.node()
            .prev_siblings()
            .filter(|sibling| sibling.value().is_element())
            .count()
    }

    pub fn next_element_sibling(&self) -> Option<Element> {
        self.node()
            .next_siblings()
            .find(|sibling| sibling.value().is_element())
            .map(|sibling| self.with_id(sibling.id()))
    }

    pub fn previous_element_sibling(&self) -> Option<Element> {
        self.node()
            .prev_siblings()
            .find(|sibling| sibling.value().is_element())
            .map(|sibling| self.with_id(sibling.id()))
    }

    /// This element and its descendant elements in document order.
    fn self_and_descendants(&self) -> Vec<Element> {
        self.node()
            .descendants()
            .filter(|node| node.value().is_element())
            .map(|node| self.with_id(node.id()))
            .collect()
    }

    pub fn elements_by_class(&self, class: &str) -> Vec<Element> {
        self.self_and_descendants()
            .into_iter()
            .filter(|element| element.has_class(class))
            .collect()
    }

    pub fn elements_by_tag(&self, tag: &str) -> Vec<Element> {
        self.self_and_descendants()
            .into_iter()
            .filter(|element| tag == "*" || element.tag_name().eq_ignore_ascii_case(tag))
            .collect()
    }

    pub fn elements_by_id(&self, id: &str) -> Vec<Element> {
        self.self_and_descendants()
            .into_iter()
            .filter(|element| element.attr("id").as_deref() == Some(id))
            .collect()
    }

    pub fn elements_containing_own_text(&self, text: &str) -> Vec<Element> {
        let needle = text.to_lowercase();
        self.self_and_descendants()
            .into_iter()
            .filter(|element| element.own_text().to_lowercase().contains(&needle))
            .collect()
    }

    /// Jsoup's `select`: CSS with Jsoup's extra pseudo-classes, matching this
    /// element itself as well as its descendants.
    pub fn select(&self, css: &str) -> Result<Vec<Element>, String> {
        select(self, css)
    }

    pub fn select_first(&self, css: &str) -> Result<Option<Element>, String> {
        Ok(self.select(css)?.into_iter().next())
    }

    /// Jsoup's `text()`.
    pub fn text(&self) -> String {
        let mut out = String::new();
        self.accumulate_text(self.node(), &mut out, false);
        out.trim_matches(is_whitespace).to_string()
    }

    fn accumulate_text(&self, node: NodeRef<'_, HtmlNode>, out: &mut String, preserve: bool) {
        match node.value() {
            HtmlNode::Text(text) => {
                if preserve {
                    out.push_str(text);
                } else {
                    let strip = out.is_empty() || ends_with_whitespace(out);
                    append_normalised(out, text, strip);
                }
            }
            HtmlNode::Element(element) => {
                let name = element.name();
                if matches!(name, "script" | "style") {
                    return;
                }
                if !out.is_empty() && (is_block(name) || name == "br") && !ends_with_whitespace(out)
                {
                    out.push(' ');
                }
                let preserve = preserve || matches!(name, "pre" | "textarea");
                for child in node.children() {
                    self.accumulate_text(child, out, preserve);
                }
                if is_block(name)
                    && node
                        .next_sibling()
                        .is_some_and(|next| next.value().is_text())
                    && !ends_with_whitespace(out)
                {
                    out.push(' ');
                }
            }
            HtmlNode::Document | HtmlNode::Fragment => {
                for child in node.children() {
                    self.accumulate_text(child, out, preserve);
                }
            }
            _ => {}
        }
    }

    /// Jsoup's `ownText()`: direct text children only.
    pub fn own_text(&self) -> String {
        let mut out = String::new();
        for child in self.node().children() {
            match child.value() {
                HtmlNode::Text(text) => {
                    let strip = out.is_empty() || ends_with_whitespace(&out);
                    append_normalised(&mut out, text, strip);
                }
                HtmlNode::Element(element)
                    if element.name() == "br" && !ends_with_whitespace(&out) =>
                {
                    out.push(' ');
                }
                _ => {}
            }
        }
        out.trim_matches(is_whitespace).to_string()
    }

    /// Jsoup's `textNodes()`, each normalized like `TextNode.text()`.
    pub fn text_nodes(&self) -> Vec<String> {
        self.node()
            .children()
            .filter_map(|child| match child.value() {
                HtmlNode::Text(text) => {
                    let mut out = String::new();
                    append_normalised(&mut out, text, false);
                    Some(out)
                }
                _ => None,
            })
            .collect()
    }

    /// Jsoup's `data()`: the contents of script and style elements.
    pub fn data(&self) -> String {
        let mut out = String::new();
        for node in self.node().descendants() {
            if let HtmlNode::Text(text) = node.value() {
                let in_data = node.parent().is_some_and(|parent| {
                    parent
                        .value()
                        .as_element()
                        .is_some_and(|element| matches!(element.name(), "script" | "style"))
                });
                if in_data {
                    out.push_str(text);
                }
            }
        }
        out
    }

    /// Pretty-printed outer HTML, like Jsoup's `outerHtml()`. Script and style
    /// elements are left out when `skip_scripts` is set, as Legado's `@html`
    /// removes them.
    pub fn outer_html_with(&self, skip_scripts: bool) -> String {
        let mut out = String::new();
        if self.is_document() {
            for child in self.node().children() {
                write_node(child, &mut out, 0, skip_scripts, false);
            }
        } else {
            write_node(self.node(), &mut out, 0, skip_scripts, false);
        }
        out.trim_start_matches('\n').to_string()
    }

    pub fn outer_html(&self) -> String {
        self.outer_html_with(false)
    }

    /// Pretty-printed inner HTML, like Jsoup's `html()`.
    pub fn inner_html(&self) -> String {
        let mut out = String::new();
        for child in self.node().children() {
            write_node(child, &mut out, 0, false, false);
        }
        out.trim_matches('\n').to_string()
    }
}

/// Serializes a node the way Jsoup's pretty printer lays it out: block
/// elements on their own indented lines, inline content kept on the line.
fn write_node(
    node: NodeRef<'_, HtmlNode>,
    out: &mut String,
    depth: usize,
    skip_scripts: bool,
    preserve: bool,
) {
    match node.value() {
        HtmlNode::Text(text) => {
            let parent_raw = node.parent().is_some_and(|parent| {
                parent
                    .value()
                    .as_element()
                    .is_some_and(|element| matches!(element.name(), "script" | "style"))
            });
            if parent_raw || preserve {
                if parent_raw {
                    out.push_str(text);
                } else {
                    escape_text(text, out);
                }
                return;
            }
            let mut normalised = String::new();
            let strip = out.is_empty() || out.ends_with('\n') || out.ends_with(' ');
            append_normalised(&mut normalised, text, strip);
            let block_parent = node.parent().is_some_and(|parent| {
                parent
                    .value()
                    .as_element()
                    .is_some_and(|element| is_block(element.name()))
            });
            if block_parent && node.next_sibling().is_none() {
                normalised = normalised.trim_end().to_string();
            }
            if normalised.is_empty() {
                return;
            }
            escape_text(&normalised, out);
        }
        HtmlNode::Element(element) => {
            let name = element.name();
            if skip_scripts && matches!(name, "script" | "style") {
                return;
            }
            let block = is_block(name);
            if block && !preserve {
                indent(out, depth);
            }
            out.push('<');
            out.push_str(name);
            for (key, value) in element.attrs() {
                out.push(' ');
                out.push_str(key);
                out.push_str("=\"");
                escape_attr(value, out);
                out.push('"');
            }
            out.push('>');
            if VOID_TAGS.contains(&name) {
                return;
            }
            let preserve_children = preserve || matches!(name, "pre" | "textarea");
            let mut had_block_child = false;
            for child in node.children() {
                if child
                    .value()
                    .as_element()
                    .is_some_and(|element| is_block(element.name()))
                {
                    had_block_child = true;
                }
                write_node(child, out, depth + 1, skip_scripts, preserve_children);
            }
            if had_block_child && !preserve_children {
                indent(out, depth);
            }
            out.push_str("</");
            out.push_str(name);
            out.push('>');
        }
        HtmlNode::Comment(comment) => {
            out.push_str("<!--");
            out.push_str(comment);
            out.push_str("-->");
        }
        HtmlNode::Doctype(doctype) => {
            out.push_str("<!doctype ");
            out.push_str(doctype.name());
            out.push('>');
        }
        _ => {
            for child in node.children() {
                write_node(child, out, depth, skip_scripts, preserve);
            }
        }
    }
}

fn indent(out: &mut String, depth: usize) {
    if out.is_empty() {
        return;
    }
    while out.ends_with(' ') {
        out.pop();
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    for _ in 0..depth {
        out.push(' ');
    }
}

/// A pseudo-class Jsoup supports and the CSS engine does not.
#[derive(Debug, Clone)]
enum JsoupFilter {
    Eq(usize),
    Lt(usize),
    Gt(usize),
    Contains(String),
    ContainsOwn(String),
    Matches(String),
    MatchesOwn(String),
}

impl JsoupFilter {
    fn accepts(&self, element: &Element) -> bool {
        match self {
            JsoupFilter::Eq(n) => element.sibling_index() == *n,
            JsoupFilter::Lt(n) => element.sibling_index() < *n,
            JsoupFilter::Gt(n) => element.sibling_index() > *n,
            JsoupFilter::Contains(text) => {
                element.text().to_lowercase().contains(&text.to_lowercase())
            }
            JsoupFilter::ContainsOwn(text) => element
                .own_text()
                .to_lowercase()
                .contains(&text.to_lowercase()),
            JsoupFilter::Matches(pattern) => fancy_regex::Regex::new(pattern)
                .ok()
                .and_then(|regex| regex.is_match(&element.text()).ok())
                .unwrap_or(false),
            JsoupFilter::MatchesOwn(pattern) => fancy_regex::Regex::new(pattern)
                .ok()
                .and_then(|regex| regex.is_match(&element.own_text()).ok())
                .unwrap_or(false),
        }
    }
}

/// Splits on `separator` characters outside brackets, parentheses, and quotes.
fn split_top_level(text: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut current = String::new();
    for c in text.chars() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            current.push(c);
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                current.push(c);
            }
            '(' | '[' => {
                depth += 1;
                current.push(c);
            }
            ')' | ']' => {
                depth -= 1;
                current.push(c);
            }
            _ if c == separator && depth == 0 => parts.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    parts.push(current);
    parts
}

/// One compound selector and the combinator that precedes it.
struct Step {
    combinator: char,
    compound: String,
    filters: Vec<JsoupFilter>,
}

fn parse_steps(group: &str) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut current = String::new();
    let mut combinator = ' ';
    let chars: Vec<char> = group.trim().chars().collect();
    let flush = |current: &mut String, combinator: &mut char, steps: &mut Vec<Step>| {
        if !current.trim().is_empty() {
            let (compound, filters) = extract_filters(current.trim());
            steps.push(Step {
                combinator: *combinator,
                compound,
                filters,
            });
        }
        current.clear();
    };
    for &c in &chars {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            current.push(c);
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                current.push(c);
            }
            '(' | '[' => {
                depth += 1;
                current.push(c);
            }
            ')' | ']' => {
                depth -= 1;
                current.push(c);
            }
            ' ' | '>' | '+' | '~' if depth == 0 => {
                if !current.trim().is_empty() {
                    flush(&mut current, &mut combinator, &mut steps);
                    combinator = ' ';
                }
                if c != ' ' {
                    combinator = c;
                }
            }
            _ => current.push(c),
        }
    }
    flush(&mut current, &mut combinator, &mut steps);
    steps
}

const JSOUP_PSEUDOS: &[&str] = &[
    ":eq(",
    ":lt(",
    ":gt(",
    ":contains(",
    ":containsOwn(",
    ":matches(",
    ":matchesOwn(",
];

fn extract_filters(compound: &str) -> (String, Vec<JsoupFilter>) {
    let mut rest = compound.to_string();
    let mut filters = Vec::new();
    loop {
        let found = JSOUP_PSEUDOS
            .iter()
            .filter_map(|pseudo| rest.find(pseudo).map(|at| (at, *pseudo)))
            .min_by_key(|(at, _)| *at);
        let Some((at, pseudo)) = found else { break };
        let open = at + pseudo.len();
        let mut depth = 1;
        let mut end = rest.len();
        for (offset, c) in rest[open..].char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + offset;
                        break;
                    }
                }
                _ => {}
            }
        }
        let argument = rest[open..end.min(rest.len())]
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .to_string();
        let number = || argument.trim().parse::<usize>().unwrap_or(usize::MAX);
        filters.push(match pseudo {
            ":eq(" => JsoupFilter::Eq(number()),
            ":lt(" => JsoupFilter::Lt(number()),
            ":gt(" => JsoupFilter::Gt(number()),
            ":contains(" => JsoupFilter::Contains(argument.clone()),
            ":containsOwn(" => JsoupFilter::ContainsOwn(argument.clone()),
            ":matches(" => JsoupFilter::Matches(argument.clone()),
            _ => JsoupFilter::MatchesOwn(argument.clone()),
        });
        let close = (end + 1).min(rest.len());
        rest.replace_range(at..close, "");
    }
    if rest.is_empty() {
        rest = "*".to_string();
    }
    (rest, filters)
}

/// Rewrites Jsoup attribute syntax the CSS engine rejects: `~=` is a
/// substring match in source rules, and values may be unquoted with spaces.
fn normalise_css(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut chars = css.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '[' {
            out.push(c);
            continue;
        }
        let mut inner = String::new();
        let mut depth = 1;
        for d in chars.by_ref() {
            if d == '[' {
                depth += 1;
            } else if d == ']' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            inner.push(d);
        }
        out.push('[');
        let operators = ["~=", "*=", "^=", "$=", "|=", "!=", "="];
        let found = operators
            .iter()
            .filter_map(|op| inner.find(op).map(|at| (at, *op)))
            .min_by_key(|(at, op)| (*at, std::cmp::Reverse(op.len())));
        match found {
            Some((at, op)) => {
                let name = inner[..at].trim();
                let value = inner[at + op.len()..].trim();
                let op = if op == "~=" { "*=" } else { op };
                out.push_str(name);
                out.push_str(op);
                if value.starts_with('"') || value.starts_with('\'') {
                    out.push_str(value);
                } else {
                    out.push('"');
                    out.push_str(&value.replace('"', "\\\""));
                    out.push('"');
                }
            }
            None => out.push_str(&inner),
        }
        out.push(']');
    }
    out
}

fn parse_selector(css: &str) -> Result<Selector, String> {
    Selector::parse(css).map_err(|error| format!("CSS 选择器无效 `{css}`：{error:?}"))
}

/// Elements in `scope` (itself included) matching a plain CSS selector.
fn css_select(scope: &Element, css: &str) -> Result<Vec<Element>, String> {
    let selector = parse_selector(css)?;
    let mut found = Vec::new();
    match scope.element_ref() {
        Some(element) => {
            if selector.matches_with_scope(&element, Some(element)) {
                found.push(scope.clone());
            }
            found.extend(element.select(&selector).map(|hit| scope.with_id(hit.id())));
        }
        None => {
            found.extend(
                scope
                    .doc
                    .html
                    .select(&selector)
                    .map(|hit| scope.with_id(hit.id())),
            );
        }
    }
    Ok(found)
}

fn relative_select(
    scope: &Element,
    combinator: char,
    compound: &str,
) -> Result<Vec<Element>, String> {
    let Some(element) = scope.element_ref() else {
        return css_select(scope, compound);
    };
    let css = match combinator {
        ' ' => format!(":scope {compound}"),
        other => format!(":scope {other} {compound}"),
    };
    let selector = parse_selector(&css)?;
    match combinator {
        '+' | '~' => {
            // Siblings are outside the scope's subtree: match from the parent.
            let Some(parent) = scope.parent() else {
                return Ok(Vec::new());
            };
            let compound_selector = parse_selector(compound)?;
            let siblings: Vec<Element> = parent
                .children()
                .into_iter()
                .skip_while(|sibling| sibling != scope)
                .skip(1)
                .collect();
            let candidates: Vec<Element> = if combinator == '+' {
                siblings.into_iter().take(1).collect()
            } else {
                siblings
            };
            Ok(candidates
                .into_iter()
                .filter(|candidate| {
                    candidate
                        .element_ref()
                        .is_some_and(|el| compound_selector.matches(&el))
                })
                .collect())
        }
        _ => Ok(element
            .select(&selector)
            .map(|hit| scope.with_id(hit.id()))
            .collect()),
    }
}

fn select(scope: &Element, css: &str) -> Result<Vec<Element>, String> {
    let css = normalise_css(css.trim());
    if css.is_empty() {
        return Ok(Vec::new());
    }
    if !JSOUP_PSEUDOS.iter().any(|pseudo| css.contains(pseudo)) {
        return css_select(scope, &css);
    }
    let mut result: Vec<Element> = Vec::new();
    let mut seen: HashSet<NodeId> = HashSet::new();
    for group in split_top_level(&css, ',') {
        let steps = parse_steps(&group);
        let mut current = vec![scope.clone()];
        for (index, step) in steps.iter().enumerate() {
            let mut next = Vec::new();
            let mut next_seen = HashSet::new();
            for element in &current {
                let hits = if index == 0 {
                    css_select(element, &step.compound)?
                } else {
                    relative_select(element, step.combinator, &step.compound)?
                };
                for hit in hits {
                    if step.filters.iter().all(|filter| filter.accepts(&hit))
                        && next_seen.insert(hit.id)
                    {
                        next.push(hit);
                    }
                }
            }
            current = next;
        }
        for element in current {
            if seen.insert(element.id) {
                result.push(element);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<html><body>
        <div class="list a"><ul>
          <li><a href="/b/1.html">第一章</a> <span>新</span></li>
          <li><a href="/b/2.html">第二章</a></li>
          <li class="x"><a href="b/3.html">第三章</a></li>
        </ul></div>
        <p id="intro">简介  内容<br>第二行</p>
        <script>var a = 1;</script>
    </body></html>"#;

    fn doc() -> Element {
        parse(PAGE, "https://example.com/book/")
    }

    #[test]
    fn select_includes_the_scope_itself() {
        let list = doc().select("div.list").unwrap().remove(0);
        assert_eq!(list.select("div").unwrap().len(), 1);
        assert_eq!(list.select("li").unwrap().len(), 3);
    }

    #[test]
    fn jsoup_pseudo_classes_filter_elements() {
        let items = doc().select("li:eq(1) a").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text(), "第二章");
        let found = doc().select("li:contains(第三)").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(doc().select("li:lt(2)").unwrap().len(), 2);
    }

    #[test]
    fn text_follows_jsoup_whitespace_rules() {
        let intro = doc().elements_by_id("intro").remove(0);
        assert_eq!(intro.text(), "简介 内容 第二行");
        assert_eq!(intro.own_text(), "简介 内容 第二行");
        let body = doc().elements_by_tag("body").remove(0);
        assert!(!body.text().contains("var a"));
    }

    #[test]
    fn attributes_resolve_absolute_links() {
        let link = doc().select("li.x a").unwrap().remove(0);
        assert_eq!(link.attr("href").unwrap(), "b/3.html");
        assert_eq!(
            link.attr("abs:href").unwrap(),
            "https://example.com/book/b/3.html"
        );
    }

    #[test]
    fn outer_html_puts_blocks_on_their_own_lines() {
        let list = doc().select("ul").unwrap().remove(0);
        let html = list.outer_html();
        assert!(html.starts_with("<ul>\n <li>"), "{html}");
        assert!(
            html.contains("<a href=\"/b/1.html\">第一章</a> <span>新</span></li>"),
            "{html}"
        );
        let body = doc().elements_by_tag("body").remove(0);
        assert!(!body.outer_html_with(true).contains("<script>"));
    }

    #[test]
    fn table_fragments_keep_their_cells() {
        let row = parse("<tr><td>书名</td><td>作者</td></tr>", "");
        assert_eq!(row.elements_by_tag("td").len(), 2);
    }

    #[test]
    fn unquoted_attribute_values_and_tilde_match() {
        let page = parse(
            r#"<a href="/x/rcatalog/1">目录</a><div style="text-indent: 2em;">正文</div>"#,
            "",
        );
        assert_eq!(page.select("a[href~=catalog]").unwrap().len(), 1);
        assert_eq!(
            page.select("div[style=text-indent: 2em;]").unwrap().len(),
            1
        );
    }
}
