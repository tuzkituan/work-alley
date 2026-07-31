mod accounts;
mod ansi;
mod autofetch;
mod chores;
mod clone;
mod commands;
mod config;
mod creds;
mod deps;
mod detect;
mod devwatch;
mod docker;
mod error;
mod events;
mod gate;
mod git;
mod model;
mod packages;
mod paths;
mod pkg;
mod platform;
mod procs;
mod pty;
mod readiness;
mod runner;
mod scripts;
mod setup;
mod state;
mod toolchain;

use state::AppState;
use std::sync::Arc;
use tauri::{Emitter, Manager, RunEvent};

/// Headless scan, for `work-alley --scan-once`.
///
/// Exercises the same toolchain probe, discovery and scanner the window uses, so
/// its output can be diffed against a terminal to prove the dashboard is telling
/// the truth.
pub fn scan_once_cli() {
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(async {
        let root = match paths::discover_workspace_root() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(2);
            }
        };
        let cfg = config::Config::defaults(root.clone());
        let tc = toolchain::probe().await;

        println!("workspace: {}", root.display());
        for t in tc.to_infos() {
            println!(
                "  {:8} {:10} {}",
                t.name,
                t.version.unwrap_or_else(|| "-".into()),
                t.path.unwrap_or_else(|| "NOT FOUND".into())
            );
        }
        for w in &tc.warnings {
            println!("  warning: {w}");
        }

        let git = match tc.require("git") {
            Ok(g) => g,
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(2);
            }
        };

        let groups: Vec<String> = paths::discover_groups(&root)
            .into_iter()
            .map(|(g, _)| g)
            .collect();
        println!("groups: {}", groups.iter().map(|g| if g.is_empty() { "<root>".to_string() } else { g.clone() }).collect::<Vec<_>>().join(" "));
        let found = paths::discover_repos(&root, &groups);
        println!("\n{} repos on disk", found.len());

        let tracked_name = commands::tracked_package(&root, &cfg).map(|t| t.name);
        println!(
            "shared package: {}",
            tracked_name.as_deref().unwrap_or("<none detected>")
        );

        let began = std::time::Instant::now();
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.scan_concurrency));
        let mut set = tokio::task::JoinSet::new();
        for (repo, path) in found {
            let permit = sem.clone();
            let git = git.clone();
            let stale = cfg.stale_days;
            let tracked = tracked_name.clone();
            set.spawn(async move {
                let _p = permit.acquire_owned().await;
                git::scan_one(git, repo, path, stale, tracked).await
            });
        }

        let mut rows = Vec::new();
        while let Some(Ok(r)) = set.join_next().await {
            rows.push(r);
        }
        let elapsed = began.elapsed();
        rows.sort_by_key(|r| r.repo.key());

        println!(
            "\n{:<46} {:<34} {:>6} {:>6} {:>6} {:<10} {}",
            "repo", "branch", "dirty", "ahead", "behind", "ui", "stale"
        );
        for r in &rows {
            let (a, b) = match r.sync {
                model::SyncState::Diverged { ahead, behind } => (ahead, behind),
                _ => (0, 0),
            };
            println!(
                "{:<46} {:<34} {:>6} {:>6} {:>6} {:<10} {}",
                r.repo.key(),
                r.branch.clone().unwrap_or_else(|| {
                    if r.detached {
                        "(detached)".into()
                    } else {
                        "-".into()
                    }
                }),
                r.dirty_count + r.untracked_count,
                a,
                b,
                r.tracked_dep.resolved.clone().unwrap_or_else(|| "-".into()),
                match r.stale {
                    model::StaleState::Stale { days, .. } => format!("{days}d"),
                    model::StaleState::Fresh { .. } => "fresh".into(),
                    model::StaleState::Unknown => "?".into(),
                }
            );
            if let Some(e) = &r.error {
                println!("    error: {e}");
            }
        }

        let errors = rows.iter().filter(|r| r.error.is_some()).count();
        println!(
            "\nscanned {} repos in {:?} ({} with errors)",
            rows.len(),
            elapsed,
            errors
        );

        let status = docker::status(&tc).await;
        println!("containers: {}", serde_json::to_string(&status).unwrap_or_default());
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let app_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));

            let mut cfg = config::Config::load(&app_dir, paths::guess_workspace_root());

            // The folder that was open last time, reopened — which does commit the
            // app to scanning it before the window is fully useful. That cost is the
            // reason this was once a picker every launch, and `reopenLastWorkspace`
            // in Settings turns it back into one. `WORK_ALLEY_ROOT` opens regardless:
            // an env var is an instruction for this launch, not a memory of an old
            // one. See `config::startup_root`.
            let workspace_root = config::startup_root(&cfg);

            // The folder we just declined to open has to stay reachable. It normally
            // sits in `recent_roots` already, but a root that arrived from the env var
            // or the first-run guess never went through `switch_workspace`, so it was
            // never recorded — and without this it would simply disappear.
            let saved = cfg.workspace_root.clone();
            if !cfg.root_forced
                && paths::is_workspace(&saved)
                && cfg.recent_roots.first() != Some(&saved)
            {
                cfg.remember_root(saved);
                let _ = cfg.save(&app_dir);
            }

            // State is managed *now*, with an empty toolchain. Deferring this until
            // the probe finished created a race: the probe shells out to an
            // interactive shell (needed to pick up nvm) and can take seconds, and
            // any command issued in that window failed with "state not managed" —
            // which silently killed the first scan.
            let state = Arc::new(AppState::new(
                workspace_root,
                app_dir,
                cfg,
                toolchain::Toolchain::default(),
            ));
            app.manage(state.clone());

            // Keeps ahead/behind honest without anyone pressing Fetch. Spawned
            // before the toolchain probe finishes on purpose — it waits out its own
            // startup delay and re-reads the config every cycle, so there is nothing
            // to sequence it after.
            {
                let handle = app.handle().clone();
                let state = state.clone();
                tauri::async_runtime::spawn(autofetch::run(handle, state));
            }

            // Corrects rows for dev servers this app no longer supervises — one
            // killed from a terminal, or one whose supervisor went with a reload.
            // Same shape as auto-fetch, and for the same reason: nothing to
            // sequence it after, and it should never be noticed.
            {
                let handle = app.handle().clone();
                let state = state.clone();
                tauri::async_runtime::spawn(devwatch::run(handle, state));
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let tc = toolchain::probe().await;
                for w in &tc.warnings {
                    log::warn!("{w}");
                }
                state.set_toolchain(tc);
                // Computed once here rather than per bootstrap: it costs a `git config`
                // pair and an ssh-agent probe, and the answer only changes when the
                // toolchain does — which is exactly when `refresh_toolchain` re-runs it.
                let readiness = readiness::probe(&state.toolchain()).await;
                state.set_readiness(readiness);
                // The frontend waits for this before scanning, so it never asks for
                // a tool we have not resolved yet.
                let _ = handle.emit(events::TOOLS_READY, ());
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::pick_workspace,
            commands::set_workspace,
            commands::close_workspace,
            commands::pick_folder,
            commands::parse_clone_urls,
            commands::get_config,
            commands::set_config,
            commands::start_scan,
            commands::cancel_scan,
            commands::get_last_scan,
            commands::rescan_repo,
            commands::recent_commits,
            commands::docker_status,
            commands::list_dev_servers,
            commands::list_branches,
            commands::list_stashes,
            commands::file_diff,
            commands::stage_paths,
            commands::unstage_paths,
            commands::list_packages,
            commands::list_package_versions,
            commands::check_package_updates,
            commands::forget_dev,
            commands::preview_run_command,
            commands::set_run_command,
            commands::list_repo_packages,
            commands::check_repo_package_updates,
            commands::list_dep_versions,
            commands::list_setup_plan,
            commands::refresh_toolchain,
            commands::complete_onboarding,
            commands::forget_recent_root,
            commands::list_git_accounts,
            commands::save_git_account,
            commands::delete_git_account,
            commands::preview_ssh_config,
            commands::apply_ssh_config,
            commands::preview_checkout,
            commands::list_pull_requests,
            commands::list_workflows,
            commands::list_workflow_runs,
            commands::workflow_dispatch_inputs,
            commands::list_changed_files,
            commands::repo_commits,
            commands::list_runs,
            commands::get_run_log,
            commands::cancel_run,
            commands::dismiss_run,
            commands::prepare_action,
            commands::run_action,
            commands::cancel_action,
            commands::term_write,
            commands::term_resize,
            commands::term_close,
            commands::term_list,
            commands::term_scrollback,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Work Alley window")
        .run(|app, event| {
            // Must be RunEvent, not WindowEvent::CloseRequested — closing the last
            // window is only one exit path; tray quit, app.exit() and an OS session
            // end are others, and each must still reap the dev servers.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    procs::kill_all_now(state.inner());
                    // Terminal shells too, for the same reason: without this every
                    // integrated terminal outlives the app that opened it.
                    pty::kill_all_now(state.inner());
                }
            }
        });
}
