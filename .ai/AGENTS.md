# Documentation standard

## Ownership

Each fact has one maintained home. Other documents link to that home instead of restating its defaults, schema, or acceptance cases. Keep references limited to their subject and describe children only by responsibility. The [documentation map](README.md) identifies owners.

- Root `AGENTS.md`: short rules needed in every session and links to their owners.
- This file: documentation placement, writing, lifecycle, and validation rules.
- `product/`: user goals, release scope, and product exclusions.
- `architecture.md`: module composition and allowed dependency direction.
- `design/`: presentation, interactions, and motion behavior.
- `subsystems/`: one specification per module, including interfaces, failure behavior, and acceptance cases.
- `engineering/`: development procedures and verification methods.
- `notes/`: reasons for consequential decisions and the tradeoffs actually considered.
- `plans/`: stage dependencies and bounded implementation tasks.
- `status.md`: current stage, active task, relevant blockers, and the next entry point.

## Writing

Use English for maintained prose, including instruction files. Product locale is independent of documentation language. Use one physical line per paragraph and editor soft-wrap. Prefer concrete behavior, ownership, failure, and compatibility statements over transcripts or descriptions of obvious code.

Use inline, relative Markdown links for repository files, and direct upstream links for external evidence. Reference-style links and custom HTML anchors are outside the checker's supported format; use ordinary Markdown headings for anchors. Keep source type declarations in code; document their non-obvious semantics beside their owner. Do not maintain copied API catalogs or test inventories once executable definitions exist.

Specifications describe intended behavior with `Status: planned`; change to `Status: implemented` only when the document's entire scope is delivered. During partial delivery, the active task and status record identify what exists. Decisions use the lifecycle below. Do not present plans as working functionality.

## Decisions and tasks

Create or update a decision note when changing a shared interface, persistence format, dependency direction, compatibility promise, or durable engineering policy. Routine local edits need no note. Record actual alternatives; do not invent a decision history.

A note in `notes/proposed/` uses `Status: proposed` and the headings `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, and `Risks`. Approval of a design does not mean its feature is implemented. A note in `notes/implemented/` uses `Status: implemented` and `Problem`, `Decision`, `Alternatives considered`, and `Consequences`. Move and rewrite a note when its decision is delivered, updating incoming links in the same change.

Use the [task template](plans/task-template.md) for bounded work that crosses modules or needs a handoff. Do not create empty task directories or pretend a template is an active task. Keep rationale in notes, behavior in specifications, and execution evidence in the task record. Keep obsolete snapshots in Git history rather than presenting them as current authority.

## Validation

Run the commands in [verification](engineering/testing.md). The [checker](../scripts/check-docs.mjs) owns required document sections, lifecycle rules, local-link validation, and word ceilings: root instructions 450, this standard 650, map 350, status 180, and architecture 800. These limits bound always-read context; relocate detail before raising a limit, and explain necessary increases in the change.

Review semantic duplication, lost requirements, and source accuracy manually. The checker cannot establish those facts. Add subtree instructions only when a real subtree needs additional rules; do not repeat root instructions there.
