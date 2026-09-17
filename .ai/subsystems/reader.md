# Reader

Status: planned

## Scope

Parse TXT and DRM-free reflowable EPUB, render normalized chapters, and support offline reading, navigation, search, and bookmarks. Online chapters enter through the same content interface. Screen layout and default typography belong to [interaction design](../design/interaction.md).

## Interfaces

`ReaderLocator` identifies a chapter or EPUB resource, text offset, and surrounding text context within a book's content version. It is independent of device page numbers. The library's `Book` identity links locators and bookmarks to the same work; a changed file or source content does not silently reuse an incompatible position.

Rust supplies normalized chapter content, resource references, text search, and persisted positions. The frontend reader measures WebView fonts and viewport dimensions, paginates normalized content, maps displayed passages to locators, and handles selection. Both sides use the same locator semantics. The M0 TXT implementation normalizes line endings to LF and measures offsets in UTF-16 code units, rejecting offsets inside a surrogate pair; its generated Rust-to-TypeScript declarations are the IPC source of truth.

Keep these interfaces sufficient for future read-only content retrieval; do not add embedding or generation services to the reading path. The M0 implementation exercises the serialization and offset rules through Rust tests and typed IPC; later EPUB/source resources must preserve the same locator contract.

## Behavior

Novels default to pagination with page-curl, slide, and instant effects, plus an optional scrolling mode. StPageFlip is the planned page-curl adapter: it receives already paginated content and owns neither text parsing nor persisted positions. General interface transitions follow [motion design](../design/motion.md).

Changing fonts, size, orientation, viewport, or single/double-page layout reflows from the text locator. Cross-chapter turns must preserve content without missing or repeating text. Retain only the required reading window in the DOM; a large novel must not be rendered in full.

Load local content first. Missing resources produce actionable loading or failure states without discarding readable content. Persist position independently of animation completion. Selection temporarily disables page-turn gestures. Reader search and bookmarks use content positions, not display pages.

Clean EPUB and source markup before rendering; scripts and application IPC are not exposed to imported content. Resolve book resources through the file/content adapter rather than arbitrary paths supplied by markup. Image loading and late font availability must not silently move the reading position.

## Acceptance

- Read a million-character TXT and an illustrated EPUB without mounting the entire book in the DOM.
- Turn across chapter boundaries in every reading mode without dropped or duplicated text.
- Change typography, orientation, window size, and page count, then reopen at the same passage.
- Exercise touch, keyboard navigation, selection, search, bookmarks, missing images, malformed content, and offline reopening.
- Replace the content version and verify position recovery reports uncertainty rather than silently selecting an unrelated passage.
