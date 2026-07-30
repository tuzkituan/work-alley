//! A real PTY, so vim, htop, a menu-driven script and a sudo prompt all work.
//!
//! `procs::spawn_run` is deliberately the opposite of this: `Stdio::piped`, stdin
//! closed by `git::harden`, ANSI stripped, output modelled as `LogLine`. That is
//! right for a build log and useless for anything that draws a screen.
//!
//! # Security
//!
//! **There is no `term_open` command.** A PTY can only be created by `run_action`
//! dispatching a `termShell` / `termScript` intent, so the argv is still built in
//! Rust from the closed `ActionSpec` enum and is never caller-supplied — exactly
//! the invariant the two-phase gate in commands.rs exists to hold. The only two
//! argvs that can reach `open` are the user's login shell in a containment-checked
//! cwd, and `bash <path>` where the path came from `scripts::find` + `script_path`.
//!
//! `term_write` is ungated **on purpose**. It cannot create a process; it writes
//! bytes to an fd whose peer is a shell the gate already authorised, and "what the
//! user then types is their own business" is what `ActionSpec::OpenShell` already
//! says. Before this module that shell ran in ptyxis, entirely outside the app's
//! control; running it here does not lower the bar. The one real delta is that a
//! compromised webview could type into an open shell invisibly — bounded by the
//! shell existing only because a gated action created it, an unguessable session
//! id, `MAX_SESSIONS`, the tab's lifetime, and a CSP with no remote origin at all.
//!
//! **Never add a `term_exec(argv)` convenience command.** That would be the actual
//! bypass: it would let a caller name the program, which is the one thing the gate
//! is built to prevent.

use crate::error::{AppError, AppResult};
use crate::events;
use crate::model::RepoRef;
use crate::state::AppState;
use base64::Engine as _;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

/// One animation frame. Lower than `procs::FLUSH_INTERVAL` (60ms) on purpose:
/// 60ms of latency on the echo of your own keystroke is felt, 16ms is not. The
/// reason 60ms was needed there — an unbounded emit storm freezing the WebKit
/// main thread — is handled here by backpressure instead. See `reader`.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// One pipe-ful. Smaller means more syscalls under `cat` of a large file.
const READ_CHUNK: usize = 64 * 1024;
/// Bounded, and that bound is the backpressure knob. See `reader`.
const CHANNEL_DEPTH: usize = 32;
/// Raw bytes retained per session, for restoring a tab after a webview reload.
const SCROLLBACK_BYTES: usize = 256 * 1024;
/// A webview bug must not be able to fork-bomb the machine through prepare/run.
const MAX_SESSIONS: usize = 8;
/// How long a hung-up shell gets to die politely before SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// Used when the frontend could not measure the pane — the classic terminal
/// geometry, which is also what most curses apps assume.
pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;

/// What `run_action` hands over. Built in Rust; see the module doc.
pub struct OpenSpec {
    pub argv: Vec<String>,
    /// What this session is for: "shell", "script" or "package". The frontend
    /// groups tabs by it — a package install belongs to the machine pages, not to
    /// a repo's output pane — and refreshes the Toolbox when a package tab exits.
    pub kind: String,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// True for an interactive login shell, which must build its own PATH.
    pub login_shell: bool,
    pub title: String,
    pub repo: Option<RepoRef>,
    pub cols: u16,
    pub rows: u16,
}

/// Everything the frontend needs to render a tab.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    pub term_id: String,
    pub kind: String,
    pub title: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub repo: Option<RepoRef>,
    pub started_unix: i64,
    pub pid: u32,
    pub alive: bool,
    pub cols: u16,
    pub rows: u16,
}

pub struct PtySession {
    pub info: Mutex<TermInfo>,
    /// Its own mutex, so a keystroke never waits behind a resize and vice versa.
    writer: Mutex<Box<dyn Write + Send>>,
    /// Kept only for `resize`. `MasterPty` is not `Sync`, hence the mutex.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Split out because the `Child` itself is moved into the waiter thread —
    /// the only way to both block on `wait()` and kill from somewhere else.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// pid == pgid == sid: portable-pty's unix child calls `setsid` and
    /// `TIOCSCTTY` itself, so `killpg` reaches the whole tree.
    pgid: i32,
    alive: AtomicBool,
    /// Raw bytes, trimmed at a newline. Best-effort by construction — the
    /// frontend prepends a full reset before replaying it.
    scrollback: Mutex<VecDeque<u8>>,
}

