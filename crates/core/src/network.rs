//! 网络设置: kept in `network.json` in the data folder (never in backups),
//! applied to the source engine's client at start, on every change, and
//! when the app returns to the foreground (the device's proxy may have
//! changed), and the limits searches and downloads read.

use crate::error::AppError;
use crate::models::{
    ConcurrencyLimits, ConcurrencyPreset, NetworkCheck, NetworkSettings, NetworkState, ProxyKind,
};
use crate::sources::network::{DohServer, NetConfig};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

const FILE: &str = "network.json";

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            doh_enabled: false,
            doh_server: "ali".into(),
            doh_custom_url: String::new(),
            proxy_kind: ProxyKind::None,
            proxy_host: String::new(),
            proxy_port: 1080,
            proxy_username: String::new(),
            proxy_password: String::new(),
            preset: ConcurrencyPreset::Balanced,
            custom: preset_limits(ConcurrencyPreset::Balanced),
        }
    }
}

/// The presets: 省心 is gentle on slow networks and strict sites, 极速 asks a lot at once.
pub fn preset_limits(preset: ConcurrencyPreset) -> ConcurrencyLimits {
    let (requests, per_host, search, download_books, download_chapters) = match preset {
        ConcurrencyPreset::Relaxed => (6, 3, 4, 1, 2),
        ConcurrencyPreset::Balanced | ConcurrencyPreset::Custom => (12, 6, 8, 2, 4),
        ConcurrencyPreset::Fast => (24, 12, 16, 3, 8),
    };
    ConcurrencyLimits {
        requests,
        per_host,
        window_ms: 1_000,
        search,
        download_books,
        download_chapters,
    }
}

/// The limits in effect: a preset's, or the 自定义 ones kept within sense.
pub fn limits_of(settings: &NetworkSettings) -> ConcurrencyLimits {
    if settings.preset != ConcurrencyPreset::Custom {
        return preset_limits(settings.preset);
    }
    let custom = settings.custom;
    ConcurrencyLimits {
        requests: custom.requests.clamp(1, 64),
        per_host: custom.per_host.min(64),
        window_ms: custom.window_ms.clamp(100, 60_000),
        search: custom.search.clamp(1, 32),
        download_books: custom.download_books.clamp(1, 8),
        download_chapters: custom.download_chapters.clamp(1, 16),
    }
}

/// The known DoH servers, each with an address to reach it without DNS.
fn doh_server(settings: &NetworkSettings) -> Option<DohServer> {
    if !settings.doh_enabled {
        return None;
    }
    let known = |url: &str, ip: [u8; 4]| DohServer {
        url: url.into(),
        bootstrap: Some(IpAddr::from(ip)),
    };
    Some(match settings.doh_server.as_str() {
        "tencent" => known("https://doh.pub/dns-query", [1, 12, 12, 12]),
        "cloudflare" => known("https://cloudflare-dns.com/dns-query", [1, 1, 1, 1]),
        "google" => known("https://dns.google/dns-query", [8, 8, 8, 8]),
        "custom" => {
            let url = settings.doh_custom_url.trim();
            if !url.starts_with("https://") {
                return None;
            }
            DohServer {
                url: url.into(),
                bootstrap: None,
            }
        }
        _ => known("https://dns.alidns.com/dns-query", [223, 5, 5, 5]),
    })
}

/// The proxy as an address ureq understands, with its account.
pub fn proxy_url(settings: &NetworkSettings) -> Option<String> {
    let scheme = match settings.proxy_kind {
        ProxyKind::None => return None,
        ProxyKind::Http => "http",
        ProxyKind::Socks5 => "socks5",
    };
    let host = settings.proxy_host.trim();
    if host.is_empty() {
        return None;
    }
    let encode =
        |text: &str| -> String { url::form_urlencoded::byte_serialize(text.as_bytes()).collect() };
    let account = match (
        settings.proxy_username.trim(),
        settings.proxy_password.as_str(),
    ) {
        ("", _) => String::new(),
        (user, "") => format!("{}@", encode(user)),
        (user, password) => format!("{}:{}@", encode(user), encode(password)),
    };
    Some(format!(
        "{scheme}://{account}{host}:{}",
        settings.proxy_port
    ))
}

