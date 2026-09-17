# Proposal: Reading-first extension boundaries

Status: proposed

## Problem

Source-runtime experiments and AI infrastructure can consume foundation work before the local reader is usable. Interface animation added after page implementation can also introduce conflicting state and gesture handling.

## Proposal

The approved design direction puts local reading before source compatibility, treats Legado behavior as the compatibility target with ColorTxt as an implementation reference, and introduces Motion with page design. AI assistance remains a later optional consumer of stable content identity and positions. The [roadmap](../../plans/roadmap.md) owns sequencing; [Sources](../../subsystems/sources.md), [Motion](../../design/motion.md), and [AIGC](../../subsystems/aigc.md) own detailed behavior.

This note remains proposed until the described extension boundaries are realized in code; approval of the documentation is not evidence of implementation.

## Alternatives considered

Fixing QuickJS and its host bridge during M0 would commit to a source runtime before evaluating the chosen compatibility reference. Copying ColorTxt's Node execution model directly would impose its platform assumptions on Tauri. Choosing a vector database during foundation work would make an optional feature influence the base application before its retrieval workload is known.

## Acceptance criteria

Source work begins after the local reading journey is complete and records a fixture-based runtime decision. Page implementations follow the motion ownership rules. Optional AI work consumes stable content and progress interfaces without becoming a dependency of normal reading.

## Risks

Deferring runtime and provider choices leaves work for their assigned stages. Those tasks must establish platform evidence and compatibility limits rather than interpreting this proposal as proof of support. Progress filtering constrains supplied evidence but requires additional output evaluation because a model may already know the book.
