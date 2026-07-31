//! Keeps the dev-server rows honest about processes this app no longer owns.
//!
//! `procs::finish` is authoritative for anything we are supervising: it sees the
//! exit and updates the row. Everything else it cannot see — a server killed from a
//! terminal, one whose supervisor died with a webview reload, a row parked mid-stop
//! by a stop that had nothing left to stop — and those rows used to sit on "up" or
//! "exiting" until the workspace was switched.
//!
//! Deliberately not wired to `dev:changed`: this emits that event, and a probe that
//! runs on it is a loop. It is a slow poll, like `autofetch`, and for the same
//! reason — it exists to be invisible.
//!
//! The decision itself is `verdict`, which is pure. Whether a pid is alive and
//! whether a port answers are inputs, not things it goes and finds out, so every
//! rule here is testable on a machine with no dev servers on it.

use crate::events;
use crate::model::{DevServer, DevState};
use crate::state::{task_key, AppState};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// How often the sweep runs. Slow enough to be free, fast enough that a server you
/// just killed in a terminal is corrected before you go looking for the button.
const SWEEP_EVERY: Duration = Duration::from_secs(15);

/// How long a row may sit in `Stopping` before it is simply gone.
///
/// `terminate` asks, waits out its grace period, then kills — so a stop that is
/// working resolves well inside this. Anything still here has no process behind it.
const STOP_GRACE: i64 = 20;

/// How long a row may sit in `Starting` with no live run.
///
/// Matches the port watchdog's own 60s window in `commands::register_dev`: before
/// that expires, "starting" is still a fair description.
const START_GRACE: i64 = 60;

/// What the sweep concludes about one row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Leave it alone.
    Keep,
    /// The process is gone. Keep the row, marked crashed, so it can be read.
    Retire,
    /// Nothing left to say about it. Drop the row entirely.
    Forget,
}

/// Whether a row still describes something real.
///
/// `supervised` short-circuits everything: for a run we spawned, `finish` is the
/// authority and will say so the moment it ends — probing it would be work to
/// second-guess a better answer. (It also matters because `pid` is 0 until
/// `hydrate_pid` finds the group, so a young supervised row looks dead here.)
pub fn verdict(d: &DevServer, supervised: bool, pid_alive: bool, port_open: bool, now: i64) -> Verdict {
    if supervised {
        return Verdict::Keep;
    }
    let age = now.saturating_sub(d.started_unix);

    match d.state {
        // Both signals must agree before an up row is retired. `nodemon` and
        // `cargo watch` re-exec on every change, so the pid moves while the port
        // stays bound — pid alone would make those rows flap between up and dead.
        DevState::Up => {
            if pid_alive || port_open {
                Verdict::Keep
            } else {
                Verdict::Retire
            }
        }
        // A stop with no live run behind it. `finish` will never fire again, which
        // is exactly how a row used to sit on "exiting" forever.
        DevState::Stopping => {
            if pid_alive && age < STOP_GRACE {
                Verdict::Keep
            } else {
                Verdict::Forget
            }
        }
        // No supervisor and nothing listening, past the window in which the port
        // watchdog would have promoted it. This is what cleans up a spawn that
        // failed before its row existed.
        DevState::Starting => {
            if pid_alive || port_open || age < START_GRACE {
                Verdict::Keep
            } else {
                Verdict::Retire
            }
        }
        // Already retired. It stays until the user restarts or dismisses it: a crash
        // that erases itself after a few minutes is a crash you never find out about.
        DevState::Crashed => Verdict::Keep,
    }
}