impl PtySession {
    fn push_scrollback(&self, chunk: &[u8]) {
        let mut sb = self.scrollback.lock().unwrap();
        sb.extend(chunk.iter().copied());
        if sb.len() <= SCROLLBACK_BYTES {
            return;
        }
        // Drop from the front, then advance to just past the next newline so a
        // restore is less likely to begin in the middle of an escape sequence.
        let excess = sb.len() - SCROLLBACK_BYTES;
        sb.drain(..excess);
        if let Some(nl) = sb.iter().position(|b| *b == b'\n') {
            sb.drain(..=nl);
        }
    }

    fn snapshot(&self) -> Vec<u8> {
        self.scrollback.lock().unwrap().iter().copied().collect()
    }
}

/// The only constructor. Reachable solely from `run_action`.
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<AppState>,
    spec: OpenSpec,
) -> AppResult<TermInfo> {
    if state.ptys.lock().unwrap().len() >= MAX_SESSIONS {
        return Err(AppError::Invalid(format!(
            "{MAX_SESSIONS} terminals are already open — close one first"
        )));
    }
    // Checked before spawning for the same reason `procs::supervise` does it: a
    // missing cwd and a missing program are both ENOENT, and only one of them is
    // the user's fault in a way they can act on.
    if !spec.cwd.is_dir() {
        return Err(AppError::Invalid(format!(
            "that folder no longer exists: {}",
            spec.cwd.display()
        )));
    }
    let Some((program, args)) = spec.argv.split_first() else {
        return Err(AppError::Invalid("empty command".into()));
    };

    let cols = spec.cols.clamp(1, 1000);
    let rows = spec.rows.clamp(1, 1000);

    let pair = portable_pty::native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Spawn(e.to_string()))?;

    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(&spec.cwd);

    // Env. This is where a pty deliberately diverges from `spawn_run`, which
    // applies `git::harden`:
    //
    //  - `GIT_TERMINAL_PROMPT=0` exists there because a pipe has nobody to answer
    //    a credential prompt. Here there is. Leaving it off is the whole point.
    //  - `NO_COLOR` / `CI` / `FORCE_COLOR=0` exist there because the log strips
    //    ANSI anyway. Here we render it.
    //
    // So `harden` is not called, and the three variables are actively removed in
    // case they were inherited from however this app was launched.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env_remove("NO_COLOR");
    cmd.env_remove("CI");
    cmd.env_remove("FORCE_COLOR");
    cmd.env_remove("GIT_TERMINAL_PROMPT");

    // `build_path_env` synthesises a PATH out of the probed tools' parent dirs.
    // Forcing that into an interactive login shell would replace the user's real
    // PATH with a handful of entries and break nvm — and the probe was imitating
    // that login shell in the first place. So the shell gets to derive its own.
    if !spec.login_shell {
        let path_env = state.toolchain().path_env;
        if !path_env.is_empty() {
            cmd.env("PATH", path_env);
        }
    }
    // Last, so an explicit override still wins.
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Spawn(e.to_string()))?;

    // Dropped immediately, and this matters: while *we* hold the slave fd open the
    // master never sees EOF when the child dies, and exit detection silently never
    // fires.
    drop(pair.slave);

    let pid = child.process_id().unwrap_or(0);
    let killer = child.clone_killer();
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Spawn(e.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Spawn(e.to_string()))?;

    let term_id = uuid::Uuid::new_v4().to_string();
    let info = TermInfo {
        term_id: term_id.clone(),
        kind: spec.kind,
        title: spec.title,
        argv: spec.argv.clone(),
        cwd: spec.cwd,
        repo: spec.repo,
        started_unix: crate::git::now_unix(),
        pid,
        alive: true,
        cols,
        rows,
    };

    let session = Arc::new(PtySession {
        info: Mutex::new(info.clone()),
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
        pgid: pid as i32,
        alive: AtomicBool::new(true),
        scrollback: Mutex::new(VecDeque::new()),
    });

    state
        .ptys
        .lock()
        .unwrap()
        .insert(term_id.clone(), session.clone());

    log::info!("term {term_id}: {} (pid {pid})", spec.argv.join(" "));
    let _ = app.emit(events::TERM_OPENED, events::TermOpened { term: info.clone() });

    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(CHANNEL_DEPTH);
    spawn_reader(reader, tx);
    spawn_emitter(app.clone(), term_id.clone(), session.clone(), rx);
    spawn_waiter(app.clone(), term_id, session, child);

    Ok(info)
}

