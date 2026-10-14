# Updates

Status: implemented

## Scope

The app finds newer GripRead releases, shows their notes, and installs them: Android downloads its APK and opens the system installer, macOS runs the Tauri updater and relaunches, and the web version only says that a newer server image exists. Releases come from GitHub ([versions and releases](../engineering/workflow.md#versions-and-releases)); while a device is connected to a GripRead [server](server.md), they come through the server's mirror.

## Interfaces

`crates/core/src/update.rs` owns the rules; its commands are `get_update_settings`, `save_update_settings`, `check_update` (the running version in, an `UpdateCheck` out), and `install_update` (a version and an operation id; progress as `update-progress`, cancelled with `cancel_source_operation`). Settings are kept on the device in `update.json`: the channel (正式版 `stable`, releases only; 测试版 `beta`, pre-releases too), 自动检查更新, the last check, and a skipped version. They are never in backups or sync records.

The platform answers how it updates (`Platform::update_target`): Android reports its ABIs and a cache folder through `UpdatePlugin`, macOS reports its updater platform key, and the server and other desktops report none. The server's mirror is `GET /api/update/releases` (the GitHub release list, cached ten minutes, the stale copy answering while GitHub fails) and `GET /api/update/asset/{tag}/{name}` (files the release lists, downloaded once and kept for the two newest tags), both behind a session.

## Behavior

A check takes the channel's releases, ignores drafts and unparsable tags, orders them by SemVer (pre-releases before their release, so a local `X.Y.Z-alpha` build is offered the beta and release of its version), and offers the newest when it is newer than the running version. Android picks the APK of its first supported ABI and falls back to the universal APK; the download is verified against the release's `SHA256SUMS`, older downloads are removed, and a failed download through the server retries GitHub directly. Android 8 and later first need 安装未知应用 allowed for GripRead; the install then reports `needsPermission` and opens that setting. GitHub requests verify certificates, follow redirects, and use the app's or the device's proxy.

关于 checks when it opens and lists the channel's recent releases as 更新日志, showing each release page's changes without its download, image, and checksum sections. With 自动检查更新 on, the app checks at most once a day at start and offers a newer, not skipped version with 立即更新, 跳过此版本, and 稍后. The web version never prompts; 关于 shows the `docker pull` line for the new image.

## Acceptance

- The stable channel offers the newest release; the beta channel also offers newer pre-releases; nothing newer offers nothing.
- An arm64 phone downloads the arm64-v8a APK, an x86_64 one the universal APK when no x86_64 APK exists; a corrupted download is rejected.
- A connected device checks and downloads through its server; when the server fails, GitHub answers.
- Installing without the install permission opens its setting; after allowing it, 立即更新 opens the system installer, which installs over the running app.
- macOS downloads, verifies, installs, and relaunches; the web version shows the image line only.
