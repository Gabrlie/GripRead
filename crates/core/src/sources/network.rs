//! 网络设置 for book source requests: an optional proxy, DNS over HTTPS,
//! and request limits (all requests at once, and per site within a time
//! window). The app configures it at start and whenever the settings
//! change; requests then use the rebuilt client.

use super::context::Control;
use super::error::{SourceError, SourceResult};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};
use ureq::config::Config;
use ureq::http::Uri;
use ureq::tls::TlsConfig;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};

/// A DoH server: its `dns-query` address (which may carry its own query
/// string) and IPs to reach it by, so the lookup does not depend on the
/// system resolver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DohServer {
    pub url: String,
    pub bootstrap: Vec<IpAddr>,
}

/// The ways a DoH server is asked, in the order they are tried: RFC 8484's
/// POST and GET (`dns=` in the query), then the JSON form (`name=&type=`)
/// some servers speak instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DohForm {
    Post,
    Get,
    Json,
}

impl DohForm {
    pub fn name(self) -> &'static str {
        match self {
            DohForm::Post => "POST",
            DohForm::Get => "GET",
            DohForm::Json => "JSON",
        }
    }
}

/// `url` with `pair` added to its query string.
fn with_query(url: &str, pair: &str) -> String {
    let (address, fragment) = url.split_once('#').map_or((url, ""), |(a, f)| (a, f));
    let joiner = if !address.contains('?') {
        "?"
    } else if address.ends_with('?') || address.ends_with('&') {
        ""
    } else {
        "&"
    };
    let fragment = if fragment.is_empty() {
        String::new()
    } else {
        format!("#{fragment}")
    };
    format!("{address}{joiner}{pair}{fragment}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetConfig {
    /// `http://user:pass@host:port` or `socks5://…`.
    pub proxy: Option<String>,
    pub doh: Option<DohServer>,
    /// Requests in flight at once, over all sources.
    pub max_requests: usize,
    /// Requests to one site within `window`.
    pub per_host: usize,
    pub window: Duration,
}

impl Default for NetConfig {
    fn default() -> Self {
        Self {
            proxy: None,
            doh: None,
            max_requests: 12,
            per_host: 6,
            window: Duration::from_secs(1),
        }
    }
}

struct State {
    config: NetConfig,
    agent: Arc<ureq::Agent>,
}

static STATE: RwLock<Option<State>> = RwLock::new(None);

fn base_config(proxy: Option<&str>) -> SourceResult<Config> {
    let proxy = match proxy {
        Some(address) => Some(
            ureq::Proxy::new(address)
                .map_err(|error| SourceError::network(format!("代理设置无效：{error}")))?,
        ),
        None => None,
    };
    Ok(ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        // Legado's client accepts any certificate; many book sites have
        // broken or expired ones.
        .tls_config(TlsConfig::builder().disable_verification(true).build())
        .timeout_connect(Some(Duration::from_secs(15)))
        .proxy(proxy)
        .build())
}

fn build(config: &NetConfig) -> SourceResult<ureq::Agent> {
    let base = base_config(config.proxy.as_deref())?;
    Ok(match &config.doh {
        // Through a proxy, the proxy resolves names.
        Some(server) if config.proxy.is_none() => ureq::Agent::with_parts(
            base,
            DefaultConnector::new(),
            DohResolver::new(server.clone()),
        ),
        _ => base.into(),
    })
}

/// Applies new settings; an invalid proxy keeps the previous client.
pub fn configure(config: NetConfig) -> SourceResult<()> {
    let agent = Arc::new(build(&config)?);
    if let Ok(mut state) = STATE.write() {
        *state = Some(State { config, agent });
    }
    LIMITER.free.notify_all();
    Ok(())
}

fn current() -> (NetConfig, Arc<ureq::Agent>) {
    if let Some(state) = STATE.read().ok().as_ref().and_then(|state| state.as_ref()) {
        return (state.config.clone(), state.agent.clone());
    }
    let config = NetConfig::default();
    let agent = Arc::new(build(&config).expect("the default client builds"));
    if let Ok(mut state) = STATE.write() {
        state.get_or_insert(State {
            config: config.clone(),
            agent: agent.clone(),
        });
    }
    (config, agent)
}

pub fn agent() -> Arc<ureq::Agent> {
    current().1
}

struct Limiter {
    state: Mutex<(usize, BTreeMap<String, VecDeque<Instant>>)>,
    free: Condvar,
}

static LIMITER: Limiter = Limiter {
    state: Mutex::new((0, BTreeMap::new())),
    free: Condvar::new(),
};

/// Holds one of the requests allowed at once; dropping it frees the place.
pub struct Permit;

impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut state) = LIMITER.state.lock() {
            state.0 = state.0.saturating_sub(1);
        }
        LIMITER.free.notify_all();
    }
}

