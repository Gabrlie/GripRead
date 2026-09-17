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
