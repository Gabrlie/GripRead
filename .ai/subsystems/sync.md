# WebDAV synchronization and backup

Status: planned

## Scope

Provide optional synchronization of structured reading records, a user-managed cloud book folder, and versioned backups. Local reading remains functional without WebDAV. These are separate user-facing capabilities; uploading a book is not the same operation as synchronizing its progress.

## Interfaces

`SyncService` handles replication, retry, conflicts, backup/restore, and cloud asset operations. `SyncStatus` exposes local-only, queued, syncing, synced, retry-needed, and conflict states without exposing credentials. Storage adapters supply explicit portable records rather than copying the live SQLite database.

## Behavior

### Data ownership

Automatically synchronize shelf records, groups, reading state, progress, bookmarks, source configurations, RSS subscriptions/groups/read/favorite states, and general preferences. Exclude embedded secrets from portable source configuration.

Never automatically upload chapter caches, RSS content/images, credentials, source login state, device paths, font files, per-device typography/window settings, or derived AI/vector indexes. Backups follow the same exclusions. AI-generated output is not added to synchronization until separately specified.

Use `/GripRead/Books` for user-selected TXT/EPUB uploads, `/GripRead/Sync/v1` for protocol records, and `/GripRead/Backups` for snapshots. Allow an existing book folder to be selected separately. Browse cloud files and download on demand; shelf replication does not imply the original book has been uploaded.

### Local-first replication

Persist domain changes locally before network work. When sync is enabled, store the change and durable queue record atomically so a crash cannot lose the pending operation. Coalesce progress uploads after 3 seconds of inactivity, with a maximum 10-second interval during continuous changes. Backgrounding and exit attempt a flush; interrupted work resumes later without depending on indefinite background execution.

Check remote records at startup, foreground entry, and book opening; while reading, check that book every 15 seconds. Also provide manual sync. Show local content immediately. If remote progress arrives after reading starts, offer a jump instead of moving the reader automatically.

Each device writes its own state records. All entities, including separately stored progress, carry causal versions and device provenance; removals carry tombstones. Use WebDAV reads/writes and conditional requests, validating server behavior before relying on it. There is no required push server. Protocol details are fixed with the sync implementation and versioned explicitly. See the [WebDAV standard](https://www.rfc-editor.org/rfc/rfc4918.html).

### Conflicts and failure

Apply causally ordered updates. Preserve conflicting values when the same field was edited concurrently. For divergent reading progress, show device, chapter, and text context and let the user choose; neither the furthest percentage nor wall-clock time wins automatically. Resolution creates a new causally related update.

Shelf removal propagates without deleting cloud originals. Cache cleanup stays local. Network/authentication/protocol failures retain local changes and retryable work; repeated delivery must not duplicate records. Keep status unobtrusive during reading and expose the cause, last successful sync, and retry action in settings.

### Backup and recovery

Create automatic snapshots daily when portable data changed, retaining the latest 7 automatic snapshots. Keep manual backups separately from automatic rotation. Snapshots contain versioned portable records and settings, not cached content or credentials.

A backup is one JSON document described by the [portable backup decision](../notes/implemented/2026-10-11-portable-backups.md): book records keyed by the SHA-256 of each book's original file, with progress, bookmarks, reading time, placement, metadata, and a cover reference, plus groups, chapter and replace rules, and preferences without device fonts or background images. Backups also carry the book sources as Legado JSON (login state and cookies stay on the device) and the online books on the shelf with their source details and their position and bookmarks by chapter (index, title, offset, chapter count); a restore adds sources that are missing or newer, matches online books by source address or by name and author, and places a restored position and bookmarks once the book's contents are fetched on first opening. The 恢复忽略列表 has 书源 and 网络书籍 entries. Everything lives in the application folder under the address (`GripRead/` unless 子文件夹 is set; an empty address uses 坚果云). Backups go to `Backups/` as `manual|auto-<UTC stamp>-<device name>.json` (the device name is editable), to an optional local backup folder (automatic backups replace one file there), or to a file the reader picks; covers go to `Covers/<sha256>.<ext>`. Restoring merges, skipping the categories in the device's 恢复忽略列表: matching books take the backup's metadata, cover, and placement, the newer position, the union of bookmarks, and the larger time of each day; records for books not on the device wait until a book with the same original file is imported. The cloud bookshelf uploads original files to `Books/` as `书名 - 作者.txt` with an index of hashes, titles, authors, introductions, and covers; uploading an uploaded book refreshes its information (after editing an uploaded book's details the app asks whether to, or does it without asking when 自动同步书籍信息到云书架 is on; it is off by default), and downloading fetches the complete file into the ordinary import, which matches it to the same book instead of adding a copy and then applies the indexed information. The shelf marks books the device last saw in the cloud. The WebDAV password, account, and switches stay in local storage; settings show the saved password on request. A connection check reports the median round trip and warns above 800 ms that progress sync is not recommended.

Progress sync follows Legado's 同步阅读进度 (on by default): opening a book fetches `Progress/<sha256>.json`, and leaving uploads the saved position when it changed; 同步增强 also does both when the reader returns from the background or the network comes back. Each record names the writing device's random id, name, and revision. A device ignores its own records and versions it already answered, and a fetch waits for that book's pending upload, so slow servers do not raise repeated prompts; another device's different position asks whether to jump, as in Legado. Positions relocate by context across different renderings of the book. Online books use `Progress/<hash of name and author>.json`, as Legado keys them by name and author, so a copy on another source still matches; their position is a chapter position mapped onto this device's contents. This replaces neither the causal replication described below nor its conflict handling, which remain planned.

Preview a backup, create a local recovery point, then apply the selected restoration as new synchronization changes. Reject unreadable or incompatible snapshots without damaging current state. Restore does not delete cloud originals or overwrite remote records as an unversioned database replacement.

## Acceptance

- Continue local reading and metadata edits without WebDAV and during connection failures.
- Switch devices, reread earlier passages, skew clocks, and create offline forks without silent progress loss.
- Interrupt/retry uploads and restoration; verify durable queue recovery, causal conflicts, tombstones, and idempotent record application.
- Transfer a manually uploaded book to another device while proving excluded data is absent from sync and backups.
- Test automatic retention, independent manual backups, preview, recovery points, and malformed backup rejection.
