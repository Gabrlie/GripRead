//! 订阅: fetching and reading RSS/Atom feeds. Feeds are fetched through the
//! app's network settings (proxy, DoH) with conditional requests, parsed by
//! `feed-rs` (RSS 0.9–2.0, RSS 1.0, Atom, JSON Feed), and their HTML is
//! sanitized once, when stored. Pages are searched for the feeds they name,
//! OPML files exchange subscription lists, and an article's page can be read
//! for its full text when the feed gives only an excerpt.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use ego_tree::NodeRef;
use scraper::{ElementRef, Html, Node, Selector};
use url::Url;

use crate::error::{AppError, ErrorCode};
use crate::models::{FeedCandidate, OpmlImportReport};
use crate::storage::{article_id, FetchedArticle, FetchedFeed, Storage};

const USER_AGENT: &str = "Mozilla/5.0 (compatible; GripRead; +https://github.com/Gabrlie/GripRead)";
const TIMEOUT: Duration = Duration::from_secs(30);
const FEED_LIMIT: u64 = 16 * 1024 * 1024;
const IMAGE_LIMIT: u64 = 20 * 1024 * 1024;
const REDIRECTS: usize = 5;
const EXCERPT_CHARS: usize = 160;
/// Full text shorter than this is not believed to be the article.
const FULL_TEXT_MIN_CHARS: usize = 200;

fn lock(storage: &Mutex<Storage>) -> Result<std::sync::MutexGuard<'_, Storage>, AppError> {
    storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
}

fn network(error: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Io, format!("网络请求失败：{error}"))
}

/// A fetched response: the final address, status, headers we use, and body.
pub struct Fetched {
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub body: Vec<u8>,
}

/// GET through the app's client, following redirects.
pub fn fetch(url: &str, headers: &[(&str, String)], limit: u64) -> Result<Fetched, AppError> {
    let agent = crate::sources::network::agent();
    let mut address = url.to_string();
    for _ in 0..=REDIRECTS {
        let mut request = agent
            .get(&address)
            .config()
            .timeout_global(Some(TIMEOUT))
            .build()
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5");
        for (name, value) in headers {
            request = request.header(*name, value.as_str());
        }
        let mut response = request.call().map_err(network)?;
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        };
        if (300..400).contains(&status) && status != 304 {
            let location = header("location")
                .ok_or_else(|| AppError::new(ErrorCode::Io, format!("HTTP {status}")))?;
            address = Url::parse(&address)
                .and_then(|base| base.join(&location))
                .map_err(network)?
                .to_string();
            continue;
        }
        let content_type = header("content-type").unwrap_or_default();
        let etag = header("etag");
        let last_modified = header("last-modified");
        let mut body = Vec::new();
        response
            .body_mut()
            .with_config()
            .limit(limit)
            .reader()
            .read_to_end(&mut body)
            .map_err(network)?;
        return Ok(Fetched {
            url: address,
            status,
            content_type,
            etag,
            last_modified,
            body,
        });
    }
    Err(AppError::new(ErrorCode::Io, "重定向次数过多"))
}

