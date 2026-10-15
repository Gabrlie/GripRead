//! Book translation: translation engines (OpenAI-compatible services,
//! Claude, Gemini, DeepL), a cache of translated lines shared by all books,
//! language detection, and turning a chapter's text into its translation or
//! a bilingual text.
//!
//! Engines and their keys are kept in `translation.json` in the data folder,
//! never in backups or sync records. Lines are translated in batches that
//! keep their count; a failed or short answer leaves the original lines.

use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{AppError, ErrorCode};
use crate::models::{EngineKind, TranslationDisplay, TranslationEngine, TranslationSettings};
use crate::storage::{CachedLine, Storage};

const SETTINGS_FILE: &str = "translation.json";
/// Characters a batch sent to a language model holds at most.
const BATCH_CHARS: usize = 2_000;
/// Lines a batch holds at most (DeepL takes up to 50 texts).
const BATCH_LINES: usize = 40;
const RETRIES: u32 = 3;

/// The languages books can be detected in and translated into: the code,
/// its name for prompts, its DeepL code, and whatlang's language.
pub const LANGUAGES: &[(&str, &str, &str, whatlang::Lang)] = &[
    (
        "zh-CN",
        "Simplified Chinese",
        "ZH-HANS",
        whatlang::Lang::Cmn,
    ),
    (
        "zh-TW",
        "Traditional Chinese",
        "ZH-HANT",
        whatlang::Lang::Cmn,
    ),
    ("en", "English", "EN-US", whatlang::Lang::Eng),
    ("ja", "Japanese", "JA", whatlang::Lang::Jpn),
    ("ko", "Korean", "KO", whatlang::Lang::Kor),
    ("fr", "French", "FR", whatlang::Lang::Fra),
    ("de", "German", "DE", whatlang::Lang::Deu),
    ("es", "Spanish", "ES", whatlang::Lang::Spa),
    ("ru", "Russian", "RU", whatlang::Lang::Rus),
];

fn language(
    code: &str,
) -> Option<&'static (&'static str, &'static str, &'static str, whatlang::Lang)> {
    LANGUAGES.iter().find(|language| language.0 == code)
}

fn error(key: &str, message: impl Into<String>) -> AppError {
    AppError::keyed(ErrorCode::Io, key, message)
}

