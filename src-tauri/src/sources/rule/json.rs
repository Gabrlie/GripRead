//! JSONPath rules with Jayway's behavior: paths without `$` get `$.`,
//! definite paths read one value, and `{$.…}` inner rules are templates.

use serde_json::Value as Json;
use serde_json_path::JsonPath;

use super::split::{inner_rule, split_compound, Joiner};
use crate::sources::lenient_json;
use crate::sources::value::{json_text, Val};

/// The JSON a rule reads: a JSON value or JSON text.
pub fn parse_content(content: &Val) -> Option<Json> {
    match content {
        Val::Json(value) => Some(value.clone()),
        Val::Null => None,
        other => lenient_json::parse(other.to_text().trim()).ok(),
    }
}

fn normalise_path(path: &str) -> String {
    let path = path.trim();
    if path.starts_with('$') {
        path.to_string()
    } else if let Some(rest) = path.strip_prefix('@') {
        format!("${rest}")
    } else if path.starts_with('[') {
        format!("${path}")
    } else {
        format!("$.{path}")
    }
}

/// Jayway treats a path without wildcards, filters, slices, unions, or deep
/// scans as definite: it reads a single value.
fn is_definite(path: &str) -> bool {
    !(path.contains("..")
        || path.contains('*')
        || path.contains('?')
        || path.contains(':')
        || path.contains(','))
}

/// Jayway's `$.a.length()` style functions are not RFC JSONPath.
fn split_function(path: &str) -> (&str, Option<&str>) {
    for function in [".length()", ".size()"] {
        if let Some(stripped) = path.strip_suffix(function) {
            return (stripped, Some(function));
        }
    }
    (path, None)
}

pub enum Read {
    One(Json),
    Many(Vec<Json>),
}

pub fn read(json: &Json, path: &str) -> Result<Read, String> {
    let path = normalise_path(path);
    let (path, function) = split_function(&path);
    let compiled =
        JsonPath::parse(path).map_err(|error| format!("JSONPath 无效 `{path}`：{error}"))?;
    let nodes: Vec<Json> = compiled.query(json).all().into_iter().cloned().collect();
    let read = if is_definite(path) {
        match nodes.into_iter().next() {
            Some(value) => Read::One(value),
            None => return Err(format!("JSONPath 没有结果：{path}")),
        }
    } else {
        Read::Many(nodes)
    };
    Ok(match function {
        Some(_) => {
            let count = match &read {
                Read::One(Json::Array(items)) => items.len(),
                Read::One(Json::Object(map)) => map.len(),
                Read::One(Json::String(text)) => text.chars().count(),
                Read::One(_) => 0,
                Read::Many(items) => items.len(),
            };
            Read::One(Json::from(count))
        }
        None => read,
    })
}

fn read_text(json: &Json, path: &str) -> Option<String> {
    match read(json, path).ok()? {
        Read::One(Json::Array(items)) => {
            Some(items.iter().map(json_text).collect::<Vec<_>>().join("\n"))
        }
        Read::One(value) => Some(json_text(&value)),
        Read::Many(items) => Some(items.iter().map(json_text).collect::<Vec<_>>().join("\n")),
    }
}

/// `AnalyzeByJSonPath.getString`.
pub fn get_string(json: &Json, rule: &str) -> Option<String> {
    if rule.is_empty() {
        return None;
    }
    let compound = split_compound(rule, &[Joiner::And, Joiner::Or], true);
    if compound.parts.len() == 1 {
        let replaced = inner_rule(rule, "{$.", |inner| get_string(json, inner));
        if !replaced.is_empty() {
            return Some(replaced);
        }
        return read_text(json, rule);
    }
    let mut texts = Vec::new();
    for part in &compound.parts {
        if let Some(text) = get_string(json, part).filter(|text| !text.is_empty()) {
            texts.push(text);
            if compound.joiner == Some(Joiner::Or) {
                break;
            }
        }
    }
    Some(texts.join("\n"))
}

