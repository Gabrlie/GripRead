//! 订阅 on the server: feeds refreshed on a schedule (each feed's own
//! interval, or `jobs.json`'s `rssIntervalMinutes`) and on request, their
//! articles handed to connected devices, which then need not reach every
//! feed themselves, and 全文 read for devices that cannot reach a page.

use super::*;
use gripread_core::sync::{
    RssArticlesReply, RssFeedUpdate, RssFullTextReply, RssFullTextRequest, RssRefreshReply,
    RssRefreshRequest,
};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

pub fn routes() -> Router<Arc<Server>> {
    Router::new()
        .route("/api/rss/refresh", post(refresh))
        .route("/api/rss/articles", get(articles))
        .route("/api/rss/fulltext", post(full_text))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// Refreshes the enabled feeds named (all when empty, with the server's
/// own 订阅账号; with `due`, those whose interval has passed) and reports
/// each.
pub(crate) async fn refresh_feeds(
    server: &Arc<Server>,
    urls: Vec<String>,
    due: bool,
) -> RssRefreshReply {
    let storage = server.core.storage.clone();
    let minutes = super::jobs::rss_interval(server);
    let reply = tokio::task::spawn_blocking(move || {
        // 订阅账号 added on the web version sync with every refresh of all.
        let accounts = if urls.is_empty() {
            storage
                .lock()
                .ok()
                .and_then(|guard| guard.accounts_to_sync(None, due, minutes).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let urls = storage
            .lock()
            .ok()
            .and_then(|guard| guard.refresh_targets(&urls, due, minutes).ok())
            .unwrap_or_default();
        if due && urls.is_empty() && accounts.is_empty() {
            return None;
        }
        let feeds = Mutex::new(Vec::new());
        for account in accounts {
            let result = gripread_core::rss::account::sync(&storage, &account, &|_, _| {});
            if let Ok(mut feeds) = feeds.lock() {
                feeds.push(RssFeedUpdate {
                    url: format!("account:{account}"),
                    added: *result.as_ref().unwrap_or(&0),
                    error: result.err().map(|error| error.message),
                });
            }
        }
        gripread_core::rss::refresh_all(&storage, urls, &AtomicBool::new(false), &|url, result| {
            if let Ok(mut feeds) = feeds.lock() {
                feeds.push(RssFeedUpdate {
                    url: url.to_string(),
                    added: *result.as_ref().unwrap_or(&0),
                    error: result.err().map(|error| error.message),
                });
            }
        });
        Some(RssRefreshReply {
            feeds: feeds.into_inner().unwrap_or_default(),
        })
    })
    .await
    .unwrap_or_default();
    // Nothing was due: no log line every minute.
    let Some(reply) = reply else {
        return RssRefreshReply::default();
    };
    let added: u32 = reply.feeds.iter().map(|feed| feed.added).sum();
    let failed = reply
        .feeds
        .iter()
        .filter(|feed| feed.error.is_some())
        .count();
    let text = format!("订阅刷新：{} 个订阅，新文章 {added} 篇", reply.feeds.len());
    let params = [
        ("feeds", reply.feeds.len().to_string()),
        ("articles", added.to_string()),
        ("failed", failed.to_string()),
    ];
    if failed > 0 {
        log(
            "feedsRefreshedFailed",
            &params,
            format!("{text}，{failed} 个失败"),
        );
    } else {
        log("feedsRefreshed", &params, text);
    }
    // A feed's first title can change its record.
    server.edits.notify_one();
    reply
}

/// Each minute, refreshes the feeds whose interval has passed: their own,
/// or the one set in `jobs.json` (0 leaves only feeds with their own).
pub fn schedule(server: Arc<Server>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            refresh_feeds(&server, Vec::new(), true).await;
        }
    });
}

async fn refresh(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    body: Option<Json<RssRefreshRequest>>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let urls = body.map(|Json(request)| request.urls).unwrap_or_default();
    Json(refresh_feeds(&server, urls, false).await).into_response()
}

async fn full_text(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(request): Json<RssFullTextRequest>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    match tokio::task::spawn_blocking(move || gripread_core::rss::public_page_text(&request.link))
        .await
    {
        Ok(Ok(html)) => Json(RssFullTextReply { html }).into_response(),
        Ok(Err(error)) => failure(StatusCode::BAD_GATEWAY, "io", &error.message),
        Err(error) => failure(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    }
}

async fn articles(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let Some(feed) = query.get("feed").cloned() else {
        return failure(StatusCode::BAD_REQUEST, "invalid_argument", "缺少参数");
    };
    let since = query
        .get("since")
        .and_then(|since| since.parse().ok())
        .unwrap_or(0);
    let storage = server.core.storage.clone();
    let cursor = now_ms();
    let found = tokio::task::spawn_blocking(move || {
        storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?
            .feed_articles_since(&feed, since)
    })
    .await;
    match found {
        Ok(Ok(Some(articles))) => Json(RssArticlesReply { articles, cursor }).into_response(),
        Ok(Ok(None)) => failure(StatusCode::NOT_FOUND, "not_found", "服务器上没有这个订阅"),
        Ok(Err(error)) => failure(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.message),
        Err(error) => failure(StatusCode::INTERNAL_SERVER_ERROR, "io", &error.to_string()),
    }
}
