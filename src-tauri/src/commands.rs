use crate::config::{Config, ConfigPatch};
use crate::error::{AppError, AppResult};
use crate::events;
use crate::model::*;
use crate::procs::{self, SpawnSpec};
use crate::state::{AppState, PendingIntent};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const INTENT_TTL: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------- bootstrap --

#[tauri::command]
pub async fn get_bootstrap(state: State<'_, Arc<AppState>>) -> AppResult<Bootstrap> {
    build_bootstrap(state.inner()).await
}

async fn build_bootstrap(state: &Arc<AppState>) -> AppResult<Bootstrap> {
    let root = state.workspace_root();
    let cfg = state.config();
    let tc = state.toolchain();

    let declared = declared_repos(&root);
    let discovered = crate::paths::discover_groups(&root);
    let workspace_label = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string();

    let mut categories = Vec::new();
    let mut repos = Vec::new();

    for (group, count) in &discovered {
        let found = crate::paths::discover_repos(&root, std::slice::from_ref(group));
        categories.push(CategoryInfo {
            category: group.clone(),
            label: if group.is_empty() {
                workspace_label.clone()
            } else {
                group.clone()
            },
            present: true,
            repo_count: *count,
            declared_count: declared.get(group.as_str()).map_or(0, |v| v.len() as u32),
        });
        repos.extend(found.into_iter().map(|(r, _)| r));
    }

    // Groups named in repos.json but with nothing cloned yet still deserve a row,
    // so "0 of 38 cloned" is visible rather than the group simply missing.
    //
    // Unless every repo it names is already cloned somewhere else here — then the
    // folder was renamed or reorganised, and repos.json is describing a layout that
    // no longer exists. Renaming `be/` to `backend/` used to leave a permanent
    // `be  0 / 38` in the rail with nothing behind it and no way to clear it.
    let cloned: std::collections::HashSet<&str> = repos.iter().map(|r| r.name.as_str()).collect();
    for (group, names) in &declared {
        if names.is_empty() || categories.iter().any(|c| &c.category == group) {
            continue;
        }
        if renamed_away(names, &cloned) {
            continue;
        }
        categories.push(CategoryInfo {
            category: group.clone(),
            label: group.clone(),
            present: crate::paths::category_dir(&root, group).is_dir(),
            repo_count: 0,
            declared_count: names.len() as u32,
        });
    }

    // Before the struct literal, which moves `cfg`.
    let tracked = tracked_package(&root, &cfg).map(|t| t.name);

    let mut warnings = tc.warnings.clone();
    let has_workspace = crate::paths::is_workspace(&root);
    if has_workspace && !crate::paths::scripts_dir(&root).is_dir() {
        warnings.push("no scripts/ directory found in this workspace.".into());
    }

    Ok(Bootstrap {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        tools_ready: state.tools_ready(),
        has_workspace,
        recent_roots: state
            .config()
            .recent_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
        categories,
        repos,
        config: cfg,
        tools: tc.to_infos(),
        package_manager: tc.preferred_package_manager().map(str::to_string),
        editors: crate::toolchain::detect_editors(&tc.path_env),
        agents: crate::toolchain::detect_agents(&tc.path_env),
        scripts: crate::scripts::discover(&root),
        tracked_package: tracked,
        home_dir: dirs_home(),
        os: std::env::consts::OS.to_string(),
        workspace_root: root,
        warnings,
        // A clone of the cached snapshot. Computing it here would put a `git config`
        // pair and an ssh-agent probe on every invalidation of this query.
        readiness: state.readiness(),
        onboarding_completed: onboarding_completed(&state.config()),
    })
}

/// Set by `complete_onboarding`, and only read while the force flag is on.
///
/// Without it, `WORK_ALLEY_ONBOARDING=force` made the screen it exists to show
/// impossible to leave: Done wrote the config, the next bootstrap reported "never
/// done" regardless, and the takeover came straight back. A reviewer cannot check
/// the *exit* from a screen they cannot exit.
///
/// Process-wide rather than on `AppState`: it deliberately does not survive a
/// relaunch, which is what makes the flag still mean "show me first-run again".
static ONBOARDING_DISMISSED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Whether first-run onboarding is over.
///
/// `WORK_ALLEY_ONBOARDING=force` reports it as never done, which is the only practical
/// way to review the first-run path on a machine that is already set up. Read on every
/// call rather than cached, so it can be toggled without a rebuild.
fn onboarding_completed(cfg: &crate::config::Config) -> bool {
    let forced = std::env::var("WORK_ALLEY_ONBOARDING").as_deref() == Ok("force");
    onboarding_state(
        forced,
        ONBOARDING_DISMISSED.load(std::sync::atomic::Ordering::Relaxed),
        cfg.onboarding_done_unix.is_some(),
    )
}

/// The rule above, without the environment or the config — so it is testable.
fn onboarding_state(forced: bool, dismissed_this_run: bool, saved: bool) -> bool {
    if forced {
        return dismissed_this_run;
    }
    saved
}

// The user's home directory, for abbreviating paths in the UI. Lives in
// `platform` because Windows keeps it in USERPROFILE, not HOME.
use crate::platform::home_dir as dirs_home;
use crate::platform::Shell;

/// The workspace's shared package, whose version drift is worth a column.
///
/// Detected, not configured. Reads every repo's `package.json` once — the same
/// order of work as the discovery walk that just ran — and picks the locally
/// published package the most repos consume. `config.tracked_package` pins it for
/// the rare workspace where the automatic choice is wrong.
pub(crate) fn tracked_package(root: &std::path::Path, cfg: &Config) -> Option<crate::pkg::TrackedPackage> {
    let manifests: Vec<crate::pkg::Manifest> = crate::paths::discover_all(root)
        .into_iter()
        .filter_map(|(_, path)| crate::pkg::read_manifest(&path))
        .collect();

    match &cfg.tracked_package {
        Some(pinned) => Some(crate::pkg::TrackedPackage {
            name: pinned.clone(),
            published: manifests
                .iter()
                .find(|m| m.name.as_deref() == Some(pinned.as_str()))
                .and_then(|m| m.version.clone()),
            dependents: manifests
                .iter()
                .filter(|m| m.deps.iter().any(|d| d == pinned))
                .count(),
        }),
        None => crate::pkg::pick_tracked(&manifests),
    }
}

/// Per-group counts from repos.json, when the workspace has one.
///
/// Any top-level key whose value is an array of objects with a `name` is treated
/// as a group, so this works for a repos.json with different group names.
/// Whether a declared category has simply moved.
///
/// Every repo it names is cloned somewhere else in this workspace, so the folder
/// was renamed or reorganised and repos.json is describing a layout that no longer
/// exists. Conservative by construction — one repo still missing and this is a
/// folder you have genuinely not finished cloning, which is worth a row.
fn renamed_away(names: &[String], cloned: &std::collections::HashSet<&str>) -> bool {
    !names.is_empty() && names.iter().all(|n| cloned.contains(n.as_str()))
}

/// The repo *names* repos.json declares, per category.
///
/// Names rather than a count, because a count cannot tell "you have not cloned
/// these yet" from "you renamed the folder they were in" — and the rail showed both
/// as `0 / 38`. See the declared-only loop in `build_bootstrap`.
fn declared_repos(root: &std::path::Path) -> std::collections::BTreeMap<String, Vec<String>> {
    let mut out = std::collections::BTreeMap::new();
    let Ok(text) = std::fs::read_to_string(root.join("repos.json")) else {
        return out;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return out;
    };
    let Some(obj) = json.as_object() else {
        return out;
    };

    for (key, value) in obj {
        if let Some(arr) = value.as_array() {
            let looks_like_repos = arr
                .iter()
                .all(|v| v.get("name").and_then(|n| n.as_str()).is_some());
            if looks_like_repos && !arr.is_empty() {
                let names: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.get("name")?.as_str().map(str::to_string))
                    .collect();
                out.insert(key.clone(), names);
            }
        }
    }
    out
}

#[tauri::command]
pub async fn get_config(state: State<'_, Arc<AppState>>) -> AppResult<Config> {
    Ok(state.config())
}

#[tauri::command]
pub async fn set_config(
    patch: ConfigPatch,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Config> {
    let mut cfg = state.config();
    patch.apply(&mut cfg);
    let _ = cfg.save(&state.app_dir());
    state.set_config(cfg.clone());
    Ok(cfg)
}

/// What one runnable task would execute, and whatever overrides it.
///
/// Read-only, and deliberately not `prepare_action` despite that returning an
/// `argvPreview`: preparing parks a single-use intent that then has to be
/// cancelled, it refuses with `DevAlreadyRunning` for a task that is up — which is
/// exactly when you want to edit its command — and it returns the *override* when
/// one exists, so it could never show the baseline being overridden.
#[tauri::command]
pub async fn preview_run_command(
    repo: RepoRef,
    task: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<RunCommandPreview> {
    let root = state.workspace_root();
    let cwd = crate::paths::resolve_repo(&root, &repo)?;
    let key = repo.key();
    let tc = state.toolchain();

    // The same closed-set gate DevStart applies: only a task this repo actually
    // offers can be previewed, let alone overridden.
    let spec = crate::runner::find(&cwd, &task)
        .ok_or_else(|| AppError::Invalid(format!("{key} has no \"{task}\" task")))?;
    let task_key = crate::state::task_key(&key, &task);

    Ok(RunCommandPreview {
        task_key: task_key.clone(),
        label: spec.label.clone(),
        default_argv: crate::runner::argv(&cwd, &spec, &tc)?,
        override_argv: state.config().dev_command_overrides.get(&task_key).cloned(),
        cwd,
    })
}

/// Sets or clears the command one task runs. `None` or an empty argv clears it.
///
/// Targeted rather than a `set_config` whole-map patch: the read-modify-write
/// happens here, against the config the backend owns, so a frontend holding a
/// stale snapshot cannot clobber a key it never saw.
///
/// The *task* is validated; the argv deliberately is not, and cannot be — being
/// able to run something the detector would not choose is the entire feature. It
/// reaches the child as a vector, never through a shell, so a quote in it is just
/// a quote.
#[tauri::command]
pub async fn set_run_command(
    repo: RepoRef,
    task: String,
    argv: Option<Vec<String>>,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Config> {
    let root = state.workspace_root();
    let cwd = crate::paths::resolve_repo(&root, &repo)?;
    let key = repo.key();

    if crate::runner::find(&cwd, &task).is_none() {
        return Err(AppError::Invalid(format!("{key} has no \"{task}\" task")));
    }
    let task_key = crate::state::task_key(&key, &task);

    let mut cfg = state.config();
    match argv {
        Some(v) if !v.is_empty() => {
            cfg.dev_command_overrides.insert(task_key, v);
        }
        _ => {
            cfg.dev_command_overrides.remove(&task_key);
        }
    }
    let _ = cfg.save(&state.app_dir());
    state.set_config(cfg.clone());
    Ok(cfg)
}

/// Opens a native folder picker and switches to the chosen workspace.
///
/// Returns None when the user cancels — cancelling is not an error.
#[tauri::command]
pub async fn pick_workspace(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Option<Bootstrap>> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Choose a workspace folder");
    if let Some(start) = picker_start_dir(state.inner()) {
        dialog = dialog.set_directory(&start);
    }
    dialog.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });

    let Ok(Some(folder)) = rx.await else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| AppError::Invalid(e.to_string()))?;

    switch_workspace(&app, state.inner(), path).await.map(Some)
}

/// Where the folder picker should open.
///
/// The *parent* of the current workspace, so its siblings are immediately
/// visible — that is almost always where the next workspace lives. Falls back to
/// the most recent workspace's parent, and only then to the home directory, since
/// landing on a bare `~` means scrolling past every dotfolder to find anything.
fn picker_start_dir(state: &Arc<AppState>) -> Option<PathBuf> {
    // Collect first: config() returns a guard-free clone, but the iterator would
    // otherwise borrow a temporary.
    let mut candidates = vec![state.workspace_root()];
    candidates.extend(state.config().recent_roots.iter().cloned());

    for root in candidates {
        if root.as_os_str().is_empty() {
            continue;
        }
        if let Some(parent) = root.parent() {
            // `parent.parent().is_some()` rather than a comparison against "/":
            // it rejects a filesystem root on both platforms, where the literal
            // would miss `C:\`.
            if parent.is_dir() && parent.parent().is_some() {
                return Some(parent.to_path_buf());
            }
        }
    }

    // Prefer a common projects directory over the bare home folder.
    let home = crate::platform::home_dir()?;
    for guess in ["Projects", "projects", "dev", "Developer", "code", "src", "work"] {
        let p = home.join(guess);
        if p.is_dir() {
            return Some(p);
        }
    }
    Some(home)
}

/// Switches to an already-known path, e.g. from the recents list.
#[tauri::command]
pub async fn set_workspace(
    path: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Bootstrap> {
    switch_workspace(&app, state.inner(), PathBuf::from(path)).await
}

/// Closes the open workspace, returning to the first-run picker.
///
/// Deliberately does not forget the folder: it stays at the top of the recents
/// list, because "close" means "stop looking at this", not "forget it existed".
#[tauri::command]
pub async fn close_workspace(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Bootstrap> {
    // An empty root is the same state as first run, so every "no workspace" path
    // in the UI already handles it.
    state.set_workspace_root(PathBuf::new());
    // Persisted, not just held in memory. `set_workspace_root` zeroes the in-memory
    // config's root, so the next `set_config` — changing any unrelated number —
    // would write that empty root to disk anyway. Saving here makes it deliberate:
    // "I closed it, so there is nothing to reopen", which is exactly what the
    // reopen-on-launch flag should see. `recent_roots` is untouched, so the folder
    // is still offered on the welcome screen.
    let _ = state.config().save(&state.app_dir());
    let _ = app.emit(events::WORKSPACE_CHANGED, ());
    build_bootstrap(state.inner()).await
}

/// Drops one folder from the recents list.
///
/// The list only ever grew: a workspace opened once by mistake, or one that has
/// since been deleted, stayed on the launcher forever with no way to remove it
/// short of editing config.json. Nothing on disk is touched — this forgets a path,
/// it does not delete a folder — and the open workspace is deliberately allowed:
/// closing it is a separate action, and "stop offering this" is a fair thing to
/// want about a folder you are in.
#[tauri::command]
pub async fn forget_recent_root(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Bootstrap> {
    let mut cfg = state.config();
    if cfg.forget_root(std::path::Path::new(&path)) {
        let _ = cfg.save(&state.app_dir());
        state.set_config(cfg);
    }
    build_bootstrap(state.inner()).await
}

/// Opens a folder picker without switching to it.
///
/// Used when setting up a new workspace: the folder is usually empty at that
/// point, so it is not yet a workspace and `pick_workspace` would reject it.
#[tauri::command]
pub async fn pick_folder(app: AppHandle, state: State<'_, Arc<AppState>>) -> AppResult<Option<FolderPick>> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose a folder for the new workspace");
    if let Some(start) = picker_start_dir(state.inner()) {
        dialog = dialog.set_directory(&start);
    }
    dialog.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });

    let Ok(Some(folder)) = rx.await else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| AppError::Invalid(e.to_string()))?;

    // Reported, not enforced: cloning into a folder that already has things in it
    // is allowed, but the user should know before confirming.
    let existing = std::fs::read_dir(&path)
        .map(|it| {
            it.filter_map(Result::ok)
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .count()
        })
        .unwrap_or(0);

    Ok(Some(FolderPick {
        path: path.display().to_string(),
        entry_count: existing as u32,
    }))
}

/// Validates pasted git URLs. Read-only, so the UI can call it as the user types.
#[tauri::command]
pub async fn parse_clone_urls(text: String) -> AppResult<crate::clone::ParsedUrls> {
    Ok(crate::clone::parse_repo_urls(&text))
}

async fn switch_workspace(
    app: &AppHandle,
    state: &Arc<AppState>,
    path: PathBuf,
) -> AppResult<Bootstrap> {
    let path = path
        .canonicalize()
        .map_err(|e| AppError::WorkspaceNotFound(format!("{}: {e}", path.display())))?;

    if !crate::paths::is_workspace(&path) {
        return Err(AppError::WorkspaceNotFound(format!(
            "no git repository found in {}. Choose a folder that is a repo, contains \
             repos, or groups them in subfolders.",
            path.display()
        )));
    }

    state.set_workspace_root(path.clone());

    let mut cfg = state.config();
    cfg.remember_root(path);
    let _ = cfg.save(&state.app_dir());
    state.set_config(cfg);

    // Everything scoped to the old workspace is gone; tell the UI to start over.
    let _ = app.emit(events::WORKSPACE_CHANGED, ());

    build_bootstrap(state).await
}

// --------------------------------------------------------------------- scan --