/// A `std::thread`, not a tokio task: portable-pty's reader is a blocking
/// `Box<dyn Read + Send>` with no async variant, and parking a tokio worker on it
/// would stall unrelated tasks.
fn spawn_reader(mut reader: Box<dyn Read + Send>, tx: tokio::sync::mpsc::Sender<Vec<u8>>) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                // EOF: the last copy of the slave fd is closed.
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // `blocking_send` on a *bounded* channel is the entire
                    // throughput answer. `yes` produces bytes faster than any
                    // renderer consumes them; procs.rs could only coalesce,
                    // because a pipe's child cannot be slowed down. A pty's can:
                    // a full channel blocks this thread, the pty buffer fills,
                    // and the kernel blocks the child's write(2) — which is
                    // exactly what a real terminal emulator does. Dropping bytes
                    // instead is strictly worse (a truncated CSI wedges the
                    // emulator permanently) and an unbounded queue reproduces the
                    // very main-thread freeze procs.rs's comment is about.
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

fn spawn_emitter<R: Runtime>(
    app: AppHandle<R>,
    term_id: String,
    session: Arc<PtySession>,
    mut rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut pending: Vec<u8> = Vec::with_capacity(READ_CHUNK);
        let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                got = rx.recv() => match got {
                    Some(chunk) => {
                        session.push_scrollback(&chunk);
                        pending.extend_from_slice(&chunk);
                        if pending.len() >= READ_CHUNK {
                            flush(&app, &term_id, &mut pending);
                        }
                    }
                    None => {
                        flush(&app, &term_id, &mut pending);
                        break;
                    }
                },
                _ = ticker.tick() => flush(&app, &term_id, &mut pending),
            }
        }
    });
}

/// Base64, not `String::from_utf8_lossy`.
///
/// A `read()` boundary lands anywhere. Lossy-decoding a chunk that ends mid
/// codepoint replaces the partial bytes with U+FFFD *and* leaves the next chunk
/// starting on orphan continuation bytes — permanently corrupting every
/// box-drawing glyph vim and htop draw. Avoiding that in Rust would need a
/// stateful incremental UTF-8 decoder holding partial sequences across chunks;
/// xterm's `write(Uint8Array)` already does exactly that, correctly.
///
/// `Vec<u8>` is not an option either: Tauri events are JSON, so it serialises as
/// an array of decimal numbers (~4x, plus a per-element parse) against base64's
/// 1.33x. The raw-bytes IPC path exists only for command return values, not for
/// `Emitter::emit`.
fn flush<R: Runtime>(app: &AppHandle<R>, term_id: &str, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let bytes = std::mem::take(pending);
    let _ = app.emit(
        events::TERM_OUTPUT,
        events::TermOutput {
            term_id: term_id.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        },
    );
}

/// `Child::wait()` blocks, so it gets its own thread and owns the `Child`.
///
/// Reader-EOF and child-exit are two independent signals and neither is
/// redundant: a backgrounded grandchild can hold the slave open after the shell
/// exits, and a shell can close its fds without exiting.
fn spawn_waiter<R: Runtime>(
    app: AppHandle<R>,
    term_id: String,
    session: Arc<PtySession>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
) {
    std::thread::spawn(move || {
        let code = match child.wait() {
            Ok(s) => s.exit_code() as i32,
            Err(_) => -1,
        };
        session.alive.store(false, Ordering::Relaxed);
        session.info.lock().unwrap().alive = false;
        log::info!("term {term_id}: exited {code}");

        // The session stays in the registry: the tab shows "exited 0" and its
        // scrollback is still readable, exactly as a finished run's chip stays in
        // the strip until dismissed. `close` is what removes it.
        let _ = app.emit(
            events::TERM_EXIT,
            events::TermExit {
                term_id,
                code,
                ended_unix: crate::git::now_unix(),
            },
        );
    });
}

fn session_of(state: &AppState, id: &str) -> AppResult<Arc<PtySession>> {
    state
        .ptys
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::Invalid("that terminal is gone".into()))
}

