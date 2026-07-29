use crate::config::Config;
use crate::model::{
    ActionIntent, Danger, DevServer, DevState, LogLine, RepoRef, RunStatus, RunSummary,
    WorkspaceSnapshot,
};
use crate::toolchain::Toolchain;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

/// A prepared, not-yet-executed mutating action.
///
/// The argv is resolved and frozen here. `run_action` takes only an opaque id, so
/// there is no parameter a frontend bug — or a compromised webview — can pass to
/// change what actually executes.
pub struct PendingIntent {
    pub intent: ActionIntent,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub kind: String,
    pub repo: Option<RepoRef>,
    pub targets: Vec<RepoRef>,
    pub expires_at: Instant,
    pub typed_confirm: Option<String>,
    pub danger: Danger,
    /// For devStart/devStop: which task ("dev" / "storybook").
    pub task: Option<String>,
}

/// `"ui/blazeup-lib-ui#storybook"`.
pub fn task_key(repo_key: &str, task: &str) -> String {
    format!("{repo_key}#{task}")
}

pub struct RunHandle {
    pub summary: Mutex<RunSummary>,
    /// Ring buffer. On overflow the oldest lines are dropped and `truncated` is set.
    pub log: Mutex<VecDeque<LogLine>>,
    pub max_lines: usize,
    /// Process group id, so `killpg` can take down the whole tree. 0 if unavailable.
    pub pgid: Mutex<i32>,
    /// Set to request cancellation; the supervising task observes it.
    pub cancel: Arc<AtomicBool>,
    pub next_seq: Mutex<u64>,
}

impl RunHandle {
    pub fn push_line(&self, line: LogLine) -> bool {
        let mut log = self.log.lock().unwrap();
        let mut dropped = false;
        while log.len() >= self.max_lines {
            log.pop_front();
            dropped = true;
        }
        log.push_back(line);
        dropped
    }

    pub fn take_seq(&self) -> u64 {
        let mut s = self.next_seq.lock().unwrap();
        let v = *s;
        *s += 1;
        v
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::Relaxed)
    }
}

pub struct AppState {
    workspace_root: RwLock<PathBuf>,
    app_dir: PathBuf,
    config: RwLock<Config>,
    toolchain: RwLock<Toolchain>,

    pub intents: Mutex<HashMap<String, PendingIntent>>,
    pub runs: Mutex<HashMap<String, Arc<RunHandle>>>,
    /// task key ("fe/x#dev") -> run id. Keyed by task, not repo, so a UI library
    /// can have dev and storybook up simultaneously.
    pub dev: Mutex<HashMap<String, String>>,
    pub dev_meta: Mutex<HashMap<String, DevServer>>,
    pub last_scan: RwLock<Option<WorkspaceSnapshot>>,
    pub scan_cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
    tools_ready: AtomicBool,
}

impl AppState {
    pub fn new(workspace_root: PathBuf, app_dir: PathBuf, config: Config, tc: Toolchain) -> Self {
        AppState {
            workspace_root: RwLock::new(workspace_root),
            app_dir,
            config: RwLock::new(config),
            toolchain: RwLock::new(tc),
            intents: Mutex::new(HashMap::new()),
            runs: Mutex::new(HashMap::new()),
            dev: Mutex::new(HashMap::new()),
            dev_meta: Mutex::new(HashMap::new()),
            last_scan: RwLock::new(None),
            scan_cancel: Mutex::new(HashMap::new()),
            tools_ready: AtomicBool::new(false),
        }
    }

    pub fn workspace_root(&self) -> PathBuf {
        self.workspace_root.read().unwrap().clone()
    }

    /// Switches workspace and drops everything scoped to the old one.
    ///
    /// The scan cache and dev-server registry are per-workspace; carrying them
    /// across would show repos that are not in the folder you just opened.
    pub fn set_workspace_root(&self, root: PathBuf) {
        *self.workspace_root.write().unwrap() = root.clone();
        self.config.write().unwrap().workspace_root = root;
        *self.last_scan.write().unwrap() = None;
        self.dev.lock().unwrap().clear();
        self.dev_meta.lock().unwrap().clear();
        self.intents.lock().unwrap().clear();
    }

    pub fn app_dir(&self) -> PathBuf {
        self.app_dir.clone()
    }

    /// Cloned out deliberately: never hold a std lock across an `.await`.
    pub fn config(&self) -> Config {
        self.config.read().unwrap().clone()
    }

    pub fn set_config(&self, c: Config) {
        *self.config.write().unwrap() = c;
    }

    pub fn toolchain(&self) -> Toolchain {
        self.toolchain.read().unwrap().clone()
    }

    pub fn set_toolchain(&self, tc: Toolchain) {
        *self.toolchain.write().unwrap() = tc;
        self.tools_ready
            .store(true, std::sync::atomic::Ordering::Release);
    }

