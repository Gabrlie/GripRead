# Reader preferences v2 and managed display assets

Status: implemented

## Problem

Reading preferences covered only theme, paper tone, font size, line height, a font family, the page effect, reading mode, and automatic-turn timing. Legado-style reading needs colour presets with day and night variants, finer typography, margins, header and footer information, chapter title styling, platform controls, configurable tap zones, and imported fonts, without losing existing saved preferences.

## Decision

Keep the single `reader_preferences` JSON record and add one nested `style` object with serde defaults, so records saved before it load with Legado-derived defaults. `style` holds Legado 3.26.7's six colour presets (each with day and night background and text), the selected preset, letter and paragraph spacing, indent, body weight, title mode and scale, body margins, header and footer slots (time, battery, chapter or book title, chapter or book progress), an optional managed font, keep-screen-on, hidden system bars, volume-key paging, and nine tap-zone actions. Bounds and colour formats are validated in Rust; the defaults are declared once in Rust and exported to the page as `DEFAULT_READING_STYLE` in the generated bindings. Night follows the application theme, and the menu's day/night toggle changes that theme; the reader no longer has its own theme setting.

Schema 9 (see the [chapter rules decision](2026-10-10-legado-txt-chapter-rules.md)) adds `reader_assets`. Imported fonts are recognised by their TrueType, OpenType, collection, or WOFF signature, copied into managed `assets/fonts`, and delivered to the page as raw bytes over IPC, where a `FontFace` registers them. Deleting a font clears it from saved preferences in the same transaction. Startup removes files under `assets/` that no record references. Assets never affect book identity or content versions.

## Alternatives considered

Separate preference tables per feature would have needed a migration for every later setting and split one user choice across records. Background images, as Legado offers, were deferred: they need cropping, memory limits on Android WebView, and rasterization rules for page turns. Serving fonts through the Tauri asset protocol would have required widening its filesystem scope; raw IPC bytes keep access limited to recorded assets.

## Consequences

Old preference JSON keeps its values and gains the defaults; invalid values are rejected rather than reset. Typography, margins, information bars, and title styling are part of the pagination signature, so changing them re-measures from the current locator. Chapter headings are marked identically for measuring, visible pages, scrolling, and page-turn overlays. A font the browser cannot decode leaves the previous font in use and reports the failure.
