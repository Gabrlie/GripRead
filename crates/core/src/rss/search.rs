//! 搜索订阅: words are looked up in Feedly's public directory; an address
//! is tried as a feed, then for the feeds its page names, then against the
//! RSSHub instance's Radar rules, which turn a site's pages into RSSHub
//! routes. A feed can be read before subscribing ([`preview`]).

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;
use url::Url;

use super::{discover_all, fetch, lock, network, normalize_url, parse_feed, FEED_LIMIT};
use crate::error::{AppError, ErrorCode};
use crate::models::{FeedPreview, FeedSearchResult, FeedSearchSource, PreviewArticle};
use crate::storage::Storage;

const FEEDLY: &str = "https://cloud.feedly.com/v3/search/feeds";
const FEEDLY_COUNT: u32 = 20;
const RULES_FILE: &str = "rsshub-rules.json";
/// Radar rules are fetched again after a day.
const RULES_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
const RULES_LIMIT: u64 = 32 * 1024 * 1024;
const PREVIEW_ARTICLES: usize = 30;

/// Where searches go: Feedly, and the RSSHub instance (with its key).
pub struct SearchSites<'a> {
    pub feedly: &'a str,
    pub instance: &'a str,
    pub key: &'a str,
    /// Where the instance's Radar rules are kept between searches.
    pub rules_file: &'a Path,
}

/// Whether the reader typed an address rather than words.
pub fn is_address(query: &str) -> bool {
    let query = query.trim();
    if query.contains("://") {
        return true;
    }
    !query.contains(char::is_whitespace)
        && Url::parse(&format!("https://{query}"))
            .ok()
            .and_then(|url| url.host_str().map(|host| host.contains('.')))
            .unwrap_or(false)
}

/// Searches with this device's settings.
pub fn search_feeds(
    storage: &Mutex<Storage>,
    query: &str,
) -> Result<Vec<FeedSearchResult>, AppError> {
    let (settings, root) = {
        let guard = lock(storage)?;
        (guard.rss_settings(), guard.root_path().to_path_buf())
    };
    crate::network::refresh(&root);
    search(
        query,
        &SearchSites {
            feedly: FEEDLY,
            instance: &settings.rsshub_instance,
            key: &settings.rsshub_key,
            rules_file: &root.join(RULES_FILE),
        },
    )
}

pub fn search(query: &str, sites: &SearchSites<'_>) -> Result<Vec<FeedSearchResult>, AppError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if !is_address(query) {
        return feedly(sites.feedly, query);
    }
    let address = normalize_url(query)?;
    let mut found: Vec<FeedSearchResult> = Vec::new();
    let mut failure = None;
    match discover_all(&address) {
        Ok(candidates) => {
            for (candidate, direct) in candidates {
                found.push(FeedSearchResult {
                    title: candidate.title,
                    site: (!direct).then(|| address.clone()),
                    description: None,
                    subscribers: None,
                    icon: None,
                    source: if direct {
                        FeedSearchSource::Feed
                    } else {
                        FeedSearchSource::Page
                    },
                    url: candidate.url,
                });
            }
        }
        Err(error) => failure = Some(error),
    }
    // The address is itself a feed: nothing else to look for.
    if found
        .iter()
        .any(|result| result.source == FeedSearchSource::Feed)
    {
        return Ok(found);
    }
    match radar_rules(sites) {
        Ok(rules) => {
            for result in radar_routes(&rules, &address, sites.instance, sites.key) {
                if !found.iter().any(|known| known.url == result.url) {
                    found.push(result);
                }
            }
        }
        Err(error) => {
            crate::log_keyed!(
                Info,
                "rss",
                "rssRadarUnavailable",
                format!("RSSHub 规则读取失败：{}", error.message),
                @error error,
            );
        }
    }
    if found.is_empty() {
        // A page that could not be reached says so; any other page simply
        // has no feed.
        let failure = failure.filter(|error| error.key.as_deref() == Some("rssNetwork"));
        return Err(failure.unwrap_or_else(|| {
            AppError::keyed(
                ErrorCode::InvalidArgument,
                "rssNoFeedFound",
                "这个地址没有找到 RSS 或 Atom 订阅",
            )
        }));
    }
    Ok(found)
}