/// Parses a feed document at `url`.
pub fn parse_feed(url: &str, body: &[u8]) -> Result<FetchedFeed, AppError> {
    let parser = feed_rs::parser::Builder::new()
        .base_uri(Some(url))
        // Entries without an id are known by their link or title, so a
        // refresh finds them again.
        .id_generator(|links, title, _| {
            links
                .first()
                .map(|link| link.href.clone())
                .or_else(|| title.as_ref().map(|title| title.content.clone()))
                .unwrap_or_default()
        })
        .build();
    let feed = parser
        .parse(body)
        .map_err(|error| AppError::invalid_argument(format!("不是有效的订阅源：{error}")))?;
    let site_url = feed
        .links
        .iter()
        .find(|link| link.rel.as_deref().is_none_or(|rel| rel == "alternate"))
        .map(|link| link.href.clone())
        .filter(|href| href != url);
    let icon_url = feed
        .icon
        .as_ref()
        .or(feed.logo.as_ref())
        .map(|image| image.uri.clone());
    let mut articles = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in feed.entries {
        let link = entry
            .links
            .iter()
            .find(|link| link.rel.as_deref().is_none_or(|rel| rel == "alternate"))
            .or(entry.links.first())
            .map(|link| link.href.clone());
        let key = if entry.id.is_empty() {
            link.clone().unwrap_or_default()
        } else {
            entry.id.clone()
        };
        let title = entry
            .title
            .as_ref()
            .map(|title| plain_text(&title.content))
            .unwrap_or_default();
        let base = link.as_deref().unwrap_or(url);
        let raw = entry
            .content
            .as_ref()
            .and_then(|content| content.body.clone())
            .or_else(|| entry.summary.as_ref().map(text_html))
            .unwrap_or_default();
        let summary_text = entry
            .summary
            .as_ref()
            .map(|summary| plain_text(&summary.content))
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| plain_text(&raw));
        // An RSS item may be nothing but its text, which then identifies it.
        let identity = [key.as_str(), title.as_str(), summary_text.as_str()]
            .into_iter()
            .find(|part| !part.is_empty());
        let Some(identity) = identity else {
            continue;
        };
        let id = article_id(url, identity);
        if !seen.insert(id.clone()) {
            continue;
        }
        let content = sanitize(&raw, base);
        let image = entry
            .media
            .iter()
            .flat_map(|media| {
                media
                    .thumbnails
                    .iter()
                    .map(|thumbnail| thumbnail.image.uri.clone())
                    .chain(media.content.iter().filter_map(|content| {
                        let image = content
                            .content_type
                            .as_ref()
                            .is_none_or(|kind| kind.ty() == "image");
                        image
                            .then(|| content.url.as_ref().map(Url::to_string))
                            .flatten()
                    }))
            })
            .next()
            .or_else(|| first_image(&content));
        articles.push(FetchedArticle {
            id,
            title: if title.is_empty() {
                excerpt(&summary_text, 40)
            } else {
                title
            },
            link,
            author: entry
                .authors
                .iter()
                .filter_map(|person| person.name.clone())
                .find(|name| !name.trim().is_empty()),
            published_at: entry
                .published
                .or(entry.updated)
                .map(|time| time.timestamp_millis())
                .unwrap_or(0),
            excerpt: excerpt(&summary_text, EXCERPT_CHARS),
            image,
            content,
        });
    }
    Ok(FetchedFeed {
        title: feed
            .title
            .map(|title| plain_text(&title.content))
            .unwrap_or_default(),
        site_url,
        icon_url,
        articles,
        ..FetchedFeed::default()
    })
}

/// Feed text as HTML: escaped when it is plain text.
fn text_html(text: &feed_rs::model::Text) -> String {
    if text.content_type.subty() == "plain" {
        escape(&text.content).replace('\n', "<br>")
    } else {
        text.content.clone()
    }
}

/// Fetches and stores one feed; returns its new articles.
pub fn refresh_feed(storage: &Mutex<Storage>, url: &str) -> Result<u32, AppError> {
    let state = lock(storage)?
        .feed_fetch_state(url)?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "没有这个订阅"))?;
    let mut headers = Vec::new();
    if let Some(etag) = &state.etag {
        headers.push(("If-None-Match", etag.clone()));
    }
    if let Some(modified) = &state.last_modified {
        headers.push(("If-Modified-Since", modified.clone()));
    }
    let result = (|| {
        let response = fetch(url, &headers, FEED_LIMIT)?;
        if response.status == 304 {
            lock(storage)?.record_feed_unchanged(url)?;
            return Ok(0);
        }
        if !(200..300).contains(&response.status) {
            return Err(AppError::new(
                ErrorCode::Io,
                format!("HTTP {}", response.status),
            ));
        }
        let mut feed = parse_feed(url, &response.body)?;
        feed.etag = response.etag;
        feed.last_modified = response.last_modified;
        lock(storage)?.store_feed_fetch(url, &feed)
    })();
    if let Err(error) = &result {
        lock(storage)?.record_feed_error(url, &error.message)?;
        crate::app_log::warn(
            "rss",
            format!("{} 刷新失败：{}", state.title, error.message),
        );
    }
    result
}

