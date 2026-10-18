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
    /// An EPUB converted to text at import (`crate::epub`).
    Epub,
    /// A comic (a CBZ or ZIP of images, or a fixed-layout EPUB of
    /// pictures), held as text of image marks as an EPUB is (`crate::comic`).
    Comic,
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
    /// For a book read chapter by chapter: the chapter resources around
    /// this one, which the reader moves into at the resource's edges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub previous_resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_resource_id: Option<String>,
    /// The chapter's position and count, for a book read chapter by chapter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource_count: Option<u32>,
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
    /// Without a locator: the resource to read from its start (forward) or
    /// its end (backward), for moving into a neighbouring chapter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource_id: Option<String>,
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
    /// An online chapter's tag from its source, usually its update time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tag: Option<String>,
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
    /// A built-in rule loose enough to match prose; such rules are only
    /// used when chosen, never found automatically inside online chapters
    /// or suggested.
    #[serde(default)]
    pub loose: bool,
}

/// Per-book chapter detection settings.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookTocSettings {
    /// The selected rule, or `None` to choose among enabled rules automatically.
    pub rule_id: Option<String>,
    /// Split chapters longer than about 100 KB (Legado 拆分超长章节).
    pub split_long_chapters: bool,
    /// Titles of the pieces a text with no matching rule is cut into: a
    /// template where `{n}` is the piece's number and `{text}` its first
    /// words. `None` is Legado's `第N章(n)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub untitled_title: Option<String>,
    /// The size of those pieces in KB; `None` is Legado's 10.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chunk_kb: Option<u32>,
    /// The one-time question about this book's contents (a disabled rule
    /// that matches, or chapters inside an online chapter) was answered.
    #[serde(default)]
    pub asked: bool,
    /// An online book: headings found inside its chapters (by `rule_id`, or
    /// the enabled rules) are listed in the contents as well.
    #[serde(default)]
    pub inner_chapters: bool,
}

/// The one-time question about a book's contents, asked by the detail page
/// or the reader, whichever opens first.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TocSuggestion {
    /// `rule`: no enabled rule matches but a disabled one does; `inner`:
    /// an online chapter holds several chapters.
    pub kind: String,
    pub rule_id: String,
    pub rule_name: String,
    /// A few of the headings the rule finds.
    pub titles: Vec<String>,
    /// How many headings it finds: in the whole text, or in the online
    /// chapters kept so far.
    pub count: u32,
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
    /// The contents are the source's titles a converted book kept, so no
    /// rule or size splitting applies.
    #[serde(default)]
    pub fixed: bool,
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
    /// Characters other than whitespace: the whole text of a local book, the
    /// kept chapters of an online one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub word_count: Option<u64>,
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
    /// The managed text of a local book; online books have none.
    pub asset: Option<BookAsset>,
    /// Where an online book comes from and how far its contents reach.
    pub online: Option<OnlineShelfInfo>,
    pub locator: Option<ReaderLocator>,
    pub total_length: Option<u64>,
    pub txt_encoding: Option<TxtEncodingInfo>,
    pub last_read_at: Option<i64>,
    pub removed_at: Option<i64>,
    /// A reading state the reader chose by moving the book; `None` lets the
    /// shelf derive it from progress.
    pub shelf_state: Option<ShelfState>,
    pub cover_asset_id: Option<String>,
    /// Legado's per-book 替换净化 switch.
    pub use_replace_rules: bool,
    /// The cloud bookshelf had this book's file when it was last seen.
    pub in_cloud: bool,
}

/// An online book on the shelf: its source, details, and contents state.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineShelfInfo {
    /// The source's details as the reader last fetched them.
    pub book: OnlineBook,
    pub total_chapters: u32,
    /// Chapters the last contents update added, shown as Legado's new mark.
    pub new_chapters: u32,
    pub last_check_time: Option<i64>,
    /// The last contents update failed with this message.
    pub update_error: Option<String>,
    /// Legado's 允许更新: whether 更新目录 includes this book.
    pub can_update: bool,
    /// False for a book read from search without adding it to the shelf.
    pub on_shelf: bool,
    /// The chapter the saved position is in.
    pub read_chapter: Option<u32>,
    pub read_chapter_title: String,
    /// Chapters whose text is kept on the device.
    pub cached_chapters: u32,
    /// The contents grew within the 连载判定 range: still being written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub serial: Option<bool>,
    /// When an update last found new chapters; the shelf sorts by it too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub grown_at: Option<i64>,
    /// When it joined the shelf; the shelf sorts by it too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shelved_at: Option<i64>,
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
    /// The book, or `retired:<key>` for a deleted one.
    pub book_id: String,
    pub seconds: u64,
    pub last_day: String,
    pub title: String,
    pub author: Option<String>,
    /// The book was deleted; its time stays in the records.
    pub deleted: bool,
    /// When it was last read (or deleted), for the newest-first order.
    pub last_read_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStats {
    pub total_seconds: u64,
    pub today_seconds: u64,
    /// Days with reading in the last 26 weeks, most recent first.
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
    /// Legado's 预下载章节数: online chapters fetched ahead while reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pre_download_chapters: Option<u8>,
    /// 连载判定: an online book whose contents grew within these days is not
    /// moved to 读完 at its end; `None` is 30, `0` turns it off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub serial_days: Option<u16>,
    /// 退出时清理缓存: the default 数据管理 parts are cleared at the next start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub clear_cache_on_exit: Option<bool>,
    /// 自动更新: 更新目录 runs when the shelf opens; `None` is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_update_shelf: Option<bool>,
    /// 界面样式 the reader made (设置 › 外观 › 更多外观设置).
    #[serde(default)]
    pub custom_styles: Vec<InterfaceStyle>,
    /// The custom style in use, by id; absent uses `paper_tone`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub custom_style: Option<String>,
    /// The 界面样式 shown in 外观, at most four: paper tone ids
    /// (`warm-tea`, …) or custom style ids. Empty shows the four tones.
    #[serde(default)]
    pub pinned_styles: Vec<String>,
    /// 默认封面: managed images drawn for books without a cover, by day and
    /// night (files on this device, like reading backgrounds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub night_default_cover: Option<String>,
    /// The default cover shows the title / the author; `None` is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_show_name: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_show_author: Option<bool>,
    /// 仅在 Wi‑Fi 下加载网络封面; `None` is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub covers_wifi_only: Option<bool>,
    /// The page the app opens on: `bookshelf`, `discover`, or `settings`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub home_tab: Option<String>,
    /// The 发现 tab shows; `None` is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_discover: Option<bool>,
    /// The 订阅 tab shows; `None` is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_subscription: Option<bool>,
    /// The bottom navigation shows its labels; `None` is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nav_labels: Option<bool>,
    /// The bottom navigation hides while the shelf scrolls down; `None` is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nav_autohide: Option<bool>,
    /// 未命中规则时的标题 for books without their own: a template as
    /// [`BookTocSettings::untitled_title`]; `None` is Legado's `第N章(n)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub toc_untitled_title: Option<String>,
    /// The size of those pieces in KB; `None` is Legado's 10.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub toc_chunk_kb: Option<u32>,
    /// The comic reader's settings; `None` is their defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub comic: Option<ComicPreferences>,
}

