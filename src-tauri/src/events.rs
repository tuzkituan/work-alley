//! Event names. Every payload carries its scanId/runId so the frontend can
//! demultiplex concurrent scans and runs without guessing.

pub const SCAN_STARTED: &str = "scan:started";
pub const SCAN_REPO: &str = "scan:repo";
pub const SCAN_COMMITS: &str = "scan:commits";
pub const SCAN_FINISHED: &str = "scan:finished";
pub const SCAN_ERROR: &str = "scan:error";

pub const RUN_STARTED: &str = "run:started";
pub const RUN_OUTPUT: &str = "run:output";
pub const RUN_EXIT: &str = "run:exit";

pub const DEV_CHANGED: &str = "dev:changed";
pub const DOCKER_CHANGED: &str = "docker:changed";
pub const APP_TOAST: &str = "app:toast";
/// Emitted once the toolchain probe finishes.
pub const TOOLS_READY: &str = "tools:ready";
/// Emitted after the workspace folder changes; all cached state is stale.
pub const WORKSPACE_CHANGED: &str = "workspace:changed";

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanStarted {
    pub scan_id: String,
    pub total: usize,
    pub categories: Vec<crate::model::Category>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanRepo {
    pub scan_id: String,
    pub repo: crate::model::RepoStatus,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanCommits {
    pub scan_id: String,
    pub commits: Vec<crate::model::CommitEntry>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanFinished {
    pub scan_id: String,
    pub snapshot: crate::model::WorkspaceSnapshot,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub run: crate::model::RunSummary,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    pub run_id: String,
    pub lines: Vec<crate::model::LogLine>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunExit {
    pub run_id: String,
    pub status: crate::model::RunStatus,
    pub ended_unix: i64,
    pub duration_ms: u64,
    pub line_count: u64,
    pub truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevChanged {
    pub servers: Vec<crate::model::DevServer>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockerChanged {
    pub status: crate::model::DockerStatus,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Toast {
    pub level: String,
    pub message: String,
    pub run_id: Option<String>,
}
