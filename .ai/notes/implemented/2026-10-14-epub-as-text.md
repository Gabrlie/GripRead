# Decision: EPUB books read as converted text

Status: implemented

## Problem

The library, reader, positions, search, bookmarks, transforms (replace rules and Chinese conversion), backups, and sync all work on one normalized text per local book, derived from a retained source file. EPUB adds a package of XHTML files, a directory of its own, and images. The text is not a TXT encoding, so it cannot be re-decoded like one.

## Decision

An EPUB is converted at import into normalized text with one paragraph per line (`crates/core/src/epub.rs`): spine files in reading order, block elements as lines, scripts and styles removed, ruby annotations dropped.

The conversion is deterministic, and every path that rebuilds a book's text from its source goes through `txt::decode_source`, which converts an EPUB and decodes anything else. The EPUB stays the retained source, so the book keeps the file's SHA-256 as its identity across devices.

Two private-use marks carry what text cannot:
- **Images:** a line holding only `U+E000 + n` is image `n`. Its size is stored at import, so pages lay out before the image loads.
- **Directory entries:** `U+F0000 + n` at the start of a line places entry `n`. The directory is read back from these marks rather than from stored offsets, so it survives transforms.

The asset kind is `epub`. Titles, depths, images, and the cover path live in `epub_assets`, schema 21. The renderer hides the marks inside hidden spans and draws image boxes capped at the page height. Speech and excerpts drop the marks.

## Alternatives considered

- **A reader resource per spine file, as online chapters do:** this was planned first. It would have needed a second local reading path, per-chapter search and bookmark offsets, and its own transform handling, all for the same reading behavior.
- **Rendering the XHTML itself:** this keeps styling, but gives up the shared text measurement, offsets, and every text tool.
- **A directory stored as offsets:** these would go stale whenever a transform changes the text before an entry.

## Consequences

Local EPUB books share everything TXT books have, and their files sync and back up the same way. Styling beyond paragraphs, headings, and images is not kept. Footnotes become plain text, and links inside the book are reached through the directory only. The TXT encoding and chapter-rule tools do not apply to EPUB. The marks are in the text, so a replace rule matching private-use characters could remove them; ordinary rules do not.
