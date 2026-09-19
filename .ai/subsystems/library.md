# Library

Status: planned

## Scope

Manage book identity, imported assets, shelf membership, groups, reading status, and device availability. File transfer and replication belong to [Sync](sync.md); the shelf presentation belongs to [interaction design](../design/interaction.md).

## Interfaces

`Book` is the persistent identity used for shelf state and reading records. `BookAsset` identifies a local file, cloud file reference, or source-backed content resource. Separate device-local paths and availability from portable identity and metadata.

Use content hashes to detect repeated local assets and a content version to distinguish changed text. Associating or downloading a file updates asset availability without creating a second shelf entry for the same known book. A persistent book ID alone does not establish chapter equivalence between sources; [Sources](sources.md) owns that mapping.

## Behavior

Import TXT and supported EPUB through platform file access; desktop also accepts dropped files. Manage shelf groups and reading states: unread, reading, and finished. Expose recent reading, chapter updates, progress, and local availability. Read local metadata before performing network work.

Removing a shelf entry removes its shelf membership and replicates that removal when sync is enabled; it does not delete the remote original book. Clearing cached chapters affects only this device. Permanent asset deletion, if later added, must be a distinct operation with its own scope.

A local-book record with no file offers cloud download when an asset is available remotely, or local-file association. A source-backed book without cached chapters offers chapter retrieval through its source. Do not show a downloaded state until content is actually available.

Imported originals, chapter caches, and derived indexes have separate ownership so cache cleanup cannot remove original books or structured reading records. Failed imports do not leave apparently readable shelf entries pointing to incomplete assets.

## M0 implementation contract

Native file selection accepts one TXT; the encoding behavior is owned by [the TXT decoding decision](../notes/implemented/2026-09-18-txt-m1.md). Cancelling the picker creates no task. Application-owned tasks continue after the import panel closes; polling and events converge on one terminal state. A completed import includes its committed result. Shelf snapshots, including an empty snapshot, are authoritative. Unknown metadata uses explicit defaults.

Imports prepare normalized content outside the database mutex. A durable import journal records ownership before file publication; startup obtains exclusive access and reconciles journal entries and committed assets. Recovery removes incomplete products and retains committed identities and valid positions. Reconstructible sparse UTF-16/byte indexes accelerate bounded reads. Managed-file identity and metadata invalidate the verified content cache; changed content produces an explicit version error.

## Local group implementation

Schema 6 stores editable groups and book memberships separately from books and assets. Template group names are inserted only when the migration runs; they never infer membership from genre and never repopulate deleted groups. Group deletion removes memberships and preserves books, assets, and reader locators. The generated Rust contracts own validation and IPC shapes.

The application shelf store serializes group reads and mutations. Chapter metadata loads independently with a book-snapshot revision, retains verified same-version entries on failure, and exposes per-book errors for retry. Views consume the authoritative group snapshot, use only local fallback covers when metadata is absent, and never match a filename to sample catalog data.

## Acceptance

- Reimport identical content without duplicating its asset; preserve book identity when its local path changes.
- Manage groups, reading state, recent books, and local availability across restarts.
- Distinguish shelf removal, cache cleanup, and cloud-file operations.
- Associate or download a missing local-book asset and retrieve uncached source chapters through the appropriate path.
- Interrupt an import and verify incomplete content is not reported as ready.
