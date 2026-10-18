//! The host objects scripts call: `java` (Legado's `JsExtensions` and the
//! running `AnalyzeRule`), `source`, `cookie`, `cache`, and the natives the
//! prelude builds Jsoup elements and Java shims on.

use std::rc::Rc;
use std::time::Duration;

use rquickjs::function::Rest;
use rquickjs::{Array, Ctx, Exception, Function, Object, Value};
use serde_json::{json, Map, Value as Json};

use super::crypto::{self, SymmetricCrypto};
use super::{HostState, JsScope};
use crate::sources::context::{
    login_header_key, login_info_key, source_custom_variable_key, BookData, ChapterData,
};
use crate::sources::dom;
use crate::sources::error::SourceError;
use crate::sources::http::{
    self, cookie_domain, cookie_pairs, join_cookie, merge_cookies, HttpMethod, HttpResponse,
};
use crate::sources::lenient_json;
use crate::sources::rule::regex as java_regex;
use crate::sources::url::{percent_encode, AnalyzeUrl};
use crate::sources::value::{json_text, Val};

type JsResult<T> = rquickjs::Result<T>;

fn throw<'js>(ctx: &Ctx<'js>, message: impl std::fmt::Display) -> rquickjs::Error {
    Exception::throw_message(ctx, &message.to_string())
}

fn source_failure<'js>(ctx: &Ctx<'js>, error: SourceError) -> rquickjs::Error {
    throw(ctx, error.message)
}

fn present<'a, 'js>(args: &'a [Value<'js>], index: usize) -> Option<&'a Value<'js>> {
    args.get(index)
        .filter(|value| !value.is_undefined() && !value.is_null())
}

fn text<'js>(args: &[Value<'js>], index: usize) -> String {
    present(args, index)
        .and_then(|value| value.get::<rquickjs::Coerced<String>>().ok())
        .map(|text| text.0)
        .unwrap_or_default()
}

fn opt_text<'js>(args: &[Value<'js>], index: usize) -> Option<String> {
    present(args, index)
        .and_then(|value| value.get::<rquickjs::Coerced<String>>().ok())
        .map(|text| text.0)
}

fn number<'js>(args: &[Value<'js>], index: usize) -> Option<f64> {
    present(args, index).and_then(|value| {
        value.as_number().or_else(|| {
            value
                .get::<rquickjs::Coerced<String>>()
                .ok()?
                .0
                .trim()
                .parse()
                .ok()
        })
    })
}

fn flag<'js>(args: &[Value<'js>], index: usize) -> bool {
    present(args, index).is_some_and(|value| {
        value
            .as_bool()
            .unwrap_or_else(|| !text(args, index).is_empty())
    })
}

/// Bytes from a JS byte array (Java's signed bytes) or a UTF-8 string.
fn bytes<'js>(args: &[Value<'js>], index: usize) -> Vec<u8> {
    let Some(value) = present(args, index) else {
        return Vec::new();
    };
    if let Some(array) = value.as_array() {
        return array
            .iter::<f64>()
            .filter_map(Result::ok)
            .map(|byte| byte as i64 as u8)
            .collect();
    }
    text(args, index).into_bytes()
}

fn string<'js>(ctx: &Ctx<'js>, value: &str) -> JsResult<Value<'js>> {
    Ok(rquickjs::String::from_str(ctx.clone(), value)?.into_value())
}

fn null<'js>(ctx: &Ctx<'js>) -> Value<'js> {
    Value::new_null(ctx.clone())
}

fn byte_array<'js>(ctx: &Ctx<'js>, data: &[u8]) -> JsResult<Value<'js>> {
    let array = Array::new(ctx.clone())?;
    for (index, byte) in data.iter().enumerate() {
        array.set(index, *byte as i8 as i32)?;
    }
    Ok(array.into_value())
}

fn json_value<'js>(ctx: &Ctx<'js>, value: &Json) -> JsResult<Value<'js>> {
    ctx.json_parse(value.to_string())
}

fn define<'js, F>(ctx: &Ctx<'js>, target: &Object<'js>, name: &str, function: F) -> JsResult<()>
where
    F: Fn(&Ctx<'js>, &[Value<'js>]) -> JsResult<Value<'js>> + 'js,
{
    let function = Function::new(ctx.clone(), move |ctx: Ctx<'js>, args: Rest<Value<'js>>| {
        function(&ctx, &args.0)
    })?;
    target.set(name, function)
}

fn scope<'js>(ctx: &Ctx<'js>, state: &Rc<HostState>) -> JsScope<'js> {
    JsScope {
        ctx: ctx.clone(),
        state: state.clone(),
    }
}

fn decode_with(data: &[u8], charset: Option<&str>) -> String {
    let encoding = charset
        .and_then(|label| encoding_rs::Encoding::for_label(label.trim().as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(data).0.into_owned()
}

fn encode_with(text: &str, charset: Option<&str>) -> Vec<u8> {
    let encoding = charset
        .and_then(|label| encoding_rs::Encoding::for_label(label.trim().as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.encode(text).0.into_owned()
}

/// A response object as scripts see `StrResponse` and Jsoup responses.
pub(super) fn response_object<'js>(
    ctx: &Ctx<'js>,
    response: &HttpResponse,
) -> JsResult<Value<'js>> {
    let mut headers = Map::new();
    let mut cookies = Map::new();
    for (key, value) in &response.headers {
        if key.eq_ignore_ascii_case("set-cookie") {
            if let Some((name, rest)) = value
                .split(';')
                .next()
                .and_then(|first| first.split_once('='))
            {
                cookies.insert(
                    name.trim().to_string(),
                    Json::String(rest.trim().to_string()),
                );
            }
        }
        match headers.get_mut(key) {
            Some(Json::String(existing)) => {
                existing.push_str(", ");
                existing.push_str(value);
            }
            _ => {
                headers.insert(key.clone(), Json::String(value.clone()));
            }
        }
    }
    let data = json!({
        "url": response.url,
        "code": response.code,
        "message": response.message,
        "headers": headers,
        "cookies": cookies,
        "body": response.body,
        "callTime": response.call_time_ms,
    });
    let make: Function = ctx.globals().get("__gr_response")?;
    make.call((json_value(ctx, &data)?,))
}

fn failed_response(url: &str, error: &SourceError) -> HttpResponse {
    HttpResponse {
        url: url.to_string(),
        code: 500,
        message: error.message.clone(),
        body: error.message.clone(),
        ..Default::default()
    }
}

/// Fetches a source URL rule the way `java.ajax` and `java.connect` do.
fn fetch_rule_url<'js>(
    ctx: &Ctx<'js>,
    state: &Rc<HostState>,
    url: &str,
    headers: Option<&str>,
) -> Result<HttpResponse, SourceError> {
    let rule = state.rule();
    let scope = scope(ctx, state);
    let header_override = match headers {
        Some(text) if !text.trim().is_empty() => {
            let mut list = crate::sources::url::source_headers(&rule, &scope, true)?;
            if let Ok(Json::Object(map)) = lenient_json::parse(text) {
                for (key, value) in map {
                    list.retain(|(existing, _)| !existing.eq_ignore_ascii_case(&key));
                    list.push((key, json_text(&value)));
                }
            }
            Some(list)
        }
        _ => None,
    };
    let analyzed = AnalyzeUrl::new(
        &rule,
        &scope,
        url,
        None,
        None,
        &rule.redirect_url(),
        header_override,
    )?;
    analyzed.get_str_response(&state.env)
}

/// A plain request without the source's URL rules, as `java.get`/`post`.
fn direct_request<'js>(
    state: &Rc<HostState>,
    method: HttpMethod,
    url: &str,
    body: Option<String>,
    headers: Option<&Value<'js>>,
) -> Result<HttpResponse, SourceError> {
    let mut request = http::HttpRequest::get(url);
    request.method = method;
    request.follow_redirects = false;
    if let Some(headers) = headers.and_then(|value| value.as_object()) {
        for (key, value) in headers
            .props::<String, rquickjs::Coerced<String>>()
            .flatten()
        {
            request.headers.push((key, value.0));
        }
    }
    if let Some(body) = body {
        if !request
            .headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("content-type"))
        {
            let trimmed = body.trim_start();
            let kind = if trimmed.starts_with('{') || trimmed.starts_with('[') {
                "application/json; charset=UTF-8"
            } else {
                "application/x-www-form-urlencoded"
            };
            request
                .headers
                .push(("Content-Type".to_string(), kind.to_string()));
        }
        request.body = Some(body.into_bytes());
    }
    http::execute(&state.env, &request)
}

