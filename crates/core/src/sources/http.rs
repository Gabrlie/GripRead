//! Source requests: redirects followed by hand so every hop's cookies are
//! kept, response charsets as Legado detects them, the cookie jar, and
//! each source's request rate.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use ureq::http::{Method, Request};

use super::context::{Control, Env};
use super::error::{SourceError, SourceResult};

pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_REDIRECTS: usize = 8;
const MAX_BODY: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
    Head,
}

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// The charset to decode the response with, overriding detection.
    pub charset: Option<String>,
    pub follow_redirects: bool,
    pub timeout: Duration,
}

impl HttpRequest {
    pub fn get(url: &str) -> Self {
        Self {
            method: HttpMethod::Get,
            url: url.to_string(),
            headers: Vec::new(),
            body: None,
            charset: None,
            follow_redirects: true,
            timeout: Duration::from_secs(15),
        }
    }
}

/// A response, as Legado's `StrResponse` exposes it.
#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    /// The final address after redirects.
    pub url: String,
    pub code: u16,
    pub message: String,
    pub headers: Vec<(String, String)>,
    pub bytes: Vec<u8>,
    pub body: String,
    pub call_time_ms: u64,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.code)
    }
}

/// Second-level labels that are public suffixes in common book-site domains.
const SHARED_SECOND_LEVEL: &[&str] = &["com", "net", "org", "gov", "edu", "co", "ac"];

/// The registrable domain cookies are filed under, like Legado's
/// `NetworkUtils.getSubDomain`.
pub fn cookie_domain(url: &str) -> String {
    let host = host_of(url);
    if host.parse::<std::net::IpAddr>().is_ok() || !host.contains('.') {
        return host;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let take = if labels.len() >= 3
        && labels[labels.len() - 1].len() == 2
        && SHARED_SECOND_LEVEL.contains(&labels[labels.len() - 2])
    {
        3
    } else {
        2
    };
    labels[labels.len().saturating_sub(take)..].join(".")
}

pub fn host_of(url: &str) -> String {
    let after = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = after.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = if host.starts_with('[') {
        host.split(']')
            .next()
            .unwrap_or(host)
            .trim_start_matches('[')
    } else {
        host.split(':').next().unwrap_or(host)
    };
    host.to_ascii_lowercase()
}

/// Parses `a=1; b=2` into ordered pairs.
pub fn cookie_pairs(cookie: &str) -> Vec<(String, String)> {
    cookie
        .split(';')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let (name, value) = part.split_once('=').unwrap_or((part, ""));
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

pub fn join_cookie(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Merges `update` into `base`, replacing cookies of the same name.
pub fn merge_cookies(base: &str, update: &str) -> String {
    let mut pairs = cookie_pairs(base);
    for (name, value) in cookie_pairs(update) {
        match pairs.iter_mut().find(|(existing, _)| *existing == name) {
            Some(pair) => pair.1 = value,
            None => pairs.push((name, value)),
        }
    }
    join_cookie(&pairs)
}

/// Applies `Set-Cookie` headers to the stored cookie of the response's domain.
fn store_set_cookies(env: &Env, url: &str, headers: &[(String, String)]) {
    let domain = cookie_domain(url);
    let mut pairs = cookie_pairs(&env.store.cookie_get(&domain).unwrap_or_default());
    let mut changed = false;
    for (_, value) in headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("set-cookie"))
    {
        let mut attributes = value.split(';');
        let Some(first) = attributes.next() else {
            continue;
        };
        let Some((name, cookie_value)) = first.split_once('=') else {
            continue;
        };
        let name = name.trim().to_string();
        let cookie_value = cookie_value.trim().to_string();
        let expired = attributes.any(|attribute| {
            let attribute = attribute.trim().to_ascii_lowercase();
            attribute == "max-age=0" || attribute.starts_with("max-age=-")
        });
        pairs.retain(|(existing, _)| *existing != name);
        if !expired && cookie_value != "deleted" {
            pairs.push((name, cookie_value));
        }
        changed = true;
    }
    if changed {
        env.store.cookie_put(&domain, &join_cookie(&pairs));
    }
}

fn charset_from_content_type(value: &str) -> Option<String> {
    value.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches(['"', '\'']).to_string())
    })
}

fn charset_from_meta(bytes: &[u8]) -> Option<String> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
    let at = head.find("charset=")?;
    let rest = &head[at + 8..];
    let value: String = rest
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    (!value.is_empty()).then_some(value)
}

