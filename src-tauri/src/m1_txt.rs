use crate::models::{Bookmark, ReaderLocator, SearchMatch};
use crate::txt::utf16_boundaries;

const CONTEXT_UNITS: usize = 32;

pub(crate) fn make_toc_locator(
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
    fn single_pass_toc_preserves_context_when_surrogates_cross_window_edges() {
        for padding in 0..40 {
            let text = format!(
                "😀{}\nChapter 1\n{}😀\nChapter 2",
                "a".repeat(padding),
                "b".repeat(padding)
            );
            let rule = crate::txt_toc::TocBuildRule {
                automatic: false,
                rules: vec![crate::txt_toc::RuleSpec {
                    id: "chapter".into(),
                    name: "chapter".into(),
                    pattern: "^Chapter \\d+$".into(),
                }],
                split_long_chapters: false,
            };
            let built = crate::txt_toc::build_toc(&text, "book", "version", &rule).unwrap();
            for entry in built.entries {
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
