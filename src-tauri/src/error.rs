use serde::{Serialize, Serializer};

/// Errors are reserved for "the frontend asked for something impossible".
///
/// Anything that is a *state the UI should render* — a repo that failed to scan,
/// docker not being installed — is modelled as data, not as an error. See
/// `RepoStatus::error` and `DockerStatus::NotInstalled`.
#[derive(thiserror::Error, Debug)]
pub enum AppError {
    #[error("workspace root not found: {0}")]
    WorkspaceNotFound(String),

    #[error("path escapes the workspace: {0}")]
    PathEscape(String),

    #[error("unknown repo: {0}")]
    UnknownRepo(String),

    #[error("unknown script: {0}")]
    UnknownScript(String),

    #[error("tool not available: {0}")]
    ToolMissing(String),

    #[error("this confirmation was not found or has already been used")]
    IntentUnknown,

    #[error("confirmation expired — please re-check and try again")]
    IntentExpired,

    #[error("typed confirmation did not match")]
    ConfirmMismatch,

    #[error("a dev server is already running for {0}")]
    DevAlreadyRunning(String),

    #[error("no dev server running for {0}")]
    DevNotRunning(String),

    #[error("run not found: {0}")]
    RunUnknown(String),

    #[error("this script cannot run headless: {0}")]
    ScriptInteractive(String),

    #[error("no terminal emulator found. Run manually: {0}")]
    NoTerminal(String),

    #[error("failed to spawn: {0}")]
    Spawn(String),

    #[error("timed out after {0}ms")]
    Timeout(u64),

    #[error("{0}")]
    Invalid(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

impl AppError {
    /// Stable machine-readable code. The frontend switches on this, never on prose.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::WorkspaceNotFound(_) => "WORKSPACE_NOT_FOUND",
            AppError::PathEscape(_) => "PATH_ESCAPE",
            AppError::UnknownRepo(_) => "UNKNOWN_REPO",
            AppError::UnknownScript(_) => "UNKNOWN_SCRIPT",
            AppError::ToolMissing(_) => "TOOL_MISSING",
            AppError::IntentUnknown => "INTENT_UNKNOWN",
            AppError::IntentExpired => "INTENT_EXPIRED",
            AppError::ConfirmMismatch => "TYPED_CONFIRM_MISMATCH",
            AppError::DevAlreadyRunning(_) => "DEV_ALREADY_RUNNING",
            AppError::DevNotRunning(_) => "DEV_NOT_RUNNING",
            AppError::RunUnknown(_) => "RUN_UNKNOWN",
            AppError::ScriptInteractive(_) => "SCRIPT_INTERACTIVE",
            AppError::NoTerminal(_) => "NO_TERMINAL",
            AppError::Spawn(_) => "SPAWN_FAILED",
            AppError::Timeout(_) => "TIMEOUT",
            AppError::Invalid(_) => "INVALID",
            AppError::Io(_) => "IO",
            AppError::Json(_) => "JSON",
        }
    }

    /// The specific thing the code is about, when there is one.
    ///
    /// Exists so the UI can offer to fix it. Without this the only way to learn *which*
    /// tool was missing was to pattern-match `"tool not available: git"` — and the
    /// prose is explicitly not the contract, per `code` above.
    pub fn detail(&self) -> Option<String> {
        match self {
            AppError::ToolMissing(t) => Some(t.clone()),
            AppError::UnknownRepo(r) => Some(r.clone()),
            AppError::UnknownScript(s) => Some(s.clone()),
            _ => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 3)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("detail", &self.detail())?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
