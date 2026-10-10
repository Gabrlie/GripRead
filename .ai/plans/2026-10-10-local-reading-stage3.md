# Local reading, stage 3

Status: in-progress

## Outcome

Finish the local reader after legado-with-MD3 tag `3.26.7` without book sources: fix two device defects, rework the bookshelf around reading-state groups and a full book detail page, polish reading (selection menu, bookmark notes, brightness, orientation, background images, regex search, scrolling automatic turns), and add the previously excluded replace rules, simplified/traditional conversion, and read-aloud. Behavior belongs to [Reader](../subsystems/reader.md), [Library](../subsystems/library.md), and [interaction design](../design/interaction.md). Delivered as one Android debug APK after host verification.

## Scope

Milestones, each committed separately: (N1) spreads on landscape phones and gestures that start anywhere on the reading screen; (N2) shelf groups 全部/在读/未读/读完 with manual moves, user groups, a full-screen book detail page that replaces 书籍管理, editable introductions, custom covers, several-file and folder import, reading time and records, and a reworked 更多 menu; (N3) reading-experience polish; (N4) replace rules, 简繁 conversion, and TTS. Local backup is excluded by the user's choice; online sources, RSS, sync, and EPUB remain excluded. The [reading-state shelf groups decision](../notes/implemented/2026-10-10-reading-state-shelf-groups.md) records the schema 11 grouping model.

## Interfaces

Schema 11 drops all existing groups, adds a manual reading state and a cover to books, notes to bookmarks, a per-day reading time table, and image asset kinds. `LibraryService` replaces `setBookGroups` with `moveBook` and gains file, folder, and cover pickers, asset reads, reading time, and statistics; `ReaderService` gains bookmark notes. The Android `DocumentPlugin` gains a folder picker. Rust declarations, generated bindings, mocks, and the preview services change together.

## Acceptance criteria

- A phone in landscape shows two pages in double mode; a tablet turns from taps and swipes that start on margins, bars, or beside the text column.
- Books appear in 在读, 未读, or 读完 from their progress unless moved by hand; a manual move holds until the next move; deleting a user group returns its books to automatic grouping.
- The detail page wraps long introductions without horizontal scrolling and edits title, author, introduction, and cover; reading time accumulates only while reading.

## Verification

N1: reader tests for margin taps and the spread rule; a tablet-size preview drag starting on the far margin turned the spread. N2: Rust tests for moves, single group membership, schema 11 migration from schema 5, 7, 8, and 9 databases, reading time validation and statistics, bookmark notes, cover signature checks and replacement, and editable introductions; frontend tests for the menu, reading-state tabs, detail page editing and moving, and reading time counting; phone screenshots of the shelf, the 更多 menu, the detail page, and reading records. `pnpm check` and Android clippy pass.

N3: Rust tests for regex search (anchors, lazy quantifiers, case folding, no line crossing, invalid patterns) and startup removal of unused background images; frontend tests for selection-to-offset mapping across hidden indents, the reveal cycle in automatic turning, and the adapter keeping a reveal over navigation cancels; phone screenshots of the selection menu, the note dialog, 更多设置, the menu following the page colours, regex results, and a reveal in progress. Brightness, orientation, share, and the emptied WebView selection toolbar need device checks.

## Handoff

In progress. N1–N3 are implemented on the host; N4 follows.
