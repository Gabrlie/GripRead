# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

[Stage 7](plans/2026-10-14-stage7.md) is in progress on `dev` toward 0.2.1: more build targets and release pages, in-app updates, EPUB, and server-side follow-up. [Stage 8, RSS](plans/2026-10-14-rss.md) is implemented on the local branch `rss`, to merge after 0.2.1 as 0.3.0. The [self-hosted server task](plans/2026-10-13-server.md) delivered the server, web version, and native sync, released as 0.2.0.

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

The next unfinished batch of [stage 7](plans/2026-10-14-stage7.md). Device acceptance of native sync happens during the user's period of use after 0.2.1; RSS is the next stage after that.