/// Waits for a place among the requests in flight and in `host`'s window,
/// giving up when the operation is cancelled or out of time.
pub fn acquire(host: &str, control: &Control) -> SourceResult<Permit> {
    let (config, _) = current();
    let mut state = LIMITER
        .state
        .lock()
        .map_err(|_| SourceError::network("网络限流不可用"))?;
    loop {
        control.check()?;
        let now = Instant::now();
        let window = config.window.max(Duration::from_millis(1));
        let (in_flight, hosts) = &mut *state;
        let recent = hosts.entry(host.to_string()).or_default();
        while recent
            .front()
            .is_some_and(|at| now.duration_since(*at) >= window)
        {
            recent.pop_front();
        }
        // The device itself (a local service, or the tests' fixture sites)
        // is not a site to be polite to.
        let local = host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
        let wait = if *in_flight >= config.max_requests.max(1) {
            Some(Duration::from_millis(50))
        } else if !local && config.per_host > 0 && recent.len() >= config.per_host {
            recent
                .front()
                .map(|first| window.saturating_sub(now.duration_since(*first)))
        } else {
            None
        };
        match wait {
            None => {
                recent.push_back(now);
                *in_flight += 1;
                return Ok(Permit);
            }
            Some(wait) => {
                let wait = wait.clamp(Duration::from_millis(5), Duration::from_millis(200));
                state = LIMITER
                    .free
                    .wait_timeout(state, wait)
                    .map_err(|_| SourceError::network("网络限流不可用"))?
                    .0;
            }
        }
    }
}

/// Resolves names over HTTPS (RFC 8484), keeping answers for their TTL and
/// falling back to the system resolver when the server does not answer.
#[derive(Debug)]
pub struct DohResolver {
    server: DohServer,
    cache: Mutex<HashMap<String, (Vec<IpAddr>, Instant)>>,
    /// The form that last worked, tried first from then on.
    form: Mutex<Option<DohForm>>,
}

impl DohResolver {
    pub fn new(server: DohServer) -> Self {
        Self {
            server,
            cache: Mutex::new(HashMap::new()),
            form: Mutex::new(None),
        }
    }

    fn client(&self) -> SourceResult<ureq::Agent> {
        let base = base_config(None)?;
        Ok(if self.server.bootstrap.is_empty() {
            base.into()
        } else {
            ureq::Agent::with_parts(
                base,
                DefaultConnector::new(),
                Fixed(self.server.bootstrap.clone()),
            )
        })
    }

    /// The form that answered last, if any.
    pub fn form(&self) -> Option<DohForm> {
        self.form.lock().ok().and_then(|form| *form)
    }

    fn query(&self, host: &str) -> SourceResult<(Vec<IpAddr>, u32)> {
        let client = self.client()?;
        let mut forms = vec![DohForm::Post, DohForm::Get, DohForm::Json];
        if let Some(known) = self.form() {
            forms.retain(|form| *form != known);
            forms.insert(0, known);
        }
        let mut failures = Vec::new();
        for form in forms {
            match self.query_as(&client, form, host) {
                Ok(found) => {
                    if let Ok(mut known) = self.form.lock() {
                        *known = Some(form);
                    }
                    return Ok(found);
                }
                Err(error) => failures.push(format!("{} {}", form.name(), error.message)),
            }
        }
        Err(SourceError::network(failures.join("; ")))
    }

    /// Both record types in one form; any failure means the form does not work here.
    fn query_as(
        &self,
        client: &ureq::Agent,
        form: DohForm,
        host: &str,
    ) -> SourceResult<(Vec<IpAddr>, u32)> {
        let mut addresses = Vec::new();
        let mut ttl = u32::MAX;
        for kind in [1u16, 28] {
            let (found, seconds) = self.ask(client, form, host, kind)?;
            if !found.is_empty() {
                ttl = ttl.min(seconds);
            }
            addresses.extend(found);
        }
        Ok((addresses, if ttl == u32::MAX { 60 } else { ttl }))
    }