fn text(value: &Value, name: &str) -> Option<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Feeds in Feedly's directory for some words.
fn feedly(base: &str, query: &str) -> Result<Vec<FeedSearchResult>, AppError> {
    let mut url = Url::parse(base).map_err(network)?;
    url.query_pairs_mut()
        .append_pair("query", query)
        .append_pair("count", &FEEDLY_COUNT.to_string());
    let response = fetch(
        url.as_str(),
        &[("Accept", "application/json".to_string())],
        FEED_LIMIT,
    )?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::keyed(
            ErrorCode::Io,
            "rssSearchFailed",
            format!("搜索失败：HTTP {}", response.status),
        )
        .with("status", response.status));
    }
    let body: Value = serde_json::from_slice(&response.body).map_err(network)?;
    let results = body
        .get("results")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    Ok(results
        .iter()
        .filter_map(|item| {
            let url = text(item, "feedId")?
                .strip_prefix("feed/")
                .filter(|url| url.starts_with("http"))?
                .to_string();
            Some(FeedSearchResult {
                title: text(item, "title").unwrap_or_else(|| url.clone()),
                site: text(item, "website"),
                description: text(item, "description"),
                subscribers: item.get("subscribers").and_then(Value::as_u64),
                icon: text(item, "iconUrl").or_else(|| text(item, "visualUrl")),
                source: FeedSearchSource::Feedly,
                url,
            })
        })
        .collect())
}

