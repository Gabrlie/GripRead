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

### With the GripRead server

设置 › 服务器同步 connects a device to the [server](server.md) with its address, its password (exchanged for a session token; the address and token stay in `sync-server.json` in the data folder, never in backups), and a device name. 断开 keeps the last sign-in (address, device name, password) in `sync-server-login.json`, also never in backups: the page fills it in, connecting again may leave the password empty, and 忘记登录信息 removes it. While connected, the server replaces WebDAV: backups, automatic backup, and progress sync pause and say so, their settings stay, and they resume after 断开. 云书架 then lists the server's book files (`GET /api/cloud/books`) with a 服务器 mark: 下载 fetches one into the ordinary import, 全部上传 queues the local books the server lacks for the next round, and books are not deleted there, since they leave the server with its shelf. 服务器同步 also opens 服务器管理, the web version's 服务器账号 sections (定时追更, signed-in devices, 修改密码) reached through the core command `server_api`, which sends the device's session to an allowlist of management routes; a password changed there updates the kept sign-in. On first contact a preferences record that still holds a new library's defaults (a server never set up) does not replace the device's own settings, which go up instead. Subscriptions, read articles (per feed, merged against the last synced version), and starred articles sync as `feed:`, `rss-read:`, and `rss-star:` records in the RSS 订阅 category ([decision](../notes/implemented/2026-10-14-rss-article-state.md)). Sync carries what backups carry as records ([decision](../notes/implemented/2026-10-13-native-sync-records.md)): books by their file's hash and online books by name and author with their details, progress, bookmarks, and reading time, plus groups, replace and TOC rules, sources, and preferences. The 同步排除 list (the former 恢复忽略列表) keeps excluded categories local both ways.

A round pulls what other devices and the web version wrote and applies it, fetches the covers and (with 自动下载服务器上的书, on by default) the books it names, then pushes what changed here and uploads the book files and covers the server lacks. A round runs at connection (the server's records apply first, then this device's others go up), at start, on returning to the foreground, on a network change, when a book opens, 3 seconds after changes pause (at most 10 seconds during continuous changes), and as soon as a long poll on the server reports a new record; failures retry after 30 seconds, doubling to 5 minutes. Rounds and the long poll each keep one HTTP agent, so connections are reused rather than set up again per round, and a cover goes up only when the server lacks it (covers known to be there are remembered for the session). On Android, while the app is in the background (the system may cut its connections), the long poll pauses and a failed round is logged quietly instead of shown; returning to the foreground runs a round. Another device's position is never applied over this one: the reader offers it in the existing 跳转 prompt when the book opens or while it is open, and a device sends its position only when it is newer than the one synced. A book never read on this device takes the synced position directly.

Online books also carry their chapter list as a `chapters:online:<key>` record (category 在线书籍), so a directory updated on the server or another device arrives without asking the source. While connected, 更新书架 runs on the server and its results come back as records; books the server lacks, or a failed request, update on the device. An uncached chapter is asked of the server first and of the source when the server cannot give it. Only a `text/plain` answer counts as a chapter, and a kept chapter file that holds an HTML page (an older server answered with its page) is deleted and fetched again. A server too old for 更新书架 (404 or 405) is noted in the log once per update, and the update runs on the device.

### Conflicts and failure

Apply causally ordered updates. Preserve conflicting values when the same field was edited concurrently. For divergent reading progress, show device, chapter, and text context and let the user choose; neither the furthest percentage nor wall-clock time wins automatically. Resolution creates a new causally related update.

Shelf removal propagates without deleting cloud originals. Cache cleanup stays local. Network/authentication/protocol failures retain local changes and retryable work; repeated delivery must not duplicate records. Keep status unobtrusive during reading and expose the cause, last successful sync, and retry action in settings.

### Backup and recovery

Create automatic snapshots daily when portable data changed, retaining the latest 7 automatic snapshots. Keep manual backups separately from automatic rotation. Snapshots contain versioned portable records and settings, not cached content or credentials.

A backup is one JSON document described by the [portable backup decision](../notes/implemented/2026-10-11-portable-backups.md): book records keyed by the SHA-256 of each book's original file, with progress, bookmarks, reading time, placement, metadata, and a cover reference, plus groups, chapter and replace rules, and preferences without device fonts or background images. Backups also carry the book sources as Legado JSON (login state and cookies stay on the device) and the online books on the shelf with their source details and their position and bookmarks by chapter (index, title, offset, chapter count); a restore adds sources that are missing or newer, matches online books by source address or by name and author, and places a restored position and bookmarks once the book's contents are fetched on first opening. The 恢复忽略列表 has 书源 and 网络书籍 entries. Everything lives in the application folder under the address (`GripRead/` unless 子文件夹 is set; an empty address uses 坚果云). Backups go to `Backups/` as `manual|auto-<UTC stamp>-<device name>.json` (the device name is editable), to an optional local backup folder (automatic backups replace one file there), or to a file the reader picks; covers go to `Covers/<sha256>.<ext>`. Restoring merges, skipping the categories in the device's 恢复忽略列表: matching books take the backup's metadata, cover, and placement, the newer position, the union of bookmarks, and the larger time of each day; records for books not on the device wait until a book with the same original file is imported. The cloud bookshelf uploads original files to `Books/` as `书名 - 作者.txt` with an index of hashes, titles, authors, introductions, and covers; uploading an uploaded book refreshes its information (after editing an uploaded book's details the app asks whether to, or does it without asking when 自动同步书籍信息到云书架 is on; it is off by default), and downloading fetches the complete file into the ordinary import, which matches it to the same book instead of adding a copy and then applies the indexed information. The shelf marks books the device last saw in the cloud. The WebDAV password, account, and switches stay in local storage; settings show the saved password on request, and the switches save as they change, leaving the account's 保存 for typed fields. Backup files the reader keeps (导出到文件 and the local backup folder) also carry the WebDAV address, account, password, and 子文件夹, which a restore takes only when the device has no account; backups sent to WebDAV never carry them. A connection check reports the median round trip and warns above 800 ms that progress sync is not recommended.

Progress sync follows Legado's 同步阅读进度 (on by default): opening a book fetches `Progress/<sha256>.json`, and leaving uploads the saved position when it changed; 同步增强 also does both when the reader returns from the background or the network comes back. Each record names the writing device's random id, name, and revision. A device ignores its own records and versions it already answered, and a fetch waits for that book's pending upload, so slow servers do not raise repeated prompts; another device's different position asks whether to jump, as in Legado. Positions relocate by context across different renderings of the book. Online books use `Progress/<hash of name and author>.json`, as Legado keys them by name and author, so a copy on another source still matches; their position is a chapter position mapped onto this device's contents. This replaces neither the causal replication described below nor its conflict handling, which remain planned.

Preview a backup, create a local recovery point, then apply the selected restoration as new synchronization changes. Reject unreadable or incompatible snapshots without damaging current state. Restore does not delete cloud originals or overwrite remote records as an unversioned database replacement.

## Acceptance

- Continue local reading and metadata edits without WebDAV and during connection failures.
- Switch devices, reread earlier passages, skew clocks, and create offline forks without silent progress loss.
- Interrupt/retry uploads and restoration; verify durable queue recovery, causal conflicts, tombstones, and idempotent record application.
- Transfer a manually uploaded book to another device while proving excluded data is absent from sync and backups.
- Test automatic retention, independent manual backups, preview, recovery points, and malformed backup rejection.
