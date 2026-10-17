//! TXT chapter detection following Legado 3.26.7 (`model/localBook/TextFile.kt`
//! and `LocalBook.kt`): a table of regex rules, automatic rule selection on a
//! sample, a preface chapter whose text becomes the introduction, volumes as
//! headings without body text, size-based splitting when no rule matches, and
//! title/author parsing from file names. Locators use UTF-16 offsets in the
//! normalized LF text, like every other reader position.

use fancy_regex::Regex;
use regex::Regex as PlainRegex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::error::{AppError, ErrorCode};
use crate::m1_txt::make_toc_locator;
use crate::models::TocEntry;

/// Legado's built-in rules, copied from `assets/defaultData/txtTocRule.json`.
const DEFAULT_RULES_JSON: &str = include_str!("legado_txt_toc_rules.json");
/// Text sampled to choose a rule automatically (Legado reads 512000 bytes).
const SAMPLE_BYTES: usize = 512_000;
/// Matches closer than this to the previous counted match do not add score.
const SCORE_GAP_CHARS: usize = 1000;
/// Size of a chapter when no rule applies (Legado `maxLengthWithNoToc`).
const SIZE_SPLIT_BYTES: usize = 10 * 1024;
/// Size above which a detected chapter may be split (Legado `maxLengthWithToc`).
const LONG_CHAPTER_BYTES: usize = 100 * 1024;
/// Size-split blocks, used only for generated titles (Legado `bufferSize`).
const BLOCK_BYTES: usize = 512_000;
/// A trailing size-split piece this small joins the previous one.
const TAIL_BYTES: usize = 100;
const INTRO_CHARS: usize = 500;
const MAX_TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, Deserialize)]
pub struct DefaultRule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub example: String,
    pub serial: i64,
    pub enabled: bool,
}

pub fn default_rules() -> Vec<DefaultRule> {
    serde_json::from_str(DEFAULT_RULES_JSON).expect("embedded Legado TOC rules are valid JSON")
}

/// One rule as used by a build. An empty pattern means size splitting.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleSpec {
    pub id: String,
    pub name: String,
    pub pattern: String,
}

/// Everything that determines a book's TOC; its JSON is the cache identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TocBuildRule {
    /// Choose among `rules` by score instead of using the only entry.
    pub automatic: bool,
    pub rules: Vec<RuleSpec>,
    pub split_long_chapters: bool,
    /// [`crate::models::BookTocSettings::untitled_title`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub untitled_title: Option<String>,
    /// Size-split pieces in bytes, when not Legado's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TocBuild {
    pub entries: Vec<TocEntry>,
    /// The rule that produced the entries; `None` for size splitting.
    pub rule_id: Option<String>,
    pub rule_name: String,
    /// Text before the first heading, shortened, when it is not blank.
    pub intro: Option<String>,
}

/// Compiles a rule like Java's `Pattern.MULTILINE`.
pub fn compile_rule(pattern: &str) -> Result<Regex, AppError> {
    Regex::new(&format!("(?m){pattern}"))
        .map_err(|error| AppError::invalid_argument(format!("invalid TOC rule pattern: {error}")))
}

/// Matches of `pattern` in `sample`, for testing a rule while editing it.
pub fn test_rule(pattern: &str, sample: &str) -> Result<Vec<String>, AppError> {
    let regex = compile_rule(pattern)?;
    let mut titles = Vec::new();
    for found in regex.find_iter(sample).take(50) {
        let found = found.map_err(regex_runtime_error)?;
        titles.push(clean_title(found.as_str()));
    }
    Ok(titles)
}

fn regex_runtime_error(error: fancy_regex::Error) -> AppError {
    AppError::new(
        ErrorCode::InvalidArgument,
        format!("TOC rule could not be applied: {error}"),
    )
}

