# Reader preferences v2 and managed display assets

Status: proposed

## Problem

Reader preferences hold only theme, paper tone, font size, line height, font family, page effect, and automatic interval. The requested reading modes and PixNovel-equivalent settings need nested typography, margin, information, and background data, plus imported fonts and background images that must outlive restarts without mixing with book content caches.

## Proposal

Extend the single `reader_preferences` JSON record with defaulted nested fields so old records deserialize with their existing values. Values are validated against bounds declared once in Rust and exported to the frontend through generated bindings. Old out-of-range line heights are clamped during migration rather than rejected.

Schema 9 adds `reader_assets` metadata for fonts and background images stored under the managed `assets/` directory, and user background definitions. Orphan cleanup includes these references. Deleting an asset updates any preference that references it in the same operation. Assets are display-only and never participate in book identity or content versions.

## Alternatives considered

Storing assets as base64 inside preference JSON would make every setting save rewrite large blobs. Keeping PixNovel's configuration-file ranges would create a second, manually synchronized source of bounds. Storing assets beside book caches would expose them to cache cleanup.

## Acceptance criteria

Schema 8 data (books, content versions, directory rules, bookmarks, positions, preferences) survives migration. Old preferences keep size, line height, font, theme, and page effect. Asset import rejects unsupported formats; deleting a referenced asset leaves a valid preference.

## Risks

Nested preference growth increases save size; saves are debounced. A font that loads in the import check can still fail in WebKit later; loading failures keep the current font and report the error.
