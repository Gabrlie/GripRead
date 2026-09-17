# Current status

## Current stage

Documentation foundation and the M0 logic foundation are implemented. The repository now has a Tauri 2 smoke host, Rust local storage, TXT normalization, typed IPC bindings, a framework-independent reader session, and repeatable native startup checks. Product screens and the full local-reading milestone remain planned.

## Active task

The [M0 logic task](plans/2026-09-17-m0-logic.md) is reviewed and ready for handoff. Its macOS debug binary, `test:native` startup smoke, Rust checks, TypeScript checks, generated bindings, and focused reader tests are available; native WebDriver coverage and the full page implementation are not yet delivered.

## Blockers

The test-only WebDriver plugin and WebdriverIO runner still need to be added for the requested embedded macOS acceptance. Android and Windows evidence are outside the current logic handoff. EPUB, source compatibility, RSS, sync, and AIGC remain later stages.

## Next entry point

Add the test-only embedded WebDriver plugin and macOS WebdriverIO suite against the existing smoke host, then create a separate page task or the next bounded M0/M1 task from the [task template](plans/task-template.md). Later roadmap stages are not assigned.