/// How comics are read.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ComicMode {
    /// One long strip of pages, chapter after chapter (条漫).
    #[default]
    Scroll,
    /// One page at a time.
    Paged,
    /// Two pages side by side on a wide screen, one on a narrow one.
    Double,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ComicDirection {
    #[default]
    LeftToRight,
    /// Japanese manga: pages turn from right to left.
    RightToLeft,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ComicFit {
    #[default]
    Width,
    Height,
    /// The whole page on screen.
    Screen,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ComicBackground {
    #[default]
    Theme,
    Black,
    White,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ComicPreferences {
    pub mode: ComicMode,
    pub direction: ComicDirection,
    pub fit: ComicFit,
    /// Space between pages in the strip, in CSS pixels.
    pub gap: u32,
    /// Pages fetched ahead of the one shown.
    pub preload: u32,
    pub background: ComicBackground,
    /// The page number at the bottom.
    pub page_number: bool,
}

impl Default for ComicPreferences {
    fn default() -> Self {
        Self {
            mode: ComicMode::Scroll,
            direction: ComicDirection::LeftToRight,
            fit: ComicFit::Width,
            gap: 0,
            preload: 5,
            background: ComicBackground::Theme,
            page_number: true,
        }
    }
}

/// A 界面样式 made from a main colour; the others, when empty, are derived
/// from it for day and night (src/application/theme-colors.ts).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceStyle {
    pub id: String,
    pub name: String,
    /// `#rrggbb`, as are the others.
    pub primary: String,
    /// The page (surface) colour.
    #[serde(default)]
    pub paper: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    /// Secondary text and controls.
    #[serde(default)]
    pub secondary: Option<String>,
}

/// Custom 界面样式 kept at once.
pub const CUSTOM_STYLES_MAX: usize = 24;

fn hex_colour(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|ch| ch.is_ascii_hexdigit())
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

/// Legado's 简繁转换, applied to the stored text when a book is decoded.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChineseConversion {
    #[default]
    Off,
    ToTraditional,
    ToSimplified,
}

/// A Legado replace rule (替换净化). Rules apply to every line of a book in
/// `serial` order; `scope` lists book titles separated by `;` or `,`, and an
/// empty scope applies to every book.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRule {
    /// Empty when adding a rule.
    pub id: String,
    pub name: String,
    pub group: String,
    pub pattern: String,
    pub replacement: String,
    pub is_regex: bool,
    pub scope: String,
    /// Applies to chapter titles in the contents and the title line
    /// (Legado `scopeTitle`).
    #[serde(default)]
    pub scope_title: bool,
    /// Applies to the chapter text (Legado `scopeContent`).
    #[serde(default = "default_true")]
    pub scope_content: bool,
    pub enabled: bool,
    pub serial: i64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveReplaceRuleRequest {
    pub rule: ReplaceRule,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRuleIdsRequest {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestReplaceRuleRequest {
    pub rule: ReplaceRule,
    pub sample: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookReplaceRequest {
    pub book_id: String,
    pub enabled: bool,
}

/// A button of the reading menu's bottom bar.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ReaderTool {
    Search,
    AutoPage,
    ReadAloud,
    Contents,
    Style,
    Night,
    Bookmark,
    ReplaceRules,
    TocRules,
    Encoding,
    MoreSettings,
}

pub const MAX_BOTTOM_TOOLS: usize = 7;

/// Legado's bottom menu.
pub fn default_bottom_tools() -> Vec<ReaderTool> {
    use ReaderTool::*;
    vec![Search, AutoPage, ReadAloud, Contents, Style, Night]
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
    pub orientation: ScreenOrientation,
    /// The reading menu uses the page colours instead of the app theme.
    pub menu_follows_page: bool,
    pub chinese_conversion: ChineseConversion,
    /// Read-aloud speed and pitch, where 1 is the engine's normal value.
    pub speech_rate: f64,
    pub speech_pitch: f64,
    /// An installed system voice; `None` uses the engine default.
    pub speech_voice: Option<String>,
    /// The tool buttons of the reading menu's bottom bar, in order.
    pub bottom_tools: Vec<ReaderTool>,
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
            orientation: ScreenOrientation::Auto,
            menu_follows_page: false,
            chinese_conversion: ChineseConversion::Off,
            speech_rate: 1.0,
            speech_pitch: 1.0,
            speech_voice: None,
            bottom_tools: default_bottom_tools(),
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
        if self.bottom_tools.is_empty() || self.bottom_tools.len() > MAX_BOTTOM_TOOLS {
            return Err(AppError::invalid_argument(format!(
                "the bottom bar needs 1 to {MAX_BOTTOM_TOOLS} tools"
            )));
        }
        let mut seen = std::collections::HashSet::new();
        if !self.bottom_tools.iter().all(|tool| seen.insert(*tool)) {
            return Err(AppError::invalid_argument("bottom bar tools repeat"));
        }
        range(self.speech_rate, 0.3, 3.0, "speech_rate")?;
        range(self.speech_pitch, 0.5, 2.0, "speech_pitch")?;
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
            pre_download_chapters: None,
            serial_days: None,
            clear_cache_on_exit: None,
            auto_update_shelf: None,
            custom_styles: Vec::new(),
            custom_style: None,
            pinned_styles: Vec::new(),
            default_cover: None,
            night_default_cover: None,
            cover_show_name: None,
            cover_show_author: None,
            covers_wifi_only: None,
            home_tab: None,
            show_discover: None,
            show_subscription: None,
            nav_labels: None,
            nav_autohide: None,
            toc_untitled_title: None,
            toc_chunk_kb: None,
            comic: None,
        }
    }
}

impl ReaderPreferences {
    /// Validate values crossing the IPC boundary and values restored from the
    /// persistent preferences record. Enum fields are validated by serde;
    /// these bounds keep typography values finite and usable by the WebView.
    pub fn validate(&self) -> Result<(), AppError> {
        if self
            .toc_untitled_title
            .as_deref()
            .is_some_and(|title| title.chars().count() > 64)
        {
            return Err(AppError::keyed(
                crate::error::ErrorCode::InvalidArgument,
                "untitledTooLong",
                "标题样式最多 64 个字",
            ));
        }
        if self.toc_chunk_kb.is_some_and(|kb| !(2..=200).contains(&kb)) {
            return Err(AppError::invalid_argument(
                "toc_chunk_kb must be between 2 and 200",
            ));
        }
        if let Some(comic) = &self.comic {
            if comic.gap > 64 || !(1..=20).contains(&comic.preload) {
                return Err(AppError::invalid_argument(
                    "comic gap must be at most 64 and preload between 1 and 20",
                ));
            }
        }
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
        if self.custom_styles.len() > CUSTOM_STYLES_MAX || self.pinned_styles.len() > 4 {
            return Err(AppError::invalid_argument(
                "too many custom or pinned interface styles",
            ));
        }
        for style in &self.custom_styles {
            let colours = [&style.paper, &style.text, &style.secondary];
            if style.id.is_empty()
                || style.name.chars().count() > 40
                || !hex_colour(&style.primary)
                || colours
                    .iter()
                    .any(|colour| colour.as_deref().is_some_and(|colour| !hex_colour(colour)))
            {
                return Err(AppError::invalid_argument(
                    "an interface style needs an id, a short name, and #rrggbb colours",
                ));
            }
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

/// 坚果云, used when the WebDAV address is left empty.
pub const DEFAULT_WEBDAV_URL: &str = "https://dav.jianguoyun.com/dav/";
/// The folder under the WebDAV address when 子文件夹 is left empty.
pub const DEFAULT_WEBDAV_FOLDER: &str = "GripRead";

/// Parts of a backup that a restore can skip (Legado 恢复忽略列表).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum RestoreCategory {
    /// Reader typography, styles, page turning, and read-aloud.
    ReadingSettings,
    /// Theme mode, paper tone, and OLED black.
    Theme,
    /// Shelf layout, sort, and selected tab.
    ShelfLayout,
    ReplaceRules,
    TocRules,
    Groups,
    Progress,
    Bookmarks,
    ReadingTime,
    /// Title, author, introduction, cover, and placement.
    BookInfo,
    /// Book sources (their JSON, switches, groups, and order).
    Sources,
    /// Online books on the shelf with their source and progress.
    OnlineBooks,
}

/// This device's WebDAV account (Legado WebDav 设置). The password is kept in
/// local storage only, shown on request in settings, and never written into backups.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSettings {
    /// The server address; empty uses 坚果云.
    pub url: String,
    pub username: String,
    pub password: String,
    /// The folder under the address (Legado 子文件夹); empty uses `GripRead`.
    pub folder: String,
    /// Names this device in backups and progress (Legado 设备名称); empty uses the platform.
    pub device_name: String,
    /// A local folder that also receives backups (Legado 备份路径), for display.
    pub local_folder: Option<String>,
    /// Back up once a day when the records changed, keeping seven automatic backups.
    pub auto_backup: bool,
    /// Sync reading progress when opening and leaving a book (Legado 同步阅读进度).
    pub sync_progress: bool,
    /// Also when the reader resumes or the network returns (Legado 同步增强).
    pub sync_progress_plus: bool,
    /// Upload edited book details to the cloud bookshelf without asking.
    #[serde(default)]
    #[ts(optional)]
    pub auto_sync_book_info: Option<bool>,
    pub restore_ignore: Vec<RestoreCategory>,
    pub last_backup_at: Option<i64>,
    /// Why the last automatic backup or progress upload failed.
    pub last_error: Option<String>,
    /// Whether an account is set (an address or a user name).
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveWebDavRequest {
    pub url: String,
    pub username: String,
    /// `None` keeps the saved password.
    pub password: Option<String>,
    pub folder: String,
    pub device_name: String,
    pub auto_backup: bool,
    pub sync_progress: bool,
    pub sync_progress_plus: bool,
    #[serde(default)]
    #[ts(optional)]
    pub auto_sync_book_info: Option<bool>,
    pub restore_ignore: Vec<RestoreCategory>,
}

/// A WebDAV connection check: the median round trip of a few requests.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDavCheck {
    pub latency_ms: u32,
    /// Slow enough that progress sync is not recommended.
    pub slow: bool,
}

/// A backup file in the WebDAV backup folder.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackup {
    pub name: String,
    pub size: u64,
    pub modified: Option<i64>,
    /// Made by the daily automatic backup, which keeps only the latest seven.
    pub automatic: bool,
    /// The device that made it, from its name.
    pub device: Option<String>,
}

/// A book file on the cloud bookshelf.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudBook {
    /// The file name in the cloud book folder.
    pub name: String,
    pub title: String,
    pub author: Option<String>,
    pub size: u64,
    /// SHA-256 of the file, when it was uploaded by GripRead.
    pub source_sha256: Option<String>,
    pub uploaded_at: Option<i64>,
    /// The local book with the same file, if any.
    pub local_book_id: Option<String>,
    /// That local book is in the 回收站.
    pub local_removed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudUploadReport {
    pub uploaded: u32,
    /// Books already uploaded whose information or cover was brought up to date.
    pub updated: u32,
    /// Books already on the cloud bookshelf.
    pub skipped: u32,
    /// Titles that could not be uploaded, with the reason.
    pub failed: Vec<String>,
}

/// What a backup holds and how much of it matches this library.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub created_at: i64,
    pub device: String,
    pub books: u32,
    /// Books of the backup that are on this device.
    pub books_on_device: u32,
    pub bookmarks: u32,
    pub groups: u32,
    pub replace_rules: u32,
    /// User chapter rules (built-in rules are only switched and ordered).
    pub toc_rules: u32,
    pub has_preferences: bool,
    pub book_sources: u32,
    pub online_books: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub groups_created: u32,
    pub rules_restored: u32,
    pub preferences_restored: bool,
    pub books_restored: u32,
    /// Books not on this device; their records apply when they are imported.
    pub books_pending: u32,
    pub positions_restored: u32,
    pub bookmarks_added: u32,
    /// Sources added or updated to a newer copy.
    pub sources_restored: u32,
    /// Online books added or brought up to date.
    pub online_books_restored: u32,
    /// The local recovery point written before restoring.
    pub recovery_point: String,
    /// The backup file's WebDAV account was taken (this device had none).
    #[serde(default)]
    pub webdav_restored: bool,
}

