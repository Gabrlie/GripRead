//! 订阅 on the server: feeds refreshed on a schedule (`jobs.json`'s
//! `rssIntervalMinutes`) and on request, and their articles handed to
//! connected devices, which then need not reach every feed themselves.

use super::*;
use gripread_core::sync::{RssArticlesReply, RssFeedUpdate, RssRefreshReply, RssRefreshRequest};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

pub fn routes() -> Router<Arc<Server>> {
    Router::new()
        .route("/api/rss/refresh", post(refresh))
        .route("/api/rss/articles", get(articles))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// Refreshes the feeds named (all when empty) and reports each.
pub(crate) async fn refresh_feeds(server: &Arc<Server>, urls: Vec<String>) -> RssRefreshReply {
    let storage = server.core.storage.clone();
    let reply = tokio::task::spawn_blocking(move || {
        let urls = if urls.is_empty() {
            storage
                .lock()
                .ok()
                .and_then(|guard| guard.feed_urls().ok())
                .unwrap_or_default()
        } else {
            urls
        };
        let feeds = Mutex::new(Vec::new());
        gripread_core::rss::refresh_all(&storage, urls, &AtomicBool::new(false), &|url, result| {
            if let Ok(mut feeds) = feeds.lock() {
                feeds.push(RssFeedUpdate {
                    url: url.to_string(),
                    added: *result.as_ref().unwrap_or(&0),
                    error: result.err().map(|error| error.message),
                });
            }
        });
        RssRefreshReply {
            feeds: feeds.into_inner().unwrap_or_default(),
        }
    })
    .await
    .unwrap_or_default();
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

/// Refreshes every feed on the schedule set in `jobs.json`.
pub fn schedule(server: Arc<Server>) {
    tokio::spawn(async move {
        let mut last = None::<i64>;
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let minutes = super::jobs::rss_interval(&server);
            if minutes == 0 {
                continue;
            }
            let due = last.is_none_or(|last| now_ms() - last >= i64::from(minutes) * 60_000);
            if due {
                last = Some(now_ms());
                refresh_feeds(&server, Vec::new()).await;
            }
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
    Json(refresh_feeds(&server, urls).await).into_response()
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
