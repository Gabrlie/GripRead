# Library

Status: planned

## Scope

Manage book identity, imported assets, shelf membership, groups, reading status, and device availability. File transfer and replication belong to [Sync](sync.md); the shelf presentation belongs to [interaction design](../design/interaction.md). The next planned import and reader slice is tracked in the [active plan](../plans/2026-09-23-import-reader-experience.md).

## Interfaces

`Book` is the persistent identity used for shelf state and reading records. `BookAsset` identifies a local file, cloud file reference, or source-backed content resource. Separate device-local paths and availability from portable identity and metadata.

Use content hashes to detect repeated local assets and a content version to distinguish changed text. Associating or downloading a file updates asset availability without creating a second shelf entry for the same known book. A persistent book ID alone does not establish chapter equivalence between sources; [Sources](sources.md) owns that mapping.

## Behavior

Import TXT and supported EPUB through platform file access; desktop also accepts dropped files. A normal TXT import requires only a file choice and runs in the background without opening a progress, metadata, encoding, or confirmation dialog. Picker cancellation is silent. After committed success, refresh the shelf without automatically opening the book. Show dismissible success notices for 3 seconds and failure notices for 8 seconds; pointer or keyboard focus pauses their dismissal. Dismissing a notice never cancels its job or erases its terminal result. After a failure notice expires, keep the latest failure details and retry action available from the import entry. Do not expose incomplete assets as readable books.

Use automatic encoding detection for ordinary imports. Legacy-encoding detection samples the first 512 KiB; decoding still covers the whole file, and replacement characters anywhere still reject the automatic guess. Offer an explicit encoding retry at import time only when automatic decoding fails, so successful imports need no encoding step. Keep the reader's encoding action available for later correction of a readable file.

Manage shelf groups and reading states: unread, reading, and finished. Expose recent reading, chapter updates, progress, and local availability. Read local metadata before performing network work.

Removing a shelf entry removes its shelf membership and replicates that removal when sync is enabled; it does not delete the remote original book. Clearing cached chapters affects only this device. Permanent asset deletion, if later added, must be a distinct operation with its own scope.

A local-book record with no file offers cloud download when an asset is available remotely, or local-file association. A source-backed book without cached chapters offers chapter retrieval through its source. Do not show a downloaded state until content is actually available.

Imported originals, chapter caches, and derived indexes have separate ownership so cache cleanup cannot remove original books or structured reading records. Failed imports do not leave apparently readable shelf entries pointing to incomplete assets.

## M0 implementation contract

Native file selection accepts one TXT. On Android the picker returns a document URI; the command layer stages a copy named after the document display name and removes it when the operation ends, as recorded in the [Android document import proposal](../notes/proposed/2026-10-10-android-document-import.md). The encoding behavior is owned by [the TXT decoding decision](../notes/implemented/2026-09-18-txt-m1.md). Cancelling the picker creates no task. Application-owned tasks continue after the import panel closes; polling and events converge on one terminal state. A completed import includes its committed result. Shelf snapshots, including an empty snapshot, are authoritative. Unknown metadata uses explicit defaults.

Imports prepare the representation used by decoding, content versions, positions, search, and recovery outside the database mutex. Required conversion detects the encoding, removes its BOM, and normalizes CRLF/CR to LF; it does not rewrite prose or remove paragraphs. Measure file reading, decoding/conversion, hashing and indexing, staging writes/synchronization, commit, shelf refresh, and time to first readable page separately before optimizing repeated work. The name of a progress phase is not evidence that its named step is the bottleneck. A durable import journal records ownership before file publication; startup obtains exclusive access and reconciles journal entries and committed assets. Recovery removes incomplete products and retains committed identities and valid positions. Reconstructible sparse UTF-16/byte indexes accelerate bounded reads. Managed-file identity and metadata invalidate the verified content cache; changed content produces an explicit version error.

## Local group implementation

Schema 6 stores editable groups and book memberships separately from books and assets. Template group names are inserted only when the migration runs; they never infer membership from genre and never repopulate deleted groups. Group deletion removes memberships and preserves books, assets, and reader locators. The generated Rust contracts own validation and IPC shapes.

The application shelf store serializes group reads and mutations. Chapter metadata loads independently with a book-snapshot revision, retains verified same-version entries on failure, and exposes per-book errors for retry. Views consume the authoritative group snapshot, use only local fallback covers when metadata is absent, and never match a filename to sample catalog data.

## Acceptance

- Reimport identical content without duplicating its asset; preserve book identity when its local path changes.
- Complete normal import with only a file choice; success and failure notices expire or dismiss without changing job outcomes, and picker cancellation remains silent.
- Offer explicit import-time encoding retry only after automatic decoding failure; interrupted or failed imports leave no apparently readable partial asset.
- Compare import, commit, shelf refresh, and first-readable-page timings independently on representative TXT sizes before attributing slowness to representation conversion.
- Manage groups, reading state, recent books, and local availability across restarts.
- Distinguish shelf removal, cache cleanup, and cloud-file operations.
- Associate or download a missing local-book asset and retrieve uncached source chapters through the appropriate path.
- Interrupt an import and verify incomplete content is not reported as ready.
