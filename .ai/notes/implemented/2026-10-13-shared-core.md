# Decision: A shared core behind one command dispatcher

Status: implemented

## Problem

A server edition must serve the same library, reader, sources, and sync as the app, to a web page and to devices. The commands lived in the Tauri crate as about 140 `#[tauri::command]` functions taking Tauri state and handles, so nothing outside the app could run them, and a second copy for the server would drift.

## Decision

The workspace splits into `crates/core` and the `src-tauri` shell. The core holds every Tauri-free module and the command bodies, rewritten as `fn name(state: &Arc<AppState>, request) -> Result<T, AppError>`. `api::dispatch(state, name, args)` runs one by name with the page's `{ request }` arguments and answers JSON, or raw bytes for fonts and covers; `api::COMMANDS` lists the names, and a test checks every command the page calls is among them. `AppState::open` starts the log, network settings, and download queue that the app's setup used to start.

Shells supply `api::Events` (Tauri events in the app) and `platform::Platform` (Android documents, folders, and the download notification; plain paths by default). The app keeps one `rpc` command plus its exit handshake, and `src/services/transport.ts` sends every core command through it, so services and pages are unchanged.

## Alternatives considered

Keeping per-command Tauri wrappers beside a server router would list every command twice. Generating both from a macro over the command signatures would hide the commands behind code generation for little gain over one dispatcher. Running the Tauri app headless as a server is not supported on Linux servers without a display.

## Consequences

A command added to the core is reachable from every shell once it is in the dispatcher. Commands no longer see Tauri types; anything platform-specific goes through `Platform` or an engine host interface. The Rust build output moves to the workspace's `target/`.
