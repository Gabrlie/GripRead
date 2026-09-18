# Import recovery and indexed local content

Status: proposed

## Problem

File renames and SQLite commits are separate operations. Process interruption can leave uncommitted managed files, and cached database hashes do not detect externally replaced content. Full-file indexing on every content window also blocks normal reading work.

## Proposal

Use a data-directory exclusive lock and an additive migration for an import journal, content metadata, and reader preferences. Record file ownership before publishing a managed file; reconcile pending imports against committed assets on startup. Perform normalization, hashing, and index preparation outside the short database transaction on blocking workers. A completed operation carries its committed result exactly once.

Use reconstructible sparse UTF-16/byte indexes, with hash verification on first use and invalidation when file identity or metadata changes. Reject changed managed content rather than applying old locators. Preserve existing book/asset identities and valid position records during migration. The source declarations remain authoritative for wire types.

## Alternatives considered

A destructor-only cleanup handles ordinary errors but cannot recover a killed process. Rebuilding a full boundary vector on every read is simple but scales with total book size instead of the requested window. Resetting the database would discard user progress and is excluded.

## Acceptance criteria

Verify interruption before and after rename/commit, cancellation, duplicate import, migration from version 1, same-length content replacement, exclusive ownership, and bounded forward/backward Unicode reads.

## Risks

Journal recovery must only remove owned uncommitted files. Index corruption must trigger rebuild or an explicit error. Test-only fault injection and data-directory overrides must not enter production builds.
