//! Errors an install or uninstall can end with, each with a friendly message
//! for the UI and a technical detail for the log.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailCode {
    /// GitHub could not be reached.
    Offline,
    /// The repository has no release to install yet.
    NoRelease,
    /// A download did not match its pinned or published SHA-256.
    Checksum,
    /// The Vencord CLI failed, or its result did not verify.
    Cli,
    /// Discord's files are in use (it could not be closed).
    Busy,
    /// No Discord install was found.
    NoDiscord,
    /// A disk operation failed.
    Io,
    /// The request does not make sense (unknown branch, nothing selected).
    Invalid,
    /// Another install or uninstall is already running.
    Running,
    /// A bug.
    Internal,
}

#[derive(Debug, Clone)]
pub struct OpError {
    pub code: FailCode,
    pub message: String,
    pub detail: String,
}

impl OpError {
    pub fn new(code: FailCode, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self { code, message: message.into(), detail: detail.into() }
    }

    pub fn io(what: &str, e: impl std::fmt::Display) -> Self {
        Self::new(
            FailCode::Io,
            "Windows wouldn't let the installer write a file. Close Discord and try again.",
            format!("{what}: {e}"),
        )
    }

    pub fn offline(e: impl std::fmt::Display) -> Self {
        Self::new(
            FailCode::Offline,
            "Couldn't reach GitHub. Check your internet connection and try again.",
            e.to_string(),
        )
    }
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.detail)
    }
}

impl From<super::net::NetError> for OpError {
    fn from(e: super::net::NetError) -> Self {
        match &e {
            super::net::NetError::Io(m) => OpError::io("download", m),
            _ => OpError::offline(e),
        }
    }
}
