# GripRead

GripRead is a lightweight, local-first novel and RSS reader designed for continuous reading across Android, Windows, and macOS. Local files work without an account; optional WebDAV adds a cloud book folder, reading-state synchronization, and backup recovery.

The planned stack is Tauri 2, React, TypeScript, Vite, Tailwind CSS, shadcn/ui, and Motion for React. Start with the [product scope](.ai/product/requirements.md), [architecture](.ai/architecture.md), and [roadmap](.ai/plans/roadmap.md). The [current status](.ai/status.md) distinguishes implemented work from planned capabilities.

## Development

Read [AGENTS.md](AGENTS.md) and the [.ai documentation map](.ai/README.md). Application setup and build commands will be established with the foundation stage; do not infer runnable features from specifications.

Documentation checks require Node.js 22 or newer and no third-party packages:

```sh
node scripts/check-docs.mjs
node --test scripts/check-docs.test.mjs
```

See the [workflow](.ai/engineering/workflow.md) for change ownership and commits, and [verification](.ai/engineering/testing.md) for test scope.
