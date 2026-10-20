//! 订阅账号 over the Google Reader API (FreshRSS, Miniflux, and others
//! that speak it). A sync writes the marks made here first, then takes the
//! account's feeds, the items crawled since the last sync, and the ids of
//! its unread and starred items: those this device lacks are fetched (the
//! newest first, a limited number each time), and the account's marks
//! replace the device's. Feeds are subscribed, renamed, moved, and
//! unsubscribed on the account at once.

use std::cmp::Reverse;
use std::collections::HashSet;
use std::sync::Mutex;

use serde_json::Value;
use url::Url;

use super::{excerpt, first_image, lock, network, plain_text, sanitize, EXCERPT_CHARS, TIMEOUT};
use crate::error::{AppError, ErrorCode};
use crate::models::{FeedAccountKind, SaveFeedAccountRequest};
use crate::storage::{
    account_feed_url, account_id, AccountFeed, AccountItem, AccountLogin, FetchedArticle,
    PendingMark, Storage,
};

const READING_LIST: &str = "user/-/state/com.google/reading-list";
const READ: &str = "user/-/state/com.google/read";
const STARRED: &str = "user/-/state/com.google/starred";
const LABEL: &str = "user/-/label/";
const ITEM_PREFIX: &str = "tag:google.com,2005:reader/item/";
/// Items a first sync takes beyond the unread and starred ones.
const FIRST_ITEMS: usize = 200;
/// Items crawled since the last sync looked at, at most.
const NEW_ITEMS: usize = 2000;
/// Items fetched in one sync, at most; the rest come with the next.
const MISSING_ITEMS: usize = 1000;
/// Unread or starred ids listed, at most.
const LISTED_IDS: usize = 50_000;
const ID_PAGE: usize = 10_000;
const CONTENT_PAGE: usize = 200;
const EDIT_PAGE: usize = 100;
/// The last sync's time is looked at again (seconds), for items crawled
/// while it ran.
const OVERLAP: i64 = 600;
const RESPONSE_LIMIT: u64 = 64 * 1024 * 1024;

fn account_error(key: &'static str, message: impl Into<String>) -> AppError {
    AppError::keyed(ErrorCode::InvalidArgument, key, message.into())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// The API address of a service: FreshRSS's is under `api/greader.php`,
/// the others' where they are given.
pub fn api_base(kind: FeedAccountKind, server: &str) -> Result<String, AppError> {
    let server = server.trim().trim_end_matches('/');
    if server.is_empty() {
        return Err(account_error("rssAccountServerEmpty", "请填写服务器地址"));
    }
    let server = if server.contains("://") {
        server.to_string()
    } else {
        format!("https://{server}")
    };
    let url = Url::parse(&server)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .ok_or_else(|| account_error("rssAccountServerInvalid", "服务器地址无效"))?;
    let server = url.as_str().trim_end_matches('/').to_string();
    Ok(match kind {
        FeedAccountKind::FreshRss if !server.ends_with("/greader.php") => {
            let root = server.strip_suffix("/i").unwrap_or(&server);
            match root.strip_suffix("/api") {
                Some(root) => format!("{root}/api/greader.php"),
                None => format!("{root}/api/greader.php"),
            }
        }
        _ => server,
    })
}

/// An item id in its long form, which every service takes; the short
/// (decimal) form lists give is turned into it.
pub fn item_id(id: &str) -> String {
    let id = id.trim();
    let number = match id.strip_prefix(ITEM_PREFIX) {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => id
            .parse::<u64>()
            .ok()
            .or_else(|| id.parse::<i64>().ok().map(|signed| signed as u64)),
    };
    match number {
        Some(number) => format!("{ITEM_PREFIX}{number:016x}"),
        None => id.to_string(),
    }
}

/// Item ids grow with time on these services: the newest is the largest.
fn item_number(id: &str) -> u64 {
    id.strip_prefix(ITEM_PREFIX)
        .and_then(|hex| u64::from_str_radix(hex, 16).ok())
        .unwrap_or(0)
}

fn label_of(id: &str) -> Option<&str> {
    let (_, label) = id.split_once("/label/")?;
    let label = label.trim();
    (!label.is_empty()).then_some(label)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// The feeds of a `subscription/list` answer.
pub fn parse_subscriptions(body: &Value) -> Vec<AccountFeed> {
    body.get("subscriptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|feed| {
            let stream = text(feed, "id")?;
            let group = feed
                .get("categories")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find_map(|category| {
                    text(category, "label").or_else(|| {
                        text(category, "id").and_then(|id| label_of(&id).map(str::to_string))
                    })
                });
            Some(AccountFeed {
                title: text(feed, "title").unwrap_or_else(|| stream.clone()),
                address: text(feed, "url"),
                site_url: text(feed, "htmlUrl"),
                icon_url: text(feed, "iconUrl"),
                group,
                stream,
            })
        })
        .collect()
}

/// The items of a `stream/items/contents` answer.
pub fn parse_items(body: &Value) -> Vec<AccountItem> {
    body.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let remote_id = item_id(&text(item, "id")?);
            let origin = item.get("origin");
            let stream = origin.and_then(|origin| text(origin, "streamId"))?;
            let href = |key: &str| {
                item.get(key)
                    .and_then(Value::as_array)
                    .and_then(|links| links.first())
                    .and_then(|link| text(link, "href"))
            };
            let link = href("canonical").or_else(|| href("alternate"));
            let html = ["content", "summary"]
                .into_iter()
                .find_map(|key| item.get(key).and_then(|part| text(part, "content")))
                .unwrap_or_default();
            let base = link
                .clone()
                .or_else(|| origin.and_then(|origin| text(origin, "htmlUrl")))
                .unwrap_or_default();
            let content = sanitize(&html, &base);
            let body = plain_text(&html);
            let title = text(item, "title")
                .map(|title| plain_text(&title))
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| excerpt(&body, 40));
            let seconds = |key: &str| {
                item.get(key).and_then(|value| {
                    value
                        .as_i64()
                        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                })
            };
            let published_at = seconds("published")
                .map(|seconds| seconds * 1000)
                .or_else(|| seconds("crawlTimeMsec"))
                .or_else(|| seconds("updated").map(|seconds| seconds * 1000))
                .unwrap_or(0);
            let categories: Vec<&str> = item
                .get("categories")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let has = |state: &str| categories.iter().any(|category| category.ends_with(state));
            Some(AccountItem {
                article: FetchedArticle {
                    id: String::new(),
                    title,
                    link,
                    author: text(item, "author"),
                    published_at,
                    excerpt: excerpt(&body, EXCERPT_CHARS),
                    image: first_image(&content),
                    content,
                },
                read: has("/state/com.google/read"),
                starred: has("/state/com.google/starred"),
                remote_id,
                stream,
            })
        })
        .collect()
}

