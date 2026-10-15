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

Versions follow [SemVer](https://semver.org/). `package.json` and the Cargo workspace (`[workspace.package] version`) hold the version; `pnpm version:set X.Y.Z` writes both and `pnpm check:version` checks they agree. MINOR rises for a major capability such as RSS, comics, or AI assistance (`0.2.x` → `0.3.0`); PATCH rises for everything else, including smaller features, improvements, and fixes (`0.2.0` → `0.2.1`). MAJOR stays 0 until the user declares the first stable release. Raise the version on `dev` when a round starts, so its pre-releases sort after the last release and reach the updater's development channel.

Work happens on `dev` and is merged into `main` once stable. The `Build` workflow (`.github/workflows/build.yml`) runs `pnpm check` on every push to either branch; nothing is built for distribution on a push, and small fixes wait for the next publish. Pushing a version tag publishes the server image to `ghcr.io/<owner>/gripread` and a GitHub release with signed Android APKs (arm64-v8a, armeabi-v7a, x86, x86_64, and a universal APK) and macOS apps (Apple Silicon and Intel, unsigned for Gatekeeper, with signed updater archives and `latest.json`). A tag `vX.Y.Z-beta.N` is a pre-release for testing a round on GitHub (image tags `dev` and the full version; the five newest pre-releases are kept); a tag `vX.Y.Z` on a commit of `main` is a release (image tags `latest`, `X.Y.Z`, and `X.Y`). The tag's `X.Y.Z` must equal `package.json`, so a release carries a version raise. A release lists its installers first, by platform (`GripRead-<version>-Android-<abi>.apk`, `GripRead-<version>-macOS-<AppleSilicon|Intel>.dmg`), then `SHA256SUMS`, `latest.json`, and the macOS updater archives (`updater-macos-<arm64|x64>.app.tar.gz` and `.sig`), which in-app updates need. A tag on a commit whose `dev` or `main` push passed the checks skips them, waiting for that run to appear and finish when the commit is the branch tip (both are usually pushed together), since a tag cannot read the branch's build cache and would compile everything again; tag runs also save no build caches of their own. Tags are pushed only when the user asks for a release or a GitHub pre-release.

Android build numbers count minutes since 2026 (`scripts/version.mjs`), and each APK's `versionCode` is that number times ten plus an ABI digit (`build.gradle.kts`), so any later build, from CI or from a developer's machine, installs over an earlier one. `pnpm android:release` builds a signed release APK locally for trying a change on a phone, versioned `X.Y.Z-alpha.<UTC time>` so the updater still offers the beta and release of the same version; it is the normal way to test a batch before anything is published. `scripts/release.mjs` writes the release page: the [changelog](../../CHANGELOG.md) entry (`Unreleased` for pre-releases, so user-facing changes are added there as they land and the section is renamed when the version is released), the Conventional Commits since the previous release of the same kind, a download table, the image, checksums (`SHA256SUMS`), and a compare link. The release keystore and the updater key live outside the repository and reach CI only through the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets; local release builds read the same values from the environment, and `pnpm android:build` stays debug-signed. arm64 images build on GitHub's arm runners while the `ARM64_IMAGE` repository variable is `true`.
