//! Text transforms applied when a TXT is decoded: Legado's replace rules,
//! then simplified/traditional conversion. A transform is a pure function of
//! the decoded text and its spec, so the stored spec reproduces the managed
//! text exactly for verification, repair, and position relocation.

use std::collections::HashMap;
use std::sync::OnceLock;

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::models::ChineseConversion;

/// One replace rule as applied; ordering follows the rule table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct TransformRule {
    pub(crate) pattern: String,
    pub(crate) replacement: String,
    pub(crate) regex: bool,
}

/// A local book read translated: lines found in the snapshot `snapshot`
/// (a fixed file of translations, see [`crate::translation`]) are replaced
/// by, or followed by, their translation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct TranslationSpec {
    pub(crate) snapshot: String,
    pub(crate) bilingual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub(crate) struct TextTransform {
    pub(crate) rules: Vec<TransformRule>,
    pub(crate) chinese: ChineseConversion,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) translation: Option<TranslationSpec>,
}

impl TextTransform {
    pub(crate) fn is_identity(&self) -> bool {
        self.rules.is_empty()
            && self.chinese == ChineseConversion::Off
            && self.translation.is_none()
    }

    /// The same transform without its translation: the lines a translation
    /// is made from.
    pub(crate) fn untranslated(&self) -> Self {
        Self {
            translation: None,
            ..self.clone()
        }
    }

    /// The stored form: `None` for the identity transform.
    pub(crate) fn to_stored(&self) -> Result<Option<String>, AppError> {
        Ok(if self.is_identity() {
            None
        } else {
            Some(serde_json::to_string(self)?)
        })
    }

    pub(crate) fn from_stored(stored: Option<&str>) -> Self {
        stored
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default()
    }
}

/// Changed lines, in UTF-16 units: `(source start, source end, output start,
/// output end)`, ascending. Offsets inside a changed line map proportionally.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OffsetMap {
    segments: Vec<(u64, u64, u64, u64)>,
}

impl OffsetMap {
    pub(crate) fn forward(&self, offset: u64) -> u64 {
        map_through(&self.segments, offset, |segment| segment)
    }

    pub(crate) fn backward(&self, offset: u64) -> u64 {
        map_through(&self.segments, offset, |(a, b, c, d)| (c, d, a, b))
    }
}

fn map_through(
    segments: &[(u64, u64, u64, u64)],
    offset: u64,
    orient: impl Fn((u64, u64, u64, u64)) -> (u64, u64, u64, u64),
) -> u64 {
    let mut shift: i64 = 0;
    for &segment in segments {
        let (from_start, from_end, to_start, to_end) = orient(segment);
        if offset < from_start {
            break;
        }
        if offset < from_end {
            let from_length = from_end - from_start;
            let to_length = to_end - to_start;
            return to_start + (offset - from_start) * to_length / from_length.max(1);
        }
        shift = to_end as i64 - from_end as i64;
    }
    (offset as i64 + shift).max(0) as u64
}

struct CompiledRule<'a> {
    rule: &'a TransformRule,
    regex: Option<fancy_regex::Regex>,
    /// The replacement in the regex crate's syntax.
    replacement: String,
}

/// Legado rules use Java replacement syntax: `$1` is a group number however
/// it is followed, `${name}` a named group, and `\x` a literal character.
fn java_replacement(replacement: &str) -> String {
    let mut output = String::with_capacity(replacement.len());
    let mut characters = replacement.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\\' => match characters.next() {
                Some('$') => output.push_str("$$"),
                Some(next) => output.push(next),
                None => output.push('\\'),
            },
            '$' if characters.peek().is_some_and(char::is_ascii_digit) => {
                output.push_str("${");
                while let Some(digit) = characters.next_if(char::is_ascii_digit) {
                    output.push(digit);
                }
                output.push('}');
            }
            '$' if characters.peek() == Some(&'{') => output.push('$'),
            '$' => output.push_str("$$"),
            other => output.push(other),
        }
    }
    output
}