/// Which marks one edit writes.
type Wanted = fn(&PendingMark) -> bool;

enum Method {
    Get,
    Post,
}

/// A signed-in conversation with a service. A refused sign-in token is
/// renewed once with the password.
struct Client {
    base: String,
    username: String,
    password: String,
    auth: Option<String>,
    write: Option<String>,
    renewed: bool,
}

impl Client {
    fn new(login: &AccountLogin) -> Result<Self, AppError> {
        Ok(Self {
            base: api_base(login.kind, &login.server)?,
            username: login.username.clone(),
            password: login.password.clone(),
            auth: login.token.clone(),
            write: None,
            renewed: false,
        })
    }

    fn send(
        &self,
        method: &Method,
        path: &str,
        query: &[(&str, String)],
        form: &[(&str, String)],
        auth: bool,
    ) -> Result<(u16, String), AppError> {
        let mut url = Url::parse(&format!("{}/{path}", self.base)).map_err(network)?;
        url.query_pairs_mut()
            .extend_pairs(query.iter().map(|(name, value)| (*name, value.as_str())));
        let agent = crate::sources::network::agent();
        let authorization = self
            .auth
            .as_ref()
            .filter(|_| auth)
            .map(|token| format!("GoogleLogin auth={token}"));
        let result = match method {
            Method::Get => {
                let mut request = agent
                    .get(url.as_str())
                    .config()
                    .timeout_global(Some(TIMEOUT))
                    .http_status_as_error(false)
                    .build()
                    .header("User-Agent", "GripRead");
                if let Some(authorization) = &authorization {
                    request = request.header("Authorization", authorization.as_str());
                }
                request.call()
            }
            Method::Post => {
                let mut request = agent
                    .post(url.as_str())
                    .config()
                    .timeout_global(Some(TIMEOUT))
                    .http_status_as_error(false)
                    .build()
                    .header("User-Agent", "GripRead");
                if let Some(authorization) = &authorization {
                    request = request.header("Authorization", authorization.as_str());
                }
                request.send_form(form.iter().map(|(name, value)| (*name, value.as_str())))
            }
        };
        let mut response = result.map_err(network)?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(RESPONSE_LIMIT)
            .read_to_string()
            .map_err(network)?;
        Ok((status, body))
    }

