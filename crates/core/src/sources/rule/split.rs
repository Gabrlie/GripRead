//! Rule splitting with Legado's `RuleAnalyzer` balancing: separators inside
//! brackets, parentheses, or quoted text inside them do not split.

/// How a compound rule combines its parts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Joiner {
    /// `&&`: every part's results, concatenated.
    And,
    /// `||`: the first part with results.
    Or,
    /// `%%`: results interleaved item by item.
    Interleave,
}

impl Joiner {
    fn token(self) -> &'static str {
        match self {
            Joiner::And => "&&",
            Joiner::Or => "||",
            Joiner::Interleave => "%%",
        }
    }
}

/// A rule split at its top-level `&&`, `||`, or `%%`. The first joiner found
/// decides how the whole rule combines, as in Legado.
#[derive(Debug, Clone)]
pub struct Compound {
    pub parts: Vec<String>,
    pub joiner: Option<Joiner>,
}

/// Scans `text`, calling `at` at each top-level position (outside brackets,
/// parentheses, and, when `code` is set, braces and quoted strings).
fn top_level_positions(text: &str, code: bool, mut at: impl FnMut(usize) -> Option<usize>) {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(q) = quote {
            if byte == b'\\' {
                index += 2;
                continue;
            }
            if byte == q {
                quote = None;
            }
            index += 1;
            continue;
        }
        match byte {
            b'\'' | b'"' if depth > 0 || code => quote = Some(byte),
            b'[' | b'(' => depth += 1,
            b'{' if code => depth += 1,
            b']' | b')' => depth = depth.saturating_sub(1),
            b'}' if code => depth = depth.saturating_sub(1),
            _ if depth == 0 && text.is_char_boundary(index) => {
                if let Some(skip) = at(index) {
                    index += skip;
                    continue;
                }
            }
            _ => {}
        }
        index += 1;
    }
}

pub fn split_compound(rule: &str, joiners: &[Joiner], code: bool) -> Compound {
    let mut parts = Vec::new();
    let mut joiner: Option<Joiner> = None;
    let mut start = 0;
    top_level_positions(rule, code, |index| {
        let rest = &rule[index..];
        let found = match joiner {
            Some(current) => rest.starts_with(current.token()).then_some(current),
            None => joiners
                .iter()
                .copied()
                .find(|j| rest.starts_with(j.token())),
        }?;
        joiner = Some(found);
        parts.push(rule[start..index].to_string());
        start = index + 2;
        Some(2)
    });
    parts.push(rule[start..].to_string());
    Compound { parts, joiner }
}

/// Splits at top-level occurrences of a one-character separator.
pub fn split_char(rule: &str, separator: u8) -> Vec<String> {
    let mut parts = Vec::new();
    let mut start = 0;
    top_level_positions(rule, false, |index| {
        if rule.as_bytes()[index] == separator {
            parts.push(rule[start..index].to_string());
            start = index + 1;
            Some(1)
        } else {
            None
        }
    });
    parts.push(rule[start..].to_string());
    parts.into_iter().filter(|part| !part.is_empty()).collect()
}

/// Replaces each balanced `{$.…}`-style inner rule with `evaluate`'s result.
/// Returns an empty string when nothing was replaced, as Legado's
/// `innerRule` does, so callers can fall back to the rule itself.
pub fn inner_rule(
    rule: &str,
    open: &str,
    mut evaluate: impl FnMut(&str) -> Option<String>,
) -> String {
    let mut out = String::new();
    let mut copied_to = 0;
    let mut search_from = 0;
    while let Some(found) = rule[search_from..].find(open) {
        let begin = search_from + found;
        match balanced_brace_end(rule, begin) {
            Some(end) => {
                let inner = &rule[begin + 1..end];
                if let Some(value) = evaluate(inner).filter(|value| !value.is_empty()) {
                    out.push_str(&rule[copied_to..begin]);
                    out.push_str(&value);
                    copied_to = end + 1;
                    search_from = end + 1;
                    continue;
                }
                search_from = begin + open.len();
            }
            None => search_from = begin + open.len(),
        }
    }
    if copied_to == 0 {
        return String::new();
    }
    out.push_str(&rule[copied_to..]);
    out
}

/// The index of the `}` balancing the `{` at `open`, skipping quoted text.
pub fn balanced_brace_end(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut index = open;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(q) = quote {
            if byte == b'\\' {
                index += 2;
                continue;
            }
            if byte == q {
                quote = None;
            }
        } else {
            match byte {
                b'\'' | b'"' => quote = Some(byte),
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(index);
                    }
                }
                _ => {}
            }
        }
        index += 1;
    }
    None
}

/// The `{{…}}` expressions in `text`, as (start, end, inner) with `end`
/// exclusive. Nested braces inside the expression are balanced.
pub fn double_brace_spans(text: &str) -> Vec<(usize, usize, String)> {
    let mut spans = Vec::new();
    let mut from = 0;
    while let Some(found) = text[from..].find("{{") {
        let begin = from + found;
        let bytes = text.as_bytes();
        let mut depth = 0usize;
        let mut quote: Option<u8> = None;
        let mut index = begin;
        let mut end = None;
        while index < bytes.len() {
            let byte = bytes[index];
            if let Some(q) = quote {
                if byte == b'\\' {
                    index += 2;
                    continue;
                }
                if byte == q {
                    quote = None;
                }
            } else {
                match byte {
                    b'\'' | b'"' | b'`' if depth >= 2 => quote = Some(byte),
                    b'{' => depth += 1,
                    b'}' => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 && index > begin + 1 && bytes[index - 1] == b'}' {
                            end = Some(index + 1);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            index += 1;
        }
        match end {
            Some(end) => {
                spans.push((begin, end, text[begin + 2..end - 2].to_string()));
                from = end;
            }
            None => break,
        }
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_joiner_decides_and_brackets_protect_separators() {
        assert_eq!(
            split_compound("text.下一页@href", &[Joiner::And], false).parts,
            vec!["text.下一页@href"]
        );
        let compound = split_compound("a&&b[x&&y]||c&&d", &[Joiner::And, Joiner::Or], false);
        assert_eq!(compound.joiner, Some(Joiner::And));
        assert_eq!(compound.parts, vec!["a", "b[x&&y]||c", "d"]);
        let single = split_compound("class.x@text", &[Joiner::And], false);
        assert_eq!(single.parts, vec!["class.x@text"]);
        assert_eq!(single.joiner, None);
    }

    #[test]
    fn at_splits_respect_attribute_selectors() {
        assert_eq!(
            split_char("div[title=a@b]@a@href", b'@'),
            vec!["div[title=a@b]", "a", "href"]
        );
    }

    #[test]
    fn inner_rules_are_replaced_or_left_empty() {
        let out = inner_rule("https://x/{$.id}/{$.name}", "{$.", |inner| {
            Some(format!("<{inner}>"))
        });
        assert_eq!(out, "https://x/<$.id>/<$.name>");
        assert_eq!(inner_rule("$.plain", "{$.", |_| Some("x".into())), "");
    }

    #[test]
    fn double_braces_balance_nested_objects() {
        let spans = double_brace_spans("a{{ {k:1}.k }}b{{key}}");
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].2, " {k:1}.k ");
        assert_eq!(spans[1].2, "key");
    }
}
