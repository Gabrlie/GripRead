# Implementation roadmap

Status: planned

## Stage dependencies

Stages describe technical dependencies and completion criteria. They do not authorize unassigned work. The [current status](../status.md) records active scope; use the [task template](task-template.md) for a bounded implementation task.

## M0: Foundation

Establish the Tauri/React application, typed service interfaces, local file and SQLite access, minimal content-location and pagination experiments, Motion integration, and executable engineering checks. Verify the page-curl adapter against rendered pages and exercise the basic reading shell on target platforms. Use [architecture](../architecture.md), [Reader](../subsystems/reader.md), [motion design](../design/motion.md), and [verification](../engineering/testing.md).

Completion requires actual target-platform evidence for the foundational operations and a runnable local development/check workflow. Neither the source script engine nor AI/vector dependencies belong to M0.

## M1: Local reading

Deliver [Library](../subsystems/library.md) and local [Reader](../subsystems/reader.md) behavior with the corresponding [screens](../design/interaction.md) and motion. Complete import, shelf management, contents, bookmarks, search, offline reading, typography, reading modes, and settings.

The local milestone is complete when a book can be imported, read, closed, reopened, and repositioned reliably, including large text, illustrations, reflow, selection, and failures. Use the subsystem acceptance cases to demonstrate the complete user journey rather than treating a rendered screen as completion.

## M2: Online content

Begin [Legado compatibility](../subsystems/sources.md) only after M1's basic local reading journey is complete. Study ColorTxt's implementation at a recorded revision, establish representative compatibility fixtures, and choose the runtime/host bridge from measured results. Deliver the source-to-reader chain and honest capability reporting.

Implement [RSS](../subsystems/rss.md) as an independent stream of work in this stage. It does not depend on the novel interpreter. Completion requires end-to-end source fixtures and feed import, refresh, article reading, and persisted read/favorite state on the target platforms.

## M3: Cross-device reading

Implement [WebDAV synchronization](../subsystems/sync.md), the cloud book folder, durable retry, causal conflict handling, and backup/restore over the established domain records. Validate real cross-device continuation and failure recovery, then verify the initial platform installers.

Completion requires evidence for the sync acceptance cases and initial release scope. File availability, record replication, and backup restoration must each work independently.

## Later: AI assistance

After basic reading and data behavior are stable, plan the first [AIGC](../subsystems/aigc.md) feature as a separate task. Select the provider, embedding/index strategy, and generation interface then. Progress-bounded character events and recaps are the initial candidates; they are not part of M0 or a release dependency for basic reading.

## Later: further directions

These directions are listed in the READMEs' roadmap without dates; each needs its own plan before work starts.
- **Comics:** after [0.3.1](2026-10-18-comics.md)'s image sources, CBZ and ZIP files, and comic reader, folders of images and RAR (CBR) archives.
- **RSS:** subscriptions and article reading, waiting on a local branch.
- **AI retrieval and questions:** asking about a book's characters and plot within what has been read, and searching across books ([AIGC](../subsystems/aigc.md)).
- **Audio books and better reading aloud.**
- **Desktop platforms:** Windows and Linux builds.
- **The web version:** catching up with the apps' features.