/// Keystrokes.
///
/// No base64 inbound: xterm's `onData` always yields a well-formed UTF-8 string —
/// it is the emulator's own encoder — so a `String` is both sufficient and
/// cheaper than making the frontend encode.
pub fn write(state: &AppState, id: &str, data: &str) -> AppResult<()> {
    let s = session_of(state, id)?;
    if !s.alive.load(Ordering::Relaxed) {
        return Err(AppError::Invalid("that terminal has exited".into()));
    }
    let mut w = s.writer.lock().unwrap();
    w.write_all(data.as_bytes())
        .and_then(|_| w.flush())
        .map_err(|e| AppError::Invalid(e.to_string()))
}

/// The `TIOCSWINSZ` ioctl, which is what makes the kernel deliver `SIGWINCH` to
/// the foreground group — which is what makes vim and htop redraw.
pub fn resize(state: &AppState, id: &str, cols: u16, rows: u16) -> AppResult<()> {
    let s = session_of(state, id)?;
    let cols = cols.clamp(1, 1000);
    let rows = rows.clamp(1, 1000);
    s.master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Invalid(e.to_string()))?;
    let mut info = s.info.lock().unwrap();
    info.cols = cols;
    info.rows = rows;
    Ok(())
}

/// Closes a tab: hang up the shell, then make sure.
pub fn close(state: &AppState, id: &str) -> AppResult<()> {
    let Some(s) = state.ptys.lock().unwrap().remove(id) else {
        // Already gone. Closing a tab twice is not an error worth a dialog.
        return Ok(());
    };
    hangup(&s);

    let s2 = s.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(KILL_GRACE).await;
        if s2.alive.load(Ordering::Relaxed) {
            force_kill(&s2);
        }
    });
    Ok(())
}

/// SIGHUP the process group — the same signal closing a real terminal window
/// sends. Dropping the master fd raises it too, so this is belt and braces for
/// the same reason `procs` keeps `kill_on_drop`.
fn hangup(s: &Arc<PtySession>) {
    #[cfg(unix)]
    if s.pgid > 1 {
        unsafe {
            libc::killpg(s.pgid, libc::SIGHUP);
        }
    }
    let _ = s.killer.lock().unwrap().kill();
}