/// Legado `getTocRule`: the enabled rule with the most well-separated matches
/// in the sample wins; ties go to the earlier rule. `None` means no rule
/// matched at all and the book is split by size.
pub fn choose_rule<'a>(text: &str, rules: &'a [RuleSpec]) -> Option<&'a RuleSpec> {
    let sample = format!("\n{}", &text[..floor_boundary(text, SAMPLE_BYTES)]);
    let sample = sample.as_str();
    let mut best: Option<&RuleSpec> = None;
    let mut best_score = 1;
    // Reverse order with `>=` makes the earliest of equally scored rules win.
    for rule in rules.iter().rev() {
        if rule.pattern.is_empty() {
            continue;
        }
        let Ok(regex) = compile_rule(&rule.pattern) else {
            continue;
        };
        let mut score = 0;
        let mut last_end: Option<usize> = None;
        // Character positions advance with the matches, keeping scoring linear.
        let (mut cursor_byte, mut cursor_chars) = (0, 0);
        let mut chars_at = |byte: usize| {
            cursor_chars += sample[cursor_byte..byte].chars().count();
            cursor_byte = byte;
            cursor_chars
        };
        for found in regex.find_iter(sample) {
            let Ok(found) = found else { break };
            let start = chars_at(found.start());
            if last_end.is_none_or(|end| start > end + SCORE_GAP_CHARS) {
                score += 1;
                last_end = Some(chars_at(found.end()));
            }
        }
        if score >= best_score {
            best_score = score;
            best = Some(rule);
        }
    }
    best
}

/// Built-in rules loose enough to match ordinary prose (numbered lists,
/// short lines, symbols, 第N节课): left out of automatic detection inside
/// online chapters and of the disabled-rule suggestion, but still usable
/// when chosen by hand.
const LOOSE_RULE_IDS: [&str; 15] = [
    "legado-5",
    "legado-6",
    "legado-7",
    "legado-8",
    "legado-9",
    "legado-10",
    "legado-15",
    "legado-16",
    "legado-18",
    "legado-21",
    "legado-22",
    "legado-23",
    "legado-24",
    "legado-25",
    "legado-100",
];

pub fn is_loose_rule(id: &str) -> bool {
    LOOSE_RULE_IDS.contains(&id)
}

/// Headings `regex` finds in `text` that are whole lines and read like
/// titles, as byte offsets of their line starts with the trimmed line:
/// the match covers the line but for indentation and trailing spaces, the
/// line is at most 30 characters, does not end like a sentence or open
/// with a quotation mark, and is not `skip` (the chapter's own title).
pub fn heading_lines(text: &str, regex: &Regex, skip: &str) -> Vec<(usize, String)> {
    let blank = |part: &str| part.chars().all(|c| c.is_whitespace() || c == '\u{3000}');
    let key = |line: &str| {
        line.chars()
            .filter(|c| !c.is_whitespace() && *c != '\u{3000}')
            .collect::<String>()
    };
    let skip = key(skip);
    let mut found: Vec<(usize, String)> = Vec::new();
    for heading in regex.find_iter(text) {
        let Ok(heading) = heading else { break };
        if heading.as_str().trim().is_empty() {
            continue;
        }
        let line_start = text[..heading.start()].rfind('\n').map_or(0, |at| at + 1);
        let line_end = text[heading.end()..]
            .find('\n')
            .map_or(text.len(), |at| heading.end() + at);
        if !blank(&text[line_start..heading.start()]) || !blank(&text[heading.end()..line_end]) {
            continue;
        }
        let line =
            text[line_start..line_end].trim_matches(|c: char| c.is_whitespace() || c == '\u{3000}');
        let count = line.chars().count();
        if count == 0 || count > 30 || found.last().is_some_and(|(at, _)| *at == line_start) {
            continue;
        }
        let last = line.chars().last().unwrap_or(' ');
        let first = line.chars().next().unwrap_or(' ');
        if "。，,！!？?；;…、：:".contains(last) || "“\"「『‘'—".contains(first) {
            continue;
        }
        if !skip.is_empty() && key(line) == skip || keyword_in_sentence(line) {
            continue;
        }
        found.push((line_start, line.to_string()));
    }
    found
}