/// Requests go through the app's proxy, else the device's; through either
/// the proxy resolves names, so DoH is off.
fn net_config(settings: &NetworkSettings, system: &NetworkState) -> NetConfig {
    let limits = limits_of(settings);
    let proxy = proxy_url(settings).or_else(|| {
        system
            .system_proxy
            .as_ref()
            .map(|address| format!("http://{address}"))
    });
    NetConfig {
        doh: doh_server(settings).filter(|_| proxy.is_none()),
        proxy,
        max_requests: usize::from(limits.requests),
        per_host: usize::from(limits.per_host),
        window: Duration::from_millis(u64::from(limits.window_ms)),
    }
}

static LIMITS: RwLock<Option<ConcurrencyLimits>> = RwLock::new(None);

pub type Detector = Box<dyn Fn() -> Option<String> + Send + Sync>;
/// How the platform reports its proxy as `host:port` (the Android plugin);
/// without one the `HTTPS_PROXY`/`HTTP_PROXY` environment variables are read.
static DETECTOR: OnceLock<Detector> = OnceLock::new();
static SYSTEM: RwLock<Option<NetworkState>> = RwLock::new(None);

fn detect() -> NetworkState {
    let system_proxy = match DETECTOR.get() {
        Some(detector) => detector(),
        None => ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
            .iter()
            .find_map(|name| std::env::var(name).ok())
            .map(|value| {
                let value = value.trim();
                let value = value.split_once("://").map_or(value, |(_, rest)| rest);
                value.trim_end_matches('/').to_string()
            }),
    };
    NetworkState {
        system_proxy: system_proxy.filter(|address| !address.is_empty()),
    }
}

/// The device's proxy as last detected.
pub fn state() -> NetworkState {
    SYSTEM
        .read()
        .ok()
        .and_then(|state| state.clone())
        .unwrap_or_default()
}

/// The limits searches and downloads use now.
pub fn limits() -> ConcurrencyLimits {
    LIMITS
        .read()
        .ok()
        .and_then(|limits| *limits)
        .unwrap_or_else(|| preset_limits(ConcurrencyPreset::Balanced))
}

/// Installs how the platform reports its proxy as `host:port` (the Android
/// shell's `NetworkPlugin`); a second call is ignored.
pub fn set_detector(detector: Detector) {
    let _ = DETECTOR.set(detector);
}

fn path(root: &Path) -> PathBuf {
    root.join(FILE)
}

