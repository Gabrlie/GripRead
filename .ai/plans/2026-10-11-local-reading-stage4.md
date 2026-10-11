# Local reading, stage 4: device feedback, settings, backup, and cloud shelf

Status: in-progress

## Outcome

Address the device findings from the stage 3 build and add the first WebDAV features: backup and restore, and a cloud bookshelf. Behavior belongs to [Reader](../subsystems/reader.md), [Library](../subsystems/library.md), [interaction design](../design/interaction.md), and [Sync](../subsystems/sync.md). Delivered as one Android debug APK after host verification.

## Scope

Milestones, each committed separately:

- (D1) Device fixes and reading polish: saving the 在读/未读/读完 tab, silent read-aloud on Android 11+, spreads after rotation, progress loss when leaving scroll mode, glyph shifts during turns, curl shadows and middle-third folds, session-only brightness, volume keys while the menu is open, a shorter chapter rule dialog, a replace action on selected text, the automatic-turning panel, a configurable bottom bar, 简繁 in the top bar menu, and read-aloud word highlighting with scroll following.
- (D2) The settings page rebuilt around app settings, rule management, reading records, and backup, without the reader typography it duplicated.
- (D3) Backup and restore of portable records to a local file or WebDAV, and a cloud bookshelf that uploads local books and pulls remote ones as complete local imports, matched and deduplicated by content.

Replication of progress between devices (the rest of [Sync](../subsystems/sync.md)), online sources, RSS, and EPUB remain excluded.

## Interfaces

D1 removes `brightness` from the reading style and adds `bottomTools`; saved styles load with the field dropped and Legado's default tools. The Android TTS bridge declares the `TTS_SERVICE` package query, reports engine status, word ranges, and errors, and opens the system speech settings.

## Acceptance criteria

- Choosing 在读, 未读, or 读完 saves and is restored; a phone shows spreads after rotating into landscape; scroll → page → scroll keeps the passage.
- Glyphs keep their spacing during cover, slide, and curl; curl shadows follow the lifted edge, and a drag from the middle folds toward a corner.
- Read-aloud speaks on Android, marks the spoken words where the engine reports them, and follows the reading in page and scroll modes.

## Verification

D1: Rust tests for the reading-state tabs and bottom tool validation and migration; frontend tests for word ranges, page turns at the spoken word, and loading more text; a preview run of three scroll/page round trips keeping offset 4109 (previously 4109 → 3585 → 3122 → 2735); phone screenshots of curl drags from the bottom and middle, the 更多 menu, the chapter rule dialog, 更多设置 with the bottom bar editor, a customized bottom bar, and the automatic panel during a reveal.

## Handoff

In progress: D1 is implemented on the host.
