# Current status

## Current stage

M0 remains in progress. Storage, IPC, measured reading, PageFlip cleanup, macOS checks, and publication recovery are integrated. The first M1 TXT slice includes encoding, re-decode, TOC, bookmarks, cancellable search, and stale-position recovery; wider M1 remains planned.

## Active task

The [review repairs](plans/2026-09-18-m0-m1-txt.md) are verified and integrated into main. The current restored visual layout is preserved; groups serialize reads and mutations, chapter failures support retry, and deferred regions use disabled controls without production fixtures. Glass backgrounds use the agreed alpha values.

## Blockers

`pnpm check` passes with 65 frontend and 37 Rust tests. The ordinary macOS build and complete native suite pass, including presentation and group persistence. System-picker selection/cancellation, native window close/quit, and source re-association evidence remain outstanding.

## Next entry point

Record remaining M0 native evidence before marking the stage complete. Android and Windows checks, EPUB, source compatibility, RSS, WebDAV, and AIGC remain deferred.
