# GripRead agent instructions

## Start here

Read [current status](.ai/status.md) and the [workflow](.ai/engineering/workflow.md), then use the [documentation map](.ai/README.md) to find the task's specifications. Read [architecture](.ai/architecture.md) before changing module dependencies or shared interfaces. Follow [.ai/AGENTS.md](.ai/AGENTS.md) when editing documentation.

## Working rules

- Follow the latest explicit user direction. A roadmap describes dependencies, not authorization to start additional stages; finish the assigned scope and report its outcome.
- Inspect existing code and worktree changes before editing. Preserve unrelated work. Agree on shared interfaces and non-overlapping file ownership before parallel implementation; review the combined result before committing.
- Keep business rules out of page components. Respect the documented module dependencies; update all affected consumers when changing an interface.
- Keep one authoritative definition for each behavior or type. Update its owning documentation with the implementation; record durable decisions using the [documentation standard](.ai/AGENTS.md).
- Run checks appropriate to the change and report actual results, including checks not run. Do not silence failures by weakening assertions, disabling rules globally, or hiding errors. See [verification](.ai/engineering/testing.md).
- Write maintained documentation in English. Keep machine paths, session transcripts, tool assignments, credentials, and generated build output out of project specifications.

## Git

Use `main` as the default branch and `codex/` for new feature branches. Preserve existing changes and avoid destructive history operations. Use Conventional Commits as defined in the [workflow](.ai/engineering/workflow.md). Commit only reviewed changes within the assigned scope.