/// A line opening with a heading word that runs on into a sentence:
/// 后记得要回信, 尾声渐远, where a title has 后记, 番外一, 番外篇 or 序章：….
fn keyword_in_sentence(line: &str) -> bool {
    const WORDS: [&str; 10] = [
        "序章", "楔子", "正文", "终章", "后记", "尾声", "番外", "前言", "文案", "简介",
    ];
    let Some(rest) = WORDS.iter().find_map(|word| line.strip_prefix(word)) else {
        return false;
    };
    rest.chars().next().is_some_and(|next| {
        ('\u{4e00}'..='\u{9fff}').contains(&next)
            && !"〇零一二两三四五六七八九十百千篇章卷之".contains(next)
    })
}

/// Numbered headings (第N章 and the like) mostly count up; fewer than two
/// numbers say nothing either way.
pub fn numbered_in_order(titles: &[&str]) -> bool {
    let numbers: Vec<i64> = titles
        .iter()
        .map(|title| crate::storage::online::chapter_number(title))
        .filter(|number| *number > 0)
        .collect();
    if numbers.len() < 2 {
        return true;
    }
    let pairs = numbers.len() - 1;
    let rising = numbers.windows(2).filter(|pair| pair[1] > pair[0]).count();
    rising * 3 >= pairs * 2
}

/// Builds the TOC for normalized text.
pub fn build_toc(
    text: &str,
    book_id: &str,
    content_version: &str,
    rule: &TocBuildRule,
) -> Result<TocBuild, AppError> {
    let chosen = if rule.automatic {
        choose_rule(text, &rule.rules)
    } else {
        rule.rules.first().filter(|rule| !rule.pattern.is_empty())
    };
    let mut builder = Builder::new(text, book_id, content_version);
    builder.untitled = rule
        .untitled_title
        .clone()
        .filter(|title| !title.trim().is_empty());
    builder.chunk_bytes = rule.chunk_bytes.unwrap_or(SIZE_SPLIT_BYTES).max(1024);
    let mut intro = None;
    match chosen {
        Some(spec) => {
            let regex = compile_rule(&spec.pattern)?;
            let mut headings = Vec::new();
            // Rules that require whitespace before a heading would miss one on
            // the first line, so the text is searched as if a line ended first.
            let padded = format!("\n{text}");
            for found in regex.find_iter(&padded) {
                let found = found.map_err(regex_runtime_error)?;
                let title = clean_title(found.as_str());
                if found.start() == found.end() {
                    continue;
                }
                let start = floor_boundary(text, found.start().saturating_sub(1));
                headings.push((start, found.end() - 1, title));
            }
            if let Some(&(first, _, _)) = headings.first() {
                let preface = &text[..first];
                if !preface.trim().is_empty() {
                    builder.push(
                        0,
                        first,
                        "前言".to_string(),
                        false,
                        rule.split_long_chapters,
                    );
                    intro = Some(shorten(&clean_intro(preface), INTRO_CHARS));
                }
            }
            for (index, (start, end, title)) in headings.iter().enumerate() {
                let next = headings
                    .get(index + 1)
                    .map_or(text.len(), |heading| heading.0);
                // Legado: a heading without body text before the next one is a
                // volume; it must also be named like one, or an empty chapter
                // (such as a repeated heading) would become a volume.
                let volume = index + 1 < headings.len()
                    && text[*end..next].trim().is_empty()
                    && looks_like_volume(title);
                let title = if title.is_empty() {
                    "无标题章节".to_string()
                } else {
                    title.clone()
                };
                builder.push(
                    *start,
                    next,
                    title,
                    volume,
                    rule.split_long_chapters && !volume,
                );
            }
            if headings.is_empty() {
                builder.split_by_size(0, text.len(), None);
            }
        }
        None => builder.split_by_size(0, text.len(), None),
    }
    Ok(TocBuild {
        entries: builder.entries,
        rule_id: chosen.map(|rule| rule.id.clone()),
        rule_name: chosen.map_or_else(|| "按字数分章".to_string(), |rule| rule.name.clone()),
        intro,
    })
}

