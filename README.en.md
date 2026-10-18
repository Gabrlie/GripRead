<div align="center">

<img src="src-tauri/icons/icon.png" width="120" alt="GripRead" />

[简体中文](README.md) · **English**

# GripRead · 手不释卷

**Read novels on your phone, your desktop, and in the browser — and pick up exactly where you left off.**

A lightweight, local-first reader built with Tauri 2, with an optional self-hosted server for real-time sync.

[![Build](https://github.com/Gabrlie/GripRead/actions/workflows/build.yml/badge.svg)](https://github.com/Gabrlie/GripRead/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/Gabrlie/GripRead?include_prereleases&label=release&color=4c8bf5)](https://github.com/Gabrlie/GripRead/releases)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Image](https://img.shields.io/badge/image-ghcr.io%2Fgabrlie%2Fgripread-2496ed?logo=docker&logoColor=white)](https://github.com/Gabrlie/GripRead/pkgs/container/gripread)
<br />
![Android](https://img.shields.io/badge/Android-3ddc84?logo=android&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![Web](https://img.shields.io/badge/Web-ff7139?logo=firefoxbrowser&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri_2-24c8db?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-b7410e?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-087ea4?logo=react&logoColor=white)

[Features](#features) · [Server](#server) · [Downloads](#downloads) · [Building from source](#building-from-source) · [Development](#development)

</div>

> [!NOTE]
> GripRead is in early development (0.x). The interface is in Chinese, and data formats may still change between versions — make a backup (设置 › 备份与恢复) before upgrading.

## Features

<table>
<tr>
<td width="50%" valign="top">

### 📖 Reading

- **Local books** — import TXT files or whole folders; encodings (UTF-8, GBK) are detected and chapters found with Legado-style rules
- **Page turns** — curl, slide, cover, fade, or none; a scrolling mode; two-page spreads on wide screens
- **Typography** — fonts, size, spacing, margins, themes, and background images
- **Tools** — table of contents, full-text search, bookmarks, replacement rules, simplified/traditional conversion, auto-turn, and read-aloud

</td>
<td width="50%" valign="top">

### 🌐 Online books

- **Book sources** — Legado-compatible text sources for search, discovery, details, and chapters
- **Bring your own** — GripRead ships no sources; import a source list from a URL, a file, or the clipboard
- **Follow and cache** — add online books to the shelf, cache chapters for offline reading, and refresh the shelf with a pull or automatically

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📚 Library

- **Shelf** — groups, reading states, sorting, and a recycle bin
- **Reading records** — reading time per book and a daily activity calendar
- **Backups** — portable backups that restore item by item, with categories you can skip

</td>
<td width="50%" valign="top">

### 🔄 Sync

- **WebDAV** — a cloud book folder, backups, and reading progress, with no account needed
- **GripRead server** — the shelf, progress, bookmarks, rules, sources, and settings sync between devices within seconds
- **Your choice** — excluded categories are never uploaded or overwritten

</td>
</tr>
</table>

## Server

The server is a single container that serves the web version of your library and is the sync hub for your devices. It is built for one user.

```sh
docker run -d --name gripread \
  -p 8080:8080 \
  -v gripread-data:/data \
  --restart unless-stopped \
  ghcr.io/gabrlie/gripread:latest
```

Open `http://<host>:8080` and set a password on the first visit. For use outside your network, put a reverse proxy with HTTPS (Caddy, nginx) in front of it. [`docker-compose.example.yml`](docker-compose.example.yml) is a Compose starting point.

| Variable            | Default | Meaning                                    |
| ------------------- | ------- | ------------------------------------------ |
| `GRIPREAD_DATA`     | `/data` | The data folder: library, account, backups |
| `GRIPREAD_PORT`     | `8080`  | The port to listen on                      |
| `GRIPREAD_PASSWORD` | unset   | Sets the password on the first start only  |

<details>
<summary><b>Connecting your devices</b></summary>

1. In the app, open 设置 › 备份与云端 › 服务器同步.
2. Enter the server address, the password, and a name for this device, then tap 连接.
3. Local books upload to the server, and books the server has download to the device (you can turn that off).

While connected, WebDAV backups and progress sync pause; they resume when you disconnect. Progress from another device never moves your page silently — the reader asks before jumping. The server keeps a daily backup of its own library.

</details>

## Downloads

| Channel     | Branch | Image tags        | App                                                                   |
| ----------- | ------ | ----------------- | --------------------------------------------------------------------- |
| Stable      | `main` | `latest`, `X.Y.Z` | [Latest release](https://github.com/Gabrlie/GripRead/releases/latest) |
| Pre-release | `dev`  | `dev`             | [Pre-releases](https://github.com/Gabrlie/GripRead/releases)          |

Every release provides:

- **Android:** arm64-v8a (most phones), armeabi-v7a (older 32-bit phones), x86_64 / x86 (emulators and some tablets), and a universal APK with every ABI.
- **macOS:** one `.dmg` each for Apple Silicon and Intel. The app is unsigned: on first launch, right-click it and choose Open, or click Open Anyway in System Settings › Privacy & Security.

Each release page lists the changes, the commits, and a `SHA256SUMS` file; see the [changelog](CHANGELOG.md) for the history. Versions follow [SemVer](https://semver.org/); pre-releases for testing are versioned `X.Y.Z-beta.N`.

## Building from source

**Requirements:** Node.js 22+, pnpm, and stable Rust. On Linux, Tauri also needs the [WebKitGTK development packages](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev               # run the desktop app
pnpm tauri build --debug     # build the desktop app
docker build -t gripread .   # build the server image
```

**Android** needs JDK 17 and the Android SDK and NDK, located through `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME`:

```sh
pnpm android:build           # a debug APK for arm64
```

## Development

```sh
pnpm check                   # formatting, docs, types, tests, lints, and the frontend build
```

| Path             | Contents                                                              |
| ---------------- | --------------------------------------------------------------------- |
| `src/`           | The React interface, shared by the app and the web version            |
| `crates/core/`   | The library, reader, sources, backups, and sync, independent of Tauri |
| `crates/server/` | The server: web version, account, and sync endpoints                  |
| `src-tauri/`     | The Tauri shell and Android plugins                                   |
| `.ai/`           | Specifications, decisions, and plans                                  |

Start with [AGENTS.md](AGENTS.md) and the [documentation map](.ai/README.md). The [architecture](.ai/architecture.md) describes the modules and their dependencies, and the [workflow](.ai/engineering/workflow.md) covers branches, commits, versions, and releases. Changes go to `dev` and reach `main` once stable.

## Roadmap

Directions ahead, without promised dates:

- **Comics:** online comic sources, local comics (CBZ, ZIP, image folders), and a dedicated comic reader (0.3.1, in progress).
- **RSS:** feed management, article reading, full-text fetching, and read and favourite state synced across devices.
- **AI retrieval and questions:** answers about a book's characters and plot bounded by how far you have read, without spoilers, and searching across books.
- **Audio books and reading aloud:** more natural voices and audio book support.
- **Desktop platforms:** Windows and Linux builds.
- **The web version:** the same features as the apps.

## Disclaimer

1. GripRead is free, open-source software, for learning and for reading content you have the right to read.
2. GripRead provides and hosts no books and includes no book sources. Content from book sources and subscriptions comes from third-party websites that you add yourself, and has nothing to do with GripRead or its developers. Follow your local laws and the websites' terms of service, respect authors' copyright, and support the official releases.
3. Translation sends text to the third-party translation services you configure; their fees, privacy, and output are governed by those services and their terms.
4. The developers collect no personal data. Books, progress, and settings are kept on your devices and on the WebDAV or self-hosted server you choose; keep your own backups.
5. GripRead is provided "as is", without any warranty. The developers are not liable for data loss or any other damage arising from its use.
6. If you believe some content infringes your rights, contact the website that provides it.

By using GripRead you confirm that you have read and agree to the above. The app shows this on first launch, and it can be read again under Settings › About.

## Acknowledgements

- [Legado (阅读)](https://github.com/gedoor/legado) — GripRead's reading behavior and book source format follow it.
- [OpenCC](https://github.com/BYVoid/OpenCC) — the simplified/traditional conversion tables (Apache-2.0).
- [Tauri](https://tauri.app/), [React](https://react.dev/), and [shadcn/ui](https://ui.shadcn.com/).

## License

GripRead is free software under the [GNU General Public License v3.0](LICENSE). You may use, study, modify, and share it; if you distribute it or a modified version, you must release the source under the same license.
