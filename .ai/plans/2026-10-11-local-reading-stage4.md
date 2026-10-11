# Local reading, stage 4: device feedback, settings, backup, and cloud shelf

Status: in-progress

## Outcome

Address the device findings from the stage 3 build and add the first WebDAV features: backup and restore, and a cloud bookshelf. Behavior belongs to [Reader](../subsystems/reader.md), [Library](../subsystems/library.md), [interaction design](../design/interaction.md), and [Sync](../subsystems/sync.md). Delivered as one Android debug APK after host verification.

## Scope

Milestones, each committed separately:

- (D1) Device fixes and reading polish: saving the 在读/未读/读完 tab, silent read-aloud on Android 11+, spreads after rotation, progress loss when leaving scroll mode, glyph shifts during turns, curl shadows and middle-third folds, session-only brightness, volume keys while the menu is open, a shorter chapter rule dialog, a replace action on selected text, the automatic-turning panel, a configurable bottom bar, 简繁 in the top bar menu, and read-aloud word highlighting with scroll following.
- (D2) The settings page rebuilt around app settings, rule management, reading records, and backup, without the reader typography it duplicated.
- (D3) Backup and restore of portable records to a local file or WebDAV, and a cloud bookshelf that uploads local books and pulls remote ones as complete local imports, matched and deduplicated by content.

- (D4, second device round) The automatic panel never pauses on its own, menu dialogs for the bottom bar and 简繁, book detail from the reader, scroll position captured when leaving scroll mode, dialogs above full-screen pages, dark swatches, an About page, self-dismissing notices, the 回收站 and two kinds of deletion, cloud marks and a reorganized detail page, cloud names with authors and indexed information and covers, a configurable WebDAV folder and device name, a local backup folder, the 恢复忽略列表, latency checks, and Legado's 同步阅读进度 and 同步增强.

Causal replication of the other records (the rest of [Sync](../subsystems/sync.md)), online sources, RSS, and EPUB remain excluded.

## Interfaces

D3 adds schema 13, `SyncService` (Rust commands, generated bindings, IPC, preview, and test mocks), and a `createDocument` command in the Android `DocumentPlugin`; the [portable backup decision](../notes/implemented/2026-10-11-portable-backups.md) records the format. D1 removes `brightness` from the reading style and adds `bottomTools`; saved styles load with the field dropped and Legado's default tools. The Android TTS bridge declares the `TTS_SERVICE` package query, reports engine status, word ranges, and errors, and opens the system speech settings.

## Acceptance criteria

- Choosing 在读, 未读, or 读完 saves and is restored; a phone shows spreads after rotating into landscape; scroll → page → scroll keeps the passage.
- Glyphs keep their spacing during cover, slide, and curl; curl shadows follow the lifted edge, and a drag from the middle folds toward a corner.
- Read-aloud speaks on Android, marks the spoken words where the engine reports them, and follows the reading in page and scroll modes.
- A backup restored on a device with a differently rendered copy of a book finds its position and bookmarks again; books not on the device take their records when imported or downloaded; nothing is duplicated by restoring or pulling twice.

## Verification

D1: Rust tests for the reading-state tabs and bottom tool validation and migration; frontend tests for word ranges, page turns at the spoken word, and loading more text; a preview run of three scroll/page round trips keeping offset 4109 (previously 4109 → 3585 → 3122 → 2735); phone screenshots of curl drags from the bottom and middle, the 更多 menu, the chapter rule dialog, 更多设置 with the bottom bar editor, a customized bottom bar, and the automatic panel during a reveal.

D2/D3: Rust tests for backup export and restore across a converted copy (metadata, group, newer position, merged bookmarks, larger daily time, idempotent restore, pending records applied on import, recovery points, malformed and newer backups), context relocation, WebDAV multistatus parsing and address encoding, and the full cloud flow against an in-process WebDAV server (wrong password, manual and pruned automatic backups, unchanged-day skip, upload dedupe, listing with local matches, download and import dedupe, delete); frontend tests for restore preview and report and for downloading into the import; phone screenshots of settings, 备份与恢复, the restore preview and report, 云书架, and TXT目录规则. A real WebDAV server (坚果云 or another) was not used.

D4: Rust tests for deletion, 回收站 matching and cloud marks, `书名 - 作者` naming with indexed information and covers applied on pull, restore-ignore categories and backup covers, device names and a custom folder in paths, latency checks, and progress sync (own uploads ignored, each new remote version asked once, no question when already there) against the in-process WebDAV server; a controller test for leaving scroll mode after evicted windows; frontend tests for the automatic panel, the More dialogs, the cloud progress prompt and upload on leaving, upload-before-fetch ordering, the device name default, cloud marks, and confirmed deletion; phone screenshots of the detail page and its removal menu, 备份与恢复 with a latency warning, the ignore list, dark settings, and About. The scroll-to-page regression did not reproduce in the preview even with scrolling and evicted windows; the fix captures the scroll position when the mode is chosen, and device confirmation is pending.

## Handoff

In progress: D1–D4 are implemented on the host; next is the Android APK and device results.
