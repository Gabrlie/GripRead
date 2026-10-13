//! Source text Rhino accepts and QuickJS does not, rewritten before running.

use std::sync::OnceLock;

fn destructured_arrow() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(\.(?:map|forEach|filter|some|every|find|findIndex|flatMap)\()\s*\[([\w\s,]+)\]\s*=>",
        )
        .expect("valid")
    })
}

/// Prepares a script: zero-width and BOM characters (which Rhino ignores in
/// identifiers) are removed, and `.map([a, b] =>` gets the parentheses
/// QuickJS requires.
pub fn prepare(script: &str) -> String {
    let cleaned: String = script
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{feff}' | '\u{ad}'
            )
        })
        .collect();
    destructured_arrow()
        .replace_all(&cleaned, "$1([$2]) =>")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_what_quickjs_rejects() {
        assert_eq!(prepare("a\u{200b}b"), "ab");
        assert_eq!(prepare("x.map([k, v]=>k)"), "x.map(([k, v]) =>k)");
    }
}
