# Complete TXT reader modes and reading settings

Status: completed

## Outcome

Deliver single-page, double-page, and continuous-scroll TXT reading with chapter-relative progress, and the complete reading settings defined by PixNovel at revision `db2f9be`: typography, text effects, sectional margins, backgrounds, header/footer information, and toolbar styling. Behavior belongs to [Reader](../subsystems/reader.md), [interaction design](../design/interaction.md), and [motion design](../design/motion.md); update those owners with each batch.

Typography preferences are global. The bottom progress row becomes previous chapter, chapter-relative progress, and next chapter; whole-book jumps use Contents. A compact header (current chapter) and footer (chapter progress and time) are shown by default. The three top-right and four bottom actions remain unchanged. Delivery is macOS desktop and narrow-window acceptance.

## Scope

Batches are executed and committed in order:

1. Unified paragraph rendering and locator foundation: paragraph slices with UTF-16 positions, one renderer shared by the visible page, measurement box, and page-turn overlay, reflow from the text locator, reader view decomposition, and debounced preference saves (800 ms) with flush on panel close, leaving, and exit.
2. Chapter ranges and reading modes: preface and whole-text fallbacks, chapter-relative progress and navigation, double-page spreads with a narrow-window single-page fallback below 900 px, bounded continuous scrolling, none/curl/slide/fade effects, and automatic reading by page, spread, or scroll speed. The [Batch 2 execution plan](2026-09-27-reader-batch-2.md) includes the Batch 1 review repairs and the ordered delivery slices.
3. Complete typography, margins, and backgrounds with managed font and image assets.
4. Information bars, chapter title styling, chapter page counts, battery state, and toolbar styles.
5. Integrated performance, native, and visual acceptance.

EPUB, online content, Android/Windows acceptance, and cross-platform release remain excluded. Allowed areas are `src/reader`, `src/components/Reader`, `src/application`, `src/services`, generated types, reader style tokens, Rust model/storage/command modules plus new asset and power modules, their verification areas, and owning `.ai` documentation.

## Interfaces

`ReaderPreferences` gains reading mode, typography effects, sectional margins, information configuration, background references, and automatic scroll speed; Rust declarations and generated TypeScript change together, and old preference JSON keeps its existing values. The content window gains no new fields; paragraph boundaries are derived in the frontend from normalized LF text. All modes share `ReaderLocator`. Storage advances additively from schema 8 to schema 9 for asset metadata as recorded in the [proposed decision](../notes/proposed/2026-09-24-reader-preferences-v2-and-assets.md). Fonts and backgrounds affect display only; typography, rule, and mode changes never re-import text or create a content version.

## Acceptance criteria

- Switching modes, adjusting typography, and restarting return to the same passage.
- Long paragraphs, consecutive blank lines, Chinese, English, and emoji crossing pages and windows show no missing, repeated, or wrongly indented text.
- Chapter progress and previous/next chapter work for preface, no directory, single chapter, final chapter, and directory rule changes; 100% stays at the chapter end.
- Odd final double-page spreads, narrow-window fallback, scroll loading/recycling, and automatic reading across windows remain continuous.
- Damaged fonts, missing assets, cancelled background creation, failed preference saves, and exit retry have recoverable results.
- 1, 10, and 50 MiB books never mount the full text and never re-import for layout changes.

## Verification

Planned per batch: `pnpm check`; `pnpm tauri build --debug` and affected native phases for native behavior; desktop, narrow, and reduced-motion screenshots for UI batches. Results are recorded below as batches complete.

### Batch 1 results

One renderer (`src/reader/render.ts`) turns each LF-delimited line into a paragraph, keeps line feeds as hidden text so `textContent` equals the page slice, and marks pages that start mid-line as continued (no first-line indent). The measurer, visible page, and page-curl clones all use it; indent and paragraph gap are CSS variables applied to paragraphs. The reader view is split into toolbar, surface, page text, layout, panel, search, tools, and action modules with one panel stack. Reader preferences preview immediately and save after 800 ms, with flush on Settings close, leaving, and exit.

Review found that a layout reflow could supersede a pending seek; reflows now queue behind navigation and only a newer reflow supersedes them (regression test added). The native highlight check now re-queries the DOM because paragraphs are replaced on seek.

`pnpm check` passes (122 frontend, 64 Rust tests). `pnpm test:native` passes all phases on macOS. Desktop and phone-sized presentation captures match the previous layout.

Subsequent review identified three regressions: overlapping highlights disappear on a following page when their local start is negative, an in-flight settings save can bypass a newer debounce interval, and Contents loses its mode selection on close. Review reran 122 frontend tests, TypeScript, and dependency checks successfully and independently reproduced the first two defects; native acceptance was not rerun.

These are repaired: the page text clips a highlight to its visible slice, a write that finishes while a newer edit is still inside its inactivity delay leaves that edit to its timer (explicit flush still drains at once), and the reader view owns the Contents tab for the current book. Regression tests cover a match crossing a page boundary, a slow write followed by an edit with and without flush, and reopening Contents; each fails on the previous code. Frontend tests (126), both TypeScript projects, formatting, and dependency boundaries pass. The full `pnpm check`, Rust tests, and native acceptance were not rerun for these frontend-only repairs.

## Handoff

Closed after Batch 2. Batches 1 and 2 are delivered; the [Batch 2 record](2026-09-27-reader-batch-2.md#verification) contains chapter/mode behavior, persistence and WebKit fixes, and native/visual evidence. On 2026-10-10 the user replaced the PixNovel reference with legado-with-MD3 tag `3.26.7`, so Batches 3–5 are superseded by the Legado-style reader rework rather than delivered here. The proposed [preferences and assets decision](../notes/proposed/2026-09-24-reader-preferences-v2-and-assets.md) will be revised for that rework.
