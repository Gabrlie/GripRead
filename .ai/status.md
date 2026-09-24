# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, and durable reading positions; wider M1 remains planned.

## Active task

The [complete TXT reader modes and settings task](plans/2026-09-24-txt-reader-modes-and-settings.md) is in progress, starting with unified paragraph rendering. The prior [silent import and immersive reading implementation](plans/2026-09-23-import-reader-experience.md) is merged.

## Blockers

`pnpm check` passes with 113 frontend and 64 Rust tests. The ordinary macOS build and all affected native phases pass, including 30 cases and expected crash/recovery behavior. Desktop and phone-sized renders were inspected. Manual source-reassociation picker evidence and other-platform acceptance remain pending.

## Next entry point

Collect the remaining system-picker evidence before stage closeout; detailed import-stage and first-render profiling remain available follow-up work. Android and Windows checks, EPUB, source compatibility, RSS, WebDAV, and AIGC remain deferred.
