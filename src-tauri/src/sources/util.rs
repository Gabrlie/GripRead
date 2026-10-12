//! URL resolution and HTML entity decoding with Legado's behavior.

/// Splits a source URL into the address and its `,{…}` option suffix.
pub fn split_url_option(url: &str) -> (&str, &str) {
    let bytes = url.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b',' {
            let rest = url[index + 1..].trim_start();
            if rest.starts_with('{') && !rest.starts_with("{{") {
                return (url[..index].trim_end(), &url[index..]);
            }
        }
        index += 1;
    }
    (url, "")
}

pub fn is_absolute_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

pub fn is_data_url(url: &str) -> bool {
    url.trim_start().to_ascii_lowercase().starts_with("data:")
}

fn remove_dot_segments(path: &str) -> String {
    let mut output: Vec<&str> = Vec::new();
    let ends_with_slash = path.ends_with('/') || path.ends_with("/.") || path.ends_with("/..");
    for segment in path.split('/') {
        match segment {
            "." => {}
            ".." => {
                if output.len() > 1 {
                    output.pop();
                }
            }
            other => output.push(other),
        }
    }
    let mut joined = output.join("/");
    if ends_with_slash && !joined.ends_with('/') {
        joined.push('/');
    }
    if !joined.starts_with('/') {
        joined.insert(0, '/');
    }
    joined
}

/// Resolves `relative` against `base` without re-encoding either, as Java's
/// `URL(base, relative)` does, so a GBK query stays as written. A `,{…}`
/// option suffix is carried over unchanged.
pub fn absolute_url(base: &str, relative: &str) -> String {
    let relative = relative.trim();
    if base.trim().is_empty() || is_absolute_url(relative) || is_data_url(relative) {
        return relative.to_string();
    }
    if relative.to_ascii_lowercase().starts_with("javascript") {
        return String::new();
    }
    let (base, _) = split_url_option(base.trim());
    let (address, option) = split_url_option(relative);
    let Some(scheme_end) = base.find("://") else {
        return relative.to_string();
    };
    let scheme = &base[..scheme_end];
    let after_scheme = &base[scheme_end + 3..];
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let origin = &base[..scheme_end + 3 + authority_end];
    let rest = &after_scheme[authority_end..];
    let path_end = rest.find(['?', '#']).unwrap_or(rest.len());
    let base_path = if rest[..path_end].is_empty() {
        "/"
    } else {
        &rest[..path_end]
    };
    let base_without_fragment = &base[..base.find('#').unwrap_or(base.len())];
    let resolved = if address.is_empty() {
        base_without_fragment.to_string()
    } else if let Some(rest) = address.strip_prefix("//") {
        format!("{scheme}://{rest}")
    } else if address.starts_with('/') {
        let path_end = address.find(['?', '#']).unwrap_or(address.len());
        format!(
            "{origin}{}{}",
            remove_dot_segments(&address[..path_end]),
            &address[path_end..]
        )
    } else if address.starts_with('?') {
        format!("{origin}{base_path}{address}")
    } else if address.starts_with('#') {
        format!("{base_without_fragment}{address}")
    } else {
        let directory = &base_path[..base_path.rfind('/').map_or(0, |at| at + 1)];
        let path_end = address.find(['?', '#']).unwrap_or(address.len());
        let merged = format!("{directory}{}", &address[..path_end]);
        format!(
            "{origin}{}{}",
            remove_dot_segments(&merged),
            &address[path_end..]
        )
    };
    format!("{resolved}{option}")
}

const ENTITIES: &[(&str, &str)] = &[
    ("amp", "&"),
    ("lt", "<"),
    ("gt", ">"),
    ("quot", "\""),
    ("apos", "'"),
    ("nbsp", "\u{a0}"),
    ("ensp", "\u{2002}"),
    ("emsp", "\u{2003}"),
    ("thinsp", "\u{2009}"),
    ("zwnj", "\u{200c}"),
    ("zwj", "\u{200d}"),
    ("copy", "©"),
    ("reg", "®"),
    ("trade", "™"),
    ("middot", "·"),
    ("hellip", "…"),
    ("mdash", "—"),
    ("ndash", "–"),
    ("lsquo", "‘"),
    ("rsquo", "’"),
    ("ldquo", "“"),
    ("rdquo", "”"),
    ("laquo", "«"),
    ("raquo", "»"),
    ("times", "×"),
    ("divide", "÷"),
    ("bull", "•"),
    ("yen", "¥"),
    ("deg", "°"),
    ("plusmn", "±"),
    ("sect", "§"),
    ("para", "¶"),
    ("shy", "\u{ad}"),
];

/// `StringEscapeUtils.unescapeHtml4` for named and numeric entities.
pub fn unescape_html(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let candidate = &rest[at + 1..];
        let end = candidate.find(';').filter(|&end| end <= 10);
        let decoded = end.and_then(|end| {
            let name = &candidate[..end];
            if let Some(number) = name.strip_prefix('#') {
                let code = match number.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => number.parse::<u32>().ok(),
                };
                code.and_then(char::from_u32).map(|c| (c.to_string(), end))
            } else {
                ENTITIES
                    .iter()
                    .find(|(entity, _)| *entity == name)
                    .map(|(_, value)| ((*value).to_string(), end))
            }
        });
        match decoded {
            Some((value, end)) => {
                out.push_str(&value);
                rest = &candidate[end + 1..];
            }
            None => {
                out.push('&');
                rest = candidate;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_resolve_like_java() {
        let base = "https://example.com/book/12/index.html?x=1";
        assert_eq!(
            absolute_url(base, "1.html"),
            "https://example.com/book/12/1.html"
        );
        assert_eq!(
            absolute_url(base, "/a/b.html"),
            "https://example.com/a/b.html"
        );
        assert_eq!(
            absolute_url(base, "../2.html"),
            "https://example.com/book/2.html"
        );
        assert_eq!(
            absolute_url(base, "//cdn.example.com/c.jpg"),
            "https://cdn.example.com/c.jpg"
        );
        assert_eq!(
            absolute_url(base, "?page=2"),
            "https://example.com/book/12/index.html?page=2"
        );
        assert_eq!(
            absolute_url(base, "https://other.com/x"),
            "https://other.com/x"
        );
        assert_eq!(
            absolute_url(base, "/s?q=中文,{\"method\":\"POST\"}"),
            "https://example.com/s?q=中文,{\"method\":\"POST\"}"
        );
        assert_eq!(
            absolute_url("https://example.com", "a.html"),
            "https://example.com/a.html"
        );
        assert_eq!(absolute_url(base, "javascript:void(0)"), "");
    }

    #[test]
    fn entities_decode() {
        assert_eq!(
            unescape_html("a&amp;b &lt;p&gt; &#20013;&#x6587; &nbsp;&unknown;"),
            "a&b <p> 中文 \u{a0}&unknown;"
        );
    }

    #[test]
    fn url_options_split_at_the_option_object() {
        assert_eq!(
            split_url_option("https://x/s,{\"a\":1}"),
            ("https://x/s", ",{\"a\":1}")
        );
        assert_eq!(
            split_url_option("https://x/s?a={{key}},b"),
            ("https://x/s?a={{key}},b", "")
        );
    }
}
