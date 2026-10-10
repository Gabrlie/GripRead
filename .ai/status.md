# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

None is in progress. The [Android adaptation task](plans/2026-10-10-android-adaptation.md) is complete. Local reading will next be rebuilt after legado-with-MD3 tag `3.26.7` (its functions and layout, GripRead's styling); this supersedes Batches 3–5 of the [TXT reader modes and settings task](plans/2026-09-24-txt-reader-modes-and-settings.md).

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

Write the decision note and task for the Legado TXT table-of-contents engine (rule table, volumes, preface and introduction, author parsing; schema 9), then the reader menu, contents and search pages, page turning with swipe, drag, and nine tap zones, and reading styles with font import.
