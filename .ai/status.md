# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

The [local reading stage 4 task](plans/2026-10-11-local-reading-stage4.md) is in progress: fixes from stage 3 device acceptance, a rebuilt settings page, backup and restore, and a WebDAV cloud bookshelf, delivered as one Android build.

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

D1 is implemented on the host; next are the settings page (D2) and backup with the cloud bookshelf (D3). The macOS native suite needs a run on macOS.
