# Documentation map

Start at [status](status.md) for the active scope, then read [workflow](engineering/workflow.md). This map assigns each maintained subject to one owner; planned specifications are not claims of shipped behavior.

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
| Change ownership and commits | [Workflow](engineering/workflow.md) |
| Checks and evidence | [Verification](engineering/testing.md) |
| Stage dependencies | [Roadmap](plans/roadmap.md) |
| Bounded implementation work | [Task template](plans/task-template.md) |

## Decision records

- [Documentation ownership](notes/implemented/2026-09-17-documentation-ownership.md) explains this structure.
- [M0 IPC bindings and text locator](notes/implemented/2026-09-17-m0-ipc-and-locator.md) records the Rust source, generated TypeScript, and Unicode position contract.
- [Reading-first extension boundaries](notes/proposed/2026-09-17-reading-first-extensions.md) records the approved direction for deferred integrations.

Add decision links here only when they guide current work. Source modules should own their local README and any additional instructions when the corresponding code exists.
