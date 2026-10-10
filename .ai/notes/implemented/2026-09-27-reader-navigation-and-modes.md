# Chapter navigation and shared reading-mode state

Status: implemented

## Problem

The original reader represented one measured page and persisted from a view-owned queue. Chapter navigation needed exact character boundaries; two single-page turns would expose an intermediate spread; continuous scrolling needed the visible text position rather than a page or pixel offset. Slow writes also delayed returning to the shelf and reopening.

## Decision

Keep one [controller](../../../src/reader/controller.ts) for chapter ranges, bounded text, navigation ownership, and the active locator. Its [snapshot and presentation contracts](../../../src/reader/types.ts) describe visible pages/spreads and bounded scroll content. [Chapter derivation](../../../src/reader/chapters.ts) consumes accepted TOC positions; no second chapter table or content resource is introduced. [Reader](../../subsystems/reader.md) owns chapter boundaries, 100% behavior, responsive fallback, scrolling, and automatic reading semantics.

Add a version/resource-checked exact-offset resolver to the existing [Rust model](../../../src-tauri/src/models.rs) and [service port](../../../src/services/contracts.ts), reusing the verified sparse index and UTF-16 boundary handling. Keep `ContentWindow` and persisted `ReaderLocator` formats unchanged. Add defaulted mode and automatic scroll speed preferences and extend page effects without a database migration. Asset tables and schema 9 remain part of the [later preference/asset decision](2026-09-24-reader-preferences-v2-and-assets.md).

The application owns a shared [position writer](../../../src/reader/positions.ts), optimistic latest locations, and pending accepted reader writes. Views release layout/presentation immediately on return to the shelf, while durable writes continue. Explicit save and native exit drain those writes. Actual failures retain the latest value and expose retry through the existing application UI. Encoding replacement clears the optimistic locator cache so backend relocation remains authoritative.

Use the same paragraph renderer for visible text, measurement, and animation clones. Scroll maps visible DOM text to UTF-16 locations and stabilizes it during bounded window insertion/recycling. Hidden line-feed text preserves source slices but cannot become a visible anchor. Temporary pixel compensation and EOF alignment space are never persisted. Curl remains owned by StPageFlip; Motion animates outgoing clones for slide/fade and cancellation settles presentation immediately.

## Alternatives considered

Calling single-page navigation twice for a spread would publish/save an intermediate location and expose half a spread on read failure. Treating scroll as an oversized page would save the window start rather than the visible passage. Independent mode controllers or save queues would race during switching and exit. Reuse one navigation owner and one application-owned writer instead.

Whole-book fractional progress would introduce rounding and version ambiguity for chapter targets. Subtracting one UTF-16 unit at a chapter end can split an emoji. Exact offset resolution and backward endpoint layout preserve both the selected chapter and character boundaries.

## Consequences

Mode changes, reflow, search, bookmarks, and restart share locator identity. Paginated chapter boundaries intentionally allow a short page or blank right column; scroll remains continuous. Body rendering does not wait for TOC or settings persistence. Retained text and cloned presentation remain bounded independently of book length. WebView tests remain necessary for real column geometry, scroll anchoring, selection, and animation; verification evidence belongs in the [Batch 2 task](../../plans/2026-09-27-reader-batch-2.md).
