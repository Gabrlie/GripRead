use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidPath,
    FileNotFound,
    UnsupportedEncoding,
    Io,
    Database,
    InvalidLocator,
    ContentVersionMismatch,
    AssetMissing,
    ImportCancelled,
    NotFound,
    InvalidArgument,
    OperationNotFound,
}

/// A failure for the interface: its kind, a Chinese message, and for
/// failures shown to the reader a key with parameters, which the interface
/// translates into its language (`error.<key>` in `src/i18n`); the message
/// is the fallback.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq, Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(as = "Option<BTreeMap<String, String>>", optional)]
    pub params: BTreeMap<String, String>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            key: None,
            params: BTreeMap::new(),
        }
    }

    /// An error the interface translates by `key`; `message` is the
    /// Chinese fallback.
    pub fn keyed(code: ErrorCode, key: &str, message: impl Into<String>) -> Self {
        Self {
            key: Some(key.into()),
            ..Self::new(code, message)
        }
    }

    /// Adds a parameter the translation fills in.
    pub fn with(mut self, name: &str, value: impl std::fmt::Display) -> Self {
        self.params.insert(name.into(), value.to_string());
        self
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::new(ErrorCode::Io, error.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(ErrorCode::Database, error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(ErrorCode::Database, error.to_string())
    }
}
