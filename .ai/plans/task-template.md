# Implementation task template

Status: template

Copy this structure into a task-specific file only when a task is assigned. Replace instructional text with task facts. Use `Status: planned`, `Status: in-progress`, or `Status: completed`; completion requires the acceptance outcome and verification evidence. Keep this template unchanged as the reusable entry point.

## Outcome

State the user-visible result and link to the specifications that own its behavior.

## Scope

List included work and explicit exclusions. Identify allowed modules/files, shared interfaces, dependencies, and non-overlapping ownership if work is parallel.

## Interfaces

Describe input/output behavior, compatibility or migration effects, affected consumers, and integration order. Link to source declarations once they exist instead of copying types.

## Acceptance criteria

Select the applicable subsystem cases and state the observable result for this task. Include relevant failures or cancellation; do not repeat the entire product test catalog.

## Verification

List intended commands and target environments. During implementation, replace intent with actual outcomes or explicitly mark checks not run.

## Handoff

Summarize implemented behavior, remaining limitations, review findings, and the next useful entry point within the assigned scope. Link a decision note when the change affects a durable design choice.
