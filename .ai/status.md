# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

The [Legado-style local reading task](plans/2026-10-10-legado-local-reading.md) is in progress: local reading is rebuilt after legado-with-MD3 tag `3.26.7` and delivered as one Android build.

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

Chapter rules, the reading menu, Contents, and Search are done. Continue with page turning and gestures, then reading styles, fonts, information bars, and book information.
