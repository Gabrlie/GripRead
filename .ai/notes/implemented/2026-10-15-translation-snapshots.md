# Decision: Local books read translations from fixed snapshots

Status: implemented

## Problem

A local book's managed text must be reproducible from its retained source and its stored transform: re-association, re-import, encoding changes, and position relocation all derive the text again and compare it. Translations arrive slowly and grow over time, so a transform that read them from the shared translation cache would give different text on each run, and a failed or cleared cache would change a book that nobody touched.

## Decision

Translation is the last step of `TextTransform`, before 简繁转换. The transform names a snapshot by its digest and records the display (仅译文 or 双语对照). A snapshot is a file under `translations/` in the data folder, mapping line hashes to translations; once written it never changes, so the same source and transform always give the same text. Lines the snapshot lacks stay as written.

A background job (`translate_book`, cancelled through the source operation registry as `translate:<book id>`) translates from the reader's place onward, or the whole book, through the shared cache. It writes a new snapshot after a short first stretch and then every 1,500 lines, and records it as the book's snapshot. That makes the book's transform pending, and the reader applies it through the existing re-decode, which relocates the position and bookmarks. Snapshots no book or current text names are removed at the end of each run.

## Alternatives considered

- **Reading translations from the cache inside the transform:** not reproducible, as above.
- **Translating at display time, outside the managed text:** offsets, search, bookmarks, and the contents would all refer to the original while the page showed other text, and a bilingual page would need its own pagination.
- **Storing the translated text as a separate managed file:** a second copy of every book, which still needs the same relocation of positions when it changes.

## Consequences

- Each step re-decodes the book, so very frequent steps would cost a re-decode each; the step size keeps that to a few per reading session.
- Snapshot files are device-local, like the engine keys; a backup restored elsewhere reads the original until it is translated there.
- Clearing the translation cache does not change books already translated, since their snapshots are separate.