struct Builder<'a> {
    text: &'a str,
    book_id: &'a str,
    content_version: &'a str,
    entries: Vec<TocEntry>,
    /// UTF-16 offset of `cursor_byte`, advanced monotonically.
    cursor_byte: usize,
    cursor_units: u64,
    untitled: Option<String>,
    chunk_bytes: usize,
    /// Size-split pieces named by `untitled` so far.
    pieces: usize,
}

impl<'a> Builder<'a> {
    fn new(text: &'a str, book_id: &'a str, content_version: &'a str) -> Self {
        Self {
            text,
            book_id,
            content_version,
            entries: Vec::new(),
            cursor_byte: 0,
            cursor_units: 0,
            untitled: None,
            chunk_bytes: SIZE_SPLIT_BYTES,
            pieces: 0,
        }
    }

    fn units_at(&mut self, byte: usize) -> u64 {
        debug_assert!(byte >= self.cursor_byte, "TOC entries are built in order");
        self.cursor_units += self.text[self.cursor_byte..byte].encode_utf16().count() as u64;
        self.cursor_byte = byte;
        self.cursor_units
    }

    fn push(&mut self, start: usize, end: usize, title: String, volume: bool, split: bool) {
        if split && end - start > LONG_CHAPTER_BYTES {
            self.split_by_size(start, end, Some(&title));
            return;
        }
        let units = self.units_at(start);
        let length = self.text[start..end].encode_utf16().count() as u64;
        self.entries.push(TocEntry {
            ordinal: self.entries.len() as u64,
            title,
            volume,
            length,
            locator: make_toc_locator(self.text, self.book_id, self.content_version, start, units),
            tag: None,
        });
    }

    /// Legado's rule-less splitter: cut at the first line end after each
    /// 10 KB step. Generated titles follow Legado's `第N章(n)`, or
    /// `标题(n)` when re-splitting an over-long chapter.
    fn split_by_size(&mut self, start: usize, end: usize, title: Option<&str>) {
        let mut cuts = vec![start];
        let mut position = start;
        let size = if title.is_some() {
            SIZE_SPLIT_BYTES
        } else {
            self.chunk_bytes
        };
        while end - position > size {
            let target = floor_boundary(self.text, position + size);
            let cut = self.text[target..end]
                .find('\n')
                .map_or(end, |offset| target + offset + 1);
            if cut >= end || end - cut <= TAIL_BYTES {
                break;
            }
            cuts.push(cut);
            position = cut;
        }
        for (index, &piece_start) in cuts.iter().enumerate() {
            let piece_end = cuts.get(index + 1).copied().unwrap_or(end);
            let name = match (title, &self.untitled) {
                (Some(title), _) => format!("{title}({})", index + 1),
                (None, Some(template)) => {
                    self.pieces += 1;
                    untitled_title(template, self.pieces, &self.text[piece_start..piece_end])
                }
                (None, None) => {
                    let block = piece_start / BLOCK_BYTES + 1;
                    let within = cuts[..=index]
                        .iter()
                        .filter(|&&cut| cut / BLOCK_BYTES + 1 == block)
                        .count();
                    format!("第{block}章({within})")
                }
            };
            self.push(piece_start, piece_end, name, false, false);
        }
    }
}

/// A size-split piece's title from a template: `{n}` its number, `{text}`
/// the start of its first line.
pub fn untitled_title(template: &str, number: usize, text: &str) -> String {
    let first: String = text
        .lines()
        .map(|line| line.trim_matches(|c: char| c.is_whitespace() || c == '\u{3000}'))
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(16)
        .collect();
    let title = template
        .replace("{n}", &number.to_string())
        .replace("{text}", &first);
    let title = title.trim();
    if title.is_empty() {
        format!("{number}")
    } else {
        title.chars().take(MAX_TITLE_CHARS).collect()
    }
}

