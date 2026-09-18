use crate::models::{Bookmark, ReaderLocator, SearchMatch, TocEntry};
use crate::txt::utf16_boundaries;

const CONTEXT_UNITS: usize = 32;

pub fn build_toc(text: &str, book_id: &str, content_version: &str) -> Vec<TocEntry> {
    let boundaries = utf16_boundaries(text);
    let mut entries = Vec::new();
    let mut line_start_byte = 0usize;
    let mut ordinal = 0u64;
    for (line_end_byte, _) in text.match_indices('\n') {
        let line = &text[line_start_byte..line_end_byte];
        if let Some(title) = chapter_title(line) {
            let offset = boundaries
                .iter()
                .find_map(|(units, byte)| (*byte == line_start_byte).then_some(*units))
                .unwrap_or_default();
            entries.push(TocEntry {
                ordinal,
                title,
                locator: make_locator(text, book_id, content_version, offset),
            });
            ordinal += 1;
        }
        line_start_byte = line_end_byte + 1;
    }
    if line_start_byte <= text.len() {
        if let Some(title) = chapter_title(&text[line_start_byte..]) {
            let offset = boundaries
                .iter()
                .find_map(|(units, byte)| (*byte == line_start_byte).then_some(*units))
                .unwrap_or_default();
            entries.push(TocEntry {
                ordinal,
                title,
                locator: make_locator(text, book_id, content_version, offset),
            });
        }
    }
    entries
}

fn chapter_title(line: &str) -> Option<String> {
    let title = line.trim();
    if title.is_empty() || title.len() > 120 {
        return None;
    }
    let chinese = ["章", "节", "回", "卷", "篇"];
    let looks_chinese = title.starts_with('第')
        && chinese.iter().any(|suffix| title.contains(suffix))
        && title.chars().count() >= 3;
    let lower = title.to_ascii_lowercase();
    let looks_english = lower.starts_with("chapter ") && title.chars().count() <= 100;
    (looks_chinese || looks_english).then(|| title.to_string())
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
