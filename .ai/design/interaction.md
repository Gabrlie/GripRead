# Interaction and visual design

Status: planned

## Visual language

The existing page implementation is the visual baseline. The reader geometry and controls described in the [active import and reading plan](../plans/2026-09-23-import-reader-experience.md) are an intentional update to that baseline; preserve its paper surfaces, tone-specific accents, editorial headings, fine separators, rounded cards, desktop sidebar, and floating phone navigation elsewhere. Use the colors in the [theme stylesheet](../../src/styles.css) and [Tailwind configuration](../../tailwind.config.js) as the single token source. Bundled reading fonts and local SVG icons keep reading independent of external asset requests.

Service integration does not authorize redesigning or removing page regions outside the reader update in the active plan. Library retains its unified glass header, group strip, four-line list cards, and cover grid with three phone columns and five desktop columns. Discovery retains search, source pills, eight category tiles, and the recommendation region. Subscriptions retain channel and article regions. Settings retains its overview, grouped rows, segmented appearance control, and paper swatches. The reader fills the available application viewport with compact insets and safe-area handling, readable desktop line length, unobtrusive metadata, overlay toolbars, and a compact typography panel; it does not use a vertically inset page card.

Unavailable capabilities remain visible and disabled. Preserve the current page hierarchy, card components, and control geometry; replace fixture identities and statistics with truthful unavailable content inside their existing regions. The shelf group strip uses only the service snapshot, including an empty group list; discovery categories are a separate presentation taxonomy. Remove fabricated books, feeds, statistics, and success responses without replacing whole screens with a single unavailable message. Empty content regions use truthful empty states within the existing layout. Completed capabilities keep their established controls and consume real service state.

Novel typography starts at 18 px with 1.8 line height. Measure each page inside the actual available viewport with compact reading insets and safe areas, and keep desktop line length readable. Do not permanently reserve toolbar-sized top or bottom padding. Toolbars may temporarily overlay the page; showing or hiding them, or switching panels, must not repaginate the text or change its saved position. Motion parameters belong exclusively to [motion design](motion.md). Future screen capabilities below remain planned and do not supersede the current visual baseline without an explicit design request.

The glass header and desktop sidebar use background alpha 0.45 in light mode, 0.58 in dark mode, and 0.65 in OLED mode; the floating dock uses 0.52, 0.64, and 0.70 respectively. Keep blur at 20 px and saturation at 180%, preserve foreground opacity and existing borders/shadows, and share the header material across the shelf title and group strip. These values reveal in-app content without changing native window transparency. Dropdown material remains more opaque for readability.

## Navigation and screens

Phone navigation has Library, Find Books, RSS, and Settings tabs, displayed in the product's default locale. Desktop uses the same destinations in a sidebar. Novel reading hides global navigation; returning restores the previous selection and list position. The current desktop RSS shell retains its channel and article columns; a reading pane is planned.

| Screen | Phone | Desktop |
| --- | --- | --- |
| Library | Continue-reading card, cover grid/list, long-press management | Recent reading, grid/list, multi-select, file drop |
| Find Books | Search, source scope, progressive grouped results, detail navigation | Results and selected book details side by side |
| RSS | Groups, subscriptions, articles, and article view through successive screens | Subscription, article list, and content columns; collapsible side panels |
| Settings | Reading, Sources, Sync and Backup, Storage groups | Category navigation beside settings |

Use shadcn/ui controls and accessible primitives. Phone actions normally use a Drawer; desktop uses a Dialog or side panel. Closing a panel restores focus and reading context rather than reopening the book. The Android back action closes the topmost dialog or reader panel, then hides visible reader toolbars, then leaves the reader, then returns to Library, and finally exits after pending saves finish.

## Library and discovery

Show a single continue-reading entry before the shelf. Support custom groups and unread/reading/finished filters. Book items expose title, progress, updates, and local availability. Cloud Library appears when configured and represents the selected WebDAV folder; [Library](../subsystems/library.md) owns availability actions and [Sync](../subsystems/sync.md) owns transfer semantics.

Find Books retains successful results when one source fails. Book details show source, title, author, cover, introduction, latest chapter, and a contents entry. Offer add-to-shelf, read, update check, chapter cache, and source switching according to available capabilities. Unsupported operations explain their cause.

Empty Library offers local file import; discovery, RSS feed URLs, and OPML controls remain disabled until their services are delivered. Do not require cloud setup before these actions.

## Reading controls

Phone novels default to one page. Desktop defaults to a centered single page and offers double-page and scroll reading. Screens account for the status bar, navigation bar, and display cutout; Android reports these insets natively because edge-to-edge WebViews do not reliably provide CSS safe-area values. Enter the reader with toolbars hidden; tapping the center toggles them, while dragging or selecting text does not. Dragging or wheel-scrolling the continuous view hides them so overlay bars never cover the passage being read, and its position indicator sits at the screen edge and appears only while scrolling; Escape also hides them before leaving the reader. The reading menu follows Legado 3.26.7 with GripRead styling. The top bar has back, the book title over the current chapter, then TXT目录规则, 设置编码, and More (add bookmark, update directory, page animation). The bottom has previous chapter, an in-chapter progress slider, and next chapter above Search, Automatic Page Turning, Contents, 界面, and a day/night toggle. Contents and Search are full-screen pages: Contents has 目录 and 书签 tabs, collapsible volumes, the current chapter highlighted and centred, filtering, and TXT rule, long-chapter, reverse, and length options; Search lists matches with their chapter, emphasized context, and position, and an opened result shows a bar for the previous or next match. The rule and encoding choices are dialogs. 界面 offers reading mode, page animation, and typography with immediate preview; the reader has no separate app-theme setting. Double-page mode falls back automatically in narrow viewports; chapter endings may leave unused space. Source switching and downloads remain under More when supported. Side taps, swipes, arrow keys, and Space turn a page/spread in paginated modes; scroll uses native vertical movement and viewport-sized keyboard navigation. Suppress reading shortcuts inside controls and while selecting text. One panel state owns the reader tools, and closing a panel restores focus without turning a page. Returning to the shelf is immediate while accepted writes continue in the application; real save errors use an unobtrusive retry notice. Detailed navigation and automatic-reading behavior belongs to [Reader](../subsystems/reader.md).

A contents selection navigates to that chapter. Reader layout changes follow the [locator contract](../subsystems/reader.md). Loading and sync indicators remain outside the text; remote progress produces a user-selectable action instead of an automatic jump.

RSS articles scroll continuously and show title, source, date, original link, and content. Preserve list position when returning from an article and retain selected columns on desktop. Content extraction and article-state behavior belong to [RSS](../subsystems/rss.md).

## States and accessibility

Design every screen together with its loading, empty, partial-failure, offline, and success states. Errors offer a relevant retry or recovery action while retaining usable content. Maintain visible keyboard focus, touch-accessible controls, understandable labels, and consistent back/dismiss behavior.

Each page specification includes the [motion contract](motion.md) alongside layout and states. UI components consume explicit data and event interfaces; they do not invent synchronization, storage, source, or AI behavior.

## Acceptance

Verify phone and desktop layouts, keyboard focus, touch controls, modal focus restoration, empty/error states, and preserved reading/list context. Evaluate motion and reduced-motion behavior using the cases owned by the motion specification.
