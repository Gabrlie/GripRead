# Architecture

Status: planned

## Composition

GripRead uses Tauri 2 for platform integration and a React, TypeScript, Vite, Tailwind CSS, and shadcn/ui frontend. Motion for React supplies interface animation. The [product specification](product/requirements.md) owns supported platforms and release scope; [motion design](design/motion.md) owns animation behavior.

The frontend renders screens, manages ephemeral presentation state, measures actual WebView text layout, and renders pages. Rust owns file access, SQLite, network requests, content parsing, persistent state, and long-running jobs. Typed Tauri commands and events connect them. Page components use service interfaces rather than issuing storage queries or implementing network protocols.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| [Library](subsystems/library.md) | Book identity, assets, groups, and local availability |
| [Reader](subsystems/reader.md) | Normalized content, positions, pagination, search, and bookmarks |
| [Sources](subsystems/sources.md) | Legado rule execution and online novel acquisition |
| [RSS](subsystems/rss.md) | Standard feeds, articles, read state, and favorites |
| [Sync](subsystems/sync.md) | Optional WebDAV replication, cloud files, and backups |
| [AIGC](subsystems/aigc.md) | Optional retrieval and generation within a reading boundary |

SQLite stores structured local state. Original books and reconstructible content caches live in managed files with database metadata. Storage and platform adapters remain below domain services. Network content is cleaned before display and cannot acquire application IPC access through its markup.

## Dependency direction

Views depend on presentation/service interfaces; services depend on domain types and storage/platform adapters. Storage adapters do not import UI. Dependencies between modules go through their declared interfaces rather than another module's internal tables or files.

Library and Reader provide stable book identity and content locations. Sources can supply normalized content to Reader; Reader does not depend on the source interpreter. RSS has its own article model and can share rendering utilities without adopting novel rules or locators. Sync consumes explicit serializable records and excludes device-only fields. AIGC consumes read-only content and position interfaces; the reading path never depends on an AI provider or index being available.

Platform features the engine needs reach it through narrow host interfaces installed by the app, such as the Android WebView for sources ([decision](notes/implemented/2026-10-13-webview-host-and-downloads.md)); Android-only work lives in app plugins (`DocumentPlugin`, `DownloadPlugin`, `NetworkPlugin`, `WebViewPlugin`) beside `MainActivity`. Do not create generic plugin frameworks or placeholder runtime services for deferred modules. Add their adapters when their stage is assigned. Shared behavior must have a named owner before extracting it into a utility.

## Interfaces and jobs

The owning subsystem defines semantic obligations; executable type declarations become authoritative once implemented. Shared command inputs and outputs must be explicit, validated at external boundaries, and updated together with consumers. Avoid independent, manually synchronized copies of IPC types.

`src/application` owns application-lifetime import and preference stores and the reader position writer. Accepted reader writes survive leaving the view; `src/context` owns navigation and display state only. `src/services/contracts.ts` declares library, reader, and settings ports; `src/services/ipc.ts` is their production platform adapter. Pages never manufacture book identities, content, or persistence results. The reader controller remains independent of React and pages.

Long-running operations expose an operation identity, progress, cancellation, and a terminal result. Resource owners release listeners, workers, and requests when work ends. Stale callbacks cannot overwrite a newer user action. Persistent jobs resume from stored state where the operation requires durability; transient searches need not become database jobs.

The [workflow](engineering/workflow.md) owns implementation discipline and [verification](engineering/testing.md) owns validation methods. Stage-specific runtime choices, including the source JavaScript engine and AI storage/provider, are recorded by their subsystems rather than assumed by the application foundation.

## App log

`src-tauri/src/app_log.rs` keeps the app log shown in 设置 › 日志: one JSON-lines file per local day under the data folder's `logs/`, kept for seven days, plus an in-memory ring of recent entries. Any layer may write to it, including the source engine, which stays free of Tauri. It records failures and key steps (source and chapter failures, failed commands reported by the IPC layer, uncaught page errors, 更新目录, 换源, backup, and restore); 详细日志, which turns itself off after a day, adds every engine step and request. Messages are redacted before writing so cookies, authorization and login headers, tokens, and passwords never enter the log; it is local and leaves the device only when the reader copies or shares it.