/// Volume titles: 第一卷, 卷三, 上部, 第二部, Volume 1, Book 2, and similar.
fn looks_like_volume(title: &str) -> bool {
    static VOLUME: OnceLock<PlainRegex> = OnceLock::new();
    VOLUME
        .get_or_init(|| {
            PlainRegex::new(
                r"(?i)^\s*(?:第\s*[\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[卷部篇册集]|[卷册]\s*[\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+|[上中下终][卷部篇册]|volume\s*\d|vol\.?\s*\d|book\s*\d|part\s*\d)",
            )
            .expect("valid")
        })
        .is_match(title)
}

/// Collapses a matched heading to one trimmed line.
fn clean_title(raw: &str) -> String {
    let line = raw
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let title = line.trim_matches(|c: char| c.is_whitespace() || c == '\u{3000}');
    title.chars().take(MAX_TITLE_CHARS).collect()
}

/// The preface without a leading label such as 简介： or 内容简介; the text
/// after the label keeps its paragraph indentation.
fn clean_intro(preface: &str) -> String {
    static LABEL: OnceLock<PlainRegex> = OnceLock::new();
    let label = LABEL.get_or_init(|| {
        PlainRegex::new(
            r"^\s*(?:【\s*)?(?:内容简介|作品简介|简介|文案|内容提要)\s*(?:】)?[:：]?[ \t]*",
        )
        .expect("valid")
    });
    tidy_intro(&label.replace(preface, ""))
}

/// An introduction without blank lines around it or trailing spaces; the
/// first line keeps its paragraph indentation like the others.
pub fn tidy_intro(text: &str) -> String {
    let start = text
        .char_indices()
        .take_while(|(_, c)| c.is_whitespace())
        .filter(|(_, c)| *c == '\n')
        .last()
        .map_or(0, |(index, _)| index + 1);
    let kept = &text[start..];
    // Only whitespace left: nothing to keep.
    if kept.trim().is_empty() {
        return String::new();
    }
    kept.trim_end().to_string()
}

fn shorten(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

pub(crate) fn floor_boundary(text: &str, byte: usize) -> usize {
    let mut byte = byte.min(text.len());
    while !text.is_char_boundary(byte) {
        byte -= 1;
    }
    byte
}

/// A book name and author parsed from a file name without its extension
/// (Legado `LocalBook.analyzeNameAuthor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameAuthor {
    pub name: String,
    pub author: Option<String>,
}

pub fn parse_name_author(file_stem: &str) -> NameAuthor {
    static PATTERNS: OnceLock<Vec<PlainRegex>> = OnceLock::new();
    // Legado's patterns, widened so 作者 may be followed by any common
    // separator (：: _ - or spaces), as in 《书名》（校对版全本） 作者_某某.
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(.*?)《([^《》]+)》.*?作\s*者[:：_\-—\s]*(.*)",
            r"(.*?)《([^《》]+)》(.*)",
            r"(^)(.+?)\s*作\s*者[:：_\-—\s]+(.+)$",
            r"(^)(.+) by (.+)$",
        ]
        .iter()
        .map(|pattern| PlainRegex::new(pattern).expect("built-in name patterns are valid"))
        .collect()
    });
    let stem = file_stem.trim();
    for pattern in patterns {
        if let Some(captures) = pattern.captures(stem) {
            let name = captures[2].trim().to_string();
            let author = format_author(&format!("{}{}", &captures[1], &captures[3]));
            if !name.is_empty() {
                return NameAuthor { name, author };
            }
        }
    }
    let name = format_name(stem);
    let author = if name.is_empty() || name == stem {
        None
    } else {
        format_author(&stem.replacen(&name, "", 1))
    };
    NameAuthor {
        name: if name.is_empty() {
            stem.to_string()
        } else {
            name
        },
        author,
    }
}

/// `BookHelp.formatBookName` with Legado's `nameRegex`.
fn format_name(name: &str) -> String {
    static NAME: OnceLock<PlainRegex> = OnceLock::new();
    NAME.get_or_init(|| PlainRegex::new(r"\s+作\s*者.*|\s+\S+\s+著").expect("valid"))
        .replace_all(name, "")
        .trim()
        .to_string()
}

