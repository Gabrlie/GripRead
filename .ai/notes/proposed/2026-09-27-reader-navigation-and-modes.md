# Chapter navigation and shared reading-mode state

Status: proposed

## Problem

The current [controller snapshot and presentation interface](../../../src/reader/types.ts) represent one measured page. The [controller](../../../src/reader/controller.ts) advances and saves one page per action, while [locator resolution](../../../src-tauri/src/storage.rs) accepts whole-book fractional progress; the controller only provides backward endpoint fallback at the end of the book. Chapters, spreads, and scrolling need one stable location and consistent operation ownership without making page components responsible for navigation or persistence.

## Proposal

### Chapters and bounded navigation

Derive half-open chapter ranges from accepted TOC starts and the verified content length in the reader domain. Add a preface before a nonzero first heading; an empty directory produces one whole-text range. An empty book has no navigable range. Keep starts in document order, deduplicate equal offsets, and reject incompatible book/version/resource metadata rather than presenting stale ranges. Cache the derived index only for its content version and accepted directory generation. TOC loading/failure leaves body reading available, with chapter controls unavailable until a valid index exists; a successful empty TOC enables whole-text navigation.

Current chapter follows the leading reading anchor. Previous/next chapter targets the adjacent range's start; reaching the first/last range disables the corresponding action. Whole-book jumps stay in Contents. Paginated layout respects chapter ends, allowing a short final page or a lone left page in a final spread; the next ordinary turn advances to the next chapter. Scrolling remains continuous across headings and derives the active chapter from the same anchor rule.

Add an exact absolute UTF-16 offset resolver alongside whole-book progress resolution. Its request carries the expected content version and resource identity, validates bounds, and uses the existing verified sparse index to floor a computed target to a Unicode scalar boundary and generate real locator context. Do not round-trip chapter offsets through `offset / totalLength`, subtract one UTF-16 unit blindly, or manufacture unchecked locators in the view. Rust declarations remain the binding source of truth.

Chapter progress below 100% maps within the range and anchors forward layout at the resolved location. A 100% action uses an explicit chapter-end navigation intent: read backward from the exclusive end, constrain layout to the chapter, and show its final page/spread; scroll aligns the chapter's end in the viewport without moving its leading anchor before the chapter start. Persist an actual visible-text locator inside the chapter rather than its exclusive boundary. The UI reports 100% when the terminal page/spread or scroll end is visible while that chapter remains active; otherwise progress uses the leading anchor. Clamp rounding below 100% until that terminal condition is true. Empty ranges never enter progress arithmetic.

At book end, scroll provides non-content trailing alignment space sufficient to place the last text line at the top of the reading viewport. This lets a short final chapter or a restored late locator remain the leading passage despite native scroll clamping. The spacer is bounded by one viewport, carries no locator, and contributes neither text length nor reading progress. Automatic reading stops when the final real text is visible rather than traversing the spacer.

Range-clipped display uses validated slices of bounded content windows while preserving absolute offsets and real whole-book metadata. It must not relabel a chapter as a different resource or silently replace `ContentWindow.totalLength` with its end. Normal page turns across chapter boundaries load adjacent content through the same navigation queue.

### Modes, anchors, and presentation

The controller owns the selected/effective mode, current reading anchor, chapter index, bounded content, and ordered saves. Its snapshot must represent a paginated viewport containing one or two measured pages, or a bounded scroll viewport, without separate persisted page numbers or scroll pixel positions. Presentation adapters receive a complete viewport transition and own no service calls or saved location. Existing single-page consumers migrate to this contract in one integration slice.

Default to single-page mode. A saved double-page choice becomes an effective single page below an application reading viewport width of 900 CSS px; widening restores two pages without changing the saved preference. Read that breakpoint from the viewport, not the current width-capped single-page text box. Measure columns using their real widths and gutter. A spread turn publishes and saves one anchor after preparing both sides, even when the spread crosses a content-window boundary. Do not implement it as two calls to the current `next()` method. Blank right columns have no content locator. On seek or reflow, the target becomes the first visible passage; do not snap it backward to a historical odd/even page index.