/// The instance's Radar rules, kept for a day; an old copy serves when
/// the instance cannot be reached.
fn radar_rules(sites: &SearchSites<'_>) -> Result<Value, AppError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64);
    let kept: Option<Value> = fs::read(sites.rules_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(|kept: &Value| {
            kept.get("instance").and_then(Value::as_str) == Some(sites.instance)
        });
    let fetched_at = kept
        .as_ref()
        .and_then(|kept| kept.get("fetchedAt"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if let Some(kept) = &kept {
        if now - fetched_at < RULES_MAX_AGE_MS {
            if let Some(rules) = kept.get("rules") {
                return Ok(rules.clone());
            }
        }
    }
    let mut url = format!("{}/api/radar/rules", sites.instance);
    if !sites.key.is_empty() {
        url = with_key(&url, sites.key);
    }
    let fresh = fetch(
        &url,
        &[("Accept", "application/json".to_string())],
        RULES_LIMIT,
    )
    .and_then(|response| {
        if (200..300).contains(&response.status) {
            serde_json::from_slice::<Value>(&response.body).map_err(network)
        } else {
            Err(AppError::new(
                ErrorCode::Io,
                format!("HTTP {}", response.status),
            ))
        }
    })
    .and_then(|rules| {
        if rules.is_object() {
            Ok(rules)
        } else {
            Err(AppError::new(ErrorCode::Io, "RSSHub 规则格式不对"))
        }
    });
    match fresh {
        Ok(rules) => {
            let kept = serde_json::json!({
                "instance": sites.instance,
                "fetchedAt": now,
                "rules": rules,
            });
            if let Some(parent) = sites.rules_file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(sites.rules_file, kept.to_string());
            Ok(rules)
        }
        Err(error) => kept
            .and_then(|kept| kept.get("rules").cloned())
            .ok_or(error),
    }
}

fn with_key(url: &str, key: &str) -> String {
    let mut url = match Url::parse(url) {
        Ok(url) => url,
        Err(_) => return url.to_string(),
    };
    url.query_pairs_mut().append_pair("key", key);
    url.to_string()
}

/// The RSSHub feeds Radar rules give for a page: each rule of its site
/// whose path pattern matches, with the page's values put into the route.
pub fn radar_routes(
    rules: &Value,
    address: &str,
    instance: &str,
    key: &str,
) -> Vec<FeedSearchResult> {
    let Ok(url) = Url::parse(address) else {
        return Vec::new();
    };
    let Some(host) = url.host_str() else {
        return Vec::new();
    };
    let host = host.to_ascii_lowercase();
    let path = url.path().trim_end_matches('/');
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let labels: Vec<&str> = host.split('.').collect();
    let mut found: Vec<FeedSearchResult> = Vec::new();
    // Every suffix of the host may be the site (example.com, example.com.cn).
    for start in 0..labels.len().saturating_sub(1) {
        let domain = labels[start..].join(".");
        let Some(site) = rules.get(&domain) else {
            continue;
        };
        let sub = if start == 0 {
            ".".to_string()
        } else {
            labels[..start].join(".")
        };
        let mut subs = vec![sub.clone()];
        match sub.as_str() {
            "." => subs.push("www".into()),
            "www" => subs.push(".".into()),
            _ => {}
        }
        let site_name = text(site, "_name");
        for sub in subs {
            let Some(entries) = site.get(&sub).and_then(Value::as_array) else {
                continue;
            };
            for entry in entries {
                let Some(target) = text(entry, "target") else {
                    continue;
                };
                let sources: Vec<String> = match entry.get("source") {
                    Some(Value::String(source)) => vec![source.clone()],
                    Some(Value::Array(sources)) => sources
                        .iter()
                        .filter_map(|source| source.as_str().map(str::to_string))
                        .collect(),
                    _ => Vec::new(),
                };
                for source in sources {
                    let Some(values) = match_path(&source, &segments) else {
                        continue;
                    };
                    let Some(route) = fill_route(&target, &values) else {
                        continue;
                    };
                    let mut feed = format!("{instance}{route}");
                    if !key.is_empty() {
                        feed = with_key(&feed, key);
                    }
                    if found.iter().any(|known| known.url == feed) {
                        break;
                    }
                    let title = text(entry, "title").unwrap_or_else(|| route.clone());
                    found.push(FeedSearchResult {
                        title: match &site_name {
                            Some(site) => format!("{site} · {title}"),
                            None => title,
                        },
                        site: Some(address.to_string()),
                        description: Some(route),
                        subscribers: None,
                        icon: None,
                        source: FeedSearchSource::Rsshub,
                        url: feed,
                    });
                    break;
                }
            }
        }
    }
    found
}

/// The values of a path pattern's parameters (`:name`, `:name?`, and `*`
/// for the rest) in a page's path, if it matches.
fn match_path(pattern: &str, segments: &[&str]) -> Option<Vec<(String, String)>> {
    // A query or a hash is not part of the path; a `?` ending a part
    // makes that part optional.
    let pattern = pattern.split('#').next().unwrap_or_default();
    let pattern = match pattern.char_indices().find(|(at, char)| {
        *char == '?' && !matches!(pattern[at + 1..].chars().next(), None | Some('/'))
    }) {
        Some((at, _)) => &pattern[..at],
        None => pattern,
    };
    let parts: Vec<&str> = pattern
        .trim_end_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let mut values = Vec::new();
    walk(&parts, segments, &mut values).then_some(values)
}

/// Whether the pattern parts take up exactly these segments.
fn walk(parts: &[&str], segments: &[&str], values: &mut Vec<(String, String)>) -> bool {
    let Some((part, rest)) = parts.split_first() else {
        return segments.is_empty();
    };
    if *part == "*" {
        values.push(("*".into(), segments.join("/")));
        return true;
    }
    if let Some(name) = part.strip_prefix(':') {
        // `:name{regex}` keeps only its name.
        let name = name.split('{').next().unwrap_or(name);
        let (name, optional) = match name.strip_suffix('?') {
            Some(name) => (name, true),
            None => (name, false),
        };
        if let Some((segment, others)) = segments.split_first() {
            let mark = values.len();
            values.push((name.to_string(), decode(segment)));
            if walk(rest, others, values) {
                return true;
            }
            values.truncate(mark);
        }
        return optional && walk(rest, segments, values);
    }
    match segments.split_first() {
        Some((segment, others)) if segment.eq_ignore_ascii_case(part) => walk(rest, others, values),
        _ => false,
    }
}

fn decode(segment: &str) -> String {
    url::form_urlencoded::parse(format!("v={segment}").as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| segment.to_string())
}

/// The route with the values in; `None` when one it needs is missing.
fn fill_route(target: &str, values: &[(String, String)]) -> Option<String> {
    if !target.starts_with('/') {
        return None;
    }
    let mut route = String::new();
    for part in target.split('/').filter(|part| !part.is_empty()) {
        let piece = if let Some(name) = part.strip_prefix(':') {
            let (name, optional) = match name.strip_suffix('?') {
                Some(name) => (name, true),
                None => (name, false),
            };
            match values.iter().find(|(known, _)| known == name) {
                Some((_, value)) if !value.is_empty() => {
                    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
                }
                _ if optional => continue,
                _ => return None,
            }
        } else {
            part.to_string()
        };
        route.push('/');
        route.push_str(&piece);
    }
    Some(if route.is_empty() { "/".into() } else { route })
}

/// A feed's newest articles, read without subscribing.
pub fn preview(storage: &Mutex<Storage>, address: &str) -> Result<FeedPreview, AppError> {
    let root = lock(storage)?.root_path().to_path_buf();
    crate::network::refresh(&root);
    preview_at(address)
}

pub fn preview_at(address: &str) -> Result<FeedPreview, AppError> {
    let address = normalize_url(address)?;
    let response = fetch(&address, &[], FEED_LIMIT)?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            ErrorCode::Io,
            format!("HTTP {}", response.status),
        ));
    }
    let feed = parse_feed(&response.url, &response.body)?;
    let mut articles: Vec<PreviewArticle> = feed
        .articles
        .into_iter()
        .map(|article| PreviewArticle {
            id: article.id,
            title: article.title,
            link: article.link,
            author: article.author,
            published_at: article.published_at,
            excerpt: article.excerpt,
            image: article.image,
            content: article.content,
        })
        .collect();
    articles.sort_by_key(|article| std::cmp::Reverse(article.published_at));
    articles.truncate(PREVIEW_ARTICLES);
    Ok(FeedPreview {
        title: if feed.title.is_empty() {
            address.clone()
        } else {
            feed.title
        },
        url: address,
        site_url: feed.site_url,
        articles,
    })
}