/// `AnalyzeByJSonPath.getStringList`.
pub fn get_string_list(json: &Json, rule: &str) -> Vec<String> {
    if rule.is_empty() {
        return Vec::new();
    }
    let compound = split_compound(rule, &[Joiner::And, Joiner::Or, Joiner::Interleave], true);
    if compound.parts.len() == 1 {
        let replaced = inner_rule(rule, "{$.", |inner| get_string(json, inner));
        if !replaced.is_empty() {
            return vec![replaced];
        }
        return match read(json, rule) {
            Ok(Read::One(Json::Array(items))) | Ok(Read::Many(items)) => {
                items.iter().map(json_text).collect()
            }
            Ok(Read::One(value)) => vec![json_text(&value)],
            Err(_) => Vec::new(),
        };
    }
    let mut results: Vec<Vec<String>> = Vec::new();
    for part in &compound.parts {
        let list = get_string_list(json, part);
        if !list.is_empty() {
            results.push(list);
            if compound.joiner == Some(Joiner::Or) {
                break;
            }
        }
    }
    combine(results, compound.joiner)
}

pub fn combine<T: Clone>(results: Vec<Vec<T>>, joiner: Option<Joiner>) -> Vec<T> {
    if joiner == Some(Joiner::Interleave) {
        let longest = results.first().map_or(0, Vec::len);
        let mut out = Vec::new();
        for index in 0..longest {
            for list in &results {
                if let Some(item) = list.get(index) {
                    out.push(item.clone());
                }
            }
        }
        out
    } else {
        results.into_iter().flatten().collect()
    }
}

/// `AnalyzeByJSonPath.getObject`.
pub fn get_object(json: &Json, rule: &str) -> Val {
    match read(json, rule) {
        Ok(Read::One(value)) => Val::Json(value),
        Ok(Read::Many(items)) => Val::Json(Json::Array(items)),
        Err(_) => Val::Null,
    }
}

/// `AnalyzeByJSonPath.getList`.
pub fn get_list(json: &Json, rule: &str) -> Vec<Val> {
    let compound = split_compound(rule, &[Joiner::And, Joiner::Or, Joiner::Interleave], true);
    let mut results: Vec<Vec<Val>> = Vec::new();
    for part in &compound.parts {
        let items: Vec<Val> = match read(json, part) {
            Ok(Read::One(Json::Array(items))) | Ok(Read::Many(items)) => {
                items.into_iter().map(Val::Json).collect()
            }
            Ok(Read::One(value)) => vec![Val::Json(value)],
            Err(_) => Vec::new(),
        };
        if !items.is_empty() {
            results.push(items);
            if compound.joiner == Some(Joiner::Or) {
                break;
            }
        }
    }
    combine(results, compound.joiner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> Json {
        serde_json::json!({
            "data": {"list": [
                {"id": 1, "name": "甲", "tags": ["玄幻", "完结"]},
                {"id": 2, "name": "乙", "tags": []}
            ], "total": 2}
        })
    }

    #[test]
    fn bare_and_prefixed_paths_read_alike() {
        assert_eq!(get_string(&data(), "$.data.total").unwrap(), "2");
        assert_eq!(get_string(&data(), "data.total").unwrap(), "2");
        assert_eq!(
            get_string_list(&data(), "$.data.list[*].name"),
            vec!["甲", "乙"]
        );
        assert_eq!(get_list(&data(), "$.data.list").len(), 2);
        assert_eq!(get_string(&data(), "$..name").unwrap(), "甲\n乙");
    }

    #[test]
    fn inner_rules_template_strings() {
        let item = &data()["data"]["list"][0];
        assert_eq!(
            get_string(item, "/book/{$.id}.html").unwrap(),
            "/book/1.html"
        );
        assert_eq!(get_string(item, "$.tags").unwrap(), "玄幻\n完结");
    }

    #[test]
    fn compounds_and_filters() {
        let item = &data()["data"]["list"][0];
        assert_eq!(get_string(item, "$.missing||$.name").unwrap(), "甲");
        assert_eq!(get_string(item, "$.name&&$.id").unwrap(), "甲\n1");
        assert_eq!(
            get_string_list(&data(), "$.data.list[?(@.id==2)].name"),
            vec!["乙"]
        );
        assert_eq!(get_string(&data(), "$.data.list.length()").unwrap(), "2");
    }
}
