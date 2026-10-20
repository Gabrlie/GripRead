//! 订阅账号 against a small Google Reader API service of its own.

use super::account::{api_base, item_id, sync, verify};
use super::*;
use crate::models::{
    ArticleFilter, ArticleQuery, FeedAccountKind, FeedFilter, FeedFilterField, FeedFilterMode,
    FeedFilterScope, SaveFeedAccountRequest,
};
use crate::sources::test_server::{start, Request, Response};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

struct Dir(std::path::PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn library() -> (Dir, Mutex<Storage>) {
    let dir = Dir(std::env::temp_dir().join(format!("gripread-account-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let storage = Storage::open(&dir.0).unwrap();
    (dir, Mutex::new(storage))
}

#[derive(Clone)]
struct Item {
    feed: u32,
    title: String,
    read: bool,
    starred: bool,
}

#[derive(Default)]
struct Service {
    /// Feed number → (title, label).
    feeds: BTreeMap<u32, (String, Option<String>)>,
    /// Item number (growing with time) → item.
    items: BTreeMap<u64, Item>,
    token: u32,
    /// Writes and content requests seen.
    edits: Vec<String>,
    fetched: Vec<u64>,
    failing_edits: bool,
}

fn form(request: &Request) -> Vec<(String, String)> {
    let text = if request.method == "POST" {
        String::from_utf8_lossy(&request.body).to_string()
    } else {
        request.query.clone()
    };
    url::form_urlencoded::parse(text.as_bytes())
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn values<'a>(pairs: &'a [(String, String)], name: &str) -> Vec<&'a str> {
    pairs
        .iter()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
        .collect()
}

fn number(id: &str) -> u64 {
    match id.strip_prefix("tag:google.com,2005:reader/item/") {
        Some(hex) => u64::from_str_radix(hex, 16).unwrap(),
        None => id.parse().unwrap(),
    }
}

fn serve(service: &Mutex<Service>, request: &Request) -> Response {
    let mut state = service.lock().unwrap();
    let pairs = form(request);
    let one = |name: &str| values(&pairs, name).first().map(|value| value.to_string());
    if request.path == "/accounts/ClientLogin" {
        if one("Email").as_deref() == Some("reader") && one("Passwd").as_deref() == Some("secret") {
            state.token += 1;
            return Response::html(&format!("SID=x\nLSID=null\nAuth=token{}\n", state.token));
        }
        return Response {
            status: 403,
            ..Response::html("Error=BadAuthentication")
        };
    }
    let signed = request.headers.get("authorization").map(String::as_str)
        == Some(&format!("GoogleLogin auth=token{}", state.token));
    if !signed || state.token == 0 {
        return Response {
            status: 401,
            ..Response::html("Unauthorized")
        };
    }
    let label = |label: &Option<String>| {
        label
            .iter()
            .map(|label| format!(r#"{{"id":"user/-/label/{label}","label":"{label}"}}"#))
            .collect::<Vec<_>>()
            .join(",")
    };
    match request.path.as_str() {
        "/reader/api/0/token" => Response::html("write-token\n"),
        "/reader/api/0/subscription/list" => {
            let feeds: Vec<String> = state
                .feeds
                .iter()
                .map(|(feed, (title, group))| {
                    format!(
                        r#"{{"id":"feed/{feed}","title":"{title}","categories":[{}],
                            "url":"https://site{feed}.example/feed","htmlUrl":"https://site{feed}.example/"}}"#,
                        label(group)
                    )
                })
                .collect();
            Response::json(&format!(r#"{{"subscriptions":[{}]}}"#, feeds.join(",")))
        }
        "/reader/api/0/stream/items/ids" => {
            let stream = one("s").unwrap();
            let exclude_read = one("xt").is_some();
            let since = one("ot").map(|ot| ot.parse::<u64>().unwrap() * 1_000_000);
            let n: usize = one("n").unwrap().parse().unwrap();
            let from: usize = one("c").map_or(0, |c| c.parse().unwrap());
            let ids: Vec<u64> = state
                .items
                .iter()
                .rev()
                .filter(|(_, item)| !(exclude_read && item.read))
                .filter(|(_, item)| !stream.ends_with("/starred") || item.starred)
                .filter(|(id, _)| since.is_none_or(|since| **id >= since))
                .map(|(id, _)| *id)
                .collect();
            let page: Vec<String> = ids
                .iter()
                .skip(from)
                .take(n)
                .map(|id| format!(r#"{{"id":"{id}"}}"#))
                .collect();
            let continuation = if from + n < ids.len() {
                format!(r#","continuation":"{}""#, from + n)
            } else {
                String::new()
            };
            Response::json(&format!(
                r#"{{"itemRefs":[{}]{continuation}}}"#,
                page.join(",")
            ))
        }
        "/reader/api/0/stream/items/contents" => {
            let mut items = Vec::new();
            for id in values(&pairs, "i") {
                let id = number(id);
                state.fetched.push(id);
                let Some(item) = state.items.get(&id) else {
                    continue;
                };
                let mut categories = vec![r#""user/-/state/com.google/reading-list""#.to_string()];
                if item.read {
                    categories.push(r#""user/-/state/com.google/read""#.into());
                }
                if item.starred {
                    categories.push(r#""user/-/state/com.google/starred""#.into());
                }
                items.push(format!(
                    r#"{{"id":"tag:google.com,2005:reader/item/{id:016x}","title":"{}",
                        "published":{},"canonical":[{{"href":"https://site{}.example/{id}"}}],
                        "summary":{{"content":"<p>{} 的正文<img src=\"/{id}.png\"></p>"}},
                        "author":"作者","categories":[{}],
                        "origin":{{"streamId":"feed/{}","title":"t"}}}}"#,
                    item.title,
                    id / 1_000_000,
                    item.feed,
                    item.title,
                    categories.join(","),
                    item.feed
                ));
            }
            Response::json(&format!(r#"{{"items":[{}]}}"#, items.join(",")))
        }
        "/reader/api/0/edit-tag" => {
            assert_eq!(one("T").as_deref(), Some("write-token"));
            if state.failing_edits {
                return Response {
                    status: 500,
                    ..Response::html("busy")
                };
            }
            let (tag, add) = match (one("a"), one("r")) {
                (Some(tag), _) => (tag, true),
                (_, Some(tag)) => (tag, false),
                _ => panic!("edit-tag without a tag"),
            };
            for id in values(&pairs, "i") {
                let id = number(id);
                state.edits.push(format!(
                    "{}{} {id}",
                    if add { "+" } else { "-" },
                    tag.rsplit('/').next().unwrap()
                ));
                let item = state.items.get_mut(&id).unwrap();
                if tag.ends_with("/read") {
                    item.read = add;
                } else {
                    item.starred = add;
                }
            }
            Response::html("OK")
        }
        "/reader/api/0/subscription/quickadd" => {
            let address = one("quickadd").unwrap();
            let feed = state.feeds.keys().max().unwrap() + 1;
            state.feeds.insert(feed, (address.clone(), None));
            state.edits.push(format!("quickadd {address}"));
            Response::json(&format!(
                r#"{{"numResults":1,"query":"{address}","streamId":"feed/{feed}"}}"#
            ))
        }
        "/reader/api/0/subscription/edit" => {
            let feed: u32 = one("s").unwrap()["feed/".len()..].parse().unwrap();
            match one("ac").as_deref() {
                Some("unsubscribe") => {
                    state.feeds.remove(&feed);
                }
                _ => {
                    let entry = state.feeds.get_mut(&feed).unwrap();
                    if let Some(title) = one("t") {
                        entry.0 = title;
                    }
                    if one("r").is_some() {
                        entry.1 = None;
                    }
                    if let Some(label) = one("a") {
                        entry.1 = Some(label["user/-/label/".len()..].to_string());
                    }
                }
            }
            state.edits.push(format!("edit {}", one("ac").unwrap()));
            Response::html("OK")
        }
        _ => Response::not_found(),
    }
}

/// An item number crawled `minutes` ago (microseconds, as FreshRSS's).
fn crawled(minutes: i64) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64;
    (now - minutes * 60_000_000) as u64
}

fn account_request(server: &str, password: Option<&str>) -> SaveFeedAccountRequest {
    SaveFeedAccountRequest {
        id: None,
        kind: FeedAccountKind::GoogleReader,
        name: "我的 Reader".into(),
        server: server.into(),
        username: "reader".into(),
        password: password.map(str::to_string),
        filter_read: true,
    }
}

fn query(account: Option<&str>, group: Option<&str>, filter: ArticleFilter) -> ArticleQuery {
    ArticleQuery {
        account: account.map(str::to_string),
        group: group.map(str::to_string),
        filter,
        limit: Some(200),
        ..ArticleQuery::default()
    }
}

#[test]
fn ids_and_addresses_take_each_services_form() {
    assert_eq!(
        item_id("1792511947320453"),
        "tag:google.com,2005:reader/item/00065e47b5e02c85"
    );
    assert_eq!(
        item_id("tag:google.com,2005:reader/item/00065e47b5e02c85"),
        "tag:google.com,2005:reader/item/00065e47b5e02c85"
    );
    assert_eq!(
        item_id("-1"),
        "tag:google.com,2005:reader/item/ffffffffffffffff"
    );
    assert_eq!(
        api_base(FeedAccountKind::FreshRss, "rss.example/").unwrap(),
        "https://rss.example/api/greader.php"
    );
    assert_eq!(
        api_base(FeedAccountKind::FreshRss, "https://rss.example/i/").unwrap(),
        "https://rss.example/api/greader.php"
    );
    assert_eq!(
        api_base(
            FeedAccountKind::FreshRss,
            "https://rss.example/api/greader.php"
        )
        .unwrap(),
        "https://rss.example/api/greader.php"
    );
    assert_eq!(
        api_base(FeedAccountKind::Miniflux, "https://flux.example").unwrap(),
        "https://flux.example"
    );
    assert!(api_base(FeedAccountKind::Miniflux, "ftp://flux.example").is_err());
}

#[test]
fn accounts_sync_both_ways_and_keep_to_themselves() {
    let service = Arc::new(Mutex::new(Service::default()));
    {
        let mut state = service.lock().unwrap();
        state.feeds.insert(1, ("甲".into(), Some("科技".into())));
        state.feeds.insert(2, ("乙".into(), None));
        for n in 1..=30u64 {
            state.items.insert(
                crawled(600 - n as i64),
                Item {
                    feed: if n <= 20 { 1 } else { 2 },
                    title: format!("第 {n} 篇"),
                    read: n <= 10,
                    starred: n == 3,
                },
            );
        }
    }
    let served = service.clone();
    let base = start(move |request: &Request| serve(&served, request));
    let (_dir, storage) = library();

    // The password is checked when the account is saved.
    let wrong = verify(&account_request(&base, Some("nope")), None).unwrap_err();
    assert_eq!(wrong.key.as_deref(), Some("rssAccountLogin"));
    let login = verify(&account_request(&base, Some("secret")), None).unwrap();
    let id = {
        let guard = lock(&storage).unwrap();
        guard
            .save_feed_account(&account_request(&base, None), &login)
            .unwrap()
    };
    assert_eq!(id, crate::storage::account_id(&base, "reader"));

    // A feed of the device's own, in a group named as an account's label.
    lock(&storage)
        .unwrap()
        .add_feed("https://own.example/feed", "自己的", Some("科技"), None)
        .unwrap();

    assert_eq!(sync(&storage, &id).unwrap(), 30);
    {
        let guard = lock(&storage).unwrap();
        let feeds = guard.list_feeds().unwrap();
        let account_feeds: Vec<_> = feeds
            .iter()
            .filter(|feed| feed.account.as_deref() == Some(id.as_str()))
            .collect();
        assert_eq!(account_feeds.len(), 2);
        assert_eq!(account_feeds[0].title, "甲");
        assert_eq!(account_feeds[0].group.as_deref(), Some("科技"));
        assert_eq!(
            account_feeds[0].address.as_deref(),
            Some("https://site1.example/feed")
        );
        assert_eq!(account_feeds[0].unread, 10);
        assert_eq!(account_feeds[1].unread, 10);
        // 分组管理 and a group's list are the device's own.
        let groups: Vec<_> = guard
            .feed_groups()
            .unwrap()
            .into_iter()
            .map(|group| group.name)
            .collect();
        assert_eq!(groups, ["科技"]);
        let own = guard
            .list_articles(&query(None, Some("科技"), ArticleFilter::All))
            .unwrap();
        assert!(own.articles.is_empty());
        let labelled = guard
            .list_articles(&query(Some(&id), Some("科技"), ArticleFilter::All))
            .unwrap();
        assert_eq!(labelled.articles.len(), 20);
        let unread = guard
            .list_articles(&query(Some(&id), None, ArticleFilter::Unread))
            .unwrap();
        assert_eq!(unread.articles.len(), 20);
        let starred = guard
            .list_articles(&query(Some(&id), None, ArticleFilter::Starred))
            .unwrap();
        assert_eq!(starred.articles[0].title, "第 3 篇");
        assert!(starred.articles[0]
            .image
            .as_deref()
            .is_some_and(|image| image.starts_with("https://site1.example/")));
        // Nothing of the account syncs or goes into backups.
        assert!(guard
            .portable_feeds()
            .unwrap()
            .iter()
            .all(|feed| feed.url == "https://own.example/feed"));
        assert!(guard.portable_stars().unwrap().is_empty());
        assert_eq!(
            export_opml(&guard)
                .unwrap()
                .matches("<outline type=\"rss\"")
                .count(),
            1
        );
    }

    // Marks made here wait, then are written to the account.
    let article = |title: &str| {
        lock(&storage)
            .unwrap()
            .list_articles(&ArticleQuery {
                search: Some(title.into()),
                ..query(Some(&id), None, ArticleFilter::All)
            })
            .unwrap()
            .articles
            .into_iter()
            .find(|article| article.title == title)
            .unwrap()
    };
    let fifteen = article("第 15 篇");
    let sixteen = article("第 16 篇");
    {
        let mut guard = lock(&storage).unwrap();
        guard
            .set_article_state(std::slice::from_ref(&fifteen.id), Some(true), None, None)
            .unwrap();
        guard
            .set_article_state(std::slice::from_ref(&sixteen.id), None, Some(true), None)
            .unwrap();
        assert_eq!(guard.feed_account(&id).unwrap().pending, 2);
    }
    // Offline (or refused), they keep waiting.
    service.lock().unwrap().failing_edits = true;
    let failed = sync(&storage, &id).unwrap_err();
    assert_eq!(failed.key.as_deref(), Some("rssAccountHttp"));
    let account = lock(&storage).unwrap().feed_account(&id).unwrap();
    assert_eq!(account.pending, 2);
    assert!(account.last_error.is_some());
    service.lock().unwrap().failing_edits = false;

    // Meanwhile, the account changes: one read elsewhere, one unstarred,
    // one new, and one a rule keeps out.
    lock(&storage)
        .unwrap()
        .save_feed_filter(
            &FeedFilter {
                scope: FeedFilterScope::All,
                field: FeedFilterField::Title,
                mode: FeedFilterMode::Drop,
                pattern: "广告".into(),
                ignore_case: true,
                enabled: true,
                ..FeedFilter::default()
            },
            false,
        )
        .unwrap();
    let advert = crawled(1);
    {
        let mut state = service.lock().unwrap();
        let twenty = *state
            .items
            .iter()
            .find(|(_, item)| item.title == "第 20 篇")
            .unwrap()
            .0;
        state.items.get_mut(&twenty).unwrap().read = true;
        for item in state.items.values_mut() {
            item.starred = false;
        }
        state.items.insert(
            crawled(2),
            Item {
                feed: 2,
                title: "第 31 篇".into(),
                read: false,
                starred: false,
            },
        );
        state.items.insert(
            advert,
            Item {
                feed: 2,
                title: "广告一则".into(),
                read: false,
                starred: false,
            },
        );
        state.edits.clear();
        state.fetched.clear();
    }
    // The sign-in token has run out: it is renewed with the password.
    service.lock().unwrap().token += 1;
    assert_eq!(sync(&storage, &id).unwrap(), 1);
    {
        let state = service.lock().unwrap();
        let fifteen_on_account = state
            .items
            .values()
            .find(|item| item.title == "第 15 篇")
            .unwrap();
        assert!(fifteen_on_account.read);
        // The mark made here wins over the account's unstarring.
        assert!(
            state
                .items
                .values()
                .find(|item| item.title == "第 16 篇")
                .unwrap()
                .starred
        );
        // Kept out by the rule, and marked read on the account.
        assert!(state.items[&advert].read);
        assert!(state.edits.contains(&format!("+read {advert}")));
        // Only what was missing was fetched.
        let fetched: BTreeSet<u64> = state.fetched.iter().copied().collect();
        assert_eq!(fetched.len(), 2);
    }
    assert!(article("第 20 篇").read);
    assert!(!article("第 3 篇").starred);
    assert!(article("第 16 篇").starred);
    {
        let guard = lock(&storage).unwrap();
        assert_eq!(guard.feed_account(&id).unwrap().pending, 0);
        assert!(guard.feed_account(&id).unwrap().last_error.is_none());
        let all = guard
            .list_articles(&query(Some(&id), None, ArticleFilter::All))
            .unwrap();
        assert_eq!(all.articles.len(), 31);
        assert!(all
            .articles
            .iter()
            .all(|article| article.title != "广告一则"));
    }
    // A rule's article is not fetched again.
    service.lock().unwrap().fetched.clear();
    assert_eq!(sync(&storage, &id).unwrap(), 0);
    assert!(service.lock().unwrap().fetched.is_empty());

    // 全部标为已读 on the account's group goes to the account too.
    lock(&storage)
        .unwrap()
        .mark_all_read(None, Some("科技"), Some(&id))
        .unwrap();
    sync(&storage, &id).unwrap();
    assert!(service
        .lock()
        .unwrap()
        .items
        .values()
        .filter(|item| item.feed == 1)
        .all(|item| item.read));
    assert_eq!(
        lock(&storage)
            .unwrap()
            .list_articles(&query(None, Some("科技"), ArticleFilter::All))
            .unwrap()
            .articles
            .len(),
        0
    );
}

#[test]
fn account_feeds_are_subscribed_changed_and_removed_on_the_account() {
    let service = Arc::new(Mutex::new(Service::default()));
    {
        let mut state = service.lock().unwrap();
        state.feeds.insert(1, ("甲".into(), None));
        state.items.insert(
            crawled(5),
            Item {
                feed: 1,
                title: "一篇".into(),
                read: false,
                starred: true,
            },
        );
    }
    let served = service.clone();
    let base = start(move |request: &Request| serve(&served, request));
    let (_dir, storage) = library();
    let login = verify(&account_request(&base, Some("secret")), None).unwrap();
    let id = lock(&storage)
        .unwrap()
        .save_feed_account(&account_request(&base, None), &login)
        .unwrap();
    sync(&storage, &id).unwrap();

    let url = account::subscribe(
        &storage,
        &id,
        "https://new.example/feed",
        Some("新的"),
        Some("阅读"),
    )
    .unwrap();
    assert_eq!(url, crate::storage::account_feed_url(&id, "feed/2"));
    let feed = lock(&storage).unwrap().feed(&url).unwrap();
    assert_eq!(
        (feed.title.as_str(), feed.group.as_deref()),
        ("新的", Some("阅读"))
    );

    account::edit_feed(&storage, &url, "改名", None).unwrap();
    assert_eq!(
        service.lock().unwrap().feeds[&2],
        ("改名".to_string(), None)
    );
    account::unsubscribe(&storage, &url).unwrap();
    assert!(!service.lock().unwrap().feeds.contains_key(&2));

    // Unsubscribed elsewhere, a feed goes; its starred article stays while
    // the account keeps it starred.
    service.lock().unwrap().feeds.remove(&1);
    sync(&storage, &id).unwrap();
    {
        let guard = lock(&storage).unwrap();
        assert!(guard.list_feeds().unwrap().is_empty());
        let starred = guard
            .list_articles(&query(None, None, ArticleFilter::Starred))
            .unwrap();
        assert_eq!(starred.articles.len(), 1);
    }

    // Removing the account leaves nothing of it here.
    lock(&storage).unwrap().remove_feed_account(&id).unwrap();
    let guard = lock(&storage).unwrap();
    assert!(guard.feed_accounts().unwrap().is_empty());
    assert!(guard
        .list_articles(&query(None, None, ArticleFilter::Starred))
        .unwrap()
        .articles
        .is_empty());
}
