# Android document import and mobile lifecycle

Status: proposed

## Problem

The Android system picker returns `content://` document URIs, while TXT import, recovery, and reassociation read sources by filesystem path and fingerprint them with file metadata. Android also pauses or kills a background app without the window-close and exit requests that currently drain pending writes, and its system back action would close the activity instead of dismissing the current layer.

## Proposal

Keep storage path-based. In the command layer, resolve a document URI through an in-app Android plugin (`DocumentPlugin.kt`) that returns a detached file descriptor and the provider display name. Copy the document into `document-staging/<operation>/<display name>.txt` under the data directory, check cancellation between chunks, and pass that path to the existing preparation. The staged directory is removed when the worker ends and the staging root is cleared at startup after the data lock is held. Managed `sources/` already retain the original bytes, so no persistent URI permission is requested. Request wire shapes are unchanged: `path` may hold either a path or a document URI.

Run the existing ordered application flush whenever the document becomes hidden. Route Android back through the existing Escape handling for open layers and the reader, then to the Library tab, then to the ordered exit handshake already used by native Quit.

## Alternatives considered

The fs plugin's Rust `open` accepts content URIs but does not report a display name, which would make imported titles opaque provider identifiers. Persisting URI permissions and reading the provider on demand would avoid one copy but makes recovery depend on an external provider and conflicts with the retained-source design. A separate back-navigation state machine would duplicate the reader's Escape ordering.

## Acceptance criteria

- UTF-8 and GBK documents import with their own titles from Files and Downloads providers.
- Cancelled, failed, or interrupted imports leave no staged file and no readable partial book.
- Backgrounding then killing the app preserves the latest position and settings.
- Back dismisses the topmost layer, then leaves the reader, then returns to Library, then exits after saves.

## Risks

Large documents are copied once before preparation, temporarily doubling their storage use. Some providers may omit a display name; those books are titled `Untitled`. A hidden-time flush can fail without a visible screen; each writer keeps its own error and retry state for when the app returns.
