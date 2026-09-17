# Decision: Documentation ownership

Status: implemented

## Problem

Repeating feature rules across product, architecture, workflow, and testing pages makes later edits easy to apply inconsistently. Long session records also obscure the current task and the obligations that matter to an implementation.

## Decision

Use a short root instruction file, an English documentation map, one specification per subsystem, separate interaction/motion references, bounded task records, and lifecycle-specific decision notes. The [documentation standard](../../AGENTS.md) owns placement rules and the checker enforces the mechanically verifiable parts.

The structure adapts the ownership principle in [DeepSeek Harness's documentation standard](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md) and the separation of proposals from delivered decisions in its [Agent Notes](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/README.md). It does not import that repository's runtime architecture, bilingual publishing machinery, or repository-specific commands.

## Alternatives considered

Keeping a full evolving design snapshot alongside the module specifications would retain competing versions of the same facts. Translating the old files without changing their ownership would preserve that problem. Reproducing the entire upstream documentation system would introduce maintenance work unrelated to the current project size.

## Consequences

Current behavior and intended behavior are explicitly distinguished. Historical snapshots remain available through Git; the working tree directs readers to the current owner. Review still checks requirement preservation and semantic consistency because link, heading, and word-count validation cannot establish them.
