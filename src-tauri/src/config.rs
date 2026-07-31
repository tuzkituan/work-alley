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
    /// Pins the shared package whose version drift is tracked. Normally None:
    /// the workspace's shared package is detected from what the repos actually
    /// depend on, which is the only thing that works across workspaces.
    #[serde(default)]
    pub tracked_package: Option<String>,
    /// Keyed by **task** key ("frontend/my-app#dev") — see `state::task_key`. The
    /// consumers are `commands::build_action`'s DevStart arm and `register_dev`,
    /// both of which look up a task key, not a repo key.
    #[serde(default)]
    pub dev_command_overrides: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub port_overrides: BTreeMap<String, u16>,
    pub max_log_lines_per_run: usize,
    /// Minutes between background fetches; 0 turns it off.
    ///
    /// Defaulted rather than opt-in because every sync number the UI shows is
    /// computed from local refs, so without this a workspace left open reports
    /// "in sync" with growing confidence and shrinking accuracy. `serde(default)`
    /// so a config written before this field existed still loads.
    #[serde(default = "default_auto_fetch_minutes")]
    pub auto_fetch_minutes: u64,
    /// Open the folder that was open when the app last quit, instead of the picker.
    ///
    /// On by default. The cost is real — launching goes straight into a scan of the
    /// remembered folder — but landing on a picker every single time to choose the
    /// same workspace is the larger one, and the switch is one control away in
    /// Settings. `default_reopen_last_workspace` rather than a bare `serde(default)`
    /// for the same reason `auto_fetch_minutes` has one: a bare default is `false`,
    /// which would silently turn this off for everyone who already has a config.
    #[serde(default = "default_reopen_last_workspace")]
    pub reopen_last_workspace: bool,
    /// Most recently opened workspaces, newest first.
    #[serde(default)]
    pub recent_roots: Vec<PathBuf>,
    /// When first-run onboarding was finished or skipped. `None` means never.
    ///
    /// Here rather than in webview storage: clearing site data must not bring a
    /// takeover screen back on a machine that is plainly set up. A timestamp rather
    /// than a bool so it is possible to tell *when* — and so a future build can decide
    /// to ask again after a long enough gap without a migration.
    #[serde(default)]
    pub onboarding_done_unix: Option<i64>,
    /// `workspace_root` came from `WORK_ALLEY_ROOT`, not from the saved config.
    ///
    /// Not persisted — it describes this process's environment, and a saved `true`
    /// would outlive the variable that justified it. Startup reads it to tell an
    /// explicit instruction apart from a remembered choice: the env var opens a
    /// workspace, the saved folder is only offered.
    #[serde(skip)]
    pub root_forced: bool,
}

/// Ten minutes: long enough that a laptop on a phone tether is not fetching
/// constantly, short enough that "behind by 3" is news rather than history.
fn default_auto_fetch_minutes() -> u64 {
    10
}

fn default_reopen_last_workspace() -> bool {
    true
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
            tracked_package: None,
            dev_command_overrides: BTreeMap::new(),
            port_overrides: BTreeMap::new(),
            max_log_lines_per_run: 5_000,
            auto_fetch_minutes: default_auto_fetch_minutes(),
            reopen_last_workspace: default_reopen_last_workspace(),
            recent_roots: Vec::new(),
            onboarding_done_unix: None,
            root_forced: false,
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
                        c.root_forced = true;
                    } else if !is_workspace(&c.workspace_root) {
                        c.workspace_root = fallback_root.unwrap_or_default();
                    }
                    c
                }
                Err(e) => {
                    log::warn!("config.json unreadable ({e}); using defaults");
                    let mut c = Config::defaults(forced.clone().or(fallback_root).unwrap_or_default());
                    c.root_forced = forced.is_some();
                    c
                }
            },
            Err(_) => {
                let mut c = Config::defaults(forced.clone().or(fallback_root).unwrap_or_default());
                c.root_forced = forced.is_some();
                c
            }
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
    pub auto_fetch_minutes: Option<u64>,
    pub reopen_last_workspace: Option<bool>,
    pub dev_command_overrides: Option<BTreeMap<String, Vec<String>>>,
    pub port_overrides: Option<BTreeMap<String, u16>>,
}

