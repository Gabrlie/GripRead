# Interaction and visual design

Status: planned

## Visual language

The existing page implementation is the visual baseline. Preserve its paper surfaces, tone-specific accents, editorial headings, fine separators, rounded cards, desktop sidebar, and floating phone navigation. Use the colors in the [theme stylesheet](../../src/styles.css) and [Tailwind configuration](../../tailwind.config.js) as the single token source. Bundled reading fonts and local SVG icons keep reading independent of external asset requests.

Service integration does not authorize redesigning or removing page regions. Library retains its unified glass header, group strip, four-line list cards, and cover grid with three phone columns and five desktop columns. Discovery retains search, source pills, eight category tiles, and the recommendation region. Subscriptions retain channel and article regions. Settings retains its overview, grouped rows, segmented appearance control, and paper swatches. The reader retains its centered page, unobtrusive metadata, overlay toolbars, and compact typography panel. Preserve these structures when replacing fixture data with real services.

Unavailable capabilities remain visible and disabled. Preserve the current page hierarchy, card components, and control geometry; replace fixture identities and statistics with truthful unavailable content inside their existing regions. The shelf group strip uses only the service snapshot, including an empty group list; discovery categories are a separate presentation taxonomy. Remove fabricated books, feeds, statistics, and success responses without replacing whole screens with a single unavailable message. Empty content regions use truthful empty states within the existing layout. Completed capabilities keep their established controls and consume real service state.

Novel typography starts at 18 px with 1.8 line height. Measure each page inside the actual available viewport; toolbar visibility must not obscure or repaginate the text. Motion parameters belong exclusively to [motion design](motion.md). Future screen capabilities below remain planned and do not supersede the current visual baseline without an explicit design request.

The glass header and desktop sidebar use background alpha 0.45 in light mode, 0.58 in dark mode, and 0.65 in OLED mode; the floating dock uses 0.52, 0.64, and 0.70 respectively. Keep blur at 20 px and saturation at 180%, preserve foreground opacity and existing borders/shadows, and share the header material across the shelf title and group strip. These values reveal in-app content without changing native window transparency. Dropdown material remains more opaque for readability.

## Navigation and screens

Phone navigation has Library, Find Books, RSS, and Settings tabs, displayed in the product's default locale. Desktop uses the same destinations in a sidebar. Novel reading hides global navigation; returning restores the previous selection and list position. The current desktop RSS shell retains its channel and article columns; a reading pane is planned.

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

Empty Library offers local file import; discovery, RSS feed URLs, and OPML controls remain disabled until their services are delivered. Do not require cloud setup before these actions.

## Reading controls

Phone novels default to one page. Desktop defaults to a centered single page and offers double-page reading. Tap the center to reveal controls: Contents, Progress, Appearance, and Bookmarks; source switching and downloads live under More. Tap left/right areas or swipe to turn pages; desktop also supports arrow keys and Space. Suppress those shortcuts inside text inputs and while selecting text.

A contents selection navigates to that chapter. Reader layout changes follow the [locator contract](../subsystems/reader.md). Loading and sync indicators remain outside the text; remote progress produces a user-selectable action instead of an automatic jump.

RSS articles scroll continuously and show title, source, date, original link, and content. Preserve list position when returning from an article and retain selected columns on desktop. Content extraction and article-state behavior belong to [RSS](../subsystems/rss.md).

## States and accessibility

Design every screen together with its loading, empty, partial-failure, offline, and success states. Errors offer a relevant retry or recovery action while retaining usable content. Maintain visible keyboard focus, touch-accessible controls, understandable labels, and consistent back/dismiss behavior.

Each page specification includes the [motion contract](motion.md) alongside layout and states. UI components consume explicit data and event interfaces; they do not invent synchronization, storage, source, or AI behavior.

## Acceptance

Verify phone and desktop layouts, keyboard focus, touch controls, modal focus restoration, empty/error states, and preserved reading/list context. Evaluate motion and reduced-motion behavior using the cases owned by the motion specification.
