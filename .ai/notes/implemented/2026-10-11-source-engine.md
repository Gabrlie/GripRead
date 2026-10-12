# Decision: A Rust source engine with a synchronous QuickJS host

Status: implemented

## Problem

Legado text sources mix CSS/Jsoup, XPath, JSONPath, and regular-expression rules with scripts written for Rhino, where `java.ajax` blocks and a script's last expression is its result. GripRead needs to run them on Android and desktop without a Node runtime, without letting scripts reach application data, and with failures that tell an unreachable site from an unsupported feature. [ColorTxt](https://github.com/ssnangua/ColorTxt) (studied at `a41095606d58`) implements the same semantics in TypeScript on Node, using asynchronous calls and extensive source rewriting to emulate Rhino's blocking calls.

## Decision

[Sources](../../subsystems/sources.md) run in `src-tauri/src/sources/`, a Rust module with no Tauri dependency (enforced by the boundary check). Rules follow Legado's `AnalyzeRule`, `AnalyzeUrl`, and `WebBook` order: chains split only at scripts, `&&`/`||`/`%%` inside a segment, then templates, `@put`/`@get`, and `##` replacements. Pages are parsed with html5ever behind a Jsoup-compatible layer (self-inclusive `select`, Jsoup pseudo-classes, `text()` whitespace, pretty `outerHtml`); XPath runs on a copy of that tree; JSONPath follows Jayway's definite-path and `$.` conventions; regular expressions use Java syntax on `fancy-regex`.

Scripts run in QuickJS (`rquickjs`) on the operation's thread. Host calls such as `java.ajax` block and return values, so no asynchronous rewriting is needed, and each script is evaluated through a direct `eval` in sloppy mode, which yields Rhino's completion value and keeps each script's declarations to itself. A prelude supplies the Java surface sources use (list methods on arrays, `java.lang.String` helpers, `Packages`/`JavaImporter` shims, Jsoup elements backed by the Rust tree); unimplemented Java classes and WebView calls throw an explicit "不支持" error. Each operation gets its own runtime with a 256 MiB memory limit and an interrupt handler bound to its cancellation and deadline.

ColorTxt is MPL-2.0. GripRead reimplements the observed behavior with Legado as the arbiter and copies no ColorTxt code; site-specific fixes in ColorTxt are not carried over.

## Alternatives considered

Running ColorTxt's engine in the WebView or a Node sidecar would bring its asynchronous rewriting, which the ColorTxt documentation shows is the largest source of Rhino incompatibilities, and would put network access and scripts beside the UI. Boa, a Rust JavaScript engine, avoids C code but is slower and less complete than QuickJS for the large jsLib bundles some sources carry. Wrapping scripts in functions, as ColorTxt does, needs heuristics to insert `return`; direct `eval` returns the completion value without them.

## Consequences

The minimum Rust version rises to 1.87 for `rquickjs`, and Android builds generate QuickJS bindings with the NDK's libclang through the [Android wrapper](../../../scripts/android.mjs). Compatibility is measured against controlled fixture sites and, later, the user's sample sources; WebView fetching, browser verification, captchas, font decryption, and local file access are reported as unsupported until they are built.
