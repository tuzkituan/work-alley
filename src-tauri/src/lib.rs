mod ansi;
mod commands;
mod config;
mod docker;
mod error;
mod events;
mod gate;
mod git;
mod model;
mod packages;
mod paths;
mod pkg;
mod procs;
mod scripts;
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

        let found = paths::discover_repos(&root, &model::Category::ALL);
        println!("\n{} repos on disk", found.len());

        let began = std::time::Instant::now();
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(cfg.scan_concurrency));
        let mut set = tokio::task::JoinSet::new();
        for (repo, path) in found {
            let permit = sem.clone();
            let git = git.clone();
            let stale = cfg.stale_days;
            let ui = cfg.ui_package_name.clone();
            set.spawn(async move {
                let _p = permit.acquire_owned().await;
                git::scan_one(git, repo, path, stale, ui).await
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
                r.ui_dep.resolved.clone().unwrap_or_else(|| "-".into()),
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

            // The saved workspace wins; the guess is only for a first run. Having
            // no workspace at all is a normal state now — the UI asks for one.
            let cfg = config::Config::load(&app_dir, paths::guess_workspace_root());
            let workspace_root = cfg.workspace_root.clone();

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

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let tc = toolchain::probe().await;
                for w in &tc.warnings {
                    log::warn!("{w}");
                }
                state.set_toolchain(tc);
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
            commands::list_packages,
            commands::list_pull_requests,
            commands::list_changed_files,
            commands::repo_commits,
            commands::list_runs,
            commands::get_run_log,
            commands::cancel_run,
            commands::dismiss_run,
            commands::prepare_action,
            commands::run_action,
            commands::cancel_action,
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
                }
            }
        });
}
