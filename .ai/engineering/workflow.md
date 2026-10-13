# Development workflow

## Scope and task ownership

Start from [current status](../status.md) and the assigned scope. Read only the relevant specifications after the entry documents. A [roadmap](../plans/roadmap.md) stage establishes dependencies, not an instruction to begin all its work. Complete the assigned task and report the result without silently extending it.

For cross-module work, use the [task template](../plans/task-template.md) to state outcomes, exclusions, allowed files/modules, interface changes, acceptance conditions, and verification. Establish shared types before parallel work. Assign non-overlapping write ownership and a clear integration point; if overlap becomes necessary, coordinate before editing. Do not alter unrelated work or conceal integration conflicts with destructive Git operations.

## Implementation discipline

Keep the dependency direction in [architecture](../architecture.md). Views consume services; domain behavior does not depend on page components. Reuse the existing owner of a behavior before adding another parser, cache, state store, or helper. Extract shared code only when its responsibility and consumers are concrete.

Use strict TypeScript checking, explicit external input validation, and narrow types. An unavoidable `any`, unsafe operation, or lint suppression needs a local explanation. Keep Rust errors explicit and preserve meaningful context across IPC. Do not use broad catches, silent fallbacks, or placeholder success to disguise failures.

Async work needs operation ownership, cancellation, timeouts, terminal results, and cleanup. Abort and await owned work where completion matters; detach listeners and ignore stale results when views or requests are replaced. Test the relevant failure behavior through its consumer.

Change shared interfaces together with all consumers. Use monotonic database schema versions and explicit migration/compatibility behavior for persisted or wire data; never silently discard user records to make a new format work. Document the decision before implementing a new persisted format.

## Documentation and review

Update the owning specification with behavioral changes, and use the [documentation standard](../AGENTS.md) for consequential decisions. Keep source declarations authoritative and explain non-obvious behavior close to its implementation. Do not copy declarations into multiple reference pages.

Review the integrated diff for lost requirements, interface mismatches, duplicate behavior, inappropriate dependencies, and error handling. Run [relevant checks](testing.md), fix failures without weakening their meaning, and record unrun checks as unrun. A successful isolated module test does not replace verification of its changed integration path. For page changes, compare actual phone and desktop renders against the existing visual baseline in [interaction design](../design/interaction.md); preserve deferred regions and controls when connecting services. Report any intended visual departure before treating it as an accepted change.

## Git and handoff

Use Conventional Commits: `<type>[optional scope][!]: <description>`. Types include `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, and `revert`. A scope is optional; the description can be English or Chinese. Put `!` after the type or scope, or use a `BREAKING CHANGE:` footer for a breaking change. See the [specification](https://www.conventionalcommits.org/en/v1.0.0/).

Keep commits cohesive and limited to reviewed task changes. Report what changed, why, verification performed, and material remaining limitations. Update [status](../status.md) only with current work and the next useful entry point; commit history retains completed change history.

## Versions and releases

Versions follow [SemVer](https://semver.org/). `package.json` and the Cargo workspace (`[workspace.package] version`) hold the version; `pnpm version:set X.Y.Z` writes both and `pnpm check:version` checks they agree. Before 1.0, MINOR rises when a feature stage reaches `main` and PATCH for a fix round; the first public release starts the 1.x line.

Work happens on `dev` and is merged into `main` once stable. The `Build` workflow (`.github/workflows/build.yml`) runs `pnpm check` on every push to either branch, then publishes the server image to `ghcr.io/<owner>/gripread` and a signed APK as a GitHub release: `dev` builds are pre-releases versioned `X.Y.Z-dev.<run>` (image tags `dev` and the full version; the five newest pre-releases are kept), and `main` builds are releases `vX.Y.Z` (image tags `latest`, `X.Y.Z`, and `X.Y`). A `main` build fails when `vX.Y.Z` already exists, so a release carries a version raise. The APK's `versionCode` is the workflow run number. The release keystore lives outside the repository and reaches CI only through the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` secrets; local builds stay debug-signed. arm64 images build on GitHub's arm runners once the `ARM64_IMAGE` repository variable is `true`.
