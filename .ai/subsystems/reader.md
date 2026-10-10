# Reader

Status: planned

## Scope

Parse TXT and DRM-free reflowable EPUB, render normalized chapters, and support offline reading, navigation, search, and bookmarks. Online chapters enter through the same content interface. Screen layout and default typography belong to [interaction design](../design/interaction.md). The current TXT mode work is tracked in the [active plan](../plans/2026-09-27-reader-batch-2.md); EPUB remains planned.

## Interfaces

`ReaderLocator` identifies a chapter or EPUB resource, text offset, and surrounding text context within a book's content version. It is independent of device page numbers. The library's `Book` identity links locators and bookmarks to the same work; a changed file or source content does not silently reuse an incompatible position.

Rust supplies normalized chapter content, resource references, text search, and persisted positions. The frontend reader measures WebView fonts and viewport dimensions, paginates normalized content, maps displayed passages to locators, and handles selection. Both sides use the same locator semantics. The M0 TXT implementation normalizes line endings to LF and measures offsets in UTF-16 code units, rejecting offsets inside a surrogate pair; its generated Rust-to-TypeScript declarations are the IPC source of truth.

Keep these interfaces sufficient for future read-only content retrieval; do not add embedding or generation services to the reading path. The M0 implementation exercises the serialization and offset rules through Rust tests and typed IPC; later EPUB/source resources must preserve the same locator contract.

## Behavior

TXT defaults to single-page reading, with double-page and continuous-scroll modes available. Paginated screens contain only one chapter; an odd final spread leaves its right column empty, and the next turn enters the next chapter. Below 900 CSS px the selected double-page mode displays one page without changing the saved preference. Instant, curl, slide, and fade effects operate on the complete visible page/spread; StPageFlip owns curl and Motion owns slide/fade. Adapters own neither content loading nor saved positions. Scroll retains the selected effect for returning to pagination. General interface transitions follow [motion design](../design/motion.md).

Changing fonts, size, orientation, viewport, or single/double-page layout reflows from the text locator. Toolbar visibility and panel changes overlay stable page geometry and do not repaginate or alter the saved passage. Cross-chapter turns must preserve content without missing or repeating text. Retain only the required reading window in the DOM; a large novel must not be rendered in full.

Load local content first. Missing resources produce actionable loading or failure states without discarding readable content. Persist position independently of animation completion. Selection temporarily disables page-turn gestures. Reader search and bookmarks use content positions, not display pages.

Clean EPUB and source markup before rendering; scripts and application IPC are not exposed to imported content. Resolve book resources through the file/content adapter rather than arbitrary paths supplied by markup. Image loading and late font availability must not silently move the reading position.

For TXT, build directory entries from heading lines in the existing text and preserve document order and UTF-16 text locations. Support automatic recognition, built-in heading presets, and a per-book custom Rust regular expression, with preview, apply, and restore-default actions. Preview reports matched titles and locations but does not change the saved rule; invalid expressions keep the active directory and show an inline error, while zero matches provide full-text navigation. Applying a rule rebuilds only directory metadata: it does not rewrite the body, change book identity or content version, or invalidate bookmarks and search positions. Version directory caches by content version and rule revision, deduplicate concurrent builds for the same key, and reject stale previews/builds after a newer choice. Encoding changes continue through the established content-version and verified-position relocation path, then rebuild rule-derived metadata for the new version.

Directory generation must not rescan the entire TXT once for every matched chapter. Build chapter locations in work proportional to the text and matches, independently from first-page rendering and shelf usability; benchmark cold and warm uncached cases with dense headings to verify the improvement.

Derive chapter ranges from accepted TOC positions, including a preface and whole-text fallback. Current chapter follows the leading visible locator. Chapter progress seeks resolve exact UTF-16 offsets through Rust; 100% reads backward from the exclusive chapter end and displays the terminal page/spread without entering the next chapter. Progress stays at 100% while that end is visible. A directory generation change cancels old chapter-targeted requests and retains the current passage. TOC loading never blocks body rendering.

Scroll renders at most three adjacent bounded windows and allows one transient read. Prepend and eviction preserve a visible text anchor; text-node mappings exclude hidden LF separators from visible anchors, and window boundaries do not introduce paragraph breaks. Selection defers recycling selected text. A bounded non-content spacer at EOF permits short final chapters and late locators to align at the viewport top. The spacer has no locator or progress contribution. Save the first visible UTF-16 position periodically during scrolling and synchronize it before leaving or exit; pixel adjustments are temporary layout state only.

Automatic reading uses the same controller and session pause state across modes. Paginated reading advances one page/spread per saved interval; continuous reading uses a separately saved CSS-pixel speed, with defaults and bounds owned by the Rust preference declarations and generated bindings. It waits for page/window completion before the next interval, never overlaps turns, and pauses for manual reading interaction, controls or panels, text selection, blur/background, content replacement, reflow, encoding changes, navigation failure, or the final visible text. It never resumes after reopening or replays elapsed background time. Explicit automatic scrolling remains available with reduced motion, while decorative transitions are disabled.

## M0 implementation contract

TXT is one resource named Full text; content windows do not create chapters. Forward windows begin at their locator; backward windows end exclusively at it. Both reject surrogate-pair splits. Paginated layout measures each column using actual WebView typography and dimensions. Chapter slices preserve absolute offsets and whole-book length. Previous-page/spread navigation after restart reads backward instead of relying on session history.

Navigation is serialized within a session; seeks invalidate stale targets, and reflow queues behind accepted navigation. Complete spreads publish and save once. The application owns ordered/coalesced position writes across reader views; returning to the shelf cancels unshown navigation and immediately leaves while accepted writes continue. Reopening uses the latest session locator before a slow write finishes; encoding replacement clears that cache and uses the relocated backend position. Save failures retain their value and offer non-modal retry. Explicit save, native exit, and the document becoming hidden (Android pause) drain pending writes; exit ends animation without waiting for its duration. Reduced motion uses instant presentation, and selection, controls, and dialogs suppress reading gestures.

Supported preferences use the settings service and persist in SQLite. Theme follows live system changes when selected. Basic reading uses system fonts, local SVG icons, and local cover placeholders without remote asset requests.

## Acceptance

- Read a million-character TXT and an illustrated EPUB without mounting the entire book in the DOM.
- Build TXT directories for Chinese, English, and numeric headings, custom rules, invalid rules, and no matches; preview cancellation and per-book rule changes preserve body text, content identity, and reader positions.
- Verify directory cache invalidation and stale-result rejection after rapid rule changes or encoding correction, and show that TOC work no longer performs a full-text scan per chapter.
- Turn across chapter boundaries in every reading mode without dropped or duplicated text.
- Run automatic turning at its default and a changed interval, verify each pause condition, and confirm reopening never starts it automatically.
- Change typography, orientation, window size, and page count, then reopen at the same passage.
- Exercise touch, keyboard navigation, selection, search, bookmarks, missing images, malformed content, and offline reopening.
- Replace the content version and verify position recovery reports uncertainty rather than silently selecting an unrelated passage.