/// `BookHelp.formatBookAuthor` with Legado's `authorRegex`, also dropping
/// bracketed notes such as （校对版全本） and separators around 作者.
pub fn format_author(author: &str) -> Option<String> {
    static AUTHOR: OnceLock<PlainRegex> = OnceLock::new();
    static NOTES: OnceLock<PlainRegex> = OnceLock::new();
    let without_notes = NOTES
        .get_or_init(|| PlainRegex::new(r"[（(【\[［][^）)】\]］]*[）)】\]］]").expect("valid"))
        .replace_all(author, " ");
    let author = AUTHOR
        .get_or_init(|| {
            PlainRegex::new(r"^[\s:：_\-—]*作\s*者[:：_\-—\s]*|\s+著\s*$").expect("valid")
        })
        .replace_all(without_notes.trim(), "")
        .trim_matches(|c: char| c.is_whitespace() || ":：_-—".contains(c))
        .to_string();
    (!author.is_empty()).then_some(author)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untitled_pieces_take_the_books_title_style_and_size() {
        let text = (0..60)
            .map(|line| format!("第{line}行的文字，没有章节标题可以匹配。"))
            .collect::<Vec<_>>()
            .join("\n");
        let rule = |template: &str| TocBuildRule {
            automatic: false,
            rules: Vec::new(),
            split_long_chapters: false,
            untitled_title: Some(template.into()),
            chunk_bytes: Some(1024),
        };
        let numbered = build_toc(&text, "b", "v", &rule("第{n}节")).unwrap();
        assert!(numbered.entries.len() > 1);
        assert_eq!(numbered.entries[0].title, "第1节");
        assert_eq!(numbered.entries[1].title, "第2节");
        let opening = build_toc(&text, "b", "v", &rule("{n}. {text}")).unwrap();
        assert_eq!(
            opening.entries[0].title,
            "1. 第0行的文字，没有章节标题可以匹"
        );
        // Without a template the pieces keep Legado's names.
        let legado = build_toc(
            &text,
            "b",
            "v",
            &TocBuildRule {
                untitled_title: None,
                ..rule("")
            },
        )
        .unwrap();
        assert_eq!(legado.entries[0].title, "第1章(1)");
    }

    fn auto() -> TocBuildRule {
        TocBuildRule {
            automatic: true,
            rules: default_rules()
                .into_iter()
                .filter(|rule| rule.enabled)
                .map(|rule| RuleSpec {
                    id: rule.id,
                    name: rule.name,
                    pattern: rule.pattern,
                })
                .collect(),
            split_long_chapters: false,
            untitled_title: None,
            chunk_bytes: None,
        }
    }

    fn titles(build: &TocBuild) -> Vec<&str> {
        build
            .entries
            .iter()
            .map(|entry| entry.title.as_str())
            .collect()
    }

    #[test]
    fn every_default_rule_compiles_and_matches_its_example() {
        let rules = default_rules();
        assert_eq!(rules.len(), 26);
        for rule in rules
            .iter()
            .filter(|rule| !rule.pattern.is_empty() && rule.id != "legado-25")
        {
            let sample = format!("\n{}\n", rule.example);
            assert!(
                !test_rule(&rule.pattern, &sample).unwrap().is_empty(),
                "{} does not match its example",
                rule.name
            );
        }
    }

    #[test]
    fn preface_becomes_intro_and_volumes_have_no_body() {
        let text = "这是一本书的简介。\n\n第一卷 风起\n第一章 开始\n内容一\n第二章 继续\n内容二\n第二卷 云涌\n第三章 结束\n内容三\n";
        let build = build_toc(text, "b", "v", &auto()).unwrap();
        assert_eq!(
            titles(&build),
            [
                "前言",
                "第一卷 风起",
                "第一章 开始",
                "第二章 继续",
                "第二卷 云涌",
                "第三章 结束"
            ]
        );
        let volumes: Vec<bool> = build.entries.iter().map(|entry| entry.volume).collect();
        assert_eq!(volumes, [false, true, false, false, true, false]);
        assert_eq!(build.intro.as_deref(), Some("这是一本书的简介。"));
        assert_eq!(clean_intro("内容简介：\n　　少年求道。"), "　　少年求道。");
        assert_eq!(
            tidy_intro("\n \n　　第一段\n　　第二段 \n"),
            "　　第一段\n　　第二段"
        );
        assert_eq!(clean_intro("【简介】山河远行"), "山河远行");
        assert_eq!(build.rule_id.as_deref(), Some("legado-1"));
        let starts: Vec<u64> = build
            .entries
            .iter()
            .map(|entry| entry.locator.offset)
            .collect();
        assert_eq!(
            starts[1],
            "这是一本书的简介。\n\n".encode_utf16().count() as u64
        );
        assert!(starts.windows(2).all(|pair| pair[0] < pair[1]));
        let total: u64 = build.entries.iter().map(|entry| entry.length).sum();
        assert_eq!(total, text.encode_utf16().count() as u64);
    }

    #[test]
    fn empty_chapters_are_not_volumes_unless_named_like_one() {
        let text = "第一章 重复\n第一章 重复\n内容\n第一卷 开端\n第二章 继续\n内容\n";
        let build = build_toc(text, "b", "v", &auto()).unwrap();
        let volumes: Vec<(&str, bool)> = build
            .entries
            .iter()
            .map(|entry| (entry.title.as_str(), entry.volume))
            .collect();
        assert_eq!(
            volumes,
            [
                ("第一章 重复", false),
                ("第一章 重复", false),
                ("第一卷 开端", true),
                ("第二章 继续", false)
            ]
        );
        assert!(looks_like_volume("卷三 风云"));
        assert!(looks_like_volume("Volume 2"));
        assert!(!looks_like_volume("第三章 卷土重来"));
    }

    #[test]
    fn english_and_numbered_headings_are_detected() {
        let text = "Chapter 1 Begin\nText.\nChapter 2 Next\nMore text.\n";
        assert_eq!(
            titles(&build_toc(text, "b", "v", &auto()).unwrap()),
            ["Chapter 1 Begin", "Chapter 2 Next"]
        );
        let text = "1、开端\n内容\n2、发展\n内容\n";
        assert_eq!(
            titles(&build_toc(text, "b", "v", &auto()).unwrap()),
            ["1、开端", "2、发展"]
        );
    }

    #[test]
    fn rule_less_text_is_split_by_size_at_line_ends() {
        let line = "没有任何章节标题的一行文字。\n";
        let text = line.repeat(2000);
        let build = build_toc(&text, "b", "v", &auto()).unwrap();
        assert!(build.rule_id.is_none());
        assert!(build.entries.len() > 3);
        assert_eq!(build.entries[0].title, "第1章(1)");
        assert_eq!(build.entries[1].title, "第1章(2)");
        for entry in &build.entries[1..] {
            let byte = text
                .encode_utf16()
                .take(entry.locator.offset as usize)
                .count();
            assert!(byte > 0);
        }
        let total: u64 = build.entries.iter().map(|entry| entry.length).sum();
        assert_eq!(total, text.encode_utf16().count() as u64);
    }

    #[test]
    fn long_chapters_split_only_when_enabled() {
        let text = format!(
            "第一章 长\n{}第二章 短\n短\n",
            "很长的正文。\n".repeat(12_000)
        );
        let mut rule = auto();
        assert_eq!(build_toc(&text, "b", "v", &rule).unwrap().entries.len(), 2);
        rule.split_long_chapters = true;
        let build = build_toc(&text, "b", "v", &rule).unwrap();
        assert!(build.entries.len() > 3);
        assert_eq!(build.entries[0].title, "第一章 长(1)");
        assert_eq!(build.entries.last().unwrap().title, "第二章 短");
    }

    #[test]
    fn a_fixed_rule_is_used_without_scoring() {
        let text = "【第一章】甲\n内容\n第二章 乙\n内容\n";
        let rule = TocBuildRule {
            automatic: false,
            rules: vec![RuleSpec {
                id: "x".into(),
                name: "x".into(),
                pattern: "^第.+章.*$".into(),
            }],
            split_long_chapters: false,
            untitled_title: None,
            chunk_bytes: None,
        };
        let build = build_toc(text, "b", "v", &rule).unwrap();
        assert_eq!(titles(&build), ["前言", "第二章 乙"]);
        assert!(compile_rule("(").is_err());
    }

    #[test]
    fn automatic_choice_prefers_well_separated_matches() {
        let body = "　　正文内容。".repeat(200);
        let text: String = (1..=5).map(|n| format!("第{n}章 标题\n{body}\n")).collect();
        let rules = auto();
        let chosen = choose_rule(&text, &rules.rules).unwrap();
        assert_eq!(chosen.id, "legado-1");
    }

    #[test]
    fn parses_name_and_author_from_file_names() {
        let cases = [
            ("《斗破苍穹》作者：天蚕土豆", "斗破苍穹", Some("天蚕土豆")),
            ("《诡秘之主》爱潜水的乌贼", "诡秘之主", Some("爱潜水的乌贼")),
            ("凡人修仙传 作者：忘语", "凡人修仙传", Some("忘语")),
            ("Dune by Frank Herbert", "Dune", Some("Frank Herbert")),
            (
                "雪中悍刀行  烽火戏诸侯 著",
                "雪中悍刀行",
                Some("烽火戏诸侯"),
            ),
            ("三体", "三体", None),
            (
                "《超神建模师》（校对版全本） 作者_零下十九度",
                "超神建模师",
                Some("零下十九度"),
            ),
            ("《剑来》 作者:烽火戏诸侯", "剑来", Some("烽火戏诸侯")),
            ("《大奉打更人》（精校版）", "大奉打更人", None),
            ("全职高手 作者_蝴蝶蓝", "全职高手", Some("蝴蝶蓝")),
        ];
        for (stem, name, author) in cases {
            let parsed = parse_name_author(stem);
            assert_eq!(parsed.name, name, "{stem}");
            assert_eq!(parsed.author.as_deref(), author, "{stem}");
        }
    }
}