/// Decodes a body: the requested charset, then the declared one, then UTF-8
/// when valid, then detection.
pub fn decode_body(bytes: &[u8], requested: Option<&str>, content_type: Option<&str>) -> String {
    let label = requested
        .filter(|label| !label.trim().is_empty())
        .map(str::to_string)
        .or_else(|| content_type.and_then(charset_from_content_type))
        .or_else(|| charset_from_meta(bytes));
    if let Some(encoding) =
        label.and_then(|label| encoding_rs::Encoding::for_label(label.trim().as_bytes()))
    {
        return encoding.decode(bytes).0.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.trim_start_matches('\u{feff}').to_string(),
        Err(_) => {
            let mut detector = chardetng::EncodingDetector::new();
            detector.feed(bytes, true);
            detector.guess(None, true).decode(bytes).0.into_owned()
        }
    }
}

/// Parses `concurrentRate`: `"N"` is one request per N ms, `"A/B"` is A
/// requests per B ms.
fn parse_rate(rate: &str) -> Option<(usize, u64)> {
    let rate = rate.trim();
    if rate.is_empty() || rate == "0" {
        return None;
    }
    match rate.split_once('/') {
        Some((count, window)) => {
            let count: usize = count.trim().parse().ok()?;
            let window: u64 = window.trim().parse().ok()?;
            (count > 0 && window > 0).then_some((count, window))
        }
        None => rate
            .parse::<u64>()
            .ok()
            .filter(|&ms| ms > 0)
            .map(|ms| (1, ms)),
    }
}

/// Waits until the source may send another request.
pub fn wait_for_rate(source_url: &str, rate: Option<&str>, control: &Control) -> SourceResult<()> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, Vec<Instant>>>> = OnceLock::new();
    let Some((count, window_ms)) = rate.and_then(parse_rate) else {
        return Ok(());
    };
    let window = Duration::from_millis(window_ms);
    loop {
        control.check()?;
        let wait = {
            let mut windows = WINDOWS
                .get_or_init(Default::default)
                .lock()
                .map_err(|_| SourceError::network("请求频率记录不可用"))?;
            let sent = windows.entry(source_url.to_string()).or_default();
            let now = Instant::now();
            sent.retain(|at| now.duration_since(*at) < window);
            if sent.len() < count {
                sent.push(now);
                None
            } else {
                Some(window - now.duration_since(sent[0]))
            }
        };
        match wait {
            None => return Ok(()),
            Some(wait) => std::thread::sleep(wait.min(Duration::from_millis(200))),
        }
    }
}

fn method_of(method: HttpMethod) -> Method {
    match method {
        HttpMethod::Get => Method::GET,
        HttpMethod::Post => Method::POST,
        HttpMethod::Head => Method::HEAD,
    }
}

