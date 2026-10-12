//! Legado's default rule syntax (`AnalyzeByJSoup`): `@`-separated steps
//! such as `class.list@tag.li.0@text`, `@CSS:` selectors, index and
//! exclusion suffixes, and the final extractor.

use super::json::combine;
use super::split::{split_char, split_compound, Joiner};
use crate::sources::dom::{self, Element};
use crate::sources::value::Val;

/// The element a rule analyzes: an element value, or text parsed as HTML.
pub fn parse_content(content: &Val, base_url: &str) -> Element {
    match content {
        Val::Element(element) => element.clone(),
        Val::Elements(elements) if elements.len() == 1 => elements[0].clone(),
        other => dom::parse(&other.to_text(), base_url),
    }
}

struct Rule<'a> {
    css: bool,
    elements_rule: &'a str,
}

fn source_rule(rule: &str) -> Rule<'_> {
    if rule.len() >= 5 && rule[..5].eq_ignore_ascii_case("@css:") {
        Rule {
            css: true,
            elements_rule: rule[5..].trim(),
        }
    } else {
        Rule {
            css: false,
            elements_rule: rule,
        }
    }
}

/// Trims leading `@` and whitespace, as `RuleAnalyzer.trim`.
fn trim_rule(rule: &str) -> &str {
    rule.trim_start_matches(|c: char| c == '@' || c <= ' ')
}

/// `getElements`.
pub fn get_elements(scope: &Element, rule: &str) -> Result<Vec<Element>, String> {
    if rule.is_empty() {
        return Ok(Vec::new());
    }
    let parsed = source_rule(rule);
    let compound = split_compound(
        parsed.elements_rule,
        &[Joiner::And, Joiner::Or, Joiner::Interleave],
        false,
    );
    let mut lists: Vec<Vec<Element>> = Vec::new();
    for part in &compound.parts {
        let found = if parsed.css {
            scope.select(part)?
        } else {
            let steps = split_char(trim_rule(part), b'@');
            if steps.len() > 1 {
                let mut current = vec![scope.clone()];
                for step in &steps {
                    let mut next = Vec::new();
                    for element in &current {
                        next.extend(get_elements(element, step)?);
                    }
                    current = next;
                }
                current
            } else {
                elements_single(scope, part)?
            }
        };
        let empty = found.is_empty();
        lists.push(found);
        if !empty && compound.joiner == Some(Joiner::Or) {
            break;
        }
    }
    Ok(combine(lists, compound.joiner))
}

/// `getStringList`.
pub fn get_string_list(scope: &Element, rule: &str) -> Result<Vec<String>, String> {
    if rule.is_empty() {
        return Ok(Vec::new());
    }
    let parsed = source_rule(rule);
    if parsed.elements_rule.is_empty() {
        return Ok(vec![scope.data()]);
    }
    let compound = split_compound(
        parsed.elements_rule,
        &[Joiner::And, Joiner::Or, Joiner::Interleave],
        false,
    );
    let mut results: Vec<Vec<String>> = Vec::new();
    for part in &compound.parts {
        let found = if parsed.css {
            match part.rfind('@') {
                Some(at) => Some(result_last(&scope.select(&part[..at])?, &part[at + 1..])),
                None => Some(result_last(&scope.select(part)?, "")),
            }
        } else {
            result_list(scope, part)?
        };
        if let Some(found) = found.filter(|found| !found.is_empty()) {
            results.push(found);
            if compound.joiner == Some(Joiner::Or) {
                break;
            }
        }
    }
    Ok(combine(results, compound.joiner))
}

/// `getString`: the list joined by newlines, or nothing.
pub fn get_string(scope: &Element, rule: &str) -> Result<Option<String>, String> {
    if rule.is_empty() {
        return Ok(None);
    }
    let list = get_string_list(scope, rule)?;
    Ok((!list.is_empty()).then(|| list.join("\n")))
}