/// The feeds at an address: the address itself when it is a feed, the
/// feeds a page links to, or the usual feed paths of its site.
pub fn discover(address: &str) -> Result<Vec<FeedCandidate>, AppError> {
    let address = normalize_url(address)?;
    let response = fetch(&address, &[], FEED_LIMIT)?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            ErrorCode::Io,
            format!("HTTP {}", response.status),
        ));
    }
    if let Ok(feed) = parse_feed(&response.url, &response.body) {
        return Ok(vec![FeedCandidate {
            title: if feed.title.is_empty() {
                response.url.clone()
            } else {
                feed.title
            },
            url: response.url,
        }]);
    }
    let html = decode_html(&response.body, &response.content_type);
    let mut found = linked_feeds(&html, &response.url);
    if found.is_empty() {
        // Sites without the link often serve one of these.
        let base = Url::parse(&response.url).map_err(network)?;
        for path in [
            "/feed",
            "/rss",
            "/rss.xml",
            "/atom.xml",
            "/feed.xml",
            "/index.xml",
        ] {
            let Ok(candidate) = base.join(path) else {
                continue;
            };
            let Ok(response) = fetch(candidate.as_str(), &[], FEED_LIMIT) else {
                continue;
            };
            if !(200..300).contains(&response.status) {
                continue;
            }
            if let Ok(feed) = parse_feed(&response.url, &response.body) {
                found.push(FeedCandidate {
                    title: if feed.title.is_empty() {
                        response.url.clone()
                    } else {
                        feed.title
                    },
                    url: response.url,
                });
                break;
            }
        }
    }
    if found.is_empty() {
        return Err(AppError::invalid_argument(
            "这个地址没有找到 RSS 或 Atom 订阅",
        ));
    }
    Ok(found)
}

/// `<link rel="alternate">` feeds of a page.
pub fn linked_feeds(html: &str, base: &str) -> Vec<FeedCandidate> {
    let document = Html::parse_document(html);
    let Ok(selector) = Selector::parse("link[rel~=alternate][href]") else {
        return Vec::new();
    };
    let mut found: Vec<FeedCandidate> = Vec::new();
    for link in document.select(&selector) {
        let kind = link
            .value()
            .attr("type")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(
            kind.as_str(),
            "application/rss+xml"
                | "application/atom+xml"
                | "application/feed+json"
                | "application/json"
        ) {
            continue;
        }
        let Some(url) = link
            .value()
            .attr("href")
            .and_then(|href| resolve(base, href))
        else {
            continue;
        };
        if found.iter().any(|known| known.url == url) {
            continue;
        }
        found.push(FeedCandidate {
            title: link
                .value()
                .attr("title")
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or(&url)
                .to_string(),
            url,
        });
    }
    found
}

fn normalize_url(address: &str) -> Result<String, AppError> {
    let address = address.trim();
    let address = if address.contains("://") {
        address.to_string()
    } else {
        format!("https://{address}")
    };
    let url = Url::parse(&address).map_err(|_| AppError::invalid_argument("地址无效"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::invalid_argument("只支持 http 和 https 地址"));
    }
    Ok(url.to_string())
}