    fn login(&mut self) -> Result<(), AppError> {
        let (status, body) = self.send(
            &Method::Post,
            "accounts/ClientLogin",
            &[],
            &[
                ("Email", self.username.clone()),
                ("Passwd", self.password.clone()),
            ],
            false,
        )?;
        if matches!(status, 401 | 403) {
            return Err(account_error(
                "rssAccountLogin",
                "用户名或密码不对（FreshRSS 和 Miniflux 用的是 API 密码）",
            ));
        }
        if !(200..300).contains(&status) {
            return Err(http(status));
        }
        let token = body
            .lines()
            .find_map(|line| line.trim().strip_prefix("Auth="))
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                account_error("rssAccountNotReader", "这个地址不是 Google Reader API 服务")
            })?;
        self.auth = Some(token.to_string());
        self.write = None;
        self.renewed = true;
        Ok(())
    }

    /// A request, signed in; a token refused is renewed once.
    fn call(
        &mut self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        form: &[(&str, String)],
    ) -> Result<String, AppError> {
        if self.auth.is_none() {
            self.login()?;
        }
        let mut retried = false;
        loop {
            let mut form = form.to_vec();
            let mut status = 0;
            let mut body = String::new();
            if matches!(method, Method::Post) {
                match self.write_token()? {
                    Some(token) => form.push(("T", token)),
                    None => status = 401,
                }
            }
            if status == 0 {
                (status, body) = self.send(&method, path, query, &form, true)?;
            }
            if status == 401 && !retried {
                retried = true;
                self.login()?;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(http(status));
            }
            return Ok(body);
        }
    }

    fn json(&mut self, path: &str, query: &[(&str, String)]) -> Result<Value, AppError> {
        let mut query = query.to_vec();
        query.push(("output", "json".into()));
        let body = self.call(Method::Get, path, &query, &[])?;
        serde_json::from_str(&body).map_err(|_| {
            account_error("rssAccountNotReader", "这个地址不是 Google Reader API 服务")
        })
    }

    /// The token writes carry; `None` when the sign-in was refused.
    fn write_token(&mut self) -> Result<Option<String>, AppError> {
        if let Some(token) = &self.write {
            return Ok(Some(token.clone()));
        }
        let (status, body) = self.send(&Method::Get, "reader/api/0/token", &[], &[], true)?;
        if status == 401 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(http(status));
        }
        let token = body.trim().to_string();
        self.write = Some(token.clone());
        Ok(Some(token))
    }

    fn post(&mut self, path: &str, form: &[(&str, String)]) -> Result<String, AppError> {
        self.call(Method::Post, path, &[], form)
    }

    fn subscriptions(&mut self) -> Result<Vec<AccountFeed>, AppError> {
        Ok(parse_subscriptions(
            &self.json("reader/api/0/subscription/list", &[])?,
        ))
    }

    /// Ids of a stream's items, newest first: at most `most`, and whether
    /// that is all of them.
    fn ids(
        &mut self,
        stream: &str,
        exclude: Option<&str>,
        since: Option<i64>,
        most: usize,
    ) -> Result<(Vec<String>, bool), AppError> {
        let mut ids = Vec::new();
        let mut continuation: Option<String> = None;
        loop {
            let mut query = vec![
                ("s", stream.to_string()),
                ("n", (most - ids.len()).min(ID_PAGE).to_string()),
            ];
            if let Some(exclude) = exclude {
                query.push(("xt", exclude.to_string()));
            }
            if let Some(since) = since {
                query.push(("ot", since.to_string()));
            }
            if let Some(continuation) = &continuation {
                query.push(("c", continuation.clone()));
            }
            let body = self.json("reader/api/0/stream/items/ids", &query)?;
            let before = ids.len();
            ids.extend(
                body.get("itemRefs")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|item| text(item, "id"))
                    .map(|id| item_id(&id)),
            );
            continuation = text(&body, "continuation");
            if continuation.is_none() || ids.len() == before {
                return Ok((ids, true));
            }
            if ids.len() >= most {
                return Ok((ids, false));
            }
        }
    }

    fn contents(&mut self, ids: &[String]) -> Result<Vec<AccountItem>, AppError> {
        let mut items = Vec::new();
        for page in ids.chunks(CONTENT_PAGE) {
            let form: Vec<(&str, String)> = page.iter().map(|id| ("i", id.clone())).collect();
            let body = self.call(
                Method::Post,
                "reader/api/0/stream/items/contents",
                &[("output", "json".into())],
                &form,
            )?;
            let body: Value = serde_json::from_str(&body).map_err(|_| {
                account_error("rssAccountNotReader", "这个地址不是 Google Reader API 服务")
            })?;
            items.extend(parse_items(&body));
        }
        Ok(items)
    }

    /// Writes the marks made here.
    fn flush(&mut self, storage: &Mutex<Storage>, account: &str) -> Result<(), AppError> {
        let marks = lock(storage)?.pending_marks(account)?;
        if marks.is_empty() {
            return Ok(());
        }
        let groups: [(&str, &str, Wanted); 4] = [
            ("a", READ, |mark| mark.read == Some(true)),
            ("r", READ, |mark| mark.read == Some(false)),
            ("a", STARRED, |mark| mark.starred == Some(true)),
            ("r", STARRED, |mark| mark.starred == Some(false)),
        ];
        for (action, tag, wanted) in groups {
            let ids: Vec<&str> = marks
                .iter()
                .filter(|mark| wanted(mark))
                .map(|mark| mark.remote_id.as_str())
                .collect();
            for page in ids.chunks(EDIT_PAGE) {
                let mut form: Vec<(&str, String)> =
                    page.iter().map(|id| ("i", id.to_string())).collect();
                form.push((action, tag.to_string()));
                self.post("reader/api/0/edit-tag", &form)?;
            }
        }
        lock(storage)?.clear_pending_marks(&marks)
    }
}