/// Which workspace this launch opens; an empty path means the picker.
///
/// A free function so it can be tested: nothing inside `lib.rs`'s `setup` closure
/// can be. `WORK_ALLEY_ROOT` is an instruction for *this* launch and always wins.
/// The saved folder is opened only when the user asked for that, and only while it
/// is still a workspace — a renamed or unmounted directory falls back to the
/// picker, which still offers it from `recent_roots`.
pub fn startup_root(cfg: &Config) -> PathBuf {
    if cfg.root_forced {
        return cfg.workspace_root.clone();
    }
    if cfg.reopen_last_workspace && is_workspace(&cfg.workspace_root) {
        return cfg.workspace_root.clone();
    }
    PathBuf::new()
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
        if let Some(v) = self.auto_fetch_minutes {
            // 0 is meaningful — off — so the floor cannot be 1. The ceiling is a
            // day, past which "automatic" is indistinguishable from disabled.
            c.auto_fetch_minutes = if v == 0 { 0 } else { v.clamp(1, 1440) };
        }
        // Nothing to clamp on a bool, and `None` must leave it alone — a patch that
        // sets one number would otherwise silently turn this off.
        if let Some(v) = self.reopen_last_workspace {
            c.reopen_last_workspace = v;
        }
        if let Some(v) = self.dev_command_overrides {
            c.dev_command_overrides = v;
        }
        if let Some(v) = self.port_overrides {
            c.port_overrides = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config written by a build that predates `onboarding_done_unix`.
    ///
    /// The regression this guards is nasty and silent: `load` falls back to *full
    /// defaults* on any deserialize error, so a field added without `serde(default)`
    /// would throw away the user's recent workspaces and every per-repo override
    /// without saying a word.
    #[test]
    fn an_older_config_loads_with_its_contents_intact() {
        let dir = std::env::temp_dir().join(format!("wa-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let json = r#"{
            "workspaceRoot": "/nonexistent",
            "staleDays": 9,
            "scanConcurrency": 8,
            "recentCommitLimit": 30,
            "maxLogLinesPerRun": 5000,
            "recentRoots": ["/tmp/one", "/tmp/two"],
            "portOverrides": { "fe/web#dev": 5173 },
            "devCommandOverrides": { "fe/web#dev": ["bun", "run", "dev", "--host"] }
        }"#;
        std::fs::write(dir.join("config.json"), json).unwrap();

        let c = Config::load(&dir, None);

        assert_eq!(
            c.recent_roots,
            vec![PathBuf::from("/tmp/one"), PathBuf::from("/tmp/two")],
            "the fallback-to-defaults path ate the saved config"
        );
        assert_eq!(c.port_overrides.get("fe/web#dev"), Some(&5173));
        assert_eq!(
            c.dev_command_overrides.get("fe/web#dev").map(|v| v.len()),
            Some(4)
        );
        // Defaulted on, and via a function rather than serde's bare `false` — an
        // old config has no such key, and landing on `false` would turn the feature
        // off for exactly the people who have been using the app longest.
        assert!(c.reopen_last_workspace);
        // Absent means never onboarded, which is the honest reading of an old config.
        assert_eq!(c.onboarding_done_unix, None);
        // A field added later must arrive at its default, not at 0 — 0 means "never
        // fetch", so `serde(default)` alone silently disables the feature for
        // everyone who already had a config.
        assert_eq!(c.auto_fetch_minutes, default_auto_fetch_minutes());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 0 is a value, not an omission: it is how auto-fetch is turned off, so it has
    /// to survive a clamp whose lower bound is 1 for every other input.
    #[test]
    fn zero_turns_auto_fetch_off_and_is_not_clamped_up() {
        let mut c = Config::defaults(PathBuf::from("/nonexistent"));

        ConfigPatch { auto_fetch_minutes: Some(0), ..Default::default() }.apply(&mut c);
        assert_eq!(c.auto_fetch_minutes, 0);

        ConfigPatch { auto_fetch_minutes: Some(5), ..Default::default() }.apply(&mut c);
        assert_eq!(c.auto_fetch_minutes, 5);

        // Past a day, "automatic" is indistinguishable from disabled.
        ConfigPatch { auto_fetch_minutes: Some(99_999), ..Default::default() }.apply(&mut c);
        assert_eq!(c.auto_fetch_minutes, 1440);
    }

    #[test]
    fn the_flag_survives_a_save_and_load() {
        let dir = std::env::temp_dir().join(format!("wa-cfg-rt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut c = Config::defaults(PathBuf::from("/nonexistent"));
        c.onboarding_done_unix = Some(1_700_000_000);
        c.save(&dir).unwrap();

        assert_eq!(
            Config::load(&dir, None).onboarding_done_unix,
            Some(1_700_000_000)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reopen_can_be_patched_both_ways_and_left_alone() {
        let mut c = Config::defaults(PathBuf::from("/nonexistent"));
        ConfigPatch {
            reopen_last_workspace: Some(true),
            ..Default::default()
        }
        .apply(&mut c);
        assert!(c.reopen_last_workspace);

        // The case a careless `unwrap_or_default()` breaks: a patch that touches one
        // number must not turn this off.
        ConfigPatch {
            stale_days: Some(30),
            ..Default::default()
        }
        .apply(&mut c);
        assert!(c.reopen_last_workspace);

        ConfigPatch {
            reopen_last_workspace: Some(false),
            ..Default::default()
        }
        .apply(&mut c);
        assert!(!c.reopen_last_workspace);
    }

    #[test]
    fn patching_leaves_the_workspace_and_recents_alone() {
        // Neither is in ConfigPatch, and both would be silent losses: the root is
        // what "reopen last folder" reads, and recents is the welcome screen.
        let mut c = Config::defaults(PathBuf::from("/tmp/ws"));
        c.recent_roots = vec![PathBuf::from("/tmp/ws"), PathBuf::from("/tmp/other")];
        ConfigPatch {
            stale_days: Some(14),
            auto_fetch_minutes: Some(0),
            ..Default::default()
        }
        .apply(&mut c);

        assert_eq!(c.workspace_root, PathBuf::from("/tmp/ws"));
        assert_eq!(c.recent_roots.len(), 2);
        assert_eq!(c.stale_days, 14);
        assert_eq!(c.auto_fetch_minutes, 0);
    }

    #[test]
    fn startup_opens_nothing_unless_asked() {
        let mut c = Config::defaults(PathBuf::from("/tmp/definitely-not-a-workspace"));

        // Off: the folder is offered on the welcome screen rather than opened.
        c.reopen_last_workspace = false;
        assert_eq!(startup_root(&c), PathBuf::new());

        // The env var is an instruction for this launch and outranks the flag.
        c.root_forced = true;
        assert_eq!(startup_root(&c), PathBuf::from("/tmp/definitely-not-a-workspace"));
        c.root_forced = false;

        // On, but the folder has been renamed or the drive is not mounted — the
        // picker, not an error. This is the case people actually hit.
        c.reopen_last_workspace = true;
        assert_eq!(startup_root(&c), PathBuf::new());

        // Opted in and the folder is still a workspace.
        let dir = std::env::temp_dir().join(format!("wa-cfg-reopen-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("repos.json"), "[]").unwrap();
        c.workspace_root = dir.clone();
        assert_eq!(startup_root(&c), dir);
        std::fs::remove_dir_all(&dir).ok();
    }
}