/// Checks a rule before it is saved.
pub(crate) fn validate_rule(rule: &TransformRule) -> Result<(), AppError> {
    if rule.pattern.is_empty() {
        return Err(AppError::invalid_argument(
            "replace rule pattern cannot be empty",
        ));
    }
    if rule.regex {
        fancy_regex::Regex::new(&rule.pattern).map_err(|error| {
            AppError::invalid_argument(format!("invalid regular expression: {error}"))
        })?;
    }
    Ok(())
}

/// Applies the rules to each line (so `^` and `$` anchor to lines), then a
/// translation from its snapshot, then the Chinese conversion, which never
/// changes length. Invalid or runaway expressions leave the line unchanged;
/// lines the snapshot lacks stay as written.
pub(crate) fn apply(text: &str, transform: &TextTransform) -> (String, OffsetMap) {
    let snapshot = transform
        .translation
        .as_ref()
        .and_then(|spec| crate::translation::snapshot(&spec.snapshot));
    let bilingual = transform
        .translation
        .as_ref()
        .is_some_and(|spec| spec.bilingual);
    let compiled: Vec<CompiledRule<'_>> = transform
        .rules
        .iter()
        .filter(|rule| !rule.pattern.is_empty())
        .map(|rule| CompiledRule {
            rule,
            regex: rule
                .regex
                .then(|| fancy_regex::Regex::new(&rule.pattern).ok())
                .flatten(),
            replacement: java_replacement(&rule.replacement),
        })
        .filter(|compiled| !compiled.rule.regex || compiled.regex.is_some())
        .collect();
    let mut output = String::with_capacity(text.len());
    let mut map = OffsetMap::default();
    let units = |value: &str| value.encode_utf16().count() as u64;
    let (mut source_offset, mut output_offset) = (0_u64, 0_u64);
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            output.push('\n');
            source_offset += 1;
            output_offset += 1;
        }
        let mut current = std::borrow::Cow::Borrowed(line);
        for rule in &compiled {
            if let Some(next) = replace_line(&current, rule) {
                current = std::borrow::Cow::Owned(next);
            }
        }
        if let Some(translated) = snapshot
            .as_ref()
            .and_then(|snapshot| crate::translation::translate_from(snapshot, &current, bilingual))
        {
            current = std::borrow::Cow::Owned(translated);
        }
        let source_units = units(line);
        if current.as_ref() == line {
            output.push_str(line);
            source_offset += source_units;
            output_offset += source_units;
        } else {
            let output_units = units(&current);
            map.segments.push((
                source_offset,
                source_offset + source_units,
                output_offset,
                output_offset + output_units,
            ));
            output.push_str(&current);
            source_offset += source_units;
            output_offset += output_units;
        }
    }
    let output = match transform.chinese {
        ChineseConversion::Off => output,
        ChineseConversion::ToTraditional => to_traditional(&output),
        ChineseConversion::ToSimplified => to_simplified(&output),
    };
    (output, map)
}

fn replace_line(line: &str, compiled: &CompiledRule<'_>) -> Option<String> {
    let rule = compiled.rule;
    match &compiled.regex {
        None => line
            .contains(rule.pattern.as_str())
            .then(|| line.replace(rule.pattern.as_str(), &rule.replacement)),
        Some(regex) => {
            let mut output = String::new();
            let mut last = 0;
            let mut changed = false;
            for captures in regex.captures_iter(line) {
                let Ok(captures) = captures else {
                    return None;
                };
                let found = captures.get(0)?;
                if found.start() == found.end() && rule.replacement.is_empty() {
                    continue;
                }
                output.push_str(&line[last..found.start()]);
                captures.expand(&compiled.replacement, &mut output);
                last = found.end();
                changed = true;
            }
            if !changed {
                return None;
            }
            output.push_str(&line[last..]);
            Some(output)
        }
    }
}

/// Simplified to Traditional Chinese, as `java.s2t` in source scripts.
pub(crate) fn to_traditional(text: &str) -> String {
    convert(text, &S2T, include_str!("zh/s2t.txt"))
}

