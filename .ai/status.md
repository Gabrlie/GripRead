# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

The [Legado book sources task](plans/2026-10-11-legado-sources.md) is completed and merged into `main`; development continues on `dev`. The [local reading stage 4 task](plans/2026-10-11-local-reading-stage4.md) is accepted on device apart from small items batched for later.

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

Book sources (S1–S5 and four device bug rounds) are closed; the WebView awaits a source to test it on the device. The next stage is the user's choice. The macOS native suite needs a run on macOS.
