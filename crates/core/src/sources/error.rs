//! Source failures, kept distinct so a broken site, an unsupported feature,
//! and a script error are reported differently.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SourceErrorKind {
    /// The site could not be reached or answered with an error.
    Network,
    /// The source needs a capability GripRead does not have yet.
    Unsupported,
    /// A source script threw or could not be parsed.
    Script,
    /// A rule is invalid or produced nothing usable.
    Rule,
    /// The operation took longer than its limit.
    Timeout,
    /// The operation was cancelled.
    Cancelled,
    /// The source returned no content.
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceError {
    pub kind: SourceErrorKind,
    pub message: String,
}

impl SourceError {
    pub fn new(kind: SourceErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn rule(message: impl Into<String>) -> Self {
        Self::new(SourceErrorKind::Rule, message)
    }

    pub fn script(message: impl Into<String>) -> Self {
        Self::new(SourceErrorKind::Script, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(SourceErrorKind::Network, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(SourceErrorKind::Unsupported, message)
    }

    pub fn empty(message: impl Into<String>) -> Self {
        Self::new(SourceErrorKind::Empty, message)
    }

    pub fn cancelled() -> Self {
        Self::new(SourceErrorKind::Cancelled, "已取消")
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(SourceErrorKind::Timeout, message)
    }
}

impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SourceError {}

impl From<String> for SourceError {
    fn from(message: String) -> Self {
        SourceError::rule(message)
    }
}

pub type SourceResult<T> = Result<T, SourceError>;