#[cfg(test)]
mod timing {
    use super::*;

    /// `cargo test --lib txt_toc::timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn directory_timing() {
        let mut text = String::new();
        let mut chapter = 1;
        while text.len() < 6 * 1024 * 1024 {
            text.push_str(&format!("第{chapter}章 风起云涌\n"));
            for _ in 0..40 {
                text.push_str(
                    "　　少年站在山门之前，望着云海翻腾，心中暗暗发誓，此生定要踏上那九天之巅。\n",
                );
            }
            chapter += 1;
        }
        let rules: Vec<RuleSpec> = default_rules()
            .into_iter()
            .filter(|rule| rule.enabled)
            .map(|rule| RuleSpec {
                id: rule.id,
                name: rule.name,
                pattern: rule.pattern,
            })
            .collect();
        let started = std::time::Instant::now();
        let chosen = choose_rule(&text, &rules).unwrap().clone();
        eprintln!("choose {:?} -> {}", started.elapsed(), chosen.name);
        for rule in &rules {
            let started = std::time::Instant::now();
            let single = std::slice::from_ref(rule);
            let _ = choose_rule(&text, single);
            eprintln!("  score {:>10?} {}", started.elapsed(), rule.name);
        }
        let fixed = TocBuildRule {
            automatic: false,
            rules: vec![chosen],
            split_long_chapters: false,
            untitled_title: None,
            chunk_bytes: None,
        };
        let started = std::time::Instant::now();
        let build = build_toc(&text, "b", "v", &fixed).unwrap();
        eprintln!(
            "build {:?} ({} entries)",
            started.elapsed(),
            build.entries.len()
        );
    }
}
