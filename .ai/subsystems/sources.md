# Legado source compatibility

Status: planned

## Scope

Implement Legado text-source behavior after the local reading milestone. Legado compatibility is the objective; ColorTxt supplies implementation references, not an alternative source format. Standard RSS remains in its [own module](rss.md).

## Interfaces

`SourceAdapter` exposes source import, search, book details, table of contents, chapter content, update checks, and capability reports. Persist original source JSON separately from normalized metadata. Accept files, URLs, and pasted JSON, including single sources and source arrays; preserve unknown configuration fields.

Report imported-but-unverified sources separately from runtime results. A capability can be supported, partially supported, unsupported, or unverified. Network failure is distinct from an unsupported rule. A successful import is not proof that search or chapter extraction works.

## Behavior

### Reference and compatibility method

Use [ColorTxt's source documentation](https://github.com/ssnangua/ColorTxt/blob/main/docs/%E4%B9%A6%E6%BA%90%E6%89%BE%E4%B9%A6.md) and the [Legado MD3 implementation](https://github.com/HapeLee/legado-with-MD3) to map observable semantics. At implementation time record the exact upstream revision used in the source-stage task; use controlled fixtures rather than mutable live sites as the acceptance oracle.

ColorTxt separates `webBook` orchestration, `AnalyzeRule` extraction, `AnalyzeUrl` request construction, and script host extensions. Follow that separation while adapting platform services to Tauri. Its Node execution and async-call rewriting are not drop-in Tauri components.

Cover common CSS/Jsoup behavior, XPath, JSONPath, regex replacement, variables, templates, composite rules, pagination, script bindings, and HTTP/cache methods. Prioritize complete search-to-content chains. Expand the matrix with evidence; do not claim universal compatibility or a percentage without a defined sample set.

Arbitrary Java classes, Android-only APIs, and complex WebView login are not initial compatibility guarantees. Missing behavior must be reported explicitly; placeholder return values must not masquerade as supported functionality.

### Runtime selection

The source stage selects the JavaScript engine and bridge using fixture results on target platforms. QuickJS-NG through rquickjs remains a candidate, not a settled dependency. Compare a synchronous host bridge with any proposed async transformation against Legado's observable return values, scope, errors, and ordering before choosing.

Do not introduce a Node sidecar or Electron dependency merely to copy ColorTxt. Rule execution runs outside the UI thread with bounded memory, execution time, network timeout, and cancellation. Source scripts receive only declared host capabilities, not arbitrary files, database access, or UI IPC. Script-level synchronous HTTP semantics are unrelated to WebDAV synchronization.

### Acquisition and source changes

Return search results progressively by source; one failing source does not erase others. Chain details, table of contents, and chapter retrieval through explicit book context. Persist sanitized chapters in local cache, support update checks and source switching, and respect per-source request concurrency.

Source switching preserves `Book` identity, then maps chapters using old/new tables of contents and text context. If uncertain, keep the prior position and present the nearest candidate with an explanation. Do not assume matching chapter numbers or URLs prove equivalence.

Source configuration can participate in [Sync](sync.md), but credentials and login state remain local. Preserve imported configuration locally while excluding embedded secrets from exported or replicated data.

## Acceptance

- Exercise single/array import and controlled HTML, JSON, selector, regex, variable, and pagination fixtures through search, details, contents, and chapter retrieval.
- Check POST options, encoding, cookies, script return values, error propagation, cancellation, timeouts, and stale-result handling through the real adapter.
- Record platform-specific compatibility results; verify advanced unsupported capabilities fail clearly.
- Verify changing sources preserves identity and handles uncertain chapter mapping without silent jumps.