fn http(status: u16) -> AppError {
    AppError::keyed(
        ErrorCode::Io,
        "rssAccountHttp",
        format!("订阅账号返回 HTTP {status}"),
    )
    .with("status", status)
}

/// Runs `work` signed in to an account, keeping a renewed token.
fn with_client<T>(
    storage: &Mutex<Storage>,
    account: &str,
    work: impl FnOnce(&mut Client, &AccountLogin) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let login = lock(storage)?.account_login(account)?;
    let mut client = Client::new(&login)?;
    let result = work(&mut client, &login);
    if client.renewed {
        lock(storage)?.set_account_token(account, client.auth.as_deref())?;
    }
    result
}

/// Signs in with what an account is to be saved with (the password it
/// has when none is given) and answers what to keep.
pub fn verify(
    request: &SaveFeedAccountRequest,
    existing: Option<AccountLogin>,
) -> Result<AccountLogin, AppError> {
    let username = request.username.trim();
    if username.is_empty() {
        return Err(account_error("rssAccountUserEmpty", "请填写用户名"));
    }
    let server = api_base(request.kind, &request.server)?;
    let password = match (&request.password, &existing) {
        (Some(password), _) if !password.is_empty() => password.clone(),
        (_, Some(existing)) => existing.password.clone(),
        _ => return Err(account_error("rssAccountPasswordEmpty", "请填写密码")),
    };
    let mut login = AccountLogin {
        id: account_id(&server, username),
        kind: request.kind,
        name: request.name.trim().to_string(),
        server,
        username: username.to_string(),
        password,
        token: None,
        since: existing.as_ref().and_then(|existing| existing.since),
        filter_read: request.filter_read,
    };
    let mut client = Client::new(&login)?;
    client.login()?;
    // Signed in is not enough: the API must answer too.
    client.json("reader/api/0/subscription/list", &[])?;
    login.token = client.auth;
    Ok(login)
}

/// Syncs an account; answers how many articles are new.
pub fn sync(storage: &Mutex<Storage>, account: &str) -> Result<u32, AppError> {
    let result = with_client(storage, account, |client, login| {
        run_sync(storage, client, login)
    });
    let name = lock(storage)?
        .feed_account(account)
        .map(|account| account.name)
        .unwrap_or_default();
    match &result {
        Ok(_) => {}
        Err(error) => {
            lock(storage)?.record_account_sync(account, None, Some(&error.message))?;
            crate::log_keyed!(
                Warn,
                "rss",
                "rssAccountFailed",
                format!("订阅账号 {name} 同步失败：{}", error.message),
                @error error,
                name = name,
            );
        }
    }
    result
}