/// Subscribes to `url` and fetches it once; the feed's title is used when
/// none is given.
pub fn subscribe(
    storage: &Mutex<Storage>,
    url: &str,
    title: Option<&str>,
    group: Option<&str>,
) -> Result<(), AppError> {
    let url = normalize_url(url)?;
    let title = title.map(str::trim).filter(|title| !title.is_empty());
    if !lock(storage)?.add_feed(&url, title.unwrap_or(""), group, None)? {
        return Err(AppError::invalid_argument("已经订阅过这个地址"));
    }
    if let Err(error) = refresh_feed(storage, &url) {
        // A feed that cannot be read now stays, showing its error.
        crate::app_log::info("rss", format!("新订阅暂时无法读取：{}", error.message));
    }
    Ok(())
}

// ---------------------------------------------------------------- OPML

/// A subscription in an OPML file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpmlFeed {
    pub url: String,
    pub title: String,
    pub site_url: Option<String>,
    pub group: Option<String>,
}

/// The feeds of an OPML file; a feed's group is the path of the outlines
/// around it.
pub fn parse_opml(text: &str) -> Result<Vec<OpmlFeed>, AppError> {
    let text = text.trim_start_matches('\u{feff}');
    let document = roxmltree::Document::parse(text)
        .map_err(|error| AppError::invalid_argument(format!("不是有效的 OPML 文件：{error}")))?;
    let body = document
        .descendants()
        .find(|node| node.has_tag_name("body"))
        .ok_or_else(|| AppError::invalid_argument("OPML 文件没有 body"))?;
    let mut feeds = Vec::new();
    fn walk(node: roxmltree::Node<'_, '_>, path: &mut Vec<String>, feeds: &mut Vec<OpmlFeed>) {
        for child in node
            .children()
            .filter(|child| child.has_tag_name("outline"))
        {
            let name = child
                .attribute("title")
                .or_else(|| child.attribute("text"))
                .unwrap_or_default()
                .trim()
                .to_string();
            match child
                .attribute("xmlUrl")
                .map(str::trim)
                .filter(|url| !url.is_empty())
            {
                Some(url) => feeds.push(OpmlFeed {
                    url: url.to_string(),
                    title: if name.is_empty() {
                        url.to_string()
                    } else {
                        name
                    },
                    site_url: child.attribute("htmlUrl").map(str::to_string),
                    group: (!path.is_empty()).then(|| path.join(" / ")),
                }),
                None => {
                    let named = !name.is_empty();
                    if named {
                        path.push(name);
                    }
                    walk(child, path, feeds);
                    if named {
                        path.pop();
                    }
                }
            }
        }
    }
    walk(body, &mut Vec::new(), &mut feeds);
    Ok(feeds)
}

/// Subscribes to an OPML file's feeds; known addresses are left alone.
pub fn import_opml(storage: &Mutex<Storage>, text: &str) -> Result<OpmlImportReport, AppError> {
    let feeds = parse_opml(text)?;
    let guard = lock(storage)?;
    let mut report = OpmlImportReport::default();
    for feed in feeds {
        let Ok(url) = normalize_url(&feed.url) else {
            continue;
        };
        if guard.add_feed(
            &url,
            &feed.title,
            feed.group.as_deref(),
            feed.site_url.as_deref(),
        )? {
            report.added += 1;
        } else {
            report.existing += 1;
        }
    }
    Ok(report)
}