    fn ask(
        &self,
        client: &ureq::Agent,
        form: DohForm,
        host: &str,
        kind: u16,
    ) -> SourceResult<(Vec<IpAddr>, u32)> {
        use base64::Engine as _;
        let timeout = Some(Duration::from_secs(5));
        let failed = |error: ureq::Error| SourceError::network(error.to_string());
        let message = dns_query(host, kind);
        let response = match form {
            DohForm::Post => client
                .post(&self.server.url)
                .header("Content-Type", "application/dns-message")
                .header("Accept", "application/dns-message")
                .config()
                .timeout_global(timeout)
                .build()
                .send(&message[..])
                .map_err(failed)?,
            DohForm::Get => {
                let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&message);
                client
                    .get(with_query(&self.server.url, &format!("dns={encoded}")))
                    .header("Accept", "application/dns-message")
                    .config()
                    .timeout_global(timeout)
                    .build()
                    .call()
                    .map_err(failed)?
            }
            DohForm::Json => {
                let name: String = url::form_urlencoded::byte_serialize(host.as_bytes()).collect();
                client
                    .get(with_query(
                        &self.server.url,
                        &format!("name={name}&type={}", if kind == 1 { "A" } else { "AAAA" }),
                    ))
                    .header("Accept", "application/dns-json")
                    .config()
                    .timeout_global(timeout)
                    .build()
                    .call()
                    .map_err(failed)?
            }
        };
        let status = response.status().as_u16();
        let bytes = response
            .into_body()
            .read_to_vec()
            .map_err(|error| SourceError::network(error.to_string()))?;
        if !(200..300).contains(&status) {
            return Err(SourceError::network(format!("HTTP {status}")));
        }
        let answer = match form {
            DohForm::Json => json_answers(&bytes),
            _ => dns_answers(&bytes),
        };
        // An answer that is not DNS says what came back instead.
        answer.map_err(|_| {
            let text: String = String::from_utf8_lossy(&bytes)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(60)
                .collect();
            SourceError::network(if text.is_empty() {
                format!("HTTP {status}, empty")
            } else {
                format!("HTTP {status} \u{201c}{text}\u{201d}")
            })
        })
    }

    /// The addresses of `host`, from the cache while they are fresh.
    pub fn lookup(&self, host: &str) -> SourceResult<Vec<IpAddr>> {
        if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
            return Ok(vec![ip]);
        }
        if let Some((addresses, until)) = self
            .cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(host).cloned())
        {
            if Instant::now() < until {
                return Ok(addresses);
            }
        }
        let (addresses, ttl) = self.query(host)?;
        if addresses.is_empty() {
            return Err(SourceError::network(format!("DoH 找不到 {host}")));
        }
        if let Ok(mut cache) = self.cache.lock() {
            let keep = Duration::from_secs(u64::from(ttl.clamp(30, 3600)));
            cache.insert(host.to_string(), (addresses.clone(), Instant::now() + keep));
        }
        Ok(addresses)
    }
}

impl Resolver for DohResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let host = uri.host().unwrap_or_default();
        let port = uri
            .port_u16()
            .unwrap_or(if uri.scheme_str() == Some("http") {
                80
            } else {
                443
            });
        match self.lookup(host) {
            Ok(addresses) => {
                let mut result = self.empty();
                for ip in addresses.into_iter().take(16) {
                    result.push(SocketAddr::new(ip, port));
                }
                Ok(result)
            }
            Err(_) => DefaultResolver::default().resolve(uri, config, timeout),
        }
    }
}

/// Resolves every name to the DoH server's bootstrap IPs.
#[derive(Debug)]
struct Fixed(Vec<IpAddr>);

impl Resolver for Fixed {
    fn resolve(
        &self,
        uri: &Uri,
        _config: &Config,
        _timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut result = self.empty();
        let port = uri
            .port_u16()
            .unwrap_or(if uri.scheme_str() == Some("http") {
                80
            } else {
                443
            });
        for ip in self.0.iter().take(16) {
            result.push(SocketAddr::new(*ip, port));
        }
        Ok(result)
    }
}

/// The addresses in a JSON DoH answer (`{"Answer": [{"type": 1, "data":
/// "1.2.3.4", "TTL": 60}]}`) and the shortest TTL.
pub fn json_answers(bytes: &[u8]) -> SourceResult<(Vec<IpAddr>, u32)> {
    let bad = || SourceError::network("DoH 回答无效");
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| bad())?;
    if value
        .get("Status")
        .and_then(|status| status.as_u64())
        .is_none()
    {
        return Err(bad());
    }
    let mut found = Vec::new();
    let mut ttl = u32::MAX;
    for answer in value
        .get("Answer")
        .and_then(|answers| answers.as_array())
        .into_iter()
        .flatten()
    {
        let kind = answer.get("type").and_then(|kind| kind.as_u64());
        let Some(ip) = answer
            .get("data")
            .and_then(|data| data.as_str())
            .and_then(|data| data.parse::<IpAddr>().ok())
        else {
            continue;
        };
        if matches!(kind, Some(1 | 28)) {
            found.push(ip);
            if let Some(seconds) = answer.get("TTL").and_then(|ttl| ttl.as_u64()) {
                ttl = ttl.min(seconds as u32);
            }
        }
    }
    Ok((found, ttl))
}