fn force_kill(s: &Arc<PtySession>) {
    #[cfg(unix)]
    if s.pgid > 1 {
        unsafe {
            libc::killpg(s.pgid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = s.killer.lock().unwrap().kill();
    }
}

pub fn list(state: &AppState) -> Vec<TermInfo> {
    let mut v: Vec<TermInfo> = state
        .ptys
        .lock()
        .unwrap()
        .values()
        .map(|s| s.info.lock().unwrap().clone())
        .collect();
    v.sort_by_key(|t| t.started_unix);
    v
}

/// Base64 of every byte the session has produced, capped at `SCROLLBACK_BYTES`.
/// Only actually needed after a full webview reload — a dev HMR — because the
/// frontend keeps its xterm instances in a module cache across remounts.
pub fn scrollback(state: &AppState, id: &str) -> AppResult<String> {
    let s = session_of(state, id)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(s.snapshot()))
}

/// Synchronous best-effort teardown for app shutdown, mirroring
/// `procs::kill_all_now`. Without this every shell outlives the app.
pub fn kill_all_now(state: &AppState) {
    let sessions: Vec<Arc<PtySession>> = state
        .ptys
        .lock()
        .unwrap()
        .values()
        .filter(|s| s.alive.load(Ordering::Relaxed))
        .cloned()
        .collect();
    if sessions.is_empty() {
        return;
    }
    for s in &sessions {
        hangup(s);
    }
    std::thread::sleep(Duration::from_millis(600));
    for s in &sessions {
        if s.alive.load(Ordering::Relaxed) {
            force_kill(s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drives the real `open` — not a reimplementation of it — via a mock
    /// AppHandle. Assertions read the scrollback, which the emitter task fills
    /// whether or not anything is listening for the events.
    fn harness() -> (tauri::AppHandle<tauri::test::MockRuntime>, Arc<AppState>) {
        let app = tauri::test::mock_app();
        let root = std::env::temp_dir();
        let state = Arc::new(AppState::new(
            root.clone(),
            root.clone(),
            crate::config::Config::defaults(root),
            crate::toolchain::Toolchain::default(),
        ));
        (app.handle().clone(), state)
    }

    fn spec(script: &str) -> OpenSpec {
        OpenSpec {
            kind: "script".into(),
            argv: vec!["/bin/bash".into(), "-c".into(), script.into()],
            cwd: std::env::temp_dir(),
            env: vec![],
            login_shell: false,
            title: "test".into(),
            repo: None,
            cols: 80,
            rows: 24,
        }
    }

    /// Polls until the child has exited and its output has been drained, rather
    /// than sleeping a fixed amount — a pty round trip has no bounded latency.
    async fn output_after_exit(state: &Arc<AppState>, id: &str) -> String {
        for _ in 0..200 {
            tokio::time::sleep(Duration::from_millis(25)).await;
            let done = state
                .ptys
                .lock()
                .unwrap()
                .get(id)
                .map(|s| !s.alive.load(Ordering::Relaxed))
                .unwrap_or(false);
            if done {
                // The waiter thread can win the race against the last flush.
                tokio::time::sleep(Duration::from_millis(120)).await;
                break;
            }
        }
        let b64 = scrollback(state, id).expect("session still registered");
        String::from_utf8_lossy(
            &base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap(),
        )
        .into_owned()
    }

    /// The real thing: the user's own login shell, driven the way a tab drives it.
    #[tokio::test]
    async fn login_shell_starts_and_echoes() {
        let (app, state) = harness();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let info = open(
            &app,
            &state,
            OpenSpec {
                kind: "shell".into(),
                argv: vec![shell.clone(), "-l".into()],
                cwd: std::env::temp_dir(),
                env: vec![],
                login_shell: true,
                title: "shell".into(),
                repo: None,
                cols: 80,
                rows: 24,
            },
        )
        .unwrap();

        // Polled rather than slept: an rc file that sources nvm can take a
        // second on a cold cache, and a fixed sleep would make this flaky on
        // someone else's machine. Readiness is "printed anything at all" —
        // looking for `$` would assume bash and fail on a zsh theme whose
        // prompt is `➜`, which is exactly what it did.
        assert!(
            wait_for(&state, &info.term_id, "", 100).await,
            "{shell} -l printed no prompt"
        );
        assert!(
            state.ptys.lock().unwrap()[&info.term_id]
                .alive
                .load(Ordering::Relaxed),
            "{shell} -l died on its own"
        );

        // Arithmetic, so a shell that merely echoed the input would still fail.
        write(&state, &info.term_id, "echo MARK-$((6*7))\n").unwrap();
        assert!(
            wait_for(&state, &info.term_id, "MARK-42", 100).await,
            "no evaluated echo from {shell}"
        );

        write(&state, &info.term_id, "exit\n").unwrap();
        output_after_exit(&state, &info.term_id).await;
        assert!(
            !state.ptys.lock().unwrap()[&info.term_id]
                .alive
                .load(Ordering::Relaxed),
            "{shell} did not exit on `exit`"
        );
    }

    /// Polls the scrollback for `needle`, so tests never race the pty. An empty
    /// needle means "any output at all".
    async fn wait_for(state: &Arc<AppState>, id: &str, needle: &str, tries: u32) -> bool {
        for _ in 0..tries {
            tokio::time::sleep(Duration::from_millis(25)).await;
            let b64 = match scrollback(state, id) {
                Ok(b) => b,
                Err(_) => return false,
            };
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap_or_default();
            if bytes.is_empty() {
                continue;
            }
            if String::from_utf8_lossy(&bytes).contains(needle) {
                return true;
            }
        }
        false
    }

    /// The pipe test. `tty` prints "not a tty" under `procs::spawn_run`; if this
    /// ever regresses, nothing else in the module is worth much.
    #[tokio::test]
    async fn child_gets_a_real_tty() {
        let (app, state) = harness();
        let info = open(&app, &state, spec("tty")).unwrap();
        let out = output_after_exit(&state, &info.term_id).await;
        assert!(out.contains("/dev/pts/"), "expected a pts device, got {out:?}");
    }

    /// Colour and curses apps both key off this, and `git::harden` would have
    /// suppressed them — which is why `open` deliberately does not call it.
    #[tokio::test]
    async fn term_is_set_and_git_prompts_are_not_suppressed() {
        let (app, state) = harness();
        let info = open(
            &app,
            &state,
            spec("echo TERM=$TERM; echo PROMPT=[${GIT_TERMINAL_PROMPT-unset}]; echo NO_COLOR=[${NO_COLOR-unset}]"),
        )
        .unwrap();
        let out = output_after_exit(&state, &info.term_id).await;
        assert!(out.contains("TERM=xterm-256color"), "got {out:?}");
        // Unset, not "0": a credential prompt in a terminal is the whole point.
        assert!(out.contains("PROMPT=[unset]"), "got {out:?}");
        assert!(out.contains("NO_COLOR=[unset]"), "got {out:?}");
    }

    /// `stty size` reads the kernel's window size, so this proves the openpty
    /// geometry reached the terminal rather than merely being recorded.
    #[tokio::test]
    async fn geometry_reaches_the_kernel() {
        let (app, state) = harness();
        let mut s = spec("stty size");
        s.cols = 132;
        s.rows = 43;
        let info = open(&app, &state, s).unwrap();
        assert_eq!((info.cols, info.rows), (132, 43));
        let out = output_after_exit(&state, &info.term_id).await;
        assert!(out.contains("43 132"), "expected rows cols, got {out:?}");
    }

    #[tokio::test]
    async fn writing_reaches_the_child_and_exit_is_detected() {
        let (app, state) = harness();
        // `read` needs stdin, which a piped child does not have at all.
        let info = open(&app, &state, spec("read -r line; echo GOT:$line")).unwrap();
        // Wait for the child to actually be at the read.
        tokio::time::sleep(Duration::from_millis(300)).await;
        write(&state, &info.term_id, "hello\n").unwrap();

        let out = output_after_exit(&state, &info.term_id).await;
        assert!(out.contains("GOT:hello"), "got {out:?}");
        // The waiter thread flipped it, so the tab can render "exited".
        let alive = state.ptys.lock().unwrap()[&info.term_id]
            .alive
            .load(Ordering::Relaxed);
        assert!(!alive, "expected the session to be marked exited");
    }

    /// A dead session must refuse writes rather than silently swallow them.
    #[tokio::test]
    async fn writing_to_a_dead_session_errors() {
        let (app, state) = harness();
        let info = open(&app, &state, spec("true")).unwrap();
        output_after_exit(&state, &info.term_id).await;
        assert!(write(&state, &info.term_id, "x").is_err());
        assert!(write(&state, "no-such-id", "x").is_err());
    }

    /// The tab survives its shell so the scrollback stays readable; `close` is
    /// what removes it, and closing twice is not an error.
    #[tokio::test]
    async fn close_removes_the_session_and_is_idempotent() {
        let (app, state) = harness();
        let info = open(&app, &state, spec("sleep 30")).unwrap();
        assert_eq!(list(&state).len(), 1);
        close(&state, &info.term_id).unwrap();
        assert!(list(&state).is_empty());
        close(&state, &info.term_id).unwrap();
    }

    /// A webview bug must not be able to fork-bomb the machine through the gate.
    #[tokio::test]
    async fn session_count_is_capped() {
        let (app, state) = harness();
        for _ in 0..MAX_SESSIONS {
            open(&app, &state, spec("sleep 30")).unwrap();
        }
        let err = open(&app, &state, spec("sleep 30")).unwrap_err();
        assert_eq!(err.code(), "INVALID");
        for info in list(&state) {
            close(&state, &info.term_id).unwrap();
        }
    }

    #[tokio::test]
    async fn a_missing_cwd_is_reported_not_spawned() {
        let (app, state) = harness();
        let mut s = spec("true");
        s.cwd = std::env::temp_dir().join("definitely-not-here-9f3a");
        assert_eq!(open(&app, &state, s).unwrap_err().code(), "INVALID");
    }

    /// Multibyte output must survive the read-boundary round trip. This is the
    /// base64-versus-lossy-String assertion: a lossy decode would emit U+FFFD
    /// wherever a chunk split a codepoint, and the volume here is well past one
    /// READ_CHUNK, so it will split one.
    #[tokio::test]
    async fn multibyte_output_is_not_corrupted() {
        let (app, state) = harness();
        let info = open(
            &app,
            &state,
            // No newlines: nothing here should trim scrollback either.
            spec("for i in $(seq 1 200); do printf 'éàü…'; done; echo"),
        )
        .unwrap();
        let out = output_after_exit(&state, &info.term_id).await;
        assert!(!out.contains('\u{fffd}'), "replacement char in {out:?}");
        assert_eq!(out.matches('…').count(), 200, "lost characters");
    }
}
