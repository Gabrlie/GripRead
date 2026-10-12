# Stage 5: Legado-compatible book sources

Status: in-progress

## Outcome

Find, follow, cache, and read online novels through Legado text sources (`bookSourceType` 0), with Legado-MD3 3.26.7 (`d28d3ed2`) as the behavior and layout reference and [ColorTxt](https://github.com/ssnangua/ColorTxt) at `a41095606d58` as the implementation reference. Behavior belongs to [Sources](../subsystems/sources.md), [Reader](../subsystems/reader.md), [Library](../subsystems/library.md), [Sync](../subsystems/sync.md), and [interaction design](../design/interaction.md).

## Scope

Milestones, each committed separately:

- (S1) A Rust rule engine in `src-tauri/src/sources/`: Legado rule analysis (Jsoup default syntax, CSS, XPath, JSONPath, regex, templates, variables), URL construction and HTTP with cookies, charsets, and request rates, a synchronous QuickJS host for `java.*` and the other script objects, and the search, explore, info, table-of-contents, and content chains, all against local fixtures.
- (S2) Source storage, import (URL, file, pasted JSON) with a preview, the 书源管理 page with Legado's sort, groups, and batch actions, the tabbed source editor, debugging, `loginUi` login, and source checking.
- (S3) Progressive multi-source search with Legado's merging, the 发现 tab, and the online book information page.
- (S4) Online books on the shelf and in the reader, one reader resource per chapter, chapter cache, pre-download, table-of-contents updates, and offline caching.
- (S5) 换源, sources and online books in backups, and progress sync for online books.

Excluded: `webView` fetching, `java.webView`, browser verification and captchas (they fail with an explicit unsupported error until a later round), audio and image sources, RSS, `exploreScreen`, reviews, 单章换源, and the web service.

## Interfaces

ColorTxt's files are MPL-2.0; GripRead reimplements the observed semantics and does not copy them. The engine choice is recorded with the S1 commit in a decision note. The minimum Rust version rises to 1.87 for `rquickjs`. New schema versions add source tables (S2) and online book and chapter tables (S4). `SourceService` joins the application services with generated bindings, preview services, and test mocks.

## Acceptance criteria

- Controlled fixture sites cover HTML, CSS, XPath, JSON, regex, GBK with POST, pagination, variables, scripts with `java.ajax` and cryptography, and login headers, through search, information, contents, and chapter text.
- Scripts are bounded by time, memory, and cancellation; an unsupported capability, network failure, script error, and empty result are reported distinctly.
- A searched book can be added to the shelf, read across chapter edges in page and scroll modes, updated, cached offline, and switched to another source without silent position jumps.
- The user's sample sources are recorded per source with their working stages and failure categories.

## Verification

S3: Rust tests for Legado's merge tiers and book and chapter conversion; frontend tests for search with merged results, opening a book, previewing chapters, keyword history, and the 发现 category list; phone screenshots of 发现, 搜索, the book page, and the preview. S2: Rust tests for import preview and merge, groups, order, switches, check records, cache expiry, login UI parsing, and debug and check runs against a fixture site; frontend tests for list logic, paste import with preview, filters, switches, batch deletion, checks, and the editor's tabs, JSON, and discard guard; phone screenshots of 书源管理 and the editor. S1: Rust tests for the DOM layer, each rule mode, URL encoding, the script host (completion values, jsLib, elements, crypto, unsupported calls, deadlines), and full chains through an in-process fixture server; Android clippy with the wrapper. Planned for later milestones: Rust tests for storage, checks, caching, updates, and source switching; frontend tests for the new pages and chapter-edge reading; Android APKs after S3 and after S5 with device checklists; `pnpm check` and Android clippy.

## Handoff

S1 is implemented on the host: the engine, the script host, and four fixture sites (HTML, JSON with scripts and AES, GBK with XPath, regex) pass search through content; cookies and request rates are covered. S2 is implemented: schema 16 source, cache, and cookie tables; import preview and merge; the 书源管理 page with filters, sorts, batch actions, and background checks; the tabbed editor; debugging; and `loginUi` login. S3 is implemented: progressive merged search with scopes, history, and 精准搜索; the 发现 tab with categories and paged lists; and the online book page with 换源 among results, contents, and chapter preview. The S3 device build was accepted for search and import. Follow-up fixes: 校验 can switch off failed sources, import moved into 更多, online contents open as their own page, and contents opened from a shelf detail page return there.

Compatibility sample: the user's published collection of 463 sources, 395 of them text sources (394 parsed), checked by the ignored `live_source_report` test on a host outside mainland China against live sites. The report runs Legado's check chain (search with `checkKeyWord` or 我的, details, contents, first chapter, and explore). After the fixes below, 188 sources complete search through content and 180 also pass explore. Of the rest: 22 need WebView, about 50 fail at the network (timeouts, unresolvable domains, refused or reset connections, HTTP 403/451 regional blocks), and most empty searches or contents inspected came from redesigned sites, expired tokens, anti-bot pages, or comic sources whose content is images. Mainland networks will reach more sites; the device check is the measure there. Engine fixes from the sample: Legado's desktop User-Agent by default; OkHttp-style percent-encoding of request addresses; `javax.crypto` (Cipher, SecretKeySpec, IvParameterSpec, Mac), `java.security.MessageDigest`, `java.util.Arrays`, and charset shims; `JavaImporter.importPackage` and top-level `importPackage`/`importClass`; `org.jsoup.Jsoup.connect`; `Element(s).remove()`; Java-style `toString` on JSON a rule hands to a script; Rhino bean properties on `source` and Legado's `Book` getters, setters, and `setReverseToc`; `response.raw().request()`; base64 `data:` bodies as hex; attribute order kept; JsoupXpath's element-relative paths; Jayway JSONPath forms; and script errors that name their location. Still open from the sample: RSA (`createAsymmetricCrypto`, `KeyFactory`), Jsoup pseudo-classes nested inside `:not()`, and `java.webView`.

S4 is implemented: schema 17 online books and chapters with a chapter cache, chapter-resource reading in page modes and chapter-by-chapter scrolling, the contents and in-book search for online books, background pre-download, 离线缓存, 更新目录 with new-chapter marks, the shelf and detail page for online books, 加入书架 and 阅读 from the online book page with the return to it, and the prompt when leaving a book that is not on the shelf. Verification: Rust tests for chapter windows, edges, version mismatch, contents, progress, search, cache, and dropping an unshelved book; controller tests for turning across chapter edges and 上一章/下一章; frontend tests for adding and reading from the online book page and for the reader's online contents, tools, and leave prompt.

S5 is implemented: 换源 from the reader and the detail page with Legado's chapter mapping for the position and bookmarks; backups with book sources and online books by chapter position, restored lazily when the contents are first fetched, with 书源 and 网络书籍 in the 恢复忽略列表; and progress sync for online books keyed by name and author. Verification: Rust tests for chapter numbers, titles, and matching; switching sources with the position and a bookmark; and a backup round trip that places the position after the contents arrive; a frontend test for the 换源 dialog.

Bug round 1 (device report on the S1–S5 build): an app log with 详细日志; gesture-bar insets on full-screen pages and the main tabs; 智能排序 by usability; 发现 without disabled sources; the online contents closing with the back gesture; 阅读记录 with an activity matrix and deleted books kept; generated cover titles that scale; the previous chapter paginated from its start; chapter buttons at resource edges; search naming chapters by resource; books read off the shelf keeping their place for 30 days; 换源 opening the matching chapter instead of the old text; an unread-chapter badge; kept covers, details, contents, and explore pages; candidates' latest chapters in 换源; merged search and details so covers survive; covers saved for shelf books; and 从书源选择 covers and details for any book. Verification: Rust tests for the log, retired books in the records, the 30-day cleanup, the caches, and search across chapters; controller tests for forward pagination of the previous chapter and for forgetting a position; frontend tests for the log page, smart sort, 发现, the back gesture, the records page, the activity matrix, 换源 latest chapters, and 从书源选择.

Next is device acceptance of this build.
