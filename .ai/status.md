# Current status

## Current stage

M0 remains in progress. The local TXT/library slice includes import recovery, encoding correction, TOC, search, bookmarks, shelf management, and durable reading positions; wider M1 remains planned.

## Active task

The [complete TXT reader modes and settings task](plans/2026-09-24-txt-reader-modes-and-settings.md) remains in progress. [Batch 2](plans/2026-09-27-reader-batch-2.md) delivers chapter controls, single/double-page and scroll modes, effects, automatic reading, and application-owned position saves.

## Blockers

Checks pass with 136 frontend and 66 Rust tests, the ordinary macOS build, and native phases across isolated runs. Desktop and narrow reader captures were inspected. Manual source-reassociation picker evidence, a native screenshot after toggling system reduced motion, and other-platform acceptance remain pending.

## Next entry point

Plan Batch 3 typography, margins, backgrounds, and managed assets using the parent task and proposed preference/asset decision. It has not started. Information bars remain in Batch 4; EPUB, online sources, RSS, WebDAV, AIGC, and other-platform acceptance remain deferred.