pub fn load_settings(root: &Path) -> TranslationSettings {
    fs::read_to_string(root.join(SETTINGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_settings(root: &Path, settings: &TranslationSettings) -> Result<(), AppError> {
    let path = root.join(SETTINGS_FILE);
    let partial = path.with_extension("json.part");
    fs::write(&partial, serde_json::to_string_pretty(settings)?)?;
    fs::rename(&partial, &path)?;
    Ok(())
}

/// The engine books are translated with: the default one, else the first.
pub fn default_engine(settings: &TranslationSettings) -> Option<&TranslationEngine> {
    settings
        .default_engine
        .as_ref()
        .and_then(|id| settings.engines.iter().find(|engine| &engine.id == id))
        .or_else(|| settings.engines.first())
}

/// What makes an engine's translations differ: its kind, address, model,
/// and prompt; the cache keeps lines per fingerprint.
pub fn fingerprint(engine: &TranslationEngine) -> String {
    let mut hash = Sha256::new();
    hash.update(format!(
        "{:?}\n{}\n{}\n{}",
        engine.kind, engine.base_url, engine.model, engine.prompt
    ));
    hex::encode(&hash.finalize()[..12])
}

fn line_hash(line: &str) -> String {
    hex::encode(&Sha256::digest(line.as_bytes())[..16])
}

/// The language of `text`, as one of [`LANGUAGES`]; Chinese counts as
/// traditional when traditional-only characters dominate.
pub fn detect(text: &str) -> Option<String> {
    let sample: String = text.chars().take(4_000).collect();
    let info = whatlang::detect(&sample)?;
    if info.lang() == whatlang::Lang::Cmn {
        let traditional = sample
            .chars()
            .filter(|ch| TRADITIONAL.contains(*ch))
            .count();
        let simplified = sample.chars().filter(|ch| SIMPLIFIED.contains(*ch)).count();
        return Some(
            if traditional > simplified {
                "zh-TW"
            } else {
                "zh-CN"
            }
            .into(),
        );
    }
    LANGUAGES
        .iter()
        .find(|language| language.3 == info.lang() && language.0 != "zh-TW")
        .map(|language| language.0.to_string())
}

/// Common characters that tell traditional from simplified writing.
const TRADITIONAL: &str = "這們個來說時會對國過還麼後裡學發見現開關長門問點經頭樣讓與從當動種實";
const SIMPLIFIED: &str = "这们个来说时会对国过还么后里学发见现开关长门问点经头样让与从当动种实";

/// A line's leading marks (EPUB images, contents entries) that stay as
/// they are, and the text after them.
fn split_marks(line: &str) -> (&str, &str) {
    let end = line
        .char_indices()
        .find(|(_, ch)| !is_mark(*ch))
        .map_or(line.len(), |(at, _)| at);
    line.split_at(end)
}

fn is_mark(ch: char) -> bool {
    matches!(ch, '\u{E000}'..='\u{F8FF}' | '\u{F0000}'..='\u{10FFFD}')
}

/// Whether a line is sent for translation: it has letters after its marks.
fn translatable(line: &str) -> bool {
    let (_, text) = split_marks(line);
    text.chars().any(|ch| ch.is_alphabetic())
}

/// An HTTP client that verifies certificates, through the app's proxy.
fn agent(root: &Path) -> Result<ureq::Agent, AppError> {
    let proxy = match crate::network::proxy(root) {
        Some(address) => Some(ureq::Proxy::new(&address).map_err(|failure| {
            error("badProxy", format!("代理设置无效：{failure}")).with("error", failure)
        })?),
        None => None,
    };
    Ok(ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(180)))
        .proxy(proxy)
        .build()
        .into())
}

/// Sends `body` to `url` with `headers`, retrying when the service is busy.
fn post(
    agent: &ureq::Agent,
    url: &str,
    headers: &[(&str, String)],
    body: &Value,
) -> Result<Value, AppError> {
    let mut attempt = 0;
    loop {
        let mut request = agent
            .post(url)
            .header("Content-Type", "application/json")
            .header("User-Agent", "GripRead");
        for (name, value) in headers {
            request = request.header(*name, value.as_str());
        }
        let mut response = request.send(body.to_string()).map_err(|failure| {
            error("engineUnreachable", format!("翻译服务连接失败：{failure}"))
                .with("error", &failure)
        })?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        let text = response
            .body_mut()
            .with_config()
            .limit(16 * 1024 * 1024)
            .read_to_string()
            .unwrap_or_default();
        if (status == 429 || status >= 500) && attempt < RETRIES {
            attempt += 1;
            let wait = retry_after.unwrap_or(2u64.pow(attempt)).min(60);
            std::thread::sleep(Duration::from_secs(wait));
            continue;
        }
        if !(200..300).contains(&status) {
            let detail: String = text.chars().take(300).collect();
            return Err(error(
                "engineHttp",
                format!("翻译服务返回 HTTP {status}：{detail}"),
            )
            .with("status", status)
            .with("detail", detail));
        }
        return serde_json::from_str(&text)
            .map_err(|_| error("engineAnswer", "翻译服务的回答无法识别"));
    }
}

fn instructions(engine: &TranslationEngine, source: Option<&str>, target: &str) -> String {
    let target_name = language(target).map_or(target, |language| language.1);
    let source_name = source
        .and_then(language)
        .map_or("the original language".to_string(), |language| {
            language.1.to_string()
        });
    let mut text = format!(
        "You are a literary translator. Translate every string in the user's JSON array from \
         {source_name} into {target_name}. Keep the meaning, tone, and paragraphing; keep names \
         and terms consistent. Reply with only a JSON array of strings with exactly as many items \
         as the input, in the same order, and nothing else."
    );
    if !engine.prompt.trim().is_empty() {
        text.push_str("\n\n");
        text.push_str(engine.prompt.trim());
    }
    text
}

/// The JSON array of strings inside a model's answer (code fences and
/// surrounding words are ignored).
fn answer_lines(answer: &str) -> Option<Vec<String>> {
    let start = answer.find('[')?;
    let end = answer.rfind(']')?;
    serde_json::from_str(answer.get(start..=end)?).ok()
}

fn base(engine: &TranslationEngine, official: &str) -> String {
    let address = engine.base_url.trim().trim_end_matches('/');
    if address.is_empty() {
        official.to_string()
    } else {
        address.to_string()
    }
}

/// Translates one batch with `engine`; the answer has as many lines.
fn call(
    agent: &ureq::Agent,
    engine: &TranslationEngine,
    lines: &[String],
    source: Option<&str>,
    target: &str,
) -> Result<Vec<String>, AppError> {
    let input = serde_json::to_string(lines)?;
    let system = instructions(engine, source, target);
    let key = engine.api_key.trim().to_string();
    let answer = match engine.kind {
        EngineKind::OpenAi => {
            let url = format!(
                "{}/chat/completions",
                base(engine, "https://api.openai.com/v1")
            );
            let mut headers = Vec::new();
            if !key.is_empty() {
                headers.push(("Authorization", format!("Bearer {key}")));
            }
            let reply = post(
                agent,
                &url,
                &headers,
                &json!({
                    "model": engine.model,
                    "temperature": 0.3,
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": input },
                    ],
                }),
            )?;
            reply["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        }
        EngineKind::Claude => {
            let url = format!("{}/v1/messages", base(engine, "https://api.anthropic.com"));
            let reply = post(
                agent,
                &url,
                &[
                    ("x-api-key", key),
                    ("anthropic-version", "2023-06-01".into()),
                ],
                &json!({
                    "model": engine.model,
                    "max_tokens": 8192,
                    "system": system,
                    "messages": [{ "role": "user", "content": input }],
                }),
            )?;
            reply["content"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<String>()
                })
                .unwrap_or_default()
        }
        EngineKind::Gemini => {
            let url = format!(
                "{}/v1beta/models/{}:generateContent",
                base(engine, "https://generativelanguage.googleapis.com"),
                engine.model
            );
            let reply = post(
                agent,
                &url,
                &[("x-goog-api-key", key)],
                &json!({
                    "systemInstruction": { "parts": [{ "text": system }] },
                    "contents": [{ "role": "user", "parts": [{ "text": input }] }],
                    "generationConfig": { "responseMimeType": "application/json" },
                }),
            )?;
            reply["candidates"][0]["content"]["parts"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<String>()
                })
                .unwrap_or_default()
        }
        EngineKind::Deepl => {
            let official = if key.ends_with(":fx") {
                "https://api-free.deepl.com"
            } else {
                "https://api.deepl.com"
            };
            let url = format!("{}/v2/translate", base(engine, official));
            let target_code = language(target).map_or(target, |language| language.2);
            let mut body = json!({ "text": lines, "target_lang": target_code });
            if let Some(code) = source.and_then(language) {
                body["source_lang"] = json!(code.2.split('-').next().unwrap_or(code.2));
            }
            let reply = post(
                agent,
                &url,
                &[("Authorization", format!("DeepL-Auth-Key {key}"))],
                &body,
            )?;
            let texts: Vec<String> = reply["translations"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| item["text"].as_str().unwrap_or_default().to_string())
                        .collect()
                })
                .unwrap_or_default();
            return if texts.len() == lines.len() {
                Ok(texts)
            } else {
                Err(error("engineCount", "翻译结果的行数不对"))
            };
        }
    };
    match answer_lines(&answer) {
        Some(texts) if texts.len() == lines.len() => Ok(texts),
        Some(_) => Err(error("engineCount", "翻译结果的行数不对")),
        None => Err(error("engineAnswer", "翻译服务的回答无法识别")),
    }
}

