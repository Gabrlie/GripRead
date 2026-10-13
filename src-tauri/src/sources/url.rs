//! Legado's `AnalyzeUrl`: turns a source URL rule into a request.
//!
//! In order: `@js:`/`<js>` segments with `@result`, `{{…}}` expressions,
//! the `<a,b,c>` page list, then the `,{…}` option object (method, headers,
//! body, charset, type, js, webView), then query or form encoding.

use base64::Engine as _;
use serde_json::Value as Json;

use super::context::{login_header_key, Env};
use super::error::{SourceError, SourceResult};
use super::http::{self, HttpMethod, HttpRequest, HttpResponse};
use super::lenient_json;
use super::rule::analyze::{AnalyzeRule, Scripts};
use super::rule::split::double_brace_spans;
use super::util::{absolute_url, split_url_option};
use super::value::{json_text, Val};

/// Extra bindings a URL script sees besides Legado's usual ones.
#[derive(Debug, Clone, Default)]
pub struct UrlBindings {
    pub key: Option<String>,
    pub page: Option<i64>,
    pub base_url: Option<String>,
}

/// Script hosts that can also bind `key` and `page`, as URL scripts need.
pub trait UrlScripts: Scripts {
    fn eval_url(
        &self,
        rule: &AnalyzeRule,
        script: &str,
        result: &Val,
        bindings: &UrlBindings,
    ) -> SourceResult<Val>;
}

#[derive(Debug, Clone)]
pub struct AnalyzeUrl {
    /// The rule after scripts and templates, option object included.
    pub rule_url: String,
    /// The absolute address without the option object.
    pub url: String,
    pub base_url: String,
    pub method: HttpMethod,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub charset: Option<String>,
    /// Set when the response should be returned as hex bytes.
    pub kind: Option<String>,
    pub retry: u32,
    pub use_web_view: bool,
    pub web_js: Option<String>,
    pub body_js: Option<String>,
    /// The content rule's `sourceRegex`, which a WebView watches resources for.
    pub source_regex: Option<String>,
}

fn set_header(headers: &mut Vec<(String, String)>, key: &str, value: &str) {
    match headers
        .iter_mut()
        .find(|(existing, _)| existing.eq_ignore_ascii_case(key))
    {
        Some(pair) => pair.1 = value.to_string(),
        None => headers.push((key.to_string(), value.to_string())),
    }
}

pub fn header_value<'a>(headers: &'a [(String, String)], key: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(existing, _)| existing.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.as_str())
}

fn json_map_into(headers: &mut Vec<(String, String)>, value: &Json) {
    if let Json::Object(map) = value {
        for (key, value) in map {
            set_header(headers, key, &json_text(value));
        }
    }
}

/// The source's default headers: its `header` field (JSON, or a script
/// returning JSON) and, when wanted, the stored login header.
pub fn source_headers(
    rule: &AnalyzeRule,
    scripts: &dyn UrlScripts,
    with_login: bool,
) -> SourceResult<Vec<(String, String)>> {
    let env = rule.env();
    let mut headers = vec![(
        "User-Agent".to_string(),
        http::DEFAULT_USER_AGENT.to_string(),
    )];
    if let Some(header) = env.source.header() {
        let header = header.trim();
        let text = if header.len() >= 4 && header[..4].eq_ignore_ascii_case("@js:") {
            scripts
                .eval_url(rule, &header[4..], &Val::Null, &UrlBindings::default())?
                .to_text()
        } else if header.len() >= 4 && header[..4].eq_ignore_ascii_case("<js>") {
            let end = header.rfind('<').unwrap_or(header.len()).max(4);
            scripts
                .eval_url(rule, &header[4..end], &Val::Null, &UrlBindings::default())?
                .to_text()
        } else {
            header.to_string()
        };
        if let Ok(value) = lenient_json::parse(&text) {
            json_map_into(&mut headers, &value);
        }
    }
    if with_login {
        if let Some(login) = env.store.cache_get(&login_header_key(&env.source.url())) {
            if let Ok(value) = lenient_json::parse(&login) {
                json_map_into(&mut headers, &value);
            }
        }
    }
    Ok(headers)
}

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'~' | b'!' | b'*' | b'\'' | b'(' | b')'
        )
}

/// Whether a parameter is already percent-encoded and needs nothing else.
fn is_encoded(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    let mut has_escape = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if bytes.get(index + 1).is_some_and(u8::is_ascii_hexdigit)
                && bytes.get(index + 2).is_some_and(u8::is_ascii_hexdigit)
            {
                has_escape = true;
                index += 3;
                continue;
            }
            return false;
        }
        if !(is_unreserved(byte) || byte == b'+') {
            return false;
        }
        index += 1;
    }
    has_escape || !value.is_empty()
}

