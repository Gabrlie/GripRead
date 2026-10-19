# Decision: RSS article state syncs as per-feed read sets and starred records

Status: implemented

## Problem

A reader who follows feeds on a phone and a computer expects an article read on one to be read on the other, and starred articles to be there on both. Articles themselves are large, change little once fetched, and every device can fetch them from the feed or the server. Read marks are many and change often, sometimes on two devices at once.

## Decision

Sync carries three kinds of record, all in the RSS 订阅 category:
- `feed:<url>`: a subscription's title, group, site, and order.
- `rss-read:<url>`: the read articles of a feed, by the first 16 hex digits of their ids, sorted.
- `rss-star:<article id>`: a starred article with its title, link, excerpt, and text.

A device applying another's read set takes only the difference from the version both last synced: what the other read since is read here, what it marked unread is unread here, and this device's own changes stay. Ids synced as read whose articles a device has not fetched stay in its own record (up to three times the articles a feed keeps), and become read when a fetch brings those articles. Article bodies, images, and full text never sync.

## Alternatives considered

- **A record per article:** every read mark would be a record, thousands per feed.
- **Last writer wins per feed:** two devices reading at once would undo each other's marks.
- **Syncing articles:** this would duplicate what feeds and the server already provide, at many times the size.

## Consequences

Marks converge without conflicts the reader sees. Each read mark rewrites its feed's record (a few kilobytes). A starred article shows on a device that never fetched its feed. Read marks on articles that have left every device's retention linger in records until the cap trims them.
