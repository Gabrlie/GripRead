# TXT chapter rules after Legado

Status: implemented

## Problem

Heuristic Chinese/English heading detection and a single per-book custom regex produced directories that did not match how readers of Legado expect TXT books to be split: volumes, prefaces, numbered or symbol-marked headings, and books without headings were handled poorly, and the user had to preview and apply rules by hand. Book authors and introductions were never derived on import.

## Decision

Follow legado-with-MD3 tag `3.26.7` (`model/localBook/TextFile.kt`, `LocalBook.kt`, `assets/defaultData/txtTocRule.json`). Storage schema 9 adds a shared `txt_toc_rules` table seeded with Legado's 26 default rules and their enabled flags, a `book_toc_settings` row per book (selected rule or automatic, long-chapter splitting, revision), `books.intro`, and a `reader_assets` table reserved for managed reading fonts. Schema 8 per-book modes migrate to the nearest built-in rule; a custom pattern becomes a disabled user rule selected for that book; existing titles are parsed for an author.

Rules are Java-compatible regexes compiled with `fancy-regex` in multi-line mode, which supports the bounded look-behind used by Legado. Automatic choice scores enabled rules on the first 512 KB sample in table order, counting matches more than 1000 characters apart; ties go to the earlier rule, and no match falls back to 10 KB size splitting. The text is searched as if a line ended before it, so rules that require leading whitespace still find a heading on the first line. Text before the first heading becomes a 前言 chapter and the first 500 characters become the introduction; a heading with no body before the next heading is a volume when its title is named like one, so repeated or empty chapters stay chapters. Over-long chapters (more than 100 KB) split into `标题(n)` parts when enabled for the book. Titles and authors come from file names with Legado's four patterns, widened for 作者 separators and bracketed edition notes; schema 10 re-cleans authors stored before that. The TOC cache identity carries an algorithm version, so directories rebuild when the chapter algorithm changes.

A TOC cache is keyed by content version, per-book revision, and the JSON of the resolved build input (the selected rule or every enabled rule), so editing, enabling, or reordering rules invalidates exactly the books they can affect. The directory is built after an import is reported complete; an early open joins that build. Rule management (add, edit, delete user rules, enable, reorder, test, import and export Legado JSON) and per-book settings are explicit commands; [Reader](../../subsystems/reader.md) owns the behavior and the [Rust module](../../../crates/core/src/txt_toc.rs) owns the algorithm.

## Alternatives considered

Keeping the Rust `regex` crate would have required rewriting every Legado rule without look-around and would break imported Legado rules. Persisting the auto-selected rule per book (Legado's `tocUrl`) would freeze a choice made before the user enabled or edited rules; resolving it at build time keeps the directory consistent with the table. Building the directory inside the import transaction would delay the shelf by the full directory scan.

## Consequences

Directories of existing books rebuild once under the new rules, and previously cached entries are discarded rather than reinterpreted. Rules run with backtracking and are bounded by the sample size for scoring and a single pass for building; a 6 MiB fixture scores in about 0.13 s and builds in about 0.14 s on the Linux host with optimized dependencies. Legado's rules treat lines beginning with 正文 or 序章 as headings, exactly as Legado does. Imported books show parsed authors and introductions.
