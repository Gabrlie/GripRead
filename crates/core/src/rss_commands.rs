//! 订阅's commands: subscriptions, refreshing with progress events,
//! articles and their state, OPML, and article images. Network work runs
//! on blocking threads; storage work goes through `with_storage`.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use crate::commands::{with_storage, AppState};
use crate::error::{AppError, ErrorCode};
use crate::models::{
    AddFeedRequest, Article, ArticleIdRequest, ArticlePage, ArticleQuery, ArticleStateRequest,
    Feed, FeedAccount, FeedAccountIdRequest, FeedFilter, FeedFilterIdRequest, FeedFilterTest,
    FeedGroup, FeedPreview, FeedSearchResult, FeedUrlsRequest, MarkAllReadRequest,
    MarkReadRangeRequest, OpmlImportReport, OpmlImportRequest, OptionalPathRequest,
    PreviewFeedRequest, RefreshFeedsRequest, RemoveFeedGroupRequest, RenameFeedGroupRequest,
    RssImageRequest, RssRefreshEvent, RssSettings, SaveFeedAccountRequest, SaveFeedFilterRequest,
    SaveFeedGroupsRequest, SaveRssSettingsRequest, SearchFeedsRequest, TestFeedFilterRequest,
    UpdateFeedRequest,
};
use crate::source_commands::SourceOperations;

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| AppError::new(ErrorCode::Io, format!("rss worker stopped: {error}")))?
}

pub async fn list_feeds(state: &Arc<AppState>) -> Result<Vec<Feed>, AppError> {
    with_storage(state, |storage| storage.list_feeds()).await
}

pub async fn add_feed(state: &Arc<AppState>, request: AddFeedRequest) -> Result<Feed, AppError> {
    let storage = state.storage.clone();
    let url = request.url.trim().to_string();
    let root = state.data_root.clone();
    blocking(move || {
        if let Some(account) = &request.account {
            crate::network::refresh(&root);
            let url = crate::rss::account::subscribe(
                &storage,
                account,
                &url,
                request.title.as_deref(),
                request.group.as_deref(),
            )?;
            return lock(&storage)?.feed(&url);
        }
        crate::rss::subscribe(
            &storage,
            &url,
            request.title.as_deref(),
            request.group.as_deref(),
        )?;
        let guard = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        guard
            .list_feeds()?
            .into_iter()
            .max_by_key(|feed| feed.added_at)
            .ok_or_else(|| AppError::keyed(ErrorCode::NotFound, "rssNotSaved", "订阅没有保存"))
    })
    .await
}

/// Changes a feed; a new address is read first, and must be a feed. An
/// account's feed is renamed or moved on the account first.
pub async fn update_feed(
    state: &Arc<AppState>,
    request: UpdateFeedRequest,
) -> Result<Feed, AppError> {
    let mut request = request;
    if crate::storage::feed_account(&request.url).is_some() {
        let storage = state.storage.clone();
        let root = state.data_root.clone();
        let (url, title, group) = (
            request.url.clone(),
            request.title.clone(),
            request.group.clone(),
        );
        blocking(move || {
            crate::network::refresh(&root);
            crate::rss::account::edit_feed(&storage, &url, &title, group.as_deref())
        })
        .await?;
        request.new_url = None;
    }
    if let Some(new_url) = request.new_url.take().filter(|new_url| {
        let new_url = new_url.trim();
        !new_url.is_empty() && new_url != request.url
    }) {
        request.new_url = Some(blocking(move || crate::rss::check_feed(&new_url)).await?);
    }
    with_storage(state, move |storage| {
        storage.update_feed(&request)?;
        storage.feed(request.new_url.as_deref().unwrap_or(&request.url))
    })
    .await
}

pub async fn list_feed_groups(state: &Arc<AppState>) -> Result<Vec<FeedGroup>, AppError> {
    with_storage(state, |storage| storage.feed_groups()).await
}

pub async fn save_feed_groups(
    state: &Arc<AppState>,
    request: SaveFeedGroupsRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.save_feed_groups(&request.names)
    })
    .await
}

pub async fn rename_feed_group(
    state: &Arc<AppState>,
    request: RenameFeedGroupRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.rename_feed_group(&request.name, &request.new_name)
    })
    .await
}

