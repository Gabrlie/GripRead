# Decision: M0 IPC bindings and text locator

Status: implemented

## Problem

The first reading service needs one wire contract across Rust and TypeScript, while a persisted position must survive reflow and remain meaningful across Unicode text. Page numbers and JavaScript string indexes cannot provide that contract.

## Decision

Rust owns the serializable IPC models and uses `ts-rs` to generate checked-in TypeScript declarations. A generated barrel is checked by a non-mutating freshness command before application checks pass. M0 TXT content removes an optional UTF-8 BOM, converts CRLF and lone CR to LF, and measures `ReaderLocator.offset` in UTF-16 code units. Offsets between the two code units of a surrogate pair are rejected. The locator carries book ID, content version, resource ID, and surrounding context; display page numbers remain a frontend concern.

## Alternatives considered

Using hand-maintained TypeScript interfaces would allow the two IPC sides to drift. Using UTF-8 byte offsets would expose storage details to WebView consumers, while Unicode scalar indexes would disagree with JavaScript string positions. Persisting page numbers would become invalid when typography or viewport dimensions change.

## Consequences

Generated bindings must be refreshed when Rust models change, and the frontend consumes the generated barrel through its service adapter. The current TXT service can restore a passage after reflow and reports invalid or stale locators explicitly. EPUB resources and source-backed chapters must adopt the same locator semantics when their stages begin.
