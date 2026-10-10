# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and Batch 2 reading modes; wider M1 remains planned.

## Active task

The [Android adaptation task](plans/2026-10-10-android-adaptation.md) is in progress: Android project, document-URI import, pause-time saves, and back navigation, built on a Linux host. The [TXT reader modes and settings task](plans/2026-09-24-txt-reader-modes-and-settings.md) resumes with Batch 3 afterwards.

## Blockers

There is no hardware-accelerated emulator on the Linux host; Android acceptance depends on device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

Collect device results for the first debug APK and fix observed Android defects. Then plan Batch 3 typography, margins, backgrounds, and managed assets.
