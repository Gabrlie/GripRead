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

/// A DoH server: its `dns-query` address and an IP to reach it by, so the
/// lookup does not depend on the system resolver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DohServer {
    pub url: String,
    pub bootstrap: Option<IpAddr>,
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
}

impl DohResolver {
    pub fn new(server: DohServer) -> Self {
        Self {
            server,
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn client(&self) -> SourceResult<ureq::Agent> {
        let base = base_config(None)?;
        Ok(match self.server.bootstrap {
            Some(ip) => ureq::Agent::with_parts(base, DefaultConnector::new(), Fixed(ip)),
            None => base.into(),
        })
    }

    fn query(&self, host: &str) -> SourceResult<(Vec<IpAddr>, u32)> {
        let client = self.client()?;
        let mut addresses = Vec::new();
        let mut ttl = u32::MAX;
        for kind in [1u16, 28] {
            let message = dns_query(host, kind);
            let response = client
                .post(&self.server.url)
                .header("Content-Type", "application/dns-message")
                .header("Accept", "application/dns-message")
                .config()
                .timeout_global(Some(Duration::from_secs(5)))
                .build()
                .send(&message[..])
                .map_err(|error| SourceError::network(format!("DoH 查询失败：{error}")))?;
            let bytes = response
                .into_body()
                .read_to_vec()
                .map_err(|error| SourceError::network(format!("DoH 查询失败：{error}")))?;
            let (found, seconds) = dns_answers(&bytes)?;
            if !found.is_empty() {
                ttl = ttl.min(seconds);
            }
            addresses.extend(found);
        }
        Ok((addresses, if ttl == u32::MAX { 60 } else { ttl }))
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

/// Resolves every name to one address: the DoH server's bootstrap IP.
#[derive(Debug)]
struct Fixed(IpAddr);

impl Resolver for Fixed {
    fn resolve(
        &self,
        uri: &Uri,
        _config: &Config,
        _timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut result = self.empty();
        result.push(SocketAddr::new(self.0, uri.port_u16().unwrap_or(443)));
        Ok(result)
    }
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
    if bytes.len() < 12 {
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

/// 测试 for a DoH server: how long `host` takes to resolve, and its addresses.
pub fn test_doh(server: DohServer, host: &str) -> SourceResult<(Duration, Vec<IpAddr>)> {
    let started = Instant::now();
    let addresses = DohResolver::new(server).lookup(host)?;
    Ok((started.elapsed(), addresses))
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
