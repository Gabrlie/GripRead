# Current status

## Current stage

M0 remains in progress. Storage, IPC, reading, PageFlip cleanup, macOS close/quit checks, and recovery are integrated. The M1 TXT and local-library slice includes encoding, verified re-decode relocation, TOC, bookmarks, cancellable search, editable metadata, persisted shelf preferences, and reversible shelf removal; wider M1 remains planned.

## Active task

The [macOS closeout and local-library implementation](plans/2026-09-19-local-library-closeout.md) is implemented and reviewed on `codex/local-library-closeout`. Metadata editing, sorting, shelf preferences, reversible removal, and verified TXT relocation preserve the existing visual baseline. Exit now waits for accepted library/group writes and offers safe retry or explicit abandonment of rejected shelf intents.

## Blockers

`pnpm check` passes: 88 frontend and 55 Rust tests. The ordinary build and affected native phases pass; the complete native suite passed before final review. System picker import/cancellation, window close, Quit, save-failure retry, and relaunch have real evidence. Source re-association has automated IPC coverage; its manual system-picker evidence remains pending.

## Next entry point

Record the remaining source-picker evidence before marking the stage complete. Android and Windows checks, EPUB, source compatibility, RSS, WebDAV, and AIGC remain deferred.
