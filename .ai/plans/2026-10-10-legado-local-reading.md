# Legado-style local reading

Status: in-progress

## Outcome

Rebuild local TXT reading after legado-with-MD3 tag `3.26.7`, keeping GripRead's visual style: chapter rules, contents, search, encoding, the reading menu, page turning and gestures, reading styles with day/night variants, typography and information bars, custom fonts, and book information. The work is delivered to the device as one debug APK after host verification. Behavior belongs to [Reader](../subsystems/reader.md), [Library](../subsystems/library.md), [interaction design](../design/interaction.md), and [motion design](../design/motion.md).

## Scope

Milestones, each committed separately: (M1) Legado TXT chapter engine, schema 9, author and introduction parsing; (M2) reading menu, Contents and Search pages, rule and encoding dialogs; (M0) a browser preview mode with in-memory services for host screenshots; (M3) page turning with drag-follow, swipes over text, nine tap zones, cover animation, and volume keys; (M4) 界面 styles, typography, margins, information bars, fonts, and more settings; (M5) book information on the shelf.

Excluded by the user's choice: replace rules, simplified/traditional conversion, and text-to-speech. Online sources, RSS, sync, EPUB, and release signing remain excluded. The [TXT chapter rules decision](../notes/implemented/2026-10-10-legado-txt-chapter-rules.md) records the engine.

## Interfaces

`ReaderService` gains chapter rule management and per-book TOC settings; `listToc` returns a listing with the producing rule and settings; `LibraryService` gains book information. Rust declarations and generated bindings change together with all consumers and test mocks. Schema 9 is additive and migrates schema 8 rule modes.

## Acceptance criteria

- Real novels get Legado's chapters, volumes, preface, introduction, and author; rule selection, enabling, reordering, editing, import, and export work and persist.
- Contents, Search, encoding, and the reading menu match Legado's functions and layout in light and dark themes.
- Gestures, tap zones, animations, styles, fonts, and information bars behave as specified; restart restores the passage in every mode.

## Verification

Per milestone: `pnpm check` on Linux and clippy for `aarch64-linux-android`; preview-mode screenshots in light and dark at phone size for UI milestones. Final: one Android debug APK and a device checklist. macOS native acceptance and emulators are not available on this host.

M1 and M2: 80 Rust tests (rule families, preface and volumes, size and long splitting, scoring, name/author parsing, schema 8 migration, rule table operations) and 140 frontend tests pass; phone screenshots of the menu, Contents, bookmarks, rule dialog, encoding dialog, Search, and the result bar were inspected in light and dark.

## Handoff

In progress. Next: M3 page turning and gestures.