/// A DNS query message for `host` and record type `kind` (1 = A, 28 = AAAA).
pub fn dns_query(host: &str, kind: u16) -> Vec<u8> {
    // ID 0 as RFC 8484 suggests for caching, recursion desired, one question.
    let mut message = vec![0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in host.trim_end_matches('.').split('.') {
        message.push(label.len().min(63) as u8);
        message.extend(label.bytes().take(63));
    }
    message.push(0);
    message.extend(kind.to_be_bytes());
    message.extend(1u16.to_be_bytes());
    message
}

fn skip_name(bytes: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let length = *bytes.get(at)? as usize;
        if length == 0 {
            return Some(at + 1);
        }
        if length & 0xC0 == 0xC0 {
            return Some(at + 2);
        }
        at += 1 + length;
    }
}

/// The A and AAAA addresses in a DNS answer and the shortest TTL.
pub fn dns_answers(bytes: &[u8]) -> SourceResult<(Vec<IpAddr>, u32)> {
    let bad = || SourceError::network("DoH 回答无效");
    let read16 = |at: usize| -> Option<u16> {
        Some(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
    };
    // A reply has the response bit set; anything else (an error page) is not one.
    if bytes.len() < 12 || bytes[2] & 0x80 == 0 {
        return Err(bad());
    }
    let questions = read16(4).ok_or_else(bad)?;
    let answers = read16(6).ok_or_else(bad)?;
    let mut at = 12;
    for _ in 0..questions {
        at = skip_name(bytes, at).ok_or_else(bad)? + 4;
    }
    let mut found = Vec::new();
    let mut ttl = u32::MAX;
    for _ in 0..answers {
        at = skip_name(bytes, at).ok_or_else(bad)?;
        let kind = read16(at).ok_or_else(bad)?;
        let seconds = u32::from_be_bytes(
            bytes
                .get(at + 4..at + 8)
                .ok_or_else(bad)?
                .try_into()
                .map_err(|_| bad())?,
        );
        let length = read16(at + 8).ok_or_else(bad)? as usize;
        let data = bytes.get(at + 10..at + 10 + length).ok_or_else(bad)?;
        match (kind, length) {
            (1, 4) => found.push(IpAddr::from(<[u8; 4]>::try_from(data).map_err(|_| bad())?)),
            (28, 16) => found.push(IpAddr::from(<[u8; 16]>::try_from(data).map_err(|_| bad())?)),
            _ => {}
        }
        if matches!(kind, 1 | 28) {
            ttl = ttl.min(seconds);
        }
        at += 10 + length;
    }
    Ok((found, ttl))
}

/// 测试 for a DoH server: how long `host` takes to resolve, its addresses,
/// and the form that worked.
pub fn test_doh(server: DohServer, host: &str) -> SourceResult<(Duration, Vec<IpAddr>, DohForm)> {
    let started = Instant::now();
    let resolver = DohResolver::new(server);
    let addresses = resolver.lookup(host)?;
    Ok((
        started.elapsed(),
        addresses,
        resolver.form().unwrap_or(DohForm::Post),
    ))
}

/// 测试 for a proxy: how long a request to `url` takes through it.
pub fn test_proxy(proxy: &str, url: &str) -> SourceResult<(Duration, u16)> {
    let agent: ureq::Agent = base_config(Some(proxy))?.into();
    let started = Instant::now();
    let response = agent
        .get(url)
        .config()
        .timeout_global(Some(Duration::from_secs(15)))
        .build()
        .call()
        .map_err(|error| SourceError::network(format!("代理连接失败：{error}")))?;
    Ok((started.elapsed(), response.status().as_u16()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_messages_encode_and_answers_decode() {
        let query = dns_query("a.cn", 1);
        assert_eq!(&query[12..], &[1, b'a', 2, b'c', b'n', 0, 0, 1, 0, 1]);
        // The query echoed with one A answer pointing back at the name.
        let mut answer = query.clone();
        answer[2] = 0x81;
        answer[3] = 0x80;
        answer[7] = 1;
        answer.extend([0xC0, 12, 0, 1, 0, 1, 0, 0, 0, 120, 0, 4, 1, 2, 3, 4]);
        let (found, ttl) = dns_answers(&answer).unwrap();
        assert_eq!(found, vec![IpAddr::from([1, 2, 3, 4])]);
        assert_eq!(ttl, 120);
        assert!(dns_answers(&[0, 1]).is_err());
    }

    /// A DNS reply to `query` with one A answer, 1.2.3.4.
    fn reply_to(query: &[u8]) -> Vec<u8> {
        let mut answer = query.to_vec();
        answer[2] = 0x81;
        answer[3] = 0x80;
        answer[7] = 1;
        let kind = u16::from_be_bytes([query[query.len() - 4], query[query.len() - 3]]);
        if kind == 1 {
            answer.extend([0xC0, 12, 0, 1, 0, 1, 0, 0, 0, 120, 0, 4, 1, 2, 3, 4]);
        } else {
            answer[7] = 0;
        }
        answer
    }

    #[test]
    fn doh_servers_answering_get_or_json_with_their_own_query_work() {
        use super::super::test_server::{start, Request, Response};
        use base64::Engine as _;
        let binary = |body: Vec<u8>| Response {
            status: 200,
            content_type: "application/dns-message".into(),
            headers: Vec::new(),
            body,
        };
        // GET only, and only with the address's own query kept first.
        let get_only = start(move |request: &Request| {
            if request.method != "GET" || !request.query.starts_with("cf=x&dns=") {
                return Response {
                    status: 200,
                    content_type: "text/plain".into(),
                    headers: Vec::new(),
                    body: b"[CRITICAL ERROR] undefined".to_vec(),
                };
            }
            let encoded = request.query.trim_start_matches("cf=x&dns=");
            let query = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(encoded)
                .unwrap();
            binary(reply_to(&query))
        });
        let server = |url: String| DohServer {
            url,
            bootstrap: Vec::new(),
        };
        let (_, found, form) = test_doh(server(format!("{get_only}/doh?cf=x")), "a.cn").unwrap();
        assert_eq!(found, vec![IpAddr::from([1, 2, 3, 4])]);
        assert_eq!(form, DohForm::Get);
        // JSON only.
        let json_only = start(|request: &Request| {
            if request.param("name").as_deref() != Some("a.cn") {
                return Response::not_found();
            }
            let answer = if request.param("type").as_deref() == Some("A") {
                r#"{"Status":0,"Answer":[{"name":"a.cn","type":1,"TTL":30,"data":"5.6.7.8"}]}"#
            } else {
                r#"{"Status":0}"#
            };
            Response {
                status: 200,
                content_type: "application/dns-json".into(),
                headers: Vec::new(),
                body: answer.as_bytes().to_vec(),
            }
        });
        let (_, found, form) = test_doh(server(format!("{json_only}/resolve")), "a.cn").unwrap();
        assert_eq!(found, vec![IpAddr::from([5, 6, 7, 8])]);
        assert_eq!(form, DohForm::Json);
        // Nothing works: each form says what it got.
        let broken = start(|_: &Request| Response {
            status: 200,
            content_type: "text/plain".into(),
            headers: Vec::new(),
            body: b"[CRITICAL ERROR] undefined".to_vec(),
        });
        let error = test_doh(server(format!("{broken}/doh?cf=x")), "a.cn").unwrap_err();
        assert!(error.message.contains("POST HTTP 200"), "{}", error.message);
        assert!(error.message.contains("GET"), "{}", error.message);
        assert!(
            error.message.contains("CRITICAL ERROR"),
            "{}",
            error.message
        );
    }

    #[test]
    fn query_strings_take_more_parameters() {
        assert_eq!(with_query("https://a/q", "dns=1"), "https://a/q?dns=1");
        assert_eq!(
            with_query("https://a/q?cf=x", "dns=1"),
            "https://a/q?cf=x&dns=1"
        );
        assert_eq!(with_query("https://a/q?", "dns=1"), "https://a/q?dns=1");
    }

    #[test]
    fn requests_wait_for_their_site_window() {
        configure(NetConfig {
            per_host: 2,
            window: Duration::from_millis(120),
            ..NetConfig::default()
        })
        .unwrap();
        let control = Control::unlimited();
        let started = Instant::now();
        for _ in 0..3 {
            drop(acquire("limit.test", &control).unwrap());
        }
        // The third had to wait for the first to leave the window.
        assert!(started.elapsed() >= Duration::from_millis(100));
        let other = Instant::now();
        drop(acquire("other.test", &control).unwrap());
        assert!(other.elapsed() < Duration::from_millis(50));
        assert!(configure(NetConfig {
            proxy: Some("bogus://".into()),
            ..NetConfig::default()
        })
        .is_err());
        configure(NetConfig::default()).unwrap();
    }
}