/// `getString0`: the first result, used when a URL is wanted.
pub fn get_string0(scope: &Element, rule: &str) -> Result<String, String> {
    Ok(get_string_list(scope, rule)?
        .into_iter()
        .next()
        .unwrap_or_default())
}

fn result_list(scope: &Element, rule: &str) -> Result<Option<Vec<String>>, String> {
    if rule.is_empty() {
        return Ok(None);
    }
    let steps = split_char(trim_rule(rule), b'@');
    let Some((last, path)) = steps.split_last() else {
        return Ok(None);
    };
    let mut elements = vec![scope.clone()];
    for step in path {
        let mut next = Vec::new();
        for element in &elements {
            next.extend(elements_single(element, step)?);
        }
        elements = next;
    }
    if elements.is_empty() {
        return Ok(None);
    }
    Ok(Some(result_last(&elements, last)))
}

fn result_last(elements: &[Element], last: &str) -> Vec<String> {
    let mut texts = Vec::new();
    match last {
        "text" => {
            for element in elements {
                let text = element.text();
                if !text.is_empty() {
                    texts.push(text);
                }
            }
        }
        "textNodes" => {
            for element in elements {
                let nodes: Vec<String> = element
                    .text_nodes()
                    .into_iter()
                    .map(|text| text.trim_matches(|c: char| c <= ' ').to_string())
                    .filter(|text| !text.is_empty())
                    .collect();
                if !nodes.is_empty() {
                    texts.push(nodes.join("\n"));
                }
            }
        }
        "ownText" => {
            for element in elements {
                let text = element.own_text();
                if !text.is_empty() {
                    texts.push(text);
                }
            }
        }
        "html" => {
            let html = elements
                .iter()
                .map(|element| element.outer_html_with(true))
                .collect::<Vec<_>>()
                .join("\n");
            if !html.is_empty() {
                texts.push(html);
            }
        }
        "all" => texts.push(
            elements
                .iter()
                .map(Element::outer_html)
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        attribute => {
            for element in elements {
                let value = element.attr(attribute).unwrap_or_default();
                if value.trim().is_empty() || texts.contains(&value) {
                    continue;
                }
                texts.push(value);
            }
        }
    }
    texts
}

/// An index selector element: a single position or a `start:end:step` range.
#[derive(Debug, Clone, PartialEq)]
enum Index {
    At(i64),
    Range(Option<i64>, Option<i64>, i64),
}

#[derive(Debug, PartialEq)]
struct IndexedRule {
    /// `.` keeps the indexed elements, `!` excludes them, ` ` means none.
    split: char,
    before: String,
    indexes: Vec<Index>,
}

/// Parses a step's index suffix, as `ElementsSingle.findIndexSet`: either
/// `rule[1,-1,2:5]` / `rule[!0]`, or `rule.0`, `rule!0`, `rule.0:2`.
fn find_index_set(rule: &str) -> IndexedRule {
    let rus: Vec<char> = rule.trim_matches(|c: char| c <= ' ').chars().collect();
    let none = || IndexedRule {
        split: ' ',
        before: rus.iter().collect(),
        indexes: Vec::new(),
    };
    if rus.is_empty() {
        return none();
    }
    let mut indexes: Vec<Index> = Vec::new();
    let mut digits = String::new();
    let mut minus = false;
    if rus[rus.len() - 1] == ']' {
        let mut range: Vec<Option<i64>> = Vec::new();
        let mut split = '.';
        let mut position = rus.len() as isize - 2;
        while position >= 0 {
            let c = rus[position as usize];
            if c == ' ' {
                position -= 1;
                continue;
            }
            if c.is_ascii_digit() {
                digits.insert(0, c);
            } else if c == '-' {
                minus = true;
            } else {
                let current = if digits.is_empty() {
                    None
                } else {
                    let value: i64 = digits.parse().unwrap_or(0);
                    Some(if minus { -value } else { value })
                };
                if c == ':' {
                    range.push(current);
                } else {
                    if range.is_empty() {
                        match current {
                            Some(value) => indexes.push(Index::At(value)),
                            None => return none(),
                        }
                    } else {
                        let step = if range.len() == 2 {
                            range[0].unwrap_or(1)
                        } else {
                            1
                        };
                        let end = *range.last().expect("range is not empty");
                        indexes.push(Index::Range(current, end, step));
                        range.clear();
                    }
                    let mut c = c;
                    if c == '!' {
                        split = '!';
                        loop {
                            position -= 1;
                            if position < 0 {
                                break;
                            }
                            c = rus[position as usize];
                            if c != ' ' {
                                break;
                            }
                        }
                    }
                    if c == '[' {
                        indexes.reverse();
                        return IndexedRule {
                            split,
                            before: rus[..position.max(0) as usize].iter().collect(),
                            indexes,
                        };
                    }
                    if c != ',' {
                        return none();
                    }
                }
                digits.clear();
                minus = false;
            }
            position -= 1;
        }
        return none();
    }
    let mut position = rus.len() as isize - 1;
    while position >= 0 {
        let c = rus[position as usize];
        if c == ' ' {
            position -= 1;
            continue;
        }
        if c.is_ascii_digit() {
            digits.insert(0, c);
        } else if c == '-' {
            minus = true;
        } else if matches!(c, '!' | '.' | ':') {
            let Ok(value) = digits.parse::<i64>() else {
                return none();
            };
            indexes.push(Index::At(if minus { -value } else { value }));
            if c != ':' {
                indexes.reverse();
                return IndexedRule {
                    split: c,
                    before: rus[..position as usize].iter().collect(),
                    indexes,
                };
            }
            digits.clear();
            minus = false;
        } else {
            return none();
        }
        position -= 1;
    }
    none()
}

/// `ElementsSingle.getElementsSingle`: one step of a default rule.
fn elements_single(scope: &Element, rule: &str) -> Result<Vec<Element>, String> {
    let indexed = find_index_set(rule);
    let elements = if indexed.before.is_empty() {
        scope.children()
    } else {
        let parts: Vec<&str> = indexed.before.splitn(2, '.').collect();
        let argument = parts.get(1).copied().unwrap_or("");
        match parts[0] {
            "children" => scope.children(),
            "class" => scope.elements_by_class(argument),
            "tag" => scope.elements_by_tag(argument),
            "id" => scope.elements_by_id(argument),
            "text" => scope.elements_containing_own_text(argument),
            _ => scope.select(&indexed.before)?,
        }
    };
    if indexed.split == ' ' {
        return Ok(elements);
    }
    let len = elements.len() as i64;
    let mut chosen: Vec<usize> = Vec::new();
    let push = |index: i64, chosen: &mut Vec<usize>| {
        let resolved = if index < 0 { index + len } else { index };
        if (0..len).contains(&resolved) && !chosen.contains(&(resolved as usize)) {
            chosen.push(resolved as usize);
        }
    };
    for index in &indexed.indexes {
        match *index {
            Index::At(at) => push(at, &mut chosen),
            Index::Range(start, end, step) => {
                let mut start = start.unwrap_or(0);
                if start < 0 {
                    start += len;
                }
                let mut end = end.unwrap_or(len - 1);
                if end < 0 {
                    end += len;
                }
                if (start < 0 && end < 0) || (start >= len && end >= len) {
                    continue;
                }
                start = start.clamp(0, (len - 1).max(0));
                end = end.clamp(0, (len - 1).max(0));
                if start == end || step >= len {
                    push(start, &mut chosen);
                    continue;
                }
                let step = if step > 0 {
                    step
                } else if -step < len {
                    step + len
                } else {
                    1
                };
                if end > start {
                    let mut at = start;
                    while at <= end {
                        push(at, &mut chosen);
                        at += step;
                    }
                } else {
                    let mut at = start;
                    while at >= end {
                        push(at, &mut chosen);
                        at -= step;
                    }
                }
            }
        }
    }
    Ok(if indexed.split == '!' {
        elements
            .into_iter()
            .enumerate()
            .filter(|(index, _)| !chosen.contains(index))
            .map(|(_, element)| element)
            .collect()
    } else {
        chosen
            .into_iter()
            .map(|index| elements[index].clone())
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<html><body>
      <div class="info"><h1>书名</h1><p class="author">作者：某人</p>
        <img src="/c.jpg"><a class="toc" href="/b/1/">目录</a></div>
      <dl id="list"><dt>最新</dt><dd><a href="/b/1/9.html">第九章</a></dd>
        <dt>正文</dt><dd><a href="/b/1/1.html">第一章</a></dd><dd><a href="/b/1/2.html">第二章</a></dd>
        <dd><a href="/b/1/3.html">第三章</a></dd></dl>
      <div id="content">第一段<br>第二段<p>第三段</p><script>ad()</script></div>
    </body></html>"#;

    fn doc() -> Element {
        dom::parse(PAGE, "https://example.com/")
    }

    fn strings(rule: &str) -> Vec<String> {
        get_string_list(&doc(), rule).unwrap()
    }

    #[test]
    fn default_steps_and_extractors() {
        assert_eq!(strings("class.info@tag.h1@text"), vec!["书名"]);
        assert_eq!(strings("class.author@text"), vec!["作者：某人"]);
        assert_eq!(strings("class.info@img@src"), vec!["/c.jpg"]);
        assert_eq!(strings("class.toc@href"), vec!["/b/1/"]);
        assert_eq!(strings("@CSS:.info > h1@text"), vec!["书名"]);
        assert_eq!(strings("id.content@textNodes"), vec!["第一段\n第二段"]);
        assert!(strings("id.content@html")[0].contains("<p>第三段</p>"));
        assert!(!strings("id.content@html")[0].contains("script"));
    }

    #[test]
    fn index_grammar_selects_and_excludes() {
        let all = |rule: &str| {
            get_elements(&doc(), rule)
                .unwrap()
                .iter()
                .map(Element::text)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            all("id.list@dd"),
            vec!["第九章", "第一章", "第二章", "第三章"]
        );
        assert_eq!(all("id.list@dd!0"), vec!["第一章", "第二章", "第三章"]);
        assert_eq!(all("id.list@dd.-1"), vec!["第三章"]);
        assert_eq!(all("id.list@dd.0:2"), vec!["第九章", "第二章"]);
        assert_eq!(all("id.list@dd[1:3]"), vec!["第一章", "第二章", "第三章"]);
        assert_eq!(all("id.list@dd[-1:1]"), vec!["第三章", "第二章", "第一章"]);
        assert_eq!(all("id.list@dd[!0,-1]"), vec!["第一章", "第二章"]);
        assert_eq!(all("tag.dd.1@tag.a"), vec!["第一章"]);
    }

    #[test]
    fn compounds_combine_results() {
        assert_eq!(
            strings("class.missing@text||class.author@text"),
            vec!["作者：某人"]
        );
        assert_eq!(
            strings("tag.h1@text&&class.author@text"),
            vec!["书名", "作者：某人"]
        );
        assert_eq!(
            strings("id.list@dt@text%%id.list@dd@a@text"),
            // Interleaving stops at the first list's length, as in Legado.
            vec!["最新", "第九章", "正文", "第一章"]
        );
    }

    #[test]
    fn index_parsing_matches_legado() {
        assert_eq!(
            find_index_set("tag.li.0"),
            IndexedRule {
                split: '.',
                before: "tag.li".into(),
                indexes: vec![Index::At(0)]
            }
        );
        assert_eq!(find_index_set("tag.li").split, ' ');
        assert_eq!(
            find_index_set("li[1:5:2]").indexes,
            vec![Index::Range(Some(1), Some(5), 2)]
        );
    }
}