fn run_sync(
    storage: &Mutex<Storage>,
    client: &mut Client,
    login: &AccountLogin,
) -> Result<u32, AppError> {
    let started = now_secs();
    client.flush(storage, &login.id)?;
    let feeds = client.subscriptions()?;
    lock(storage)?.store_account_feeds(&login.id, &feeds)?;
    let (fresh, _) = match login.since {
        None => client.ids(READING_LIST, None, None, FIRST_ITEMS)?,
        Some(since) => client.ids(READING_LIST, None, Some(since), NEW_ITEMS)?,
    };
    let (unread, unread_complete) = client.ids(READING_LIST, Some(READ), None, LISTED_IDS)?;
    let (starred, starred_complete) = client.ids(STARRED, None, None, LISTED_IDS)?;
    let mut wanted: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for id in fresh.iter().chain(&unread).chain(&starred) {
        if seen.insert(id.as_str()) {
            wanted.push(id.clone());
        }
    }
    let mut missing = lock(storage)?.unknown_account_items(&login.id, &wanted)?;
    missing.sort_by_key(|id| Reverse(item_number(id)));
    missing.truncate(MISSING_ITEMS);
    let items = client.contents(&missing)?;
    let stored = {
        let mut guard = lock(storage)?;
        let stored = guard.store_account_items(&login.id, &items, login.filter_read)?;
        guard.reconcile_account(
            &login.id,
            &unread.into_iter().collect(),
            unread_complete,
            &starred.into_iter().collect(),
            starred_complete,
        )?;
        stored
    };
    // Articles kept out, marked read on the account.
    client.flush(storage, &login.id)?;
    lock(storage)?.record_account_sync(&login.id, Some(started - OVERLAP), None)?;
    Ok(stored.added)
}

/// Subscribes to a feed on an account, filed under `group`, and syncs;
/// answers the feed's `url` here.
pub fn subscribe(
    storage: &Mutex<Storage>,
    account: &str,
    address: &str,
    title: Option<&str>,
    group: Option<&str>,
) -> Result<String, AppError> {
    let address = super::normalize_url(address)?;
    let stream = with_client(storage, account, |client, _| {
        let body = client.post(
            "reader/api/0/subscription/quickadd",
            &[("quickadd", address.clone())],
        )?;
        let answer: Value = serde_json::from_str(&body).unwrap_or_default();
        let stream = text(&answer, "streamId").ok_or_else(|| {
            let detail = text(&answer, "error").unwrap_or_default();
            account_error(
                "rssAccountSubscribeFailed",
                format!("订阅账号没能订阅：{detail}"),
            )
            .with("error", detail)
        })?;
        let mut form = vec![("ac", "edit".to_string()), ("s", stream.clone())];
        if let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) {
            form.push(("t", title.to_string()));
        }
        if let Some(group) = group.map(str::trim).filter(|group| !group.is_empty()) {
            form.push(("a", format!("{LABEL}{group}")));
        }
        if form.len() > 2 {
            client.post("reader/api/0/subscription/edit", &form)?;
        }
        Ok(stream)
    })?;
    sync(storage, account)?;
    Ok(account_feed_url(account, &stream))
}

/// Renames a feed on its account or files it under another group.
pub fn edit_feed(
    storage: &Mutex<Storage>,
    url: &str,
    title: &str,
    group: Option<&str>,
) -> Result<(), AppError> {
    let Some((account, stream)) = lock(storage)?.account_feed(url)? else {
        return Ok(());
    };
    let feed = lock(storage)?.feed(url)?;
    let group = group.map(str::trim).filter(|group| !group.is_empty());
    let title = title.trim();
    if feed.title == title && feed.group.as_deref() == group {
        return Ok(());
    }
    with_client(storage, &account, |client, _| {
        let mut form = vec![
            ("ac", "edit".to_string()),
            ("s", stream.clone()),
            ("t", title.to_string()),
        ];
        if feed.group.as_deref() != group {
            if let Some(old) = &feed.group {
                form.push(("r", format!("{LABEL}{old}")));
            }
            if let Some(group) = group {
                form.push(("a", format!("{LABEL}{group}")));
            }
        }
        client.post("reader/api/0/subscription/edit", &form)?;
        Ok(())
    })
}

/// Unsubscribes from a feed on its account.
pub fn unsubscribe(storage: &Mutex<Storage>, url: &str) -> Result<(), AppError> {
    let Some((account, stream)) = lock(storage)?.account_feed(url)? else {
        return Ok(());
    };
    with_client(storage, &account, |client, _| {
        client.post(
            "reader/api/0/subscription/edit",
            &[("ac", "unsubscribe".into()), ("s", stream.clone())],
        )?;
        Ok(())
    })
}