/// Traditional to Simplified Chinese, as `java.t2s` in source scripts.
pub(crate) fn to_simplified(text: &str) -> String {
    convert(text, &T2S, include_str!("zh/t2s.txt"))
}

struct Converter {
    automaton: AhoCorasick,
    values: Vec<&'static str>,
}

static S2T: OnceLock<Converter> = OnceLock::new();
static T2S: OnceLock<Converter> = OnceLock::new();

/// OpenCC character and phrase tables (Apache-2.0, `zh/OPENCC-LICENSE`),
/// reduced to entries whose replacement has the same UTF-16 length, matched
/// longest first.
fn convert(text: &str, cell: &OnceLock<Converter>, table: &'static str) -> String {
    let converter = cell.get_or_init(|| {
        let mut keys = Vec::new();
        let mut values = Vec::new();
        let mut seen = HashMap::new();
        for line in table.lines() {
            if let Some((key, value)) = line.split_once('\t') {
                if seen.insert(key, value).is_none() {
                    keys.push(key);
                    values.push(value);
                }
            }
        }
        Converter {
            automaton: AhoCorasickBuilder::new()
                .match_kind(MatchKind::LeftmostLongest)
                .build(&keys)
                .expect("conversion table builds"),
            values,
        }
    });
    let mut output = String::with_capacity(text.len());
    converter
        .automaton
        .replace_all_with(text, &mut output, |found, _, destination| {
            destination.push_str(converter.values[found.pattern().as_usize()]);
            true
        });
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(pattern: &str, replacement: &str, regex: bool) -> TransformRule {
        TransformRule {
            pattern: pattern.into(),
            replacement: replacement.into(),
            regex,
        }
    }

    #[test]
    fn rules_apply_per_line_in_order_and_map_offsets() {
        let transform = TextTransform {
            rules: vec![
                rule("（本章完）", "", false),
                rule(r"^\s*广告.*$", "", true),
                rule(r"(\d+)章", "第$1章", true),
            ],
            chinese: ChineseConversion::Off,
            translation: None,
        };
        let text = "12章 开始\n正文（本章完）\n广告 点击\n结尾";
        let (output, map) = apply(text, &transform);
        assert_eq!(output, "第12章 开始\n正文\n\n结尾");
        // Unchanged lines keep their positions after the shift.
        let source = text.encode_utf16().count() as u64 - 2;
        let target = output.encode_utf16().count() as u64 - 2;
        assert_eq!(map.forward(source), target);
        assert_eq!(map.backward(target), source);
        assert_eq!(map.forward(0), 0);
        // An identity transform needs no stored spec.
        assert_eq!(TextTransform::default().to_stored().unwrap(), None);
        let stored = transform.to_stored().unwrap();
        assert_eq!(TextTransform::from_stored(stored.as_deref()), transform);
    }

    #[test]
    fn invalid_expressions_leave_text_unchanged() {
        let transform = TextTransform {
            rules: vec![rule("(", "x", true)],
            chinese: ChineseConversion::Off,
            translation: None,
        };
        assert!(validate_rule(&transform.rules[0]).is_err());
        assert_eq!(apply("原文", &transform).0, "原文");
    }

    #[test]
    fn chinese_conversion_preserves_length_both_ways() {
        let simplified = "头发里的云在说话，后来门开了。";
        let to_traditional = TextTransform {
            rules: Vec::new(),
            chinese: ChineseConversion::ToTraditional,
            translation: None,
        };
        let (traditional, map) = apply(simplified, &to_traditional);
        assert_eq!(traditional, "頭髮裏的雲在說話，後來門開了。");
        assert_eq!(map, OffsetMap::default());
        assert_eq!(
            traditional.encode_utf16().count(),
            simplified.encode_utf16().count()
        );
        let to_simplified = TextTransform {
            rules: Vec::new(),
            chinese: ChineseConversion::ToSimplified,
            translation: None,
        };
        assert_eq!(
            apply("頭髮裡的雲在說話", &to_simplified).0,
            "头发里的云在说话"
        );
    }
}
