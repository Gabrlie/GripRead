//! Legado book sources as imported JSON. The original object is kept whole,
//! unknown fields included; typed accessors read the fields the engine uses.

use serde_json::{Map, Value};

use super::lenient_json;
use super::value::json_text;

/// A Legado book source. `raw` is the source exactly as imported.
#[derive(Debug, Clone, Default)]
pub struct BookSource {
    pub raw: Map<String, Value>,
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(json_text(other)),
    }
}

fn value_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => Some(number.as_i64().unwrap_or(0) != 0),
        Value::String(text) => match text.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn value_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|f| f as i64)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

impl BookSource {
    /// Reads one source object. The rule sections may be objects or JSON
    /// text, as older exports store them.
    pub fn from_value(value: Value) -> Result<Self, String> {
        match value {
            Value::Object(raw) => {
                let source = BookSource { raw };
                if source.url().trim().is_empty() {
                    return Err("书源缺少 bookSourceUrl".to_string());
                }
                Ok(source)
            }
            _ => Err("书源必须是 JSON 对象".to_string()),
        }
    }

    pub fn text(&self, field: &str) -> Option<String> {
        self.raw
            .get(field)
            .and_then(value_text)
            .filter(|text| !text.is_empty())
    }

    fn flag(&self, field: &str, default: bool) -> bool {
        self.raw.get(field).and_then(value_bool).unwrap_or(default)
    }

    fn number(&self, field: &str, default: i64) -> i64 {
        self.raw.get(field).and_then(value_i64).unwrap_or(default)
    }

    pub fn url(&self) -> String {
        self.text("bookSourceUrl").unwrap_or_default()
    }

    pub fn name(&self) -> String {
        self.text("bookSourceName").unwrap_or_default()
    }

    pub fn group(&self) -> String {
        self.text("bookSourceGroup").unwrap_or_default()
    }

    /// 0 text, 1 audio, 2 image, 3 file.
    pub fn source_type(&self) -> i64 {
        self.number("bookSourceType", 0)
    }

    pub fn enabled(&self) -> bool {
        self.flag("enabled", true)
    }

    pub fn enabled_explore(&self) -> bool {
        self.flag("enabledExplore", true)
    }

    pub fn enabled_cookie_jar(&self) -> bool {
        self.flag("enabledCookieJar", true)
    }

    pub fn custom_order(&self) -> i64 {
        self.number("customOrder", 0)
    }

    pub fn weight(&self) -> i64 {
        self.number("weight", 0)
    }

    pub fn last_update_time(&self) -> i64 {
        self.number("lastUpdateTime", 0)
    }

    pub fn respond_time(&self) -> i64 {
        self.number("respondTime", 180_000)
    }

    pub fn concurrent_rate(&self) -> Option<String> {
        self.text("concurrentRate")
    }

    pub fn header(&self) -> Option<String> {
        self.text("header")
    }

    pub fn login_url(&self) -> Option<String> {
        self.text("loginUrl")
    }

    pub fn login_ui(&self) -> Option<String> {
        self.text("loginUi")
    }

    pub fn login_check_js(&self) -> Option<String> {
        self.text("loginCheckJs")
    }

    pub fn cover_decode_js(&self) -> Option<String> {
        self.text("coverDecodeJs")
    }

    pub fn js_lib(&self) -> Option<String> {
        self.text("jsLib")
    }

    pub fn search_url(&self) -> Option<String> {
        self.text("searchUrl")
    }

    pub fn explore_url(&self) -> Option<String> {
        self.text("exploreUrl")
    }

    pub fn book_url_pattern(&self) -> Option<String> {
        self.text("bookUrlPattern")
    }

    pub fn comment(&self) -> Option<String> {
        self.text("bookSourceComment")
    }

    pub fn variable_comment(&self) -> Option<String> {
        self.text("variableComment")
    }

    /// A rule section such as `ruleSearch`, parsed when stored as text.
    pub fn section(&self, section: &str) -> Map<String, Value> {
        match self.raw.get(section) {
            Some(Value::Object(map)) => map.clone(),
            Some(Value::String(text)) if !text.trim().is_empty() => match lenient_json::parse(text)
            {
                Ok(Value::Object(map)) => map,
                _ => Map::new(),
            },
            _ => Map::new(),
        }
    }

    /// One rule of a section, or `None` when it is absent or empty.
    pub fn rule(&self, section: &str, field: &str) -> Option<String> {
        self.section(section)
            .get(field)
            .and_then(value_text)
            .filter(|text| !text.is_empty())
    }
}

/// Reads pasted or downloaded source JSON: one source or an array.
pub fn parse_sources(text: &str) -> Result<Vec<Value>, String> {
    let value = lenient_json::parse(text.trim().trim_start_matches('\u{feff}'))
        .map_err(|error| format!("书源 JSON 无法解析：{error}"))?;
    match value {
        Value::Array(items) => Ok(items),
        Value::Object(_) => Ok(vec![value]),
        _ => Err("书源 JSON 必须是对象或数组".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_keep_unknown_fields_and_read_string_sections() {
        let values = parse_sources(
            r#"[{"bookSourceUrl":"https://a.com","bookSourceName":"甲","enabled":"false",
                "ruleSearch":"{\"bookList\":\"class.item\"}","customField":{"x":1}}]"#,
        )
        .unwrap();
        let source = BookSource::from_value(values[0].clone()).unwrap();
        assert_eq!(source.name(), "甲");
        assert!(!source.enabled());
        assert_eq!(source.rule("ruleSearch", "bookList").unwrap(), "class.item");
        assert!(source.raw.contains_key("customField"));
        assert!(BookSource::from_value(serde_json::json!({"bookSourceName": "x"})).is_err());
    }
}