#[tauri::command]
pub async fn start_scan(
    opts: Option<ScanOptions>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<String> {
    let opts = opts.unwrap_or_default();
    let st = state.inner().clone();
    let scan_id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    st.scan_cancel
        .lock()
        .unwrap()
        .insert(scan_id.clone(), cancel.clone());

    let id = scan_id.clone();
    tauri::async_runtime::spawn(async move {
        run_scan(app, st, id, opts, cancel).await;
    });

    Ok(scan_id)
}

#[tauri::command]
pub async fn cancel_scan(scan_id: String, state: State<'_, Arc<AppState>>) -> AppResult<()> {
    if let Some(c) = state.scan_cancel.lock().unwrap().get(&scan_id) {
        c.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_last_scan(
    state: State<'_, Arc<AppState>>,
) -> AppResult<Option<WorkspaceSnapshot>> {
    Ok(state.last_scan.read().unwrap().clone())
}

#[tauri::command]
pub async fn rescan_repo(
    repo: RepoRef,
    state: State<'_, Arc<AppState>>,
) -> AppResult<RepoStatus> {
    let root = state.workspace_root();
    let cfg = state.config();
    let git = state.toolchain().require("git")?;
    let path = crate::paths::resolve_repo(&root, &repo)?;

    let tracked = tracked_package(&root, &cfg).map(|t| t.name);
    let mut status =
        crate::git::scan_one(git, repo.clone(), path, cfg.stale_days, tracked).await;
    status.tasks = state.dev_servers_for_repo(&repo.key());
    Ok(status)
}

async fn run_scan(
    app: AppHandle,
    state: Arc<AppState>,
    scan_id: String,
    opts: ScanOptions,
    cancel: Arc<AtomicBool>,
) {
    let began = Instant::now();
    let started_unix = crate::git::now_unix();
    let root = state.workspace_root();
    let cfg = state.config();
    let categories = crate::git::categories_or_all(opts.categories.clone(), &root);

    let Ok(git) = state.toolchain().require("git") else {
        let _ = app.emit(
            events::SCAN_ERROR,
            serde_json::json!({ "scanId": scan_id, "message": "git is not available" }),
        );
        return;
    };

    // Detected from the whole workspace, not just the categories being scanned —
    // the shared library often lives in a group the user is not looking at.
    let tracked = tracked_package(&root, &cfg);

    let found = crate::paths::discover_repos(&root, &categories);
    let total = found.len();
    log::info!("scan {scan_id}: starting, {total} repos");

    let _ = app.emit(
        events::SCAN_STARTED,
        events::ScanStarted {
            scan_id: scan_id.clone(),
            total,
            categories: categories.clone(),
        },
    );

    let sem = Arc::new(tokio::sync::Semaphore::new(cfg.scan_concurrency.max(1)));
    let mut set = tokio::task::JoinSet::new();

    for (repo, path) in found.clone() {
        let permit = sem.clone();
        let git = git.clone();
        let stale_days = cfg.stale_days;
        let tracked_name = tracked.as_ref().map(|t| t.name.clone());
        let repo_for_err = repo.clone();
        let path_for_err = path.clone();

        set.spawn(async move {
            let _p = permit.acquire_owned().await;
            // scan_one never returns Err — a failure lands in RepoStatus::error.
            let r = crate::git::scan_one(git, repo, path, stale_days, tracked_name).await;
            (repo_for_err, path_for_err, r)
        });
    }

    let mut repos: Vec<RepoStatus> = Vec::with_capacity(total);
    let mut error_count = 0u32;

    while let Some(joined) = set.join_next().await {
        if cancel.load(Ordering::Relaxed) {
            set.abort_all();
            break;
        }

        let mut status = match joined {
            Ok((_, _, s)) => s,
            // A panic in one task must not lose the whole scan either.
            Err(e) => {
                let msg = format!("scan task failed: {e}");
                log::error!("{msg}");
                error_count += 1;
                continue;
            }
        };

        status.tasks = state.dev_servers_for_repo(&status.repo.key());
        if status.error.is_some() {
            error_count += 1;
        }

        let _ = app.emit(
            events::SCAN_REPO,
            events::ScanRepo {
                scan_id: scan_id.clone(),
                repo: status.clone(),
            },
        );
        repos.push(status);
    }

    log::info!("scan {scan_id}: {} repos scanned, now commits", repos.len());
    // Sort into a stable order for the snapshot; the UI keeps its own ordering.
    repos.sort_by_key(|r| r.repo.key());

    // --- shared-package drift baseline ---------------------------------------
    // "Latest" is the newest version seen anywhere: the library repo's own
    // version when it is cloned here, otherwise the highest version any repo
    // declares. Both are discovered, so this works in any workspace.
    let mut candidates: Vec<String> = repos
        .iter()
        .filter_map(|r| r.tracked_dep.resolved.clone())
        .collect();
    let published = tracked.as_ref().and_then(|t| t.published.clone());
    let mut tracked_latest_source = None;
    if let Some(p) = published.clone() {
        if let Some(cleaned) = crate::pkg::clean_version(&p) {
            candidates.push(cleaned);
        }
    }
    let tracked_latest = crate::pkg::max_version(candidates);
    if tracked_latest.is_some() {
        tracked_latest_source = Some(
            if published.as_deref().and_then(crate::pkg::clean_version).as_deref()
                == tracked_latest.as_deref()
            {
                "published".to_string()
            } else {
                "declared".to_string()
            },
        );
    }

    // --- recent commits -------------------------------------------------------
    let mut commits: Vec<CommitEntry> = Vec::new();
    if opts.include_commits.unwrap_or(true) && !cancel.load(Ordering::Relaxed) {
        let limit = opts.commit_limit.unwrap_or(cfg.recent_commit_limit);
        let sem = Arc::new(tokio::sync::Semaphore::new(cfg.scan_concurrency.max(1)));
        let mut set = tokio::task::JoinSet::new();
        for (repo, path) in found {
            let permit = sem.clone();
            let git = git.clone();
            set.spawn(async move {
                let _p = permit.acquire_owned().await;
                crate::git::recent_for(&git, &repo, &path, limit).await
            });
        }
        while let Some(Ok(mut batch)) = set.join_next().await {
            commits.append(&mut batch);
        }
        commits.sort_by(|a, b| b.unix.cmp(&a.unix));
        commits.truncate(limit as usize);

        let _ = app.emit(
            events::SCAN_COMMITS,
            events::ScanCommits {
                scan_id: scan_id.clone(),
                commits: commits.clone(),
            },
        );
    }

    let snapshot = WorkspaceSnapshot {
        scan_id: scan_id.clone(),
        started_unix,
        finished_unix: Some(crate::git::now_unix()),
        ok_count: repos.len() as u32 - error_count.min(repos.len() as u32),
        error_count,
        repos,
        commits,
        tracked_latest,
        tracked_latest_source,
        duration_ms: began.elapsed().as_millis() as u64,
    };

    log::info!(
        "scan {scan_id}: finished in {}ms, {} commits",
        snapshot.duration_ms,
        snapshot.commits.len()
    );
    *state.last_scan.write().unwrap() = Some(snapshot.clone());
    state.scan_cancel.lock().unwrap().remove(&scan_id);

    let _ = app.emit(
        events::SCAN_FINISHED,
        events::ScanFinished { scan_id, snapshot },
    );
}

#[tauri::command]
pub async fn recent_commits(
    limit: Option<u32>,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<CommitEntry>> {
    let cfg = state.config();
    let limit = limit.unwrap_or(cfg.recent_commit_limit);
    if let Some(snap) = state.last_scan.read().unwrap().as_ref() {
        return Ok(snap.commits.iter().take(limit as usize).cloned().collect());
    }
    Ok(Vec::new())
}

// ------------------------------------------------------------------- docker --

#[tauri::command]
pub async fn docker_status(state: State<'_, Arc<AppState>>) -> AppResult<DockerStatus> {
    // Never Err: "not installed" and "daemon down" are states to render.
    Ok(crate::docker::status(&state.toolchain()).await)
}

// ---------------------------------------------------------------------- dev --

#[tauri::command]
pub async fn list_dev_servers(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<DevServer>> {
    // Re-seed against reality first. This is what the frontend calls on connect, so
    // it is exactly the moment a row left behind by a previous webview's supervisor
    // would otherwise be handed back as though it were live.
    crate::devwatch::sweep(&app, state.inner()).await;
    Ok(state.dev_servers())
}

/// Clears a finished dev row.
///
/// A plain command rather than an `ActionSpec`, for the same reason `dismiss_run`
/// is one: it touches no process and no disk. It refuses while a run is still live
/// — the button for that is Stop, and hiding a running server is how you lose one.
/// `task: None` clears every finished row for the repo.
#[tauri::command]
pub async fn forget_dev(
    repo: RepoRef,
    task: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<()> {
    let key = repo.key();
    let targets: Vec<String> = match task {
        Some(t) => vec![crate::state::task_key(&key, &t)],
        None => state
            .dev_servers_for_repo(&key)
            .into_iter()
            .map(|s| crate::state::task_key(&key, &s.task))
            .collect(),
    };

    let mut cleared = false;
    for tkey in targets {
        if state.live_dev_run(&tkey).is_some() {
            continue;
        }
        state.remove_dev(&tkey);
        cleared = true;
    }
    if cleared {
        let _ = app.emit(
            events::DEV_CHANGED,
            events::DevChanged {
                servers: state.dev_servers(),
            },
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn list_branches(
    repo: RepoRef,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<BranchInfo>> {
    crate::git::list_branches(state.inner(), &repo)
        .await
        .map_err(AppError::Invalid)
}

/// The stash, as data. Read-only.
#[tauri::command]
pub async fn list_stashes(
    repo: RepoRef,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<StashEntry>> {
    crate::git::list_stashes(state.inner(), &repo)
        .await
        .map_err(AppError::Invalid)
}

// ------------------------------------------------------------------- runs ----

#[tauri::command]
pub async fn list_runs(state: State<'_, Arc<AppState>>) -> AppResult<Vec<RunSummary>> {
    let mut v: Vec<RunSummary> = state
        .all_runs()
        .iter()
        .map(|h| h.summary.lock().unwrap().clone())
        .collect();
    v.sort_by_key(|s| s.started_unix);
    Ok(v)
}

#[tauri::command]
pub async fn get_run_log(
    run_id: String,
    from_seq: Option<u64>,
    state: State<'_, Arc<AppState>>,
) -> AppResult<RunLogPage> {
    let handle = state
        .run(&run_id)
        .ok_or_else(|| AppError::RunUnknown(run_id.clone()))?;
    let from = from_seq.unwrap_or(0);

    let (lines, truncated) = {
        let log = handle.log.lock().unwrap();
        let lines: Vec<LogLine> = log.iter().filter(|l| l.seq >= from).cloned().collect();
        let truncated = handle.summary.lock().unwrap().truncated;
        (lines, truncated)
    };
    let next_seq = lines.last().map(|l| l.seq + 1).unwrap_or(from);
    let status = handle.summary.lock().unwrap().status.clone();

    Ok(RunLogPage {
        lines,
        next_seq,
        truncated,
        status,
    })
}

#[tauri::command]
pub async fn cancel_run(run_id: String, state: State<'_, Arc<AppState>>) -> AppResult<()> {
    procs::cancel_run(state.inner(), &run_id)
}

#[tauri::command]
pub async fn dismiss_run(
    run_id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<()> {
    let still_running = state
        .run(&run_id)
        .map(|h| matches!(h.summary.lock().unwrap().status, RunStatus::Running))
        .unwrap_or(false);
    if still_running {
        return Err(AppError::Invalid(
            "this run is still going — cancel it first".into(),
        ));
    }
    state.runs.lock().unwrap().remove(&run_id);

    // A dev row points at this run, and dismissing the log while leaving the red
    // row behind means the crash is still on screen with nothing left to read.
    let orphan: Option<String> = state
        .dev_servers()
        .into_iter()
        .find(|d| d.run_id == run_id)
        .map(|d| crate::state::task_key(&d.repo.key(), &d.task))
        .filter(|k| state.live_dev_run(k).is_none());
    if let Some(key) = orphan {
        state.remove_dev(&key);
        let _ = app.emit(
            events::DEV_CHANGED,
            events::DevChanged {
                servers: state.dev_servers(),
            },
        );
    }
    Ok(())
}

// ----------------------------------------------------------------- actions ---

/// Phase 1 of the gate. Has **no side effects**: it resolves the exact argv, runs
/// a read-only preflight, and parks the result behind a single-use id.
#[tauri::command]
pub async fn prepare_action(
    spec: ActionSpec,
    state: State<'_, Arc<AppState>>,
) -> AppResult<ActionIntent> {
    let st = state.inner().clone();
    let built = build_action(&st, spec).await?;

    let id = uuid::Uuid::new_v4().to_string();
    let expires_unix = crate::git::now_unix() + INTENT_TTL.as_secs() as i64;

    let per_target = built.preview.is_some();
    let intent = ActionIntent {
        id: id.clone(),
        kind: built.kind.clone(),
        title: built.title.clone(),
        description: built.description.clone(),
        argv_preview: built.preview.clone().unwrap_or_else(|| built.argv.clone()),
        per_target,
        full_argv: if per_target {
            Some(built.argv.clone())
        } else {
            None
        },
        cwd: built.cwd.clone(),
        danger: built.danger,
        warnings: built.warnings.clone(),
        requires_typed_confirm: built.typed_confirm.clone(),
        expires_unix,
        targets: built.targets.clone(),
        read_only: built.read_only,
    };

    st.intents.lock().unwrap().insert(
        id,
        PendingIntent {
            intent: intent.clone(),
            argv: built.argv,
            cwd: built.cwd,
            env: built.env,
            kind: built.kind,
            repo: built.repo,
            targets: built.targets,
            expires_at: Instant::now() + INTENT_TTL,
            typed_confirm: built.typed_confirm,
            danger: built.danger,
            task: built.task,
            size: built.size,
        },
    );

    Ok(intent)
}

/// Phase 2. Takes **only** the opaque id — there is no argv, cwd, repo or flag
/// parameter a frontend bug could use to change what executes.
#[tauri::command]
pub async fn run_action(
    intent_id: String,
    typed_confirm: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<String> {
    // remove(), not get(): single use, so a double-clicked button cannot pull twice.
    let pending = state
        .intents
        .lock()
        .unwrap()
        .remove(&intent_id)
        .ok_or(AppError::IntentUnknown)?;

    crate::gate::check_expiry(pending.expires_at, Instant::now())?;
    crate::gate::check_typed_confirm(
        pending.typed_confirm.as_deref(),
        typed_confirm.as_deref(),
    )?;

    match pending.kind.as_str() {
        "devStop" => {
            let repo = pending.repo.clone().ok_or(AppError::IntentUnknown)?;
            let task = pending.task.clone().unwrap_or_else(|| "dev".to_string());
            let tkey = crate::state::task_key(&repo.key(), &task);
            // The run has to still be *running*, not merely registered. Cancelling a
            // run that already finished is how a row used to park on "exiting"
            // forever: `finish` cannot fire a second time, so nothing would ever
            // clear the state this line sets.
            let live = state.live_dev_run(&tkey).filter(|rid| {
                state
                    .run(rid)
                    .map(|h| matches!(h.summary.lock().unwrap().status, RunStatus::Running))
                    .unwrap_or(false)
            });
            let Some(run_id) = live else {
                // Already gone. Clearing the row is the honest answer to "stop it".
                state.remove_dev(&tkey);
                let _ = app.emit(
                    events::DEV_CHANGED,
                    events::DevChanged {
                        servers: state.dev_servers(),
                    },
                );
                return Ok(String::new());
            };
            state.patch_dev(&tkey, |d| d.state = DevState::Stopping);
            let _ = app.emit(
                events::DEV_CHANGED,
                events::DevChanged {
                    servers: state.dev_servers(),
                },
            );
            procs::cancel_run(state.inner(), &run_id)?;
            Ok(run_id)
        }
        // The integrated terminal. This is the *only* path to `pty::open`, which
        // is what keeps a free-form shell inside the gate: the argv was built in
        // Rust from the closed ActionSpec enum, not supplied by the caller. See
        // the module doc in pty.rs.
        //
        // `termPackage` joins them: a Toolbox or setup-page operation is exactly
        // what a pty is for. Root installs need a tty to prompt for a password —
        // that used to mean throwing the command at whatever terminal emulator the
        // machine had — and the unprivileged ones were streaming into an output
        // pane that neither of those full-window pages even renders, so their
        // output was invisible.
        "termShell" | "termScript" | "termPackage" => {
            let size = pending.size.unwrap_or(TermSize {
                cols: crate::pty::DEFAULT_COLS,
                rows: crate::pty::DEFAULT_ROWS,
            });
            let info = crate::pty::open(
                &app,
                state.inner(),
                crate::pty::OpenSpec {
                    kind: match pending.kind.as_str() {
                        "termShell" => "shell".into(),
                        "termPackage" => "package".into(),
                        _ => "script".into(),
                    },
                    argv: pending.argv,
                    cwd: pending.cwd,
                    env: pending.env,
                    login_shell: pending.kind == "termShell",
                    title: pending.intent.title.clone(),
                    repo: pending.repo.clone(),
                    cols: size.cols,
                    rows: size.rows,
                },
            )?;
            // A term id, not a run id. Harmless: callers learn about the new tab
            // from `term:opened`, exactly as they learn about a run from
            // `run:started` rather than from this return value.
            Ok(info.term_id)
        }
        // Reached only when the caller asked for `external: true`.
        "openShell" => {
            procs::open_shell(&app, &state.toolchain(), &pending.cwd)?;
            Ok(String::new())
        }
        "openInTerminal" => {
            procs::open_terminal(&app, &state.toolchain(), &pending.cwd, &pending.argv)?;
            Ok(String::new())
        }
        "openInEditor" => {
            // Detached: a GUI editor outlives this app, and streaming its output
            // into the run pane would be noise.
            procs::spawn_detached(&state.toolchain(), &pending.cwd, &pending.argv)?;
            Ok(String::new())
        }
        kind => {
            // The keys the emitter may attribute lines to. Previously this was a
            // single string taken from `pending.repo` and only when
            // `targets.len() > 1` — a condition no run can satisfy, since every bulk
            // builder leaves `repo` unset. So the field was always None and the
            // frontend's repo prefix was dead code.
            let target_keys: Vec<String> = pending.targets.iter().map(|r| r.key()).collect();
            let run_id = procs::spawn_run(
                &app,
                SpawnSpec {
                    // The dialog's preview, when there is one: it is the per-repo
                    // command, and `per_target` says how many repos it runs in.
                    header: if pending.intent.per_target {
                        Some(format!(
                            "{}   (in {} repos)",
                            crate::procs::shell_join(&pending.intent.argv_preview),
                            pending.intent.targets.len()
                        ))
                    } else {
                        None
                    },
                    argv: pending.argv,
                    cwd: pending.cwd,
                    env: pending.env,
                    kind: kind.to_string(),
                    title: pending.intent.title.clone(),
                    repo: pending.repo.clone(),
                    targets: pending.targets.clone(),
                    dev_key: if kind == "devStart" {
                        pending.repo.as_ref().map(|r| {
                            crate::state::task_key(
                                &r.key(),
                                pending.task.as_deref().unwrap_or("dev"),
                            )
                        })
                    } else {
                        None
                    },
                    target_keys,
                },
            )?;

            if kind == "devStart" {
                if let Some(repo) = pending.repo.clone() {
                    let task = pending.task.clone().unwrap_or_else(|| "dev".to_string());
                    register_dev(&app, state.inner(), repo, task, &run_id).await;
                }
            }

            Ok(run_id)
        }
    }
}

#[tauri::command]
pub async fn cancel_action(intent_id: String, state: State<'_, Arc<AppState>>) -> AppResult<()> {
    state.intents.lock().unwrap().remove(&intent_id);
    Ok(())
}

// ------------------------------------------------------------------ terminal --
//
// Thin wrappers; all the logic is in pty.rs, the same way `cancel_run` delegates
// to `procs`. Note what is *not* here: there is no command that opens a terminal.
// A session can only be created by `run_action` dispatching a termShell/termScript
// intent, so the argv is never caller-supplied. See the module doc in pty.rs.

#[tauri::command]
pub async fn term_write(
    term_id: String,
    data: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<()> {
    crate::pty::write(state.inner(), &term_id, &data)
}

#[tauri::command]
pub async fn term_resize(
    term_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, Arc<AppState>>,
) -> AppResult<()> {
    crate::pty::resize(state.inner(), &term_id, cols, rows)
}

#[tauri::command]
pub async fn term_close(term_id: String, state: State<'_, Arc<AppState>>) -> AppResult<()> {
    crate::pty::close(state.inner(), &term_id)
}

#[tauri::command]
pub async fn term_list(state: State<'_, Arc<AppState>>) -> AppResult<Vec<crate::pty::TermInfo>> {
    Ok(crate::pty::list(state.inner()))
}

/// Base64 of everything the session has printed, for restoring a tab after a
/// webview reload.
#[tauri::command]
pub async fn term_scrollback(
    term_id: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<String> {
    crate::pty::scrollback(state.inner(), &term_id)
}

async fn register_dev(
    app: &AppHandle,
    state: &Arc<AppState>,
    repo: RepoRef,
    task: String,
    run_id: &str,
) {
    let root = state.workspace_root();
    let cfg = state.config();
    let key = repo.key();
    let tkey = crate::state::task_key(&key, &task);
    let path = crate::paths::repo_path(&root, &repo);

    let (port, source) = cfg
        .port_overrides
        .get(&tkey)
        .map(|p| (Some(*p), Some(PortSource::ConfigOverride)))
        // Whatever `runner` derived for this task, carrying its own source — the
        // authoritative port still arrives later by sniffing the output.
        .unwrap_or_else(|| match crate::runner::find(&path, &task).and_then(|t| t.port) {
            Some((p, source)) => (Some(p), Some(source)),
            None => (None, None),
        });

    let (pid, argv) = state
        .run(run_id)
        .map(|h| {
            let s = h.summary.lock().unwrap();
            (0u32, s.argv.clone())
        })
        .unwrap_or((0, Vec::new()));

    state.upsert_dev(DevServer {
        repo: repo.clone(),
        task: task.clone(),
        run_id: run_id.to_string(),
        pid,
        command: argv,
        port,
        port_source: source,
        state: DevState::Starting,
        url: port.map(|p| format!("http://localhost:{p}")),
        started_unix: crate::git::now_unix(),
    });

    let _ = app.emit(
        events::DEV_CHANGED,
        events::DevChanged {
            servers: state.dev_servers(),
        },
    );

    // Watchdog: sniffing vite's "Local: http://localhost:NNNN/" banner is the
    // primary signal, but the banner is printed once and the emitter task can
    // reach it before this entry exists — in which case it is lost and the card
    // would sit on "starting" forever. Polling the port closes that hole, and also
    // covers dev servers that print no such banner at all.
    if let Some(p) = port {
        let app2 = app.clone();
        let st = state.clone();
        let key = tkey.clone();
        let rid = run_id.to_string();
        tauri::async_runtime::spawn(async move {
            for _ in 0..120 {
                tokio::time::sleep(Duration::from_millis(500)).await;

                // Stop if this run ended or was replaced.
                match st.dev_server_for(&key) {
                    Some(d) if d.run_id == rid => {
                        if d.state == DevState::Up {
                            return;
                        }
                    }
                    _ => return,
                }

                if procs::port_in_use(p).await {
                    st.patch_dev(&key, |d| {
                        d.state = DevState::Up;
                        d.url = Some(format!("http://localhost:{p}"));
                    });
                    let _ = app2.emit(
                        events::DEV_CHANGED,
                        events::DevChanged {
                            servers: st.dev_servers(),
                        },
                    );
                    return;
                }
            }
        });
    }
}

// --- action construction ----------------------------------------------------

struct Built {
    kind: String,
    task: Option<String>,
    /// Representative per-repo command for bulk actions. None => argv is shown.
    preview: Option<Vec<String>>,
    title: String,
    description: String,
    argv: Vec<String>,
    cwd: PathBuf,
    env: Vec<(String, String)>,
    danger: Danger,
    warnings: Vec<String>,
    typed_confirm: Option<String>,
    repo: Option<RepoRef>,
    targets: Vec<RepoRef>,
    read_only: bool,
    /// Initial PTY geometry. Only ever Some for termShell/termScript.
    size: Option<TermSize>,
}

async fn build_action(state: &Arc<AppState>, spec: ActionSpec) -> AppResult<Built> {
    let root = state.workspace_root();
    let tc = state.toolchain();
    let cfg = state.config();

    match spec {
        ActionSpec::Status { repo } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            Ok(Built {
                kind: "status".into(),
                title: format!("Status — {}", repo.key()),
                description: "Read-only.".into(),
                argv: vec![
                    git.display().to_string(),
                    "status".into(),
                    "-sb".into(),
                ],
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: true,
                size: None,
            })
        }

        ActionSpec::BranchList { repo } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            Ok(Built {
                kind: "branchList".into(),
                title: format!("Branches — {}", repo.key()),
                description: "Read-only.".into(),
                argv: vec![
                    git.display().to_string(),
                    "branch".into(),
                    "-vv".into(),
                    "--sort=-committerdate".into(),
                ],
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: true,
                size: None,
            })
        }

        ActionSpec::GhRunLog {
            repo,
            run_id,
            failed_only,
        } => {
            let (gh, cwd, slug, label) = gh_run_target(state, &root, &repo, run_id).await?;
            let mut argv = vec![
                gh.display().to_string(),
                "run".into(),
                "view".into(),
                run_id.to_string(),
                "--repo".into(),
                slug,
            ];
            argv.push(if failed_only { "--log-failed".into() } else { "--log".into() });

            Ok(Built {
                kind: "ghRunLog".into(),
                title: format!("Log — {} #{}", label.workflow, label.number),
                // Said here because gh refuses on a run that has not finished, and
                // the pane is otherwise a single confusing line.
                description: "Read-only. A run that is still going has no log yet.".into(),
                argv,
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: true,
                size: None,
            })
        }

        ActionSpec::GhRunRerun {
            repo,
            run_id,
            failed_only,
        } => {
            let (gh, cwd, slug, label) = gh_run_target(state, &root, &repo, run_id).await?;
            let mut argv = vec![
                gh.display().to_string(),
                "run".into(),
                "rerun".into(),
                run_id.to_string(),
                "--repo".into(),
                slug,
            ];
            if failed_only {
                argv.push("--failed".into());
            }

            Ok(Built {
                kind: "ghRunRerun".into(),
                title: format!(
                    "Re-run {}{} #{}",
                    if failed_only { "failed jobs of " } else { "" },
                    label.workflow,
                    label.number
                ),
                description: format!("Starts a new attempt on {}.", label.branch),
                argv,
                cwd,
                env: vec![],
                // Medium rather than a typed confirm: typed confirm is for
                // destroying local work, and making someone type a phrase to
                // re-run a flaky test teaches them to stop reading dialogs.
                danger: Danger::Medium,
                warnings: vec![
                    "This spends Actions minutes.".into(),
                    // Always, not when the name looks deployment-shaped: a
                    // heuristic that stays quiet on `release.yml` because the
                    // spelling did not match is worse than no heuristic.
                    "If this workflow deploys, re-running it will deploy again.".into(),
                ],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::GhWorkflowRun {
            repo,
            workflow,
            git_ref,
            inputs,
        } => {
            let tc = state.toolchain();
            let gh = tc.require("gh")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            let key = repo.key();

            // The same closed-set gate the run actions hold: a path this app never
            // listed for this repo is not a workflow it will start.
            let label = state.gh_workflow_label(&key, &workflow).ok_or_else(|| {
                AppError::Invalid(format!("{key} has no workflow at {workflow}"))
            })?;

            // A ref reaches gh as argv, so this is not about quoting — it is about
            // failing here, with a sentence, rather than after a network round trip
            // with git's own wording.
            if !crate::git::valid_branch_name(&git_ref) {
                return Err(AppError::Invalid(format!("not a branch or tag: {git_ref}")));
            }

            // Keys are checked against what the form declared; values are not, and
            // cannot be — arbitrary values are the whole point of an input.
            for (name, _) in &inputs {
                if !label.inputs.iter().any(|d| d == name) {
                    return Err(AppError::Invalid(format!(
                        "{} does not declare an input called \"{name}\"",
                        label.name
                    )));
                }
            }

            let git = tc.require("git")?;
            let slug = crate::git::remote_slug(&git, &cwd)
                .await
                .ok_or_else(|| AppError::Invalid("this repo has no origin remote".into()))?;

            let mut argv = vec![
                gh.display().to_string(),
                "workflow".into(),
                "run".into(),
                workflow.clone(),
                "--repo".into(),
                slug,
                "--ref".into(),
                git_ref.clone(),
            ];
            for (name, value) in &inputs {
                argv.push("-f".into());
                argv.push(format!("{name}={value}"));
            }

            Ok(Built {
                kind: "ghWorkflowRun".into(),
                title: format!("Run {} on {git_ref}", label.name),
                description: format!("Starts {} in {key} by hand.", workflow),
                argv,
                cwd,
                env: vec![],
                // Same as a re-run, and for the same reason: this spends real
                // minutes and may be the workflow that deploys.
                danger: Danger::Medium,
                warnings: vec![
                    "This spends Actions minutes.".into(),
                    "If this workflow deploys, running it will deploy.".into(),
                ],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                // The argv above is the preview, and it lists every input value —
                // which is exactly what wants reading before a deploy.
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::GhRunCancel { repo, run_id } => {
            let (gh, cwd, slug, label) = gh_run_target(state, &root, &repo, run_id).await?;

            Ok(Built {
                kind: "ghRunCancel".into(),
                title: format!("Cancel {} #{}", label.workflow, label.number),
                description: format!("Stops the run on {}.", label.branch),
                argv: vec![
                    gh.display().to_string(),
                    "run".into(),
                    "cancel".into(),
                    run_id.to_string(),
                    "--repo".into(),
                    slug,
                ],
                cwd,
                env: vec![],
                danger: Danger::Medium,
                warnings: vec![
                    "Jobs that already finished stay finished. A cancelled run cannot be \
                     resumed, only re-run."
                        .into(),
                ],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::PrList => {
            let gh = tc.require("gh")?;
            Ok(Built {
                kind: "prList".into(),
                title: "Open PRs".into(),
                description: "Read-only.".into(),
                argv: vec![
                    gh.display().to_string(),
                    "pr".into(),
                    "list".into(),
                    "--author".into(),
                    "@me".into(),
                ],
                cwd: root.clone(),
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: None,
                targets: vec![],
                preview: None,
                task: None,
                read_only: true,
                size: None,
            })
        }

        ActionSpec::SetupStep { id } => {
            // Refuse a step whose own prerequisite is missing, with the reason the page
            // already shows. Without this it failed later inside the planner with a
            // worse message — "npm is not installed" for a step whose card says, in
            // plain words, that Node has to come first.
            if let Some(reason) = crate::setup::blocked_reason(&tc, &id).await {
                return Err(AppError::Invalid(reason));
            }
            let step = crate::setup::plan(&tc, &id)
                .await
                .map_err(AppError::Invalid)?;
            let plan = step.plan;

            Ok(Built {
                // Same dispatch as the Toolbox: the integrated terminal, whether or
                // not this step needs root. `plan.in_terminal` no longer selects the
                // destination — it only records that a password prompt is coming.
                kind: "termPackage".into(),
                title: format!("Set up — {}", step.title),
                description: plan.description,
                argv: plan.argv,
                preview: None,
                // Machine-scoped: this must work with no workspace open, which is
                // exactly when the workspace root is the empty path.
                cwd: crate::paths::neutral_cwd(&root),
                env: vec![],
                danger: plan.danger,
                warnings: plan.warnings,
                typed_confirm: plan.typed_confirm,
                repo: None,
                targets: vec![],
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::GitIdentity { name, email } => {
            let git = tc.require("git")?;
            let name = crate::setup::clean_identity("name", &name).map_err(AppError::Invalid)?;
            let email = crate::setup::clean_identity("email", &email).map_err(AppError::Invalid)?;

            Ok(Built {
                kind: "gitIdentity".into(),
                title: "Set your git identity".into(),
                description: format!("Every commit you make will record {name} <{email}>."),
                argv: crate::setup::git_identity_argv(require_shell()?, &git, &name, &email),
                preview: None,
                cwd: crate::paths::neutral_cwd(&root),
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: None,
                targets: vec![],
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::UseGitAccount { id, repo } => {
            let git = tc.require("git")?;
            // The closed set: the id names a record the backend stored, so nothing
            // that reaches a command line here came from this call.
            let cfg = state.config();
            let account = cfg
                .git_accounts
                .iter()
                .find(|a| a.id == id)
                .cloned()
                .ok_or_else(|| AppError::Invalid(format!("unknown account '{id}'")))?;

            let (scope, cwd, target) = match &repo {
                Some(r) => {
                    let path = crate::paths::resolve_repo(&root, r)?;
                    (
                        crate::accounts::Scope::Repo(path.clone()),
                        path,
                        format!("in {}", r.name),
                    )
                }
                None => (
                    crate::accounts::Scope::Global,
                    crate::paths::neutral_cwd(&root),
                    "on this machine".to_string(),
                ),
            };

            // Absent gh is not an error: the identity is still worth writing, and
            // `apply_argv` drops the switch. Warned about below rather than
            // silently, because "the account has a gh login" and "gh moved" are
            // different facts and only one of them just happened.
            let gh = tc.paths.get("gh").cloned();
            let mut warnings = Vec::new();
            if let Some(user) = &account.gh_user {
                match (&scope, gh.is_some()) {
                    (crate::accounts::Scope::Global, true) => warnings.push(format!(
                        "Also switches the GitHub CLI to {user}, which affects every repo."
                    )),
                    (crate::accounts::Scope::Global, false) => warnings.push(format!(
                        "gh is not installed, so the GitHub CLI stays as it is — {user} will not become active."
                    )),
                    (crate::accounts::Scope::Repo(_), _) => warnings.push(format!(
                        "The GitHub CLI stays as it is: gh has one active account per machine, not per repo. Apply {} globally to switch it to {user}.",
                        account.label
                    )),
                }
            }

            let pairs = crate::accounts::config_pairs(&account)
                .into_iter()
                .map(|(k, v)| format!("{k} = {v}"))
                .collect::<Vec<_>>()
                .join("\n");

            Ok(Built {
                kind: "useGitAccount".into(),
                title: format!("Use {} {target}", account.label),
                description: format!(
                    "Commits will record {} <{}>.\n{pairs}",
                    account.name, account.email
                ),
                argv: crate::accounts::apply_argv(
                    require_shell()?,
                    &git,
                    gh.as_deref(),
                    &account,
                    &scope,
                ),
                preview: None,
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings,
                typed_confirm: None,
                repo,
                targets: vec![],
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::Package { id, op, version } => {
            let plan = crate::packages::plan(&tc, &id, op, version.as_deref())
                .map_err(AppError::Invalid)?;
            let entry = crate::packages::find(&id)
                .ok_or_else(|| AppError::Invalid(format!("unknown package '{id}'")))?;
            let verb = match op {
                PackageOp::Install => "Install",
                PackageOp::Upgrade => "Upgrade",
                PackageOp::Remove => "Remove",
            };

            Ok(Built {
                // Always the integrated terminal, root or not. Two reasons, and the
                // second applies to every package operation: sudo needs a tty to ask
                // for a password, and the Toolbox is a full-window page with no
                // output pane — a streamed run there produced no visible output at
                // all.
                kind: "termPackage".into(),
                title: match &version {
                    Some(v) => format!("{verb} {} {v}", entry.label),
                    None => format!("{verb} {}", entry.label),
                },
                description: plan.description,
                argv: plan.argv,
                preview: None,
                // Any existing directory will do — none of these touch their cwd,
                // and the Toolbox is reachable before a workspace is chosen.
                cwd: crate::paths::neutral_cwd(&root),
                env: vec![],
                danger: plan.danger,
                warnings: plan.warnings,
                typed_confirm: plan.typed_confirm,
                repo: None,
                targets: vec![],
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::OpenInEditor { repo, editor } => {
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            // Only an id from the detected list is accepted, so the editor binary
            // can never be caller-supplied.
            let found = crate::toolchain::detect_editors(&tc.path_env)
                .into_iter()
                .find(|e| e.id == editor)
                .ok_or_else(|| AppError::ToolMissing(editor.clone()))?;

            Ok(Built {
                kind: "openInEditor".into(),
                title: format!("Open {} in {}", repo.key(), found.label),
                description: "Read-only — launches the editor on this folder.".into(),
                argv: vec![found.path, cwd.display().to_string()],
                preview: None,
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                task: None,
                // Opening an editor does not touch the repo, so it runs without a
                // confirmation dialog like the other read-only inspections.
                read_only: true,
                size: None,
            })
        }

        ActionSpec::OpenAgent {
            repo,
            agent,
            external,
            size,
        } => {
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            // The same closed-set gate the editors hold: the id is matched against
            // what the probe found, and the *resolved path* is what runs. A name
            // off the wire never becomes a program to execute.
            let found = crate::toolchain::detect_agents(&tc.path_env)
                .into_iter()
                .find(|a| a.id == agent)
                .ok_or_else(|| AppError::ToolMissing(agent.clone()))?;

            Ok(Built {
                // A pty, not a detached spawn: these are TUIs and would exit
                // immediately without a tty. `termScript` rather than a new kind so
                // it lands in the terminal dock the same way everything else does.
                kind: if external {
                    "openInTerminal".into()
                } else {
                    "termScript".into()
                },
                title: format!("{} — {}", found.label, repo.key()),
                description: format!("Starts {} in {}.", found.label, cwd.display()),
                // No arguments: every one of these takes the working directory as
                // its subject, and the ones that accept a prompt should be given it
                // by typing, not by a dialog.
                argv: vec![found.path],
                preview: None,
                cwd,
                env: vec![],
                // It is an agent that can write to the repo, but so is the shell
                // beside it, and gating a terminal behind a dialog per launch is
                // the friction that stops people reading dialogs at all.
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                task: None,
                read_only: true,
                size,
            })
        }

        ActionSpec::DockerPs => {
            let runtime = tc
                .container_runtime()
                .ok_or_else(|| AppError::ToolMissing("docker or podman".into()))?;
            let bin = tc.require(runtime.tool())?;
            Ok(Built {
                kind: "dockerPs".into(),
                title: format!("{} ps", runtime.tool()),
                description: "Read-only.".into(),
                argv: vec![
                    bin.display().to_string(),
                    "ps".into(),
                    "--all".into(),
                ],
                cwd: crate::paths::neutral_cwd(&root),
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: None,
                targets: vec![],
                preview: None,
                task: None,
                read_only: true,
                size: None,
            })
        }

        ActionSpec::KillPort { port, repo } => {
            if port < 1024 {
                // Refuse privileged ports outright: nothing this app manages lives
                // there, and a stray value should not let the user shoot at sshd.
                return Err(AppError::Invalid(format!(
                    "refusing to touch privileged port {port}"
                )));
            }

            let holders = procs::port_holders(&tc, port).await;
            let mut warnings = Vec::new();

            if holders.is_empty() {
                warnings.push(format!("Nothing is listening on :{port} — this will do nothing."));
            } else {
                for (pid, name) in &holders {
                    warnings.push(if name.is_empty() {
                        format!("pid {pid} is listening on :{port}")
                    } else {
                        format!("{name} (pid {pid}) is listening on :{port}")
                    });
                }
                // Not hardcoded: on Windows there is no catchable signal, so these
                // are terminated outright and the dialog must not claim otherwise.
                warnings.push(crate::platform::kill_verb_note().to_string());
            }

            // If we started it ourselves, stopping it is the right move — that path
            // tears down the whole process group instead of one pid.
            if let Some(r) = &repo {
                if let Some(d) = state.dev_server_for(&r.key()) {
                    if d.port == Some(port) {
                        warnings.push(
                            "Work Alley started this server — \"Stop dev\" shuts it down more                              cleanly."
                                .into(),
                        );
                    }
                }
            }

            // One command per pid — `taskkill` takes a single `/PID` — run as a
            // sequence, which also gives this action the per-pid result markers the
            // old single `kill -TERM a b c` never had.
            let pids: Vec<u32> = holders.iter().map(|(pid, _)| *pid).collect();
            let argv = if pids.is_empty() {
                Vec::new()
            } else {
                let sh = require_shell()?;
                let mut script = String::new();
                for (cmd, (pid, name)) in
                    crate::platform::kill_pids_argv(&pids).iter().zip(&holders)
                {
                    let who = if name.is_empty() {
                        format!("pid {pid}")
                    } else {
                        format!("{name} (pid {pid})")
                    };
                    script.push_str(&sh.stmt(&[
                        sh.echo(&format!("[..]   {who}")),
                        sh.and_or(
                            &sh.cmd(cmd),
                            &format!("[OK]   {who}"),
                            &format!("[FAIL] {who}"),
                        ),
                    ]));
                }
                sh.script_argv(&script)
            };

            Ok(Built {
                kind: "killPort".into(),
                title: format!("Free port :{port}"),
                description: match holders.len() {
                    0 => "No listener found.".into(),
                    1 => "Signal the process holding this port.".into(),
                    n => format!("Signal {n} processes holding this port."),
                },
                argv,
                cwd: root.clone(),
                env: vec![],
                danger: if holders.is_empty() {
                    Danger::Low
                } else {
                    Danger::Medium
                },
                warnings,
                typed_confirm: None,
                repo: repo.clone(),
                targets: repo.map(|r| vec![r]).unwrap_or_default(),
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::Pull { repo } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            let mut warnings = Vec::new();

            // Read-only preflight — this is what makes the dialog worth reading.
            let status = crate::git::scan_one(
                git.clone(),
                repo.clone(),
                cwd.clone(),
                cfg.stale_days,
                // The preflight only needs dirty counts, so skip the manifest read.
                None,
            )
            .await;

            let dirty = status.dirty_count + status.untracked_count;
            if dirty > 0 {
                warnings.push(format!(
                    "{dirty} uncommitted change(s) will be stashed and re-applied (--autostash)."
                ));
            }
            if status.conflict_count > 0 {
                warnings.push(format!(
                    "{} file(s) are in a conflicted state — resolve them first.",
                    status.conflict_count
                ));
            }
            if matches!(status.sync, SyncState::NoUpstream) {
                warnings.push("This branch has no upstream — the pull will do nothing.".into());
            }
            if status.detached {
                warnings.push("HEAD is detached — a rebase pull will fail.".into());
            }

            Ok(Built {
                kind: "pull".into(),
                title: format!("Pull {}", repo.key()),
                description: format!(
                    "Rebase onto the upstream of {}.",
                    status.branch.clone().unwrap_or_else(|| "HEAD".into())
                ),
                argv: vec![
                    git.display().to_string(),
                    "pull".into(),
                    "--rebase".into(),
                    "--autostash".into(),
                ],
                cwd,
                env: vec![],
                danger: if dirty > 0 { Danger::Medium } else { Danger::Low },
                warnings,
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::Push { repo, force } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            let mut warnings = Vec::new();

            let status = crate::git::scan_one(
                git.clone(),
                repo.clone(),
                cwd.clone(),
                cfg.stale_days,
                None,
            )
            .await;

            let branch = status.branch.clone();
            let no_upstream = matches!(status.sync, SyncState::NoUpstream);

            if status.detached {
                // There is no branch to push, and `-u HEAD` would be a surprise.
                return Err(AppError::Invalid(
                    "HEAD is detached — check out a branch before pushing".into(),
                ));
            }
            match &status.sync {
                SyncState::Diverged { ahead, behind } if *behind == 0 => {
                    warnings.push(format!("{ahead} commit(s) will be pushed."))
                }
                SyncState::Diverged { ahead, behind } if *ahead == 0 => warnings.push(format!(
                    "This branch is {behind} behind and has nothing to push."
                )),
                SyncState::Diverged { ahead, behind } => warnings.push(format!(
                    "This branch has diverged — {ahead} ahead, {behind} behind. \
                     Pull first unless you mean to force."
                )),
                SyncState::NoUpstream => warnings.push(format!(
                    "No upstream yet — this creates origin/{} and tracks it.",
                    branch.clone().unwrap_or_else(|| "HEAD".into())
                )),
                SyncState::InSync => {
                    warnings.push("Already up to date with the upstream — nothing to push.".into())
                }
            }
            let dirty = status.dirty_count + status.untracked_count;
            if dirty > 0 {
                // Not a blocker, but the usual reason a push "didn't include my fix".
                warnings.push(format!(
                    "{dirty} uncommitted change(s) stay local — a push only sends commits."
                ));
            }
            if force {
                warnings.push(
                    "--force-with-lease overwrites the remote branch. It refuses if someone \
                     else pushed since your last fetch, but your own remote commits are lost."
                        .into(),
                );
            }

            let mut argv = vec![git.display().to_string(), "push".into()];
            if force {
                // Never a bare --force: the lease is what makes this recoverable.
                argv.push("--force-with-lease".into());
            }
            if no_upstream {
                argv.push("--set-upstream".into());
                argv.push("origin".into());
                argv.push(branch.clone().unwrap_or_else(|| "HEAD".into()));
            }

            Ok(Built {
                kind: "push".into(),
                title: if force {
                    format!("Force-push {}", repo.key())
                } else {
                    format!("Push {}", repo.key())
                },
                description: format!(
                    "Push {} to origin.",
                    branch.clone().unwrap_or_else(|| "HEAD".into())
                ),
                argv,
                cwd,
                env: vec![],
                danger: if force { Danger::High } else { Danger::Medium },
                warnings,
                typed_confirm: force.then(|| "force".to_string()),
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::Commit {
            repo,
            message,
            amend,
        } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;

            let msg = message.trim();
            if msg.is_empty() {
                return Err(AppError::Invalid("a commit needs a message".into()));
            }

            if !crate::git::has_identity(&git, &cwd).await {
                return Err(AppError::Invalid(
                    "git does not know who you are yet — set your name and email in Guided setup"
                        .into(),
                ));
            }

            let changed = crate::git::changed_files(&git, &cwd)
                .await
                .map_err(AppError::Invalid)?;

            // A conflicted file in the index commits the conflict markers along with
            // it. git allows this and it is almost never what anyone means.
            let conflicts = changed.iter().filter(|f| f.conflicted).count();
            if conflicts > 0 {
                return Err(AppError::Invalid(format!(
                    "{} has {conflicts} unresolved conflict(s) — resolve them first",
                    repo.key()
                )));
            }

            let staged = changed.iter().filter(|f| f.staged).count();
            // --amend with nothing staged is a legitimate operation: it rewrites the
            // previous commit's message. Without it there is nothing to commit, and
            // git's own error for that prints the whole status output.
            if staged == 0 && !amend {
                return Err(AppError::Invalid(format!(
                    "nothing is staged in {} — stage a file first",
                    repo.key()
                )));
            }

            let branch = crate::git::current_branch(&git, &cwd).await;
            let mut warnings = Vec::new();
            if amend {
                warnings.push(
                    "Rewrites the previous commit. Do not amend anything already pushed."
                        .to_string(),
                );
            }
            warnings.push(match staged {
                0 => "Nothing staged — only the message changes.".to_string(),
                1 => "1 staged file will be committed.".to_string(),
                n => format!("{n} staged files will be committed."),
            });
            let left = changed.iter().filter(|f| !f.staged && !f.untracked).count();
            if left > 0 {
                warnings.push(format!("{left} change(s) stay uncommitted."));
            }

            let mut argv = vec![git.display().to_string(), "commit".into()];
            if amend {
                argv.push("--amend".into());
            }
            // Two elements, never one interpolated string: this is the whole reason a
            // free-text message is safe here.
            argv.push("--message".into());
            argv.push(msg.to_string());

            // The subject only, and shortened: a commit message can be a paragraph,
            // and this is a dialog title.
            let subject: String = msg.lines().next().unwrap_or(msg).chars().take(50).collect();
            Ok(Built {
                kind: "commit".into(),
                title: if amend {
                    format!("Amend {} — {subject}", repo.key())
                } else {
                    format!("Commit {} — {subject}", repo.key())
                },
                description: match &branch {
                    Some(b) => format!("Commits the staged changes onto {b}."),
                    None => "Commits the staged changes as this repo's first commit.".into(),
                },
                argv,
                cwd,
                env: vec![],
                // Amending rewrites history, which is a different kind of answer to
                // "can I undo this" than adding a commit on top.
                danger: if amend { Danger::Medium } else { Danger::Low },
                warnings,
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::Stash {
            repo,
            include_untracked,
        } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;

            let status = crate::git::scan_one(
                git.clone(),
                repo.clone(),
                cwd.clone(),
                cfg.stale_days,
                None,
            )
            .await;

            // Tracked changes alone are what plain `git stash` moves; untracked ones
            // only count when -u is on. Refusing early beats a run that prints
            // "No local changes to save" and exits 0.
            let stashable = status.dirty_count + if include_untracked { status.untracked_count } else { 0 };
            if stashable == 0 {
                return Err(AppError::Invalid(if status.untracked_count > 0 {
                    format!(
                        "{} has only untracked files — use \"Stash including untracked\"",
                        repo.key()
                    )
                } else {
                    format!("{} has nothing to stash", repo.key())
                }));
            }

            let existing = crate::git::stash_count(&git, &cwd).await;
            let mut warnings = vec![format!(
                "{stashable} change(s) move onto the stash — recover with \"Pop stash\"."
            )];
            if !include_untracked && status.untracked_count > 0 {
                warnings.push(format!(
                    "{} untracked file(s) are left in place.",
                    status.untracked_count
                ));
            }
            if existing > 0 {
                warnings.push(format!(
                    "{existing} entr(y/ies) already on the stash — this becomes stash@{{0}}."
                ));
            }

            let mut argv = vec![git.display().to_string(), "stash".into(), "push".into()];
            if include_untracked {
                argv.push("--include-untracked".into());
            }

            Ok(Built {
                kind: "stash".into(),
                title: format!("Stash {}", repo.key()),
                description: "Move uncommitted changes onto the stash.".into(),
                argv,
                cwd,
                env: vec![],
                danger: Danger::Medium,
                warnings,
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::StashPop { repo } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;

            let existing = crate::git::stash_count(&git, &cwd).await;
            if existing == 0 {
                return Err(AppError::Invalid(format!(
                    "{} has an empty stash",
                    repo.key()
                )));
            }

            let status = crate::git::scan_one(
                git.clone(),
                repo.clone(),
                cwd.clone(),
                cfg.stale_days,
                None,
            )
            .await;

            let mut warnings = Vec::new();
            if existing > 1 {
                warnings.push(format!(
                    "{existing} entries on the stash — only the newest is applied."
                ));
            }
            if status.dirty_count > 0 {
                // `pop` merges into the working tree and can leave conflicts behind.
                warnings.push(format!(
                    "{} uncommitted change(s) here already — applying may conflict, \
                     and a conflicted pop keeps the entry on the stash.",
                    status.dirty_count
                ));
            }

            Ok(Built {
                kind: "stashPop".into(),
                title: format!("Pop stash — {}", repo.key()),
                description: "Re-apply the newest stash entry and drop it.".into(),
                argv: vec![git.display().to_string(), "stash".into(), "pop".into()],
                cwd,
                env: vec![],
                danger: Danger::Medium,
                warnings,
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::StashList { repo } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            Ok(Built {
                kind: "stashList".into(),
                title: format!("Stash — {}", repo.key()),
                description: "Read-only.".into(),
                argv: vec![
                    git.display().to_string(),
                    "stash".into(),
                    "list".into(),
                    "--stat".into(),
                ],
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: true,
                size: None,
            })
        }

        ActionSpec::LogGraph { repo } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            Ok(Built {
                kind: "logGraph".into(),
                title: format!("Log — {}", repo.key()),
                description: "Read-only.".into(),
                argv: vec![
                    git.display().to_string(),
                    "log".into(),
                    "--graph".into(),
                    "--oneline".into(),
                    "--decorate".into(),
                    "--all".into(),
                    "--max-count=200".into(),
                ],
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: true,
                size: None,
            })
        }

        ActionSpec::Diff { repo, staged } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            // Stat *and* patch. This printed only `--stat` before, while the two
            // places that offer it — the changes panel's "Diff…" chip and the
            // truncation note under a long inline patch — both say it shows the
            // whole patch. The summary leads, so the output still opens with the
            // overview it used to be.
            let mut argv = vec![
                git.display().to_string(),
                "diff".into(),
                "--stat".into(),
                "--patch".into(),
            ];
            if staged {
                argv.push("--staged".into());
            }
            Ok(Built {
                kind: "diff".into(),
                title: if staged {
                    format!("Staged diff — {}", repo.key())
                } else {
                    format!("Diff — {}", repo.key())
                },
                description: "Read-only.".into(),
                argv,
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: true,
                size: None,
            })
        }

        ActionSpec::DiscardChanges { repo } => {
            let git = tc.require("git")?;
            let cwd = crate::paths::resolve_repo(&root, &repo)?;

            let status = crate::git::scan_one(
                git.clone(),
                repo.clone(),
                cwd.clone(),
                cfg.stale_days,
                None,
            )
            .await;

            let dirty = status.dirty_count + status.untracked_count;
            if dirty == 0 {
                return Err(AppError::Invalid(format!(
                    "{} has no local changes to discard",
                    repo.key()
                )));
            }

            Ok(Built {
                kind: "discardChanges".into(),
                title: format!("Discard changes — {}", repo.key()),
                description: "Reset tracked files and delete untracked ones.".into(),
                // Two commands, because neither half does the other's job: reset
                // --hard leaves untracked files, clean -fd leaves modifications.
                argv: {
                    let sh = require_shell()?;
                    let g = git.display().to_string();
                    let reset = sh.cmd(&[g.clone(), "reset".into(), "--hard".into()]);
                    let clean = sh.cmd(&[g, "clean".into(), "-fd".into()]);
                    sh.script_argv(&sh.both(&reset, &clean))
                },
                cwd,
                env: vec![],
                danger: Danger::High,
                warnings: vec![
                    format!(
                        "{} modified file(s) revert to HEAD and {} untracked file(s) are DELETED.",
                        status.dirty_count, status.untracked_count
                    ),
                    "This cannot be undone. \"Stash\" keeps the work instead.".into(),
                ],
                typed_confirm: Some("discard".to_string()),
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::RunScript {
            repo,
            script,
            manager,
        } => {
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            let key = repo.key();

            // Same gate as DevStart: the name must be one this repo declares, so a
            // caller cannot turn this into "run an arbitrary command".
            if !crate::pkg::available_scripts(&cwd).contains(&script) {
                return Err(AppError::Invalid(format!(
                    "{key} has no \"{script}\" script in package.json"
                )));
            }

            let fallback = tc.preferred_package_manager().unwrap_or("npm");
            let (tool, args) = match manager {
                // A named manager is checked against the four this app drives, so
                // the value can only ever select one of them — it is never a
                // program name reaching argv.
                Some(m) if crate::pkg::MANAGERS.contains(&m.as_str()) => {
                    (m.clone(), crate::pkg::script_args(&m, &script))
                }
                Some(m) => return Err(AppError::Invalid(format!("not a package manager: {m}"))),
                None => crate::pkg::task_command(&cwd, &script, fallback)
                    .ok_or_else(|| AppError::Invalid(format!("{key} has no package.json")))?,
            };
            let bin = tc.require(&tool)?;
            let mut argv = vec![bin.display().to_string()];
            argv.extend(args);

            Ok(Built {
                kind: "runScript".into(),
                title: format!("{script} — {key}"),
                description: format!("Run the \"{script}\" script with {tool}."),
                argv,
                cwd,
                env: vec![],
                // One-shot and repo-local. It can still write to the working tree —
                // `format` and `lint:fix` exist to — so not read_only.
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::UpgradeDep {
            repo,
            package,
            version,
        } => {
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            let key = repo.key();

            // The same closed-set gate RunScript holds against available_scripts:
            // the name has to be one this repo's own package.json declares, and the
            // field it is declared in — not the caller — picks the install flag.
            let (field, range) = crate::pkg::declared_dep(&cwd, &package).ok_or_else(|| {
                AppError::Invalid(format!("{key} does not declare \"{package}\""))
            })?;

            // A workspace/file/git range names a location, not a registry version.
            // Installing over it would silently swap a local link for a published
            // copy, which is a package.json edit, not an upgrade.
            if crate::deps::is_linked(&range) {
                return Err(AppError::Invalid(format!(
                    "{package} is declared as \"{range}\" — change that in package.json instead"
                )));
            }

            // Strict semver or nothing. Every offered value comes from the version
            // menu, so this only ever rejects a hand-built request.
            let version = match version {
                Some(v) => Some(
                    crate::deps::clean_target_version(&v)
                        .ok_or_else(|| AppError::Invalid(format!("not a version: {v}")))?,
                ),
                None => None,
            };

            let fallback = tc.preferred_package_manager().unwrap_or("npm");
            let tool = crate::pkg::package_manager(&cwd, fallback)
                .ok_or_else(|| AppError::Invalid(format!("{key} has no package.json")))?;
            let bin = tc.require(&tool)?;

            let mut argv = vec![bin.display().to_string()];
            argv.extend(crate::deps::add_argv(
                &tool,
                &cwd,
                &package,
                version.as_deref(),
                field,
            ));

            let target = version.as_deref().unwrap_or("latest");
            Ok(Built {
                kind: "upgradeDep".into(),
                title: format!("{package} → {target} — {key}"),
                description: format!("Runs {tool} in {key}."),
                argv,
                cwd,
                env: vec![],
                // Medium, not Low: an install executes the package's own lifecycle
                // scripts, which is a bigger step than any repo-local script.
                danger: Danger::Medium,
                warnings: vec![
                    "This rewrites package.json and the lockfile, and runs the package's install scripts."
                        .into(),
                ],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::RunChore {
            repo,
            chore,
            manager,
        } => {
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            let key = repo.key();

            // Same gate as RunScript and DevStart: the id must name a recipe this
            // repo's own files produced, so a caller cannot compose a command.
            let spec = crate::chores::find(&cwd, &chore)
                .ok_or_else(|| AppError::Invalid(format!("{key} has no \"{chore}\" command")))?;

            // Only the recipes that go through a package manager notice this; a
            // Gradle or CocoaPods chore resolves exactly as before.
            let m = match manager.as_deref() {
                Some(m) if crate::pkg::MANAGERS.contains(&m) => Some(m),
                Some(m) => return Err(AppError::Invalid(format!("not a package manager: {m}"))),
                None => None,
            };
            let argv = crate::runner::resolve_with(&cwd, &spec.via, &tc, m)?;

            // A subdirectory from the recipe, not from the caller — `pod install`
            // only works in ios/ and a Gradle task only in android/. Checked rather
            // than assumed, because a repo can lose the directory a stale scan saw.
            let cwd = match &spec.cwd {
                Some(sub) => {
                    let dir = cwd.join(sub);
                    if !dir.is_dir() {
                        return Err(AppError::Invalid(format!("{key} has no {sub}/ directory")));
                    }
                    dir
                }
                None => cwd,
            };

            Ok(Built {
                kind: "runChore".into(),
                title: format!("{} — {key}", spec.label),
                description: match &spec.cwd {
                    Some(sub) => format!("Runs in {sub}/."),
                    None => format!("Runs in {key}."),
                },
                argv,
                cwd,
                env: vec![],
                // Medium for anything that deletes build output or rewrites files in
                // place, so it gets a confirm rather than firing on one click.
                danger: if spec.destructive {
                    Danger::Medium
                } else {
                    Danger::Low
                },
                warnings: if spec.destructive {
                    vec!["This deletes build output or rewrites files in the working tree.".into()]
                } else {
                    vec![]
                },
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::CloneUrls { root: target, urls } => {
            let git = tc.require("git")?;
            let target = PathBuf::from(&target);
            if !target.is_absolute() {
                return Err(AppError::Invalid("the workspace folder must be an absolute path".into()));
            }
            // Created up front so the clone command has somewhere to run, and so a
            // permission problem surfaces here rather than mid-clone.
            std::fs::create_dir_all(&target)
                .map_err(|e| AppError::Invalid(format!("{}: {e}", target.display())))?;
            let target = target
                .canonicalize()
                .map_err(|e| AppError::Invalid(format!("{}: {e}", target.display())))?;

            let parsed = crate::clone::parse_repo_urls(&urls.join("\n"));
            if !parsed.rejected.is_empty() {
                // The UI validates as you type, so reaching here means the two
                // disagree. Refusing beats cloning a subset silently.
                return Err(AppError::Invalid(format!(
                    "{} of these URLs could not be parsed",
                    parsed.rejected.len()
                )));
            }
            if parsed.repos.is_empty() {
                return Err(AppError::Invalid("no repositories to clone".into()));
            }

            let mut warnings = Vec::new();
            let mut already: Vec<String> = Vec::new();
            for r in &parsed.repos {
                let dir = target.join(&r.name);
                if dir.exists() {
                    already.push(r.name.clone());
                }
            }
            if !already.is_empty() {
                // Skipped, not overwritten — see the generated command.
                warnings.push(format!(
                    "{} folder(s) already exist and will be skipped: {}",
                    already.len(),
                    already.join(", ")
                ));
            }
            if parsed.repos.iter().any(|r| !r.url.starts_with("http"))
                && std::env::var_os("SSH_AUTH_SOCK").is_none()
            {
                warnings.push(
                    "SSH_AUTH_SOCK is not set, so ssh clones may fail to authenticate.".into(),
                );
            }
            warnings.push(format!(
                "{} repositories will be cloned into {}.",
                parsed.repos.len() - already.len(),
                target.display()
            ));

            let hosts: std::collections::BTreeSet<&str> =
                parsed.repos.iter().map(|r| r.host.as_str()).collect();
            warnings.push(format!(
                "Clones from: {}.",
                hosts.into_iter().collect::<Vec<_>>().join(", ")
            ));

            Ok(Built {
                kind: "cloneUrls".into(),
                title: format!("Clone {} repositories", parsed.repos.len()),
                description: format!("Set up a new workspace in {}.", target.display()),
                argv: clone_all_argv(require_shell()?, &git, &target, &parsed.repos),
                preview: Some(vec![
                    git.display().to_string(),
                    "clone".into(),
                    "--progress".into(),
                    "<url>".into(),
                    format!("{}/<name>", target.display()),
                ]),
                cwd: target.clone(),
                env: vec![],
                // Network writes into a fresh directory, and nothing existing is
                // modified: worth confirming, not worth a typed phrase.
                danger: Danger::Medium,
                warnings,
                typed_confirm: None,
                repo: None,
                targets: vec![],
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::PullMany { refs } => {
            let git = tc.require("git")?;
            if refs.is_empty() {
                return Err(AppError::Invalid("no repos selected".into()));
            }
            let mut warnings = Vec::new();
            let mut dirty_total = 0u32;
            for r in &refs {
                let p = crate::paths::resolve_repo(&root, r)?;
                let s = crate::git::scan_one(
                    git.clone(),
                    r.clone(),
                    p,
                    cfg.stale_days,
                    None,
                )
                .await;
                dirty_total += s.dirty_count + s.untracked_count;
            }
            if dirty_total > 0 {
                warnings.push(format!(
                    "{dirty_total} uncommitted change(s) across the selection will be autostashed."
                ));
            }
            warnings.push(format!("{} repos will be pulled in sequence.", refs.len()));

            Ok(Built {
                kind: "pullMany".into(),
                title: format!("Pull {} repos", refs.len()),
                description: "Rebase each selected repo onto its upstream.".into(),
                // The runner executes one argv; for bulk we drive git through a
                // loop in bash -c using only absolute, validated paths.
                argv: bulk_pull_argv(require_shell()?, &git, &root, &refs),
                preview: Some(vec![
                    git.display().to_string(),
                    "pull".into(),
                    "--rebase".into(),
                    "--autostash".into(),
                ]),
                cwd: root.clone(),
                env: vec![],
                danger: if dirty_total > 0 { Danger::Medium } else { Danger::Low },
                warnings,
                typed_confirm: None,
                repo: None,
                targets: refs,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::FetchAll { repo } => {
            let git = tc.require("git")?;
            match repo {
                Some(r) => {
                    let cwd = crate::paths::resolve_repo(&root, &r)?;
                    Ok(Built {
                        kind: "fetchAll".into(),
                        title: format!("Fetch {}", r.key()),
                        description: "Update remote refs and prune deleted branches.".into(),
                        argv: vec![
                            git.display().to_string(),
                            "fetch".into(),
                            "--all".into(),
                            "--prune".into(),
                        ],
                        cwd,
                        env: vec![],
                        danger: Danger::Low,
                        warnings: vec![],
                        typed_confirm: None,
                        repo: Some(r.clone()),
                        targets: vec![r],
                        preview: None,
                task: None,
                        read_only: false,
                        size: None,
                    })
                }
                None => {
                    let groups: Vec<Category> = crate::paths::discover_groups(&root)
                        .into_iter()
                        .map(|(g, _)| g)
                        .collect();
                    let all: Vec<RepoRef> = crate::paths::discover_repos(&root, &groups)
                        .into_iter()
                        .map(|(r, _)| r)
                        .collect();
                    Ok(Built {
                        kind: "fetchAll".into(),
                        title: format!("Fetch all {} repos", all.len()),
                        description: "Update remote refs across the workspace.".into(),
                        argv: bulk_fetch_argv(require_shell()?, &git, &root, &all),
                        preview: Some(vec![
                            git.display().to_string(),
                            "fetch".into(),
                            "--all".into(),
                            "--prune".into(),
                        ]),
                        cwd: root.clone(),
                        env: vec![],
                        danger: Danger::Low,
                        warnings: vec![format!(
                            "{} repos will be fetched — this touches the network.",
                            all.len()
                        )],
                        typed_confirm: None,
                        repo: None,
                        targets: all,
                        task: None,
                        read_only: false,
                        size: None,
                    })
                }
            }
        }

        ActionSpec::FetchMany { refs } => {
            let git = tc.require("git")?;
            if refs.is_empty() {
                return Err(AppError::Invalid("no repos selected".into()));
            }
            // Validate every target before building the script, so a bad ref can
            // never reach the shell.
            for r in &refs {
                crate::paths::resolve_repo(&root, r)?;
            }
            Ok(Built {
                kind: "fetchAll".into(),
                title: format!("Fetch {} repos", refs.len()),
                description: "Update remote refs and prune deleted branches.".into(),
                argv: bulk_fetch_argv(require_shell()?, &git, &root, &refs),
                preview: Some(vec![
                    git.display().to_string(),
                    "fetch".into(),
                    "--all".into(),
                    "--prune".into(),
                ]),
                cwd: root.clone(),
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: None,
                targets: refs,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::DevStart {
            repo,
            task,
            manager,
        } => {
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            let key = repo.key();

            // The gate on `task` is unchanged in kind — it must name one of the
            // recipes `runner` derived from this repo — only the set is wider than
            // "scripts in package.json". A caller still cannot invent an argv.
            let available = crate::runner::run_tasks(&cwd);
            let spec = match &task {
                Some(id) => available
                    .iter()
                    .find(|t| &t.id == id)
                    .ok_or_else(|| AppError::Invalid(format!("{key} has no \"{id}\" task")))?,
                // No task named: whatever this repo's own files say it runs. This
                // is what used to be a hardcoded "dev", and it failed outright for
                // every repo that spells its dev server anything else.
                None => available.first().ok_or_else(|| {
                    AppError::Invalid(format!(
                        "nothing to run in {key} — no dev/start/serve script, and no \
                         Cargo/Go/Python/compose entry point"
                    ))
                })?,
            };
            let task = spec.id.clone();
            let tkey = crate::state::task_key(&key, &task);

            if state.dev.lock().unwrap().contains_key(&tkey) {
                return Err(AppError::DevAlreadyRunning(tkey));
            }

            // A saved override is the most specific answer there is, so it wins
            // over a manager picked for this launch — that picker is about which
            // manager runs the *detected* command, and an override replaced the
            // command entirely.
            let argv = match cfg.dev_command_overrides.get(&tkey) {
                Some(v) if !v.is_empty() => {
                    let mut argv = v.clone();
                    // Resolve the program to an absolute path if we know it.
                    if let Some(p) = tc.path(&argv[0]) {
                        argv[0] = p.display().to_string();
                    }
                    argv
                }
                _ => {
                    let m = match manager.as_deref() {
                        Some(m) if crate::pkg::MANAGERS.contains(&m) => Some(m),
                        Some(m) => {
                            return Err(AppError::Invalid(format!("not a package manager: {m}")))
                        }
                        None => None,
                    };
                    crate::runner::argv_with(&cwd, spec, &tc, m)?
                }
            };

            let mut warnings = Vec::new();
            let port = cfg
                .port_overrides
                .get(&tkey)
                .copied()
                .or(spec.port.map(|(p, _)| p));
            if let Some(p) = port {
                if procs::port_in_use(p).await {
                    warnings.push(format!(
                        "port {p} is already in use — the dev server may fail to bind."
                    ));
                }
            } else {
                warnings
                    .push("could not determine the port; it will be read from the output.".into());
            }

            Ok(Built {
                kind: "devStart".into(),
                // The label, so the confirm reads "Start cargo run — svc/api"
                // rather than calling every runner "dev".
                title: format!("Start {} — {key}", spec.label),
                description: port
                    .map(|p| format!("Expected on http://localhost:{p}"))
                    .unwrap_or_else(|| "Port will be detected from the output.".into()),
                argv,
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings,
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                read_only: false,
                size: None,
                task: Some(task),
            })
        }

        ActionSpec::DevStop { repo, task } => {
            let key = repo.key();
            // No task named: stop whatever is up. Defaulting to "dev" meant asking
            // to stop a server the repo may never have had — for a repo running
            // only `start`, Stop could not reach its own process.
            let task = match task {
                Some(t) => t,
                None => {
                    // Live tasks only. A crashed row is still in `dev_meta` — that
                    // is what makes the crash readable — but counting it here would
                    // make Stop ambiguous for a repo whose `dev` died while its
                    // storybook is still up, i.e. exactly when you want to stop one.
                    let mut running: Vec<String> = state
                        .dev_servers()
                        .into_iter()
                        .filter(|s| s.repo.key() == key)
                        .filter(|s| !matches!(s.state, DevState::Crashed))
                        .map(|s| s.task)
                        .collect();
                    if running.len() != 1 {
                        // Ambiguous on purpose: a library with dev and storybook
                        // both up has to say which, not have one guessed for it.
                        return Err(AppError::DevNotRunning(key.clone()));
                    }
                    running.remove(0)
                }
            };
            let tkey = crate::state::task_key(&key, &task);
            let server = state
                .dev_server_for(&tkey)
                .ok_or_else(|| AppError::DevNotRunning(tkey.clone()))?;
            let label = crate::runner::find(&crate::paths::repo_path(&root, &repo), &task)
                .map(|t| t.label)
                .unwrap_or_else(|| task.clone());
            Ok(Built {
                kind: "devStop".into(),
                title: format!("Stop {label} — {key}"),
                description: server
                    .port
                    .map(|p| format!("Frees port {p}."))
                    .unwrap_or_else(|| "Stops the process group.".into()),
                // What actually runs is killpg(SIGTERM) then SIGKILL after a
                // grace period — never this argv. But the preview must not read
                // as `kill -TERM -0`, which would mean "every process in my
                // session", so fall back to a description when the pid is unknown.
                argv: if server.pid > 0 {
                    vec![
                        "kill".into(),
                        "-TERM".into(),
                        format!("-{}", server.pid),
                    ]
                } else {
                    vec![
                        "(signal the dev server's process group; pid not yet known)".into(),
                    ]
                },
                cwd: crate::paths::repo_path(&root, &repo),
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: Some(repo.clone()),
                targets: vec![repo],
                preview: None,
                task: Some(task),
                read_only: false,
                size: None,
            })
        }

        ActionSpec::Script { script, args } => {
            let desc = crate::scripts::find(&root, &script)?;
            if desc.mode == ScriptMode::TerminalOnly {
                return Err(AppError::ScriptInteractive(desc.file.clone()));
            }
            let args = crate::scripts::validate_args(&desc, &args)?;
            let path = script_path(&root, &desc.file)?;
            let body = std::fs::read_to_string(&path).unwrap_or_default();

            let mut warnings = crate::scripts::extra_warnings(&desc, &args, &body);
            for t in &desc.required_tools {
                if !tc.has(t) {
                    warnings.push(format!("{t} is not installed — this script needs it."));
                }
            }
            if let Some(meaning) = &desc.non_zero_exit_meaning {
                warnings.push(format!("A non-zero exit here means: {meaning}."));
            }

            let argv = script_file_argv(&path, &args)?;

            Ok(Built {
                kind: "script".into(),
                title: desc.title.clone(),
                description: desc.description.clone(),
                argv,
                cwd: root.clone(),
                env: vec![],
                danger: desc.danger,
                warnings,
                typed_confirm: crate::scripts::typed_confirm_for(&desc, &args),
                repo: None,
                targets: vec![],
                preview: None,
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::Checkout { refs, branch, dirty } => {
            let git = tc.require("git")?;
            if refs.is_empty() {
                return Err(AppError::Invalid("no repos selected".into()));
            }

            let named = match branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
                Some(b) if !crate::git::valid_branch_name(b) => {
                    return Err(AppError::Invalid(format!(
                        "\"{b}\" is not a valid branch name"
                    )))
                }
                Some(b) => Some(b.to_string()),
                None => None,
            };

            // Preflight every repo. This is what makes the dialog worth reading: it
            // says how many will actually change, how many are already there, and
            // how many have work that the policy is about to act on.
            let mut plans: Vec<(RepoRef, PathBuf, String, u32)> = Vec::new();
            let mut no_default: Vec<String> = Vec::new();
            let mut already: u32 = 0;
            let mut dirty_repos: Vec<String> = Vec::new();

            for r in &refs {
                let path = crate::paths::resolve_repo(&root, r)?;
                let target = match &named {
                    Some(b) => {
                        let (local, remote) = crate::git::branch_exists(&git, &path, b).await;
                        // Either is enough — checkout creates a tracking branch from
                        // the remote. Neither means this repo simply does not have it.
                        if local || remote {
                            Some(b.clone())
                        } else {
                            None
                        }
                    }
                    // Guessing "main" could check out a branch that does not exist,
                    // or worse, one that does but is not the default.
                    None => crate::git::default_branch(&git, &path).await,
                };
                let Some(target) = target else {
                    no_default.push(r.key());
                    continue;
                };
                let status =
                    crate::git::scan_one(git.clone(), r.clone(), path.clone(), cfg.stale_days, None)
                        .await;
                let d = status.dirty_count + status.untracked_count;
                let on_target = status.branch.as_deref() == Some(target.as_str());

                if on_target && d == 0 {
                    already += 1;
                    continue;
                }
                if d > 0 {
                    dirty_repos.push(r.key());
                }
                plans.push((r.clone(), path, target, d));
            }

            let what = match &named {
                Some(b) => format!("branch {b}"),
                None => "their default branch".to_string(),
            };

            if plans.is_empty() {
                return Err(AppError::Invalid(format!(
                    "nothing to do — {already} already on {what}, {} without it",
                    no_default.len()
                )));
            }

            let mut warnings = Vec::new();
            warnings.push(format!(
                "{} repo(s) will switch branch.",
                plans.iter().filter(|(_, _, _, d)| *d == 0).count()
                    + dirty_repos.len()
                    - if dirty == DirtyPolicy::Skip { dirty_repos.len() } else { 0 }
            ));
            if already > 0 {
                warnings.push(format!("{already} already on {what}."));
            }
            if !no_default.is_empty() {
                warnings.push(match &named {
                    Some(b) => format!(
                        "{} skipped — no branch \"{b}\" locally or on origin: {}",
                        no_default.len(),
                        no_default.join(", ")
                    ),
                    None => format!(
                        "{} skipped — no origin/HEAD, so the default branch is unknown: {}",
                        no_default.len(),
                        no_default.join(", ")
                    ),
                });
            }
            if !dirty_repos.is_empty() {
                let n = dirty_repos.len();
                warnings.push(match dirty {
                    DirtyPolicy::Skip => format!(
                        "{n} repo(s) have local changes and will be left alone: {}",
                        dirty_repos.join(", ")
                    ),
                    DirtyPolicy::Stash => format!(
                        "{n} repo(s) will be stashed first — recover with `git stash pop`: {}",
                        dirty_repos.join(", ")
                    ),
                    DirtyPolicy::Discard => format!(
                        "{n} repo(s) will have local changes DELETED, including untracked \
                         files. This cannot be undone: {}",
                        dirty_repos.join(", ")
                    ),
                });
            }

            let danger = match dirty {
                DirtyPolicy::Discard if !dirty_repos.is_empty() => Danger::High,
                DirtyPolicy::Stash if !dirty_repos.is_empty() => Danger::Medium,
                _ => Danger::Low,
            };

            Ok(Built {
                kind: "checkout".into(),
                title: match &named {
                    Some(b) => format!("Check out {b} in {} repos", plans.len()),
                    None => format!("Check out {} repos on their default branch", plans.len()),
                },
                description: match &named {
                    Some(b) => format!("Switches each repo to {b}."),
                    None => "Switches each repo to the branch origin/HEAD points at.".into(),
                },
                argv: checkout_default_argv(require_shell()?, &git, &plans, dirty),
                preview: Some(vec![
                    git.display().to_string(),
                    "checkout".into(),
                    named.clone().unwrap_or_else(|| "<default branch>".into()),
                ]),
                cwd: root.clone(),
                env: vec![],
                danger,
                warnings,
                // Deleting other people's uncommitted work deserves more than a
                // click, and the phrase has to be typed rather than confirmed.
                typed_confirm: (danger == Danger::High).then(|| "discard".to_string()),
                repo: None,
                targets: plans.iter().map(|(r, _, _, _)| r.clone()).collect(),
                task: None,
                read_only: false,
                size: None,
            })
        }

        ActionSpec::OpenShell {
            repo,
            external,
            size,
        } => {
            let cwd = match &repo {
                Some(r) => crate::paths::resolve_repo(&root, r)?,
                None => root.clone(),
            };
            let where_ = repo
                .as_ref()
                .map(|r| r.key())
                .unwrap_or_else(|| "the workspace".to_string());
            // Resolved here, in the phase with no side effects, so the preview can
            // name the shell that will actually run — and resolved by `platform`, so
            // the preview and the dispatch cannot disagree about which shell that is.
            // $SHELL can be unset when launched from a .desktop file, and on Windows
            // it is never set at all.
            let login = crate::platform::login_shell_argv();
            Ok(Built {
                kind: if external { "openShell".into() } else { "termShell".into() },
                title: format!("Terminal in {where_}"),
                description: if external {
                    format!("Opens your terminal emulator in {}.", cwd.display())
                } else {
                    format!("Opens a terminal tab in {}.", cwd.display())
                },
                // For the external path the emulator is resolved at dispatch, so
                // there is nothing to show beyond where it will start.
                argv: if external {
                    vec![]
                } else {
                    login
                },
                preview: None,
                cwd,
                env: vec![],
                danger: Danger::Low,
                warnings: vec![],
                typed_confirm: None,
                repo: repo.clone(),
                targets: repo.map(|r| vec![r]).unwrap_or_default(),
                task: None,
                // Opening a shell changes nothing by itself, so it needs no
                // confirmation — a terminal button that asks first is a nuisance.
                // What the user then types is their own business, exactly as it is
                // in any other terminal.
                read_only: true,
                size,
            })
        }

        ActionSpec::OpenInTerminal {
            script,
            repo,
            external,
            size,
        } => {
            // A script handed to an external terminal is the one case Windows cannot
            // do: `wt.exe` splits its own command line on `;`, and these scripts are
            // full of them. The integrated PTY handles an interactive script at least
            // as well, so the request is rewritten rather than refused.
            let external = external && crate::platform::external_terminal_available(&tc);
            let desc = crate::scripts::find(&root, &script)?;
            let path = script_path(&root, &desc.file)?;
            // fe-auto-create-pr.sh auto-detects the repo from $PWD and only shows
            // its repo menu when it can't — so presetting cwd removes the most
            // error-prone prompt.
            let cwd = match &repo {
                Some(r) => crate::paths::resolve_repo(&root, r)?,
                None => root.clone(),
            };
            Ok(Built {
                kind: if external {
                    "openInTerminal".into()
                } else {
                    "termScript".into()
                },
                title: format!("{} — in a terminal", desc.title),
                description: "This script prompts interactively, so it needs a real terminal."
                    .into(),
                argv: script_file_argv(&path, &[])?,
                cwd,
                env: vec![],
                danger: desc.danger,
                warnings: vec![if external {
                    "It runs in its own terminal window, not in the output pane.".into()
                } else {
                    "It runs interactively in a terminal tab in the output pane.".to_string()
                }],
                typed_confirm: None,
                repo: repo.clone(),
                targets: repo.map(|r| vec![r]).unwrap_or_default(),
                preview: None,
                task: None,
                // Stays false even though OpenShell is true, and the asymmetry is
                // the point: opening an empty shell is not an action, but these
                // scripts push commits and publish packages, so the confirmation
                // dialog still has to fire.
                read_only: false,
                size,
            })
        }
    }
}

/// ScriptId maps to a fixed filename inside scripts/ — never a caller-supplied
/// path — and the result is still containment-checked.
fn script_path(root: &std::path::Path, file: &str) -> AppResult<PathBuf> {
    let p = crate::paths::scripts_dir(root).join(file);
    if !p.is_file() {
        return Err(AppError::UnknownScript(file.to_string()));
    }
    crate::paths::ensure_inside(root, &p)
}

/// The shell every generated script runs under.
///
/// An error rather than a silent fallback, and the message names the fix: on Windows
/// the whole shell layer rests on Git for Windows shipping `bash.exe`, and "nothing
/// happened" is the worst way to learn that it is missing.
fn require_shell() -> AppResult<&'static Shell> {
    crate::platform::shell().ok_or_else(|| {
        AppError::ToolMissing(
            "a shell — install Git for Windows, which provides Git Bash".into(),
        )
    })
}

/// The argv to run a `.sh` file, or a clear reason why it cannot be run.
///
/// The one genuine feature gap on Windows. PowerShell cannot execute a shell script
/// and rewriting a user's own scripts is out of the question, so the honest outcome
/// is to name the missing piece. A `.sh` in the workspace is still *listed* — see
/// `scripts::discover` — because the user should see that it exists.
fn script_file_argv(path: &std::path::Path, args: &[String]) -> AppResult<Vec<String>> {
    require_shell()?.file_argv(path, args).ok_or_else(|| {
        AppError::ToolMissing(
            "bash — this is a shell script, and PowerShell cannot run one. Install Git for \
             Windows, which provides Git Bash."
                .into(),
        )
    })
}

/// Bulk git over N repos, with every path absolute and pre-validated.
fn bulk_pull_argv(
    sh: &Shell,
    git: &std::path::Path,
    root: &std::path::Path,
    refs: &[RepoRef],
) -> Vec<String> {
    let mut script = String::new();
    for r in refs {
        let p = crate::paths::repo_path(root, r);
        let key = r.key();
        let pull = sh.cmd(&[
            git.display().to_string(),
            "-C".into(),
            p.display().to_string(),
            "pull".into(),
            "--rebase".into(),
            "--autostash".into(),
        ]);
        script.push_str(&sh.stmt(&[
            sh.echo(&format!("[..]   {key}")),
            sh.or_fail(&pull, &format!("[FAIL] {key}")),
        ]));
    }
    script.push_str(&sh.stmt(&[sh.echo("[OK]   bulk pull finished")]));
    sh.script_argv(&script)
}

/// One `git clone` per repo, sequentially, with per-repo result markers.
///
/// Sequential on purpose: parallel clones interleave progress output into
/// something unreadable, and they all contend for the same network anyway.
///
/// `-d` guards every clone: an existing directory is skipped rather than written
/// into, so re-running this after a partial failure cannot damage what worked.
fn clone_all_argv(
    sh: &Shell,
    git: &std::path::Path,
    root: &std::path::Path,
    repos: &[crate::clone::RepoUrl],
) -> Vec<String> {
    let mut script = String::new();
    for r in repos {
        let dir = root.join(&r.name);
        // Safe bare in the marker text: clone::repo_name allows only [A-Za-z0-9._-].
        let name = &r.name;
        let clone = sh.cmd(&[
            git.display().to_string(),
            "clone".into(),
            "--progress".into(),
            r.url.clone(),
            dir.display().to_string(),
        ]);
        // `rmdir` after a failure, never `rm -rf`: it only succeeds on an empty
        // directory, so it can clear the husk an interrupted clone leaves behind —
        // making a retry possible — and can never delete anything with content in it.
        let attempt = sh.if_ok(
            &clone,
            &[sh.echo(&format!("[OK]   {name}"))],
            &[sh.rmdir_quiet(&dir), sh.echo(&format!("[FAIL] {name}"))],
        );
        script.push_str(&sh.line(&sh.if_dir(
            &dir,
            &[sh.echo(&format!("[SKIP] {name} — folder already exists"))],
            &[sh.echo(&format!("[..]   {name}")), attempt],
        )));
    }
    script.push_str(&sh.stmt(&[sh.echo("[OK]   clone finished")]));
    sh.script_argv(&script)
}

/// One checkout per repo, with the dirty policy applied first.
///
/// `checkout` rather than `switch`, so this works with the git versions still
/// shipped by long-term-support distributions.
///
/// Each repo is a self-contained `if` chain, deliberately: an earlier version used
/// `continue` to skip a repo whose stash failed, wrapped in a one-iteration `for`
/// loop. `continue` there ends the *loop*, so a single stash failure silently
/// abandoned every remaining repo — the worst possible failure for a bulk action,
/// because the summary line still said it had finished.
fn checkout_default_argv(
    sh: &Shell,
    git: &std::path::Path,
    plans: &[(RepoRef, PathBuf, String, u32)],
    dirty: crate::model::DirtyPolicy,
) -> Vec<String> {
    use crate::model::DirtyPolicy;
    let mut script = String::new();

    for (repo, path, target, dirty_count) in plans {
        let key = repo.key();
        let g = git.display().to_string();
        let p = path.display().to_string();
        // Every git invocation in this loop is `git -C <repo>`, so build the prefix once.
        let git_c = |args: &[&str]| {
            let mut argv = vec![g.clone(), "-C".into(), p.clone()];
            argv.extend(args.iter().map(|s| (*s).to_string()));
            sh.cmd(&argv)
        };

        // The checkout itself, reused by every branch below.
        let checkout = sh.and_or(
            &git_c(&["checkout", target, "-q"]),
            &format!("[OK]   {key} -> {target}"),
            &format!("[FAIL] {key} — checkout {target} failed"),
        );

        if *dirty_count == 0 {
            // The policy applies only to repos with local changes; a clean repo is
            // always a plain checkout, even under "discard".
            script.push_str(&sh.stmt(&[checkout]));
            continue;
        }

        match dirty {
            DirtyPolicy::Skip => {
                script.push_str(&sh.stmt(&[
                    sh.echo(&format!("[SKIP] {key} — {dirty_count} local change(s)")),
                ]));
            }
            DirtyPolicy::Stash => {
                // -u includes untracked files, which is what the change count on the
                // card means. The checkout only runs if the stash actually worked.
                let stash = git_c(&[
                    "stash",
                    "push",
                    "-u",
                    "-q",
                    "-m",
                    &format!("work-alley: before checkout {target}"),
                ]);
                script.push_str(&sh.stmt(&[
                    sh.echo(&format!("[..]   {key} — stashing {dirty_count} change(s)")),
                    sh.if_ok(
                        &stash,
                        &[checkout],
                        &[sh.echo(&format!(
                            "[FAIL] {key} — stash failed, left on its current branch"
                        ))],
                    ),
                ]));
            }
            DirtyPolicy::Discard => {
                // Both halves are needed: reset drops tracked modifications, clean
                // drops untracked files, and an untracked file left behind can still
                // block the checkout.
                let reset = git_c(&["reset", "--hard", "-q"]);
                let clean = git_c(&["clean", "-fdq"]);
                script.push_str(&sh.stmt(&[
                    sh.echo(&format!("[..]   {key} — discarding {dirty_count} change(s)")),
                    sh.if_ok(
                        &sh.both(&reset, &clean),
                        &[checkout],
                        &[sh.echo(&format!("[FAIL] {key} — could not clean, left alone"))],
                    ),
                ]));
            }
        }
    }

    script.push_str(&sh.stmt(&[sh.echo("[OK]   checkout finished")]));
    sh.script_argv(&script)
}

fn bulk_fetch_argv(
    sh: &Shell,
    git: &std::path::Path,
    root: &std::path::Path,
    refs: &[RepoRef],
) -> Vec<String> {
    let mut script = String::new();
    for r in refs {
        let p = crate::paths::repo_path(root, r);
        let key = r.key();
        let fetch = sh.cmd(&[
            git.display().to_string(),
            "-C".into(),
            p.display().to_string(),
            "fetch".into(),
            "--all".into(),
            "--prune".into(),
            "-q".into(),
        ]);
        // The `[..]` opener exists so the UI has an in-flight state per repo, the
        // same as pull. Without it a fetch of 40 repos showed 40 queued rows that
        // each flipped straight to done, and you could not see where it had got to.
        script.push_str(&sh.stmt(&[
            sh.echo(&format!("[..]   {key}")),
            sh.and_or(&fetch, &format!("[OK]   {key}"), &format!("[FAIL] {key}")),
        ]));
    }
    sh.script_argv(&script)
}

/// The toolbox listing. Read-only.
#[tauri::command]
pub async fn list_packages(state: State<'_, Arc<AppState>>) -> AppResult<Vec<PackageStatus>> {
    let cfg = state.config();
    let chosen = crate::ecosystems::chosen(&cfg.stacks);
    let all = crate::packages::list(&state.toolchain()).await;
    // Filtered here rather than in the Toolbox, so the search field, the group
    // counts and the update check all agree about what the list is. A tool no stack
    // claims is always kept — see `tool_allowed`.
    Ok(all
        .into_iter()
        .filter(|p| crate::ecosystems::tool_allowed(&p.package.id, &chosen))
        .collect())
}

/// The stack picker's rows: every language and framework, with what this workspace
/// looks like and what is already installed for it.
///
/// Read-only and cheap: the repo counts come from the scan the app has already
/// done, and the tool counts from the same probe the Toolbox uses.
#[tauri::command]
pub async fn list_stacks(state: State<'_, Arc<AppState>>) -> AppResult<Vec<crate::model::StackInfo>> {
    let cfg = state.config();
    // The toolchain's own probe, not `packages::list`. That one spawns each tool to
    // read its version — forty-odd processes — and this command runs on every
    // keystroke of the picker. Whether a binary resolved is all the count needs.
    let tc = state.toolchain();
    let installed = |id: &str| {
        crate::packages::find(id)
            .map(|e| tc.has(e.bin_for(crate::packages::Os::current())))
            .unwrap_or(false)
    };

    // Detection is `detect.rs`'s answer, not a second opinion: whatever the last
    // scan decided each repo is, mapped up to the stack that owns that string.
    //
    // Zero counts before the first scan are honest — nothing has been looked at yet
    // — and the picker says "not scanned" rather than "none", because "0 Flutter
    // repos" would be a claim this has not earned.
    let mut counts: std::collections::HashMap<&'static str, usize> =
        std::collections::HashMap::new();
    if let Some(snap) = state.last_scan.read().unwrap().as_ref() {
        for repo in &snap.repos {
            for s in crate::ecosystems::for_shape(&repo.shape.stack) {
                *counts.entry(s.id).or_default() += 1;
            }
        }
    }

    Ok(crate::ecosystems::STACKS
        .iter()
        .map(|s| crate::model::StackInfo {
            id: s.id.to_string(),
            label: s.label.to_string(),
            hint: s.hint.to_string(),
            family: format!("{:?}", s.family).to_lowercase(),
            family_label: s.family.label().to_string(),
            chosen: cfg.stacks.iter().any(|id| id == s.id),
            repos: counts.get(s.id).copied().unwrap_or(0),
            tools_installed: s.tools.iter().filter(|t| installed(t)).count(),
            tools_total: s.tools.len(),
        })
        .collect())
}

/// Which installed tools have a newer version available. Read-only.
///
/// Separate from `list_packages` because it is the slow half: one bulk query per
/// manager, each of which may hit a mirror or a registry. Never an error — a
/// manager that cannot be reached is left out of `checked`, and the Toolbox then
/// keeps offering Upgrade rather than claiming those tools are current.
#[tauri::command]
pub async fn check_package_updates(state: State<'_, Arc<AppState>>) -> AppResult<UpdateReport> {
    Ok(crate::packages::updates(&state.toolchain()).await)
}

/// Sets the onboarding flag, once, and persists it. Never fails a caller.
fn mark_onboarded(state: &Arc<AppState>) {
    // Before the early return below: under `WORK_ALLEY_ONBOARDING=force` the config
    // flag may already be set from a previous run, and this is the only thing that
    // lets the screen be left in this one.
    ONBOARDING_DISMISSED.store(true, std::sync::atomic::Ordering::Relaxed);

    let mut cfg = state.config();
    if cfg.onboarding_done_unix.is_some() {
        return;
    }
    cfg.onboarding_done_unix = Some(crate::git::now_unix());
    state.set_config(cfg.clone());
    if let Err(e) = cfg.save(&state.app_dir()) {
        // A convenience flag is not worth failing anything over; the cost of losing it
        // is one extra visit to a page that will say everything is already done.
        log::warn!("could not save config: {e}");
    }
}

/// Records that first-run onboarding is over — finished or skipped, both count.
///
/// Skipping has to be durable for the same reason finishing does: a takeover screen
/// that returns on the next launch is one people learn to dismiss without reading.
/// Whatever is still missing keeps showing in the dashboard's warning bar.
#[tauri::command]
pub async fn complete_onboarding(state: State<'_, Arc<AppState>>) -> AppResult<Bootstrap> {
    // Idempotent: the first answer is the one that counts, so this does not move an
    // existing timestamp.
    mark_onboarded(state.inner());
    build_bootstrap(&state).await
}

/// Whether github.com has a newer release than this build.
///
/// On demand only. There is no launch-time check and no timer: a dashboard that
/// phones home the moment it opens is a thing people notice, and the answer is
/// only ever interesting when someone thought to ask.
///
/// Never an `Err`. Offline, no git, a timeout — all of it is rendered as a
/// sentence in the row that asked, per the rule at the top of `error.rs`.
#[tauri::command]
pub async fn check_for_updates(
    state: State<'_, Arc<AppState>>,
) -> AppResult<crate::update::UpdateCheck> {
    let git = state.toolchain().path("git").cloned();
    // Machine-scoped, like the Toolbox's commands: this asks about the app, not
    // about the open folder, and must work with no workspace at all.
    let cwd = crate::paths::neutral_cwd(&state.workspace_root());
    Ok(crate::update::check(git.as_deref(), &cwd).await)
}

/// The accounts page, in one call.
///
/// Reads rather than trusts: the stored list comes from config, but "which one is
/// active" is whatever `~/.gitconfig` says right now — someone can always run
/// `git config` themselves, and a page that reported its own last write instead of
/// the machine's actual state would be lying in exactly the situation this feature
/// exists for.
#[tauri::command]
pub async fn list_git_accounts(
    state: State<'_, Arc<AppState>>,
) -> AppResult<crate::accounts::AccountsView> {
    let cfg = state.config();
    let tc = state.toolchain();
    let accounts = cfg.git_accounts.clone();

    let (global_name, global_email) = match tc.path("git") {
        Some(git) => {
            let home = crate::paths::neutral_cwd(&state.workspace_root());
            (
                global_config(git, &home, "user.name").await,
                global_config(git, &home, "user.email").await,
            )
        }
        None => (None, None),
    };

    let gh_present = tc.has("gh");
    let gh_accounts = if gh_present {
        gh_auth_accounts(&tc).await
    } else {
        Vec::new()
    };

    Ok(crate::accounts::AccountsView {
        active_id: crate::accounts::match_account(&accounts, global_email.as_deref()),
        accounts,
        global_name,
        global_email,
        gh_accounts,
        gh_present,
    })
}

/// One `git config --global --get`. A missing key is `None`, not an error.
async fn global_config(
    git: &std::path::Path,
    cwd: &std::path::Path,
    key: &str,
) -> Option<String> {
    crate::git::git_output_public(git, cwd, &["config", "--global", "--get", key])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `gh auth status`, parsed.
///
/// Not through `gh_json`: that one is repo-scoped — it resolves a slug and passes
/// `--repo` — and this question is about the machine. Failure of any kind yields no
/// accounts, which the page renders as "gh is not signed in".
async fn gh_auth_accounts(tc: &crate::toolchain::Toolchain) -> Vec<crate::accounts::GhAccount> {
    let Some(gh) = tc.path("gh").cloned() else {
        return Vec::new();
    };
    let mut cmd = tokio::process::Command::new(&gh);
    crate::platform::hide_console(&mut cmd);
    cmd.args(["auth", "status"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::git::harden(&mut cmd);
    tc.apply_path(&mut cmd);

    let out = match tokio::time::timeout(Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(o)) => o,
        _ => return Vec::new(),
    };
    // gh writes this to stdout on success and stderr on some versions; read both
    // rather than guessing, since the parser ignores anything it does not recognise.
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    crate::accounts::parse_gh_accounts(&text)
}

/// What the app would write into `~/.ssh/config`, and what is there now.
///
/// A preview command rather than a silent write, because this is the one thing
/// here that edits a file the user also edits by hand — and the file in question is
/// what a machine's access to everything runs through. The page shows both halves
/// and asks; `apply_ssh_config` is the only thing that touches the disk.
#[tauri::command]
pub async fn preview_ssh_config(
    state: State<'_, Arc<AppState>>,
) -> AppResult<crate::model::SshConfigPreview> {
    let cfg = state.config();
    let path = ssh_config_path()?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let block = crate::accounts::ssh_config_block(&cfg.git_accounts);
    let entries = crate::accounts::parse_ssh_config(&existing);

    let proposed = if block.trim().is_empty() {
        crate::accounts::strip_ssh_config(&existing)
    } else {
        crate::accounts::splice_ssh_config(&existing, &block)
    };

    Ok(match proposed {
        Ok(next) => crate::model::SshConfigPreview {
            path: path.display().to_string(),
            exists: path.is_file(),
            managed: block.trim().to_string(),
            // Nothing to do is worth saying explicitly: the button is disabled and
            // the page says why, rather than offering a write that changes nothing.
            changed: next != existing,
            error: None,
            entries,
        },
        Err(e) => crate::model::SshConfigPreview {
            path: path.display().to_string(),
            exists: path.is_file(),
            managed: block.trim().to_string(),
            changed: false,
            error: Some(e),
            entries,
        },
    })
}

/// Writes the managed block. Everything outside the markers is copied through.
///
/// Backs the file up once per write and creates it 0600 if it is missing — ssh
/// refuses to read a config anyone else can write, so getting the mode wrong here
/// would break every connection on the machine rather than just this feature.
#[tauri::command]
pub async fn apply_ssh_config(state: State<'_, Arc<AppState>>) -> AppResult<String> {
    let cfg = state.config();
    let path = ssh_config_path()?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let block = crate::accounts::ssh_config_block(&cfg.git_accounts);

    let next = if block.trim().is_empty() {
        crate::accounts::strip_ssh_config(&existing)
    } else {
        crate::accounts::splice_ssh_config(&existing, &block)
    }
    .map_err(AppError::Invalid)?;

    if next == existing {
        return Ok(path.display().to_string());
    }

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::Invalid(format!("could not create {}: {e}", dir.display())))?;
    }
    // One backup per write, overwritten each time: the point is "undo the change I
    // just made", not a history — and a directory filling with dated copies of an
    // ssh config is its own problem.
    if !existing.is_empty() {
        let backup = path.with_extension("work-alley.bak");
        let _ = std::fs::write(&backup, &existing);
    }

    std::fs::write(&path, &next)
        .map_err(|e| AppError::Invalid(format!("could not write {}: {e}", path.display())))?;
    restrict_permissions(&path);

    Ok(path.display().to_string())
}

fn ssh_config_path() -> AppResult<std::path::PathBuf> {
    let home = crate::platform::home_dir()
        .ok_or_else(|| AppError::Invalid("no home directory".into()))?;
    Ok(home.join(".ssh").join("config"))
}

/// 0600 on unix. ssh ignores — and complains about — a config that is group or
/// world writable, so a file created with the default umask can be worse than none.
#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

/// Windows inherits the parent directory's ACL, which for a per-user profile folder
/// is already the right answer.
#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}

/// Adds or updates one account. Persisted immediately, like every other config write.
///
/// Not gated behind `prepare_action`: this writes the app's own JSON and runs no
/// process. Applying an account — the part that touches `~/.gitconfig` and gh — is
/// `ActionSpec::UseGitAccount`, and that does go through the gate.
#[tauri::command]
pub async fn save_git_account(
    account: crate::accounts::GitAccount,
    state: State<'_, Arc<AppState>>,
) -> AppResult<crate::accounts::AccountsView> {
    let mut cleaned = crate::accounts::clean(&account).map_err(AppError::Invalid)?;
    let mut cfg = state.config();

    match cfg.git_accounts.iter().position(|a| a.id == cleaned.id) {
        Some(i) => cfg.git_accounts[i] = cleaned,
        None => {
            // A new account whose generated id collides with an existing one — two
            // accounts both labelled "Work" — must not overwrite it.
            let taken: Vec<String> = cfg.git_accounts.iter().map(|a| a.id.clone()).collect();
            cleaned.id = crate::accounts::unique_id(&cleaned.label, &taken);
            cfg.git_accounts.push(cleaned);
        }
    }

    let _ = cfg.save(&state.app_dir());
    state.set_config(cfg);
    list_git_accounts(state).await
}

/// Forgets an account. Touches no git config: what is on the machine stays.
#[tauri::command]
pub async fn delete_git_account(
    id: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<crate::accounts::AccountsView> {
    let mut cfg = state.config();
    cfg.git_accounts.retain(|a| a.id != id);
    let _ = cfg.save(&state.app_dir());
    state.set_config(cfg);
    list_git_accounts(state).await
}

/// Re-runs the toolchain probe and republishes the result.
///
/// The setup page could not finish without this. `probe()` ran once at startup, so
/// after the nvm and node steps put npm on disk, `tc.paths` still had no npm — and
/// `plan_npm_group` kept refusing the very next step, js-tools, with "npm is not
/// installed — install Node first" until the app was restarted. The probe resolves
/// tools through a login *and* interactive shell (`-lic`), which is exactly what
/// picks up the lines nvm's installer appends to your rc file, so re-running it is
/// all that was needed.
///
/// Returns the fresh tool list so a caller can show it without a second round trip.
#[tauri::command]
pub async fn refresh_toolchain(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<ToolInfo>> {
    let st = state.inner().clone();

    // Already probing: hand back what we have rather than queueing a second pair of
    // login shells behind the first. Callers are events (a package terminal exiting)
    // as well as clicks, so concurrent calls are the normal case, not the edge one.
    if !st.begin_probe() {
        return Ok(st.toolchain().to_infos());
    }

    let tc = crate::toolchain::probe().await;
    st.set_toolchain(tc);
    // Readiness is derived from the toolchain, so it has to be recomputed here or
    // `get_bootstrap` would keep serving the pre-install answer.
    let readiness = crate::readiness::probe(&st.toolchain()).await;
    let ready = readiness.ready;
    st.set_readiness(readiness);
    st.end_probe();

    // A machine that is already set up must never be asked to onboard. Recorded here
    // rather than left to the frontend so it survives a launch on which the user never
    // opens the setup page at all.
    if ready && crate::paths::is_workspace(&st.workspace_root()) {
        mark_onboarded(&st);
    }

    // The same event the startup probe emits, so every listener that already reacts
    // to "the toolchain is known" reacts to it changing too.
    let _ = app.emit(events::TOOLS_READY, ());
    Ok(st.toolchain().to_infos())
}

/// The first-run setup path: every step, in order, with what is already done.
///
/// Never returns Err — a machine with no package manager, no git and no Node is
/// exactly when this page is needed, so every one of those is a state it renders
/// rather than a failure.
#[tauri::command]
pub async fn list_setup_plan(state: State<'_, Arc<AppState>>) -> AppResult<SetupPlan> {
    let cfg = state.config();
    let chosen = crate::ecosystems::chosen(&cfg.stacks);
    let mut plan = crate::setup::status(&state.toolchain()).await;
    // Same rule as the Toolbox: a step no stack claims is everybody's. The counts
    // the page shows ("3/7 required") are computed from `plan.steps` in the
    // frontend, so filtering here is what makes them mean "3 of the 7 *you* need".
    plan.steps
        .retain(|s| crate::ecosystems::step_allowed(&s.id, &chosen));
    Ok(plan)
}

/// What a checkout would do, per repo. Read-only.
///
/// Its own command rather than part of `prepare_action` because the *policy* is
/// chosen from this information — the user has to see which repos have local
/// changes, and which do not have the branch at all, before deciding.
///
/// `branch` None means each repo's own default from origin/HEAD.
#[tauri::command]
pub async fn preview_checkout(
    refs: Vec<RepoRef>,
    branch: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<CheckoutPreview>> {
    let root = state.workspace_root();
    let cfg = state.config();
    let git = state.toolchain().require("git")?;

    // Bounded concurrency, like the scan: this is 2-3 git processes per repo and a
    // folder can hold dozens.
    let sem = Arc::new(tokio::sync::Semaphore::new(cfg.scan_concurrency.max(1)));
    let mut set = tokio::task::JoinSet::new();

    // A name git would refuse is rejected once here rather than 60 times in the
    // output pane.
    let named = match branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) if !crate::git::valid_branch_name(b) => {
            return Err(AppError::Invalid(format!("\"{b}\" is not a valid branch name")))
        }
        Some(b) => Some(b.to_string()),
        None => None,
    };

    for r in refs {
        let path = match crate::paths::resolve_repo(&root, &r) {
            Ok(p) => p,
            // A repo that has vanished since the scan is reported, not fatal.
            Err(_) => continue,
        };
        let permit = sem.clone();
        let git = git.clone();
        let stale_days = cfg.stale_days;
        let named = named.clone();
        set.spawn(async move {
            let _p = permit.acquire_owned().await;

            let (target, exists) = match &named {
                Some(b) => {
                    let (local, remote) = crate::git::branch_exists(&git, &path, b).await;
                    // Either is enough: `git checkout <b>` creates a tracking branch
                    // when only the remote has it.
                    (Some(b.clone()), local || remote)
                }
                // A repo's own default always exists by construction.
                None => (crate::git::default_branch(&git, &path).await, true),
            };

            let status = crate::git::scan_one(git, r.clone(), path, stale_days, None).await;
            let dirty = status.dirty_count + status.untracked_count;
            let already = target.is_some()
                && exists
                && status.branch.as_deref() == target.as_deref()
                && dirty == 0;
            CheckoutPreview {
                repo: r,
                current: status.branch,
                target: target.filter(|_| exists),
                target_exists: exists,
                dirty_count: dirty,
                already_there: already,
            }
        });
    }

    let mut out = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(p) = joined {
            out.push(p);
        }
    }
    // Stable order, and the ones needing attention are easiest to find sorted.
    out.sort_by(|a, b| a.repo.key().cmp(&b.repo.key()));
    Ok(out)
}

/// Versions that can be installed for one tool, newest first.
///
/// Read-only and best-effort: an empty list means "this manager cannot enumerate
/// versions", and the UI then offers the current one only. Never an error, because
/// a registry being unreachable must not make the row look broken.
#[tauri::command]
pub async fn list_package_versions(
    id: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<PackageVersion>> {
    Ok(crate::packages::versions(&state.toolchain(), &id).await)
}

// ------------------------------------------------------------- repo detail ---

/// Resolves everything a `gh run` action needs, and refuses an unknown run.
///
/// The gate is `gh_run_label`: an id this app never listed for this repo has no
/// label, and without one there is no action. It is also where the dialog's words
/// come from, so "Re-run CI #482 on main" is the backend's own last answer rather
/// than whatever the frontend believed when the button was clicked.
async fn gh_run_target(
    state: &Arc<AppState>,
    root: &std::path::Path,
    repo: &RepoRef,
    run_id: u64,
) -> AppResult<(PathBuf, PathBuf, String, crate::state::GhRunLabel)> {
    let tc = state.toolchain();
    let gh = tc.require("gh")?;
    let cwd = crate::paths::resolve_repo(root, repo)?;

    let label = state.gh_run_label(&repo.key(), run_id).ok_or_else(|| {
        AppError::Invalid(
            "that workflow run is not in the current list — refresh the Actions tab".into(),
        )
    })?;

    // `--repo` as well as the cwd: a repo with two GitHub remotes must not be able
    // to surprise someone into re-running a fork's workflow.
    let git = tc.require("git")?;
    let slug = crate::git::remote_slug(&git, &cwd)
        .await
        .ok_or_else(|| AppError::Invalid("this repo has no origin remote".into()))?;

    Ok((gh, cwd, slug, label))
}

/// How a `gh --json` call can fail before it has produced anything to parse.
///
/// Internal: each command maps this onto its *own* public result enum, because
/// those enums are the wire contract and the house style is to write them out
/// rather than share one. What is shared is the twenty lines of getting there.
enum GhFail {
    Missing,
    NotAuthed(String),
    NoRemote,
    Failed(String),
}

/// Runs `gh <args> --repo <slug>` in a repo and returns its stdout.
///
/// Everything `list_pull_requests` learned the hard way, in one place: the child
/// is hardened the way every other subprocess here is, the network call has a
/// ceiling, and gh's "you are not logged in" is sniffed out of stderr so the UI
/// can offer the fix rather than printing a stack of words at someone.
///
/// **`Ok("")` is a success.** `gh workflow list` prints nothing at all for a repo
/// with no workflows, so an empty stdout must not be read as a failure — only a
/// non-zero exit is one.
async fn gh_json(
    tc: &crate::toolchain::Toolchain,
    repo_path: &std::path::Path,
    args: &[&str],
) -> Result<(String, String), GhFail> {
    let git = tc.require("git").map_err(|_| GhFail::Failed("git is not available".into()))?;
    let gh = tc.path("gh").cloned().ok_or(GhFail::Missing)?;
    let slug = crate::git::remote_slug(&git, repo_path)
        .await
        .ok_or(GhFail::NoRemote)?;

    let mut cmd = tokio::process::Command::new(&gh);
    crate::platform::hide_console(&mut cmd);
    cmd.args(args)
        .args(["--repo", &slug])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::git::harden(&mut cmd);
    tc.apply_path(&mut cmd);

    let out = match tokio::time::timeout(Duration::from_secs(20), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(GhFail::Failed(e.to_string())),
        Err(_) => return Err(GhFail::Failed("gh timed out after 20s".into())),
    };

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let lower = err.to_lowercase();
        if lower.contains("auth") || lower.contains("logged in") || lower.contains("token") {
            return Err(GhFail::NotAuthed(err));
        }
        return Err(GhFail::Failed(err));
    }

    Ok((slug, String::from_utf8_lossy(&out.stdout).into_owned()))
}

/// Every workflow this repo defines, for the Actions sidebar. Read-only.
///
/// `--all` because github.com greys a disabled workflow rather than hiding it,
/// and one disabled by sixty days of inactivity is exactly the thing you open
/// this tab to notice.
#[tauri::command]
pub async fn list_workflows(
    repo: RepoRef,
    state: State<'_, Arc<AppState>>,
) -> AppResult<WorkflowsResult> {
    let root = state.workspace_root();
    let tc = state.toolchain();
    let path = crate::paths::resolve_repo(&root, &repo)?;

    match gh_json(
        &tc,
        &path,
        &["workflow", "list", "--limit", "100", "--all", "--json", "id,name,path,state"],
    )
    .await
    {
        // Exit 0 with no rows is the real answer for a repo with no workflows —
        // and the *only* way to tell it from a broken parse, since gh prints
        // nothing rather than `[]`.
        Ok((slug, stdout)) => {
            let workflows = parse_gh_workflows(&stdout);
            // The closed set `GhWorkflowRun` is checked against.
            state.remember_gh_workflows(&repo.key(), &workflows);
            Ok(WorkflowsResult::Ok { slug, workflows })
        }
        Err(GhFail::Missing) => Ok(WorkflowsResult::GhMissing),
        Err(GhFail::NoRemote) => Ok(WorkflowsResult::NoRemote),
        Err(GhFail::NotAuthed(message)) => Ok(WorkflowsResult::NotAuthenticated { message }),
        Err(GhFail::Failed(message)) => Ok(WorkflowsResult::Failed { message }),
    }
}

/// Whether a workflow can be started by hand, and what it asks for. Read-only.
///
/// Reads the workflow's own YAML, because the REST API does not expose dispatch
/// inputs at all — `gh` parses the file client-side to build its own prompt, and
/// this does the same.
#[tauri::command]
pub async fn workflow_dispatch_inputs(
    repo: RepoRef,
    workflow: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<WorkflowDispatchResult> {
    let root = state.workspace_root();
    let tc = state.toolchain();
    let path = crate::paths::resolve_repo(&root, &repo)?;

    match gh_json(&tc, &path, &["workflow", "view", &workflow, "--yaml"]).await {
        Ok((_slug, yaml)) => match parse_dispatch_inputs(&yaml) {
            Some(inputs) => {
                // Remembered so the argv built from this form can be checked
                // against it later without asking GitHub a second time.
                state.remember_gh_inputs(
                    &repo.key(),
                    &workflow,
                    inputs.iter().map(|i| i.name.clone()).collect(),
                );
                Ok(WorkflowDispatchResult::Ok { inputs })
            }
            None => Ok(WorkflowDispatchResult::NotDispatchable),
        },
        Err(GhFail::Missing) => Ok(WorkflowDispatchResult::GhMissing),
        Err(GhFail::NoRemote) => Ok(WorkflowDispatchResult::NoRemote),
        Err(GhFail::NotAuthed(message)) => {
            Ok(WorkflowDispatchResult::NotAuthenticated { message })
        }
        Err(GhFail::Failed(message)) => Ok(WorkflowDispatchResult::Failed { message }),
    }
}

/// The fields every `gh` still in circulation understands.
const GH_RUN_FIELDS: &str = "databaseId,number,displayTitle,workflowName,workflowDatabaseId,\
                             event,headBranch,headSha,status,conclusion,url,createdAt,\
                             startedAt,updatedAt";

/// The same list plus `attempt`, which is the re-run counter behind the `a2` badge.
const GH_RUN_FIELDS_WITH_ATTEMPT: &str = "databaseId,number,attempt,displayTitle,workflowName,\
                                          workflowDatabaseId,event,headBranch,headSha,status,\
                                          conclusion,url,createdAt,startedAt,updatedAt";

/// Whether this machine's `gh` understands `run list --json attempt`.
///
/// It does not always. The field landed in gh 2.49, and Debian and Ubuntu still
/// package 2.46. There, naming it does not just omit the column: it fails the
/// whole call with `Unknown JSON field: "attempt"`, and the Actions tab renders
/// nothing at all. One cosmetic badge is not worth the tab, so the field list is
/// a capability rather than a constant. The first call asks for `attempt`, and a
/// rejection downgrades every later one in this process.
///
/// The flag only ever moves toward the shorter list, so the cost of being wrong
/// is one wasted call on the first fetch, never a wrong answer. A restart
/// re-probes, which is what picks the badge back up after a gh upgrade.
static GH_RUN_HAS_ATTEMPT: AtomicBool = AtomicBool::new(true);

/// gh's complaint about a `--json` field it does not know.
///
/// Matched on the text because gh exits 1 for this the same way it does for a
/// network failure, and the two want opposite handling: retry without the field,
/// versus show the user the error.
fn gh_rejected_json_field(message: &str, field: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("unknown json field") && m.contains(&field.to_lowercase())
}

/// The last 50 workflow runs, optionally for one workflow. Read-only.
///
/// `workflow` is a *path* (`.github/workflows/ci.yml`) rather than a display
/// name: gh accepts either, but the path survives a rename and is unambiguous
/// when two workflows share a `name:`.
#[tauri::command]
pub async fn list_workflow_runs(
    repo: RepoRef,
    workflow: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> AppResult<WorkflowRunsResult> {
    let root = state.workspace_root();
    let tc = state.toolchain();
    let path = crate::paths::resolve_repo(&root, &repo)?;

    async fn fetch(
        tc: &crate::toolchain::Toolchain,
        path: &std::path::Path,
        workflow: Option<&str>,
        fields: &str,
    ) -> Result<(String, String), GhFail> {
        let mut args: Vec<&str> = vec!["run", "list", "--limit", "50", "--json", fields];
        if let Some(w) = workflow {
            args.extend(["--workflow", w]);
        }
        gh_json(tc, path, &args).await
    }

    let asked_for_attempt = GH_RUN_HAS_ATTEMPT.load(Ordering::Relaxed);
    let fields = if asked_for_attempt {
        GH_RUN_FIELDS_WITH_ATTEMPT
    } else {
        GH_RUN_FIELDS
    };
    let mut out = fetch(&tc, &path, workflow.as_deref(), fields).await;

    // An old gh rejecting `attempt` is not a failure to report, it is a field to
    // stop asking for. Every run then parses with `attempt: 1`, which is what the
    // badge already treats as "not a re-run".
    if asked_for_attempt {
        let rejected = matches!(
            &out,
            Err(GhFail::Failed(m)) if gh_rejected_json_field(m, "attempt")
        );
        if rejected {
            GH_RUN_HAS_ATTEMPT.store(false, Ordering::Relaxed);
            out = fetch(&tc, &path, workflow.as_deref(), GH_RUN_FIELDS).await;
        }
    }

    match out {
        Ok((slug, stdout)) => {
            let now = crate::git::now_unix();
            let runs = parse_gh_runs(&stdout, now);
            // The closed set the run actions are checked against. Replaced by the
            // unfiltered view, merged into by a filtered one — see `remember_gh_runs`.
            state.remember_gh_runs(&repo.key(), &runs, workflow.is_none());
            Ok(WorkflowRunsResult::Ok {
                slug,
                runs,
                fetched_unix: now,
            })
        }
        Err(GhFail::Missing) => Ok(WorkflowRunsResult::GhMissing),
        Err(GhFail::NoRemote) => Ok(WorkflowRunsResult::NoRemote),
        Err(GhFail::NotAuthed(message)) => Ok(WorkflowRunsResult::NotAuthenticated { message }),
        Err(GhFail::Failed(message)) => Ok(WorkflowRunsResult::Failed { message }),
    }
}

/// Open PRs for one repo.
///
/// Never returns Err for the ordinary failure modes — gh missing, not logged in,
/// no remote — because those are states the detail page must render, not crashes.
#[tauri::command]
pub async fn list_pull_requests(
    repo: RepoRef,
    state: State<'_, Arc<AppState>>,
) -> AppResult<PullRequestsResult> {
    let root = state.workspace_root();
    let tc = state.toolchain();
    let path = crate::paths::resolve_repo(&root, &repo)?;

    let Ok(git) = tc.require("git") else {
        return Ok(PullRequestsResult::Failed {
            message: "git is not available".into(),
        });
    };
    let Some(gh) = tc.path("gh").cloned() else {
        return Ok(PullRequestsResult::GhMissing);
    };
    let Some(slug) = crate::git::remote_slug(&git, &path).await else {
        return Ok(PullRequestsResult::NoRemote);
    };

    let mut cmd = tokio::process::Command::new(&gh);
    crate::platform::hide_console(&mut cmd);
    cmd.args([
        "pr",
        "list",
        "--repo",
        &slug,
        "--state",
        "open",
        "--limit",
        "50",
        "--json",
        // statusCheckRollup, labels and mergeable ride along on the call that was
        // already being made — gh charges the same round trip for twelve fields or
        // fifteen, and "is CI green" is the first thing anyone asks of a PR list.
        "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,url,\
         additions,deletions,changedFiles,updatedAt,statusCheckRollup,labels,mergeable",
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    crate::git::harden(&mut cmd);
    tc.apply_path(&mut cmd);

    // gh talks to the network; without a ceiling the page would spin forever.
    let out = match tokio::time::timeout(Duration::from_secs(20), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Ok(PullRequestsResult::Failed {
                message: e.to_string(),
            })
        }
        Err(_) => {
            return Ok(PullRequestsResult::Failed {
                message: "gh timed out after 20s".into(),
            })
        }
    };

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let lower = err.to_lowercase();
        if lower.contains("auth") || lower.contains("logged in") || lower.contains("token") {
            return Ok(PullRequestsResult::NotAuthenticated { message: err });
        }
        return Ok(PullRequestsResult::Failed { message: err });
    }

    let me = gh_current_user(&gh, &tc).await;
    let prs = parse_gh_prs(&String::from_utf8_lossy(&out.stdout), me.as_deref());

    Ok(PullRequestsResult::Ok {
        slug,
        prs,
        fetched_unix: crate::git::now_unix(),
    })
}

/// The configured GitHub Projects v2 board's items, for the Projects page.
/// Read-only. Takes no repo/owner — reads `Config::github_project` itself, so
/// the frontend just asks for "the board" once one has been picked in Settings.
#[tauri::command]
pub async fn list_github_project_items(
    state: State<'_, Arc<AppState>>,
) -> AppResult<ProjectItemsResult> {
    let Some(project) = state.config().github_project else {
        return Ok(ProjectItemsResult::NotConfigured);
    };
    let tc = state.toolchain();
    Ok(crate::github_projects::fetch_items(&tc, &project).await)
}

/// Projects for one owner, for the Settings page's project picker. Read-only.
#[tauri::command]
pub async fn list_github_projects(
    owner: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<GithubProjectListResult> {
    let tc = state.toolchain();
    Ok(crate::github_projects::list_projects(&tc, &owner).await)
}

/// Cached for the process lifetime — the login does not change while running.
async fn gh_current_user(gh: &std::path::Path, tc: &crate::toolchain::Toolchain) -> Option<String> {
    use std::sync::OnceLock;
    static ME: OnceLock<Option<String>> = OnceLock::new();
    if let Some(v) = ME.get() {
        return v.clone();
    }

    let mut cmd = tokio::process::Command::new(gh);
    crate::platform::hide_console(&mut cmd);
    cmd.args(["api", "user", "--jq", ".login"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    tc.apply_path(&mut cmd);

    let login = match tokio::time::timeout(Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        _ => None,
    };
    let _ = ME.set(login.clone());
    login
}

pub fn parse_gh_prs(stdout: &str, me: Option<&str>) -> Vec<PullRequest> {
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(stdout) else {
        return Vec::new();
    };
    let now = crate::git::now_unix();

    items
        .into_iter()
        .filter_map(|v| {
            let number = v.get("number")?.as_u64()?;
            let author = v
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|l| l.as_str())
                .unwrap_or("")
                .to_string();
            let updated_unix = v
                .get("updatedAt")
                .and_then(|u| u.as_str())
                .and_then(parse_iso8601)
                .unwrap_or(0);

            Some(PullRequest {
                number,
                title: v
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
                is_mine: me.is_some_and(|m| m == author),
                author,
                head_ref: v
                    .get("headRefName")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
                base_ref: v
                    .get("baseRefName")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
                is_draft: v.get("isDraft").and_then(|d| d.as_bool()).unwrap_or(false),
                review_decision: v
                    .get("reviewDecision")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
                url: v.get("url").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                additions: v.get("additions").and_then(|n| n.as_u64()).unwrap_or(0),
                deletions: v.get("deletions").and_then(|n| n.as_u64()).unwrap_or(0),
                changed_files: v.get("changedFiles").and_then(|n| n.as_u64()).unwrap_or(0),
                checks: rollup_state(v.get("statusCheckRollup")),
                labels: v
                    .get("labels")
                    .and_then(|l| l.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|l| l.get("name").and_then(|n| n.as_str()))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                mergeable: v
                    .get("mergeable")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string(),
                updated_relative: if updated_unix > 0 {
                    crate::git::relative_time(updated_unix, now)
                } else {
                    "?".into()
                },
                updated_unix,
            })
        })
        .collect()
}

/// Collapses gh's per-check array into one word: `passing`, `failing`, `pending`.
///
/// A rollup, because that is the only useful shape at list density — and the array
/// mixes two schemas: CheckRun entries carry `conclusion`/`status`, StatusContext
/// entries carry `state`. Both are read, so a repo using either still reports.
///
/// Empty string means "no checks configured", which is not the same as passing and
/// must not be rendered as green.
fn rollup_state(v: Option<&serde_json::Value>) -> String {
    let Some(arr) = v.and_then(|v| v.as_array()) else {
        return String::new();
    };
    if arr.is_empty() {
        return String::new();
    }

    let mut pending = false;
    for c in arr {
        // CheckRun: status COMPLETED/IN_PROGRESS/QUEUED, conclusion SUCCESS/FAILURE/…
        let status = c.get("status").and_then(|s| s.as_str()).unwrap_or("");
        let conclusion = c
            .get("conclusion")
            .and_then(|s| s.as_str())
            // StatusContext has no conclusion; its `state` plays the same role.
            .or_else(|| c.get("state").and_then(|s| s.as_str()))
            .unwrap_or("");

        match conclusion.to_ascii_uppercase().as_str() {
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => {
                // One red check is the answer, whatever the rest say.
                return "failing".into();
            }
            // Neutral and skipped are deliberately not failures: a skipped job is
            // how most workflows express "not applicable to this PR".
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => {}
            "" | "PENDING" | "EXPECTED" => pending = true,
            _ => pending = true,
        }
        if status.eq_ignore_ascii_case("IN_PROGRESS") || status.eq_ignore_ascii_case("QUEUED") {
            pending = true;
        }
    }

    if pending { "pending".into() } else { "passing".into() }
}

/// gh's `(status, conclusion)` pair, collapsed into the one thing a row renders.
///
/// A table rather than a chain of `contains`, because the interesting cells are
/// the ones that are not obvious: `skipped` and `neutral` are *not* failures, a
/// `completed` run with no conclusion yet is genuinely unknown rather than
/// successful, and a conclusion gh adds after this ships must land in `Unknown`
/// rather than being guessed at.
pub fn run_state(status: &str, conclusion: &str) -> RunState {
    match status.to_ascii_lowercase().as_str() {
        "queued" | "requested" | "waiting" | "pending" => return RunState::Queued,
        "in_progress" => return RunState::Running,
        "completed" => {}
        _ => return RunState::Unknown,
    }
    match conclusion.to_ascii_lowercase().as_str() {
        "success" => RunState::Success,
        "failure" | "timed_out" | "startup_failure" => RunState::Failure,
        "cancelled" => RunState::Cancelled,
        "skipped" | "neutral" | "stale" => RunState::Skipped,
        "action_required" => RunState::ActionRequired,
        _ => RunState::Unknown,
    }
}

/// `gh run list --json …` into rows.
///
/// `now` is a parameter rather than a call to the clock, so durations and the
/// relative string can be pinned in a test — `parse_gh_prs` reads the clock
/// internally, which is exactly why its own tests can only assert the fields that
/// are not time.
///
/// Unparseable JSON is an empty list, matching `parse_gh_prs`: the caller has
/// already decided from gh's exit code whether this was a failure.
pub fn parse_gh_runs(stdout: &str, now: i64) -> Vec<WorkflowRun> {
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(stdout) else {
        return Vec::new();
    };

    items
        .into_iter()
        .filter_map(|v| {
            let str_of = |k: &str| {
                v.get(k)
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let time_of = |k: &str| {
                v.get(k)
                    .and_then(|x| x.as_str())
                    .and_then(parse_iso8601)
                    .unwrap_or(0)
            };

            // The one field whose absence makes a row unusable — it is what every
            // `gh run` subcommand takes. Same role `number` plays for a PR.
            let id = v.get("databaseId")?.as_u64()?;

            let status = str_of("status");
            let conclusion = str_of("conclusion");
            let state = run_state(&status, &conclusion);

            let started_unix = time_of("startedAt");
            let updated_unix = time_of("updatedAt");
            let duration_secs = match state {
                // A queued run has not started, so a duration ticking up from its
                // creation would be describing time it did not spend.
                RunState::Queued => 0,
                RunState::Running if started_unix > 0 => (now - started_unix).max(0),
                _ if started_unix > 0 && updated_unix > 0 => {
                    // Clamped: clock skew between the runner and the API does
                    // produce an `updatedAt` before `startedAt`.
                    (updated_unix - started_unix).max(0)
                }
                _ => 0,
            };

            Some(WorkflowRun {
                id,
                number: v.get("number").and_then(|x| x.as_u64()).unwrap_or(0),
                attempt: v.get("attempt").and_then(|x| x.as_u64()).unwrap_or(1),
                title: str_of("displayTitle"),
                workflow_name: str_of("workflowName"),
                workflow_id: v
                    .get("workflowDatabaseId")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0),
                event: str_of("event"),
                branch: str_of("headBranch"),
                head_sha: str_of("headSha"),
                status,
                conclusion,
                state,
                url: str_of("url"),
                created_unix: time_of("createdAt"),
                started_unix,
                updated_unix,
                duration_secs,
                updated_relative: if updated_unix > 0 {
                    crate::git::relative_time(updated_unix, now)
                } else {
                    "?".to_string()
                },
            })
        })
        .collect()
}

/// `gh workflow list --json …` into the sidebar's rows.
///
/// Note what an empty result means here: `gh workflow list` prints *nothing at
/// all* for a repo with no workflows — not `[]` — so this returns an empty list
/// for both that and for junk. The caller distinguishes them by gh's exit code,
/// and must not read an empty list as a failure.
pub fn parse_gh_workflows(stdout: &str) -> Vec<Workflow> {
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(stdout) else {
        return Vec::new();
    };

    items
        .into_iter()
        .filter_map(|v| {
            let str_of = |k: &str| {
                v.get(k)
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            Some(Workflow {
                id: v.get("id")?.as_u64()?,
                name: str_of("name"),
                path: str_of("path"),
                state: str_of("state"),
            })
        })
        .collect()
}

/// The `workflow_dispatch` inputs a workflow declares, from its YAML.
///
/// `None` means the workflow has no `workflow_dispatch:` trigger at all — GitHub
/// then offers no way to start it by hand, and the UI must say so rather than
/// showing an empty form. `Some(vec![])` is a dispatchable workflow that simply
/// takes no inputs, which is the common case.
///
/// The YAML is read rather than the API asked, because the REST API does not
/// expose dispatch inputs at all — `gh` itself parses the file client-side to
/// build its own prompt.
pub fn parse_dispatch_inputs(yaml: &str) -> Option<Vec<WorkflowInput>> {
    use yaml_rust2::{Yaml, YamlLoader};

    let docs = YamlLoader::load_from_str(yaml).ok()?;
    let doc = docs.first()?;

    // `on` is the Norway problem's cousin: under YAML 1.1 the bare key `on` is the
    // *boolean true*, and which reading you get depends on the parser's version
    // and mood. Both are checked, because a workflow file's most important key
    // must not hinge on that.
    let on = match doc {
        Yaml::Hash(h) => h
            .get(&Yaml::String("on".into()))
            .or_else(|| h.get(&Yaml::Boolean(true)))?,
        _ => return None,
    };

    // `on: [push, workflow_dispatch]` and `on: workflow_dispatch` are both legal
    // and both mean dispatchable with no inputs.
    match on {
        Yaml::String(s) => return (s == "workflow_dispatch").then(Vec::new),
        Yaml::Array(items) => {
            let listed = items
                .iter()
                .any(|i| i.as_str() == Some("workflow_dispatch"));
            return listed.then(Vec::new);
        }
        _ => {}
    }

    let dispatch = on.as_hash()?.get(&Yaml::String("workflow_dispatch".into()))?;
    // `workflow_dispatch:` with nothing under it parses as null — dispatchable,
    // no inputs.
    let Some(inputs) = dispatch
        .as_hash()
        .and_then(|h| h.get(&Yaml::String("inputs".into())))
        .and_then(|i| i.as_hash())
    else {
        return Some(Vec::new());
    };

    Some(
        inputs
            .iter()
            .filter_map(|(name, spec)| {
                let name = name.as_str()?.to_string();
                let get = |k: &str| spec.as_hash().and_then(|h| h.get(&Yaml::String(k.into())));
                let text = |k: &str| {
                    get(k)
                        .map(|v| match v {
                            Yaml::String(s) => s.clone(),
                            Yaml::Boolean(b) => b.to_string(),
                            Yaml::Integer(i) => i.to_string(),
                            Yaml::Real(r) => r.clone(),
                            _ => String::new(),
                        })
                        .unwrap_or_default()
                };
                Some(WorkflowInput {
                    name,
                    description: text("description"),
                    // `required: true` is the only truthy spelling GitHub honours.
                    required: get("required").and_then(|v| v.as_bool()).unwrap_or(false),
                    kind: {
                        let t = text("type");
                        if t.is_empty() { "string".to_string() } else { t }
                    },
                    default: text("default"),
                    options: get("options")
                        .and_then(|v| v.as_vec())
                        .map(|v| {
                            v.iter()
                                .filter_map(|o| match o {
                                    Yaml::String(s) => Some(s.clone()),
                                    Yaml::Integer(i) => Some(i.to_string()),
                                    _ => None,
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
            })
            .collect(),
    )
}

/// Minimal ISO-8601 -> unix. Avoids pulling in chrono for one field.
/// gh always emits `2026-07-29T13:15:04Z`.
pub fn parse_iso8601(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);

    // Days since the epoch, via a days-from-civil algorithm.
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    Some(days * 86_400 + h * 3_600 + mi * 60 + sec)
}

// -------------------------------------------------------------- packages --

/// One repo's dependency table: declared range, installed version, field.
///
/// Local only — manifest and `node_modules`, nothing over the network. Read-only.
#[tauri::command]
pub async fn list_repo_packages(
    repo: RepoRef,
    state: State<'_, Arc<AppState>>,
) -> AppResult<RepoPackages> {
    let root = state.workspace_root();
    let path = crate::paths::resolve_repo(&root, &repo)?;
    Ok(crate::deps::list(&path, &state.toolchain()).await)
}

/// Which of this repo's dependencies have a newer published version. Read-only.
///
/// Split from `list_repo_packages` for the same reason `check_package_updates` is
/// split from `list_packages`: this is the half that talks to a registry and can
/// take half a minute on a large repo. Never an error — a manager that could not be
/// asked comes back as `checked: false` with a reason, and the panel keeps offering
/// Upgrade instead of claiming everything is current.
#[tauri::command]
pub async fn check_repo_package_updates(
    repo: RepoRef,
    state: State<'_, Arc<AppState>>,
) -> AppResult<DepUpdateReport> {
    let root = state.workspace_root();
    let path = crate::paths::resolve_repo(&root, &repo)?;
    Ok(crate::deps::check_updates(&path, &state.toolchain()).await)
}

/// Published versions of one dependency, for the version menu. Read-only.
///
/// An undeclared package is an empty list rather than an error: the menu having
/// nothing to offer is the same honest outcome as a registry that did not answer,
/// and it keeps a stale frontend from producing a dialog.
#[tauri::command]
pub async fn list_dep_versions(
    repo: RepoRef,
    package: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<PackageVersion>> {
    let root = state.workspace_root();
    let path = crate::paths::resolve_repo(&root, &repo)?;
    if crate::pkg::declared_dep(&path, &package).is_none() {
        return Ok(Vec::new());
    }
    Ok(crate::deps::versions(&path, &state.toolchain(), &package).await)
}

#[tauri::command]
pub async fn list_changed_files(
    repo: RepoRef,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<ChangedFile>> {
    let root = state.workspace_root();
    let git = state.toolchain().require("git")?;
    let path = crate::paths::resolve_repo(&root, &repo)?;
    crate::git::changed_files(&git, &path)
        .await
        .map_err(AppError::Invalid)
}

/// Moves paths into the index, and returns the fresh changed-file list.
///
/// A direct command rather than an `ActionSpec`, deliberately. The gate exists to
/// put a confirmation in front of anything that changes the working tree or history;
/// staging changes neither — it only sorts what is already there, and `git reset`
/// puts it straight back. Routing it through the gate would mean a modal dialog per
/// file click, which is the whole feature made unusable.
///
/// What it keeps from the gate is the part that matters: the argv is built here, and
/// every caller-supplied path is checked against the repo's own changed-file list
/// first — the same closed-set invariant `file_diff` holds. A path outside the repo,
/// or a `../` escape, simply is not in that list.
///
/// Returning the new list rather than nothing lets the panel update from the
/// authoritative answer instead of guessing what staging did.
#[tauri::command]
pub async fn stage_paths(
    repo: RepoRef,
    paths: Vec<String>,
    all: bool,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<ChangedFile>> {
    index_op(repo, paths, all, true, state).await
}

/// Takes paths back out of the index. See `stage_paths`.
#[tauri::command]
pub async fn unstage_paths(
    repo: RepoRef,
    paths: Vec<String>,
    all: bool,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<ChangedFile>> {
    index_op(repo, paths, all, false, state).await
}

async fn index_op(
    repo: RepoRef,
    paths: Vec<String>,
    all: bool,
    stage: bool,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<ChangedFile>> {
    let root = state.workspace_root();
    let git = state.toolchain().require("git")?;
    let cwd = crate::paths::resolve_repo(&root, &repo)?;

    let changed = crate::git::changed_files(&git, &cwd)
        .await
        .map_err(AppError::Invalid)?;

    if !all {
        if paths.is_empty() {
            return Err(AppError::Invalid("no paths given".into()));
        }
        // The closed set. Checked before anything reaches git, so a caller cannot
        // name a path this repo has not reported as changed.
        for p in &paths {
            if !changed.iter().any(|f| &f.path == p) {
                return Err(AppError::Invalid(format!(
                    "{p} is not a changed file in {}",
                    repo.key()
                )));
            }
        }
    }

    let mut argv: Vec<&str> = match (stage, all) {
        // -A so a deletion and an untracked file stage like any other change.
        (true, true) => vec!["add", "-A"],
        (true, false) => vec!["add"],
        // Plain `git reset` is a mixed reset against HEAD: it empties the index and
        // leaves every file exactly as it is on disk. Chosen over `restore --staged`
        // because it also works in a repo whose HEAD is unborn, which is precisely
        // the repo someone is staging a first commit in.
        (false, true) => vec!["reset", "--quiet"],
        (false, false) => vec!["reset", "--quiet"],
    };
    if !all {
        // `--` so a file named like a revision is still treated as a path.
        argv.push("--");
        argv.extend(paths.iter().map(String::as_str));
    }

    crate::git::git_output_public(&git, &cwd, &argv)
        .await
        .map_err(AppError::Invalid)?;

    crate::git::changed_files(&git, &cwd)
        .await
        .map_err(AppError::Invalid)
}

/// The patch for one changed file, for the inline diff viewer. Read-only.
///
/// `path` is caller-supplied, so it is checked against the repo's *own* changed-file
/// list before it reaches git — the same closed-set invariant `RunScript` holds
/// against `available_scripts` and `DevStart` against `available_tasks`. That is
/// what keeps this from becoming "read any file git will show you": a path outside
/// the repo, or a `../` escape, simply is not in the list.
#[tauri::command]
pub async fn file_diff(
    repo: RepoRef,
    path: String,
    staged: bool,
    state: State<'_, Arc<AppState>>,
) -> AppResult<String> {
    let root = state.workspace_root();
    let git = state.toolchain().require("git")?;
    let cwd = crate::paths::resolve_repo(&root, &repo)?;

    let changed = crate::git::changed_files(&git, &cwd)
        .await
        .map_err(AppError::Invalid)?;
    if !changed.iter().any(|f| f.path == path) {
        return Err(AppError::Invalid(format!(
            "{path} is not a changed file in {}",
            repo.key()
        )));
    }

    let mut argv = vec!["diff", "--no-color", "--patch"];
    if staged {
        argv.push("--cached");
    }
    // `--` so a path that looks like a revision is still treated as a path.
    argv.push("--");
    argv.push(&path);

    crate::git::git_output_public(&git, &cwd, &argv)
        .await
        .map_err(AppError::Invalid)
}

#[tauri::command]
pub async fn repo_commits(
    repo: RepoRef,
    limit: Option<u32>,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<CommitEntry>> {
    let root = state.workspace_root();
    let git = state.toolchain().require("git")?;
    let path = crate::paths::resolve_repo(&root, &repo)?;
    Ok(crate::git::recent_for(&git, &repo, &path, limit.unwrap_or(20)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- github actions ---------------------------------------------------

    /// 2026-07-31T03:12:48Z, the fixture's clock.
    const T0: i64 = 1_785_467_568;

    #[test]
    fn run_state_maps_every_pair_gh_emits() {
        use RunState::*;
        let cases: &[(&str, &str, RunState)] = &[
            ("queued", "", Queued),
            ("requested", "", Queued),
            ("waiting", "", Queued),
            ("pending", "", Queued),
            ("in_progress", "", Running),
            ("completed", "success", Success),
            ("completed", "failure", Failure),
            // Nothing renders a timeout differently from a failure, and a startup
            // failure is a failure you cannot even read a log for.
            ("completed", "timed_out", Failure),
            ("completed", "startup_failure", Failure),
            ("completed", "cancelled", Cancelled),
            // Not failures: "this did not apply".
            ("completed", "skipped", Skipped),
            ("completed", "neutral", Skipped),
            ("completed", "stale", Skipped),
            ("completed", "action_required", ActionRequired),
            // Completed with no conclusion is a real, momentary API state.
            ("completed", "", Unknown),
            // A conclusion gh grows after this ships must not be guessed at.
            ("completed", "some_future_thing", Unknown),
            ("something_new", "", Unknown),
            // gh is consistent about case, but nothing here should depend on it.
            ("QUEUED", "", Queued),
            ("In_Progress", "", Running),
            ("COMPLETED", "SUCCESS", Success),
        ];
        for (status, conclusion, want) in cases {
            assert_eq!(
                run_state(status, conclusion),
                *want,
                "({status}, {conclusion})"
            );
        }
    }

    #[test]
    fn garbage_parses_to_nothing_rather_than_panicking() {
        for bad in ["", "not json", "{}", "[null]", "[1,2]"] {
            assert!(parse_gh_runs(bad, T0).is_empty(), "runs: {bad:?}");
            assert!(parse_gh_workflows(bad).is_empty(), "workflows: {bad:?}");
        }
        // The empty string is not hypothetical: `gh workflow list` prints exactly
        // that for a repo with no workflows. The caller tells it apart from junk
        // by gh's exit code, never by this being empty.
        assert!(parse_gh_workflows("").is_empty());
    }

    #[test]
    fn an_old_gh_rejecting_a_field_is_told_apart_from_a_real_failure() {
        // Verbatim from gh 2.46, which Ubuntu packages and which predates the
        // `attempt` field. The whole call fails, so without the downgrade the
        // Actions tab shows this sentence where the runs should be.
        let err = "Unknown JSON field: \"attempt\"\nAvailable fields:\n  conclusion\n  \
                   createdAt\n  databaseId";
        assert!(gh_rejected_json_field(err, "attempt"));

        // Only that one field, and only that one complaint. A network or auth
        // failure must still reach the user rather than trigger a silent retry.
        assert!(!gh_rejected_json_field(err, "headSha"));
        for real in [
            "could not resolve to a Repository",
            "gh timed out after 20s",
            "HTTP 403: Resource not accessible",
            "",
        ] {
            assert!(!gh_rejected_json_field(real, "attempt"), "{real:?}");
        }
    }

    #[test]
    fn a_run_from_a_gh_without_attempt_still_parses() {
        // What the downgraded field list returns: no `attempt` key at all. The
        // badge reads 1 as "not a re-run", so the row renders unchanged.
        let json = r#"[{"databaseId":7,"number":12,"status":"completed",
          "conclusion":"success","startedAt":"2026-07-31T03:12:48Z",
          "updatedAt":"2026-07-31T03:13:06Z"}]"#;
        let r = &parse_gh_runs(json, T0 + 3600)[0];
        assert_eq!(r.attempt, 1);
        assert_eq!(r.number, 12);
        assert_eq!(r.state, RunState::Success);
    }

    #[test]
    fn parses_a_real_run() {
        // Captured from `gh run list` against cli/cli.
        let json = r#"[{"attempt":1,"conclusion":"success","createdAt":"2026-07-31T03:12:48Z",
          "databaseId":30601004684,"displayTitle":"Triage Scheduled Tasks","event":"schedule",
          "headBranch":"trunk","headSha":"abc123","number":5356,
          "startedAt":"2026-07-31T03:12:48Z","status":"completed",
          "updatedAt":"2026-07-31T03:13:06Z",
          "url":"https://github.com/cli/cli/actions/runs/30601004684",
          "workflowDatabaseId":235328803,"workflowName":"Triage Scheduled Tasks"}]"#;
        let runs = parse_gh_runs(json, T0 + 3600);
        assert_eq!(runs.len(), 1);
        let r = &runs[0];
        assert_eq!(r.id, 30_601_004_684);
        assert_eq!(r.number, 5356);
        assert_eq!(r.workflow_id, 235_328_803);
        assert_eq!(r.event, "schedule");
        assert_eq!(r.state, RunState::Success);
        // 03:12:48 -> 03:13:06.
        assert_eq!(r.duration_secs, 18);
    }

    #[test]
    fn a_running_run_counts_up_from_when_it_started() {
        let json = format!(
            r#"[{{"databaseId":1,"status":"in_progress","conclusion":"",
                 "startedAt":"{}","updatedAt":"{}"}}]"#,
            iso(T0),
            iso(T0)
        );
        let r = &parse_gh_runs(&json, T0 + 600)[0];
        assert_eq!(r.state, RunState::Running);
        assert_eq!(r.duration_secs, 600);
    }

    #[test]
    fn a_queued_run_has_no_duration() {
        // It has a timestamp, but nothing has run — a duration ticking up here
        // would be describing time the run did not spend.
        let json = format!(
            r#"[{{"databaseId":1,"status":"queued","conclusion":"",
                 "startedAt":"{}","updatedAt":"{}"}}]"#,
            iso(T0),
            iso(T0)
        );
        let r = &parse_gh_runs(&json, T0 + 600)[0];
        assert_eq!(r.state, RunState::Queued);
        assert_eq!(r.duration_secs, 0);
    }

    #[test]
    fn clock_skew_never_yields_a_negative_duration() {
        let json = format!(
            r#"[{{"databaseId":1,"status":"completed","conclusion":"success",
                 "startedAt":"{}","updatedAt":"{}"}}]"#,
            iso(T0 + 30),
            iso(T0)
        );
        assert_eq!(parse_gh_runs(&json, T0 + 600)[0].duration_secs, 0);
    }

    #[test]
    fn a_row_needs_an_id_and_nothing_else() {
        // No databaseId: unusable, because it is what every `gh run` takes.
        assert!(parse_gh_runs(r#"[{"number":7}]"#, T0).is_empty());

        // Only an id: renders, with everything else at its default rather than
        // taking the whole list down.
        let r = &parse_gh_runs(r#"[{"databaseId":9}]"#, T0)[0];
        assert_eq!(r.title, "");
        assert_eq!(r.state, RunState::Unknown);
        assert_eq!(r.attempt, 1);
        assert_eq!(r.updated_relative, "?");
    }

    #[test]
    fn a_ruleset_run_with_no_workflow_name_still_renders() {
        // Runs created by an org ruleset carry no workflowName. Documented API
        // behaviour, not a parse failure — dropping them would hide real CI.
        let json = r#"[{"databaseId":5,"workflowName":"","status":"completed",
                        "conclusion":"failure"}]"#;
        let r = &parse_gh_runs(json, T0)[0];
        assert_eq!(r.workflow_name, "");
        assert_eq!(r.state, RunState::Failure);
    }

    #[test]
    fn parses_workflows_including_disabled_ones() {
        let json = r#"[{"id":1,"name":"CI","path":".github/workflows/ci.yml","state":"active"},
                       {"id":2,"name":"Old","path":".github/workflows/old.yml",
                        "state":"disabled_inactivity"},
                       {"name":"no id"}]"#;
        let ws = parse_gh_workflows(json);
        assert_eq!(ws.len(), 2, "a workflow with no id cannot be filtered on");
        // The state string is passed through rather than parsed: the sidebar only
        // needs to know it is not "active", and gh may add more of these.
        assert_eq!(ws[1].state, "disabled_inactivity");
        assert_eq!(ws[1].path, ".github/workflows/old.yml");
    }

    #[test]
    fn a_workflow_with_no_dispatch_trigger_cannot_be_started_by_hand() {
        // The real cli/cli test workflow. None, not an empty input list: GitHub
        // offers no way in, and an empty form would imply there is one.
        let yaml = "name: Unit and Integration Tests\non:\n  push:\n    branches:\n      - trunk\n  pull_request:\n";
        assert_eq!(parse_dispatch_inputs(yaml), None);
    }

    #[test]
    fn on_survives_being_read_as_the_boolean_true() {
        // YAML 1.1 reads a bare `on` key as `true`. Which reading a parser gives
        // depends on its version, and a workflow file's most important key must
        // not hinge on that — so both are looked up.
        let yaml = "on:\n  workflow_dispatch:\njobs: {}\n";
        assert_eq!(parse_dispatch_inputs(yaml), Some(Vec::new()));
    }

    #[test]
    fn the_short_trigger_spellings_all_mean_dispatchable() {
        // `workflow_dispatch:` with nothing under it, in every legal shape.
        assert_eq!(parse_dispatch_inputs("on: workflow_dispatch\n"), Some(Vec::new()));
        assert_eq!(
            parse_dispatch_inputs("on: [push, workflow_dispatch]\n"),
            Some(Vec::new())
        );
        assert_eq!(parse_dispatch_inputs("on:\n  - workflow_dispatch\n"), Some(Vec::new()));
        // …and a list that does not include it is still not dispatchable.
        assert_eq!(parse_dispatch_inputs("on: [push]\n"), None);
    }

    #[test]
    fn parses_a_real_dispatch_form() {
        // Trimmed from cli/cli's deployment.yml.
        let yaml = r#"
name: Deployment
on:
  workflow_dispatch:
    inputs:
      tag_name:
        required: true
        type: string
        description: "The tag name for the release (e.g. v2.100.0)."
      environment:
        default: production
        type: environment
        description: "The deployment environment."
      dry_run:
        type: boolean
        default: true
      channel:
        type: choice
        options:
          - stable
          - beta
      untyped:
        description: no type given
"#;
        let inputs = parse_dispatch_inputs(yaml).expect("dispatchable");
        let by = |n: &str| inputs.iter().find(|i| i.name == n).unwrap().clone();

        assert_eq!(inputs.len(), 5);
        assert!(by("tag_name").required);
        assert_eq!(by("environment").default, "production");
        // A boolean default is not a string in the file, but the form and the
        // `-f k=v` argv both need one.
        assert_eq!(by("dry_run").default, "true");
        assert_eq!(by("channel").options, vec!["stable", "beta"]);
        // No `type:` means string — that is what GitHub assumes too.
        assert_eq!(by("untyped").kind, "string");
        assert!(!by("untyped").required);
    }

    #[test]
    fn junk_yaml_is_not_dispatchable_rather_than_a_panic() {
        for bad in ["", "\t\tbroken:\n  - [", "just a string", "42"] {
            assert_eq!(parse_dispatch_inputs(bad), None, "{bad:?}");
        }
    }

    /// Unix -> the ISO-8601 gh emits, for building fixtures.
    fn iso(unix: i64) -> String {
        let days = unix.div_euclid(86_400);
        let secs = unix.rem_euclid(86_400);
        // 1970-01-01 + days, the inverse of parse_iso8601's civil-from-days.
        let (mut y, mut d) = (1970, days);
        loop {
            let len = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 366 } else { 365 };
            if d < len {
                break;
            }
            d -= len;
            y += 1;
        }
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let mut m = 0;
        while d >= months[m] {
            d -= months[m];
            m += 1;
        }
        format!(
            "{y:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            m + 1,
            d + 1,
            secs / 3600,
            (secs % 3600) / 60,
            secs % 60
        )
    }

    fn name_set<'a>(names: &[&'a str]) -> std::collections::HashSet<&'a str> {
        names.iter().copied().collect()
    }

    #[test]
    fn a_folder_whose_repos_all_live_elsewhere_has_been_renamed() {
        let declared = vec!["api".to_string(), "auth".to_string()];
        // `be/` was renamed to `backend/`, so both are cloned — under another name.
        assert!(renamed_away(&declared, &name_set(&["api", "auth", "web"])));
    }

    #[test]
    fn a_folder_you_have_not_finished_cloning_keeps_its_row() {
        let declared = vec!["api".to_string(), "auth".to_string()];
        // The whole point of the declared-only row: "0 of 2 cloned" is information.
        assert!(!renamed_away(&declared, &name_set(&["api"])));
        assert!(!renamed_away(&declared, &name_set(&[])));
    }

    #[test]
    fn a_category_declaring_nothing_is_not_a_rename() {
        assert!(!renamed_away(&[], &name_set(&["api"])));
    }

    /// A fixed POSIX shell, so these assertions do not depend on `$SHELL`.
    fn posix() -> &'static Shell {
        crate::platform::test_shell(crate::platform::ShellKind::Posix)
    }

    fn plan(name: &str, branch: &str, dirty: u32) -> (RepoRef, PathBuf, String, u32) {
        (
            RepoRef {
                category: "fe".into(),
                name: name.into(),
            },
            PathBuf::from(format!("/w/fe/{name}")),
            branch.to_string(),
            dirty,
        )
    }

    #[test]
    fn checkout_uses_each_repos_own_default_branch() {
        // The whole point: origin/HEAD differs per repo, so "main" must never be
        // assumed.
        let plans = vec![plan("web", "main", 0), plan("api", "develop", 0)];
        let argv = checkout_default_argv(
            posix(),
            std::path::Path::new("/usr/bin/git"),
            &plans,
            crate::model::DirtyPolicy::Skip,
        );
        let script = argv.last().unwrap();
        assert!(script.contains("checkout main"));
        assert!(script.contains("checkout develop"));
    }

    #[test]
    fn skip_leaves_a_dirty_repo_completely_untouched() {
        let plans = vec![plan("web", "main", 3)];
        let script = checkout_default_argv(
            posix(),
            std::path::Path::new("/usr/bin/git"),
            &plans,
            crate::model::DirtyPolicy::Skip,
        )
        .last()
        .unwrap()
        .clone();
        assert!(script.contains("[SKIP] fe/web"));
        // Not merely "no reset" — no checkout either. Switching branches with
        // uncommitted work can still fail or carry changes across. Matched on
        // `checkout '` so the script's own closing echo does not count.
        assert!(!script.contains("checkout '"), "must not touch it at all: {script}");
        assert!(!script.contains("reset"));
        assert!(!script.contains("stash"));
    }

    #[test]
    fn stash_includes_untracked_files_and_never_resets() {
        let plans = vec![plan("web", "main", 3)];
        let script = checkout_default_argv(
            posix(),
            std::path::Path::new("/usr/bin/git"),
            &plans,
            crate::model::DirtyPolicy::Stash,
        )
        .last()
        .unwrap()
        .clone();
        // -u, or "3 changes" on the card would not match what gets stashed.
        assert!(script.contains("stash push -u"));
        assert!(!script.contains("reset --hard"), "stash must not destroy anything");
        assert!(!script.contains("clean -fd"));
        assert!(script.contains("checkout main"));
    }

    #[test]
    fn discard_resets_and_cleans_because_either_alone_is_not_enough() {
        let plans = vec![plan("web", "main", 3)];
        let script = checkout_default_argv(
            posix(),
            std::path::Path::new("/usr/bin/git"),
            &plans,
            crate::model::DirtyPolicy::Discard,
        )
        .last()
        .unwrap()
        .clone();
        // reset drops tracked edits, clean drops untracked files; without both the
        // checkout can still fail on an untracked file in the way.
        assert!(script.contains("reset --hard"));
        assert!(script.contains("clean -fdq"));
        assert!(script.contains("checkout main"));
    }

    #[test]
    fn a_clean_repo_is_never_reset_whatever_the_policy() {
        // The policy applies only to repos with local changes. A clean repo must be
        // a plain checkout even when "discard" is selected.
        let plans = vec![plan("web", "main", 0)];
        for policy in [
            crate::model::DirtyPolicy::Skip,
            crate::model::DirtyPolicy::Stash,
            crate::model::DirtyPolicy::Discard,
        ] {
            let script = checkout_default_argv(posix(), std::path::Path::new("/usr/bin/git"), &plans, policy)
                .last()
                .unwrap()
                .clone();
            assert!(!script.contains("reset"), "{policy:?}: {script}");
            assert!(!script.contains("stash"), "{policy:?}: {script}");
            assert!(!script.contains("[SKIP]"), "{policy:?}: {script}");
            assert!(script.contains("checkout main"), "{policy:?}");
        }
    }

    #[test]
    fn one_repos_failure_cannot_abandon_the_rest() {
        // Regression: the generated script used `continue` inside a one-iteration
        // `for` loop to skip a repo whose stash failed. That ends the loop, so a
        // single failure silently skipped every remaining repo while still printing
        // "finished".
        let plans = vec![plan("web", "main", 3), plan("api", "main", 3), plan("docs", "main", 0)];
        let script = checkout_default_argv(
            posix(),
            std::path::Path::new("/usr/bin/git"),
            &plans,
            crate::model::DirtyPolicy::Stash,
        )
        .last()
        .unwrap()
        .clone();

        assert!(
            !script.contains("continue"),
            "a per-repo skip must not use loop control: {script}"
        );
        // Every repo still has its own checkout, whatever happens to the others.
        for name in ["fe/web", "fe/api", "fe/docs"] {
            assert!(script.contains(name), "{name} missing from: {script}");
        }
        assert_eq!(script.matches("checkout main -q").count(), 3);
        // And a failed stash is reported per repo rather than aborting.
        assert_eq!(script.matches("stash failed").count(), 2);
    }

    #[test]
    fn a_value_that_would_split_or_inject_is_quoted() {
        // Quoting is decided per value now, so the invariant to hold is "nothing can
        // split or inject", not "everything is quoted" — a safe value is written bare
        // because the preview in the confirmation dialog is also read by a human.
        let script = |path: &str, branch: &str| {
            let plans = vec![(
                RepoRef {
                    category: "fe".into(),
                    name: "web".into(),
                },
                PathBuf::from(path),
                branch.to_string(),
                0,
            )];
            checkout_default_argv(
                posix(),
                std::path::Path::new("/usr/bin/git"),
                &plans,
                crate::model::DirtyPolicy::Skip,
            )
            .last()
            .unwrap()
            .clone()
        };

        // A workspace under "My Projects" must not split into two arguments.
        let s = script("/w/My Projects/web", "main");
        assert!(s.contains("-C '/w/My Projects/web'"), "{s}");

        // A `;` is legal in a git ref name and would otherwise start a second
        // command. This is the case the quoting exists for.
        let s = script("/w/web", "feat;whoami");
        assert!(s.contains("checkout 'feat;whoami'"), "{s}");

        // And a value with nothing in it to interpret stays legible.
        let s = script("/w/web", "release/2026.1");
        assert!(s.contains("checkout release/2026.1"), "{s}");
    }

    #[test]
    fn parses_gh_pr_json() {
        let json = r#"[{"number":482,"title":"feat: dashboard filters","author":{"login":"kim"},
          "headRefName":"feat/kim/filters","baseRefName":"v26","isDraft":false,
          "reviewDecision":"REVIEW_REQUIRED","url":"https://github.com/o/r/pull/482",
          "additions":604,"deletions":97,"changedFiles":18,"updatedAt":"2026-07-29T13:15:04Z"}]"#;
        let prs = parse_gh_prs(json, Some("kim"));
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 482);
        assert_eq!(prs[0].author, "kim");
        assert!(prs[0].is_mine);
        assert_eq!(prs[0].changed_files, 18);
        assert!(prs[0].updated_unix > 1_700_000_000);
    }

    #[test]
    fn empty_and_malformed_pr_json_are_safe() {
        assert!(parse_gh_prs("[]", None).is_empty());
        assert!(parse_gh_prs("not json", None).is_empty());
        assert!(parse_gh_prs("", None).is_empty());
    }

    #[test]
    fn parses_iso8601() {
        // 2026-07-29T00:00:00Z
        assert_eq!(parse_iso8601("2026-07-29T00:00:00Z"), Some(1_785_283_200));
        // Epoch itself, as a sanity anchor.
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("garbage"), None);
    }
}

/// Golden snapshots of the four bulk-action script builders.
///
/// These exist for exactly one reason: `ansi::marker` and the emitter in
/// `procs::stream` parse the `[..]`/`[OK]`/`[FAIL]`/`[SKIP]` prefixes out of this
/// generated text, so the POSIX output is a wire format and not an implementation
/// detail. Refactoring these builders to emit PowerShell as well as sh must not
/// change a byte of the sh side, and a full-string comparison is the only check
/// that actually proves it.
#[cfg(test)]
mod golden {
    use super::*;
    use crate::model::DirtyPolicy;

    // --- github actions ---------------------------------------------------

    /// 2026-07-31T03:12:48Z, the fixture's clock.
    const T0: i64 = 1_785_467_568;

    #[test]
    fn run_state_maps_every_pair_gh_emits() {
        use RunState::*;
        let cases: &[(&str, &str, RunState)] = &[
            ("queued", "", Queued),
            ("requested", "", Queued),
            ("waiting", "", Queued),
            ("pending", "", Queued),
            ("in_progress", "", Running),
            ("completed", "success", Success),
            ("completed", "failure", Failure),
            // Nothing renders a timeout differently from a failure, and a startup
            // failure is a failure you cannot even read a log for.
            ("completed", "timed_out", Failure),
            ("completed", "startup_failure", Failure),
            ("completed", "cancelled", Cancelled),
            // Not failures: "this did not apply".
            ("completed", "skipped", Skipped),
            ("completed", "neutral", Skipped),
            ("completed", "stale", Skipped),
            ("completed", "action_required", ActionRequired),
            // Completed with no conclusion is a real, momentary API state.
            ("completed", "", Unknown),
            // A conclusion gh grows after this ships must not be guessed at.
            ("completed", "some_future_thing", Unknown),
            ("something_new", "", Unknown),
            // gh is consistent about case, but nothing here should depend on it.
            ("QUEUED", "", Queued),
            ("In_Progress", "", Running),
            ("COMPLETED", "SUCCESS", Success),
        ];
        for (status, conclusion, want) in cases {
            assert_eq!(
                run_state(status, conclusion),
                *want,
                "({status}, {conclusion})"
            );
        }
    }

    #[test]
    fn garbage_parses_to_nothing_rather_than_panicking() {
        for bad in ["", "not json", "{}", "[null]", "[1,2]"] {
            assert!(parse_gh_runs(bad, T0).is_empty(), "runs: {bad:?}");
            assert!(parse_gh_workflows(bad).is_empty(), "workflows: {bad:?}");
        }
        // The empty string is not hypothetical: `gh workflow list` prints exactly
        // that for a repo with no workflows. The caller tells it apart from junk
        // by gh's exit code, never by this being empty.
        assert!(parse_gh_workflows("").is_empty());
    }

    #[test]
    fn parses_a_real_run() {
        // Captured from `gh run list` against cli/cli.
        let json = r#"[{"attempt":1,"conclusion":"success","createdAt":"2026-07-31T03:12:48Z",
          "databaseId":30601004684,"displayTitle":"Triage Scheduled Tasks","event":"schedule",
          "headBranch":"trunk","headSha":"abc123","number":5356,
          "startedAt":"2026-07-31T03:12:48Z","status":"completed",
          "updatedAt":"2026-07-31T03:13:06Z",
          "url":"https://github.com/cli/cli/actions/runs/30601004684",
          "workflowDatabaseId":235328803,"workflowName":"Triage Scheduled Tasks"}]"#;
        let runs = parse_gh_runs(json, T0 + 3600);
        assert_eq!(runs.len(), 1);
        let r = &runs[0];
        assert_eq!(r.id, 30_601_004_684);
        assert_eq!(r.number, 5356);
        assert_eq!(r.workflow_id, 235_328_803);
        assert_eq!(r.event, "schedule");
        assert_eq!(r.state, RunState::Success);
        // 03:12:48 -> 03:13:06.
        assert_eq!(r.duration_secs, 18);
    }

    #[test]
    fn a_running_run_counts_up_from_when_it_started() {
        let json = format!(
            r#"[{{"databaseId":1,"status":"in_progress","conclusion":"",
                 "startedAt":"{}","updatedAt":"{}"}}]"#,
            iso(T0),
            iso(T0)
        );
        let r = &parse_gh_runs(&json, T0 + 600)[0];
        assert_eq!(r.state, RunState::Running);
        assert_eq!(r.duration_secs, 600);
    }

    #[test]
    fn a_queued_run_has_no_duration() {
        // It has a timestamp, but nothing has run — a duration ticking up here
        // would be describing time the run did not spend.
        let json = format!(
            r#"[{{"databaseId":1,"status":"queued","conclusion":"",
                 "startedAt":"{}","updatedAt":"{}"}}]"#,
            iso(T0),
            iso(T0)
        );
        let r = &parse_gh_runs(&json, T0 + 600)[0];
        assert_eq!(r.state, RunState::Queued);
        assert_eq!(r.duration_secs, 0);
    }

    #[test]
    fn clock_skew_never_yields_a_negative_duration() {
        let json = format!(
            r#"[{{"databaseId":1,"status":"completed","conclusion":"success",
                 "startedAt":"{}","updatedAt":"{}"}}]"#,
            iso(T0 + 30),
            iso(T0)
        );
        assert_eq!(parse_gh_runs(&json, T0 + 600)[0].duration_secs, 0);
    }

    #[test]
    fn a_row_needs_an_id_and_nothing_else() {
        // No databaseId: unusable, because it is what every `gh run` takes.
        assert!(parse_gh_runs(r#"[{"number":7}]"#, T0).is_empty());

        // Only an id: renders, with everything else at its default rather than
        // taking the whole list down.
        let r = &parse_gh_runs(r#"[{"databaseId":9}]"#, T0)[0];
        assert_eq!(r.title, "");
        assert_eq!(r.state, RunState::Unknown);
        assert_eq!(r.attempt, 1);
        assert_eq!(r.updated_relative, "?");
    }

    #[test]
    fn a_ruleset_run_with_no_workflow_name_still_renders() {
        // Runs created by an org ruleset carry no workflowName. Documented API
        // behaviour, not a parse failure — dropping them would hide real CI.
        let json = r#"[{"databaseId":5,"workflowName":"","status":"completed",
                        "conclusion":"failure"}]"#;
        let r = &parse_gh_runs(json, T0)[0];
        assert_eq!(r.workflow_name, "");
        assert_eq!(r.state, RunState::Failure);
    }

    #[test]
    fn parses_workflows_including_disabled_ones() {
        let json = r#"[{"id":1,"name":"CI","path":".github/workflows/ci.yml","state":"active"},
                       {"id":2,"name":"Old","path":".github/workflows/old.yml",
                        "state":"disabled_inactivity"},
                       {"name":"no id"}]"#;
        let ws = parse_gh_workflows(json);
        assert_eq!(ws.len(), 2, "a workflow with no id cannot be filtered on");
        // The state string is passed through rather than parsed: the sidebar only
        // needs to know it is not "active", and gh may add more of these.
        assert_eq!(ws[1].state, "disabled_inactivity");
        assert_eq!(ws[1].path, ".github/workflows/old.yml");
    }

    #[test]
    fn a_workflow_with_no_dispatch_trigger_cannot_be_started_by_hand() {
        // The real cli/cli test workflow. None, not an empty input list: GitHub
        // offers no way in, and an empty form would imply there is one.
        let yaml = "name: Unit and Integration Tests\non:\n  push:\n    branches:\n      - trunk\n  pull_request:\n";
        assert_eq!(parse_dispatch_inputs(yaml), None);
    }

    #[test]
    fn on_survives_being_read_as_the_boolean_true() {
        // YAML 1.1 reads a bare `on` key as `true`. Which reading a parser gives
        // depends on its version, and a workflow file's most important key must
        // not hinge on that — so both are looked up.
        let yaml = "on:\n  workflow_dispatch:\njobs: {}\n";
        assert_eq!(parse_dispatch_inputs(yaml), Some(Vec::new()));
    }

    #[test]
    fn the_short_trigger_spellings_all_mean_dispatchable() {
        // `workflow_dispatch:` with nothing under it, in every legal shape.
        assert_eq!(parse_dispatch_inputs("on: workflow_dispatch\n"), Some(Vec::new()));
        assert_eq!(
            parse_dispatch_inputs("on: [push, workflow_dispatch]\n"),
            Some(Vec::new())
        );
        assert_eq!(parse_dispatch_inputs("on:\n  - workflow_dispatch\n"), Some(Vec::new()));
        // …and a list that does not include it is still not dispatchable.
        assert_eq!(parse_dispatch_inputs("on: [push]\n"), None);
    }

    #[test]
    fn parses_a_real_dispatch_form() {
        // Trimmed from cli/cli's deployment.yml.
        let yaml = r#"
name: Deployment
on:
  workflow_dispatch:
    inputs:
      tag_name:
        required: true
        type: string
        description: "The tag name for the release (e.g. v2.100.0)."
      environment:
        default: production
        type: environment
        description: "The deployment environment."
      dry_run:
        type: boolean
        default: true
      channel:
        type: choice
        options:
          - stable
          - beta
      untyped:
        description: no type given
"#;
        let inputs = parse_dispatch_inputs(yaml).expect("dispatchable");
        let by = |n: &str| inputs.iter().find(|i| i.name == n).unwrap().clone();

        assert_eq!(inputs.len(), 5);
        assert!(by("tag_name").required);
        assert_eq!(by("environment").default, "production");
        // A boolean default is not a string in the file, but the form and the
        // `-f k=v` argv both need one.
        assert_eq!(by("dry_run").default, "true");
        assert_eq!(by("channel").options, vec!["stable", "beta"]);
        // No `type:` means string — that is what GitHub assumes too.
        assert_eq!(by("untyped").kind, "string");
        assert!(!by("untyped").required);
    }

    #[test]
    fn junk_yaml_is_not_dispatchable_rather_than_a_panic() {
        for bad in ["", "\t\tbroken:\n  - [", "just a string", "42"] {
            assert_eq!(parse_dispatch_inputs(bad), None, "{bad:?}");
        }
    }

    /// Unix -> the ISO-8601 gh emits, for building fixtures.
    fn iso(unix: i64) -> String {
        let days = unix.div_euclid(86_400);
        let secs = unix.rem_euclid(86_400);
        // 1970-01-01 + days, the inverse of parse_iso8601's civil-from-days.
        let (mut y, mut d) = (1970, days);
        loop {
            let len = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 366 } else { 365 };
            if d < len {
                break;
            }
            d -= len;
            y += 1;
        }
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let mut m = 0;
        while d >= months[m] {
            d -= months[m];
            m += 1;
        }
        format!(
            "{y:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            m + 1,
            d + 1,
            secs / 3600,
            (secs % 3600) / 60,
            secs % 60
        )
    }

    fn name_set<'a>(names: &[&'a str]) -> std::collections::HashSet<&'a str> {
        names.iter().copied().collect()
    }

    #[test]
    fn a_folder_whose_repos_all_live_elsewhere_has_been_renamed() {
        let declared = vec!["api".to_string(), "auth".to_string()];
        // `be/` was renamed to `backend/`, so both are cloned — under another name.
        assert!(renamed_away(&declared, &name_set(&["api", "auth", "web"])));
    }

    #[test]
    fn a_folder_you_have_not_finished_cloning_keeps_its_row() {
        let declared = vec!["api".to_string(), "auth".to_string()];
        // The whole point of the declared-only row: "0 of 2 cloned" is information.
        assert!(!renamed_away(&declared, &name_set(&["api"])));
        assert!(!renamed_away(&declared, &name_set(&[])));
    }

    #[test]
    fn a_category_declaring_nothing_is_not_a_rename() {
        assert!(!renamed_away(&[], &name_set(&["api"])));
    }

    /// A fixed POSIX shell, so these assertions do not depend on `$SHELL`.
    fn posix() -> &'static Shell {
        crate::platform::test_shell(crate::platform::ShellKind::Posix)
    }

    fn git() -> &'static std::path::Path {
        std::path::Path::new("/usr/bin/git")
    }

    fn rf(category: &str, name: &str) -> RepoRef {
        RepoRef {
            category: category.into(),
            name: name.into(),
        }
    }

    #[test]
    fn golden_bulk_pull() {
        let refs = vec![rf("fe", "web"), rf("be", "api")];
        let argv = bulk_pull_argv(posix(), git(), std::path::Path::new("/w"), &refs);
        assert_eq!(argv[0], "bash");
        assert_eq!(argv[1], "-c");
        assert_eq!(
            argv[2],
            concat!(
                "echo \"[..]   fe/web\"; /usr/bin/git -C /w/web pull --rebase --autostash || echo \"[FAIL] fe/web\";\n",
                "echo \"[..]   be/api\"; /usr/bin/git -C /w/api pull --rebase --autostash || echo \"[FAIL] be/api\";\n",
                "echo \"[OK]   bulk pull finished\";\n",
            )
        );
    }

    #[test]
    fn golden_bulk_fetch() {
        let refs = vec![rf("fe", "web")];
        let argv = bulk_fetch_argv(posix(), git(), std::path::Path::new("/w"), &refs);
        assert_eq!(
            argv[2],
            "echo \"[..]   fe/web\"; /usr/bin/git -C /w/web fetch --all --prune -q \
             && echo \"[OK]   fe/web\" || echo \"[FAIL] fe/web\";\n"
        );
    }

    #[test]
    fn golden_clone_all() {
        let repos = vec![crate::clone::RepoUrl {
            name: "web".into(),
            url: "git@github.com:x/web.git".into(),
            host: "github.com".into(),
        }];
        let argv = clone_all_argv(posix(), git(), std::path::Path::new("/w"), &repos);
        assert_eq!(
            argv[2],
            concat!(
                "if [ -d /w/web ]; then echo \"[SKIP] web — folder already exists\"; ",
                "else echo \"[..]   web\"; ",
                "if /usr/bin/git clone --progress git@github.com:x/web.git /w/web; then echo \"[OK]   web\"; ",
                "else rmdir /w/web 2>/dev/null; echo \"[FAIL] web\"; fi; fi\n",
                "echo \"[OK]   clone finished\";\n",
            )
        );
    }

    fn plan(name: &str, branch: &str, dirty: u32) -> (RepoRef, PathBuf, String, u32) {
        (
            rf("fe", name),
            PathBuf::from(format!("/w/fe/{name}")),
            branch.to_string(),
            dirty,
        )
    }

    #[test]
    fn golden_checkout_clean() {
        let argv = checkout_default_argv(posix(), git(), &[plan("web", "main", 0)], DirtyPolicy::Skip);
        assert_eq!(
            argv[2],
            concat!(
                "/usr/bin/git -C /w/fe/web checkout main -q && echo \"[OK]   fe/web -> main\" ",
                "|| echo \"[FAIL] fe/web — checkout main failed\";\n",
                "echo \"[OK]   checkout finished\";\n",
            )
        );
    }

    #[test]
    fn golden_checkout_skip() {
        let argv = checkout_default_argv(posix(), git(), &[plan("web", "main", 3)], DirtyPolicy::Skip);
        assert_eq!(
            argv[2],
            concat!(
                "echo \"[SKIP] fe/web — 3 local change(s)\";\n",
                "echo \"[OK]   checkout finished\";\n",
            )
        );
    }

    #[test]
    fn golden_checkout_stash() {
        let argv = checkout_default_argv(posix(), git(), &[plan("web", "main", 2)], DirtyPolicy::Stash);
        assert_eq!(
            argv[2],
            concat!(
                "echo \"[..]   fe/web — stashing 2 change(s)\"; ",
                "if /usr/bin/git -C /w/fe/web stash push -u -q -m 'work-alley: before checkout main'; ",
                "then /usr/bin/git -C /w/fe/web checkout main -q && echo \"[OK]   fe/web -> main\" ",
                "|| echo \"[FAIL] fe/web — checkout main failed\"; ",
                "else echo \"[FAIL] fe/web — stash failed, left on its current branch\"; fi;\n",
                "echo \"[OK]   checkout finished\";\n",
            )
        );
    }

    #[test]
    fn golden_checkout_discard() {
        let argv = checkout_default_argv(posix(), git(), &[plan("web", "main", 1)], DirtyPolicy::Discard);
        assert_eq!(
            argv[2],
            concat!(
                "echo \"[..]   fe/web — discarding 1 change(s)\"; ",
                "if /usr/bin/git -C /w/fe/web reset --hard -q && /usr/bin/git -C /w/fe/web clean -fdq; ",
                "then /usr/bin/git -C /w/fe/web checkout main -q && echo \"[OK]   fe/web -> main\" ",
                "|| echo \"[FAIL] fe/web — checkout main failed\"; ",
                "else echo \"[FAIL] fe/web — could not clean, left alone\"; fi;\n",
                "echo \"[OK]   checkout finished\";\n",
            )
        );
    }

    /// A fixed PowerShell, for the twins below.
    fn pwsh() -> &'static Shell {
        crate::platform::test_shell(crate::platform::ShellKind::PowerShell)
    }

    /// The PowerShell emitter, exercised on the Linux dev box.
    ///
    /// This is the reason every builder takes a `&Shell` instead of calling
    /// `platform::shell()` itself. The single most dangerous difference is that
    /// PowerShell has no `&&` or `||` and `if (cmd)` tests a command's *output*
    /// rather than its exit status — so a naive translation marks every step as
    /// succeeded, silently, including the ones that failed.
    #[test]
    fn powershell_branches_on_the_exit_code_and_never_on_output() {
        let refs = vec![rf("fe", "web")];
        let argv = bulk_fetch_argv(pwsh(), git(), std::path::Path::new("/w"), &refs);

        // The shell is invoked non-interactively with no profile, so a user's
        // PowerShell profile cannot change what this script means.
        assert_eq!(
            &argv[..argv.len() - 1],
            &[
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command"
            ]
        );

        let script = argv.last().unwrap();
        assert_eq!(
            script,
            concat!(
                "Write-Output '[..]   fe/web'; ",
                "& /usr/bin/git -C /w/web fetch --all --prune -q; ",
                "if ($LASTEXITCODE -eq 0) { Write-Output '[OK]   fe/web' } ",
                "else { Write-Output '[FAIL] fe/web' }\n",
            )
        );
        // The trap this test exists for.
        assert!(!script.contains("&&"), "PowerShell has no && : {script}");
        assert!(!script.contains("||"), "PowerShell has no || : {script}");
    }

    #[test]
    fn powershell_tests_a_directory_with_test_path_not_with_brackets() {
        let repos = vec![crate::clone::RepoUrl {
            name: "web".into(),
            url: "git@github.com:x/web.git".into(),
            host: "github.com".into(),
        }];
        let script = clone_all_argv(pwsh(), git(), std::path::Path::new("/w"), &repos)
            .last()
            .unwrap()
            .clone();
        assert!(script.contains("Test-Path -LiteralPath /w/web -PathType Container"), "{script}");
        // `rmdir` has no PowerShell spelling, and Remove-Item without -Recurse is
        // the equivalent: it refuses a directory that has anything in it.
        assert!(script.contains("Remove-Item -LiteralPath /w/web"), "{script}");
        assert!(!script.contains("-Recurse"), "must not be able to delete content: {script}");
        assert!(!script.contains("[ -d"), "{script}");
    }

    #[test]
    fn powershell_quotes_with_doubled_apostrophes_and_keeps_backslash_paths() {
        let plans = vec![(
            rf("fe", "web"),
            PathBuf::from(r"C:\w\My Projects\web"),
            "main".to_string(),
            0u32,
        )];
        let script = checkout_default_argv(pwsh(), git(), &plans, DirtyPolicy::Skip)
            .last()
            .unwrap()
            .clone();
        // Backslashes are left alone for PowerShell — translating them, which is
        // required for Git Bash, would be wrong here.
        assert!(script.contains(r"'C:\w\My Projects\web'"), "{script}");
    }

    #[test]
    fn a_powershell_shell_cannot_run_a_dot_sh_file() {
        // The one thing the fallback genuinely cannot do. Returning None makes the
        // caller report "install Git for Windows" instead of running the wrong thing.
        assert!(pwsh()
            .file_argv(std::path::Path::new("/w/scripts/deploy.sh"), &[])
            .is_none());
        assert!(posix()
            .file_argv(std::path::Path::new("/w/scripts/deploy.sh"), &[])
            .is_some());
    }

    #[test]
    fn onboarding_is_over_once_the_config_says_so() {
        assert!(!onboarding_state(false, false, false));
        assert!(onboarding_state(false, false, true));
        // The flag is off, so the in-process bit is not consulted at all: the saved
        // config is the whole answer.
        assert!(!onboarding_state(false, true, false));
    }

    #[test]
    fn forcing_first_run_still_lets_the_screen_be_left() {
        // The bug this exists for: with the flag on, a saved config was ignored —
        // correct, that is the point — but so was pressing Done, so the takeover
        // returned immediately and its exit could not be reviewed at all.
        assert!(!onboarding_state(true, false, true));
        assert!(onboarding_state(true, true, true));
        assert!(onboarding_state(true, true, false));
    }
}