    /// False until the probe finishes. Commands that need a tool must not run
    /// before this, or they fail spuriously with "tool not available".
    pub fn tools_ready(&self) -> bool {
        self.tools_ready.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn run(&self, run_id: &str) -> Option<Arc<RunHandle>> {
        self.runs.lock().unwrap().get(run_id).cloned()
    }

    /// Fills in the pid from the run handle rather than storing a copy.
    ///
    /// The child is spawned asynchronously, so the pid is not known when the dev
    /// entry is first registered. Deriving it here avoids a race between the
    /// supervising task learning the pid and the entry existing to receive it —
    /// and avoids two copies of the same fact going out of sync.
    fn hydrate_pid(&self, mut d: DevServer) -> DevServer {
        if d.pid == 0 {
            if let Some(h) = self.run(&d.run_id) {
                let pgid = *h.pgid.lock().unwrap();
                if pgid > 0 {
                    d.pid = pgid as u32;
                }
            }
        }
        d
    }

    pub fn dev_servers(&self) -> Vec<DevServer> {
        // Collect and drop the dev_meta guard *before* hydrating, which takes the
        // runs lock. Holding both at once would establish a lock ordering that a
        // future caller could invert into a deadlock.
        let raw: Vec<DevServer> = {
            let m = self.dev_meta.lock().unwrap();
            m.values().cloned().collect()
        };
        let mut v: Vec<DevServer> = raw.into_iter().map(|d| self.hydrate_pid(d)).collect();
        v.sort_by_key(|d| d.repo.key());
        v
    }

    /// Every running task for one repo.
    pub fn dev_servers_for_repo(&self, repo_key: &str) -> Vec<DevServer> {
        let prefix = format!("{repo_key}#");
        let raw: Vec<DevServer> = {
            let m = self.dev_meta.lock().unwrap();
            m.iter()
                .filter(|(k, _)| k.starts_with(&prefix))
                .map(|(_, v)| v.clone())
                .collect()
        };
        let mut v: Vec<DevServer> = raw.into_iter().map(|d| self.hydrate_pid(d)).collect();
        v.sort_by(|a, b| a.task.cmp(&b.task));
        v
    }

    pub fn dev_server_for(&self, key: &str) -> Option<DevServer> {
        let d = {
            let m = self.dev_meta.lock().unwrap();
            m.get(key).cloned()
        };
        d.map(|d| self.hydrate_pid(d))
    }

    pub fn upsert_dev(&self, server: DevServer) {
        let key = task_key(&server.repo.key(), &server.task);
        self.dev.lock().unwrap().insert(key.clone(), server.run_id.clone());
        self.dev_meta.lock().unwrap().insert(key, server);
    }

    pub fn patch_dev<F: FnOnce(&mut DevServer)>(&self, key: &str, f: F) -> Option<DevServer> {
        let mut m = self.dev_meta.lock().unwrap();
        let s = m.get_mut(key)?;
        f(s);
        Some(s.clone())
    }

    pub fn remove_dev(&self, key: &str) {
        self.dev.lock().unwrap().remove(key);
        self.dev_meta.lock().unwrap().remove(key);
    }

    /// Every live run, for the shutdown sweep.
    pub fn all_runs(&self) -> Vec<Arc<RunHandle>> {
        self.runs.lock().unwrap().values().cloned().collect()
    }

    pub fn running_pgids(&self) -> Vec<i32> {
        self.runs
            .lock()
            .unwrap()
            .values()
            .filter(|h| matches!(h.summary.lock().unwrap().status, RunStatus::Running))
            .map(|h| *h.pgid.lock().unwrap())
            .filter(|p| *p > 1)
            .collect()
    }

    /// Persists dev-server identities so a crash can be recovered from.
    #[allow(clippy::needless_return)]
    pub fn persist_dev_runs(&self) {
        #[derive(serde::Serialize)]
        struct Rec {
            key: String,
            pid: u32,
            pgid: i32,
            argv: Vec<String>,
            started_unix: i64,
        }
        let recs: Vec<Rec> = self
            .dev_meta
            .lock()
            .unwrap()
            .values()
            .filter(|d| d.state != DevState::Crashed)
            .map(|d| Rec {
                key: task_key(&d.repo.key(), &d.task),
                pid: d.pid,
                pgid: self
                    .run(&d.run_id)
                    .map(|h| *h.pgid.lock().unwrap())
                    .unwrap_or(0),
                argv: d.command.clone(),
                started_unix: d.started_unix,
            })
            .collect();

        let _ = std::fs::create_dir_all(&self.app_dir);
        if let Ok(s) = serde_json::to_string_pretty(&recs) {
            let _ = std::fs::write(self.app_dir.join("runs.json"), s);
        }
    }
}