/// `java.cacheFile`: a remote text kept in the source cache.
pub(super) fn cache_file(
    scope: &JsScope<'_>,
    url: &str,
    save_seconds: i64,
) -> Result<String, SourceError> {
    let key = format!("cacheFile_{}", crypto::md5_hex(url.as_bytes()));
    if let Some(cached) = scope.state.env.store.cache_get(&key) {
        return Ok(cached);
    }
    let rule = scope.state.rule();
    let analyzed = AnalyzeUrl::new(&rule, scope, url, None, None, "", None)?;
    let response = analyzed.get_str_response(&scope.state.env)?;
    if !response.is_success() {
        return Err(SourceError::network(format!(
            "下载失败（{}）：{url}",
            response.code
        )));
    }
    scope
        .state
        .env
        .store
        .cache_put(&key, &response.body, save_seconds);
    Ok(response.body)
}

const CHINESE_DIGITS: &[(char, u64)] = &[
    ('零', 0),
    ('〇', 0),
    ('一', 1),
    ('二', 2),
    ('两', 2),
    ('三', 3),
    ('四', 4),
    ('五', 5),
    ('六', 6),
    ('七', 7),
    ('八', 8),
    ('九', 9),
    ('壹', 1),
    ('贰', 2),
    ('叁', 3),
    ('肆', 4),
    ('伍', 5),
    ('陆', 6),
    ('柒', 7),
    ('捌', 8),
    ('玖', 9),
];

fn chinese_number(text: &str) -> Option<u64> {
    let mut total = 0u64;
    let mut section = 0u64;
    let mut digit = 0u64;
    for c in text.chars() {
        if let Some((_, value)) = CHINESE_DIGITS.iter().find(|(d, _)| *d == c) {
            digit = *value;
            continue;
        }
        let unit = match c {
            '十' | '拾' => 10,
            '百' | '佰' => 100,
            '千' | '仟' => 1000,
            '万' => 10_000,
            '亿' => 100_000_000,
            _ => return None,
        };
        if unit >= 10_000 {
            total = (total + section + digit) * unit;
            section = 0;
        } else {
            section += if digit == 0 { 1 } else { digit } * unit;
        }
        digit = 0;
    }
    Some(total + section + digit)
}

/// `java.toNumChapter`: Chinese chapter numbers become digits.
fn to_num_chapter(text: &str) -> String {
    let pattern = regex::Regex::new(
        r"第([零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+)([章节回卷集部篇])",
    )
    .expect("valid");
    pattern
        .replace_all(
            text,
            |captures: &regex::Captures<'_>| match chinese_number(&captures[1]) {
                Some(value) => format!("第{value}{}", &captures[2]),
                None => captures[0].to_string(),
            },
        )
        .into_owned()
}

/// Java `SimpleDateFormat` patterns, enough for the dates sources print.
pub(super) fn format_time(millis: f64, pattern: &str, offset_hours: Option<f64>) -> String {
    use chrono::{FixedOffset, Local, TimeZone};
    let seconds = (millis / 1000.0).floor() as i64;
    let nanos = ((millis % 1000.0).abs() * 1_000_000.0) as u32;
    let chrono_pattern = pattern
        .replace("yyyy", "%Y")
        .replace("yy", "%y")
        .replace("MM", "%m")
        .replace("dd", "%d")
        .replace("HH", "%H")
        .replace("hh", "%I")
        .replace("mm", "%M")
        .replace("ss", "%S")
        .replace("SSS", "%3f")
        .replace('a', "%p");
    match offset_hours {
        Some(hours) => FixedOffset::east_opt((hours * 3600.0) as i32)
            .and_then(|offset| offset.timestamp_opt(seconds, nanos).single())
            .map(|time| time.format(&chrono_pattern).to_string())
            .unwrap_or_default(),
        None => Local
            .timestamp_opt(seconds, nanos)
            .single()
            .map(|time| time.format(&chrono_pattern).to_string())
            .unwrap_or_default(),
    }
}

