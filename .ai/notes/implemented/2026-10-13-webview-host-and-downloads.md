# Decision: A WebView host for sources and a background download queue

Status: implemented

## Problem

Many sources need a real browser: pages built by scripts (`webView: true`, `webJs`), `java.webView`, logins on a web page, and verification pages. The source engine runs on its own threads without Tauri, and only Android's WebView can render pages on the device. Offline caching also stopped when its page closed and when Android suspended the app in the background.

## Decision

The engine defines `sources::webview::WebViewHost` with two blocking calls: `render` (load a page off screen with the source's headers and cookies, wait for it, and answer with its HTML, a script's result, or a matched resource or navigation address) and `browse` (show a page full screen until the reader closes it). The app installs a host at start; on Android it is `WebViewPlugin`, called through `run_mobile_plugin` from engine threads, two pages at a time, each bounded by the operation's deadline and at most 60 seconds. Cookies go into the WebView before loading and come back into the source's cookie store. Without a host the engine keeps its explicit unsupported error.

Downloads become an app-wide queue (`downloads.rs`) independent of pages, kept in `downloads.json`. While jobs run, Android's `DownloadPlugin` keeps a `dataSync` foreground service with a progress notification; its 停止 reaches the page as a plugin event that pauses the queue.

## Alternatives considered

A second Tauri webview window would work on desktop but Tauri's mobile runtime has one window, and its IPC would expose app commands to source pages. Running scripts that need a DOM in QuickJS with a fake document would not run sites' own scripts. Keeping downloads tied to the page with a wake lock would still stop when Android froze the process.

## Consequences

WebView sources work on Android only; desktop reports them as needing WebView, and host tests use a fake host. Pages loaded for sources never receive app IPC. A notification permission is asked on Android 13 and later the first time a download starts; without it the service still runs, only the notification is hidden.
