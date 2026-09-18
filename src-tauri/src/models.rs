use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::AppError;

/// The persistent identity of a work. A Book is independent from its local files.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub content_version: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Txt,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TxtEncoding {
    Auto,
    Utf8,
    Gb18030,
    Gbk,
    Utf16Le,
    Utf16Be,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TxtDecodeState {
    Clean,
    ReplacementCharacters,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TxtEncodingInfo {
    pub detected: TxtEncoding,
    pub selected: TxtEncoding,
    pub state: TxtDecodeState,
    pub can_change: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetAvailability {
    Ready,
    Missing,
}

/// Metadata exposed to the frontend. The managed device path stays in storage.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookAsset {
    pub id: String,
    pub book_id: String,
    pub kind: AssetKind,
    pub sha256: String,
    pub byte_length: u64,
    pub content_version: String,
    pub availability: AssetAvailability,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportPhase {
    Staging,
    Reading,
    Normalizing,
    Persisting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportTask {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub book: Book,
    pub asset: BookAsset,
    pub duplicate: bool,
    pub source_byte_length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportStatus {
    pub operation_id: String,
    pub phase: ImportPhase,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub result: Option<ImportResult>,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub requested: bool,
}

/// A content position measured in UTF-16 code units of normalized text.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderLocator {
    pub book_id: String,
    pub content_version: String,
    pub resource_id: String,
    pub offset: u64,
    pub context_before: String,
    pub context_after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentWindow {
    pub book_id: String,
    pub resource_id: String,
    pub content_version: String,
    pub text: String,
    pub start_offset: u64,
    pub end_offset: u64,
    pub total_length: u64,
    pub has_before: bool,
    pub has_after: bool,
    pub locator: ReaderLocator,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowDirection {
    Forward,
    Backward,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadContentRequest {
    pub book_id: String,
    pub locator: Option<ReaderLocator>,
    pub max_units: u64,
    pub direction: WindowDirection,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveLocatorRequest {
    pub book_id: String,
    pub progress: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookRequest {
    pub book_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TxtEncodingRequest {
    pub book_id: String,
    pub encoding: TxtEncoding,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TxtSourceRequest {
    pub book_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TxtDecodeTask {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TxtDecodeStatus {
    pub operation_id: String,
    pub book_id: String,
    pub phase: ImportPhase,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub result: Option<TxtEncodingInfo>,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    pub ordinal: u64,
    pub title: String,
    pub locator: ReaderLocator,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub content_version: String,
    pub locator: ReaderLocator,
    pub excerpt: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkRequest {
    pub book_id: String,
    pub locator: ReaderLocator,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkIdRequest {
    pub bookmark_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub book_id: String,
    pub query: String,
    pub case_sensitive: bool,
    pub cursor: Option<u64>,
    pub limit: u32,
    #[serde(default)]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub ordinal: u64,
    pub locator: ReaderLocator,
    pub excerpt: String,
    pub match_start: u64,
    pub match_end: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub content_version: String,
    pub matches: Vec<SearchMatch>,
    pub next_cursor: Option<u64>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartImportRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportOperationRequest {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveLocatorRequest {
    pub locator: ReaderLocator,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBook {
    pub book: Book,
    pub asset: BookAsset,
    pub locator: Option<ReaderLocator>,
    pub total_length: Option<u64>,
    pub txt_encoding: Option<TxtEncodingInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMode {
    System,
    Light,
    Dark,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PaperTone {
    WarmTea,
    BoneWhite,
    XuanPaper,
    JadeGreen,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReaderFont {
    Serif,
    Sans,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageTurnEffect {
    Instant,
    Curl,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderPreferences {
    pub theme: ThemeMode,
    pub paper_tone: PaperTone,
    pub oled_black: bool,
    pub font_size: f64,
    pub line_height: f64,
    pub font_family: ReaderFont,
    pub page_turn_effect: PageTurnEffect,
}

impl Default for ReaderPreferences {
    fn default() -> Self {
        Self {
            theme: ThemeMode::System,
            paper_tone: PaperTone::WarmTea,
            oled_black: false,
            font_size: 20.0,
            line_height: 1.8,
            font_family: ReaderFont::Serif,
            page_turn_effect: PageTurnEffect::Curl,
        }
    }
}

impl ReaderPreferences {
    /// Validate values crossing the IPC boundary and values restored from the
    /// persistent preferences record. Enum fields are validated by serde;
    /// these bounds keep typography values finite and usable by the WebView.
    pub fn validate(&self) -> Result<(), AppError> {
        if !self.font_size.is_finite() || !(8.0..=96.0).contains(&self.font_size) {
            return Err(AppError::invalid_argument(
                "font_size must be a finite value between 8 and 96",
            ));
        }
        if !self.line_height.is_finite() || !(1.0..=3.5).contains(&self.line_height) {
            return Err(AppError::invalid_argument(
                "line_height must be a finite value between 1 and 3.5",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsRequest {
    pub settings: ReaderPreferences,
}