pub async fn remove_feed_group(
    state: &Arc<AppState>,
    request: RemoveFeedGroupRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.remove_feed_group(&request.name, request.unsubscribe)
    })
    .await
}

/// Unsubscribes; an account's feeds are unsubscribed on the account first.
pub async fn remove_feeds(state: &Arc<AppState>, request: FeedUrlsRequest) -> Result<(), AppError> {
    let storage = state.storage.clone();
    let root = state.data_root.clone();
    let urls = request.urls.clone();
    if urls
        .iter()
        .any(|url| crate::storage::feed_account(url).is_some())
    {
        blocking(move || {
            crate::network::refresh(&root);
            for url in &urls {
                crate::rss::account::unsubscribe(&storage, url)?;
            }
            Ok(())
        })
        .await?;
    }
    with_storage(state, move |storage| storage.remove_feeds(&request.urls)).await
}

pub async fn list_feed_accounts(state: &Arc<AppState>) -> Result<Vec<FeedAccount>, AppError> {
    with_storage(state, |storage| storage.feed_accounts()).await
}

/// Adds or changes an account after signing in to it; a changed account
/// keeps its service and user name.
pub async fn save_feed_account(
    state: &Arc<AppState>,
    request: SaveFeedAccountRequest,
) -> Result<FeedAccount, AppError> {
    let storage = state.storage.clone();
    let root = state.data_root.clone();
    blocking(move || {
        let existing = match &request.id {
            Some(id) => Some(lock(&storage)?.account_login(id)?),
            None => None,
        };
        let request = match &existing {
            Some(existing) => SaveFeedAccountRequest {
                server: existing.server.clone(),
                username: existing.username.clone(),
                ..request
            },
            None => request,
        };
        crate::network::refresh(&root);
        let login = crate::rss::account::verify(&request, existing)?;
        let guard = lock(&storage)?;
        let id = guard.save_feed_account(&request, &login)?;
        guard.feed_account(&id)
    })
    .await
}

/// Removes an account from this device; the service keeps everything.
pub async fn remove_feed_account(
    state: &Arc<AppState>,
    request: FeedAccountIdRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.remove_feed_account(&request.id)
    })
    .await
}

/// Refreshes feeds a few at a time, sending `rss-refresh` for each and
/// once when done; answers when all are done. While connected, the server
/// refreshes and this device takes its articles; feeds the server cannot
/// give are fetched here.
pub async fn refresh_feeds(
    state: &Arc<AppState>,
    request: RefreshFeedsRequest,
) -> Result<(), AppError> {
    let (urls, due, named) = (request.urls.clone(), request.due, request.accounts.clone());
    let (urls, accounts) = with_storage(state, move |storage| {
        let minutes = storage.rss_settings().refresh_minutes;
        let everything = urls.is_empty() && named.is_empty();
        // An account feed named syncs its account.
        let mut named = named;
        let mut local = Vec::new();
        for url in urls {
            match crate::storage::feed_account(&url) {
                Some((account, _)) => named.push(account.to_string()),
                None => local.push(url),
            }
        }
        let urls = if everything || !local.is_empty() {
            storage.refresh_targets(&local, due, minutes)?
        } else {
            Vec::new()
        };
        let accounts =
            storage.accounts_to_sync((!everything).then_some(&named[..]), due, minutes)?;
        Ok((urls, accounts))
    })
    .await?;
    let root = state.data_root.clone();
    // A proxy turned off since the last check is noticed first.
    blocking(move || {
        crate::network::refresh(&root);
        Ok(())
    })
    .await?;
    let cancel = state.operations.register(&request.operation_id);
    let cancels = state.operations.cancels();
    let total = (urls.len() + accounts.len()) as u32;
    let refreshed = Arc::new(AtomicU32::new(0));
    let storage = state.storage.clone();
    let events = state.events.clone();
    let sync = state.sync.clone();
    let operation_id = request.operation_id.clone();
    let counted = refreshed.clone();
    blocking(move || {
        let report = |url: &str, result: Result<u32, AppError>| {
            let done = counted.fetch_add(1, Ordering::AcqRel) + 1;
            let event = RssRefreshEvent {
                operation_id: operation_id.clone(),
                url: url.to_string(),
                refreshed: done,
                total,
                new_articles: *result.as_ref().unwrap_or(&0),
                error: result.err().map(|error| error.message),
                done: false,
            };
            events.emit(
                "rss-refresh",
                serde_json::to_value(event).unwrap_or_default(),
            );
        };
        // Accounts sync here: their passwords stay on this device.
        for account in &accounts {
            if cancel.load(Ordering::Acquire) {
                break;
            }
            report(
                &format!("account:{account}"),
                crate::rss::account::sync(&storage, account),
            );
        }
        // Nothing due: the server is not asked, which would take an empty
        // list as every feed.
        let here = if urls.is_empty() {
            urls
        } else if sync.connected() {
            through_server(&storage, &sync, urls, &report)
        } else {
            urls
        };
        crate::rss::refresh_all(&storage, here, &cancel, &report);
        Ok(())
    })
    .await?;
    SourceOperations::finish(&cancels, &request.operation_id);
    state.events.emit(
        "rss-refresh",
        serde_json::to_value(RssRefreshEvent {
            operation_id: request.operation_id,
            url: String::new(),
            refreshed: refreshed.load(Ordering::Acquire),
            total,
            new_articles: 0,
            error: None,
            done: true,
        })
        .unwrap_or_default(),
    );
    Ok(())
}

