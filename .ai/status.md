# Current status

## Current stage

M0 remains in progress. Storage, IPC, measured reading, PageFlip cleanup, isolated macOS embedded checks, and publication recovery are integrated. The first M1 TXT slice now includes automatic/manual encoding, re-decode recovery, TOC, bookmarks, cancellable literal search, and stale-position recovery; the wider M1 and product specifications remain planned.

## Active task

Complete [M0 closeout and M1 TXT reading](plans/2026-09-18-m0-m1-txt.md), then review the integrated storage, reader, and native evidence. Preserve the current visual layout and keep deferred features explicitly unavailable.

## Blockers

Local Rust, frontend, generated-binding, documentation, boundary, ordinary debug build, and the full isolated native suite pass. The native suite includes an expected publication crash followed by an independent recovery check. Native automation uses fixture IPC imports instead of the macOS picker, so picker evidence remains manual.

## Next entry point

Collect macOS system-picker evidence before deciding whether M0 can close. Verify TXT source re-association during that evidence pass. Android and Windows native checks, EPUB, source compatibility, RSS, WebDAV, and AIGC remain deferred.
