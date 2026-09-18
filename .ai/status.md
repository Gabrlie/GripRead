# Current status

## Current stage

M0 is in progress. The existing storage and IPC foundation and uncommitted product pages require integration repairs before acceptance. Wider product specifications remain planned.

## Active task

Implement the approved [M0 repair](plans/2026-09-17-m0-repair.md): real imports and observable failures, recoverable storage, measured reading pages, supported preferences, and macOS native acceptance. Preserve the current visual layout and make deferred features explicitly unavailable.

## Blockers

The local Rust, frontend, generated-binding, documentation, boundary, production frontend build, ordinary Tauri macOS build, and isolated embedded WebDriver checks pass. Native automation still does not drive the macOS system file picker, and a separate animated WebKit run remains a diagnostic check rather than the deterministic acceptance default.

## Next entry point

Review the integrated diff, record the native evidence and picker limitation, then decide whether the M0 milestone can close. Do not start later roadmap stages. Android and Windows native checks, EPUB, source compatibility, RSS, WebDAV, and AIGC remain deferred.
