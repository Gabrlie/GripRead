# GripRead

GripRead is a lightweight, local-first novel and RSS reader designed for continuous reading across Android, Windows, and macOS. Local files work without an account; optional WebDAV adds a cloud book folder, reading-state synchronization, and backup recovery.

The planned stack is Tauri 2, React, TypeScript, Vite, Tailwind CSS, shadcn/ui, and Motion for React. Start with the [product scope](.ai/product/requirements.md), [architecture](.ai/architecture.md), and [roadmap](.ai/plans/roadmap.md). The [current status](.ai/status.md) distinguishes implemented work from planned capabilities.

## Development

Read [AGENTS.md](AGENTS.md) and the [.ai documentation map](.ai/README.md). The M0 smoke host is runnable on macOS after installing dependencies:

```sh
pnpm install
pnpm check
pnpm tauri dev
pnpm tauri build --debug
pnpm test:native
```

The smoke host exercises TXT import, local book listing, bounded content windows, reader turns, and position persistence. `pnpm test:native` starts the real macOS Tauri host without watch mode and verifies that the native binary reaches its running state. Product screens and M1 local-reading features remain separate tasks.

Documentation checks require Node.js 22 or newer and no third-party packages:

```sh
node scripts/check-docs.mjs
node --test scripts/check-docs.test.mjs
```

See the [workflow](.ai/engineering/workflow.md) for change ownership and commits, and [verification](.ai/engineering/testing.md) for test scope.
