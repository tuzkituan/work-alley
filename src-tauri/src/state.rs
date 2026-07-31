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
    /// Initial PTY geometry for termShell/termScript. Must survive prepare→run,
    /// because the pane that measured it is not in scope at dispatch.
    pub size: Option<crate::model::TermSize>,
}

/// What a workflow run is, in the words the confirmation dialog needs.
///
/// Stored beside the id rather than passed in with the action, so every string in
/// "Re-runs CI #482 on main" comes from the backend's own last answer instead of
/// from whatever the frontend believed at click time.
#[derive(Debug, Clone)]
pub struct GhRunLabel {
    pub workflow: String,
    pub number: u64,
    pub branch: String,
}

/// A workflow, in the words a dispatch needs: its display name, and the inputs it
/// declares once anyone has asked.
#[derive(Debug, Clone, Default)]
pub struct GhWorkflowLabel {
    pub name: String,
    /// Empty until the dispatch form has been fetched for this workflow.
    pub inputs: Vec<String>,
}

/// `"libs/design-system#storybook"`.
pub fn task_key(repo_key: &str, task: &str) -> String {
    format!("{repo_key}#{task}")
}

pub struct RunHandle {
    pub summary: Mutex<RunSummary>,
    /// Ring buffer. On overflow the oldest lines are dropped and `truncated` is set.
    pub log: Mutex<VecDeque<LogLine>>,
    pub max_lines: usize,
    /// The child and everything it spawns, so a stop can take down the whole tree.
    /// `None` until the spawn succeeds.
    pub group: Mutex<Option<crate::platform::Group>>,
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
    /// Workflow run ids most recently listed for each repo, by `RepoRef::key()`.
    ///
    /// The closed set the `ghRun*` actions are checked against, the same way
    /// `RunScript` is checked against `pkg::available_scripts`. Worth being clear
    /// about what it buys: a run id is a `u64` and argv never touches a shell, so
    /// injection is impossible by construction — the type is the sanitiser. What
    /// this adds is *scope*, so a stale render after switching repos cannot cancel
    /// a run in a repository nobody is looking at.
    ///
    /// The label rides along so the confirmation dialog's text is server-derived
    /// too. Bounded: one 50-ish entry map per repo, cleared on workspace switch.
    pub gh_runs: Mutex<HashMap<String, HashMap<u64, GhRunLabel>>>,
    /// Workflows most recently listed for each repo, by `RepoRef::key()` then by
    /// path — the closed set `GhWorkflowRun` is checked against.
    ///
    /// `inputs` fills in when the dispatch form is opened, which is the only route
    /// to running one, so by the time an argv is built the declared names are
    /// known and a key GitHub would reject never reaches it.
    pub gh_workflows: Mutex<HashMap<String, HashMap<String, GhWorkflowLabel>>>,
    pub last_scan: RwLock<Option<WorkspaceSnapshot>>,
    pub scan_cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Integrated terminal sessions, keyed by term id.
    pub ptys: Mutex<HashMap<String, Arc<crate::pty::PtySession>>>,
    tools_ready: AtomicBool,
    /// The last computed readiness snapshot.
    ///
    /// Cached because the alternative is computing it inside `get_bootstrap`, which
    /// every invalidation calls — and the probe behind it is not free.
    readiness: RwLock<crate::readiness::Readiness>,
    /// A toolchain probe is in flight.
    ///
    /// The probe runs two `-lic` login shells at a 6s timeout each, so a
    /// double-click on "Re-check" — or two package installs finishing together —
    /// must not launch two of them.
    probing: AtomicBool,
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
            gh_runs: Mutex::new(HashMap::new()),
            gh_workflows: Mutex::new(HashMap::new()),
            last_scan: RwLock::new(None),
            scan_cancel: Mutex::new(HashMap::new()),
            ptys: Mutex::new(HashMap::new()),
            tools_ready: AtomicBool::new(false),
            // Nothing is known until the first probe, and `tools_ready: false` is what
            // stops the UI treating that as a broken machine.
            readiness: RwLock::new(crate::readiness::unknown()),
            probing: AtomicBool::new(false),
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
        self.gh_runs.lock().unwrap().clear();
        self.gh_workflows.lock().unwrap().clear();
        self.intents.lock().unwrap().clear();
        // `ptys` is deliberately *not* cleared. A shell you are halfway through a
        // command in is still a valid shell, and killing it because you switched
        // folders is hostile; each tab shows its own cwd, so nothing is
        // misleading. The omission only looks like one next to the clears above.
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

    pub fn readiness(&self) -> crate::readiness::Readiness {
        self.readiness.read().unwrap().clone()
    }

    pub fn set_readiness(&self, r: crate::readiness::Readiness) {
        *self.readiness.write().unwrap() = r;
    }

    /// Claims the right to run a probe, or reports that someone else already has.
    ///
    /// `compare_exchange`, not a read-then-write: two installs finishing in the same
    /// frame would both see `false` and both probe.
    pub fn begin_probe(&self) -> bool {
        self.probing
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }

