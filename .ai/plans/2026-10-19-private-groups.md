# 0.3.2: Private groups

Status: in-progress

## Outcome

Release 0.3.2 with private shelf groups ([library](../subsystems/library.md), [sync](../subsystems/sync.md), [server](../subsystems/server.md)):
- **Hiding:** a group can be private, its books and comics left out of 全部, the reading-state groups, shelf search, and other book lists, and hidden in the reading records list (totals and the heatmap still count them, without titles).
- **Locking:** a private group is behind a blur mask, opened by a tap or by a password; it locks again when another group is chosen or the app goes to the background.
- **Sync:** the group, with its lock and password hash, syncs, so every device and the server hold the same private group. Optionally (on by default) its books stop syncing anything but their group, and stay out of WebDAV and local backups and cloud uploads.
- **Server:** books in a private group are not updated on schedule, and logs and job failures name them only as a private book.

## Scope

**Included:** schema 28 (group privacy columns), argon2 password hashes in the core, the shelf mask and unlock, list filtering, group settings, sync and backup exclusion, server jobs and logs, and the web version through the shared interface.

**Excluded:** encrypting book files or the database; recovering a forgotten password; the per-source server relay setting, which stays a network choice.

## Interfaces

**Batches:**
1. the core: schema, hashing, commands;
2. the shelf, lists, and group settings;
3. sync, backups, and cloud uploads;
4. the server's jobs and logs;
5. documentation and release.

## Acceptance criteria

- A private group's books are absent from 全部 and from the records list until it is unlocked; a password group opens only with its password; leaving the group or hiding the app locks it.
- Moving a synced book into a non-syncing private group moves it into the same group on another device without deleting it there, and later progress does not sync; a backup leaves it out.
- The server skips the book in scheduled updates and logs no title for it.

## Verification

Commands and results are recorded here per batch.

## Handoff

Pending.
