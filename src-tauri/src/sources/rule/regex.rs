//! Java regular expressions as source rules write them, on `fancy-regex`.

use fancy_regex::{Captures, Regex};

/// Compiles a Java pattern. Java's `\p{IsHan}` spelling becomes `\p{Han}`.
pub fn compile(pattern: &str) -> Result<Regex, String> {
    let translated = pattern.replace("\\p{Is", "\\p{").replace("\\P{Is", "\\P{");
    Regex::new(&translated).map_err(|error| format!("正则无效 `{pattern}`：{error}"))
}

/// Expands a Java replacement string (`$1`, `${name}`, `\$`) for a match.
fn expand(captures: &Captures<'_, str>, replacement: &str, out: &mut String) {
    let chars: Vec<char> = replacement.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        match c {
            '\\' if index + 1 < chars.len() => {
                out.push(chars[index + 1]);
                index += 2;
            }
            '$' if index + 1 < chars.len() && chars[index + 1] == '{' => {
                let close = chars[index..].iter().position(|&c| c == '}');
                match close {
                    Some(close) => {
                        let name: String = chars[index + 2..index + close].iter().collect();
                        if let Some(group) = captures.name(&name) {
                            out.push_str(group.as_str());
                        }
                        index += close + 1;
                    }
                    None => {
                        out.push(c);
                        index += 1;
                    }
                }
            }
            '$' if index + 1 < chars.len() && chars[index + 1].is_ascii_digit() => {
                // Java takes further digits only while the group exists.
                let mut group: usize = chars[index + 1].to_digit(10).unwrap_or(0) as usize;
                let mut next = index + 2;
                while next < chars.len() && chars[next].is_ascii_digit() {
                    let longer = group * 10 + chars[next].to_digit(10).unwrap_or(0) as usize;
                    if longer >= captures.len() {
                        break;
                    }
                    group = longer;
                    next += 1;
                }
                if let Some(matched) = captures.get(group) {
                    out.push_str(matched.as_str());
                }
                index = next;
            }
            _ => {
                out.push(c);
                index += 1;
            }
        }
    }
}

/// `String.replaceAll` with Java replacement syntax.
pub fn replace_all(regex: &Regex, text: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut position = 0;
    while position <= text.len() {
        let Ok(Some(captures)) = regex.captures_from_pos(text, position) else {
            break;
        };
        let whole = captures.get(0).expect("group 0 always matches");
        out.push_str(&text[last..whole.start()]);
        expand(&captures, replacement, &mut out);
        last = whole.end();
        position = if whole.end() == whole.start() {
            match text[whole.end()..].chars().next() {
                Some(c) => {
                    out.push(c);
                    last = whole.end() + c.len_utf8();
                    whole.end() + c.len_utf8()
                }
                None => break,
            }
        } else {
            whole.end()
        };
    }
    if last <= text.len() {
        out.push_str(&text[last..]);
    }
    out
}

/// `String.replaceFirst` with Java replacement syntax.
pub fn replace_first(regex: &Regex, text: &str, replacement: &str) -> String {
    match regex.captures(text) {
        Ok(Some(captures)) => {
            let whole = captures.get(0).expect("group 0 always matches");
            let mut out = String::with_capacity(text.len());
            out.push_str(&text[..whole.start()]);
            expand(&captures, replacement, &mut out);
            out.push_str(&text[whole.end()..]);
            out
        }
        _ => text.to_string(),
    }
}

fn groups(captures: &Captures<'_, str>) -> Vec<String> {
    (0..captures.len())
        .map(|index| {
            captures
                .get(index)
                .map(|group| group.as_str().to_string())
                .unwrap_or_default()
        })
        .collect()
}

/// Legado's `AnalyzeByRegex.getElement`: every pattern but the last joins
/// all its matches as the input for the next; the last returns the groups
/// of its first match.
pub fn all_in_one_element(text: &str, patterns: &[String]) -> Result<Option<Vec<String>>, String> {
    let mut input = text.to_string();
    for (index, pattern) in patterns.iter().enumerate() {
        let regex = compile(pattern)?;
        if index + 1 == patterns.len() {
            return Ok(match regex.captures(input.as_str()) {
                Ok(Some(captures)) => Some(groups(&captures)),
                _ => None,
            });
        }
        let joined: String = regex
            .find_iter(input.as_str())
            .filter_map(Result::ok)
            .map(|found| found.as_str().to_string())
            .collect();
        if joined.is_empty() {
            return Ok(None);
        }
        input = joined;
    }
    Ok(None)
}

/// Legado's `AnalyzeByRegex.getElements`: the groups of every match of the
/// last pattern.
pub fn all_in_one_elements(text: &str, patterns: &[String]) -> Result<Vec<Vec<String>>, String> {
    let mut input = text.to_string();
    for (index, pattern) in patterns.iter().enumerate() {
        let regex = compile(pattern)?;
        if index + 1 == patterns.len() {
            return Ok(regex
                .captures_iter(input.as_str())
                .filter_map(Result::ok)
                .map(|captures| groups(&captures))
                .collect());
        }
        let joined: String = regex
            .find_iter(input.as_str())
            .filter_map(Result::ok)
            .map(|found| found.as_str().to_string())
            .collect();
        if joined.is_empty() {
            return Ok(Vec::new());
        }
        input = joined;
    }
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_replacements_expand_groups_and_escapes() {
        let regex = compile(r"(\d+)-(\d+)").unwrap();
        assert_eq!(replace_all(&regex, "1-2 3-4", "$2:$1"), "2:1 4:3");
        assert_eq!(replace_all(&regex, "1-2", r"\$1"), "$1");
        assert_eq!(replace_first(&regex, "1-2 3-4", "x"), "x 3-4");
        let empty = compile("x*").unwrap();
        assert_eq!(replace_all(&empty, "ab", "-"), "-a-b-");
    }

    #[test]
    fn all_in_one_regex_returns_groups_per_match() {
        let page = "<li><a href=\"/1\">一</a></li><li><a href=\"/2\">二</a></li>";
        let items =
            all_in_one_elements(page, &[r#"<a href="([^"]+)">([^<]+)"#.to_string()]).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1][1], "/2");
        assert_eq!(items[1][2], "二");
    }

    #[test]
    fn java_unicode_script_names_compile() {
        let regex = compile(r"\p{IsHan}+").unwrap();
        assert!(regex.is_match("书名").unwrap());
    }
}
