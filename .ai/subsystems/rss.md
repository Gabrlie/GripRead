# RSS reader

Status: implemented

## Scope

A standard RSS/Atom reader, independent of novel sources. OPML exchanges subscription lists and groups; it is not an article or parsing-rule format. Legado `rssSource` webpage adapters are outside this module.

## Interfaces

The core owns feeds and articles (`crates/core/src/rss.rs` for fetching and content, `storage/rss.rs` for the tables `rss_feeds` and `rss_articles`, `rss_commands.rs` for the commands). The frontend reaches them through `FeedService` (`src/services/contracts.ts`) and keeps 订阅's state in `FeedStore` (`src/application/rss.ts`). Articles and feed identities are separate from novel books and `ReaderLocator`.

Commands: `list_feeds` (with unread and total counts), `discover_feed`, `add_feed`, `update_feed`, `remove_feeds`, `refresh_feeds` (progress as `rss-refresh` events, cancellable), `list_articles` (one feed, one group, or all; 全部, 未读, or 星标; a search over titles and excerpts; pages by publication time), `get_article`, `fetch_full_text`, `set_article_state`, `mark_all_read`, `rss_image`, `import_opml`, `export_opml_file`, and `get_rss_settings`/`save_rss_settings` (`rss.json` on the device). Its tables came with schema 29.

## Behavior

Feeds are fetched through the app's network settings (proxy and DoH), with `If-None-Match`/`If-Modified-Since`, following up to five redirects. `feed-rs` parses RSS 0.9–2.0, RSS 1.0, Atom, and JSON Feed. An article's id is a hash of the feed address and the entry's id (its link, title, or text when it has none), so repeated entries count once and a refresh updates articles it has while keeping their read and starred state. A failed feed records its error and keeps its articles; refreshing runs four feeds at once. Each feed keeps its newest 500 articles or those of the last `keepDays` days (30, 90 by default, 180, or 365), whichever is more; entries too old to keep are not counted as new. Starred articles stay until unstarred, also after their feed is removed.

Adding a feed takes a feed address, or a page whose `<link rel="alternate">` names feeds (several are offered to choose from), or a site whose usual feed paths answer. OPML import subscribes to each outline with an `xmlUrl`, filed under the path of the outlines around it joined by ` / `; addresses already subscribed are left alone. Export writes OPML 2.0 with groups as outlines.

Article HTML is sanitized once, when stored: an allowlist of reading elements and attributes, links and images made absolute (http, https, and mailto only), lazy-loading `data-src` taken as the image, and scripts, styles, frames, forms, and media dropped with their content. 全文 reads the article's page in its declared charset, scores paragraph containers by text, punctuation, class names, and link density, and keeps the best one sanitized; when nothing long enough stands out the excerpt and link stay and the reader is told why. Images load through `rss_image`, with the article as referrer, into `rss-images/` (订阅文章图片 in 数据管理), so they show offline.

订阅 refreshes when entered if the last refresh is over ten minutes old (unless 进入订阅时刷新 is off), on pulling down (phone) or 刷新, and on the chosen interval (off, 30 minutes, 1 hour by default, 3 or 6 hours) while the app is visible. There is no background refresh. Read and starred changes show at once and are saved behind; a failed save puts them back, as it does for settings. Opening an article marks it read unless turned off, and fetches its 全文 when 打开文章时读取全文 is on (quietly keeping the feed's text if that fails). Article lists show each article's first picture, loaded once in view, unless turned off. Article text uses its own size setting.

订阅设置 is reached from 设置 › 订阅 (beside 管理订阅), from 订阅's menu, and from 管理订阅. It holds the interval, 进入订阅时刷新, 打开文章时标为已读, 打开文章时读取全文, 文章列表显示图片, the text size, 文章保留, and whether 订阅 shows in the tab bar (the same preference as in 更多外观设置). These settings stay on the device. The server's own refresh interval is set in 定时追更. The core's errors and log entries carry keys (`error.rss*`, `log.rss*`, `log.feedsRefreshed`), so they show in the interface language.

Subscriptions, read articles, and starred articles sync ([Sync](sync.md), [decision](../notes/implemented/2026-10-14-rss-article-state.md)) and go into backups (subscriptions and starred articles) under the RSS 订阅 category. While connected, a refresh asks the [server](server.md) to refresh and takes the articles it fetched; feeds it cannot give are fetched on the device. Layouts belong to [interaction design](../design/interaction.md).

## Acceptance

- RSS 2.0, Atom, and RDF parse with repeated and malformed entries; HTML is sanitized; discovery finds linked and guessed feeds.
- Refresh keeps state and articles through 304 answers and failures; retention keeps starred articles.
- OPML with nested groups imports, exports, and reimports without duplicates.
- Unread and starred filtering, paging, search, optimistic state, and the refresh schedule are tested in the store; the phone flow opens a feed, reads, stars, and fetches 全文.
- Two devices and a server converge on subscriptions and read state with concurrent marks; a connected device refreshes through the server.
