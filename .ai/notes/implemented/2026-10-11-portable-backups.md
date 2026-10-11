# Portable backups and the cloud bookshelf

Status: implemented

## Problem

The reader asked for backup with WebDAV and a cloud bookshelf before cross-device replication exists. Backups must not contain books, must restore onto a device whose copy of a book has a different text (another encoding choice, replace rules, or 简繁 conversion), and must not erase what the device already has. Pulled books must not duplicate books already on the shelf.

## Decision

A backup is a versioned JSON document (`format: gripread-backup`, `version: 1`). Books are identified by the SHA-256 of their original file bytes (`txt_assets.source_sha256`), which import already uses for deduplication and which survives re-decoding. Positions and bookmarks carry the content version, offset, text length, and 32 characters of context on each side; on a device with the same content version the offset is used as is, otherwise the position is found again by its context nearest its proportional place, falling back to the line start at that place.

Restoring writes a local recovery point (the latest five are kept in `backups/`), then merges. Schema 13 adds `pending_book_restores` for records whose book is not on the device; the import worker applies them when a book with the same original file is committed. Schema 13 also adds `sync_settings` for the device's WebDAV account and automatic backup state, which never enters a backup.

The cloud bookshelf stores original files under `GripRead/Books/` with an index of names, hashes, titles, and authors, so listing can tell which books are local without downloading them. A download is staged and passed to the ordinary import.

The WebDAV client uses `ureq` with rustls and ring, which builds for Android without CMake.

## Alternatives considered

Copying the SQLite database was rejected: it carries device paths and content versions and cannot merge. Replacing the library on restore was rejected because it silently loses newer progress. Byte offsets in the original file were considered for positions; they need both encodings and transforms at restore time, while context search works across them with one pass over the text. Uploading normalized text instead of original files was rejected because the hash would then change with encoding and transforms.

## Consequences

Backups contain short text excerpts around positions and bookmarks. A position whose context was rewritten by a rule falls back to its proportional place. Progress is not replicated between devices automatically; that remains part of the Sync specification.