/// One pass over every dev row. Emits only when something actually changed.
pub async fn sweep(app: &AppHandle, state: &Arc<AppState>) {
    let rows = state.dev_servers();
    if rows.is_empty() {
        return;
    }
    let supervised = state.supervised_dev_keys();
    let now = crate::git::now_unix();
    let mut changed = false;

    for d in rows {
        let key = task_key(&d.repo.key(), &d.task);
        let live = supervised.contains(&key)
            && state
                .live_dev_run(&key)
                .and_then(|rid| state.run(&rid))
                .map(|h| matches!(h.summary.lock().unwrap().status, crate::model::RunStatus::Running))
                .unwrap_or(false);

        // Probe only what the verdict can still be changed by. A supervised row
        // needs neither call, which is the common case and why this is cheap.
        if live {
            continue;
        }
        let alive = crate::platform::pid_alive(d.pid);
        let port_open = match d.port {
            Some(p) => crate::procs::port_in_use(p).await,
            None => false,
        };

        match verdict(&d, false, alive, port_open, now) {
            Verdict::Keep => {}
            Verdict::Retire => {
                state.retire_dev(&key, DevState::Crashed);
                changed = true;
            }
            Verdict::Forget => {
                state.remove_dev(&key);
                changed = true;
            }
        }
    }

    // Silence when nothing moved. `dev:changed` replaces the whole server list in
    // the store, so emitting unconditionally would re-render the rail four times a
    // minute for the lifetime of the app.
    if changed {
        let _ = app.emit(
            events::DEV_CHANGED,
            events::DevChanged {
                servers: state.dev_servers(),
            },
        );
    }
}

/// The background loop. Spawned once at startup and lives for the process.
pub async fn run(app: AppHandle, state: Arc<AppState>) {
    loop {
        tokio::time::sleep(SWEEP_EVERY).await;
        sweep(&app, &state).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::RepoRef;

    fn row(state: DevState, started_unix: i64) -> DevServer {
        DevServer {
            repo: RepoRef {
                category: "fe".into(),
                name: "web".into(),
            },
            task: "dev".into(),
            run_id: "r1".into(),
            pid: 4242,
            command: vec!["npm".into(), "run".into(), "dev".into()],
            port: Some(5173),
            port_source: None,
            state,
            url: None,
            started_unix,
        }
    }

    #[test]
    fn a_supervised_run_is_never_second_guessed() {
        // pid 0 until hydrate_pid finds the group, port not up yet — and still Keep,
        // because finish() owns this row.
        let mut d = row(DevState::Starting, 0);
        d.pid = 0;
        assert_eq!(verdict(&d, true, false, false, 10_000), Verdict::Keep);
        assert_eq!(
            verdict(&row(DevState::Up, 0), true, false, false, 10_000),
            Verdict::Keep
        );
    }

    #[test]
    fn an_up_row_with_a_live_port_survives_a_dead_pid() {
        // The nodemon case: it re-execs on every file change, so the pid moves while
        // the port stays bound. Retiring on pid alone makes the row flap.
        assert_eq!(
            verdict(&row(DevState::Up, 0), false, false, true, 10_000),
            Verdict::Keep
        );
    }

    #[test]
    fn an_up_row_with_neither_signal_is_retired() {
        assert_eq!(
            verdict(&row(DevState::Up, 0), false, false, false, 10_000),
            Verdict::Retire
        );
        // A live pid alone is enough to keep it — a server that has not bound its
        // port yet is not a dead one.
        assert_eq!(
            verdict(&row(DevState::Up, 0), false, true, false, 10_000),
            Verdict::Keep
        );
    }

    #[test]
    fn a_stop_that_finished_stops_being_a_row() {
        let d = row(DevState::Stopping, 10_000);
        // Mid-teardown, still alive: the grace period is the whole point.
        assert_eq!(verdict(&d, false, true, true, 10_005), Verdict::Keep);
        // Past the grace, or already gone: nothing will ever move this row again.
        assert_eq!(verdict(&d, false, true, true, 10_100), Verdict::Forget);
        assert_eq!(verdict(&d, false, false, false, 10_001), Verdict::Forget);
    }

    #[test]
    fn a_start_that_never_happened_is_retired_after_the_watchdog_window() {
        let d = row(DevState::Starting, 10_000);
        // Inside the window a slow boot is not a failure.
        assert_eq!(verdict(&d, false, false, false, 10_030), Verdict::Keep);
        assert_eq!(verdict(&d, false, false, false, 10_100), Verdict::Retire);
    }

    #[test]
    fn a_crash_is_not_swept_away_behind_your_back() {
        let d = row(DevState::Crashed, 0);
        assert_eq!(verdict(&d, false, false, false, 10_000_000), Verdict::Keep);
    }
}
