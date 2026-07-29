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

    let declared = declared_counts(&root);
    let mut categories = Vec::new();
    let mut repos = Vec::new();

    for c in Category::ALL {
        let dir = crate::paths::category_dir(&root, c);
        let found = crate::paths::discover_repos(&root, &[c]);
        categories.push(CategoryInfo {
            category: c,
            present: dir.is_dir(),
            repo_count: found.len() as u32,
            declared_count: *declared.get(c.dir()).unwrap_or(&0),
        });
        repos.extend(found.into_iter().map(|(r, _)| r));
    }

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
        workspace_root: root,
        categories,
        repos,
        config: cfg,
        tools: tc.to_infos(),
        editors: crate::toolchain::detect_editors(&tc.path_env),
        scripts: crate::scripts::catalog(),
        warnings,
    })
}

/// Counts per category in repos.json, so the UI can show "0 of 38 cloned" for be/.
fn declared_counts(root: &std::path::Path) -> std::collections::BTreeMap<String, u32> {
    let mut out = std::collections::BTreeMap::new();
    let Ok(text) = std::fs::read_to_string(root.join("repos.json")) else {
        return out;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return out;
    };
    for c in Category::ALL {
        let n = json
            .get(c.dir())
            .and_then(|v| v.as_array())
            .map(|a| a.len() as u32)
            .unwrap_or(0);
        out.insert(c.dir().to_string(), n);
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

/// Opens a native folder picker and switches to the chosen workspace.
///
/// Returns None when the user cancels — cancelling is not an error.
#[tauri::command]
pub async fn pick_workspace(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Option<Bootstrap>> {
    use tauri_plugin_dialog::DialogExt;

    let start = state.workspace_root();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Choose a workspace folder");
    if start.is_dir() {
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

/// Switches to an already-known path, e.g. from the recents list.
#[tauri::command]
pub async fn set_workspace(
    path: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Bootstrap> {
    switch_workspace(&app, state.inner(), PathBuf::from(path)).await
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
            "{} has no be/ fe/ sa/ ui/ folder with repos in it, and no repos.json",
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

    let mut status = crate::git::scan_one(
        git,
        repo.clone(),
        path,
        cfg.stale_days,
        cfg.ui_package_name.clone(),
    )
    .await;
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
    let categories = crate::git::categories_or_all(opts.categories.clone());

    let Ok(git) = state.toolchain().require("git") else {
        let _ = app.emit(
            events::SCAN_ERROR,
            serde_json::json!({ "scanId": scan_id, "message": "git is not available" }),
        );
        return;
    };

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
        let ui_pkg = cfg.ui_package_name.clone();
        let repo_for_err = repo.clone();
        let path_for_err = path.clone();

        set.spawn(async move {
            let _p = permit.acquire_owned().await;
            // scan_one never returns Err — a failure lands in RepoStatus::error.
            let r = crate::git::scan_one(git, repo, path, stale_days, ui_pkg).await;
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

    // --- blazeup-ui drift baseline -------------------------------------------
    let mut candidates: Vec<String> = repos
        .iter()
        .filter_map(|r| r.ui_dep.resolved.clone())
        .collect();
    let published = crate::pkg::read_own_version(
        &root
            .join(Category::Ui.dir())
            .join("blazeup-lib-ui"),
    )
    .await;
    let mut ui_latest_source = None;
    if let Some(p) = published.clone() {
        if let Some(cleaned) = crate::pkg::clean_version(&p) {
            candidates.push(cleaned);
        }
    }
    let ui_latest = crate::pkg::max_version(candidates);
    if ui_latest.is_some() {
        ui_latest_source = Some(
            if published.as_deref().and_then(crate::pkg::clean_version).as_deref()
                == ui_latest.as_deref()
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
        ui_latest,
        ui_latest_source,
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
pub async fn list_dev_servers(state: State<'_, Arc<AppState>>) -> AppResult<Vec<DevServer>> {
    Ok(state.dev_servers())
}

#[tauri::command]
pub async fn list_branches(
    repo: RepoRef,
    state: State<'_, Arc<AppState>>,
) -> AppResult<Vec<String>> {
    crate::git::list_branches(state.inner(), &repo)
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
pub async fn dismiss_run(run_id: String, state: State<'_, Arc<AppState>>) -> AppResult<()> {
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
            let run_id = state
                .dev
                .lock()
                .unwrap()
                .get(&tkey)
                .cloned()
                .ok_or_else(|| AppError::DevNotRunning(tkey.clone()))?;
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
        "openInTerminal" => {
            procs::open_terminal(&state.toolchain(), &pending.cwd, &pending.argv)?;
            Ok(String::new())
        }
        "packageInTerminal" => {
            // dnf needs root, and a GUI cannot ask for a password. The terminal can.
            procs::open_terminal(&state.toolchain(), &pending.cwd, &pending.argv)?;
            Ok(String::new())
        }
        "openInEditor" => {
            // Detached: a GUI editor outlives this app, and streaming its output
            // into the run pane would be noise.
            procs::spawn_detached(&state.toolchain(), &pending.cwd, &pending.argv)?;
            Ok(String::new())
        }
        kind => {
            // Only worth tagging when a run spans several repos; on a single-repo
            // run the prefix is on every line and says nothing.
            let line_repo = if pending.targets.len() > 1 {
                pending.repo.as_ref().map(|r| r.key())
            } else {
                None
            };
            let run_id = procs::spawn_run(
                &app,
                SpawnSpec {
                    argv: pending.argv,
                    cwd: pending.cwd,
                    env: pending.env,
                    kind: kind.to_string(),
                    title: pending.intent.title.clone(),
                    repo: pending.repo.clone(),
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
                    line_repo,
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
        .unwrap_or_else(|| match crate::pkg::task_port(&path, &task) {
            Some((p, s)) => (Some(p), Some(s)),
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
    state.persist_dev_runs();

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
            })
        }

        ActionSpec::Package { id, op } => {
            let plan = crate::packages::plan(&tc, &id, op).map_err(AppError::Invalid)?;
            let entry = crate::packages::find(&id)
                .ok_or_else(|| AppError::Invalid(format!("unknown package '{id}'")))?;
            let verb = match op {
                PackageOp::Install => "Install",
                PackageOp::Upgrade => "Upgrade",
                PackageOp::Remove => "Remove",
            };

            Ok(Built {
                // Terminal operations are dispatched like openInTerminal.
                kind: if plan.in_terminal {
                    "packageInTerminal".into()
                } else {
                    "package".into()
                },
                title: format!("{verb} {}", entry.label),
                description: plan.description,
                argv: plan.argv,
                preview: None,
                // The workspace is a safe cwd; none of these touch it.
                cwd: root.clone(),
                env: vec![],
                danger: plan.danger,
                warnings: plan.warnings,
                typed_confirm: plan.typed_confirm,
                repo: None,
                targets: vec![],
                task: None,
                read_only: false,
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
                warnings.push(
                    "These are signalled directly. Anything unsaved in them is lost.".into(),
                );
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

            let mut argv = vec!["kill".to_string(), "-TERM".to_string()];
            argv.extend(holders.iter().map(|(pid, _)| pid.to_string()));

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
                cfg.ui_package_name.clone(),
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
                    cfg.ui_package_name.clone(),
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
                argv: bulk_pull_argv(&git, &root, &refs),
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
                    })
                }
                None => {
                    let all: Vec<RepoRef> = crate::paths::discover_repos(&root, &Category::ALL)
                        .into_iter()
                        .map(|(r, _)| r)
                        .collect();
                    Ok(Built {
                        kind: "fetchAll".into(),
                        title: format!("Fetch all {} repos", all.len()),
                        description: "Update remote refs across the workspace.".into(),
                        argv: bulk_fetch_argv(&git, &root, &all),
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
                argv: bulk_fetch_argv(&git, &root, &refs),
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
            })
        }

        ActionSpec::DevStart { repo, task } => {
            let task = task.unwrap_or_else(|| "dev".to_string());
            if task != "dev" && task != "storybook" {
                return Err(AppError::Invalid(format!("unknown task '{task}'")));
            }
            let cwd = crate::paths::resolve_repo(&root, &repo)?;
            let key = repo.key();
            let tkey = crate::state::task_key(&key, &task);

            if state.dev.lock().unwrap().contains_key(&tkey) {
                return Err(AppError::DevAlreadyRunning(tkey));
            }
            if !crate::pkg::available_tasks(&cwd).contains(&task) {
                return Err(AppError::Invalid(format!(
                    "{key} has no \"{task}\" script in package.json"
                )));
            }

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
                    let (tool, args) = crate::pkg::task_command(&cwd, &task).ok_or_else(|| {
                        AppError::Invalid(format!("{key} has no package.json — nothing to run"))
                    })?;
                    let bin = tc.require(tool)?;
                    let mut argv = vec![bin.display().to_string()];
                    argv.extend(args);
                    argv
                }
            };

            let mut warnings = Vec::new();
            let port = cfg
                .port_overrides
                .get(&tkey)
                .copied()
                .or_else(|| crate::pkg::task_port(&cwd, &task).map(|(p, _)| p));
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
                title: if task == "storybook" {
                    format!("Start Storybook — {key}")
                } else {
                    format!("Start dev — {key}")
                },
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
                task: Some(task),
            })
        }

        ActionSpec::DevStop { repo, task } => {
            let task = task.unwrap_or_else(|| "dev".to_string());
            let key = repo.key();
            let tkey = crate::state::task_key(&key, &task);
            let server = state
                .dev_server_for(&tkey)
                .ok_or_else(|| AppError::DevNotRunning(tkey.clone()))?;
            Ok(Built {
                kind: "devStop".into(),
                title: if task == "storybook" {
                    format!("Stop Storybook — {key}")
                } else {
                    format!("Stop dev — {key}")
                },
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
            })
        }

        ActionSpec::Script { script, args } => {
            let desc = crate::scripts::find(&script)?;
            if desc.mode == ScriptMode::TerminalOnly {
                return Err(AppError::ScriptInteractive(desc.file.clone()));
            }
            let args = crate::scripts::validate_args(&desc, &args)?;
            let path = script_path(&root, &desc.file)?;

            let mut warnings = crate::scripts::extra_warnings(&desc, &args);
            for t in &desc.required_tools {
                if !tc.has(t) {
                    warnings.push(format!("{t} is not installed — this script needs it."));
                }
            }
            if let Some(meaning) = &desc.non_zero_exit_meaning {
                warnings.push(format!("A non-zero exit here means: {meaning}."));
            }

            let mut argv = vec!["bash".to_string(), path.display().to_string()];
            argv.extend(args.clone());

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
            })
        }

        ActionSpec::OpenInTerminal { script, repo } => {
            let desc = crate::scripts::find(&script)?;
            let path = script_path(&root, &desc.file)?;
            // fe-auto-create-pr.sh auto-detects the repo from $PWD and only shows
            // its repo menu when it can't — so presetting cwd removes the most
            // error-prone prompt.
            let cwd = match &repo {
                Some(r) => crate::paths::resolve_repo(&root, r)?,
                None => root.clone(),
            };
            Ok(Built {
                kind: "openInTerminal".into(),
                title: format!("{} — in a terminal", desc.title),
                description: "This script prompts interactively, so it opens in a real terminal."
                    .into(),
                argv: vec!["bash".to_string(), path.display().to_string()],
                cwd,
                env: vec![],
                danger: desc.danger,
                warnings: vec![
                    "It runs in its own terminal window, not in the output pane.".into(),
                ],
                typed_confirm: None,
                repo: repo.clone(),
                targets: repo.map(|r| vec![r]).unwrap_or_default(),
                preview: None,
                task: None,
                read_only: false,
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

/// Bulk git over N repos, with every path absolute and pre-validated.
fn bulk_pull_argv(git: &std::path::Path, root: &std::path::Path, refs: &[RepoRef]) -> Vec<String> {
    let mut script = String::new();
    for r in refs {
        let p = crate::paths::repo_path(root, r);
        script.push_str(&format!(
            "echo \"[..]   {key}\"; {git} -C {path} pull --rebase --autostash || echo \"[FAIL] {key}\";\n",
            key = r.key(),
            git = git.display(),
            path = p.display(),
        ));
    }
    script.push_str("echo \"[OK]   bulk pull finished\";\n");
    vec!["bash".into(), "-c".into(), script]
}

fn bulk_fetch_argv(git: &std::path::Path, root: &std::path::Path, refs: &[RepoRef]) -> Vec<String> {
    let mut script = String::new();
    for r in refs {
        let p = crate::paths::repo_path(root, r);
        script.push_str(&format!(
            "{git} -C {path} fetch --all --prune -q && echo \"[OK]   {key}\" || echo \"[FAIL] {key}\";\n",
            key = r.key(),
            git = git.display(),
            path = p.display(),
        ));
    }
    vec!["bash".into(), "-c".into(), script]
}

/// The toolbox listing. Read-only.
#[tauri::command]
pub async fn list_packages(state: State<'_, Arc<AppState>>) -> AppResult<Vec<PackageStatus>> {
    Ok(crate::packages::list(&state.toolchain()).await)
}

// ------------------------------------------------------------- repo detail ---

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
        "number,title,author,headRefName,baseRefName,isDraft,reviewDecision,url,additions,deletions,changedFiles,updatedAt",
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

/// Cached for the process lifetime — the login does not change while running.
async fn gh_current_user(gh: &std::path::Path, tc: &crate::toolchain::Toolchain) -> Option<String> {
    use std::sync::OnceLock;
    static ME: OnceLock<Option<String>> = OnceLock::new();
    if let Some(v) = ME.get() {
        return v.clone();
    }

    let mut cmd = tokio::process::Command::new(gh);
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
