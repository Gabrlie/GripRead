# macOS closeout and local library completion

Status: in-progress

## Outcome

Complete the remaining macOS foundation evidence and make the existing TXT reader practical for managing a local collection. Preserve the current visual baseline and add actions only through existing menus, dialogs, and state regions. Follow [Library](../subsystems/library.md), [Reader](../subsystems/reader.md), and [interaction design](../design/interaction.md).

## Scope

N1 covers actual native TXT selection/cancellation, close and Quit with save failures, process restart, and source re-association. N2 covers verified byte-anchor relocation across decoding changes and distinct search/directory states. N3 covers editable title/author, recent/import/title ordering, and persisted shelf layout/group. N4 covers reversible removal, undo, restoration, and re-import of archived books without identity loss. N5 integrates checks, visual review, and handoff. EPUB, batch import, reading statistics, new reading modes, online sources, RSS, WebDAV, AIGC, permanent deletion, and other-platform acceptance remain excluded.

## Interfaces

Rust owns new request/response definitions and incremental migrations; generated bindings and all service consumers change together. LibraryService owns metadata and archive actions. SettingsService owns shelf display preferences separately from reading typography. Preserve book/asset IDs, content versions, positions, bookmarks, and group memberships across metadata changes and soft removal. Re-decoding maps only verified raw-byte boundaries from the retained source and preserves old records when mapping is uncertain. Existing files are never deleted by a shelf operation.

## Acceptance criteria

- Actual system picker cancellation creates no task; selection imports the chosen bytes. Native close and Quit wait for saves, show failures, and succeed after retry. Relaunch restores the last saved text.
- Correct source re-association enables encoding changes; mismatching source bytes cannot replace usable assets.
- Encoding changes relocate positions and bookmarks only when the raw-source correspondence is verified; ambiguous offsets remain explicitly unresolved. Cancellation/failure retains the previous publication.
- Metadata, ordering, layout, and group selection survive restart without altering text identity. Deleted groups resolve to All.
- Removed books disappear from the active shelf and remain restorable with records intact. Re-import restores the same identity instead of duplicating it.
- Existing page geometry, colors, fonts, and glass treatment remain unchanged; unsupported features remain disabled.

## Verification

Run targeted tests for each implementation, then `pnpm check`, `pnpm tauri build --debug --no-bundle`, and `pnpm test:native`. Record native-system interactions separately from IPC fixture coverage. Capture desktop/phone before-and-after images for changed menus and dialogs.

## Implementation status

N1 close and Quit persistence now coalesce requests, preserve a failed close for retry, and keep the reader inert while exit is pending. The native Quit item routes through the same exit handshake as a window close. Manual macOS evidence covers picker cancellation, BOM UTF-8 import, save-failure retry, relaunch, window close, and both Quit paths. Manual source re-association evidence remains pending; automated storage and real IPC checks cover correct-source acceptance, wrong-source rejection, and concurrent association.

N2 retains the previous TXT publication until the source hash and full decode snapshot validate. Reassociation hashes operation-owned staging bytes before acquiring the storage mutex, then rechecks only a metadata fingerprint and the actual retained source path/hash snapshot while committing. Verified raw-byte boundaries relocate saved positions and bookmarks; ambiguous boundaries keep their old locator records for explicit relocation; cancellation, read failure, and concurrent changes retain the previous publication. Search distinguishes idle, active, empty, and failed states.

N3 and N4 add metadata editing, recent/import/title sorting, persisted layout and group preferences, soft removal, undo, restoration, and identity-preserving duplicate re-import. Archived records keep files, positions, bookmarks, and group memberships. Library and group mutations are drained before native exit. Stable intent keys retain independent failures and prevent an old failed edit from replaying over a newer successful change. Explicit exit retry replays only current safe intents; uncertain group creation is reconciled by exact stored name without replaying creation. Known validation rejections do not block exit. The existing exit-error region offers an explicit abandonment action for unresolved shelf intents, leaving pending writes, committed records, reader positions, and settings untouched. Deleted groups resolve a saved shelf group to `all`.

## Verification record

Storage regression tests cover migration, metadata identity, archived duplicate failure, missing-file repair, source re-association validation, non-default retained paths, concurrent association, byte-boundary relocation, unresolved anchors, cancellation, and concurrent position changes. Frontend tests cover preference write races, loading versus empty archive state, management controls, ordering, restore flows, and close-flush durability including failure/retry/no-duplicate behavior. Native WebDriver IPC coverage exercises wrong and matching source re-association, shelf preferences, metadata, archive/restore, and identity-preserving re-import; the reader flow also exercises no-result and failed-search states.

`pnpm check` passes with 88 frontend tests and 55 Rust tests. The ordinary macOS build and full native suite passed before the final review; the final review also passed the ordinary build and affected `interaction,presentation,m1-txt` phases (4, 2, and 6 cases). The presentation phase waits for computed glass alpha after theme reloads and passes its desktop/phone and group persistence checks. Native WebDriver coverage includes the new IPC flows; the crash phase terminates as an expected failure and recovery passes. Native fixture coverage does not replace manual macOS system-picker source re-association evidence.

## Handoff

The assigned implementation is ready for integration, with native source-picker re-association evidence still pending. Keep M0 and the full stage in progress until that evidence is recorded. Broader M1 and other platforms remain planned.
