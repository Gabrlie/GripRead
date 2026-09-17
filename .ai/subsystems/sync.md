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

Preview a backup, create a local recovery point, then apply the selected restoration as new synchronization changes. Reject unreadable or incompatible snapshots without damaging current state. Restore does not delete cloud originals or overwrite remote records as an unversioned database replacement.

## Acceptance

- Continue local reading and metadata edits without WebDAV and during connection failures.
- Switch devices, reread earlier passages, skew clocks, and create offline forks without silent progress loss.
- Interrupt/retry uploads and restoration; verify durable queue recovery, causal conflicts, tombstones, and idempotent record application.
- Transfer a manually uploaded book to another device while proving excluded data is absent from sync and backups.
- Test automatic retention, independent manual backups, preview, recovery points, and malformed backup rejection.
