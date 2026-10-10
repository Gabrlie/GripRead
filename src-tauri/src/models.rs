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
pub struct ResolveOffsetRequest {
    pub book_id: String,
    pub content_version: String,
    pub resource_id: String,
    pub offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookRequest {
    pub book_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGroup {
    pub id: String,
    pub name: String,
    pub book_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameGroupRequest {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupRequest {
    pub id: String,
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
    /// A volume heading (卷) with no body text before the next heading.
    #[serde(default)]
    pub volume: bool,
    /// Chapter length in UTF-16 code units, up to the next entry.
    #[serde(default)]
    pub length: u64,
    pub locator: ReaderLocator,
}

/// A TXT chapter rule (Legado `TxtTocRule`). Built-in rules come from
/// Legado 3.26.7 and can be enabled, disabled, or reordered but not deleted.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TxtTocRule {
    /// Empty when saving a new rule.
    pub id: String,
    pub name: String,
    /// A Java-compatible regex applied in multi-line mode; empty splits by size.
    pub pattern: String,
    pub example: String,
    pub serial: i64,
    pub enabled: bool,
    pub builtin: bool,
}

/// Per-book chapter detection settings.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookTocSettings {
    /// The selected rule, or `None` to choose among enabled rules automatically.
    pub rule_id: Option<String>,
    /// Split chapters longer than about 100 KB (Legado 拆分超长章节).
    pub split_long_chapters: bool,
}

/// A book's chapters and the rule that produced them.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TocListing {
    pub entries: Vec<TocEntry>,
    /// `None` when no rule matched and the text was split by size.
    pub rule_id: Option<String>,
    pub rule_name: String,
    pub settings: BookTocSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveBookTocSettingsRequest {
    pub book_id: String,
    pub settings: BookTocSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveTxtTocRuleRequest {
    pub rule: TxtTocRule,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TxtTocRuleIdRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrderTxtTocRulesRequest {
    /// Every rule id in the new order.
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportTxtTocRulesRequest {
    /// A Legado rule export (a JSON array or a single rule object).
    pub json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestTxtTocRuleRequest {
    pub pattern: String,
    pub sample: String,
}

/// A managed file used for display, such as an imported reading font.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderAsset {
    pub id: String,
    pub name: String,
    pub byte_length: u64,
    pub created_at: i64,
}

/// A picked file: a filesystem path or an Android document URI.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderAssetRequest {
    pub id: String,
}

/// Book details beyond the shelf record.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookInfo {
    pub book_id: String,
    /// Text before the first chapter, when the book has one.
    pub intro: Option<String>,
    pub source_byte_length: u64,
    pub chapter_count: Option<u64>,
    pub reading_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub content_version: String,
    pub locator: ReaderLocator,
    pub excerpt: String,
    /// The reader's own note (Legado 书签备注).
    #[serde(default)]
    pub note: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkRequest {
    pub book_id: String,
    pub locator: ReaderLocator,
    pub excerpt: String,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
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
    /// Treat `query` as a regular expression matched within each line.
    #[serde(default)]
    pub regex: bool,
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
    #[serde(default)]
    #[ts(optional)]
    pub encoding: Option<TxtEncoding>,
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
    pub last_read_at: Option<i64>,
    pub removed_at: Option<i64>,
    /// A reading state the reader chose by moving the book; `None` lets the
    /// shelf derive it from progress.
    pub shelf_state: Option<ShelfState>,
    pub cover_asset_id: Option<String>,
}

/// The shelf's automatic groups, which a book can also be moved into by hand.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShelfState {
    Reading,
    Unread,
    Finished,
}

/// Where a book is moved on the shelf: back to automatic grouping, a reading
/// state, or one user group (a book is in at most one).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum ShelfPlacement {
    Automatic,
    State(ShelfState),
    Group(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoveBookRequest {
    pub book_id: String,
    pub placement: ShelfPlacement,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingTimeRequest {
    pub book_id: String,
    /// The reader's local calendar day, `YYYY-MM-DD`.
    pub day: String,
    pub seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookReadingTime {
    pub book_id: String,
    pub seconds: u64,
    pub last_day: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStats {
    pub total_seconds: u64,
    pub today_seconds: u64,
    /// Days with reading, most recent first, up to 30.
    pub days: Vec<DayReadingTime>,
    pub books: Vec<BookReadingTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DayReadingTime {
    pub day: String,
    pub seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStatsRequest {
    pub today: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookCoverRequest {
    pub book_id: String,
    pub path: String,
}

/// A file found by a folder import.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkNoteRequest {
    pub bookmark_id: String,
    pub note: String,
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
    Slide,
    Fade,
    /// Legado's 覆盖: the turning page slides over the next one.
    Cover,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReaderMode {
    #[default]
    Single,
    Double,
    Scroll,
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
    #[serde(default = "default_auto_page_seconds")]
    pub auto_page_seconds: u8,
    #[serde(default)]
    pub reading_mode: ReaderMode,
    #[serde(default = "default_auto_scroll_speed")]
    pub auto_scroll_speed: u16,
    /// Legado-style reading styles, layout, information bars, and controls.
    /// Absent in records saved before it existed, which then get the defaults.
    #[serde(default)]
    pub style: ReadingStyle,
}

/// A reading colour scheme with day and night variants (Legado ReadBookConfig).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StylePreset {
    pub name: String,
    /// CSS colours such as `#f6f2e9`.
    pub background: String,
    pub text: String,
    pub night_background: String,
    pub night_text: String,
    /// A managed `background` image drawn instead of the day colour.
    #[serde(default)]
    pub background_image: Option<String>,
    #[serde(default)]
    pub night_background_image: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScreenOrientation {
    #[default]
    Auto,
    Portrait,
    Landscape,
}

/// How automatic page turning advances paginated text (Legado 自动翻页).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AutoPageMode {
    /// The next page is uncovered from the top, behind a moving line.
    #[default]
    Reveal,
    /// The page turns with the selected animation at each interval.
    Turn,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TitleMode {
    Left,
    Center,
    Hidden,
}

/// One position in the header or footer (Legado ReadTipConfig).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InfoSlot {
    None,
    Time,
    Battery,
    ChapterTitle,
    BookTitle,
    ChapterProgress,
    BookProgress,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InfoBar {
    pub visible: bool,
    pub left: InfoSlot,
    pub middle: InfoSlot,
    pub right: InfoSlot,
}

/// Body margins in CSS pixels, inside the system bar insets.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Margins {
    pub top: f64,
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TapAction {
    None,
    Menu,
    Next,
    Previous,
    NextChapter,
    PreviousChapter,
    Contents,
    Search,
    Bookmark,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReadingStyle {
    pub presets: Vec<StylePreset>,
    /// Index into `presets`.
    pub selected: u32,
    /// Extra space between characters, in em.
    pub letter_spacing: f64,
    /// Space between paragraphs, in em.
    pub paragraph_spacing: f64,
    /// First-line indent, in full-width characters.
    pub indent: u8,
    /// CSS font weight of the body text.
    pub font_weight: u16,
    pub title_mode: TitleMode,
    /// Chapter heading size relative to the body text.
    pub title_scale: f64,
    pub margins: Margins,
    /// Space around the header and footer text (Legado PaddingConfig).
    pub header_margins: Margins,
    pub footer_margins: Margins,
    /// Divider lines between the body and the header or footer.
    pub header_line: bool,
    pub footer_line: bool,
    pub header: InfoBar,
    pub footer: InfoBar,
    /// A managed font from `reader_assets`, overriding `font_family`.
    pub font_asset_id: Option<String>,
    pub keep_screen_on: bool,
    pub hide_system_bars: bool,
    pub volume_keys: bool,
    /// Row-major nine tap zones.
    pub tap_zones: Vec<TapAction>,
    /// Screen brightness from 0 to 1 while reading; `None` follows the system.
    pub brightness: Option<f64>,
    pub orientation: ScreenOrientation,
    /// The reading menu uses the page colours instead of the app theme.
    pub menu_follows_page: bool,
    pub auto_page_mode: AutoPageMode,
}

impl Default for ReadingStyle {
    fn default() -> Self {
        // Legado 3.26.7 `assets/defaultData/readConfig.json`.
        let preset =
            |name: &str, background: &str, text: &str, night_background: &str, night_text: &str| {
                StylePreset {
                    name: name.to_string(),
                    background: background.to_string(),
                    text: text.to_string(),
                    night_background: night_background.to_string(),
                    night_text: night_text.to_string(),
                    background_image: None,
                    night_background_image: None,
                }
            };
        use TapAction::{Menu, Next, Previous};
        Self {
            presets: vec![
                preset("微信读书", "#c0edc6", "#0b0b0b", "#000000", "#adadad"),
                preset("纸白", "#ffffff", "#000000", "#000000", "#ffffff"),
                preset("羊皮纸", "#ddc090", "#3e3422", "#3c3f43", "#dcdfe1"),
                preset("豆沙绿", "#c2d8aa", "#596c44", "#3c3f43", "#88c16f"),
                preset("淡紫", "#dbb8e2", "#68516c", "#3c3f43", "#f6aeae"),
                preset("天青", "#abcee0", "#3d4c54", "#3c3f43", "#90bff5"),
            ],
            selected: 0,
            letter_spacing: 0.0,
            paragraph_spacing: 0.4,
            indent: 2,
            font_weight: 400,
            title_mode: TitleMode::Left,
            title_scale: 1.25,
            margins: Margins {
                top: 8.0,
                bottom: 8.0,
                left: 20.0,
                right: 20.0,
            },
            header_margins: Margins {
                top: 4.0,
                bottom: 0.0,
                left: 20.0,
                right: 20.0,
            },
            footer_margins: Margins {
                top: 0.0,
                bottom: 6.0,
                left: 20.0,
                right: 20.0,
            },
            header_line: false,
            footer_line: false,
            header: InfoBar {
                visible: true,
                left: InfoSlot::ChapterTitle,
                middle: InfoSlot::None,
                right: InfoSlot::Time,
            },
            footer: InfoBar {
                visible: true,
                left: InfoSlot::Battery,
                middle: InfoSlot::None,
                right: InfoSlot::ChapterProgress,
            },
            font_asset_id: None,
            keep_screen_on: true,
            hide_system_bars: false,
            volume_keys: true,
            tap_zones: vec![
                Previous, Previous, Next, Previous, Menu, Next, Previous, Next, Next,
            ],
            brightness: None,
            orientation: ScreenOrientation::Auto,
            menu_follows_page: false,
            auto_page_mode: AutoPageMode::Reveal,
        }
    }
}

impl ReadingStyle {
    fn validate(&self) -> Result<(), AppError> {
        let range = |value: f64, low: f64, high: f64, name: &str| {
            if value.is_finite() && (low..=high).contains(&value) {
                Ok(())
            } else {
                Err(AppError::invalid_argument(format!(
                    "{name} must be between {low} and {high}"
                )))
            }
        };
        if self.presets.is_empty() || self.presets.len() > 32 {
            return Err(AppError::invalid_argument(
                "reading styles need 1 to 32 presets",
            ));
        }
        if self.selected as usize >= self.presets.len() {
            return Err(AppError::invalid_argument(
                "selected reading style does not exist",
            ));
        }
        for preset in &self.presets {
            if preset.name.trim().is_empty() || preset.name.chars().count() > 24 {
                return Err(AppError::invalid_argument(
                    "style names need 1 to 24 characters",
                ));
            }
            for color in [
                &preset.background,
                &preset.text,
                &preset.night_background,
                &preset.night_text,
            ] {
                let hex = color.strip_prefix('#').unwrap_or("");
                if !(hex.len() == 6 || hex.len() == 8)
                    || !hex.chars().all(|c| c.is_ascii_hexdigit())
                {
                    return Err(AppError::invalid_argument(format!(
                        "invalid colour {color}"
                    )));
                }
            }
        }
        range(self.letter_spacing, -0.1, 0.5, "letter_spacing")?;
        range(self.paragraph_spacing, 0.0, 3.0, "paragraph_spacing")?;
        range(self.title_scale, 1.0, 2.5, "title_scale")?;
        for margins in [&self.margins, &self.header_margins, &self.footer_margins] {
            for value in [margins.top, margins.bottom, margins.left, margins.right] {
                range(value, 0.0, 120.0, "margins")?;
            }
        }
        if self.indent > 4 {
            return Err(AppError::invalid_argument(
                "indent must be at most 4 characters",
            ));
        }
        if !(100..=900).contains(&self.font_weight) {
            return Err(AppError::invalid_argument(
                "font_weight must be between 100 and 900",
            ));
        }
        if self.tap_zones.len() != 9 {
            return Err(AppError::invalid_argument("tap zones need nine actions"));
        }
        if let Some(brightness) = self.brightness {
            range(brightness, 0.0, 1.0, "brightness")?;
        }
        Ok(())
    }
}

fn default_auto_scroll_speed() -> u16 {
    40
}

pub const AUTO_SCROLL_SPEED_MIN: u16 = 5;
pub const AUTO_SCROLL_SPEED_MAX: u16 = 200;

fn default_auto_page_seconds() -> u8 {
    8
}

impl Default for ReaderPreferences {
    fn default() -> Self {
        Self {
            theme: ThemeMode::Light,
            paper_tone: PaperTone::WarmTea,
            oled_black: false,
            font_size: 18.0,
            line_height: 1.8,
            font_family: ReaderFont::Serif,
            page_turn_effect: PageTurnEffect::Curl,
            auto_page_seconds: default_auto_page_seconds(),
            reading_mode: ReaderMode::Single,
            auto_scroll_speed: default_auto_scroll_speed(),
            style: ReadingStyle::default(),
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
        if !(2..=60).contains(&self.auto_page_seconds) {
            return Err(AppError::invalid_argument(
                "auto_page_seconds must be between 2 and 60",
            ));
        }
        if !(AUTO_SCROLL_SPEED_MIN..=AUTO_SCROLL_SPEED_MAX).contains(&self.auto_scroll_speed) {
            return Err(AppError::invalid_argument(
                "auto_scroll_speed must be between 5 and 200 CSS pixels per second",
            ));
        }
        self.style.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsRequest {
    pub settings: ReaderPreferences,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBookRequest {
    pub book_id: String,
    pub title: String,
    pub author: Option<String>,
    /// A new introduction; absent leaves it unchanged and empty clears it.
    #[serde(default)]
    #[ts(optional)]
    pub intro: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ShelfLayout {
    #[default]
    List,
    Grid,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ShelfSort {
    #[default]
    RecentRead,
    Imported,
    Title,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfPreferences {
    pub layout: ShelfLayout,
    pub sort: ShelfSort,
    pub group_id: String,
}
impl Default for ShelfPreferences {
    fn default() -> Self {
        Self {
            layout: ShelfLayout::List,
            sort: ShelfSort::RecentRead,
            group_id: "all".into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveShelfPreferencesRequest {
    pub preferences: ShelfPreferences,
}
