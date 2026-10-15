# Updates

Status: implemented

## Scope

The app finds newer GripRead releases, shows their notes, and installs them: Android downloads its APK and opens the system installer, macOS runs the Tauri updater and relaunches, and the web version only says that a newer server image exists. Releases come from GitHub ([versions and releases](../engineering/workflow.md#versions-and-releases)), along the route 下载方式 picks: 自动 (through a connected GripRead [server](server.md)'s mirror, else GitHub), 直连, 代理, 加速器, or 服务器.

## Interfaces

`crates/core/src/update.rs` owns the rules; its commands are `get_update_settings`, `save_update_settings`, `check_update` (the running version in, an `UpdateCheck` out), and `install_update` (a version and an operation id; progress as `update-progress`, cancelled with `cancel_source_operation`). Settings are kept on the device in `update.json`: the channel (正式版 `stable`, releases only; 测试版 `beta`, pre-releases too), 下载方式 (`source`) with the accelerator address, 自动检查更新, the last automatic check, and a skipped version. They are never in backups or sync records.

The platform answers how it updates (`Platform::update_target`): Android reports its ABIs and a cache folder through `UpdatePlugin`, macOS reports its updater platform key, and the server and other desktops report none. The server's mirror is `GET /api/update/releases` (the GitHub release list, cached ten minutes, the stale copy answering while GitHub fails) and `GET /api/update/asset/{tag}/{name}` (files the release lists, downloaded once and kept for the two newest tags), both behind a session.

## Behavior

下载方式 decides where checks and downloads go. 自动 uses the connected server and falls back to GitHub through the app's proxy when the server fails; 直连 reaches GitHub without any proxy; 代理 through the proxy of 网络设置; 服务器 only through the connected server (an error while disconnected); 加速器 reads the release list from GitHub directly and downloads files through an accelerator address. That address is a template: `{url}` (the GitHub download address), `{path}` (it without `https://github.com/`), `{tag}`, and `{name}` are filled in, and an address with none of them is a prefix; the default is `https://gh-proxy.com/{url}`. The desktop updater reads `latest.json` and its archive along the same route (with the server's session, or the proxy).

A check takes the channel's releases, ignores drafts and unparsable tags, orders them by SemVer (pre-releases before their release, so a local `X.Y.Z-alpha` build is offered the beta and release of its version), and offers the newest when it is newer than the running version. Android picks the APK of its first supported ABI and falls back to the universal APK (`GripRead-<version>-Android-<abi>.apk`, or the lower-case names of releases up to 0.2.1-beta.1); the download is verified against the release's `SHA256SUMS`, takes its final name, and only then are older downloads removed. Under 自动, a failed download through the server starts over from GitHub. Android 8 and later first need 安装未知应用 allowed for GripRead; the install then reports `needsPermission` and opens that setting. GitHub requests verify certificates, follow redirects, and use the app's or the device's proxy.

关于 links the GitHub repository, its release page, and its issues (opened in the system browser through the opener plugin, or a new tab on the web). It checks when it opens and lists the channel's recent releases as 更新日志, showing each release page's changes without its download, image, and checksum sections. With 自动检查更新 on, the app checks at most once a day, at start or on returning to it, and offers a newer, not skipped version with 立即更新, 跳过此版本, and 稍后; checks on 关于 do not count toward the day, so they never hide the prompt. A link that cannot open says why. The web version never prompts; 关于 shows the `docker pull` line for the new image.

## Acceptance

- The stable channel offers the newest release; the beta channel also offers newer pre-releases; nothing newer offers nothing.
- An arm64 phone downloads the arm64-v8a APK, an x86_64 one the universal APK when no x86_64 APK exists; a corrupted download is rejected.
- A connected device checks and downloads through its server; when the server fails, GitHub answers (自动 only).
- 直连, 代理, and 加速器 reach GitHub as named; an accelerator template with `{url}` or a bare prefix both download the APK.
- Installing without the install permission opens its setting; after allowing it, 立即更新 opens the system installer, which installs over the running app.
- macOS downloads, verifies, installs, and relaunches; the web version shows the image line only.
