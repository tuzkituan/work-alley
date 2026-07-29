use crate::paths::is_workspace;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub workspace_root: PathBuf,
    pub stale_days: i64,
    pub scan_concurrency: usize,
    pub recent_commit_limit: u32,
    pub ui_package_name: String,
    /// Keyed by repo key ("fe/blazeup-hostapp").
    #[serde(default)]
    pub dev_command_overrides: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub port_overrides: BTreeMap<String, u16>,
    pub max_log_lines_per_run: usize,
    /// Most recently opened workspaces, newest first.
    #[serde(default)]
    pub recent_roots: Vec<PathBuf>,
}

impl Config {
    pub fn defaults(workspace_root: PathBuf) -> Self {
        let cpus = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        Config {
            workspace_root,
            stale_days: 9,
            scan_concurrency: (cpus * 2).min(16),
            recent_commit_limit: 30,
            ui_package_name: "@blazeupai/blazeup-ui".into(),
            dev_command_overrides: BTreeMap::new(),
            port_overrides: BTreeMap::new(),
            max_log_lines_per_run: 5_000,
            recent_roots: Vec::new(),
        }
    }

    /// Loads config, keeping the *saved* workspace root when it is still valid.
    ///
    /// The saved root wins over discovery now that the folder is user-chosen: the
    /// app no longer lives inside the workspace, so walking up from the binary
    /// would find nothing.
    pub fn load(dir: &Path, fallback_root: Option<PathBuf>) -> Self {
        // An explicit env var is an instruction, so it outranks the saved choice.
        // Without this, WORK_ALLEY_ROOT silently did nothing once a workspace had
        // been saved — while the UI still advertised it as an override.
        let forced = std::env::var_os("WORK_ALLEY_ROOT")
            .map(PathBuf::from)
            .filter(|p| is_workspace(p));

        let path = dir.join("config.json");
        match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<Config>(&s) {
                Ok(mut c) => {
                    if let Some(f) = forced {
                        c.workspace_root = f;
                    } else if !is_workspace(&c.workspace_root) {
                        c.workspace_root = fallback_root.unwrap_or_default();
                    }
                    c
                }
                Err(e) => {
                    log::warn!("config.json unreadable ({e}); using defaults");
                    Config::defaults(forced.clone().or(fallback_root).unwrap_or_default())
                }
            },
            Err(_) => Config::defaults(forced.or(fallback_root).unwrap_or_default()),
        }
    }

    /// Records a workspace as most-recently-used, de-duplicated, capped at 8.
    pub fn remember_root(&mut self, root: PathBuf) {
        self.recent_roots.retain(|r| r != &root);
        self.recent_roots.insert(0, root);
        self.recent_roots.truncate(8);
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let s = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(dir.join("config.json"), s)
    }
}

/// Partial update — only present fields are applied.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    pub stale_days: Option<i64>,
    pub scan_concurrency: Option<usize>,
    pub recent_commit_limit: Option<u32>,
    pub max_log_lines_per_run: Option<usize>,
    pub dev_command_overrides: Option<BTreeMap<String, Vec<String>>>,
    pub port_overrides: Option<BTreeMap<String, u16>>,
}

impl ConfigPatch {
    pub fn apply(self, c: &mut Config) {
        if let Some(v) = self.stale_days {
            c.stale_days = v.clamp(1, 365);
        }
        if let Some(v) = self.scan_concurrency {
            c.scan_concurrency = v.clamp(1, 64);
        }
        if let Some(v) = self.recent_commit_limit {
            c.recent_commit_limit = v.clamp(1, 200);
        }
        if let Some(v) = self.max_log_lines_per_run {
            c.max_log_lines_per_run = v.clamp(200, 100_000);
        }
        if let Some(v) = self.dev_command_overrides {
            c.dev_command_overrides = v;
        }
        if let Some(v) = self.port_overrides {
            c.port_overrides = v;
        }
    }
}