/// The address as OkHttp sends it: characters a URL may not carry, such as
/// Chinese text or spaces in the path, are percent-encoded in UTF-8, while
/// existing escapes stay; the fragment is dropped.
pub fn wire_url(url: &str) -> String {
    let url = url.split('#').next().unwrap_or(url).trim();
    let mut out = String::with_capacity(url.len());
    for ch in url.chars() {
        match ch {
            '!'..='~' if !matches!(ch, '"' | '<' | '>' | '\\' | '^' | '`' | '{' | '|' | '}') => {
                out.push(ch)
            }
            _ => {
                let mut buffer = [0u8; 4];
                for byte in ch.encode_utf8(&mut buffer).bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    out
}

/// Sends a request for a source: rate-limited, with the source's cookies when
/// its cookie jar is on, following redirects by hand.
pub fn execute(env: &Env, request: &HttpRequest) -> SourceResult<HttpResponse> {
    env.control.check()?;
    let source_url = env.source.url();
    wait_for_rate(
        &source_url,
        env.source.concurrent_rate().as_deref(),
        &env.control,
    )?;
    let started = Instant::now();
    let mut url = wire_url(&request.url);
    let mut method = request.method;
    let mut body = request.body.clone();
    for _ in 0..=MAX_REDIRECTS {
        env.control.check()?;
        let mut wire: Vec<(String, String)> = Vec::new();
        let mut has_agent = false;
        let mut cookie_header: Option<String> = None;
        for (key, value) in &request.headers {
            if key.eq_ignore_ascii_case("cookie") {
                cookie_header = Some(value.clone());
                continue;
            }
            if key.eq_ignore_ascii_case("user-agent") {
                has_agent = true;
            }
            if key.eq_ignore_ascii_case("proxy") || key.eq_ignore_ascii_case("keep-alive") {
                continue;
            }
            wire.push((key.clone(), value.clone()));
        }
        if !has_agent {
            wire.push(("User-Agent".into(), DEFAULT_USER_AGENT.into()));
        }
        let stored = if env.source.enabled_cookie_jar() {
            env.store.cookie_get(&cookie_domain(&url))
        } else {
            None
        };
        let cookie = match (stored, cookie_header) {
            (Some(stored), Some(header)) => Some(merge_cookies(&stored, &header)),
            (stored, header) => header.or(stored),
        };
        if let Some(cookie) = cookie.filter(|cookie| !cookie.is_empty()) {
            wire.push(("Cookie".into(), cookie));
        }
        let hop_request = Hop {
            method: method_of(method).as_str().to_string(),
            url: url.clone(),
            headers: wire,
            body: body.clone(),
            timeout: request.timeout,
        };
        let hop = match relay_for(env) {
            // 通过服务器访问: the server sends this hop; cookies and
            // redirects are still handled here.
            Some(relay) => match relay(&hop_request) {
                Ok(answer) => answer,
                Err(message) => {
                    relay_failed(env, &message);
                    direct(env, &hop_request)?
                }
            },
            None => direct(env, &hop_request)?,
        };
        let code = hop.code;
        let headers = hop.headers;
        store_set_cookies(env, &url, &headers);
        let location = headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("location"))
            .map(|(_, value)| value.clone());
        if request.follow_redirects && (300..400).contains(&code) && code != 304 {
            if let Some(location) = location {
                url = wire_url(&super::util::absolute_url(&url, &location));
                if code == 303 || ((code == 301 || code == 302) && method == HttpMethod::Post) {
                    method = HttpMethod::Get;
                    body = None;
                }
                continue;
            }
        }
        let bytes = hop.bytes;
        let content_type = headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("content-type"))
            .map(|(_, value)| value.as_str());
        let text = decode_body(&bytes, request.charset.as_deref(), content_type);
        return Ok(HttpResponse {
            url,
            code,
            message: hop.message,
            headers,
            bytes,
            body: text,
            call_time_ms: started.elapsed().as_millis() as u64,
        });
    }
    Err(SourceError::network(format!(
        "重定向次数过多：{}",
        request.url
    )))
}

/// One request on the wire, as sent: what a relay is asked to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hop {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
}

/// The answer to one hop, redirects not followed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HopAnswer {
    pub code: u16,
    pub message: String,
    pub headers: Vec<(String, String)>,
    pub bytes: Vec<u8>,
}

type RelayFn = dyn Fn(&Hop) -> Result<HopAnswer, String> + Send + Sync;

/// 通过服务器访问: sends a hop through the server; installed while the
/// device is connected to one.
static RELAY: std::sync::RwLock<Option<std::sync::Arc<RelayFn>>> = std::sync::RwLock::new(None);

pub fn set_relay(relay: Option<std::sync::Arc<RelayFn>>) {
    if let Ok(mut slot) = RELAY.write() {
        *slot = relay;
    }
}

/// The source-cache key of a source's 通过服务器访问 switch (local only).
pub fn via_server_key(source_url: &str) -> String {
    format!("viaServer_{source_url}")
}

fn relay_for(env: &Env) -> Option<std::sync::Arc<RelayFn>> {
    #[cfg(test)]
    if let Some(relay) = testing::RELAY.with(|relay| relay.borrow().clone()) {
        return env
            .store
            .cache_get(&via_server_key(&env.source.url()))
            .filter(|value| value == "1")
            .map(|_| relay);
    }
    env.store
        .cache_get(&via_server_key(&env.source.url()))
        .filter(|value| value == "1")?;
    RELAY.read().ok()?.clone()
}

/// A relay that failed: the request goes out directly, said once per source.
fn relay_failed(env: &Env, message: &str) {
    static SAID: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let source = env.source.url();
    let first = SAID
        .get_or_init(Default::default)
        .lock()
        .map(|mut said| said.insert(source.clone()))
        .unwrap_or(false);
    env.log(format!("通过服务器访问失败，改为直接访问：{message}"));
    if first {
        // The reader hears of it once per source while the app runs.
        crate::notify::emit(
            "source-notice",
            crate::models::SourceNotice {
                source: env.source.name(),
                kind: crate::models::SourceNoticeKind::RelayFallback,
                message: message.to_string(),
            },
        );
        crate::app_log::warn(
            "source",
            format!("{source} 通过服务器访问失败，改为直接访问：{message}"),
        );
    }
}

