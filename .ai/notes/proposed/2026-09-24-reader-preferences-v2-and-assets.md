# Reader preferences v2 and managed display assets

Status: proposed

## Problem

Reader preferences hold only theme, paper tone, font size, line height, font family, page effect, and automatic interval. The requested reading modes and PixNovel-equivalent settings need nested typography, margin, information, and background data, plus imported fonts and background images that must outlive restarts without mixing with book content caches.

## Proposal

Extend the single `reader_preferences` JSON record with defaulted nested fields so old records deserialize with their existing values. Values are validated against bounds declared once in Rust and exported to the frontend through generated bindings. Old out-of-range line heights are clamped during migration rather than rejected.

Deliver this incrementally. [Batch 2](../../plans/2026-09-27-reader-batch-2.md) adds defaulted reading mode and automatic scroll speed to the current record and extends page effects with slide/fade. Preserve existing fields and the serialized `instant`/`curl` values; absent mode defaults to single-page. Responsive fallback and automatic running state are transient. The broader nested typography/margin/information migration belongs to later batches and must not reset existing values or silently hide malformed records.

Schema 9 adds `reader_assets` metadata for fonts and background images stored under the managed `assets/` directory, and user background definitions. Orphan cleanup includes these references. Deleting an asset updates any preference that references it in the same operation. Assets are display-only and never participate in book identity or content versions.

Keep schema 8 during the additive Batch 2 settings change; create schema 9 only with the asset tables in Batch 3. These are distinct compatibility steps and require their own old-record tests.

## Alternatives considered

Storing assets as base64 inside preference JSON would make every setting save rewrite large blobs. Keeping PixNovel's configuration-file ranges would create a second, manually synchronized source of bounds. Storing assets beside book caches would expose them to cache cleanup.

## Acceptance criteria

Schema 8 data (books, content versions, directory rules, bookmarks, positions, preferences) survives migration. Old preferences keep size, line height, font, theme, and page effect. Asset import rejects unsupported formats; deleting a referenced asset leaves a valid preference.

## Risks

Nested preference growth increases save size; saves are debounced. A font that loads in the import check can still fail in WebKit later; loading failures keep the current font and report the error.
