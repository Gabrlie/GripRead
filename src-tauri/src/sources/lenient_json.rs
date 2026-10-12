//! Lenient JSON as GSON and json-smart accept it in sources: single-quoted
//! strings, unquoted keys and values, trailing commas, and comments.

use serde_json::{Map, Number, Value};

/// Parses strict JSON first, then the lenient form.
pub fn parse(text: &str) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str(text) {
        return Ok(value);
    }
    let mut parser = Parser {
        chars: text.chars().collect(),
        index: 0,
    };
    parser.skip_space();
    let value = parser.value()?;
    parser.skip_space();
    if parser.index < parser.chars.len() {
        return Err(format!("JSON 末尾有多余内容：{}", parser.rest()));
    }
    Ok(value)
}

struct Parser {
    chars: Vec<char>,
    index: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.index).copied()
    }

    fn rest(&self) -> String {
        self.chars[self.index..].iter().take(30).collect()
    }

    fn skip_space(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_whitespace() {
                self.index += 1;
            } else if c == '/' && self.chars.get(self.index + 1) == Some(&'/') {
                while let Some(c) = self.peek() {
                    if c == '\n' {
                        break;
                    }
                    self.index += 1;
                }
            } else if c == '/' && self.chars.get(self.index + 1) == Some(&'*') {
                self.index += 2;
                while self.index < self.chars.len()
                    && !(self.peek() == Some('*') && self.chars.get(self.index + 1) == Some(&'/'))
                {
                    self.index += 1;
                }
                self.index = (self.index + 2).min(self.chars.len());
            } else {
                break;
            }
        }
    }

    fn value(&mut self) -> Result<Value, String> {
        match self.peek() {
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some(quote @ ('"' | '\'')) => {
                self.index += 1;
                self.string(quote).map(Value::String)
            }
            Some(_) => Ok(self.bare_value()),
            None => Err("JSON 意外结束".to_string()),
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        self.index += 1;
        let mut map = Map::new();
        loop {
            self.skip_space();
            match self.peek() {
                Some('}') => {
                    self.index += 1;
                    return Ok(Value::Object(map));
                }
                Some(',') => {
                    self.index += 1;
                    continue;
                }
                None => return Err("JSON 对象没有结束".to_string()),
                _ => {}
            }
            let key = match self.peek() {
                Some(quote @ ('"' | '\'')) => {
                    self.index += 1;
                    self.string(quote)?
                }
                _ => self.bare_token(&[':']),
            };
            self.skip_space();
            if self.peek() != Some(':') && self.peek() != Some('=') {
                return Err(format!("JSON 缺少冒号：{}", self.rest()));
            }
            self.index += 1;
            self.skip_space();
            let value = self.value()?;
            map.insert(key.trim().to_string(), value);
        }
    }

    fn array(&mut self) -> Result<Value, String> {
        self.index += 1;
        let mut items = Vec::new();
        loop {
            self.skip_space();
            match self.peek() {
                Some(']') => {
                    self.index += 1;
                    return Ok(Value::Array(items));
                }
                Some(',') => {
                    self.index += 1;
                    continue;
                }
                None => return Err("JSON 数组没有结束".to_string()),
                _ => items.push(self.value()?),
            }
        }
    }

    fn string(&mut self, quote: char) -> Result<String, String> {
        let mut out = String::new();
        while let Some(c) = self.peek() {
            self.index += 1;
            if c == quote {
                return Ok(out);
            }
            if c != '\\' {
                out.push(c);
                continue;
            }
            let Some(escaped) = self.peek() else { break };
            self.index += 1;
            match escaped {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                'b' => out.push('\u{8}'),
                'f' => out.push('\u{c}'),
                'u' => {
                    let hex: String = self.chars[self.index..].iter().take(4).collect();
                    let code = u32::from_str_radix(&hex, 16)
                        .map_err(|_| format!("JSON 转义无效：\\u{hex}"))?;
                    self.index += 4;
                    // Surrogate pairs come as two escapes.
                    if (0xd800..0xdc00).contains(&code)
                        && self.peek() == Some('\\')
                        && self.chars.get(self.index + 1) == Some(&'u')
                    {
                        let low: String = self.chars[self.index + 2..].iter().take(4).collect();
                        if let Ok(low) = u32::from_str_radix(&low, 16) {
                            self.index += 6;
                            let combined = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                            out.extend(char::from_u32(combined));
                            continue;
                        }
                    }
                    out.extend(char::from_u32(code));
                }
                other => out.push(other),
            }
        }
        Err("JSON 字符串没有结束".to_string())
    }

    fn bare_token(&mut self, stops: &[char]) -> String {
        let mut out = String::new();
        let mut depth = 0usize;
        while let Some(c) = self.peek() {
            if depth == 0 && (stops.contains(&c) || matches!(c, ',' | '}' | ']')) {
                break;
            }
            match c {
                '[' | '(' => depth += 1,
                ']' | ')' => depth = depth.saturating_sub(1),
                _ => {}
            }
            out.push(c);
            self.index += 1;
        }
        out
    }

    fn bare_value(&mut self) -> Value {
        let token = self.bare_token(&[]);
        let token = token.trim();
        match token {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            "null" => Value::Null,
            _ => token
                .parse::<i64>()
                .map(Value::from)
                .ok()
                .or_else(|| {
                    token
                        .parse::<f64>()
                        .ok()
                        .and_then(Number::from_f64)
                        .map(Value::Number)
                })
                .unwrap_or_else(|| Value::String(token.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_gson_leniencies() {
        let value =
            parse("{method:'POST', body: \"k=1\", n: 2, ok: true, headers:{a:b},}").unwrap();
        assert_eq!(value["method"], "POST");
        assert_eq!(value["body"], "k=1");
        assert_eq!(value["n"], 2);
        assert_eq!(value["ok"], true);
        assert_eq!(value["headers"]["a"], "b");
        let list =
            parse("[{'title':'玄幻','url':'/x/1'}, // note\n {title:都市,url:/x/2}]").unwrap();
        assert_eq!(list[1]["title"], "都市");
        assert_eq!(list[1]["url"], "/x/2");
    }

    #[test]
    fn put_maps_keep_rules_as_strings() {
        let value = parse("{bid:\"$.id\", name:class.title@text, first:$.list[0]}").unwrap();
        assert_eq!(value["first"], "$.list[0]");
        assert_eq!(value["bid"], "$.id");
        assert_eq!(value["name"], "class.title@text");
    }
}