/// Sends one hop from this device (rate-limited by 网络设置).
pub fn direct(env: &Env, hop: &Hop) -> SourceResult<HopAnswer> {
    let _permit = super::network::acquire(&host_of(&hop.url), &env.control)?;
    send(hop)
}

/// A hop as it travels to the server (`POST /api/source/fetch`): bodies in
/// base64, since sources send and receive bytes in any charset.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayHop {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayAnswer {
    pub code: u16,
    pub message: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl RelayHop {
    pub fn from_hop(hop: &Hop) -> Self {
        use base64::Engine as _;
        Self {
            method: hop.method.clone(),
            url: hop.url.clone(),
            headers: hop.headers.clone(),
            body: hop
                .body
                .as_ref()
                .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
            timeout_ms: hop.timeout.as_millis() as u64,
        }
    }

    pub fn to_hop(&self) -> Result<Hop, String> {
        use base64::Engine as _;
        Ok(Hop {
            method: self.method.clone(),
            url: self.url.clone(),
            headers: self.headers.clone(),
            body: match &self.body {
                Some(text) => Some(
                    base64::engine::general_purpose::STANDARD
                        .decode(text)
                        .map_err(|error| error.to_string())?,
                ),
                None => None,
            },
            timeout: Duration::from_millis(self.timeout_ms.clamp(1_000, 120_000)),
        })
    }
}

impl RelayAnswer {
    pub fn from_answer(answer: &HopAnswer) -> Self {
        use base64::Engine as _;
        Self {
            code: answer.code,
            message: answer.message.clone(),
            headers: answer.headers.clone(),
            body: base64::engine::general_purpose::STANDARD.encode(&answer.bytes),
        }
    }

    pub fn to_answer(&self) -> Result<HopAnswer, String> {
        use base64::Engine as _;
        Ok(HopAnswer {
            code: self.code,
            message: self.message.clone(),
            headers: self.headers.clone(),
            bytes: base64::engine::general_purpose::STANDARD
                .decode(&self.body)
                .map_err(|error| error.to_string())?,
        })
    }
}

/// The server's side of 通过服务器访问: sends a device's hop when its
/// address is a public one. Loopback, private, link-local, and other local
/// addresses are refused, so a device cannot reach the server's network.
pub fn relay_hop(hop: &Hop) -> Result<HopAnswer, String> {
    public_address(&hop.url)?;
    send(hop).map_err(|error| error.message)
}

/// Whether `url` is http(s) to a host whose every address is public.
pub fn public_address(url: &str) -> Result<(), String> {
    use std::net::{IpAddr, ToSocketAddrs};
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("只能访问 http 和 https 地址".into());
    }
    let host = host_of(url);
    let port = if lower.starts_with("https://") {
        443
    } else {
        80
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addresses: Vec<IpAddr> = match bare.parse::<IpAddr>() {
        Ok(address) => vec![address],
        Err(_) => (bare, port)
            .to_socket_addrs()
            .map_err(|error| format!("无法解析 {host}：{error}"))?
            .map(|address| address.ip())
            .collect(),
    };
    let local = |address: &IpAddr| match address {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_private() || v4.is_link_local())
        }
    };
    if addresses.is_empty() || addresses.iter().any(local) {
        return Err(format!("不能通过服务器访问本地或内网地址：{host}"));
    }
    Ok(())
}

fn send(hop: &Hop) -> SourceResult<HopAnswer> {
    let mut builder = Request::builder()
        .method(Method::from_bytes(hop.method.as_bytes()).unwrap_or(Method::GET))
        .uri(hop.url.as_str());
    for (key, value) in &hop.headers {
        builder = builder.header(key.as_str(), value.as_str());
    }
    let result = match &hop.body {
        Some(bytes) => builder
            .body(bytes.clone())
            .map_err(|error| SourceError::network(format!("请求无效：{error}")))
            .and_then(|request| run(request, hop.timeout)),
        None => builder
            .body(())
            .map_err(|error| SourceError::network(format!("请求无效：{error}")))
            .and_then(|request| run(request, hop.timeout)),
    };
    let mut response = result?;
    let code = response.status().as_u16();
    let message = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(key, value)| {
            (
                key.to_string(),
                String::from_utf8_lossy(value.as_bytes()).to_string(),
            )
        })
        .collect();
    let mut bytes = Vec::new();
    match response
        .body_mut()
        .as_reader()
        .take(MAX_BODY)
        .read_to_end(&mut bytes)
    {
        Ok(_) => {}
        // A server that hangs up without TLS close_notify still sent its
        // page; OkHttp keeps what arrived, and so does this.
        Err(error) if !bytes.is_empty() && error.kind() == std::io::ErrorKind::UnexpectedEof => {}
        Err(error) => return Err(SourceError::network(format!("读取响应失败：{error}"))),
    }
    Ok(HopAnswer {
        code,
        message,
        headers,
        bytes,
    })
}

