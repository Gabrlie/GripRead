# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, durable reading positions, and single/double/scroll reading modes, and it runs on Android; wider M1 remains planned.

## Active task

[0.4.1](plans/2026-10-14-rss.md) is in progress on `dev`: the RSS reader, merged from its branch, with 订阅设置; its [second round](plans/2026-10-19-rss-round2.md) works through the user's first test in four batches. [0.3.2](plans/2026-10-19-private-groups.md) (private shelf groups) was released as `v0.3.2` on 2026-10-19.

## Blockers

The Linux host has no hardware-accelerated emulator; Android acceptance uses device evidence from installed debug APKs. macOS native acceptance cannot run on this host.

## Next entry point

Batch 2 of the [second round](plans/2026-10-19-rss-round2.md) (filters, large lists, feed search), after the user's device test of the batch 1 beta.
