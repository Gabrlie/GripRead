# Android adaptation

Status: completed

## Outcome

Make the existing local TXT reading journey run as an Android application: build a debug APK on a Linux host, import TXT from the system document picker, read in every delivered mode, keep positions and settings when the app is paused or killed, and handle the system back action. Behavior belongs to [Library](../subsystems/library.md), [Reader](../subsystems/reader.md), and [interaction design](../design/interaction.md). It preceded the planned Legado-style rework of local reading.

## Scope

Included: Android project generation and mobile entry point, Linux host toolchain documentation, document-picker import and source reassociation, pause-time persistence, back-button navigation, viewport/safe-area and touch defects observed on a device, and the owning documentation.

Excluded: Batch 3 and later reader settings, EPUB, online sources, RSS, sync, release signing and store packaging, iOS, and Windows. macOS behavior must stay unchanged. Allowed areas are `src-tauri` (including `gen/android`), `src/services`, `src/application`, `src/context`, `src/App.tsx`, `index.html`, `vite.config.ts`, reader and layout components only for observed Android defects, generated bindings, `scripts`, and owning `.ai` documentation.

## Interfaces

Import and reassociation requests keep their wire shape; `path` may be a filesystem path or an Android `content://` document URI. On Android, the Rust command layer copies the document into an operation-owned staging file named after the document display name, passes that file to the existing storage preparation, and removes the staging directory on every terminal outcome. Storage remains path-based and unaware of URIs. The application flushes its existing ordered writers when the document becomes hidden. The system back action is routed through existing navigation and panel state.

## Acceptance criteria

- `pnpm check` passes on Linux; `pnpm tauri android build --debug --apk --target aarch64` produces an installable APK.
- On a device, UTF-8 and GBK TXT import from Files and Downloads with the document's own title; cancelling the picker creates no task; a failed or cancelled import leaves no staged file or readable partial book.
- Paging by tap and swipe, page effects, and scroll mode work; toolbars toggle on a center tap.
- Backgrounding the app and then killing it reopens the book at the same passage with the latest settings.
- Back closes an open panel, then leaves the reader, then follows the previous tab or exits; it never discards pending writes.
- Content is not hidden behind status or gesture bars in portrait or landscape, light or dark.

## Verification

Host: Ubuntu 24.04 without KVM, so no emulator. Device acceptance is manual: the user installs the debug APK and reports results, which are recorded here as user-provided evidence. `pnpm test:native` requires macOS and is not run on this host.

Linux baseline before changes (Ubuntu 24.04, Rust 1.99, Node 24, pnpm 11.5.2): formatting, documentation, generated bindings, boundaries, and both TypeScript projects passed; the original 136 frontend tests passed; 66 Rust tests, `cargo fmt --check`, and clippy with `-D warnings` passed. The frontend build ran afterwards with this task's changes.

After the first slice, on the same host: `pnpm check` passes with 139 frontend tests (new hidden-flush and back-button cases) and 69 Rust tests (new document staging cases); clippy with `-D warnings` also passes for `aarch64-linux-android`. `pnpm tauri android build --debug --apk --target aarch64` succeeds (arm64-v8a, minSdk 24, about 50 MB without Rust debug info). Device results for `c32c81a` (user-provided; device model and Android version not reported): import works and keeps the document title; the position and settings survive closing and reopening; status and gesture bars do not cover content; back closes dialogs but left the reader without first hiding its toolbars. Defects: scroll mode left text under the open top bar after scrolling back, a 6 MB TXT import took more than ten seconds, and the curl effect stuttered and flickered (slide and fade were smooth).

Repairs in `55223ca` and `0714fbb`: dependency optimization and sampled encoding detection (6 MiB GBK fixture on the host: 12.0 s to 0.15 s; UTF-8: 0.66 s to 0.09 s), toolbar dismissal on scroll drags and before leaving, and a held outgoing page with a reused PageFlip instance. `pnpm check` passes with 141 frontend and 70 Rust tests. Device results for this build: pending.

The same device review asked to rebuild the reader around Legado 3.26.7 (contents, directory rules, search, encoding, reading styles, author and introduction parsing); that is a separate task.

Device results for `17ba26e` and its repairs (user-provided): imports of a 6 MB TXT are fast; tab pages and the reader respect the status and gesture bars; curl no longer stutters or locks the reader when the toolbar opens mid-turn. Scroll mode briefly lost its single-page text column because `.reader-prose` resets padding on its own element; the column now wraps the text while the position indicator stays at the screen edge. Horizontal swipes still do not turn pages on the device, page dragging is not interactive, and the middle column has no page-turn tap zones.

## Handoff

Completed. The Android project builds on Linux and the local TXT journey runs on a device: document-picker import, all reading modes, pause-time saves, back navigation, native insets, the canvas curl, and import performance. The [decision note](../notes/implemented/2026-10-10-android-document-import.md) records the platform choices. Swipe turning, interactive page dragging, and Legado's nine-zone tap layout move to the page-turn work of the Legado-style reader rework, as the user requested.
