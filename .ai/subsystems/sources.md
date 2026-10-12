# Legado source compatibility

Status: planned

## Scope

Implement Legado text-source behavior after the local reading milestone. Legado compatibility is the objective; ColorTxt supplies implementation references, not an alternative source format. Standard RSS remains in its [own module](rss.md).

## Interfaces

`SourceService` (in the [service contracts](../../src/services/contracts.ts)) lists, imports (preview first, then the chosen sources), edits, groups, orders, switches, exports, debugs, logs in to, and checks sources; debug lines and check progress arrive as `source-debug` and `source-check` events. Storage keeps each source's original JSON with unknown fields preserved, plus columns for sorting and filtering; `lastUpdateTime` decides whether an import is an update. Imports accept files, URLs, and pasted JSON, single sources or arrays; only text sources are imported, and the others are counted as skipped. The source cache (script `cache`, source variables, login information and headers) and the cookie jar are local tables that never leave the device.

Report imported-but-unverified sources separately from runtime results. A capability can be supported, partially supported, unsupported, or unverified. Network failure is distinct from an unsupported rule. A successful import is not proof that search or chapter extraction works. A check records Legado's failure groups (网站失效, js失效, 校验超时, 搜索失效, 发现失效, 详情失效, 目录失效, 正文失效) and an error comment, and clears them when a later check succeeds.

## Behavior

### Reference and compatibility method

Use [ColorTxt's source documentation](https://github.com/ssnangua/ColorTxt/blob/main/docs/%E4%B9%A6%E6%BA%90%E6%89%BE%E4%B9%A6.md) and the [Legado MD3 implementation](https://github.com/HapeLee/legado-with-MD3) to map observable semantics. At implementation time record the exact upstream revision used in the source-stage task; use controlled fixtures rather than mutable live sites as the acceptance oracle.

ColorTxt separates `webBook` orchestration, `AnalyzeRule` extraction, `AnalyzeUrl` request construction, and script host extensions. Follow that separation while adapting platform services to Tauri. Its Node execution and async-call rewriting are not drop-in Tauri components.

Cover common CSS/Jsoup behavior, XPath, JSONPath, regex replacement, variables, templates, composite rules, pagination, script bindings, and HTTP/cache methods. Prioritize complete search-to-content chains. Expand the matrix with evidence; do not claim universal compatibility or a percentage without a defined sample set.

Arbitrary Java classes, Android-only APIs, and complex WebView login are not initial compatibility guarantees. Missing behavior must be reported explicitly; placeholder return values must not masquerade as supported functionality.

### Runtime

The engine lives in `src-tauri/src/sources/` and runs scripts in QuickJS with blocking host calls, as recorded in the [engine decision](../notes/implemented/2026-10-11-source-engine.md). ColorTxt's Node execution and asynchronous rewriting are not used. Rule execution runs outside the UI thread with bounded memory, a deadline, request timeouts, and cancellation. Source scripts receive only declared host capabilities: requests through the source's rules, the source's cache, cookies, and login state, and Jsoup-style elements. They get no arbitrary files, database access, or UI IPC. Script-level synchronous HTTP semantics are unrelated to WebDAV synchronization.

### Capability status

| Capability | Status |
| --- | --- |
| Default (Jsoup) rules, `@CSS:`, index and exclusion suffixes, extractors | supported |
| XPath with JsoupXpath's `text()`, `allText()`, `html()`, `outerHtml()` | supported |
| JSONPath, `{$.…}` inner rules, `{{…}}` templates, `@put`/`@get`, `$N` groups | supported |
| `##` replacements, `:` all-in-one regex lists, `&&`/`||`/`%%` | supported |
| URL options (method, body, headers, charset, type, js, retry), GBK and `escape` encoding, page lists, `data:` URLs | supported |
| Cookie jar, request rate, login headers, `loginCheckJs` | supported |
| `java.*` network, encoding, hashing, AES/DES/3DES, time, and rule calls; `source`, `cookie`, `cache` | supported |
| Search, explore, details (`init`, `canReName`), contents (pagination, `formatJs`, `preUpdateJs`), content (pagination, `replaceRegex`, `title`, `sourceRegex`) | supported |
| `webView` fetching, `java.webView`, browser verification, captchas | unsupported, reported as such |
| Font decryption (`queryTTF`), local files, archives | unsupported, reported as such |
| Images in chapter text | not shown; images are dropped from the text |

### Acquisition and source changes

Search asks every chosen source with up to eight at a time and a 30-second limit per source, and streams `online-search` events whose results are merged as Legado's `SearchModel` does: same name and author fold into one result with each source's copy, exact matches of the key first, then results containing it, each by source count, then the rest unless 精准搜索 is on. A source named in the scope is searched even when disabled. Details, contents, and chapter text are separate steps with a 90-second limit; a details page that also lists the contents is kept briefly so the next step does not fetch it again. Covers are fetched through the source's URL rules so headers and cookies apply.

Return search results progressively by source; one failing source does not erase others. Chain details, table of contents, and chapter retrieval through explicit book context. Persist sanitized chapters in local cache, support update checks and source switching, and respect per-source request concurrency.

Source switching preserves `Book` identity, then maps chapters using old/new tables of contents and text context. If uncertain, keep the prior position and present the nearest candidate with an explanation. Do not assume matching chapter numbers or URLs prove equivalence.

Source configuration can participate in [Sync](sync.md), but credentials and login state remain local. Preserve imported configuration locally while excluding embedded secrets from exported or replicated data.

## Acceptance

- Exercise single/array import and controlled HTML, JSON, selector, regex, variable, and pagination fixtures through search, details, contents, and chapter retrieval.
- Check POST options, encoding, cookies, script return values, error propagation, cancellation, timeouts, and stale-result handling through the real adapter.
- Record platform-specific compatibility results; verify advanced unsupported capabilities fail clearly.
- Verify changing sources preserves identity and handles uncertain chapter mapping without silent jumps.
