//! Keeps ahead/behind and staleness true on their own.
//!
//! Every sync number the UI shows is computed from *local* refs — `git status
//! --porcelain=v2 --branch` cannot know about a commit nobody has fetched. So a
//! workspace left open reported "in sync" with increasing confidence and decreasing
//! accuracy, and the only cure was remembering to press Fetch.
//!
//! Deliberately not a run: firing a visible `fetchAll` every few minutes would put a
//! chip in the output pane and a spinner on the folder every cycle, which is a lot of
//! noise for something whose entire job is to be invisible. This talks to git
//! directly, the way a scan does, and reports only by refreshing the rows it changed.

use crate::events;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Ceiling per repo. A fetch talks to the network, so without this one unreachable
/// remote — a VPN-only host, a laptop that just slept — stalls the cycle behind it.
const FETCH_TIMEOUT: Duration = Duration::from_secs(45);

/// How long after launch the first cycle runs.
///
/// Not immediately: startup is already probing the toolchain and scanning whatever
/// folder is open, and adding 40 network calls to that is the one moment it would be
/// felt.
const FIRST_DELAY: Duration = Duration::from_secs(90);

/// The background loop. Spawned once at startup and lives for the process.
///
/// Re-reads the config every cycle rather than capturing it, so changing the interval
/// or turning the whole thing off takes effect at the next tick instead of needing a
/// restart.
pub async fn run(app: AppHandle, state: Arc<AppState>) {
    tokio::time::sleep(FIRST_DELAY).await;

    loop {
        let minutes = state.config().auto_fetch_minutes;
        // Off. Still wake up periodically, because the setting can be turned back on
        // while the app runs and the loop is the only thing that would notice.
        if minutes == 0 {
            tokio::time::sleep(Duration::from_secs(60)).await;
            continue;
        }

        cycle(&app, &state).await;
        tokio::time::sleep(Duration::from_secs(minutes.saturating_mul(60))).await;
    }
}

/// One pass over the open workspace.
async fn cycle(app: &AppHandle, state: &Arc<AppState>) {
    let root = state.workspace_root();
    // No workspace open is the normal state on the welcome screen, not a problem.
    if root.as_os_str().is_empty() || !root.is_dir() {
        return;
    }
    let Ok(git) = state.toolchain().require("git") else {
        return;
    };

    let repos = crate::paths::discover_all(&root);
    if repos.is_empty() {
        return;
    }

    let cfg = state.config();
    let tracked = crate::commands::tracked_package(&root, &cfg).map(|t| t.name);

    // The same bound a scan uses, and for the same reason: 40 concurrent git
    // processes is worse than 8, on the network as much as on the CPU.
    let permits = Arc::new(tokio::sync::Semaphore::new(cfg.scan_concurrency.max(1)));
    let mut set = tokio::task::JoinSet::new();

    for (repo, path) in repos {
        // Nothing that would collide with what the user is doing right now. A repo
        // mid-pull or mid-checkout has an index lock, and a background fetch is not
        // worth failing that for.
        if state.is_repo_busy(&repo.key()) {
            continue;
        }

        let permits = permits.clone();
        let git = git.clone();
        let stale_days = cfg.stale_days;
        let tracked = tracked.clone();
        set.spawn(async move {
            let _p = permits.acquire_owned().await;
            fetch_one(&git, &path).await;
            // Re-read after fetching: the ahead/behind and stale numbers are exactly
            // what just changed, and a row that is not refreshed shows the state the
            // fetch was supposed to correct.
            crate::git::scan_one(git, repo, path, stale_days, tracked).await
        });
    }

    let mut refreshed = 0usize;
    while let Some(joined) = set.join_next().await {
        let Ok(mut status) = joined else { continue };
        status.tasks = state.dev_servers_for_repo(&status.repo.key());
        // The frontend's `scan:repo` handler updates one row and ignores the scan id,
        // so this refreshes rows without starting a scan the UI would show a spinner
        // for. See the handler in ipc/bridge.ts.
        let _ = app.emit(
            events::SCAN_REPO,
            events::ScanRepo {
                scan_id: "auto-fetch".to_string(),
                repo: status,
            },
        );
        refreshed += 1;
    }

    if refreshed > 0 {
        log::debug!("auto-fetch refreshed {refreshed} repo(s)");
    }
}

/// `git fetch` for one repo, failing quietly.
///
/// Quiet on purpose. A fetch fails for entirely ordinary reasons — offline, VPN
/// down, an ssh-agent that has forgotten the key — and a background task cannot
/// treat any of them as something to interrupt the user about. The visible Fetch
/// action still reports failures in full; this one leaves the row showing the last
/// state it could confirm.
async fn fetch_one(git: &Path, path: &PathBuf) {
    let mut cmd = tokio::process::Command::new(git);
    // The one git child in the app that was built by hand instead of going through
    // `harden`, and it cost exactly what that function's comment warns about: on
    // Windows this process owns no console, so every one of these fetches allocated
    // its own — a wall of `git.exe` windows appearing every auto-fetch cycle, one per
    // repo. `harden` is also what pins GIT_SSH_COMMAND to BatchMode, which a
    // background fetch wants more than anything else here does.
    crate::git::harden(&mut cmd);
    cmd.current_dir(path)
        .args([
            "fetch",
            "--all",
            "--prune",
            "--quiet",
            // A background refresh is about this repo's own remotes. Recursing would
            // multiply one cycle into a fetch per submodule of every repo.
            "--no-recurse-submodules",
        ])
        // Never prompt. Without these a repo whose credentials have expired hangs on
        // a username prompt until the timeout, every cycle, forever — and with stdin
        // closed it would hang rather than fail on some git versions.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "true")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    match tokio::time::timeout(FETCH_TIMEOUT, cmd.status()).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => log::debug!("auto-fetch {}: {e}", path.display()),
        Err(_) => log::debug!("auto-fetch {}: timed out", path.display()),
    }
}
