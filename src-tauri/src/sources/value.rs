//! The values rules pass along a chain: page text, JSON, elements, and lists.

use serde_json::Value as Json;

use super::dom::Element;

#[derive(Clone, Debug, Default)]
pub enum Val {
    #[default]
    Null,
    Str(String),
    Json(Json),
    Element(Element),
    Elements(Vec<Element>),
    List(Vec<Val>),
}

/// The text of a JSON value as Jayway's JSON provider prints it: strings
/// bare, numbers without a trailing `.0`, objects and arrays as JSON.
pub fn json_text(value: &Json) -> String {
    match value {
        Json::Null => String::new(),
        Json::String(text) => text.clone(),
        Json::Number(number) => number_text(number),
        Json::Bool(flag) => flag.to_string(),
        other => other.to_string(),
    }
}

pub fn number_text(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    format_f64(number.as_f64().unwrap_or(0.0))
}

pub fn format_f64(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

impl Val {
    pub fn is_null(&self) -> bool {
        matches!(self, Val::Null)
    }

    /// Kotlin's `toString()` of the value Legado would hold.
    pub fn to_text(&self) -> String {
        match self {
            Val::Null => String::new(),
            Val::Str(text) => text.clone(),
            Val::Json(value) => json_text(value),
            Val::Element(element) => element.outer_html(),
            Val::Elements(elements) => elements
                .iter()
                .map(Element::outer_html)
                .collect::<Vec<_>>()
                .join("\n"),
            Val::List(items) => format!(
                "[{}]",
                items
                    .iter()
                    .map(Val::to_text)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }

    /// The value as a list of strings, as `getStringList` returns it: a
    /// string is split into lines.
    pub fn into_strings(self) -> Vec<String> {
        match self {
            Val::Null => Vec::new(),
            Val::Str(text) => text.split('\n').map(str::to_string).collect(),
            Val::Json(Json::Array(items)) => items.iter().map(json_text).collect(),
            Val::Json(value) => vec![json_text(&value)],
            Val::Element(element) => vec![element.outer_html()],
            Val::Elements(elements) => elements.iter().map(Element::outer_html).collect(),
            Val::List(items) => items.iter().map(Val::to_text).collect(),
        }
    }

    /// The value as list items for `getElements`.
    pub fn into_items(self) -> Vec<Val> {
        match self {
            Val::Null => Vec::new(),
            Val::Elements(elements) => elements.into_iter().map(Val::Element).collect(),
            Val::List(items) => items,
            Val::Json(Json::Array(items)) => items.into_iter().map(Val::Json).collect(),
            other => vec![other],
        }
    }

    /// Whether the text looks like JSON, as Legado's `String.isJson()`.
    pub fn looks_like_json(&self) -> bool {
        match self {
            Val::Json(Json::Object(_) | Json::Array(_)) => true,
            Val::Json(_) | Val::Null | Val::Element(_) | Val::Elements(_) => false,
            Val::Str(text) => text_is_json(text),
            Val::List(_) => false,
        }
    }
}

pub fn text_is_json(text: &str) -> bool {
    let text = text.trim();
    (text.starts_with('{') && text.ends_with('}')) || (text.starts_with('[') && text.ends_with(']'))
}