/// Where a backup comes from or goes to.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind", content = "name")]
pub enum BackupSource {
    /// A file in the WebDAV backup folder.
    Remote(String),
    /// A local recovery point.
    Recovery(String),
    /// A file the reader picked.
    File(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSourceRequest {
    pub source: BackupSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NameRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookIdListRequest {
    pub book_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OptionalPathRequest {
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBookRequest {
    pub book_id: String,
    /// Also delete the book's file from the cloud bookshelf.
    pub cloud: bool,
}

/// Another device's newer reading position for the open book (Legado 云端进度).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPrompt {
    pub device_id: String,
    pub device_name: String,
    pub revision: u64,
    pub written_at: i64,
    pub chapter_title: String,
    /// Text at the position, to recognize it.
    pub excerpt: String,
    /// The position in this device's text of the book.
    pub locator: ReaderLocator,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgressRequest {
    pub book_id: String,
    pub chapter_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeProgressRequest {
    pub book_id: String,
    pub device_id: String,
    pub revision: u64,
    /// The prompt's position, so reading on nearby is not asked about again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locator: Option<ReaderLocator>,
}

// Book sources (Legado `BookSource`). The source JSON itself stays as text
// on the boundary; these are the views pages list and the requests they send.

/// One book source as the 书源管理 list shows it.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceSummary {
    /// `bookSourceUrl`, the source's identity.
    pub url: String,
    pub name: String,
    /// Groups separated by `,` or `;` as Legado stores them.
    pub group: String,
    pub enabled: bool,
    pub enabled_explore: bool,
    pub has_explore: bool,
    pub has_search: bool,
    /// The source has a login form or script.
    pub has_login: bool,
    pub custom_order: i64,
    pub weight: i64,
    pub last_update_time: i64,
    pub respond_time: i64,
    pub comment: String,
    /// 通过服务器访问 is on for it on this device.
    #[serde(default)]
    pub via_server: bool,
    /// An image (comic) source, Legado's `bookSourceType` 2.
    #[serde(default)]
    pub comic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceViaServerRequest {
    pub urls: Vec<String>,
    pub on: bool,
}

/// A source with its full JSON, for the editor.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookSourceDetail {
    pub summary: BookSourceSummary,
    /// The source JSON, pretty-printed, with fields GripRead does not use kept.
    pub json: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceImportStatus {
    /// Not on this device.
    New,
    /// On this device with an older `lastUpdateTime`.
    Update,
    /// On this device and not newer.
    Existing,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceImportItem {
    pub url: String,
    pub name: String,
    pub group: String,
    pub status: SourceImportStatus,
}

/// What an import would do, before anything is saved.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceImportPreview {
    pub items: Vec<SourceImportItem>,
    /// Audio, image, and file sources, which GripRead does not read.
    pub skipped: u32,
    /// Entries that are not usable sources, with the reason.
    pub invalid: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSourceImportRequest {
    /// One source object or an array, as Legado exports them.
    pub json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourcesRequest {
    pub json: String,
    /// The sources to save; others in the JSON are left out.
    pub urls: Vec<String>,
    /// Keep the name, groups, and enabled switches of sources already here.
    pub keep_name: bool,
    pub keep_group: bool,
    pub keep_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceUrlRequest {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceUrlsRequest {
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceSwitch {
    /// The source takes part in search.
    Enabled,
    /// The source's 发现 categories are shown.
    Explore,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetSourcesSwitchRequest {
    pub urls: Vec<String>,
    pub switch: SourceSwitch,
    pub on: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceGroupRequest {
    pub urls: Vec<String>,
    pub group: String,
    /// Add the group, or remove it.
    pub add: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MoveSourcesRequest {
    pub urls: Vec<String>,
    /// To the top of the manual order, or to the bottom.
    pub top: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveBookSourceRequest {
    pub json: String,
    /// The source's address before editing, when it was changed.
    pub previous_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchTextRequest {
    pub url: String,
}

/// One row of a source's `loginUi`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLoginRow {
    pub name: String,
    /// `text`, `password`, `button`, or `toggle`/`select` with `chars`.
    pub kind: String,
    pub action: Option<String>,
    pub default_value: Option<String>,
    /// Choices for `select` and `toggle` rows.
    pub chars: Vec<String>,
}

/// A source's login form and what is already saved for it.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLoginForm {
    pub rows: Vec<SourceLoginRow>,
    #[ts(type = "Record<string, string>")]
    pub values: std::collections::BTreeMap<String, String>,
    /// The source logs in only through a web page, which needs WebView.
    pub browser_only: bool,
    pub login_url: Option<String>,
    /// What the source's last successful login answered, and when (ms).
    pub last_login: Option<String>,
    #[ts(type = "number | null")]
    pub last_login_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLoginRequest {
    pub url: String,
    #[ts(type = "Record<string, string>")]
    pub values: std::collections::BTreeMap<String, String>,
    /// A button row's action, instead of the source's `login()`.
    pub action: Option<String>,
}

/// What a source script did, for login buttons and source actions.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceScriptReport {
    pub result: String,
    pub logs: Vec<String>,
    /// A login that succeeded (a script that ran, or a web login the
    /// source's `login()` confirmed).
    #[serde(default)]
    pub logged_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceVariableRequest {
    pub url: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DebugSourceRequest {
    pub operation_id: String,
    pub url: String,
    /// A search keyword, or a book or explore address to start from.
    pub key: String,
}

/// One line of a source debug run, streamed as `source-debug`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceDebugEvent {
    pub operation_id: String,
    pub line: String,
    /// The run ended; `error` says why when it failed.
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckSourcesRequest {
    pub operation_id: String,
    pub urls: Vec<String>,
    /// The search keyword; empty uses each source's `checkKeyWord` or 我的.
    pub keyword: String,
    /// Switch off a source whose reading chain fails, or only its explore
    /// when just 发现 fails.
    pub disable_failed: bool,
}

/// Progress of a source check, streamed as `source-check`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheckEvent {
    pub operation_id: String,
    pub url: String,
    pub name: String,
    /// What is being checked, or the outcome.
    pub message: String,
    /// This source's check finished; `ok` tells how.
    pub finished: bool,
    pub ok: bool,
    pub checked: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSourcesFileRequest {
    /// The file chosen in the save dialog; Android asks with its own screen.
    pub path: Option<String>,
    /// The sources to export; every source when empty.
    pub urls: Vec<String>,
}

/// A book as one source describes it: a search or explore result, or its
/// details once read.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineBook {
    pub source_url: String,
    pub source_name: String,
    pub name: String,
    pub author: String,
    /// Categories, comma separated.
    pub kind: String,
    pub cover_url: String,
    pub intro: String,
    pub word_count: String,
    pub latest_chapter_title: String,
    pub book_url: String,
    pub toc_url: String,
    /// The book's rule variables as JSON, carried between steps.
    pub variables: String,
    /// The details asked for the contents newest first.
    pub reverse_toc: bool,
    /// A comic: its source is an image source, and it opens in the comic reader.
    #[serde(default)]
    pub comic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddOnlineBookRequest {
    pub book: OnlineBook,
    pub chapters: Vec<OnlineChapter>,
    /// False opens it for reading without putting it on the shelf.
    pub on_shelf: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeOnlineSourceRequest {
    pub book_id: String,
    /// The details from the new source, with its contents.
    pub book: OnlineBook,
    pub chapters: Vec<OnlineChapter>,
}

/// After 换源: the book, and where its position went.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeOnlineSourceResult {
    pub book: LibraryBook,
    /// The chapter the position is now in; `None` when the book was unread.
    pub chapter: Option<u32>,
    /// False when no chapter matched by title or number, so the position
    /// kept its place in the contents.
    pub certain: bool,
    /// The saved position after the switch.
    pub locator: Option<ReaderLocator>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindOnlineBookRequest {
    pub name: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOnlineTocRequest {
    pub operation_id: String,
    /// Empty updates every shelf book that allows updates.
    pub book_ids: Vec<String>,
}

/// Progress of 更新目录, streamed as `online-toc`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineTocEvent {
    pub operation_id: String,
    pub book_id: String,
    pub updated: u32,
    pub total: u32,
    pub new_chapters: u32,
    pub error: Option<String>,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetOnlineBookFlagRequest {
    pub book_id: String,
    pub on: bool,
}

/// Search results with the same name and author from several sources.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSearchResult {
    pub name: String,
    pub author: String,
    pub kind: String,
    pub cover_url: String,
    pub intro: String,
    pub word_count: String,
    pub latest_chapter_title: String,
    /// Each source's copy, in the order they answered.
    pub origins: Vec<OnlineBook>,
}

/// Which sources a search asks; both empty means every enabled source.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchScope {
    pub groups: Vec<String>,
    pub source_urls: Vec<String>,
    /// Only comic (image) sources, or only text ones; `None` is both. A
    /// source asked for by address is searched whatever its kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub comic: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchOnlineRequest {
    pub operation_id: String,
    pub key: String,
    pub scope: SearchScope,
    /// Keep only results whose name or author contains the key.
    pub precise: bool,
    pub page: u32,
    /// Keep only this author's books. With an empty `key` the author is
    /// what the sources are searched for.
    #[serde(default)]
    #[ts(optional)]
    pub author: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFailure {
    pub source_name: String,
    pub message: String,
}

/// Search progress, streamed as `online-search` with the merged results so far.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSearchEvent {
    pub operation_id: String,
    pub searched: u32,
    pub total: u32,
    pub done: bool,
    pub results: Vec<OnlineSearchResult>,
    pub failures: Vec<SourceFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExploreKindsRequest {
    pub source_url: String,
    /// Run the source's explore script again instead of using its cache.
    pub refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExploreBooksRequest {
    pub source_url: String,
    pub url: String,
    pub page: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineBookRequest {
    pub book: OnlineBook,
    /// Ask the source again instead of using a copy kept within the hour.
    #[serde(default)]
    #[ts(optional)]
    pub refresh: Option<bool>,
}

/// One entry of an online book's table of contents.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineChapter {
    pub index: u32,
    pub title: String,
    /// The address as the source gave it, possibly relative.
    pub url: String,
    /// The page the address is relative to.
    pub base_url: String,
    pub is_volume: bool,
    pub is_vip: bool,
    pub is_pay: bool,
    /// Extra text such as an update time.
    pub tag: String,
    pub variables: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineContentRequest {
    pub book: OnlineBook,
    pub chapter: OnlineChapter,
    pub next_chapter_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineContent {
    /// The title the content page gave, when it has a title rule.
    pub title: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineCoverRequest {
    pub source_url: String,
    pub url: String,
}

/// Saves a source's cover image as the book's own cover.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceCoverRequest {
    pub book_id: String,
    pub source_url: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    /// The lowest level to list.
    pub level: crate::app_log::LogLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub entries: Vec<crate::app_log::LogEntry>,
    /// 详细日志 is on until then.
    pub detail_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetFlagRequest {
    pub on: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogRequest {
    pub level: crate::app_log::LogLevel,
    #[serde(default)]
    pub area: String,
    pub message: String,
    /// `log.<key>` and its params, so the entry reads in the page's language.
    #[serde(default)]
    #[ts(optional)]
    pub key: Option<String>,
    #[serde(default)]
    #[ts(as = "Option<std::collections::BTreeMap<String, String>>", optional)]
    pub params: std::collections::BTreeMap<String, String>,
}

/// One part of the app's data folder (数据管理).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataPart {
    pub key: String,
    pub label: String,
    pub bytes: u64,
    /// A cache 数据管理 can clear.
    pub clearable: bool,
}

/// An online book on the shelf with its chapter cache.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfBookCache {
    pub book_id: String,
    pub title: String,
    pub bytes: u64,
    pub cached_chapters: u32,
    pub total_chapters: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataUsage {
    pub parts: Vec<DataPart>,
    pub books: Vec<ShelfBookCache>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClearDataRequest {
    pub parts: Vec<String>,
}

/// Where a 下载管理 job is.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    Queued,
    Running,
    Paused,
    Done,
    Cancelled,
}

/// One book's chapter range in the download queue.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub book_id: String,
    pub title: String,
    /// The chapter range `[start, end)`.
    pub start: u32,
    pub end: u32,
    pub state: DownloadState,
    /// Chapters in the range kept on the device.
    pub cached: u32,
    pub failed: u32,
    pub total: u32,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub book_id: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJobRequest {
    pub id: String,
}

/// 网络设置's request limits (省心, 均衡, 极速, or 自定义).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConcurrencyPreset {
    Relaxed,
    Balanced,
    Fast,
    Custom,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConcurrencyLimits {
    /// Requests in flight at once, over all sources.
    pub requests: u16,
    /// 限流阈值: requests to one site within the window.
    pub per_host: u16,
    /// 时间窗口, in milliseconds.
    pub window_ms: u32,
    /// Sources searched at once.
    pub search: u16,
    /// Books downloading at once.
    pub download_books: u16,
    /// Chapters in flight per downloading book.
    pub download_chapters: u16,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProxyKind {
    None,
    Http,
    Socks5,
}

/// 网络设置: DNS over HTTPS, a proxy for the app, and request limits. Kept on
/// the device only, never in backups.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettings {
    pub doh_enabled: bool,
    /// `ali`, `tencent`, `cloudflare`, `google`, or `custom`.
    pub doh_server: String,
    pub doh_custom_url: String,
    /// IPs (comma or space separated) the custom DoH server is reached by,
    /// so finding it does not need DNS.
    #[serde(default)]
    pub doh_bootstrap: String,
    pub proxy_kind: ProxyKind,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub proxy_username: String,
    pub proxy_password: String,
    pub preset: ConcurrencyPreset,
    /// The 自定义 values; the presets have their own.
    pub custom: ConcurrencyLimits,
}

/// The device's own proxy (`host:port`), which requests use when the app
/// has none and which turns DoH off like the app's proxy does.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkState {
    #[ts(optional)]
    pub system_proxy: Option<String>,
}

/// What a 测试 found: the time taken and a short description.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCheck {
    pub millis: u32,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCheckRequest {
    pub settings: NetworkSettings,
    /// `doh` or `proxy`.
    pub kind: String,
}

/// 设置 › 服务器: this device's connection to the GripRead server. The
/// session token stays in the data folder, never in backups.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncServerStatus {
    pub connected: bool,
    pub address: String,
    pub device_name: String,
    pub syncing: bool,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
    /// 自动下载服务器上的书.
    pub auto_download: bool,
    /// 通过服务器更新书籍: 更新目录 asks the server while connected.
    pub update_via_server: bool,
    /// Not connected, but the last sign-in is kept: `address` and
    /// `device_name` are its, and connecting may leave the password empty.
    pub remembered: bool,
}

/// A request to the connected server's management API (服务器管理 in the
/// app): 定时追更, signed-in devices, and the password.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerApiRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub body: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectSyncServerRequest {
    pub address: String,
    pub password: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SwitchRequest {
    pub on: bool,
}

/// Which releases the app offers: 正式版 (releases only) or 测试版 (beta
/// pre-releases too).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

/// 下载方式: where updates are checked for and downloaded from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum UpdateSource {
    /// The connected server, else GitHub through the app's proxy.
    #[default]
    Auto,
    /// GitHub without any proxy.
    Direct,
    /// GitHub through the app's proxy (网络设置).
    Proxy,
    /// GitHub's release list directly, files through an accelerator.
    Accelerator,
    /// The connected GripRead server's mirror.
    Server,
}

/// The accelerator a new install suggests.
pub const DEFAULT_ACCELERATOR: &str = "https://gh-proxy.com/{url}";

/// 检查更新 settings, kept on the device only.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateSettings {
    pub channel: UpdateChannel,
    pub source: UpdateSource,
    /// The accelerator's address: `{url}` (the GitHub download address),
    /// `{path}` (it without `https://github.com/`), `{tag}`, and `{name}`
    /// are filled in; without any of them it is a prefix.
    pub accelerator: String,
    /// Check once a day when the app starts.
    pub auto_check: bool,
    /// When the last check finished.
    pub last_check: Option<i64>,
    /// A version the reader chose to skip (跳过此版本 on the update prompt);
    /// newer versions are offered again.
    pub skipped: Option<String>,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            channel: UpdateChannel::Stable,
            source: UpdateSource::Auto,
            accelerator: DEFAULT_ACCELERATOR.into(),
            auto_check: true,
            last_check: None,
            skipped: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveUpdateSettingsRequest {
    pub channel: UpdateChannel,
    pub source: UpdateSource,
    pub accelerator: String,
    pub auto_check: bool,
    pub skipped: Option<String>,
}

/// How this copy of GripRead updates itself.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateKind {
    /// Download the APK and hand it to the system installer.
    Android,
    /// The desktop updater replaces the app and relaunches it.
    Desktop,
    /// The web version: the server is updated by pulling its image.
    Server,
}

/// One release's notes for 更新日志.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    pub version: String,
    pub prerelease: bool,
    pub published_at: i64,
    /// The changes, in Markdown, without the download and image sections.
    pub notes: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub prerelease: bool,
    pub published_at: i64,
    pub notes: String,
    pub url: String,
    /// The file to download for this device (the APK); none on desktop and
    /// the web version.
    pub asset: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub kind: UpdateKind,
    pub current: String,
    /// A newer version on the chosen channel, if any.
    pub update: Option<AvailableUpdate>,
    /// The channel's releases, newest first, for 更新日志.
    pub releases: Vec<ReleaseNote>,
    /// Checked through the connected GripRead server.
    pub via_server: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckUpdateRequest {
    /// The running version (package.json, stamped by release builds).
    pub current: String,
    /// 自动检查更新, which alone counts toward the daily check; checking
    /// on 关于 leaves the next automatic check (and its prompt) due.
    #[serde(default)]
    #[ts(optional)]
    pub automatic: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallUpdateRequest {
    pub operation_id: String,
    pub version: String,
}

/// Download progress of an update, as the `update-progress` event.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub operation_id: String,
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstallOutcome {
    /// The system installer is open (Android) or the app is relaunching.
    Started,
    /// Android needs 安装未知应用 allowed for GripRead first; its settings
    /// screen is open.
    NeedsPermission,
}

/// An EPUB illustration's size, so pages are laid out before it loads.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookImage {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookImageRequest {
    pub book_id: String,
    pub index: u32,
}

/// The kind of service a translation engine talks to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum EngineKind {
    /// Any OpenAI-compatible chat API (OpenAI, DeepSeek, 通义, Kimi,
    /// OpenRouter, Ollama, …).
    #[default]
    OpenAi,
    Claude,
    Gemini,
    Deepl,
    /// A DeepLX service (self-hosted, or a hosted one with the key in its
    /// address).
    Deeplx,
}

/// A translation engine, kept on this device with its key.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TranslationEngine {
    pub id: String,
    pub name: String,
    pub kind: EngineKind,
    /// The API address; empty uses the kind's official one. `{apiKey}`
    /// and `{model}` are filled in.
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    /// Extra instructions for language models (style, names, terms).
    pub prompt: String,
    /// Extra request headers, one `Name: value` per line, with the same
    /// placeholders. When the address or a header takes `{apiKey}`, the
    /// kind's usual key header is not sent.
    #[serde(default)]
    pub headers: String,
}

/// How a translated book reads: the translation alone, or each paragraph
/// followed by its translation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TranslationDisplay {
    #[default]
    Translated,
    Bilingual,
}

/// 翻译 settings, kept on this device only (keys never enter backups or sync).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct TranslationSettings {
    pub engines: Vec<TranslationEngine>,
    /// The engine books are translated with.
    pub default_engine: Option<String>,
    /// The language books are translated into (a code such as `zh-CN`).
    pub target: String,
    pub display: TranslationDisplay,
    /// Books detected in another language start translated.
    pub auto_translate: bool,
    /// Chapters of online books translated ahead of the one being read.
    pub ahead: u32,
    /// How translated paragraphs look (译文样式).
    pub style: TranslationStyle,
    /// CSS declarations for translated paragraphs when `style` is `custom`.
    pub custom_css: String,
}

/// 译文样式: the look of translated paragraphs in the reader.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TranslationStyle {
    #[default]
    Plain,
    /// Secondary colour, a little smaller.
    Dim,
    /// A rule at the left, indented.
    Quote,
    Italic,
    /// Blurred until tapped.
    Blur,
    /// `custom_css`.
    Custom,
}

impl Default for TranslationSettings {
    fn default() -> Self {
        Self {
            engines: Vec::new(),
            default_engine: None,
            target: "zh-CN".into(),
            display: TranslationDisplay::Translated,
            auto_translate: false,
            ahead: 2,
            style: TranslationStyle::Plain,
            custom_css: String::new(),
        }
    }
}

/// A book's language and whether it is read translated.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookTranslation {
    pub book_id: String,
    /// The book's language, detected or chosen; `None` until known.
    pub language: Option<String>,
    /// The language the book is read in when translated.
    pub translate_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookTranslationRequest {
    pub book_id: String,
    /// The language to translate into; `None` turns translation off.
    pub translate_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookLanguageRequest {
    pub book_id: String,
    /// `None` detects it again.
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestEngineRequest {
    pub engine: TranslationEngine,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslateBookRequest {
    pub book_id: String,
    /// 翻译整本: the whole book, not only the stretch ahead of the reader.
    pub whole: bool,
}

/// Progress of translating a local book (`book-translation`).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookTranslationEvent {
    pub book_id: String,
    /// Lines translated in this run, of those it set out to translate.
    pub done: u32,
    pub total: u32,
    /// A new snapshot is ready: the text should be generated again.
    pub applied: bool,
    pub finished: bool,
    /// Why the run stopped early; translations made so far are kept.
    pub error: Option<crate::error::AppError>,
}

/// What importing a replace-rule JSON would do.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRuleImportPreview {
    /// The rules in order; `chosen` in [`ImportReplaceRulesRequest`] counts
    /// positions in this list.
    pub items: Vec<ReplaceRuleImportItem>,
    /// Title-only and empty rules, which have nothing to change in text.
    pub skipped: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRuleImportItem {
    pub rule: ReplaceRule,
    /// The same pattern and replacement is already here.
    pub existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReplaceRulesRequest {
    pub json: String,
    /// Positions in the preview to import; all when absent.
    #[ts(optional)]
    pub chosen: Option<Vec<u32>>,
}

/// Progress of translating an online chapter as it is read
/// (`chapter-translation`): lines sent to the engine of those it needs.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChapterTranslationEvent {
    pub book_id: String,
    pub index: u32,
    pub done: u32,
    pub total: u32,
    /// Translated ahead of the reader rather than opened.
    pub ahead: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextsRequest {
    /// Titles or introductions; each may hold several lines.
    pub texts: Vec<String>,
}

/// Something about a book source the reader should hear of (`source-notice`).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceNotice {
    /// The source's name.
    pub source: String,
    pub kind: SourceNoticeKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceNoticeKind {
    /// 通过服务器访问 failed; the source was reached directly.
    RelayFallback,
}

/// 书源订阅: a source list's address, updated by hand through 网络导入.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSubscription {
    /// Empty when adding one.
    pub id: String,
    pub name: String,
    pub url: String,
    /// When it was last imported from (ms), and how many sources that saved.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub imported: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionImportedRequest {
    pub id: String,
    pub count: u32,
}

/// One page of a comic chapter: its size when known (0 until a page of an
/// online comic is kept), and where it is for positions and bookmarks.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComicPage {
    pub width: u32,
    pub height: u32,
    /// The locator offset of the page: its image line in a local comic's
    /// text, or the page number in an online chapter.
    pub offset: u64,
}

/// A comic chapter's pages, with what a locator into it needs.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComicChapter {
    pub index: u32,
    pub title: String,
    pub resource_id: String,
    pub content_version: String,
    pub pages: Vec<ComicPage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComicChapterRequest {
    pub book_id: String,
    /// The chapter's place in the contents.
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComicPageRequest {
    pub book_id: String,
    pub chapter: u32,
    pub page: u32,
}