/// Translates `lines`, splitting a batch whose answer has the wrong count
/// in halves before giving up on it.
fn call_split(
    agent: &ureq::Agent,
    engine: &TranslationEngine,
    lines: &[String],
    source: Option<&str>,
    target: &str,
) -> Result<Vec<String>, AppError> {
    match call(agent, engine, lines, source, target) {
        Err(failure) if failure.key.as_deref() == Some("engineCount") && lines.len() > 1 => {
            let (first, second) = lines.split_at(lines.len() / 2);
            let mut texts = call_split(agent, engine, first, source, target)?;
            texts.extend(call_split(agent, engine, second, source, target)?);
            Ok(texts)
        }
        other => other,
    }
}

/// Translates a sample line with `engine`, to test its settings.
pub fn test_engine(
    root: &Path,
    engine: &TranslationEngine,
    target: &str,
) -> Result<String, AppError> {
    let agent = agent(root)?;
    let sample = if target.starts_with("zh") {
        "The night was quiet, and the old house remembered every step."
    } else {
        "夜很静，老房子记得每一个脚步。"
    };
    Ok(call(&agent, engine, &[sample.to_string()], None, target)?
        .into_iter()
        .next()
        .unwrap_or_default())
}

/// The translation of each line (`None` for lines left as they are or not
/// translated): from the cache, else from `engine` in batches, which are
/// cached. A failure stops at the first batch that fails and keeps what
/// was translated before it.
pub fn translate_lines(
    storage: &Mutex<Storage>,
    root: &Path,
    engine: &TranslationEngine,
    source: Option<&str>,
    target: &str,
    lines: &[&str],
) -> Result<Vec<Option<String>>, AppError> {
    let engine_key = fingerprint(engine);
    let texts: Vec<&str> = lines.iter().map(|line| split_marks(line).1).collect();
    let hashes: Vec<String> = texts.iter().map(|text| line_hash(text)).collect();
    let cached = {
        let guard = storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        guard.cached_translations(&hashes, target, &engine_key)?
    };
    let mut result: Vec<Option<String>> = lines
        .iter()
        .zip(&hashes)
        .map(|(line, hash)| {
            if translatable(line) {
                cached.get(hash).cloned()
            } else {
                None
            }
        })
        .collect();
    // Lines still to translate, once each.
    let mut wanted: Vec<usize> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (index, line) in lines.iter().enumerate() {
        if result[index].is_none() && translatable(line) && seen.insert(&hashes[index]) {
            wanted.push(index);
        }
    }
    if !wanted.is_empty() {
        let agent = agent(root)?;
        let mut batches: Vec<Vec<usize>> = Vec::new();
        let mut size = 0;
        for index in wanted {
            let length = texts[index].chars().count();
            match batches.last_mut() {
                Some(batch) if size + length <= BATCH_CHARS && batch.len() < BATCH_LINES => {
                    batch.push(index);
                    size += length;
                }
                _ => {
                    batches.push(vec![index]);
                    size = length;
                }
            }
        }
        let mut first_failure = None;
        for batch in batches {
            let input: Vec<String> = batch
                .iter()
                .map(|&index| texts[index].to_string())
                .collect();
            match call_split(&agent, engine, &input, source, target) {
                Ok(translated) => {
                    let stored: Vec<CachedLine> = batch
                        .iter()
                        .zip(&translated)
                        .map(|(&index, text)| CachedLine {
                            source_hash: hashes[index].clone(),
                            text: text.clone(),
                        })
                        .collect();
                    if let Ok(mut guard) = storage.lock() {
                        let _ = guard.store_translations(&stored, target, &engine_key);
                    }
                    for (index, text) in batch.iter().zip(translated) {
                        // Every line with the same text takes it.
                        for (other, hash) in hashes.iter().enumerate() {
                            if hash == &hashes[*index] && translatable(lines[other]) {
                                result[other] = Some(text.clone());
                            }
                        }
                    }
                }
                Err(failure) => {
                    first_failure = Some(failure);
                    break;
                }
            }
        }
        if let Some(failure) = first_failure {
            if result.iter().all(Option::is_none) {
                return Err(failure);
            }
            crate::app_log::warn(
                "translation",
                format!("部分段落未翻译：{}", failure.message),
            );
        }
    }
    Ok(result)
}