    pub fn end_probe(&self) {
        self.probing
            .store(false, std::sync::atomic::Ordering::Release);
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
                if let Some(g) = h.group.lock().unwrap().as_ref() {
                    d.pid = g.pid();
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
    /// Whether any run is currently touching this repo.
    ///
    /// `targets` rather than `repo`, so a bulk pull counts for every repo it is
    /// working through — a bulk action leaves `repo` unset, which is exactly the case
    /// a background task must not step on. Used by auto-fetch: a concurrent `git
    /// fetch` and `git pull` in one repo contend for the same ref locks, and it is
    /// the user's pull that must not be the one that fails.
    pub fn is_repo_busy(&self, repo_key: &str) -> bool {
        self.runs.lock().unwrap().values().any(|h| {
            let s = h.summary.lock().unwrap();
            matches!(s.status, crate::model::RunStatus::Running)
                && s.targets.iter().any(|t| t.key() == repo_key)
        })
    }

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

    /// The task has no live run any more, but its row stays so the state is
    /// readable.
    ///
    /// The counterpart to `remove_dev`, which is for a stop that worked. Splitting
    /// them is the whole fix for the stuck-forever row: `self.dev` means "we are
    /// supervising a run", and `DevStart` gates on exactly that — so a crashed
    /// entry used to block the restart that would have cleared it. Only `dev_meta`
    /// survives, carrying the state that explains what happened.
    pub fn retire_dev(&self, key: &str, to: DevState) -> Option<DevServer> {
        // Same lock order as `remove_dev`: dev, then dev_meta.
        self.dev.lock().unwrap().remove(key);
        let mut m = self.dev_meta.lock().unwrap();
        let s = m.get_mut(key)?;
        s.state = to;
        Some(s.clone())
    }

    /// Registers the live run for a task. The `dev_meta` half follows separately.
    ///
    /// Called from `spawn_run` before the supervising task can exist, because a
    /// command that fails to spawn reaches `finish()` immediately — and `finish`
    /// looks the task up *here*. Registering afterwards left a row stuck on
    /// "starting" with nothing alive to clear it.
    pub fn claim_dev(&self, key: &str, run_id: &str) {
        self.dev
            .lock()
            .unwrap()
            .insert(key.to_string(), run_id.to_string());
    }

    /// The run id currently supervised for this task, if any.
    pub fn live_dev_run(&self, key: &str) -> Option<String> {
        self.dev.lock().unwrap().get(key).cloned()
    }

    /// Records the run ids a listing just handed to the UI.
    ///
    /// `replace` for the unfiltered view, which is authoritative, and a merge for
    /// a per-workflow one: selecting a workflow in the sidebar must not disarm the
    /// re-run button on every row that was on screen a moment ago. The merge is
    /// capped so a long session of clicking through workflows cannot grow it
    /// without bound.
    pub fn remember_gh_runs(&self, repo_key: &str, runs: &[crate::model::WorkflowRun], replace: bool) {
        const CAP: usize = 500;
        let mut all = self.gh_runs.lock().unwrap();
        let entry = all.entry(repo_key.to_string()).or_default();
        if replace {
            entry.clear();
        } else if entry.len() > CAP {
            // Oldest-first would need an ordering this map does not keep; the
            // point is only that it stays bounded, and the next unfiltered fetch
            // replaces it wholesale anyway.
            entry.clear();
        }
        for r in runs {
            entry.insert(
                r.id,
                GhRunLabel {
                    workflow: r.workflow_name.clone(),
                    number: r.number,
                    branch: r.branch.clone(),
                },
            );
        }
    }

    /// Records the workflows a listing just handed to the UI.
    ///
    /// Replaces wholesale: unlike the runs, this is always the complete set for a
    /// repo, so a workflow deleted upstream should stop being dispatchable here.
    /// Known input names are carried across, since they came from a separate call
    /// and re-listing does not invalidate them.
    pub fn remember_gh_workflows(&self, repo_key: &str, workflows: &[crate::model::Workflow]) {
        let mut all = self.gh_workflows.lock().unwrap();
        let entry = all.entry(repo_key.to_string()).or_default();
        let carried: HashMap<String, Vec<String>> = entry
            .iter()
            .map(|(p, l)| (p.clone(), l.inputs.clone()))
            .collect();
        entry.clear();
        for w in workflows {
            entry.insert(
                w.path.clone(),
                GhWorkflowLabel {
                    name: w.name.clone(),
                    inputs: carried.get(&w.path).cloned().unwrap_or_default(),
                },
            );
        }
    }

    /// Records the inputs a dispatch form just rendered, so the argv built from it
    /// can be checked against them without a second network call.
    pub fn remember_gh_inputs(&self, repo_key: &str, path: &str, inputs: Vec<String>) {
        let mut all = self.gh_workflows.lock().unwrap();
        let entry = all.entry(repo_key.to_string()).or_default();
        entry.entry(path.to_string()).or_default().inputs = inputs;
    }

    /// The label for a workflow this app listed, or None if it never did.
    pub fn gh_workflow_label(&self, repo_key: &str, path: &str) -> Option<GhWorkflowLabel> {
        self.gh_workflows
            .lock()
            .unwrap()
            .get(repo_key)
            .and_then(|m| m.get(path))
            .cloned()
    }

    /// The label for a run this app listed, or None if it never did.
    ///
    /// None is the gate: an action for an id that was never listed is refused.
    pub fn gh_run_label(&self, repo_key: &str, run_id: u64) -> Option<GhRunLabel> {
        self.gh_runs
            .lock()
            .unwrap()
            .get(repo_key)
            .and_then(|m| m.get(&run_id))
            .cloned()
    }

    /// Task keys with a live run, for the liveness sweep.
    pub fn supervised_dev_keys(&self) -> std::collections::HashSet<String> {
        self.dev.lock().unwrap().keys().cloned().collect()
    }

    /// Every live run, for the shutdown sweep.
    pub fn all_runs(&self) -> Vec<Arc<RunHandle>> {
        self.runs.lock().unwrap().values().cloned().collect()
    }

    /// The tree of every live run, for the shutdown sweep.
    pub fn running_groups(&self) -> Vec<crate::platform::Group> {
        self.runs
            .lock()
            .unwrap()
            .values()
            .filter(|h| matches!(h.summary.lock().unwrap().status, RunStatus::Running))
            .filter_map(|h| h.group.lock().unwrap().clone())
            .filter(|g| g.is_tree())
            .collect()
    }

    // A `persist_dev_runs` used to live here, writing `runs.json` synchronously
    // on every dev state transition so a crash "could be recovered from". Nothing
    // ever read it back, and its record could not have been read back: it stored a
    // task key, and rebuilding a `DevServer` needs a `RepoRef`. `kill_all_now` on
    // exit already reaps every server this app owns, so after a normal quit there
    // is nothing to recover. Reconciliation, if it is ever wanted, needs a record
    // carrying the ref, the task and the port — and an adopt-by-pid path in
    // devStop to go with it.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DevState, RepoRef};

    fn state() -> AppState {
        let d = std::env::temp_dir().join(format!("wa-state-{}", std::process::id()));
        AppState::new(d.clone(), d.clone(), Config::defaults(d), Toolchain::default())
    }

    fn server(task: &str, run_id: &str) -> DevServer {
        DevServer {
            repo: RepoRef {
                category: "fe".into(),
                name: "web".into(),
            },
            task: task.into(),
            run_id: run_id.into(),
            pid: 0,
            command: vec!["npm".into(), "run".into(), task.into()],
            port: None,
            port_source: None,
            state: DevState::Starting,
            url: None,
            started_unix: 0,
        }
    }

    #[test]
    fn retiring_keeps_the_row_but_frees_the_task() {
        let s = state();
        s.upsert_dev(server("dev", "r1"));
        assert_eq!(s.live_dev_run("fe/web#dev").as_deref(), Some("r1"));

        let after = s.retire_dev("fe/web#dev", DevState::Crashed).expect("row");
        assert_eq!(after.state, DevState::Crashed);
        // The row survives so the crash is readable…
        assert!(s.dev_server_for("fe/web#dev").is_some());
        // …but nothing claims a live run, which is what `DevStart` gates on. This is
        // the whole bug: a crashed entry used to block the restart that fixes it.
        assert_eq!(s.live_dev_run("fe/web#dev"), None);
    }

    #[test]
    fn a_stop_that_worked_takes_the_row_with_it() {
        let s = state();
        s.upsert_dev(server("dev", "r1"));
        s.remove_dev("fe/web#dev");
        assert!(s.dev_server_for("fe/web#dev").is_none());
        assert_eq!(s.live_dev_run("fe/web#dev"), None);
    }

    #[test]
    fn restarting_over_a_crashed_row_claims_it_again() {
        let s = state();
        s.upsert_dev(server("dev", "r1"));
        s.retire_dev("fe/web#dev", DevState::Crashed);

        s.upsert_dev(server("dev", "r2"));
        assert_eq!(s.live_dev_run("fe/web#dev").as_deref(), Some("r2"));
        assert_eq!(
            s.dev_server_for("fe/web#dev").map(|d| d.state),
            Some(DevState::Starting)
        );
    }

    #[test]
    fn claim_dev_registers_the_run_before_any_row_exists() {
        // What `spawn_run` does: a command that fails to spawn reaches `finish`
        // before `register_dev` has written the meta half, and `finish` finds the
        // task through this map.
        let s = state();
        s.claim_dev("fe/web#dev", "r1");
        assert_eq!(s.live_dev_run("fe/web#dev").as_deref(), Some("r1"));
        assert!(s.supervised_dev_keys().contains("fe/web#dev"));
        assert!(s.dev_server_for("fe/web#dev").is_none());
    }
}
