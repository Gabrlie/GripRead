# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

The [Legado-style local reading task](plans/2026-10-10-legado-local-reading.md) is in progress: local reading is rebuilt after legado-with-MD3 tag `3.26.7` and delivered as one Android build.

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

All milestones are implemented on the host. Build the Android debug APK and collect device results; the macOS native suite was updated but needs a run on macOS.
