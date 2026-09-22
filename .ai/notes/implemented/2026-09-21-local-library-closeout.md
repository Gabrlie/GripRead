# Decision: local shelf archive, preferences, and verified TXT relocation

Status: implemented

## Problem

The local shelf needed editable metadata, durable ordering and layout choices, reversible removal, and position recovery when a retained TXT source is decoded with a different encoding. These operations must preserve the existing book, asset, reader, bookmark, and group records and must not delete user files.

## Decision

Schema 7 adds `shelf_removals` and a single-row `shelf_preferences` record. Shelf removal is a soft archive keyed by book ID; restoring or successfully re-importing the same normalized/source identity clears that row, while all managed files, positions, bookmarks, and memberships remain intact. Shelf preferences use a typed settings port for layout, sort order, and group selection. Loading an invalid or deleted group resolves to `all`.

TXT re-decode retains the old publication until a staged replacement, source hash, and complete decode snapshot are validated. The snapshot includes the saved position and bookmarks. Relocation maps only coincident normalized UTF-16 boundaries through the immutable source-byte boundaries using verified incremental decoding; ambiguous or replacement-character decodes leave the old locator records unchanged. A commit conflict or cancellation removes its stage and leaves the prior publication readable.

## Alternatives considered

Permanent deletion was rejected because shelf management does not own original-file destruction and would make recovery unsafe. Storing shelf display state in page components was rejected because it would lose preferences across restarts and duplicate persistence behavior. Context matching or nearest-boundary heuristics were rejected because they can silently move a locator into unrelated text.

## Consequences

Book and asset IDs survive metadata edits, archive/restore, and duplicate re-import. Missing managed bodies can be repaired by re-importing the retained source without resetting a manual encoding choice. The UI reports archive loading and management failures separately from a confirmed empty archive and offers retry/undo actions through existing menus and dialogs.

Library and group write queues participate in native-exit flushing. Failures are tracked by intent key and revision; a newer successful intent supersedes an older failed one. Retry never repeats a completed write solely because its subsequent refresh failed. Uncertain creation is reconciled against stored group names instead of blindly replayed; unresolved shelf intents may be explicitly abandoned from the exit error without deleting stored data.
