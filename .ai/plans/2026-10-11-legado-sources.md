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

Next is S4, online books on the shelf and in the reader.