/// The server refreshes the feeds and sends what it fetched; returns the
/// feeds it could not give, to fetch here.
fn through_server(
    storage: &Mutex<crate::storage::Storage>,
    sync: &crate::sync_client::SyncClient,
    urls: Vec<String>,
    report: &dyn Fn(&str, Result<u32, AppError>),
) -> Vec<String> {
    let reply = match sync.rss_refresh(urls.clone()) {
        Ok(Some(reply)) => reply,
        Ok(None) => {
            crate::log_keyed!(
                Info,
                "rss",
                "serverTooOldToRefreshFeeds",
                "服务器版本较旧，不能代为刷新订阅，在本机刷新"
            );
            return urls;
        }
        Err(error) => {
            crate::log_keyed!(
                Warn,
                "rss",
                "serverFeedRefreshFailed",
                format!("服务器刷新订阅失败，改为本机刷新：{}", error.message),
                @error error,
            );
            return urls;
        }
    };
    let mut here = Vec::new();
    for url in urls {
        let failed = reply
            .feeds
            .iter()
            .find(|feed| feed.url == url)
            .is_none_or(|feed| feed.error.is_some());
        if failed {
            here.push(url);
            continue;
        }
        let taken = (|| {
            let since = lock(storage)?.feed_server_cursor(&url)?;
            let Some(page) = sync.rss_articles(&url, since)? else {
                return Ok(None);
            };
            lock(storage)?
                .store_server_articles(&url, page.articles, page.cursor)
                .map(Some)
        })();
        match taken {
            Ok(Some(added)) => report(&url, Ok(added)),
            _ => here.push(url),
        }
    }
    here
}

fn lock(
    storage: &Mutex<crate::storage::Storage>,
) -> Result<std::sync::MutexGuard<'_, crate::storage::Storage>, AppError> {
    storage
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
}

pub async fn list_articles(
    state: &Arc<AppState>,
    request: ArticleQuery,
) -> Result<ArticlePage, AppError> {
    with_storage(state, move |storage| storage.list_articles(&request)).await
}

pub async fn get_article(
    state: &Arc<AppState>,
    request: ArticleIdRequest,
) -> Result<Article, AppError> {
    with_storage(state, move |storage| storage.rss_article(&request.id)).await
}

/// 全文: the article's page, read for its main text and kept.
pub async fn fetch_full_text(
    state: &Arc<AppState>,
    request: ArticleIdRequest,
) -> Result<String, AppError> {
    let storage = state.storage.clone();
    let sync = state.sync.clone();
    let root = state.data_root.clone();
    blocking(move || {
        crate::network::refresh(&root);
        let server = |link: &str| {
            sync.rss_full_text(link)?.ok_or_else(|| {
                AppError::keyed(
                    ErrorCode::InvalidArgument,
                    "serverTooOldForFullText",
                    "服务器版本较旧，不能代为读取全文",
                )
            })
        };
        let server: Option<crate::rss::ServerPage<'_>> = sync.connected().then_some(&server);
        crate::rss::full_text(&storage, &request.id, server)
    })
    .await
}