/// The subscriptions as an OPML 2.0 file, grouped as they are here.
pub fn export_opml(storage: &Storage) -> Result<String, AppError> {
    let feeds = storage.list_feeds()?;
    let outline = |feed: &crate::models::Feed, indent: &str| {
        format!(
            "{indent}<outline type=\"rss\" text=\"{0}\" title=\"{0}\" xmlUrl=\"{1}\"{2}/>\n",
            escape(&feed.title),
            escape(&feed.url),
            feed.site_url
                .as_ref()
                .map(|site| format!(" htmlUrl=\"{}\"", escape(site)))
                .unwrap_or_default()
        )
    };
    let mut body = String::new();
    let mut groups: Vec<&str> = Vec::new();
    for feed in &feeds {
        match &feed.group {
            Some(group) if !groups.contains(&group.as_str()) => groups.push(group),
            _ => {}
        }
    }
    for feed in feeds.iter().filter(|feed| feed.group.is_none()) {
        body.push_str(&outline(feed, "    "));
    }
    for group in groups {
        body.push_str(&format!(
            "    <outline text=\"{0}\" title=\"{0}\">\n",
            escape(group)
        ));
        for feed in feeds
            .iter()
            .filter(|feed| feed.group.as_deref() == Some(group))
        {
            body.push_str(&outline(feed, "      "));
        }
        body.push_str("    </outline>\n");
    }
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head>\n    <title>手不释卷订阅</title>\n  </head>\n  <body>\n{body}  </body>\n</opml>\n"
    ))
}

// ---------------------------------------------------------------- Images

/// An article image, from the device or fetched now (with the article as
/// the referrer, which some sites require).
pub fn image(
    storage: &Mutex<Storage>,
    url: &str,
    referer: Option<&str>,
) -> Result<Vec<u8>, AppError> {
    let url = normalize_url(url)?;
    let path = lock(storage)?
        .rss_image_cache()
        .join(crate::storage::cover_key("rss", &url));
    if let Ok(bytes) = fs::read(&path) {
        return Ok(bytes);
    }
    let mut headers = Vec::new();
    if let Some(referer) = referer.filter(|referer| referer.starts_with("http")) {
        headers.push(("Referer", referer.to_string()));
    }
    let response = fetch(&url, &headers, IMAGE_LIMIT)?;
    if !(200..300).contains(&response.status) || response.body.is_empty() {
        return Err(AppError::new(
            ErrorCode::Io,
            format!("图片读取失败：HTTP {}", response.status),
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("part");
    fs::write(&partial, &response.body)?;
    fs::rename(&partial, &path)?;
    Ok(response.body)
}

// ---------------------------------------------------------------- Full text

/// Reads the article's page and keeps its main text (全文).
pub fn full_text(storage: &Mutex<Storage>, id: &str) -> Result<String, AppError> {
    let article = lock(storage)?.rss_article(id)?;
    let link = article
        .summary
        .link
        .clone()
        .ok_or_else(|| AppError::invalid_argument("这篇文章没有原文链接"))?;
    let response = fetch(&link, &[], FEED_LIMIT)?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            ErrorCode::Io,
            format!("原文读取失败：HTTP {}", response.status),
        ));
    }
    let html = decode_html(&response.body, &response.content_type);
    let text = extract_main(&html, &response.url)
        .ok_or_else(|| AppError::invalid_argument("没能从原文页面中找到正文"))?;
    lock(storage)?.save_full_text(id, &text)?;
    Ok(text)
}

/// Decodes a page by its declared charset (header, then `<meta>`), UTF-8
/// otherwise.
pub fn decode_html(body: &[u8], content_type: &str) -> String {
    let declared = charset_of(content_type).or_else(|| {
        let head = String::from_utf8_lossy(&body[..body.len().min(2048)]).to_ascii_lowercase();
        let at = head.find("charset=")?;
        let rest = &head[at + 8..];
        let rest = rest.trim_start_matches(['"', '\'']);
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .unwrap_or(rest.len());
        Some(rest[..end].to_string())
    });
    let encoding = declared
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(body).0.into_owned()
}

fn charset_of(content_type: &str) -> Option<String> {
    content_type
        .split(';')
        .find_map(|part| part.trim().strip_prefix("charset="))
        .map(|charset| charset.trim_matches(['"', '\'']).to_string())
}

const POSITIVE: &[&str] = &[
    "article", "body", "content", "entry", "main", "page", "post", "text", "blog", "story",
];
const NEGATIVE: &[&str] = &[
    "comment",
    "meta",
    "footer",
    "footnote",
    "sidebar",
    "nav",
    "share",
    "related",
    "promo",
    "header",
    "menu",
    "widget",
    "advert",
    "banner",
    "social",
    "breadcrumb",
];

