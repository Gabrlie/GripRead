# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

The [local reading stage 3 task](plans/2026-10-10-local-reading-stage3.md) is in progress: device fixes, the reading-state bookshelf, reading polish, replace rules, 简繁 conversion, and read-aloud, delivered as one Android build.

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

N1 and N2 are implemented on the host; continue with N3. The macOS native suite needs a run on macOS.