/// The text read: each line replaced by its translation, or followed by
/// it; a line's leading marks stay in front.
pub fn compose(
    lines: &[&str],
    translated: &[Option<String>],
    display: TranslationDisplay,
) -> String {
    let mut out = String::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        match (&translated[index], display) {
            (Some(text), TranslationDisplay::Translated) => {
                out.push_str(split_marks(line).0);
                out.push_str(text);
            }
            (Some(text), TranslationDisplay::Bilingual) => {
                out.push_str(line);
                out.push('\n');
                out.push_str(text);
            }
            (None, _) => out.push_str(line),
        }
    }
    out
}

/// What a chapter's translation depends on, for caches of shown text.
pub fn spec(engine: &TranslationEngine, target: &str, display: TranslationDisplay) -> String {
    format!("{target}:{display:?}:{}", fingerprint(engine))
}

/// The commands of 翻译 (`api.rs`).
pub mod commands {
    use std::sync::Arc;

    use super::*;
    use crate::commands::AppState;
    use crate::models::{
        BookLanguageRequest, BookRequest, BookTranslation, BookTranslationRequest,
        TestEngineRequest,
    };

    fn lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, Storage>, AppError> {
        state
            .storage
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))
    }

    async fn blocking<T: Send + 'static>(
        work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(|failure| AppError::new(ErrorCode::Io, failure.to_string()))?
    }

    pub async fn get_translation_settings(
        state: &Arc<AppState>,
    ) -> Result<TranslationSettings, AppError> {
        Ok(load_settings(&state.data_root))
    }

    pub async fn save_translation_settings(
        state: &Arc<AppState>,
        settings: TranslationSettings,
    ) -> Result<TranslationSettings, AppError> {
        save_settings(&state.data_root, &settings)?;
        Ok(settings)
    }

    pub async fn test_translation_engine(
        state: &Arc<AppState>,
        request: TestEngineRequest,
    ) -> Result<String, AppError> {
        let root = state.data_root.clone();
        blocking(move || test_engine(&root, &request.engine, &request.target)).await
    }

    fn current(storage: &Storage, book_id: &str) -> Result<BookTranslation, AppError> {
        let (language, translate_to) = storage.book_translation(book_id)?;
        Ok(BookTranslation {
            book_id: book_id.into(),
            language,
            translate_to,
        })
    }

    /// A book's language and translation; the language is detected the
    /// first time from the beginning of its text.
    pub async fn get_book_translation(
        state: &Arc<AppState>,
        request: BookRequest,
    ) -> Result<BookTranslation, AppError> {
        let storage = state.storage.clone();
        let root = state.data_root.clone();
        blocking(move || {
            let (known, online, sample) = {
                let guard = storage
                    .lock()
                    .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
                let found = current(&guard, &request.book_id)?;
                if found.language.is_some() {
                    return Ok(found);
                }
                let online = guard.is_online_book(&request.book_id)?;
                let sample = if online {
                    None
                } else {
                    guard.local_text_sample(&request.book_id)?
                };
                (found, online, sample)
            };
            let sample = match sample {
                Some(sample) => Some(sample),
                None if online => crate::online_reader::raw_chapter(&storage, &request.book_id, 0)
                    .ok()
                    .map(|text| text.to_string()),
                None => None,
            };
            let Some(language) = sample.as_deref().and_then(detect) else {
                return Ok(known);
            };
            let guard = storage
                .lock()
                .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
            guard.set_book_language(&request.book_id, Some(&language))?;
            // 自动翻译外语书籍: a book in another language starts translated.
            let settings = load_settings(&root);
            if settings.auto_translate
                && known.translate_to.is_none()
                && !same_language(&language, &settings.target)
                && default_engine(&settings).is_some()
            {
                guard.set_book_translate_to(&request.book_id, Some(&settings.target))?;
                crate::online_reader::forget_shown(&request.book_id);
            }
            current(&guard, &request.book_id)
        })
        .await
    }

    pub async fn set_book_translation(
        state: &Arc<AppState>,
        request: BookTranslationRequest,
    ) -> Result<BookTranslation, AppError> {
        let guard = lock(state)?;
        guard.set_book_translate_to(&request.book_id, request.translate_to.as_deref())?;
        crate::online_reader::forget_shown(&request.book_id);
        current(&guard, &request.book_id)
    }

    pub async fn set_book_language(
        state: &Arc<AppState>,
        request: BookLanguageRequest,
    ) -> Result<BookTranslation, AppError> {
        let guard = lock(state)?;
        guard.set_book_language(&request.book_id, request.language.as_deref())?;
        crate::online_reader::forget_shown(&request.book_id);
        current(&guard, &request.book_id)
    }
}

