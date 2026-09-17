# Verification

## Available checks

The documentation tool uses Node.js 22 or newer without package installation:

```sh
node scripts/check-docs.mjs
node --test scripts/check-docs.test.mjs
```

The checker validates maintained root/.ai Markdown, required sections and statuses, local file and heading links, and bounded entry-document word counts. Its tests use temporary fixtures to prove invalid documentation is rejected. It does not fetch external URLs or prove semantic consistency; review those explicitly.

## Application checks to establish

The M0 foundation exposes executable commands for strict TypeScript checks, frontend build, Rust formatting/static checks, generated-binding freshness, dependency-direction checks, documentation checks, focused unit tests, and native startup smoke. `pnpm check` runs the offline repository checks; `pnpm tauri build --debug` verifies the macOS native build and `pnpm test:native` starts the real host, while the WebdriverIO embedded suite remains a separate follow-up until its test-only Tauri plugin and runner are added.

Use fixtures and observable outcomes for parsing, state, and service behavior. Exercise IPC changes through their real consumers. UI work also needs visual inspection, keyboard/touch checks, and reduced-motion behavior. Native/platform claims require evidence from the corresponding target, not an inference from a browser build or a different operating system.

## Selecting scope

Choose checks by the changed behavior and risk. Local mechanical edits do not require new tests that repeat the implementation. Fixes to substantive bugs should exercise the failure and corrected behavior. Once relevant checks pass, repeat or broaden them only after new changes, failures, or unresolved concerns.

Subsystem documents own their [acceptance cases](../README.md); avoid copying their catalogs here. Plans identify the cases relevant to a task. Keep deterministic fixtures for format parsing and protocol behavior, and separate optional live-service smoke tests from offline acceptance.

## Reporting evidence

State the command, environment/platform, outcome, and material limitations. Distinguish passed, failed, blocked, and not run; missing credentials or an unavailable target is not a pass. Record evidence with the active task or change description, not as growing historical inventories in permanent specifications.

For doc changes, inspect the diff for lost requirements, stale references, duplicate facts, and accidental promotion of planned behavior to implemented status. Test any change to the checker with both valid and invalid fixtures, including its command-line failure status. Avoid network calls or application scaffolding solely to validate documentation.
