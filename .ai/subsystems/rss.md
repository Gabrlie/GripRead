# RSS reader

Status: planned

## Scope

Provide a standard RSS/Atom reader independently of novel sources. OPML exchanges subscription lists and groups; it is not an article or parsing-rule format. Legado `rssSource` webpage adapters are outside this module's initial scope.

## Interfaces

`FeedService` imports and exports subscriptions, refreshes feeds, returns article lists and content, and updates read/favorite state. Articles and feed identities are separate from novel books and `ReaderLocator`. Sharing cleaned-text rendering utilities does not couple their data models.

## Behavior

Accept RSS/Atom URLs and OPML files, preserve subscription groups, merge duplicate subscriptions, and deduplicate repeated articles on refresh. Show local articles while fetching updates; a failed feed does not remove data from successful feeds.

Display feed-provided content first. Offer on-demand full-text extraction for excerpt-only entries; retain the excerpt and original link if extraction fails. Preserve article title, source, publication date, and original URL. Sanitize HTML before display and cache article content and images locally.

Read and favorite changes are immediately durable on the device. Subscription configuration and article state are eligible for [Sync](sync.md); content caches follow its exclusions. Article reading remains continuous scrolling; layouts belong to [interaction design](../design/interaction.md).

## Acceptance

- Import RSS, Atom, and nested OPML groups; export and reimport without duplicate subscriptions.
- Refresh feeds with repeated or malformed entries and partial network failures without losing existing articles.
- Verify unread/favorite filtering, local persistence, offline content, and full-text extraction fallback.
- Verify the phone navigation and desktop three-column view preserve selection and list position.
