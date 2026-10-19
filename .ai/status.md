# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

[0.3.1](plans/2026-10-18-comics.md) (comic reading, the cloud progress prompt and online chapter title fixes, and the test rounds' fixes) was released as `v0.3.1` on 2026-10-19. No round is open; the next one raises the version on `dev`.

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

The next round the user assigns. RSS waits on a local branch; its version and schema are set when it is merged.
