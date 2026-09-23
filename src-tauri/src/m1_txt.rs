use crate::error::AppError;
use crate::models::{Bookmark, ReaderLocator, SearchMatch, TocEntry};
use crate::models::{TxtTocRule, TxtTocRuleMode};
use crate::txt::utf16_boundaries;
use regex::Regex;

const CONTEXT_UNITS: usize = 32;

pub fn build_toc(text: &str, book_id: &str, content_version: &str) -> Vec<TocEntry> {
    build_toc_with_rule(
        text,
        book_id,
        content_version,
        &TxtTocRule {
            mode: TxtTocRuleMode::Automatic,
            pattern: String::new(),
        },
    )
    .expect("automatic TOC rules do not contain a regex")
}

/// Build the TOC with a single forward pass over normalized lines. Per-entry
/// locator context is limited to `CONTEXT_UNITS` around the heading, so adding
/// chapters never triggers another walk across the full text.
pub fn build_toc_with_rule(
    text: &str,
    book_id: &str,
    content_version: &str,
    rule: &TxtTocRule,
) -> Result<Vec<TocEntry>, AppError> {
    let custom_regex = if rule.mode == TxtTocRuleMode::Custom {
        Some(Regex::new(&rule.pattern).map_err(|error| {
            AppError::invalid_argument(format!("invalid TOC rule pattern: {error}"))
        })?)
    } else {
        None
    };
    let mut entries = Vec::new();
    let mut ordinal = 0u64;
    let mut line_start_byte = 0usize;
    let mut line_start_units = 0u64;
    for raw_line in text.split_inclusive('\n') {
        let line = raw_line.strip_suffix('\n').unwrap_or(raw_line);
        if let Some(title) = chapter_title_for_rule(line, rule, custom_regex.as_ref()) {
            entries.push(TocEntry {
                ordinal,
                title,
                locator: make_toc_locator(
                    text,
                    book_id,
                    content_version,
                    line_start_byte,
                    line_start_units,
                ),
            });
            ordinal += 1;
        }
        line_start_byte += raw_line.len();
        line_start_units += raw_line.encode_utf16().count() as u64;
    }
    Ok(entries)
}

pub fn validate_toc_rule(rule: &TxtTocRule) -> Result<(), AppError> {
    if rule.mode == TxtTocRuleMode::Custom {
        Regex::new(&rule.pattern).map_err(|error| {
            AppError::invalid_argument(format!("invalid TOC rule pattern: {error}"))
        })?;
    }
    Ok(())
}

fn chapter_title(line: &str) -> Option<String> {
    chinese_chapter_title(line).or_else(|| english_chapter_title(line))
}

fn chapter_title_for_rule(
    line: &str,
    rule: &TxtTocRule,
    custom_regex: Option<&Regex>,
) -> Option<String> {
    match rule.mode {
        TxtTocRuleMode::Automatic => chapter_title(line),
        TxtTocRuleMode::Chinese => chinese_chapter_title(line),
        TxtTocRuleMode::English => english_chapter_title(line),
        TxtTocRuleMode::Custom => {
            let title = line.trim();
            (title.chars().count() <= 120 && custom_regex.is_some_and(|regex| regex.is_match(line)))
                .then(|| title.to_string())
                .filter(|title| !title.is_empty())
        }
    }
}

fn chinese_chapter_title(line: &str) -> Option<String> {
    let title = line.trim();
    if title.is_empty() || title.len() > 120 {
        return None;
    }
    let chinese = ["章", "节", "回", "卷", "篇"];
    let looks_chinese = title.starts_with('第')
        && chinese.iter().any(|suffix| title.contains(suffix))
        && title.chars().count() >= 3;
    looks_chinese.then(|| title.to_string())
}

fn english_chapter_title(line: &str) -> Option<String> {
    let title = line.trim();
    if title.is_empty() || title.len() > 120 {
        return None;
    }
    (title.to_ascii_lowercase().starts_with("chapter ") && title.chars().count() <= 100)
        .then(|| title.to_string())
}

fn make_toc_locator(
    text: &str,
    book_id: &str,
    content_version: &str,
    byte_offset: usize,
    unit_offset: u64,
) -> ReaderLocator {
    // Match the existing locator slices: round a start boundary forward and
    // an end boundary forward when the 32-unit boundary splits a surrogate.
    let before: Vec<_> = text[..byte_offset]
        .chars()
        .rev()
        .scan(0, |units, character| {
            *units += character.len_utf16();
            (*units <= CONTEXT_UNITS).then_some(character)
        })
        .collect();
    let after = text[byte_offset..]
        .chars()
        .scan(0, |units, character| {
            if *units >= CONTEXT_UNITS {
                return None;
            }
            *units += character.len_utf16();
            Some(character)
        })
        .collect();
    ReaderLocator {
        book_id: book_id.to_string(),
        content_version: content_version.to_string(),
        resource_id: "full-text".to_string(),
        offset: unit_offset,
        context_before: before.into_iter().rev().collect(),
        context_after: after,
    }
}

