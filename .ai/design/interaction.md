# Interaction and visual design

Status: planned

## Visual language

Use a quiet paper-like palette: background `#F7F4ED`, body text `#292D29`, and restrained green `#58705C`, with a corresponding dark theme. Interface typography uses system sans-serif; reading supports a Song-style serif and imported fonts. Use spacing and fine separators to establish hierarchy.

Default novel typography is 20 px text with 1.8 line height, 24 px horizontal phone padding, and an approximately 720 px maximum text width per desktop page. Typography controls include size, line height, margins, font, and theme. Motion parameters belong exclusively to [motion design](motion.md).

## Navigation and screens

Phone navigation has Library, Find Books, RSS, and Settings tabs, displayed in the product's default locale. Desktop uses the same destinations in a sidebar. Novel reading hides global navigation; returning restores the previous selection and list position. Desktop RSS retains its three-column workspace.

| Screen | Phone | Desktop |
| --- | --- | --- |
| Library | Continue-reading card, cover grid/list, long-press management | Recent reading, grid/list, multi-select, file drop |
| Find Books | Search, source scope, progressive grouped results, detail navigation | Results and selected book details side by side |
| RSS | Groups, subscriptions, articles, and article view through successive screens | Subscription, article list, and content columns; collapsible side panels |
| Settings | Reading, Sources, Sync and Backup, Storage groups | Category navigation beside settings |

Use shadcn/ui controls and accessible primitives. Phone actions normally use a Drawer; desktop uses a Dialog or side panel. Closing a panel restores focus and reading context rather than reopening the book.

## Library and discovery

Show a single continue-reading entry before the shelf. Support custom groups and unread/reading/finished filters. Book items expose title, progress, updates, and local availability. Cloud Library appears when configured and represents the selected WebDAV folder; [Library](../subsystems/library.md) owns availability actions and [Sync](../subsystems/sync.md) owns transfer semantics.

Find Books retains successful results when one source fails. Book details show source, title, author, cover, introduction, latest chapter, and a contents entry. Offer add-to-shelf, read, update check, chapter cache, and source switching according to available capabilities. Unsupported operations explain their cause.

Empty Library offers file import and book discovery; empty RSS offers a feed URL or OPML import. Do not require cloud setup before these actions.

## Reading controls

Phone novels default to one page. Desktop defaults to a centered single page and offers double-page reading. Tap the center to reveal controls: Contents, Progress, Appearance, and Bookmarks; source switching and downloads live under More. Tap left/right areas or swipe to turn pages; desktop also supports arrow keys and Space. Suppress those shortcuts inside text inputs and while selecting text.

A contents selection navigates to that chapter. Reader layout changes follow the [locator contract](../subsystems/reader.md). Loading and sync indicators remain outside the text; remote progress produces a user-selectable action instead of an automatic jump.

RSS articles scroll continuously and show title, source, date, original link, and content. Preserve list position when returning from an article and retain selected columns on desktop. Content extraction and article-state behavior belong to [RSS](../subsystems/rss.md).

## States and accessibility

Design every screen together with its loading, empty, partial-failure, offline, and success states. Errors offer a relevant retry or recovery action while retaining usable content. Maintain visible keyboard focus, touch-accessible controls, understandable labels, and consistent back/dismiss behavior.

Each page specification includes the [motion contract](motion.md) alongside layout and states. UI components consume explicit data and event interfaces; they do not invent synchronization, storage, source, or AI behavior.

## Acceptance

Verify phone and desktop layouts, keyboard focus, touch controls, modal focus restoration, empty/error states, and preserved reading/list context. Evaluate motion and reduced-motion behavior using the cases owned by the motion specification.