For scroll, identify the first visible text position with the existing UTF-16 locator. Retain a transient pixel delta only to stabilize that anchor during prepend, eviction, resize, and font changes; persist only the locator. Initially bound retained body content to three windows of at most 8192 UTF-16 units each, with at most one additional transient adjacent read, allowing the existing one-scalar boundary extension. Animation clones and measurement content have separate explicit limits. Loading, measuring, and position updates are coalesced; no whole-book DOM and no per-frame IPC saves. Under selection, defer recycling selected blocks and pause further loading if necessary to keep the bound.

Extend the shared renderer with a reliable mapping between rendered text nodes and absolute UTF-16 ranges. Adjacent windows inside one paragraph must remain visually continuous rather than inserting a new block break, indentation, or paragraph gap; retaining a whole unbounded paragraph is not an acceptable workaround. Keep this mapping and fragment handling common to highlighting, measurement, and visible rendering.

Use one save worker and exit flush across all modes. Scroll updates coalesce to the latest visible anchor; pause, leaving, or exit synchronizes the current viewport before flush. Seek, mode change, or content replacement invalidates stale reads and layout callbacks. Chapter-intent operations also capture the accepted directory generation: applying a new rule cancels older chapter seeks before they publish and rebuilds ranges around the current passage. A new user action targets the new index. Reflow waits behind accepted navigation and does not cancel the pending target. A failed adjacent read keeps the current viewport readable and exposes retry.

Single-page and double-page modes support the stored `instant`, `curl`, `slide`, and `fade` effects; the UI may label `instant` as no effect. Reduced motion uses instant presentation. Scroll disables page-turn effects without overwriting the selected effect. One adapter owns each animated property, and every interrupted transition settles its completion promise. Side taps/swipes and arrow/Page/Space shortcuts retain page/spread navigation in paginated modes; scroll uses native vertical interaction and viewport-sized Page/Space navigation, suppressing reading shortcuts in controls or selection.

Automatic page reading advances one effective page/spread per saved interval. Automatic scroll uses a separate validated CSS-pixel-per-second speed; propose 40 px/s initially with a 5–200 px/s range, declared once in Rust and exposed to controls. Movement uses elapsed visible-frame time without replaying suspended time. Both modes share session-local running state and the existing pause conditions, including mode changes, reflow, selections, controls, blur, errors, and exit. Automatic movement waits at an unloaded boundary, resumes only within the same active session after successful loading, and stops on failure or book end. Explicit user-started scrolling remains available with reduced motion; decorative transitions are disabled.

## Alternatives considered

Calling single-page navigation twice for a spread would publish and save an intermediate page and can expose half a spread on read failure. Treating scrolling as an oversized measured page would retain page-start saves and miss the actually visible passage. Separate controllers with separate save queues would race during mode switches and exit. Keep mode-specific layout logic under one navigation and persistence owner instead.

Reusing whole-book fractional progress for chapter targets is smaller at the service surface but introduces rounding and version-validation ambiguity and cannot express an exclusive chapter end. Fabricating end minus one offsets can split emoji. The additive exact resolver and bounded endpoint operation keep these responsibilities explicit without replacing the existing content protocol.

## Acceptance criteria

The [Batch 2 task](../../plans/2026-09-27-reader-batch-2.md#acceptance-criteria) exercises chapter boundaries, atomic spreads, responsive fallback, scroll anchoring and budgets, stale operations, persistence, and automatic-reading failures through their actual consumers. All modes use unchanged persisted locator identities. Chapter-end navigation stays in its selected chapter; ordinary reading still crosses to the next one.

## Risks

Scroll anchoring and selection behavior require real WebKit evidence; jsdom layout substitutes are insufficient. The initial bounded-window and scroll-speed choices need native validation without relaxing the no-full-book-render contract. Chapter-end layout intentionally leaves unused page space, and the double-page adapter must not repeat the lone final page. Shared controller changes have many test/helper consumers, so interface migration must precede parallel feature implementation. This proposal remains unimplemented until those paths and compatibility cases pass acceptance.
