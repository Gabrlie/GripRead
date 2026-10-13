# Decision: Native sync by records and snapshot comparison

Status: implemented

## Problem

Devices connected to the GripRead server should keep one library in sync: books and their details, progress, bookmarks, reading time, groups, rules, sources, and preferences, as WebDAV backups carry them. The library's tables use device-local ids, deletions leave no trace, and the WebDAV path only restores whole documents. Changing every write path to journal its changes would touch most of the storage code and miss writes added later.

## Decision

The library is described as records (`storage/sync.rs`), one per piece of state and keyed like backups so devices agree on identity: `book:<sha256>` and `online:<name key>` with their `progress:`, `bookmarks:`, and `time:` records, plus `group:`, `replace:`, `toc:`, `source:`, and `prefs:reading|theme|shelf`. Records are built from the backup export, so their contents are the backup's. A device finds its changes by building the records now and comparing their hashes with the ones it last synced (`sync_records`, schema 20); a key that disappears is sent as a removal. Records from elsewhere are applied through the restore paths, now able to apply one part of a book at a time, and are noted as synced with the value received, so applying never sends anything back once both sides hold the same value.

The server keeps the latest record per key in `sync_log`, numbered in the order it took them, and applies records to its own library, which the web version reads; its own edits are found by the same comparison. Later records win; bookmarks merge three ways against the last synced list, so a bookmark added on one device survives another device's deletions; reading time keeps the larger value per day; preferences split into reading, theme, and shelf records. The 恢复忽略列表 is the exclusion list: excluded records are neither sent nor applied. Records for a book whose file has not arrived wait in `pending_book_restores` and are not reported as removed.

## Alternatives considered

Triggers or a journal written by each storage call would catch changes immediately but couple every write path to sync, including future ones. Exchanging whole backup documents would resend everything and cannot tell a removal from data never seen. Field-level vector clocks would preserve more concurrent edits, at a cost not justified for one reader's own devices.

## Consequences

Sync costs one export of the library per comparison; it runs a few seconds after changes rather than on every write. A change made on two devices before either syncs keeps the later one, except bookmarks. Removing a book moves it to the other devices' 回收站; permanently deleting a book that was never synced as removed does not reach them.
