# TXT directory rules and automatic page turning

Status: implemented

## Problem

TXT heading recognition was fixed, and the first directory load repeated full-text location work for every matched chapter. Reader controls also lacked configurable rule preview/application and automatic page turning.

## Decision

Persist each book's TXT heading rule independently from its normalized body, using an additive schema migration. Automatic, Chinese, and English presets preserve the existing heading behavior; a per-book Rust regular expression can match normalized text lines. Preview remains transient. Applying a rule changes directory metadata only and leaves content versions and UTF-16 locators unchanged. TOC cache entries are valid only for their content version and rule revision/identity. Build positions in one forward scan and coalesce concurrent builds with the same key.

Store the chosen automatic page-turn interval in reader preferences, defaulting to 8 seconds and bounded to 2–60 seconds. Running state is session-local, waits for each completed page turn, and pauses on user interaction or when the app loses focus.

## Alternatives considered

PixNovel's chapter-rule behavior extracts numbers from existing online chapter titles; it does not identify chapter headings within a TXT body. Applying it directly would preserve neither the input semantics nor reader locators. Regenerating the body or its content version when a rule changes would invalidate positions despite unchanged text, so the rule and derived directory cache have separate persistence.

## Consequences

Storage advances additively to schema 8 and preserves existing books, text, positions, and bookmarks. Custom rules use Rust regex syntax. Importing and re-decoding keep normalized content and UTF-16 locators authoritative; encoding changes regenerate rule-derived TOC data for the resulting content version. The interval survives restart, but automatic turning never resumes without user action. The [task record](../../plans/2026-09-23-import-reader-experience.md) contains review fixes, macOS native acceptance, performance results, and remaining platform evidence.