fn run<B: ureq::AsSendBody>(
    request: Request<B>,
    timeout: Duration,
) -> SourceResult<ureq::http::Response<ureq::Body>> {
    let agent = super::network::agent();
    let request = agent
        .configure_request(request)
        .timeout_global(Some(timeout))
        .build();
    agent
        .run(request)
        .map_err(|error| SourceError::network(format!("网络请求失败：{error}")))
}

#[cfg(test)]
pub mod testing {
    //! A relay for this thread only, for engine tests.
    use super::*;

    thread_local! {
        pub static RELAY: std::cell::RefCell<Option<std::sync::Arc<RelayFn>>> =
            const { std::cell::RefCell::new(None) };
    }

    pub fn with_relay<R>(
        relay: impl Fn(&Hop) -> Result<HopAnswer, String> + Send + Sync + 'static,
        work: impl FnOnce() -> R,
    ) -> R {
        RELAY.with(|slot| *slot.borrow_mut() = Some(std::sync::Arc::new(relay)));
        let result = work();
        RELAY.with(|slot| *slot.borrow_mut() = None);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_relays_only_to_public_addresses() {
        for local in [
            "http://127.0.0.1:8080/a",
            "http://10.1.2.3/",
            "http://192.168.1.1/",
            "http://169.254.1.1/",
            "http://100.64.0.1/",
            "http://[::1]/",
            "http://[fd00::1]/",
            "http://localhost/",
        ] {
            assert!(public_address(local).is_err(), "{local}");
        }
        assert!(public_address("ftp://93.184.216.34/").is_err());
        assert!(public_address("https://93.184.216.34/page").is_ok());
        // The wire format carries bodies in any charset.
        let hop = Hop {
            method: "POST".into(),
            url: "https://93.184.216.34/s".into(),
            headers: vec![("Cookie".into(), "a=1".into())],
            body: Some(vec![0xd6, 0xd0]),
            timeout: Duration::from_secs(15),
        };
        assert_eq!(RelayHop::from_hop(&hop).to_hop().unwrap(), hop);
    }

    #[test]
    fn addresses_go_out_encoded_like_okhttp() {
        assert_eq!(
            wire_url("https://a.com/search/我的/1.html?q=%E6%88%91 x#top"),
            "https://a.com/search/%E6%88%91%E7%9A%84/1.html?q=%E6%88%91%20x"
        );
        assert_eq!(
            wire_url("https://a.com/a?b=1&c=[2]"),
            "https://a.com/a?b=1&c=[2]"
        );
    }

    #[test]
    fn cookie_domains_are_registrable_domains() {
        assert_eq!(cookie_domain("https://m.example.com/a"), "example.com");
        assert_eq!(
            cookie_domain("https://www.example.com.cn/a"),
            "example.com.cn"
        );
        assert_eq!(cookie_domain("http://127.0.0.1:8080/x"), "127.0.0.1");
        assert_eq!(merge_cookies("a=1; b=2", "b=3; c=4"), "a=1; b=3; c=4");
    }

    #[test]
    fn bodies_decode_by_declared_or_detected_charset() {
        let (gbk, _, _) = encoding_rs::GBK.encode("第一章 开始");
        assert_eq!(decode_body(&gbk, Some("gbk"), None), "第一章 开始");
        assert_eq!(
            decode_body(&gbk, None, Some("text/html; charset=GBK")),
            "第一章 开始"
        );
        let page = [b"<meta charset=\"gbk\">".as_slice(), &gbk].concat();
        assert!(decode_body(&page, None, None).ends_with("第一章 开始"));
        assert_eq!(decode_body("正文".as_bytes(), None, None), "正文");
    }

    #[test]
    fn rates_parse_both_forms() {
        assert_eq!(parse_rate("1500"), Some((1, 1500)));
        assert_eq!(parse_rate("20/60000"), Some((20, 60000)));
        assert_eq!(parse_rate("0"), None);
        assert_eq!(parse_rate("x"), None);
    }
}