fn class_weight(element: &scraper::node::Element) -> f64 {
    let names = format!(
        "{} {}",
        element.attr("class").unwrap_or_default(),
        element.attr("id").unwrap_or_default()
    )
    .to_ascii_lowercase();
    let mut weight = 0.0;
    if NEGATIVE.iter().any(|word| names.contains(word)) {
        weight -= 25.0;
    }
    if POSITIVE.iter().any(|word| names.contains(word)) {
        weight += 25.0;
    }
    weight
}

fn text_len(element: ElementRef<'_>) -> usize {
    element.text().map(|text| text.trim().chars().count()).sum()
}

fn link_density(element: ElementRef<'_>) -> f64 {
    let total = text_len(element).max(1) as f64;
    let Ok(links) = Selector::parse("a") else {
        return 0.0;
    };
    let linked: usize = element.select(&links).map(text_len).sum();
    linked as f64 / total
}

/// A readability-style guess at a page's main text, sanitized; `None` when
/// nothing long enough stands out.
pub fn extract_main(html: &str, base: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let paragraphs = Selector::parse("p, pre, td, blockquote").ok()?;
    let mut scores: HashMap<ego_tree::NodeId, f64> = HashMap::new();
    for paragraph in document.select(&paragraphs) {
        let text: String = paragraph.text().collect();
        let length = text.trim().chars().count();
        if length < 25 {
            continue;
        }
        let commas = text.matches([',', '，', '。', '、']).count() as f64;
        let score = 1.0 + commas + (length as f64 / 100.0).min(3.0);
        let mut ancestors = paragraph.ancestors().filter_map(ElementRef::wrap);
        for share in [1.0, 0.5] {
            let Some(ancestor) = ancestors.next() else {
                break;
            };
            if matches!(ancestor.value().name(), "html" | "body") {
                break;
            }
            let entry = scores
                .entry(ancestor.id())
                .or_insert_with(|| class_weight(ancestor.value()));
            *entry += score * share;
        }
    }
    let best = scores
        .into_iter()
        .filter_map(|(id, score)| {
            let element = ElementRef::wrap(document.tree.get(id)?)?;
            Some((element, score * (1.0 - link_density(element))))
        })
        .max_by(|left, right| left.1.total_cmp(&right.1))?
        .0;
    if text_len(best) < FULL_TEXT_MIN_CHARS {
        return None;
    }
    Some(sanitize(&best.inner_html(), base))
}

// ---------------------------------------------------------------- HTML

/// Elements kept, with the attributes each may keep.
fn allowed(tag: &str) -> Option<&'static [&'static str]> {
    Some(match tag {
        "a" => &["href", "title"],
        "img" => &["src", "alt", "title", "width", "height"],
        "td" | "th" => &["colspan", "rowspan"],
        "ol" => &["start"],
        "abbr" | "acronym" => &["title"],
        "p" | "br" | "div" | "span" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "li"
        | "blockquote" | "pre" | "code" | "em" | "strong" | "b" | "i" | "u" | "s" | "del"
        | "ins" | "sub" | "sup" | "figure" | "figcaption" | "table" | "thead" | "tbody"
        | "tfoot" | "tr" | "caption" | "hr" | "dl" | "dt" | "dd" | "cite" | "q" | "small"
        | "mark" | "section" | "article" | "header" | "footer" | "aside" | "main" | "time"
        | "kbd" | "samp" | "var" | "details" | "summary" => &[],
        _ => return None,
    })
}

/// Elements dropped with everything inside them.
fn dropped(tag: &str) -> bool {
    matches!(
        tag,
        "script"
            | "style"
            | "iframe"
            | "object"
            | "embed"
            | "noscript"
            | "template"
            | "svg"
            | "math"
            | "form"
            | "input"
            | "button"
            | "select"
            | "textarea"
            | "head"
            | "title"
            | "meta"
            | "link"
            | "base"
            | "frame"
            | "frameset"
            | "canvas"
            | "audio"
            | "video"
            | "applet"
    )
}