pub fn search_text(
    text: &str,
    book_id: &str,
    content_version: &str,
    query: &str,
    case_sensitive: bool,
    cursor: u64,
    limit: u32,
) -> (Vec<SearchMatch>, Option<u64>, bool) {
    if query.is_empty() || limit == 0 {
        return (Vec::new(), None, false);
    }
    let source: Vec<char> = text.chars().collect();
    let needle: Vec<char> = query.chars().collect();
    let mut seen = 0u64;
    let mut matches = Vec::new();
    for start in 0..source.len() {
        let Some(end) = start.checked_add(needle.len()) else {
            break;
        };
        if end > source.len() {
            break;
        }
        if source[start..end].iter().zip(&needle).all(|(left, right)| {
            if case_sensitive {
                left == right
            } else {
                left.to_lowercase().eq(right.to_lowercase())
            }
        }) {
            if seen < cursor {
                seen += 1;
            } else if matches.len() < limit as usize {
                let start_units = units_for_chars(&source, start);
                let end_units = units_for_chars(&source, end);
                matches.push(SearchMatch {
                    ordinal: seen,
                    locator: make_locator(text, book_id, content_version, start_units),
                    excerpt: excerpt(text, start_units, end_units),
                    match_start: start_units,
                    match_end: end_units,
                });
                seen += 1;
            } else {
                return (matches, Some(seen), true);
            }
        }
    }
    (matches, None, false)
}

pub fn make_bookmark(
    id: String,
    book_id: &str,
    content_version: &str,
    locator: ReaderLocator,
    excerpt: String,
    created_at: i64,
) -> Bookmark {
    Bookmark {
        id,
        book_id: book_id.to_string(),
        content_version: content_version.to_string(),
        locator,
        excerpt,
        created_at,
    }
}

fn units_for_chars(chars: &[char], count: usize) -> u64 {
    chars[..count].iter().map(|ch| ch.len_utf16() as u64).sum()
}

fn make_locator(text: &str, book_id: &str, content_version: &str, offset: u64) -> ReaderLocator {
    let boundaries = utf16_boundaries(text);
    let before_start = offset.saturating_sub(CONTEXT_UNITS as u64);
    let before = slice_units(text, &boundaries, before_start, offset);
    let after = slice_units(text, &boundaries, offset, offset + CONTEXT_UNITS as u64);
    ReaderLocator {
        book_id: book_id.to_string(),
        content_version: content_version.to_string(),
        resource_id: "full-text".to_string(),
        offset,
        context_before: before,
        context_after: after,
    }
}

fn excerpt(text: &str, start: u64, end: u64) -> String {
    let boundaries = utf16_boundaries(text);
    slice_units(
        text,
        &boundaries,
        start.saturating_sub(CONTEXT_UNITS as u64),
        end.saturating_add(CONTEXT_UNITS as u64),
    )
}

fn slice_units(text: &str, boundaries: &[(u64, usize)], start: u64, end: u64) -> String {
    let start = boundaries
        .iter()
        .find(|(units, _)| *units >= start)
        .map(|(_, byte)| *byte)
        .unwrap_or(text.len());
    let end = boundaries
        .iter()
        .find(|(units, _)| *units >= end)
        .map(|(_, byte)| *byte)
        .unwrap_or(text.len());
    text[start.min(end)..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_conservative_chapter_lines_and_safe_locators() {
        let text = "前言\n第一章 开始😀\n正文\nChapter 2\n";
        let entries = build_toc(text, "book", "version");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "第一章 开始😀");
        assert!(entries[0]
            .locator
            .context_before
            .is_char_boundary(entries[0].locator.context_before.len()));
    }

    #[test]
    fn directory_rules_select_headings_without_changing_text_offsets() {
        let text = "前言😀\n第一章 开始\n正文\nChapter 2\nPart 3 — 尾声";
        for (mode, pattern, expected) in [
            (
                TxtTocRuleMode::Automatic,
                "",
                vec!["第一章 开始", "Chapter 2"],
            ),
            (TxtTocRuleMode::Chinese, "", vec!["第一章 开始"]),
            (TxtTocRuleMode::English, "", vec!["Chapter 2"]),
            (
                TxtTocRuleMode::Custom,
                "^Part [0-9]+",
                vec!["Part 3 — 尾声"],
            ),
            (TxtTocRuleMode::Custom, "^Missing$", vec![]),
        ] {
            let entries = build_toc_with_rule(
                text,
                "book",
                "version",
                &TxtTocRule {
                    mode,
                    pattern: pattern.to_string(),
                },
            )
            .unwrap();
            assert_eq!(
                entries
                    .iter()
                    .map(|entry| entry.title.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
            for (ordinal, entry) in entries.iter().enumerate() {
                let byte_offset = text.find(&entry.title).unwrap();
                let offset = text[..byte_offset].encode_utf16().count() as u64;
                assert_eq!(entry.ordinal, ordinal as u64);
                assert_eq!(entry.locator, make_locator(text, "book", "version", offset));
            }
        }
        let invalid = TxtTocRule {
            mode: TxtTocRuleMode::Custom,
            pattern: "[".to_string(),
        };
        assert!(validate_toc_rule(&invalid).is_err());
        assert!(build_toc_with_rule(text, "book", "version", &invalid).is_err());
        assert!(build_toc("", "book", "version").is_empty());
    }

    #[test]
    fn single_pass_toc_preserves_context_when_surrogates_cross_window_edges() {
        for padding in 0..40 {
            let text = format!(
                "😀{}\nChapter 1\n{}😀\nChapter 2",
                "a".repeat(padding),
                "b".repeat(padding)
            );
            for entry in build_toc(&text, "book", "version") {
                assert_eq!(
                    entry.locator,
                    make_locator(&text, "book", "version", entry.locator.offset)
                );
            }
        }
    }

    #[test]
    fn searches_with_utf16_offsets_and_cursor() {
        let text = "😀 hello 😀 hello";
        let (first, cursor, more) = search_text(text, "book", "version", "hello", true, 0, 1);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].locator.offset, 3);
        assert_eq!(cursor, Some(1));
        assert!(more);
        let (second, _, _) = search_text(text, "book", "version", "hello", true, 1, 1);
        assert_eq!(second[0].locator.offset, 12);
    }
}
