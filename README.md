# GripRead · 手不释卷

GripRead is a lightweight, local-first novel and RSS reader designed for continuous reading across Android, Windows, and macOS. Local files work without an account; optional WebDAV adds a cloud book folder, reading-state synchronization, and backup recovery.

The planned stack is Tauri 2, React, TypeScript, Vite, Tailwind CSS, shadcn/ui, and Motion for React. Start with the [product scope](.ai/product/requirements.md), [architecture](.ai/architecture.md), and [roadmap](.ai/plans/roadmap.md). The [current status](.ai/status.md) distinguishes implemented work from planned capabilities.

## Server

`gripread-server` serves the web version of your library from one container; see [Server](.ai/subsystems/server.md).

```sh
docker run -d -p 8080:8080 -v gripread-data:/data ghcr.io/gabrlie/gripread:latest
```

Open `http://<host>:8080`, set a password on the first visit, and put a reverse proxy with HTTPS in front of it for use outside your network. [`docker-compose.example.yml`](docker-compose.example.yml) is a compose starting point. To build the image yourself: `docker build -t gripread .`.

## Development

Read [AGENTS.md](AGENTS.md) and the [.ai documentation map](.ai/README.md). The current M0 repair connects the product shell to local TXT services. Install dependencies and run:

```sh
pnpm install
pnpm check
pnpm tauri dev
pnpm tauri build --debug
pnpm test:native
pnpm tauri android build --debug --apk --target aarch64
```

The supported path is UTF-8 TXT import, local reading, position persistence, and reading preferences. Deferred features are marked unavailable in the interface. Android builds need JDK 17 and the Android SDK and NDK; see [verification](.ai/engineering/testing.md). `pnpm test:native` builds a dedicated macOS test application and runs the WebdriverIO embedded suite against an isolated data directory. Test plugins and test data-directory overrides are excluded from ordinary builds. See the [active repair](.ai/plans/2026-09-17-m0-repair.md) for acceptance evidence and remaining limitations.

Documentation checks require Node.js 22 or newer and no third-party packages:

```sh
node scripts/check-docs.mjs
node --test scripts/check-docs.test.mjs
```

See the [workflow](.ai/engineering/workflow.md) for change ownership and commits, and [verification](.ai/engineering/testing.md) for test scope.
