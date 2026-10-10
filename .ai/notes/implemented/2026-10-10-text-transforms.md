# Text transforms: replace rules and Chinese conversion

Status: implemented

## Problem

Legado applies replace rules (替换净化) and simplified/traditional conversion (简繁转换) to chapter text before display. GripRead's positions, search, chapter detection, and bookmarks all address the managed normalized text by UTF-16 offset, and the renderer relies on rendered text equalling that slice. Changing the text only at display time would split those coordinates.

## Decision

Transforms are applied to the stored text by the existing re-decode job: the managed text is `apply(decode(source, encoding), spec)`. The spec (the book's enabled, in-scope rules in order, then the style's conversion) is stored per asset in `txt_assets.transform_json` (schema 12; `NULL` is the identity), so every path that reproduces the managed text from retained bytes (re-decode relocation, re-association, duplicate repair) applies the stored spec. Rules run on each line with Java replacement syntax translated for the regex crate; invalid or runaway expressions leave a line unchanged. Positions and bookmarks map through the old spec back to decoded text, across decodings, then forward through the new spec; offsets inside a changed line map proportionally and snap to a character boundary. The reader asks Rust to apply transforms when a book opens, after the rule list closes with changes, after the per-book switch, and after the conversion changes. Conversion uses OpenCC's character and phrase tables (Apache-2.0, bundled with their licence) reduced to entries that keep the UTF-16 length, so conversion never moves offsets.

## Alternatives considered

Display-time replacement with hidden originals kept offsets but broke canvas page-turn copies, selection, and measurement. The `zhconv` crate converts more phrases but is GPL-2.0-or-later, which would decide the project's licence; it was not adopted. Title-only Legado rules would need the chapter rule in effect when the text was produced, which can change, so they are not imported.

## Consequences

Changing rules rewrites a book's managed text and content version once, then reading, search, and the directory use the transformed text. Duplicate detection still matches the retained source hash. Conversion is character- and phrase-based without variant-specific regional vocabulary.
