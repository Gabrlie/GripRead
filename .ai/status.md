# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

The [Legado book sources task](plans/2026-10-11-legado-sources.md) is in progress. The [local reading stage 4 task](plans/2026-10-11-local-reading-stage4.md) is accepted on device apart from small items batched for later.

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

S1–S3 (engine, source management, search and discover) are implemented; an Android build for device testing is next, then S4, online books in the reader. The macOS native suite needs a run on macOS.
