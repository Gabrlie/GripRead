# Current status

## Current stage

M0 remains in progress. Storage, IPC, measured reading, PageFlip cleanup, macOS checks, and publication recovery are integrated. The first M1 TXT slice includes encoding, re-decode, TOC, bookmarks, cancellable search, and stale-position recovery; wider M1 remains planned.

## Active task

Complete [M0 closeout and M1 TXT reading](plans/2026-09-18-m0-m1-txt.md), then review storage, reader, and native evidence. Preserve the visual layout and deferred entries. The repair protects stale locators, recovers failed re-decode publication, preserves manual encoding on repeat imports, and exposes search paging and cancellation.

## Blockers

`pnpm check`, the ordinary macOS debug build, and the full native suite now pass. Native fixtures still bypass system picker selection; native window close/quit and TXT source re-association evidence remain manual.

## Next entry point

Record system-picker selection/cancellation, native window close/quit, and TXT source re-association. Android and Windows native checks, EPUB, source compatibility, RSS, WebDAV, and AIGC remain deferred.