const VOID: &[&str] = &["br", "img", "hr"];

pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn resolve(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() {
        return None;
    }
    let url = match Url::parse(base) {
        Ok(base) => base.join(href).ok()?,
        Err(_) => Url::parse(href).ok()?,
    };
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// The HTML with only harmless elements and attributes, links and images
/// made absolute, and nothing that runs.
pub fn sanitize(html: &str, base: &str) -> String {
    let fragment = Html::parse_fragment(html);
    let mut out = String::with_capacity(html.len());
    for child in fragment.root_element().children() {
        write_node(child, base, &mut out);
    }
    out.trim().to_string()
}

fn write_node(node: NodeRef<'_, Node>, base: &str, out: &mut String) {
    match node.value() {
        Node::Text(text) => out.push_str(&escape(text)),
        Node::Element(element) => {
            let tag = element.name();
            if dropped(tag) {
                return;
            }
            let Some(attributes) = allowed(tag) else {
                // Unknown wrappers keep their content.
                for child in node.children() {
                    write_node(child, base, out);
                }
                return;
            };
            let mut kept = String::new();
            for name in attributes {
                let value = match (tag, *name) {
                    // Lazy-loading pages keep the real address elsewhere.
                    ("img", "src") => element
                        .attr("data-src")
                        .or_else(|| element.attr("data-original"))
                        .or_else(|| element.attr("src"))
                        .and_then(|src| resolve(base, src)),
                    ("a", "href") => element.attr("href").and_then(|href| {
                        if href.trim_start().starts_with("mailto:") {
                            Some(href.trim().to_string())
                        } else {
                            resolve(base, href)
                        }
                    }),
                    (_, "width" | "height" | "colspan" | "rowspan" | "start") => element
                        .attr(name)
                        .filter(|value| value.chars().all(|c| c.is_ascii_digit()))
                        .map(str::to_string),
                    _ => element.attr(name).map(str::to_string),
                };
                if let Some(value) = value {
                    kept.push_str(&format!(" {name}=\"{}\"", escape(&value)));
                }
            }
            if tag == "img" && !kept.contains(" src=") {
                return;
            }
            out.push_str(&format!("<{tag}{kept}>"));
            if VOID.contains(&tag) {
                return;
            }
            for child in node.children() {
                write_node(child, base, out);
            }
            out.push_str(&format!("</{tag}>"));
        }
        _ => {}
    }
}

/// Text without markup, with whitespace collapsed.
pub fn plain_text(html: &str) -> String {
    if !html.contains('<') && !html.contains('&') {
        return html.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    let fragment = Html::parse_fragment(html);
    let mut text = String::new();
    for node in fragment.root_element().descendants() {
        match node.value() {
            Node::Text(part) => {
                let skipped = node.ancestors().any(|ancestor| {
                    ancestor
                        .value()
                        .as_element()
                        .is_some_and(|element| dropped(element.name()))
                });
                if !skipped {
                    text.push_str(part);
                    text.push(' ');
                }
            }
            Node::Element(element) if matches!(element.name(), "br" | "p" | "div" | "li") => {
                text.push(' ');
            }
            _ => {}
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn excerpt(text: &str, chars: usize) -> String {
    let mut short: String = text.chars().take(chars).collect();
    if text.chars().count() > chars {
        short.push('…');
    }
    short
}

fn first_image(html: &str) -> Option<String> {
    let at = html.find("<img ")?;
    let rest = &html[at..];
    let src = rest.find(" src=\"")? + 6;
    let end = rest[src..].find('"')?;
    Some(rest[src..src + end].replace("&amp;", "&"))
}

#[cfg(test)]
mod tests;