pub fn load(root: &Path) -> NetworkSettings {
    std::fs::read_to_string(path(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Applies settings to the engine with the device's proxy as detected now;
/// an invalid proxy is refused.
pub fn apply(settings: &NetworkSettings) -> Result<(), AppError> {
    apply_as(settings, detect())
}

fn apply_as(settings: &NetworkSettings, system: NetworkState) -> Result<(), AppError> {
    crate::sources::network::configure(net_config(settings, &system))
        .map_err(|error| AppError::invalid_argument(error.message))?;
    if let Ok(mut state) = SYSTEM.write() {
        *state = Some(system);
    }
    if let Ok(mut limits) = LIMITS.write() {
        *limits = Some(limits_of(settings));
    }
    Ok(())
}

/// Applies the saved settings at start, then once more on another thread
/// when the device reports a proxy (asking it may wait on the UI thread).
pub fn start(root: &Path) -> Result<(), AppError> {
    let result = apply_as(&load(root), NetworkState::default());
    let root = root.to_path_buf();
    std::thread::spawn(move || refresh(&root));
    result
}

/// Applies the saved settings again when the device's proxy changed.
pub fn refresh(root: &Path) {
    if detect() == state() {
        return;
    }
    if let Err(error) = apply(&load(root)) {
        crate::app_log::warn("network", format!("系统代理无效：{}", error.message));
    }
}

/// The proxy other requests of the app (updates) go through: the app's own,
/// else the device's, as for book sources.
pub fn proxy(root: &Path) -> Option<String> {
    proxy_url(&load(root)).or_else(|| {
        state()
            .system_proxy
            .map(|address| format!("http://{address}"))
    })
}

pub fn save(root: &Path, settings: &NetworkSettings) -> Result<(), AppError> {
    apply(settings)?;
    std::fs::write(path(root), serde_json::to_string(settings)?)?;
    Ok(())
}

/// 测试: resolves a well-known host over the chosen DoH server, or fetches
/// a page through the proxy.
pub fn check(settings: &NetworkSettings, kind: &str) -> Result<NetworkCheck, AppError> {
    let failed =
        |error: crate::sources::error::SourceError| AppError::invalid_argument(error.message);
    match kind {
        "doh" => {
            let server = doh_server(&NetworkSettings {
                doh_enabled: true,
                ..settings.clone()
            })
            .ok_or_else(|| AppError::invalid_argument("DoH 地址需要以 https:// 开头"))?;
            let (took, addresses) =
                crate::sources::network::test_doh(server, "www.baidu.com").map_err(failed)?;
            Ok(NetworkCheck {
                millis: took.as_millis() as u32,
                detail: format!(
                    "www.baidu.com → {}",
                    addresses
                        .iter()
                        .take(2)
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join("、")
                ),
            })
        }
        _ => {
            let proxy =
                proxy_url(settings).ok_or_else(|| AppError::invalid_argument("请先填写代理"))?;
            let (took, status) =
                crate::sources::network::test_proxy(&proxy, "https://www.baidu.com/")
                    .map_err(failed)?;
            Ok(NetworkCheck {
                millis: took.as_millis() as u32,
                detail: format!("HTTP {status}"),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_and_proxy_addresses() {
        let mut settings = NetworkSettings::default();
        assert_eq!(limits_of(&settings).search, 8);
        settings.preset = ConcurrencyPreset::Relaxed;
        assert_eq!(limits_of(&settings).download_books, 1);
        settings.preset = ConcurrencyPreset::Custom;
        settings.custom.requests = 0;
        settings.custom.window_ms = 5;
        let custom = limits_of(&settings);
        assert_eq!((custom.requests, custom.window_ms), (1, 100));

        assert_eq!(proxy_url(&settings), None);
        settings.proxy_kind = ProxyKind::Socks5;
        settings.proxy_host = "10.0.0.2".into();
        settings.proxy_port = 7890;
        settings.proxy_username = "me".into();
        settings.proxy_password = "p@ss".into();
        assert_eq!(
            proxy_url(&settings).as_deref(),
            Some("socks5://me:p%40ss@10.0.0.2:7890")
        );
        settings.doh_enabled = true;
        let system = NetworkState {
            system_proxy: Some("127.0.0.1:8080".into()),
        };
        let config = net_config(&settings, &system);
        assert_eq!(
            config.proxy.as_deref(),
            Some("socks5://me:p%40ss@10.0.0.2:7890")
        );
        assert_eq!(config.doh, None);
        settings.proxy_kind = ProxyKind::None;
        let config = net_config(&settings, &system);
        assert_eq!(config.proxy.as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(config.doh, None, "the device's proxy turns DoH off too");
        assert!(net_config(&settings, &NetworkState::default())
            .doh
            .is_some());
        settings.doh_server = "custom".into();
        settings.doh_custom_url = "http://insecure".into();
        assert_eq!(doh_server(&settings), None);
    }

    #[test]
    fn settings_are_kept_on_the_device_and_applied() {
        let root = std::env::temp_dir().join(format!("gripread-network-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(load(&root), NetworkSettings::default());
        let settings = NetworkSettings {
            preset: ConcurrencyPreset::Fast,
            ..NetworkSettings::default()
        };
        save(&root, &settings).unwrap();
        assert_eq!(load(&root), settings);
        assert_eq!(limits().search, 16);
        let bad = NetworkSettings {
            proxy_kind: ProxyKind::Http,
            proxy_host: "bad host with spaces".into(),
            ..NetworkSettings::default()
        };
        assert!(save(&root, &bad).is_err());
        assert_eq!(load(&root), settings, "a refused proxy is not kept");
        apply(&NetworkSettings::default()).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    /// Resolves through each known DoH server over the real network.
    #[test]
    #[ignore = "needs the network"]
    fn live_doh() {
        for server in ["ali", "tencent", "cloudflare", "google"] {
            let settings = NetworkSettings {
                doh_server: server.into(),
                ..NetworkSettings::default()
            };
            println!(
                "{server}: {:?}",
                check(&settings, "doh").map(|found| (found.millis, found.detail))
            );
        }
    }
}