pub async fn set_article_state(
    state: &Arc<AppState>,
    request: ArticleStateRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.set_article_state(
            &request.ids,
            request.read,
            request.starred,
            request.keep_unread,
        )
    })
    .await
}

pub async fn mark_all_read(
    state: &Arc<AppState>,
    request: MarkAllReadRequest,
) -> Result<u32, AppError> {
    with_storage(state, move |storage| {
        storage.mark_all_read(
            request.feed.as_deref(),
            request.group.as_deref(),
            request.account.as_deref(),
        )
    })
    .await
}

pub async fn mark_read_range(
    state: &Arc<AppState>,
    request: MarkReadRangeRequest,
) -> Result<u32, AppError> {
    with_storage(state, move |storage| {
        storage.mark_read_range(&request.query, &request.from, request.newer)
    })
    .await
}

pub async fn rss_image(
    state: &Arc<AppState>,
    request: RssImageRequest,
) -> Result<Vec<u8>, AppError> {
    let storage = state.storage.clone();
    blocking(move || crate::rss::image(&storage, &request.url, request.referer.as_deref())).await
}

pub async fn import_opml(
    state: &Arc<AppState>,
    request: OpmlImportRequest,
) -> Result<OpmlImportReport, AppError> {
    let storage = state.storage.clone();
    blocking(move || crate::rss::import_opml(&storage, &request.text)).await
}

/// Saves the subscriptions as an OPML file; `false` when cancelled.
pub async fn export_opml_file(
    state: &Arc<AppState>,
    request: OptionalPathRequest,
) -> Result<bool, AppError> {
    let app = state.clone();
    let text = with_storage(state, |storage| crate::rss::export_opml(storage)).await?;
    blocking(move || {
        crate::documents::save_document(
            &*app.platform,
            request.path.as_deref(),
            "GripRead-subscriptions.opml",
            "text/x-opml",
            text.as_bytes(),
        )
    })
    .await
}

pub async fn get_rss_settings(state: &Arc<AppState>) -> Result<RssSettings, AppError> {
    with_storage(state, |storage| Ok(storage.rss_settings())).await
}

pub async fn save_rss_settings(
    state: &Arc<AppState>,
    request: SaveRssSettingsRequest,
) -> Result<RssSettings, AppError> {
    with_storage(state, move |storage| {
        storage.save_rss_settings(&request.settings)
    })
    .await
}

pub async fn list_feed_filters(state: &Arc<AppState>) -> Result<Vec<FeedFilter>, AppError> {
    with_storage(state, |storage| storage.feed_filters()).await
}

pub async fn save_feed_filter(
    state: &Arc<AppState>,
    request: SaveFeedFilterRequest,
) -> Result<FeedFilter, AppError> {
    with_storage(state, move |storage| {
        storage.save_feed_filter(&request.filter, request.purge)
    })
    .await
}

pub async fn remove_feed_filter(
    state: &Arc<AppState>,
    request: FeedFilterIdRequest,
) -> Result<(), AppError> {
    with_storage(state, move |storage| {
        storage.remove_feed_filter(&request.id)
    })
    .await
}

pub async fn test_feed_filter(
    state: &Arc<AppState>,
    request: TestFeedFilterRequest,
) -> Result<FeedFilterTest, AppError> {
    with_storage(state, move |storage| {
        storage.test_feed_filter(&request.filter)
    })
    .await
}

pub async fn search_feeds(
    state: &Arc<AppState>,
    request: SearchFeedsRequest,
) -> Result<Vec<FeedSearchResult>, AppError> {
    let storage = state.storage.clone();
    blocking(move || crate::rss::search::search_feeds(&storage, &request.query)).await
}

pub async fn preview_feed(
    state: &Arc<AppState>,
    request: PreviewFeedRequest,
) -> Result<FeedPreview, AppError> {
    let storage = state.storage.clone();
    blocking(move || crate::rss::search::preview(&storage, &request.url)).await
}
