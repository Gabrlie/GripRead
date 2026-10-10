# Verification

## Available checks

The documentation tool uses Node.js 22 or newer without package installation:

```sh
node scripts/check-docs.mjs
node --test scripts/check-docs.test.mjs
```

The checker validates maintained root/.ai Markdown, required sections and statuses, local file and heading links, and bounded entry-document word counts. Its tests use temporary fixtures to prove invalid documentation is rejected. It does not fetch external URLs or prove semantic consistency; review those explicitly.

## Application checks

`pnpm check` aggregates formatting, documentation, generated-binding freshness, TypeScript, dependency boundaries, frontend and Rust tests, Rust formatting/static checks, and the frontend build. The boundary checker parses module edges and tests rejected fixtures; generated IPC types are checked against their Rust definitions. `pnpm tauri build --debug` verifies an ordinary desktop native build on the host platform. On Linux, Rust checks need the Tauri WebKitGTK development packages.

`pnpm tauri android build --debug --apk --target aarch64` builds an Android debug APK; it needs JDK 17 and an Android SDK with the NDK, located through `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME`. The dev profile optimizes dependencies so device debug builds show representative import and reading speed; `cargo test import_timing -- --ignored --nocapture` prints import phase timings for a 6 MiB fixture. Setting `CARGO_PROFILE_DEV_DEBUG=0` keeps the debug APK small enough to transfer; delete a previous APK before rebuilding, because incremental packaging can leave it padded. Without a hardware-accelerated emulator, Android acceptance is performed on a device and recorded as device evidence with the device model and Android version.

`pnpm test:native` uses WebdriverIO with the embedded Tauri driver in a dedicated test build. The native-test feature, frontend test mode, and capability override must be enabled together; ordinary builds exclude test plugins, fault injection, and test entry points. The runner uses isolated data and process lifetimes and must propagate build, assertion, crash, and timeout failures. A startup log line never establishes acceptance. The presentation phase records desktop/phone screenshots and geometry in ignored `.native-artifacts/`; set `GRIPREAD_PRESENTATION_MODE=baseline` with `GRIPREAD_NATIVE_PHASES=presentation` to capture a pre-change comparison. Verified captures also inspect deferred actions and glass alpha values. Compare the images directly; geometry assertions do not replace visual review.

Use `GRIPREAD_NATIVE_PHASES` to select native phases and `GRIPREAD_NATIVE_GREP` to select individual Mocha cases while investigating a failure. Integrated acceptance omits the case filter. Builds share the frontend output directory, so run ordinary and native builds sequentially. Native interactions foreground the actual isolated test window when it becomes hidden; they do not spoof visibility or disable production animations.

Use fixtures and observable outcomes for parsing, state, and service behavior. Exercise IPC changes through their real consumers. UI work also needs visual inspection, keyboard/touch checks, and reduced-motion behavior. Native/platform claims require evidence from the corresponding target, not an inference from a browser build or a different operating system.

## Selecting scope

Choose checks by the changed behavior and risk. Local mechanical edits do not require new tests that repeat the implementation. Fixes to substantive bugs should exercise the failure and corrected behavior. Once relevant checks pass, repeat or broaden them only after new changes, failures, or unresolved concerns.

Subsystem documents own their [acceptance cases](../README.md); avoid copying their catalogs here. Plans identify the cases relevant to a task. Keep deterministic fixtures for format parsing and protocol behavior, and separate optional live-service smoke tests from offline acceptance.

## Reporting evidence

State the command, environment/platform, outcome, and material limitations. Distinguish passed, failed, blocked, and not run; missing credentials or an unavailable target is not a pass. Record evidence with the active task or change description, not as growing historical inventories in permanent specifications.

For doc changes, inspect the diff for lost requirements, stale references, duplicate facts, and accidental promotion of planned behavior to implemented status. Test any change to the checker with both valid and invalid fixtures, including its command-line failure status. Avoid network calls or application scaffolding solely to validate documentation.
