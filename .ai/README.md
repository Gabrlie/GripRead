# Documentation map

Start at [status](status.md) for the active scope, then read [workflow](engineering/workflow.md). Each subject has one owner; planned specifications are not shipped behavior.

| Subject | Authoritative document |
| --- | --- |
| Documentation placement and lifecycle | [Documentation standard](AGENTS.md) |
| Product goals and release boundaries | [Requirements](product/requirements.md) |
| Composition and dependency direction | [Architecture](architecture.md) |
| Screens, navigation, and visual defaults | [Interaction](design/interaction.md) |
| Transitions and reduced-motion behavior | [Motion](design/motion.md) |
| Parsing, pagination, and text positions | [Reader](subsystems/reader.md) |
| Book identity, assets, and shelf operations | [Library](subsystems/library.md) |
| Legado compatibility and ColorTxt reference | [Sources](subsystems/sources.md) |
| Standard feeds and article state | [RSS](subsystems/rss.md) |
| WebDAV, conflicts, and backup | [Sync](subsystems/sync.md) |
| Progress-bounded retrieval and generation | [AIGC](subsystems/aigc.md) |
| Interface languages | [i18n](subsystems/i18n.md) |
| Book translation | [Translation](subsystems/translation.md) |
| Web version and deployment | [Server](subsystems/server.md) |
| App updates | [Updates](subsystems/updates.md) |
| Change ownership and commits | [Workflow](engineering/workflow.md) |
| Checks and evidence | [Verification](engineering/testing.md) |
| Stage dependencies | [Roadmap](plans/roadmap.md) |
| Bounded implementation work | [Task template](plans/task-template.md) |

## Decision records

- [Documentation ownership](notes/implemented/2026-09-17-documentation-ownership.md) explains this structure.
- [M0 IPC bindings and text locator](notes/implemented/2026-09-17-m0-ipc-and-locator.md) records the Rust source, generated TypeScript, and Unicode position contract.
- [TXT encoding and reading tools](notes/implemented/2026-09-18-txt-m1.md) records retained source bytes, re-decode recovery, and search.
- [Local shelf archive, preferences, and verified TXT relocation](notes/implemented/2026-09-21-local-library-closeout.md) records schema 7 shelf state.
- [TXT directory rules and automatic page turning](notes/implemented/2026-09-23-txt-directory-rules-and-auto-turn.md) records TOC cache identity and the automatic-turn interval.
- [Reader preferences v2 and managed display assets](notes/implemented/2026-09-24-reader-preferences-v2-and-assets.md) records reading styles and managed fonts.
- [Chapter navigation and shared reading-mode state](notes/implemented/2026-09-27-reader-navigation-and-modes.md) records chapter seeks and one locator owner for all modes.
- [Android document import and mobile lifecycle](notes/implemented/2026-10-10-android-document-import.md) records document-URI import and the mobile lifecycle.
- [TXT chapter rules after Legado](notes/implemented/2026-10-10-legado-txt-chapter-rules.md) records schema 9 chapter rules.
- [Portable backups](notes/implemented/2026-10-11-portable-backups.md) records the backup format.
- [Reading-first extension boundaries](notes/proposed/2026-09-17-reading-first-extensions.md) records the approved direction for deferred integrations.

Add decision links here only when they guide current work. Source modules own their local README once their code exists.