/// JavaScript's `escape()`, used by sources with `"charset":"escape"`.
pub fn js_escape(value: &str) -> String {
    let mut out = String::new();
    for unit in value.encode_utf16() {
        match unit {
            0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a => out.push(unit as u8 as char),
            _ if b"@*_+-./".contains(&(unit as u8)) && unit < 0x80 => out.push(unit as u8 as char),
            _ if unit < 0x100 => out.push_str(&format!("%{unit:02X}")),
            _ => out.push_str(&format!("%u{unit:04X}")),
        }
    }
    out
}

/// Percent-encodes in a charset, keeping a literal `+` as sources expect.
pub fn percent_encode(value: &str, charset: Option<&str>, space_as_plus: bool) -> String {
    let encoding = charset
        .and_then(|label| encoding_rs::Encoding::for_label(label.trim().as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (bytes, _, _) = encoding.encode(value);
    let mut out = String::new();
    for &byte in bytes.iter() {
        if is_unreserved(byte) || byte == b'+' {
            out.push(byte as char);
        } else if byte == b' ' {
            out.push_str(if space_as_plus { "+" } else { "%20" });
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn encode_part(value: &str, charset: Option<&str>, query: bool) -> String {
    let charset = charset.filter(|c| !c.trim().is_empty());
    if charset.is_none() && is_encoded(value) {
        return value.to_string();
    }
    if charset.is_some_and(|c| c.eq_ignore_ascii_case("escape")) {
        return js_escape(value);
    }
    percent_encode(value, charset, !query)
}

/// Encodes `a=1&b=2` parameter by parameter, as `encodeParams`.
pub fn encode_params(params: &str, charset: Option<&str>, query: bool) -> String {
    params
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => format!(
                "{}={}",
                encode_part(key, charset, query),
                encode_part(value, charset, query)
            ),
            None => encode_part(pair, charset, query),
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn page_list(rule: &str, page: i64) -> String {
    let mut out = String::new();
    let mut rest = rule;
    while let Some(open) = rest.find('<') {
        let Some(close) = rest[open..].find('>') else {
            break;
        };
        let inner = &rest[open + 1..open + close];
        // `<js>` and HTML-like text are not page lists.
        if inner.contains("js") || inner.contains('/') && !inner.contains(',') {
            out.push_str(&rest[..open + close + 1]);
            rest = &rest[open + close + 1..];
            continue;
        }
        let pages: Vec<&str> = inner.split(',').collect();
        let chosen = if page >= 1 && (page as usize) < pages.len() {
            pages[page as usize - 1]
        } else {
            pages[pages.len() - 1]
        };
        out.push_str(&rest[..open]);
        out.push_str(chosen.trim());
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    out
}

fn js_segments(rule: &str) -> Vec<(bool, String)> {
    let pattern = regex::Regex::new(r"(?is)<js>(.*?)</js>|@js:(.*)").expect("valid");
    let mut segments = Vec::new();
    let mut start = 0;
    for captures in pattern.captures_iter(rule) {
        let whole = captures.get(0).expect("group 0");
        if whole.start() > start {
            segments.push((false, rule[start..whole.start()].trim().to_string()));
        }
        let script = captures
            .get(2)
            .or_else(|| captures.get(1))
            .map_or("", |m| m.as_str());
        segments.push((true, script.to_string()));
        start = whole.end();
    }
    if rule.len() > start {
        segments.push((false, rule[start..].trim().to_string()));
    }
    segments
}

impl AnalyzeUrl {
    /// Builds the request for a URL rule. `rule` supplies the book, chapter,
    /// and variables, and is `java` in URL scripts.
    pub fn new(
        rule: &AnalyzeRule,
        scripts: &dyn UrlScripts,
        rule_url: &str,
        key: Option<&str>,
        page: Option<i64>,
        base_url: &str,
        headers: Option<Vec<(String, String)>>,
    ) -> SourceResult<Self> {
        let (base_url, _) = split_url_option(base_url);
        let mut base_url = base_url.to_string();
        let mut request_headers = match headers {
            Some(headers) => headers,
            None => source_headers(rule, scripts, true)?,
        };
        let bindings = UrlBindings {
            key: key.map(str::to_string),
            page,
            base_url: Some(base_url.clone()),
        };
        // Scripts and `@result`.
        let mut result = rule_url.to_string();
        for (is_js, text) in js_segments(rule_url) {
            if is_js {
                result = scripts
                    .eval_url(rule, &text, &Val::Str(result.clone()), &bindings)?
                    .to_text();
            } else if !text.is_empty() {
                result = text.replace("@result", &result);
            }
        }
        let mut url_rule = result;
        // `{{…}}` expressions, then the page list.
        if url_rule.contains("{{") && url_rule.contains("}}") {
            let spans = double_brace_spans(&url_rule);
            if !spans.is_empty() {
                let mut out = String::new();
                let mut last = 0;
                for (start, end, inner) in spans {
                    out.push_str(&url_rule[last..start]);
                    let value = match inner.trim() {
                        "key" => Val::Str(key.unwrap_or("").to_string()),
                        "page" => Val::Str(page.unwrap_or(1).to_string()),
                        expression => scripts.eval_url(rule, expression, &Val::Null, &bindings)?,
                    };
                    out.push_str(&value.to_text());
                    last = end;
                }
                out.push_str(&url_rule[last..]);
                url_rule = out;
            }
        }
        if let Some(page) = page {
            url_rule = page_list(&url_rule, page);
        }
        let (address, option) = split_url_option(&url_rule);
        let mut url = absolute_url(&base_url, address);
        if let Some(scheme_end) = url.find("://") {
            let host_end = url[scheme_end + 3..]
                .find('/')
                .map_or(url.len(), |at| scheme_end + 3 + at);
            base_url = url[..host_end].to_string();
        }
        let mut analyzed = AnalyzeUrl {
            rule_url: url_rule.clone(),
            url: String::new(),
            base_url,
            method: HttpMethod::Get,
            headers: Vec::new(),
            body: None,
            charset: None,
            kind: None,
            retry: 0,
            use_web_view: false,
            web_js: None,
            source_regex: None,
            body_js: None,
        };
        let option = option.trim_start_matches(|c: char| c == ',' || c.is_whitespace());
        if !option.is_empty() {
            let parsed = lenient_json::parse(option)
                .map_err(|error| SourceError::rule(format!("URL 参数无法解析：{error}")))?;
            if let Json::Object(map) = &parsed {
                let get = |name: &str| map.get(name).filter(|value| !value.is_null());
                if let Some(method) = get("method") {
                    if json_text(method).eq_ignore_ascii_case("POST") {
                        analyzed.method = HttpMethod::Post;
                    }
                }
                match get("headers") {
                    Some(Json::String(text)) => {
                        if let Ok(value) = lenient_json::parse(text) {
                            json_map_into(&mut request_headers, &value);
                        }
                    }
                    Some(value) => json_map_into(&mut request_headers, value),
                    None => {}
                }
                analyzed.body = get("body").map(|value| match value {
                    Json::String(text) => text.clone(),
                    other => other.to_string(),
                });
                analyzed.kind = get("type").map(json_text).filter(|text| !text.is_empty());
                analyzed.charset = get("charset")
                    .map(json_text)
                    .filter(|text| !text.is_empty());
                analyzed.retry = get("retry")
                    .and_then(|value| json_text(value).parse().ok())
                    .unwrap_or(0);
                analyzed.use_web_view = get("webView").is_some_and(|value| match value {
                    Json::Bool(flag) => *flag,
                    Json::String(text) => !text.is_empty() && text != "false",
                    Json::Number(number) => number.as_i64().unwrap_or(0) != 0,
                    _ => false,
                });
                analyzed.web_js = get("webJs").map(json_text).filter(|text| !text.is_empty());
                analyzed.body_js = get("bodyJs").map(json_text).filter(|text| !text.is_empty());
                if let Some(js) = get("js").map(json_text).filter(|text| !text.is_empty()) {
                    let value = scripts.eval_url(rule, &js, &Val::Str(url.clone()), &bindings)?;
                    if !value.is_null() {
                        url = value.to_text();
                    }
                }
            }
        }
        analyzed.headers = request_headers;
        analyzed.url = url;
        Ok(analyzed)
    }

    /// The request this URL describes.
    pub fn request(&self) -> HttpRequest {
        let mut request = HttpRequest::get(&self.url);
        request.method = self.method;
        request.charset = self.charset.clone();
        request.headers = self.headers.clone();
        match self.method {
            HttpMethod::Get | HttpMethod::Head => {
                if let Some((path, query)) = self.url.split_once('?') {
                    request.url = format!(
                        "{path}?{}",
                        encode_params(query, self.charset.as_deref(), true)
                    );
                }
            }
            HttpMethod::Post => {
                let body = self.body.clone().unwrap_or_default();
                let trimmed = body.trim();
                let is_json = (trimmed.starts_with('{') && trimmed.ends_with('}'))
                    || (trimmed.starts_with('[') && trimmed.ends_with(']'));
                let is_xml = trimmed.starts_with('<');
                let content_type =
                    header_value(&request.headers, "Content-Type").map(str::to_string);
                if content_type.is_none() && !is_json && !is_xml {
                    let form = encode_params(&body, self.charset.as_deref(), false);
                    set_header(
                        &mut request.headers,
                        "Content-Type",
                        "application/x-www-form-urlencoded",
                    );
                    request.body = Some(form.into_bytes());
                } else {
                    if content_type.is_none() {
                        set_header(
                            &mut request.headers,
                            "Content-Type",
                            if is_json {
                                "application/json; charset=UTF-8"
                            } else {
                                "text/xml; charset=UTF-8"
                            },
                        );
                    }
                    let encoding = self
                        .charset
                        .as_deref()
                        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
                        .unwrap_or(encoding_rs::UTF_8);
                    request.body = Some(encoding.encode(&body).0.into_owned());
                }
            }
        }
        request
    }

    /// Fetches the page, as `getStrResponse`.
    pub fn get_str_response(&self, env: &Env) -> SourceResult<HttpResponse> {
        if self.use_web_view {
            return self.web_view_response(env);
        }
        if super::util::is_data_url(&self.url) {
            return data_url_response(&self.url);
        }
        let request = self.request();
        let mut attempt = 0;
        let mut response = loop {
            match http::execute(env, &request) {
                Ok(response) => break response,
                Err(error)
                    if attempt < self.retry
                        && error.kind == super::error::SourceErrorKind::Network =>
                {
                    attempt += 1;
                }
                Err(error) => return Err(error),
            }
        };
        if self.kind.is_some() {
            response.body = hex::encode(&response.bytes);
        }
        Ok(response)
    }
}

impl AnalyzeUrl {
    /// `webView: true`, as Legado's getStrResponse: a GET page loads in the
    /// WebView with the request's headers; a POST is sent first and its
    /// answer loads at its address. `webJs` decides the body.
    fn web_view_response(&self, env: &Env) -> SourceResult<HttpResponse> {
        let started = std::time::Instant::now();
        let request = self.request();
        let (url, html) = match self.method {
            HttpMethod::Post => {
                let response = http::execute(env, &request)?;
                (response.url, Some(response.body))
            }
            HttpMethod::Get | HttpMethod::Head => (self.url.clone(), None),
        };
        let result = super::webview::render(
            env,
            super::webview::WebRequest {
                url,
                html,
                headers: request.headers,
                js: self.web_js.clone(),
                source_regex: self.source_regex.clone(),
                ..Default::default()
            },
        )?;
        Ok(HttpResponse {
            url: result.url,
            code: 200,
            message: "OK".to_string(),
            headers: Vec::new(),
            bytes: result.body.as_bytes().to_vec(),
            body: result.body,
            call_time_ms: started.elapsed().as_millis() as u64,
        })
    }
}

fn data_url_response(url: &str) -> SourceResult<HttpResponse> {
    let payload_start = url
        .find(',')
        .ok_or_else(|| SourceError::rule("data: 地址缺少内容"))?;
    let header = &url[5..payload_start];
    let payload = &url[payload_start + 1..];
    let base64 = header
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"));
    let bytes = if base64 {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|error| SourceError::rule(format!("data: 地址无法解码：{error}")))?
    } else {
        payload.as_bytes().to_vec()
    };
    let charset = header
        .split(';')
        .find_map(|part| part.trim().strip_prefix("charset="))
        .map(str::to_string);
    // Legado answers a base64 data address with the bytes as hex, which
    // scripts turn back with java.hexDecodeToString.
    let body = if base64 {
        hex::encode(&bytes)
    } else {
        http::decode_body(&bytes, charset.as_deref(), None)
    };
    Ok(HttpResponse {
        url: url.to_string(),
        code: 200,
        message: "OK".to_string(),
        headers: Vec::new(),
        bytes,
        body,
        call_time_ms: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_lists_pick_the_page_or_the_last() {
        assert_eq!(page_list("/s?p=<1,2,3>", 2), "/s?p=2");
        assert_eq!(page_list("/s?p=<,{{page}}>", 1), "/s?p=");
        assert_eq!(page_list("/list_<1,2,3>.html", 9), "/list_3.html");
    }

    #[test]
    fn parameters_encode_in_their_charset() {
        assert_eq!(encode_params("q=书&t=1", None, true), "q=%E4%B9%A6&t=1");
        assert_eq!(encode_params("q=书", Some("gbk"), false), "q=%CA%E9");
        assert_eq!(
            encode_params("q=%E4%B9%A6&a=b+c", None, true),
            "q=%E4%B9%A6&a=b+c"
        );
        assert_eq!(encode_params("q=a b", None, false), "q=a+b");
        assert_eq!(encode_params("q=书", Some("escape"), true), "q=%u4E66");
    }

    #[test]
    fn data_urls_decode() {
        let response = data_url_response("data:text/html;base64,5q2j5paH").unwrap();
        assert_eq!(response.body, "e6ada3e69687");
        assert_eq!(response.bytes, "正文".as_bytes());
        assert_eq!(data_url_response("data:,a%20b").unwrap().body, "a%20b");
    }
}