/// Whether two language codes are the same writing (simplified and
/// traditional Chinese count as different).
pub fn same_language(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_are_detected() {
        assert_eq!(
            detect("The quick brown fox jumps over the lazy dog, and the night was quiet.")
                .as_deref(),
            Some("en")
        );
        assert_eq!(
            detect("夜很静，老房子记得每一个脚步，他们说这里会有人来。").as_deref(),
            Some("zh-CN")
        );
        assert_eq!(
            detect("夜很靜，老房子記得每一個腳步，他們說這裡會有人來。").as_deref(),
            Some("zh-TW")
        );
        assert_eq!(
            detect("吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。").as_deref(),
            Some("ja")
        );
    }

    #[test]
    fn marks_and_empty_lines_pass_through() {
        assert!(!translatable(""));
        assert!(!translatable("  "));
        assert!(!translatable("\u{E000}12"));
        assert!(translatable("\u{F0001}Chapter One"));
        let lines = ["\u{F0001}Chapter One", "", "He came."];
        let translated = [
            Some("第一章".to_string()),
            None,
            Some("他来了。".to_string()),
        ];
        assert_eq!(
            compose(&lines, &translated, TranslationDisplay::Translated),
            "\u{F0001}第一章\n\n他来了。"
        );
        assert_eq!(
            compose(&lines, &translated, TranslationDisplay::Bilingual),
            "\u{F0001}Chapter One\n第一章\n\nHe came.\n他来了。"
        );
    }

    use crate::sources::test_server::{start, Response};

    fn engine(kind: EngineKind, base_url: &str) -> TranslationEngine {
        TranslationEngine {
            id: "e".into(),
            name: "e".into(),
            kind,
            base_url: base_url.into(),
            model: "m".into(),
            api_key: "k:fx".into(),
            prompt: String::new(),
        }
    }

    /// Answers each kind's request shape with every input line in brackets.
    fn stub() -> String {
        start(|request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
            let wrap = |lines: Vec<String>| -> Vec<String> {
                lines.into_iter().map(|line| format!("[{line}]")).collect()
            };
            let from_json =
                |text: &str| -> Vec<String> { serde_json::from_str(text).unwrap_or_default() };
            if request.path.ends_with("/chat/completions") {
                assert_eq!(
                    request.headers.get("authorization").map(String::as_str),
                    Some("Bearer k:fx")
                );
                let input = from_json(body["messages"][1]["content"].as_str().unwrap_or("[]"));
                let content = serde_json::to_string(&wrap(input)).unwrap();
                Response::json(&json!({ "choices": [{ "message": { "content": format!("```json\n{content}\n```") } }] }).to_string())
            } else if request.path.ends_with("/v1/messages") {
                assert_eq!(
                    request.headers.get("x-api-key").map(String::as_str),
                    Some("k:fx")
                );
                let input = from_json(body["messages"][0]["content"].as_str().unwrap_or("[]"));
                Response::json(&json!({ "content": [{ "type": "text", "text": serde_json::to_string(&wrap(input)).unwrap() }] }).to_string())
            } else if request.path.ends_with(":generateContent") {
                let input = from_json(
                    body["contents"][0]["parts"][0]["text"]
                        .as_str()
                        .unwrap_or("[]"),
                );
                Response::json(&json!({ "candidates": [{ "content": { "parts": [{ "text": serde_json::to_string(&wrap(input)).unwrap() }] } }] }).to_string())
            } else if request.path.ends_with("/v2/translate") {
                assert_eq!(body["target_lang"], "ZH-HANS");
                let input: Vec<String> =
                    serde_json::from_value(body["text"].clone()).unwrap_or_default();
                let texts: Vec<Value> = wrap(input)
                    .into_iter()
                    .map(|text| json!({ "text": text }))
                    .collect();
                Response::json(&json!({ "translations": texts }).to_string())
            } else {
                Response::not_found()
            }
        })
    }

    #[test]
    fn every_engine_kind_translates_and_the_cache_answers_again() {
        let base = stub();
        let root =
            std::env::temp_dir().join(format!("gripread-translation-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let storage = Mutex::new(Storage::open(&root.join("data")).unwrap());
        let lines = ["\u{F0001}Chapter One", "", "He came.", "He came."];
        for kind in [
            EngineKind::OpenAi,
            EngineKind::Claude,
            EngineKind::Gemini,
            EngineKind::Deepl,
        ] {
            let engine = engine(kind, &base);
            let translated =
                translate_lines(&storage, &root, &engine, Some("en"), "zh-CN", &lines).unwrap();
            assert_eq!(
                translated,
                vec![
                    Some("[Chapter One]".to_string()),
                    None,
                    Some("[He came.]".to_string()),
                    Some("[He came.]".to_string()),
                ],
                "{kind:?}"
            );
        }
        // An engine that cannot be reached fails a line nobody translated…
        let mut offline = engine(EngineKind::OpenAi, &base);
        offline.base_url = "http://127.0.0.1:9".into();
        assert!(translate_lines(&storage, &root, &offline, None, "zh-CN", &["New line."]).is_err());
        // …and the stub engine answers a line it translated before.
        let again = translate_lines(
            &storage,
            &root,
            &engine(EngineKind::OpenAi, &base),
            Some("en"),
            "zh-CN",
            &["He came."],
        )
        .unwrap();
        assert_eq!(again, vec![Some("[He came.]".to_string())]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn answers_are_read_inside_fences() {
        assert_eq!(
            answer_lines("```json\n[\"一\", \"二\"]\n```"),
            Some(vec!["一".to_string(), "二".to_string()])
        );
        assert_eq!(answer_lines("no array"), None);
    }
}