/// Legado's `HtmlFormatter.formatKeepImg` for text from scripts.
pub(crate) fn html_format(html: &str) -> String {
    let wrap = regex::Regex::new(r"(?i)</?(?:div|p|br|hr|h\d|article|dd|dl)[^>]*>").expect("valid");
    let comment = regex::Regex::new(r"<!--[^>]*-->").expect("valid");
    let tags = regex::Regex::new(r"</?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*)?/?>").expect("valid");
    let text = wrap.replace_all(html, "\n");
    let text = comment.replace_all(&text, "");
    let text = tags.replace_all(&text, "");
    let text = crate::sources::util::unescape_html(&text);
    text.lines()
        .map(|line| line.trim_matches(|c: char| c.is_whitespace() || c == '\u{3000}'))
        .filter(|line| !line.is_empty())
        .map(|line| format!("\u{3000}\u{3000}{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn install_natives<'js>(
    ctx: &Ctx<'js>,
    native: &Object<'js>,
    state: Rc<HostState>,
) -> JsResult<()> {
    define(ctx, native, "javaMatches", |ctx, args| {
        let pattern = format!("^(?:{})$", text(args, 1));
        let matched = java_regex::compile(&pattern)
            .map_err(|error| throw(ctx, error))?
            .is_match(&text(args, 0))
            .unwrap_or(false);
        Ok(Value::new_bool(ctx.clone(), matched))
    })?;
    define(ctx, native, "strToBytes", |ctx, args| {
        byte_array(
            ctx,
            &encode_with(&text(args, 0), opt_text(args, 1).as_deref()),
        )
    })?;
    define(ctx, native, "bytesToStr", |ctx, args| {
        string(
            ctx,
            &decode_with(&bytes(args, 0), opt_text(args, 1).as_deref()),
        )
    })?;
    define(
        ctx,
        native,
        "lenientJson",
        |ctx, args| match lenient_json::parse(&text(args, 0)) {
            Ok(value) => string(ctx, &value.to_string()),
            Err(_) => Ok(Value::new_undefined(ctx.clone())),
        },
    )?;
    define(ctx, native, "base64DecodeBytes", |ctx, args| {
        let decoded = crypto::base64_decode(&text(args, 0), number(args, 1).unwrap_or(0.0) as i64)
            .map_err(|error| throw(ctx, error))?;
        byte_array(ctx, &decoded)
    })?;
    define(ctx, native, "base64EncodeBytes", |ctx, args| {
        string(
            ctx,
            &crypto::base64_encode(&bytes(args, 0), number(args, 1).unwrap_or(0.0) as i64),
        )
    })?;
    // javax.crypto and java.security over byte arrays.
    define(ctx, native, "cipherBytes", |ctx, args| {
        let transformation = text(args, 0);
        let decrypt = number(args, 1).unwrap_or(1.0) as i64 == 2;
        let iv = present(args, 3)
            .filter(|value| !value.is_null())
            .map(|_| bytes(args, 3));
        let crypto = crypto::SymmetricCrypto::new(&transformation, &bytes(args, 2), iv.as_deref())
            .map_err(|error| throw(ctx, error))?;
        let data = bytes(args, 4);
        let out = if decrypt {
            crypto.decrypt(&data)
        } else {
            crypto.encrypt(&data)
        }
        .map_err(|error| throw(ctx, error))?;
        byte_array(ctx, &out)
    })?;
    define(ctx, native, "digestBytes", |ctx, args| {
        let out =
            crypto::digest(&bytes(args, 1), &text(args, 0)).map_err(|error| throw(ctx, error))?;
        byte_array(ctx, &out)
    })?;
    define(ctx, native, "hmacBytes", |ctx, args| {
        let out = crypto::hmac(&bytes(args, 2), &text(args, 0), &bytes(args, 1))
            .map_err(|error| throw(ctx, error))?;
        byte_array(ctx, &out)
    })?;
    define(ctx, native, "timeFormatPattern", |ctx, args| {
        string(
            ctx,
            &format_time(number(args, 0).unwrap_or(0.0), &text(args, 1), None),
        )
    })?;
    define(ctx, native, "urlEncode", |ctx, args| {
        string(
            ctx,
            &percent_encode(&text(args, 0), opt_text(args, 1).as_deref(), true),
        )
    })?;
    define(ctx, native, "urlDecode", |ctx, args| {
        string(
            ctx,
            &url_decode(&text(args, 0), opt_text(args, 1).as_deref()),
        )
    })?;
    define(ctx, native, "randomUUID", |ctx, _| {
        string(ctx, &uuid::Uuid::new_v4().to_string())
    })?;

    // `org.jsoup.Jsoup.connect(...)`: the connection the prelude builds,
    // executed with redirects followed unless it says otherwise.
    let st = state.clone();
    define(ctx, native, "jsoupExecute", move |ctx, args| {
        let mut request = http::HttpRequest::get(&text(args, 0));
        request.method = match text(args, 1).to_ascii_uppercase().as_str() {
            "POST" => HttpMethod::Post,
            "HEAD" => HttpMethod::Head,
            _ => HttpMethod::Get,
        };
        if let Some(headers) = present(args, 2).and_then(|value| value.as_object()) {
            for (key, value) in headers
                .props::<String, rquickjs::Coerced<String>>()
                .flatten()
            {
                request.headers.push((key, value.0));
            }
        }
        if let Some(body) = opt_text(args, 3) {
            if !request
                .headers
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case("content-type"))
            {
                request.headers.push((
                    "Content-Type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                ));
            }
            request.body = Some(body.into_bytes());
        }
        request.follow_redirects = present(args, 4).and_then(|v| v.as_bool()).unwrap_or(true);
        if let Some(ms) = number(args, 5).filter(|ms| *ms > 0.0) {
            request.timeout = Duration::from_millis(ms as u64);
        }
        let response =
            http::execute(&st.env, &request).map_err(|error| source_failure(ctx, error))?;
        let object = response_object(ctx, &response)?;
        if let Some(object) = object.as_object() {
            object.set("__bytes", crypto::base64_encode(&response.bytes, 2))?;
        }
        Ok(object)
    })?;
    // `Element.remove()`: the document is rebuilt without the nodes, and its
    // handles point at the new one.
    let st = state.clone();
    define(ctx, native, "elRemove", move |ctx, args| {
        let handles: Vec<i32> = present(args, 0)
            .and_then(|value| value.as_array())
            .map(|array| array.iter::<f64>().flatten().map(|h| h as i32).collect())
            .unwrap_or_default();
        let removed: Vec<dom::Element> = handles.iter().filter_map(|h| st.element(*h)).collect();
        let mut done: Vec<dom::Element> = Vec::new();
        for item in &removed {
            let root = item.document();
            if done.contains(&root) {
                continue;
            }
            let same: Vec<dom::Element> = removed
                .iter()
                .filter(|other| other.document() == root)
                .cloned()
                .collect();
            let rebuilt = dom::without(&root, &same);
            for slot in st.elements.borrow_mut().iter_mut() {
                if *slot == root {
                    *slot = rebuilt.clone();
                }
            }
            done.push(root);
        }
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state.clone();
    define(ctx, native, "jsoupParse", move |ctx, args| {
        let document = dom::parse(&text(args, 0), &st.rule().redirect_url());
        Ok(Value::new_int(ctx.clone(), st.register(document)))
    })?;

    // Elements.
    let element_of =
        |state: &Rc<HostState>, ctx: &Ctx<'js>, args: &[Value<'js>]| -> JsResult<dom::Element> {
            let handle = number(args, 0).unwrap_or(-1.0) as i32;
            state
                .element(handle)
                .ok_or_else(|| throw(ctx, "元素已失效"))
        };
    let handles =
        |state: &Rc<HostState>, ctx: &Ctx<'js>, list: Vec<dom::Element>| -> JsResult<Value<'js>> {
            let array = Array::new(ctx.clone())?;
            for (index, element) in list.into_iter().enumerate() {
                array.set(index, state.register(element))?;
            }
            Ok(array.into_value())
        };
    let st = state.clone();
    define(ctx, native, "elSelect", move |ctx, args| {
        let element = element_of(&st, ctx, args)?;
        let found = element
            .select(&text(args, 1))
            .map_err(|error| throw(ctx, error))?;
        handles(&st, ctx, found)
    })?;
    macro_rules! element_text {
        ($name:literal, $method:ident) => {{
            let st = state.clone();
            define(ctx, native, $name, move |ctx, args| {
                let element = element_of(&st, ctx, args)?;
                string(ctx, &element.$method())
            })?;
        }};
    }
    element_text!("elText", text);
    element_text!("elOwnText", own_text);
    element_text!("elHtml", inner_html);
    element_text!("elOuterHtml", outer_html);
    element_text!("elData", data);
    element_text!("elTag", tag_name);
    let st = state.clone();
    define(ctx, native, "elAttr", move |ctx, args| {
        let element = element_of(&st, ctx, args)?;
        string(ctx, &element.attr(&text(args, 1)).unwrap_or_default())
    })?;
    let st = state.clone();
    define(ctx, native, "elHasAttr", move |ctx, args| {
        let element = element_of(&st, ctx, args)?;
        Ok(Value::new_bool(
            ctx.clone(),
            element.has_attr(&text(args, 1)),
        ))
    })?;
    let st = state.clone();
    define(ctx, native, "elHasClass", move |ctx, args| {
        let element = element_of(&st, ctx, args)?;
        Ok(Value::new_bool(
            ctx.clone(),
            element.has_class(&text(args, 1)),
        ))
    })?;
    let st = state.clone();
    define(ctx, native, "elAttrs", move |ctx, args| {
        let element = element_of(&st, ctx, args)?;
        let map: Map<String, Json> = element
            .attributes()
            .into_iter()
            .map(|(key, value)| (key, Json::String(value)))
            .collect();
        json_value(ctx, &Json::Object(map))
    })?;
    let st = state.clone();
    define(ctx, native, "elChildren", move |ctx, args| {
        let element = element_of(&st, ctx, args)?;
        handles(&st, ctx, element.children())
    })?;
    macro_rules! element_relative {
        ($name:literal, $method:ident) => {{
            let st = state.clone();
            define(ctx, native, $name, move |ctx, args| {
                let element = element_of(&st, ctx, args)?;
                Ok(Value::new_int(
                    ctx.clone(),
                    element.$method().map_or(-1, |found| st.register(found)),
                ))
            })?;
        }};
    }
    element_relative!("elParent", parent);
    element_relative!("elNext", next_element_sibling);
    element_relative!("elPrev", previous_element_sibling);
    macro_rules! element_query {
        ($name:literal, $method:ident) => {{
            let st = state.clone();
            define(ctx, native, $name, move |ctx, args| {
                let element = element_of(&st, ctx, args)?;
                handles(&st, ctx, element.$method(&text(args, 1)))
            })?;
        }};
    }
    element_query!("elByTag", elements_by_tag);
    element_query!("elByClass", elements_by_class);
    element_query!("elById", elements_by_id);
    let st = state.clone();
    define(ctx, native, "elTextNodes", move |ctx, args| {
        let element = element_of(&st, ctx, args)?;
        json_value(ctx, &json!(element.text_nodes()))
    })?;

    // Book and chapter variables.
    let st = state.clone();
    define(ctx, native, "bookGetVar", move |ctx, args| {
        let rule = st.rule();
        let Some(book) = rule.book() else {
            return Ok(null(ctx));
        };
        let book = book.borrow();
        match opt_text(args, 0) {
            Some(key) => string(ctx, book.variables.get(&key).map_or("", String::as_str)),
            None => string(
                ctx,
                &serde_json::to_string(&book.variables).unwrap_or_default(),
            ),
        }
    })?;
    let st = state.clone();
    define(ctx, native, "bookPutVar", move |ctx, args| {
        if let Some(book) = st.rule().book() {
            let mut book = book.borrow_mut();
            match opt_text(args, 1) {
                Some(value) => book.variables.insert(text(args, 0), value),
                None => book.variables.remove(&text(args, 0)),
            };
        }
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state.clone();
    define(ctx, native, "chapterGetVar", move |ctx, args| {
        let rule = st.rule();
        let Some(chapter) = rule.chapter() else {
            return Ok(null(ctx));
        };
        let chapter = chapter.borrow();
        match opt_text(args, 0) {
            Some(key) => string(ctx, chapter.variables.get(&key).map_or("", String::as_str)),
            None => string(
                ctx,
                &serde_json::to_string(&chapter.variables).unwrap_or_default(),
            ),
        }
    })?;
    let st = state;
    define(ctx, native, "chapterPutVar", move |ctx, args| {
        if let Some(chapter) = st.rule().chapter() {
            let mut chapter = chapter.borrow_mut();
            match opt_text(args, 1) {
                Some(value) => chapter.variables.insert(text(args, 0), value),
                None => chapter.variables.remove(&text(args, 0)),
            };
        }
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    Ok(())
}

fn url_decode(text: &str, charset: Option<&str>) -> String {
    let mut bytes = Vec::with_capacity(text.len());
    let raw = text.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        match raw[index] {
            b'+' => {
                bytes.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < raw.len() => {
                let hex = std::str::from_utf8(&raw[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        bytes.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        bytes.push(b'%');
                        index += 1;
                    }
                }
            }
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    decode_with(&bytes, charset)
}

fn crypto_object<'js>(ctx: &Ctx<'js>, cipher: SymmetricCrypto) -> JsResult<Value<'js>> {
    let object = Object::new(ctx.clone())?;
    let cipher = Rc::new(cipher);
    let input = |ctx: &Ctx<'js>, args: &[Value<'js>], decrypting: bool| -> JsResult<Vec<u8>> {
        match present(args, 0) {
            Some(value) if value.is_array() => Ok(bytes(args, 0)),
            _ if decrypting => {
                crypto::decode_cipher_text(&text(args, 0)).map_err(|error| throw(ctx, error))
            }
            _ => Ok(text(args, 0).into_bytes()),
        }
    };
    let c = cipher.clone();
    define(ctx, &object, "decrypt", move |ctx, args| {
        let data = input(ctx, args, true)?;
        byte_array(ctx, &c.decrypt(&data).map_err(|error| throw(ctx, error))?)
    })?;
    let c = cipher.clone();
    define(ctx, &object, "decryptStr", move |ctx, args| {
        let data = input(ctx, args, true)?;
        let plain = c.decrypt(&data).map_err(|error| throw(ctx, error))?;
        string(ctx, &String::from_utf8_lossy(&plain))
    })?;
    let c = cipher.clone();
    define(ctx, &object, "encrypt", move |ctx, args| {
        let data = input(ctx, args, false)?;
        byte_array(ctx, &c.encrypt(&data).map_err(|error| throw(ctx, error))?)
    })?;
    let c = cipher.clone();
    define(ctx, &object, "encryptBase64", move |ctx, args| {
        let data = input(ctx, args, false)?;
        let encrypted = c.encrypt(&data).map_err(|error| throw(ctx, error))?;
        string(ctx, &crypto::base64_encode(&encrypted, 2))
    })?;
    let c = cipher;
    define(ctx, &object, "encryptHex", move |ctx, args| {
        let data = input(ctx, args, false)?;
        let encrypted = c.encrypt(&data).map_err(|error| throw(ctx, error))?;
        string(ctx, &hex::encode(encrypted))
    })?;
    Ok(object.into_value())
}

/// A key or IV given as a string (UTF-8) or a byte array.
fn key_bytes<'js>(args: &[Value<'js>], index: usize) -> Option<Vec<u8>> {
    present(args, index).map(|_| bytes(args, index))
}

fn make_cipher<'js>(
    ctx: &Ctx<'js>,
    transformation: &str,
    key: &[u8],
    iv: Option<&[u8]>,
) -> JsResult<SymmetricCrypto> {
    SymmetricCrypto::new(transformation, key, iv).map_err(|error| throw(ctx, error))
}

pub(super) fn java_object<'js>(ctx: &Ctx<'js>, state: Rc<HostState>) -> JsResult<Object<'js>> {
    let java = Object::new(ctx.clone())?;

    // Network.
    let st = state.clone();
    define(ctx, &java, "ajax", move |ctx, args| {
        let url = match present(args, 0) {
            Some(value) if value.is_array() => value
                .as_array()
                .and_then(|array| array.get::<rquickjs::Coerced<String>>(0).ok())
                .map(|text| text.0)
                .unwrap_or_default(),
            _ => text(args, 0),
        };
        match fetch_rule_url(ctx, &st, &url, None) {
            Ok(response) => string(ctx, &response.body),
            Err(error) if error.kind == crate::sources::error::SourceErrorKind::Unsupported => {
                Err(source_failure(ctx, error))
            }
            Err(error) => {
                st.env.log(format!("ajax({url}) 失败：{}", error.message));
                string(ctx, &error.message)
            }
        }
    })?;
    let st = state.clone();
    define(ctx, &java, "ajaxAll", move |ctx, args| {
        let urls: Vec<String> = present(args, 0)
            .and_then(|value| value.as_array())
            .map(|array| {
                array
                    .iter::<rquickjs::Coerced<String>>()
                    .filter_map(Result::ok)
                    .map(|text| text.0)
                    .collect()
            })
            .unwrap_or_default();
        let list = Array::new(ctx.clone())?;
        for (index, url) in urls.iter().enumerate() {
            let response = fetch_rule_url(ctx, &st, url, None)
                .unwrap_or_else(|error| failed_response(url, &error));
            list.set(index, response_object(ctx, &response)?)?;
        }
        Ok(list.into_value())
    })?;
    let st = state.clone();
    define(ctx, &java, "connect", move |ctx, args| {
        let url = text(args, 0);
        let response = fetch_rule_url(ctx, &st, &url, opt_text(args, 1).as_deref())
            .unwrap_or_else(|error| failed_response(&url, &error));
        response_object(ctx, &response)
    })?;
    let st = state.clone();
    define(ctx, &java, "get", move |ctx, args| {
        // One argument reads a variable; with headers it is an HTTP GET.
        if args.len() < 2 {
            return string(ctx, &st.rule().get(&text(args, 0)));
        }
        let response = direct_request(&st, HttpMethod::Get, &text(args, 0), None, present(args, 1))
            .map_err(|error| source_failure(ctx, error))?;
        response_object(ctx, &response)
    })?;
    let st = state.clone();
    define(ctx, &java, "post", move |ctx, args| {
        let response = direct_request(
            &st,
            HttpMethod::Post,
            &text(args, 0),
            Some(text(args, 1)),
            present(args, 2),
        )
        .map_err(|error| source_failure(ctx, error))?;
        response_object(ctx, &response)
    })?;
    let st = state.clone();
    define(ctx, &java, "head", move |ctx, args| {
        let response = direct_request(
            &st,
            HttpMethod::Head,
            &text(args, 0),
            None,
            present(args, 1),
        )
        .map_err(|error| source_failure(ctx, error))?;
        response_object(ctx, &response)
    })?;
    let st = state.clone();
    define(ctx, &java, "cacheFile", move |ctx, args| {
        let scope = scope(ctx, &st);
        let body = cache_file(
            &scope,
            &text(args, 0),
            number(args, 1).unwrap_or(0.0) as i64,
        )
        .map_err(|error| source_failure(ctx, error))?;
        string(ctx, &body)
    })?;
    let st = state.clone();
    define(ctx, &java, "importScript", move |ctx, args| {
        let path = text(args, 0);
        if !crate::sources::util::is_absolute_url(&path) {
            return Err(throw(
                ctx,
                format!("不支持: java.importScript 读取本地文件 {path}"),
            ));
        }
        let scope = scope(ctx, &st);
        let body = cache_file(&scope, &path, 0).map_err(|error| source_failure(ctx, error))?;
        string(ctx, &body)
    })?;
    // Legado's BackstageWebView: (html, url, js), with a resource or
    // navigation pattern for the GetSource and GetOverrideUrl forms.
    for (name, pattern) in [
        ("webView", None),
        ("webViewGetSource", Some(false)),
        ("webViewGetOverrideUrl", Some(true)),
    ] {
        let st = state.clone();
        define(ctx, &java, name, move |ctx, args| {
            let html = opt_text(args, 0).filter(|html| !html.trim().is_empty());
            let base = st.rule().base_url();
            let url = match text(args, 1) {
                url if url.trim().is_empty() => base,
                url => crate::sources::util::absolute_url(&base, &url),
            };
            let js = opt_text(args, 2).filter(|js| !js.trim().is_empty());
            let regex = opt_text(args, 3).filter(|regex| !regex.is_empty());
            let rule = st.rule();
            let headers = crate::sources::url::source_headers(&rule, &scope(ctx, &st), true)
                .unwrap_or_default();
            let request = crate::sources::webview::WebRequest {
                url,
                html,
                headers,
                js,
                source_regex: regex.clone().filter(|_| pattern == Some(false)),
                override_url_regex: regex.filter(|_| pattern == Some(true)),
                ..Default::default()
            };
            match crate::sources::webview::render(&st.env, request) {
                Ok(result) => string(ctx, &result.body),
                Err(error) => Err(source_failure(ctx, error)),
            }
        })?;
    }
    // A page shown to the reader for login or verification; the Await form
    // returns the page as a response once they close it.
    for (name, wait) in [("startBrowser", false), ("startBrowserAwait", true)] {
        let st = state.clone();
        define(ctx, &java, name, move |ctx, args| {
            let base = st.rule().base_url();
            let url = crate::sources::util::absolute_url(&base, &text(args, 0));
            let rule = st.rule();
            let headers = crate::sources::url::source_headers(&rule, &scope(ctx, &st), true)
                .unwrap_or_default();
            let request = crate::sources::webview::BrowseRequest {
                url: url.clone(),
                title: opt_text(args, 1).unwrap_or_default(),
                headers,
                html: None,
            };
            let result = crate::sources::webview::browse(&st.env, request)
                .map_err(|error| source_failure(ctx, error))?;
            if !wait {
                return Ok(Value::new_undefined(ctx.clone()));
            }
            response_object(
                ctx,
                &HttpResponse {
                    url: result.url,
                    code: 200,
                    message: "OK".into(),
                    headers: Vec::new(),
                    bytes: result.body.as_bytes().to_vec(),
                    body: result.body,
                    call_time_ms: 0,
                },
            )
        })?;
    }
    for name in ["getVerificationCode", "openUrl"] {
        define(ctx, &java, name, move |ctx, _| {
            Err(throw(
                ctx,
                format!("不支持: java.{name}（需要 WebView，暂不支持）"),
            ))
        })?;
    }
    for name in [
        "downloadFile",
        "readFile",
        "readTxtFile",
        "deleteFile",
        "unzipFile",
        "un7zFile",
        "unrarFile",
        "unArchiveFile",
        "getTxtInFolder",
        "getZipStringContent",
        "getZipByteArrayContent",
        "queryTTF",
        "queryBase64TTF",
        "replaceFont",
    ] {
        define(ctx, &java, name, move |ctx, _| {
            Err(throw(ctx, format!("不支持: java.{name}")))
        })?;
    }

    // The running rule.
    let st = state.clone();
    define(ctx, &java, "put", move |ctx, args| {
        let value = text(args, 1);
        string(ctx, &st.rule().put(&text(args, 0), &value))
    })?;
    let st = state.clone();
    define(ctx, &java, "getString", move |ctx, args| {
        let scope = scope(ctx, &st);
        let content = present(args, 1).map(|value| scope.from_js(value.clone()));
        let is_url = args.get(2).and_then(Value::as_bool).unwrap_or(false)
            || args.get(1).and_then(Value::as_bool).unwrap_or(false);
        let content = content
            .filter(|value| !matches!(value, Val::Str(text) if text == "true" || text == "false"));
        let result = st
            .rule()
            .get_string_with(&scope, &text(args, 0), content.as_ref(), is_url)
            .map_err(|error| source_failure(ctx, error))?;
        string(ctx, &result)
    })?;
    let st = state.clone();
    define(ctx, &java, "getStringList", move |ctx, args| {
        let scope = scope(ctx, &st);
        let content = present(args, 1).map(|value| scope.from_js(value.clone()));
        let is_url = args.get(2).and_then(Value::as_bool).unwrap_or(false);
        let list = st
            .rule()
            .get_string_list(&scope, &text(args, 0), content.as_ref(), is_url)
            .map_err(|error| source_failure(ctx, error))?;
        json_value(ctx, &json!(list.unwrap_or_default()))
    })?;
    let st = state.clone();
    define(ctx, &java, "getElement", move |ctx, args| {
        let scope = scope(ctx, &st);
        let rule = st.rule();
        let found = rule
            .get_element(&scope, &text(args, 0))
            .map_err(|error| source_failure(ctx, error))?;
        scope.to_js(&found)
    })?;
    let st = state.clone();
    define(ctx, &java, "getElements", move |ctx, args| {
        let scope = scope(ctx, &st);
        let rule = st.rule();
        let found = rule
            .get_elements(&scope, &text(args, 0))
            .map_err(|error| source_failure(ctx, error))?;
        // Selected elements are jsoup's Elements under Legado, so scripts
        // call `.text()` or `.attr()` on the whole list.
        if found.iter().all(|item| matches!(item, Val::Element(_))) {
            let elements = found
                .into_iter()
                .filter_map(|item| match item {
                    Val::Element(element) => Some(element),
                    _ => None,
                })
                .collect();
            return scope.to_js(&Val::Elements(elements));
        }
        scope.to_js(&Val::List(found))
    })?;
    let st = state.clone();
    define(ctx, &java, "setContent", move |ctx, args| {
        let scope = scope(ctx, &st);
        let content = present(args, 0).map_or(Val::Null, |value| scope.from_js(value.clone()));
        st.rule().set_content(content, opt_text(args, 1).as_deref());
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state.clone();
    define(ctx, &java, "getContent", move |ctx, _| {
        let scope = scope(ctx, &st);
        scope.to_js(&st.rule().content())
    })?;
    let st = state.clone();
    define(ctx, &java, "getBaseUrl", move |ctx, _| {
        string(ctx, &st.rule().base_url())
    })?;

    // Logging.
    let st = state.clone();
    define(ctx, &java, "log", move |ctx, args| {
        let message = text(args, 0);
        st.env.log(message.clone());
        string(ctx, &message)
    })?;
    let st = state.clone();
    define(ctx, &java, "logType", move |ctx, args| {
        let kind =
            present(args, 0).map_or("null".to_string(), |value| format!("{:?}", value.type_of()));
        st.env.log(kind);
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    for name in ["toast", "longToast"] {
        let st = state.clone();
        define(ctx, &java, name, move |ctx, args| {
            st.env.log(format!("[toast] {}", text(args, 0)));
            Ok(Value::new_undefined(ctx.clone()))
        })?;
    }

    // Encoding and hashing.
    define(ctx, &java, "base64Decode", |ctx, args| {
        let flags = present(args, 1).and_then(Value::as_number).unwrap_or(0.0) as i64;
        let charset = present(args, 1)
            .filter(|value| value.is_string())
            .map(|_| text(args, 1));
        let decoded =
            crypto::base64_decode(&text(args, 0), flags).map_err(|error| throw(ctx, error))?;
        string(ctx, &decode_with(&decoded, charset.as_deref()))
    })?;
    define(ctx, &java, "base64DecodeToByteArray", |ctx, args| {
        let flags = number(args, 1).unwrap_or(0.0) as i64;
        let decoded =
            crypto::base64_decode(&text(args, 0), flags).map_err(|error| throw(ctx, error))?;
        byte_array(ctx, &decoded)
    })?;
    define(ctx, &java, "base64Encode", |ctx, args| {
        let flags = number(args, 1).unwrap_or(2.0) as i64;
        string(ctx, &crypto::base64_encode(text(args, 0).as_bytes(), flags))
    })?;
    define(ctx, &java, "hexDecodeToByteArray", |ctx, args| {
        let decoded = hex::decode(text(args, 0).trim()).map_err(|error| throw(ctx, error))?;
        byte_array(ctx, &decoded)
    })?;
    define(ctx, &java, "hexDecodeToString", |ctx, args| {
        let decoded = hex::decode(text(args, 0).trim()).map_err(|error| throw(ctx, error))?;
        string(ctx, &String::from_utf8_lossy(&decoded))
    })?;
    define(ctx, &java, "hexEncodeToString", |ctx, args| {
        string(ctx, &hex::encode(text(args, 0)))
    })?;
    define(ctx, &java, "strToBytes", |ctx, args| {
        byte_array(
            ctx,
            &encode_with(&text(args, 0), opt_text(args, 1).as_deref()),
        )
    })?;
    define(ctx, &java, "bytesToStr", |ctx, args| {
        string(
            ctx,
            &decode_with(&bytes(args, 0), opt_text(args, 1).as_deref()),
        )
    })?;
    define(ctx, &java, "encodeURI", |ctx, args| {
        let charset = opt_text(args, 1).unwrap_or_else(|| "UTF-8".to_string());
        string(ctx, &percent_encode(&text(args, 0), Some(&charset), true))
    })?;
    define(ctx, &java, "utf8ToGbk", |ctx, args| {
        string(ctx, &encoding_rs::GBK.decode(text(args, 0).as_bytes()).0)
    })?;
    define(ctx, &java, "md5Encode", |ctx, args| {
        string(ctx, &crypto::md5_hex(text(args, 0).as_bytes()))
    })?;
    define(ctx, &java, "md5Encode16", |ctx, args| {
        string(ctx, &crypto::md5_hex(text(args, 0).as_bytes())[8..24])
    })?;
    define(ctx, &java, "digestHex", |ctx, args| {
        let digest = crypto::digest(text(args, 0).as_bytes(), &text(args, 1))
            .map_err(|error| throw(ctx, error))?;
        string(ctx, &hex::encode(digest))
    })?;
    define(ctx, &java, "digestBase64Str", |ctx, args| {
        let digest = crypto::digest(text(args, 0).as_bytes(), &text(args, 1))
            .map_err(|error| throw(ctx, error))?;
        string(ctx, &crypto::base64_encode(&digest, 2))
    })?;
    define(ctx, &java, "HMacHex", |ctx, args| {
        let mac = crypto::hmac(
            text(args, 0).as_bytes(),
            &text(args, 1),
            text(args, 2).as_bytes(),
        )
        .map_err(|error| throw(ctx, error))?;
        string(ctx, &hex::encode(mac))
    })?;
    define(ctx, &java, "HMacBase64", |ctx, args| {
        let mac = crypto::hmac(
            text(args, 0).as_bytes(),
            &text(args, 1),
            text(args, 2).as_bytes(),
        )
        .map_err(|error| throw(ctx, error))?;
        string(ctx, &crypto::base64_encode(&mac, 2))
    })?;
    define(ctx, &java, "createSymmetricCrypto", |ctx, args| {
        let key = key_bytes(args, 1).unwrap_or_default();
        let iv = key_bytes(args, 2);
        let cipher = make_cipher(ctx, &text(args, 0), &key, iv.as_deref())?;
        crypto_object(ctx, cipher)
    })?;
    // Legado's older shortcuts: (data, key, transformation, iv).
    for (name, decrypting, base64_out) in [
        ("aesDecodeToString", true, false),
        ("aesBase64DecodeToString", true, false),
        ("aesEncodeToString", false, false),
        ("aesEncodeToBase64String", false, true),
        ("desDecodeToString", true, false),
        ("desBase64DecodeToString", true, false),
        ("desEncodeToString", false, false),
        ("desEncodeToBase64String", false, true),
    ] {
        define(ctx, &java, name, move |ctx, args| {
            let default = if name.starts_with("aes") {
                "AES/ECB/PKCS5Padding"
            } else {
                "DES/ECB/PKCS5Padding"
            };
            let transformation = opt_text(args, 2).unwrap_or_else(|| default.to_string());
            let key = key_bytes(args, 1).unwrap_or_default();
            let iv = key_bytes(args, 3);
            let cipher = make_cipher(ctx, &transformation, &key, iv.as_deref())?;
            if decrypting {
                let data = crypto::decode_cipher_text(&text(args, 0))
                    .map_err(|error| throw(ctx, error))?;
                let plain = cipher.decrypt(&data).map_err(|error| throw(ctx, error))?;
                string(ctx, &String::from_utf8_lossy(&plain))
            } else {
                let encrypted = cipher
                    .encrypt(text(args, 0).as_bytes())
                    .map_err(|error| throw(ctx, error))?;
                string(
                    ctx,
                    &if base64_out {
                        crypto::base64_encode(&encrypted, 2)
                    } else {
                        hex::encode(encrypted)
                    },
                )
            }
        })?;
    }
    // Triple DES shortcuts: (data, key, mode, padding, iv); the `Args`
    // forms take the key and IV in Base64.
    for (name, decrypting, args_base64) in [
        ("tripleDESDecodeStr", true, false),
        ("tripleDESDecodeArgsBase64Str", true, true),
        ("tripleDESEncodeBase64Str", false, false),
        ("tripleDESEncodeArgsBase64Str", false, true),
    ] {
        define(ctx, &java, name, move |ctx, args| {
            let transformation = format!("DESede/{}/{}", text(args, 2), text(args, 3));
            let decode_arg = |index: usize| -> JsResult<Option<Vec<u8>>> {
                match opt_text(args, index) {
                    Some(value) if args_base64 => crypto::base64_decode(&value, 0)
                        .map(Some)
                        .map_err(|error| throw(ctx, error)),
                    Some(value) => Ok(Some(value.into_bytes())),
                    None => Ok(None),
                }
            };
            let key = decode_arg(1)?.unwrap_or_default();
            let iv = decode_arg(4)?;
            let cipher = make_cipher(ctx, &transformation, &key, iv.as_deref())?;
            if decrypting {
                let data = crypto::decode_cipher_text(&text(args, 0))
                    .map_err(|error| throw(ctx, error))?;
                let plain = cipher.decrypt(&data).map_err(|error| throw(ctx, error))?;
                string(ctx, &String::from_utf8_lossy(&plain))
            } else {
                let encrypted = cipher
                    .encrypt(text(args, 0).as_bytes())
                    .map_err(|error| throw(ctx, error))?;
                string(ctx, &crypto::base64_encode(&encrypted, 2))
            }
        })?;
    }

    // Text and time.
    define(ctx, &java, "t2s", |ctx, args| {
        string(ctx, &crate::transform::to_simplified(&text(args, 0)))
    })?;
    define(ctx, &java, "s2t", |ctx, args| {
        string(ctx, &crate::transform::to_traditional(&text(args, 0)))
    })?;
    define(ctx, &java, "toNumChapter", |ctx, args| {
        string(ctx, &to_num_chapter(&text(args, 0)))
    })?;
    define(ctx, &java, "htmlFormat", |ctx, args| {
        string(ctx, &html_format(&text(args, 0)))
    })?;
    define(ctx, &java, "timeFormat", |ctx, args| {
        string(
            ctx,
            &format_time(number(args, 0).unwrap_or(0.0), "yyyy/MM/dd HH:mm", None),
        )
    })?;
    define(ctx, &java, "timeFormatUTC", |ctx, args| {
        string(
            ctx,
            &format_time(
                number(args, 0).unwrap_or(0.0),
                &text(args, 1),
                Some(number(args, 2).unwrap_or(0.0)),
            ),
        )
    })?;
    define(ctx, &java, "randomUUID", |ctx, _| {
        string(ctx, &uuid::Uuid::new_v4().to_string())
    })?;
    for name in ["getWebViewUA", "getUserAgent"] {
        define(ctx, &java, name, |ctx, _| {
            string(ctx, http::DEFAULT_USER_AGENT)
        })?;
    }
    let st = state.clone();
    define(ctx, &java, "androidId", move |ctx, _| {
        let key = "gripread_android_id";
        let id = match st.env.store.cache_get(key) {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
                st.env.store.cache_put(key, &id, 0);
                id
            }
        };
        string(ctx, &id)
    })?;
    let st = state.clone();
    define(ctx, &java, "getCookie", move |ctx, args| {
        let cookie = st
            .env
            .store
            .cookie_get(&cookie_domain(&text(args, 0)))
            .unwrap_or_default();
        match opt_text(args, 1) {
            Some(key) => string(
                ctx,
                &cookie_pairs(&cookie)
                    .into_iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value)
                    .unwrap_or_default(),
            ),
            None => string(ctx, &cookie),
        }
    })?;
    let st = state.clone();
    define(ctx, &java, "refreshTocUrl", move |ctx, _| {
        let Some(book) = st.rule().book() else {
            return Err(throw(ctx, "refreshTocUrl 需要书籍"));
        };
        let scope = scope(ctx, &st);
        crate::sources::web_book::refresh_toc_url(&scope, &book)
            .map_err(|error| source_failure(ctx, error))?;
        let toc_url = book.borrow().toc_url.clone();
        string(ctx, &toc_url)
    })?;
    let st = state;
    define(ctx, &java, "reGetBook", move |ctx, _| {
        let Some(book) = st.rule().book() else {
            return Err(throw(ctx, "reGetBook 需要书籍"));
        };
        let scope = scope(ctx, &st);
        crate::sources::web_book::re_get_book(&scope, &book)
            .map_err(|error| source_failure(ctx, error))?;
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    define(ctx, &java, "getSource", |ctx, _| {
        ctx.globals().get("source")
    })?;
    Ok(java)
}

pub(super) fn source_object<'js>(ctx: &Ctx<'js>, state: Rc<HostState>) -> JsResult<Object<'js>> {
    let raw = Json::Object(state.env.source.raw.clone());
    let source: Object<'js> = json_value(ctx, &raw)?
        .into_object()
        .ok_or_else(|| throw(ctx, "书源不是对象"))?;
    let url = state.env.source.url();
    // Rhino reads Java getters as properties: `source.key` is getKey().
    source.set("key", url.clone())?;
    source.set("tag", state.env.source.name())?;
    let key = url.clone();
    define(ctx, &source, "getKey", move |ctx, _| string(ctx, &key))?;
    for field in [
        "bookSourceUrl",
        "bookSourceName",
        "bookSourceGroup",
        "bookSourceComment",
        "loginUrl",
        "header",
        "searchUrl",
        "exploreUrl",
    ] {
        let value = state
            .env
            .source
            .raw
            .get(field)
            .map(json_text)
            .unwrap_or_default();
        let mut getter = String::from("get");
        getter.push_str(&field[..1].to_ascii_uppercase());
        getter.push_str(&field[1..]);
        define(ctx, &source, &getter, move |ctx, _| string(ctx, &value))?;
    }
    let name = state.env.source.name();
    define(ctx, &source, "getTag", move |ctx, _| string(ctx, &name))?;
    let st = state.clone();
    define(ctx, &source, "get", move |ctx, args| {
        string(ctx, &st.env.source_get(&text(args, 0)).unwrap_or_default())
    })?;
    let st = state.clone();
    define(ctx, &source, "put", move |ctx, args| {
        let value = text(args, 1);
        st.env.source_put(&text(args, 0), &value);
        string(ctx, &value)
    })?;
    let st = state.clone();
    let variable_key = source_custom_variable_key(&url);
    define(ctx, &source, "getVariable", move |ctx, _| {
        string(
            ctx,
            &st.env.store.cache_get(&variable_key).unwrap_or_default(),
        )
    })?;
    let st = state.clone();
    let variable_key = source_custom_variable_key(&url);
    define(ctx, &source, "setVariable", move |ctx, args| {
        match opt_text(args, 0) {
            Some(value) => st.env.store.cache_put(&variable_key, &value, 0),
            None => st.env.store.cache_delete(&variable_key),
        }
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state.clone();
    let info_key = login_info_key(&url);
    define(ctx, &source, "getLoginInfo", move |ctx, _| {
        match st.env.store.cache_get(&info_key) {
            Some(info) => string(ctx, &info),
            None => Ok(null(ctx)),
        }
    })?;
    let st = state.clone();
    let info_key = login_info_key(&url);
    define(ctx, &source, "getLoginInfoMap", move |ctx, _| {
        // Legado gives a Java map, or null without saved login info;
        // scripts test for null and then call `.get(key)`.
        let info = st.env.store.cache_get(&info_key).unwrap_or_default();
        match lenient_json::parse(&info).ok().filter(Json::is_object) {
            Some(value) => {
                let java: Function = ctx.globals().get("__gr_java_json")?;
                java.call((json_value(ctx, &value)?,))
            }
            None => Ok(null(ctx)),
        }
    })?;
    let st = state.clone();
    let info_key = login_info_key(&url);
    define(ctx, &source, "putLoginInfo", move |ctx, args| {
        let info = text(args, 0);
        let valid = lenient_json::parse(&info).is_ok();
        if valid {
            st.env.store.cache_put(&info_key, &info, 0);
        }
        Ok(Value::new_bool(ctx.clone(), valid))
    })?;
    let st = state.clone();
    let info_key = login_info_key(&url);
    define(ctx, &source, "removeLoginInfo", move |ctx, _| {
        st.env.store.cache_delete(&info_key);
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state.clone();
    let header_key = login_header_key(&url);
    define(ctx, &source, "getLoginHeader", move |ctx, _| {
        match st.env.store.cache_get(&header_key) {
            Some(header) => string(ctx, &header),
            None => Ok(null(ctx)),
        }
    })?;
    let st = state.clone();
    let header_key = login_header_key(&url);
    define(ctx, &source, "getLoginHeaderMap", move |ctx, _| {
        match st
            .env
            .store
            .cache_get(&header_key)
            .and_then(|header| lenient_json::parse(&header).ok())
        {
            Some(value) => json_value(ctx, &value),
            None => Ok(null(ctx)),
        }
    })?;
    let st = state.clone();
    let header_key = login_header_key(&url);
    define(ctx, &source, "putLoginHeader", move |ctx, args| {
        let header = text(args, 0);
        st.env.store.cache_put(&header_key, &header, 0);
        // Legado also stores a cookie given in the login header.
        if let Ok(Json::Object(map)) = lenient_json::parse(&header) {
            if let Some(cookie) = map
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("cookie"))
            {
                let domain = cookie_domain(&st.env.source.url());
                let merged = merge_cookies(
                    &st.env.store.cookie_get(&domain).unwrap_or_default(),
                    &json_text(cookie.1),
                );
                st.env.store.cookie_put(&domain, &merged);
            }
        }
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state.clone();
    let header_key = login_header_key(&url);
    define(ctx, &source, "removeLoginHeader", move |ctx, _| {
        st.env.store.cache_delete(&header_key);
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state.clone();
    define(ctx, &source, "getHeaderMap", move |ctx, args| {
        let scope = scope(ctx, &st);
        let headers = crate::sources::url::source_headers(&st.rule(), &scope, flag(args, 0))
            .map_err(|error| source_failure(ctx, error))?;
        let map: Map<String, Json> = headers
            .into_iter()
            .map(|(key, value)| (key, Json::String(value)))
            .collect();
        json_value(ctx, &Json::Object(map))
    })?;
    let st = state;
    define(ctx, &source, "putConcurrent", move |ctx, args| {
        st.env.log(format!(
            "书源请求频率临时改为 {}（本次操作不生效）",
            text(args, 0)
        ));
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    // Read from the globals: a closure holding the object would keep it
    // alive where the garbage collector cannot see.
    define(ctx, &source, "getSource", |ctx, _| {
        ctx.globals().get("source")
    })?;
    Ok(source)
}

pub(super) fn cookie_object<'js>(ctx: &Ctx<'js>, state: Rc<HostState>) -> JsResult<Object<'js>> {
    let cookie = Object::new(ctx.clone())?;
    let st = state.clone();
    define(ctx, &cookie, "getCookie", move |ctx, args| {
        string(
            ctx,
            &st.env
                .store
                .cookie_get(&cookie_domain(&text(args, 0)))
                .unwrap_or_default(),
        )
    })?;
    let st = state.clone();
    define(ctx, &cookie, "getKey", move |ctx, args| {
        let cookie = st
            .env
            .store
            .cookie_get(&cookie_domain(&text(args, 0)))
            .unwrap_or_default();
        let key = text(args, 1);
        string(
            ctx,
            &cookie_pairs(&cookie)
                .into_iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value)
                .unwrap_or_default(),
        )
    })?;
    let st = state.clone();
    define(ctx, &cookie, "setCookie", move |ctx, args| {
        st.env
            .store
            .cookie_put(&cookie_domain(&text(args, 0)), &text(args, 1));
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state.clone();
    define(ctx, &cookie, "replaceCookie", move |ctx, args| {
        let domain = cookie_domain(&text(args, 0));
        let merged = merge_cookies(
            &st.env.store.cookie_get(&domain).unwrap_or_default(),
            &text(args, 1),
        );
        st.env.store.cookie_put(&domain, &merged);
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state;
    define(ctx, &cookie, "removeCookie", move |ctx, args| {
        st.env.store.cookie_remove(&cookie_domain(&text(args, 0)));
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    define(ctx, &cookie, "cookieToMap", |ctx, args| {
        let map: Map<String, Json> = cookie_pairs(&text(args, 0))
            .into_iter()
            .map(|(key, value)| (key, Json::String(value)))
            .collect();
        json_value(ctx, &Json::Object(map))
    })?;
    define(ctx, &cookie, "mapToCookie", |ctx, args| {
        let pairs: Vec<(String, String)> = present(args, 0)
            .and_then(|value| value.as_object())
            .map(|object| {
                object
                    .props::<String, rquickjs::Coerced<String>>()
                    .flatten()
                    .map(|(key, value)| (key, value.0))
                    .collect()
            })
            .unwrap_or_default();
        string(ctx, &join_cookie(&pairs))
    })?;
    Ok(cookie)
}

pub(super) fn cache_object<'js>(ctx: &Ctx<'js>, state: Rc<HostState>) -> JsResult<Object<'js>> {
    let cache = Object::new(ctx.clone())?;
    for (get_name, put_name, prefix) in [("get", "put", ""), ("getFile", "putFile", "file_")] {
        let st = state.clone();
        define(ctx, &cache, get_name, move |ctx, args| {
            match st
                .env
                .store
                .cache_get(&format!("{prefix}{}", text(args, 0)))
            {
                Some(value) => string(ctx, &value),
                None => Ok(null(ctx)),
            }
        })?;
        let st = state.clone();
        define(ctx, &cache, put_name, move |ctx, args| {
            let save = number(args, 2).unwrap_or(0.0) as i64;
            st.env
                .store
                .cache_put(&format!("{prefix}{}", text(args, 0)), &text(args, 1), save);
            Ok(Value::new_undefined(ctx.clone()))
        })?;
    }
    for name in ["getInt", "getLong", "getDouble", "getFloat"] {
        let st = state.clone();
        define(ctx, &cache, name, move |ctx, args| {
            match st
                .env
                .store
                .cache_get(&text(args, 0))
                .and_then(|value| value.trim().parse::<f64>().ok())
            {
                Some(value) => Ok(Value::new_float(ctx.clone(), value)),
                None => Ok(null(ctx)),
            }
        })?;
    }
    let st = state.clone();
    define(ctx, &cache, "delete", move |ctx, args| {
        st.env.store.cache_delete(&text(args, 0));
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state.clone();
    define(ctx, &cache, "getFromMemory", move |ctx, args| {
        match st.env.memory.borrow().get(&text(args, 0)) {
            Some(value) => string(ctx, value),
            None => Ok(null(ctx)),
        }
    })?;
    let st = state.clone();
    define(ctx, &cache, "putMemory", move |ctx, args| {
        st.env
            .memory
            .borrow_mut()
            .insert(text(args, 0), text(args, 1));
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    let st = state;
    define(ctx, &cache, "deleteMemory", move |ctx, args| {
        st.env.memory.borrow_mut().remove(&text(args, 0));
        Ok(Value::new_undefined(ctx.clone()))
    })?;
    Ok(cache)
}

pub(super) fn book_fields(book: &BookData) -> Json {
    json!({
        "name": book.name,
        "author": book.author,
        "kind": book.kind,
        "coverUrl": book.cover_url,
        "intro": book.intro,
        "wordCount": book.word_count,
        "latestChapterTitle": book.latest_chapter_title,
        "bookUrl": book.book_url,
        "tocUrl": book.toc_url,
        "origin": book.origin,
        "originName": book.origin_name,
        "variable": serde_json::to_string(&book.variables).unwrap_or_default(),
        "reverseToc": book.reverse_toc,
    })
}

pub(super) fn chapter_fields(chapter: &ChapterData) -> Json {
    json!({
        "title": chapter.title,
        "url": chapter.url,
        "baseUrl": chapter.base_url,
        "index": chapter.index,
        "isVolume": chapter.is_volume,
        "isVip": chapter.is_vip,
        "isPay": chapter.is_pay,
        "tag": chapter.tag,
        "variable": serde_json::to_string(&chapter.variables).unwrap_or_default(),
    })
}

fn field<'js>(object: &Value<'js>, name: &str) -> Option<String> {
    object
        .as_object()?
        .get::<_, Option<rquickjs::Coerced<String>>>(name)
        .ok()
        .flatten()
        .map(|text| text.0)
}

/// Writes fields a script assigned on `book` back to the book.
pub(super) fn sync_book(object: &Value<'_>, book: &mut BookData) {
    let update = |name: &str, target: &mut String| {
        if let Some(value) = field(object, name) {
            if *target != value {
                *target = value;
            }
        }
    };
    update("name", &mut book.name);
    update("author", &mut book.author);
    update("kind", &mut book.kind);
    update("coverUrl", &mut book.cover_url);
    update("intro", &mut book.intro);
    update("wordCount", &mut book.word_count);
    update("latestChapterTitle", &mut book.latest_chapter_title);
    update("bookUrl", &mut book.book_url);
    update("tocUrl", &mut book.toc_url);
    if let Some(reverse) = object
        .as_object()
        .and_then(|object| object.get::<_, Option<bool>>("reverseToc").ok().flatten())
    {
        book.reverse_toc = reverse;
    }
}

pub(super) fn sync_chapter(object: &Value<'_>, chapter: &mut ChapterData) {
    if let Some(title) = field(object, "title") {
        chapter.title = title;
    }
    if let Some(url) = field(object, "url") {
        chapter.url = url;
    }
    if let Some(tag) = field(object, "tag") {
        chapter.tag = tag;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_chapter_numbers_become_digits() {
        assert_eq!(to_num_chapter("第一百二十三章 归来"), "第123章 归来");
        assert_eq!(to_num_chapter("第十章"), "第10章");
        assert_eq!(to_num_chapter("第两千零五章"), "第2005章");
    }

    #[test]
    fn html_formats_into_indented_paragraphs() {
        assert_eq!(
            html_format("<p>一</p><br/>二&nbsp;<b>三</b>"),
            "\u{3000}\u{3000}一\n\u{3000}\u{3000}二\u{a0}三"
        );
    }
}
