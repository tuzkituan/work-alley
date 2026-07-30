use crate::ansi;
use crate::error::{AppError, AppResult};
use crate::events;
use crate::model::{LogLine, RepoRef, RunStatus, RunSummary, Severity, Stream};
use crate::state::{AppState, RunHandle};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

/// Output is coalesced and flushed on whichever comes first.
///
/// This is a requirement, not an optimization: one emit per line freezes the
/// WebKit main thread during a cold vite start or a whole-workspace pull.
const FLUSH_INTERVAL: Duration = Duration::from_millis(60);
const FLUSH_BATCH: usize = 200;

/// Grace period between SIGTERM and SIGKILL for a process group.
const KILL_GRACE: Duration = Duration::from_secs(5);

pub struct SpawnSpec {
    pub argv: Vec<String>,
    /// Task key for devStart runs ("libs/design-system#storybook"), so the port
    /// sniffer patches the right entry when a repo runs dev and storybook at once.
    pub dev_key: Option<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub kind: String,
    pub title: String,
    pub repo: Option<RepoRef>,
    /// Every repo the run touches, including for bulk runs where `repo` is None.
    pub targets: Vec<RepoRef>,
    /// Repo keys this run may attribute lines to, so a bulk run over many repos can
    /// be rendered grouped instead of as one unreadable interleaved stream.
    ///
    /// A *set*, not one string: the previous field was a single value stamped on
    /// every line, so no value it could hold was right for more than one line and
    /// the field was always left unset. The emitter tracks which of these is in
    /// flight by watching the script's own `[..]/[OK]/[FAIL]` markers.
    pub target_keys: Vec<String>,
}

/// Spawns a child, streams its output in batches, and always reaps it.
///
/// Returns the run id immediately; everything else arrives as events.
pub fn spawn_run(app: &AppHandle, spec: SpawnSpec) -> AppResult<String> {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let run_id = uuid::Uuid::new_v4().to_string();
    let started = crate::git::now_unix();
    let max_lines = state.config().max_log_lines_per_run;

    let summary = RunSummary {
        run_id: run_id.clone(),
        kind: spec.kind.clone(),
        title: spec.title.clone(),
        repo: spec.repo.clone(),
        targets: spec.targets.clone(),
        argv: spec.argv.clone(),
        cwd: spec.cwd.clone(),
        started_unix: started,
        ended_unix: None,
        status: RunStatus::Running,
        line_count: 0,
        truncated: false,
    };

    let handle = Arc::new(RunHandle {
        summary: Mutex::new(summary.clone()),
        log: Mutex::new(VecDeque::new()),
        max_lines,
        pgid: Mutex::new(0),
        cancel: Arc::new(AtomicBool::new(false)),
        next_seq: Mutex::new(0),
    });

    state
        .runs
        .lock()
        .unwrap()
        .insert(run_id.clone(), handle.clone());

    let _ = app.emit(events::RUN_STARTED, events::RunStarted { run: summary });

    // The command header, so the log always opens with exactly what ran.
    push_and_record(
        app,
        &handle,
        &run_id,
        Stream::Meta,
        Severity::Cmd,
        format!("$ {}", shell_join(&spec.argv)),
        None,
    );

    let app2 = app.clone();
    let state2 = state.clone();
    let handle2 = handle.clone();
    let run_id2 = run_id.clone();

    tauri::async_runtime::spawn(async move {
        supervise(app2, state2, handle2, run_id2, spec).await;
    });

    Ok(run_id)
}

async fn supervise(
    app: AppHandle,
    state: Arc<AppState>,
    handle: Arc<RunHandle>,
    run_id: String,
    spec: SpawnSpec,
) {
    let began = Instant::now();

    let Some((program, args)) = spec.argv.split_first() else {
        finish(&app, &state, &handle, &run_id, RunStatus::Failed { message: "empty command".into() }, began).await;
        return;
    };

    // Checked here rather than left to the spawn: a missing cwd and a missing
    // program both come back as a bare ENOENT, and "failed to spawn: No such file or
    // directory" sends you looking for the wrong missing thing.
    if !spec.cwd.is_dir() {
        finish(
            &app,
            &state,
            &handle,
            &run_id,
            RunStatus::Failed {
                message: format!("that folder no longer exists: {}", spec.cwd.display()),
            },
            began,
        )
        .await;
        return;
    }

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(&spec.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::git::harden(&mut cmd);
    // Must come before spec.env so an explicit override still wins.
    state.toolchain().apply_path(&mut cmd);
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    // Belt-and-braces only. The explicit wait() below is what actually prevents
    // zombies — kill_on_drop stops reaping once the runtime is gone.
    cmd.kill_on_drop(true);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            // Own process group, so killpg can take down the whole tree. vite
            // spawns esbuild; killing only the direct child orphans it and leaves
            // the port bound, which makes the next start fail confusingly.
            //
            // pre_exec runs post-fork/pre-exec and must be async-signal-safe.
            // setsid() is. Do not add anything else to this closure.
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::NotFound {
                format!("{program} not found. Is it installed and on PATH?")
            } else {
                e.to_string()
            };
            push_and_record(
                &app,
                &handle,
                &run_id,
                Stream::Meta,
                Severity::Err,
                msg.clone(),
                None,
            );
            finish(
                &app,
                &state,
                &handle,
                &run_id,
                RunStatus::Failed { message: msg },
                began,
            )
            .await;
            return;
        }
    };

    let pid = child.id().unwrap_or(0);
    #[cfg(unix)]
    {
        // The child is its own group leader, so pgid == pid.
        *handle.pgid.lock().unwrap() = pid as i32;
    }

    let (tx, mut rx) = mpsc::channel::<(Stream, String)>(1024);

    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if tx.send((Stream::Stdout, l)).await.is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if tx.send((Stream::Stderr, l)).await.is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    // --- emitter: coalesce into batches ---------------------------------------
    let app_e = app.clone();
    let handle_e = handle.clone();
    let run_id_e = run_id.clone();
    // Longest first, so `fe/web-admin` wins over `fe/web` on a line naming the
    // former — the same rule the TS parser uses.
    let mut target_keys = spec.target_keys.clone();
    target_keys.sort_by_key(|k| std::cmp::Reverse(k.len()));
    let dev_key = spec.dev_key.clone();
    let state_e = state.clone();

    let emitter = tokio::spawn(async move {
        let mut pending: Vec<LogLine> = Vec::new();
        // The repo currently in flight, from the markers the script prints. Only
        // meaningful for a bulk run; a single-repo run has nothing to disambiguate.
        let mut current_repo: Option<String> = None;
        let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                got = rx.recv() => match got {
                    Some((stream, raw)) => {
                        let text = ansi::strip(&raw);
                        if text.is_empty() {
                            continue;
                        }
                        let severity = ansi::classify(stream, &text);

                        // Which repo this line belongs to, tracked across lines from
                        // the script's own markers.
                        //
                        // Done here rather than in the frontend because lines are
                        // stored and replayed through `get_run_log`, and the log body
                        // is virtualized over up to 20k lines — attribution has to be
                        // a property of the line, not recomputed on every render.
                        //
                        // Only for a bulk run: on a single-repo run the prefix would
                        // be on every line and say nothing.
                        let line_repo = if target_keys.len() > 1 {
                            match ansi::marker(&text) {
                                Some((kind, rest)) => {
                                    let named = target_keys
                                        .iter()
                                        .find(|k| {
                                            rest == k.as_str()
                                                || rest.starts_with(&format!("{k} "))
                                        })
                                        .cloned();
                                    match (kind, &named) {
                                        // A repo opens: everything up to the next
                                        // marker is its output.
                                        (ansi::Marker::Start, Some(k)) => {
                                            current_repo = Some(k.clone())
                                        }
                                        // A result closes it, but the marker line
                                        // itself is still attributed below so the
                                        // row keeps its reason.
                                        (_, Some(_)) => current_repo = None,
                                        // A line naming no repo ("bulk pull
                                        // finished") belongs to the run, not a repo.
                                        (_, None) => current_repo = None,
                                    }
                                    named
                                }
                                None => current_repo.clone(),
                            }
                        } else {
                            None
                        };

                        // Correct a wrong static port guess from vite's own banner.
                        if let Some(key) = &dev_key {
                            if let Some(port) = ansi::sniff_port(&text) {
                                if let Some(updated) = state_e.patch_dev(key, |d| {
                                    d.port = Some(port);
                                    d.port_source = Some(crate::model::PortSource::DetectedFromOutput);
                                    d.state = crate::model::DevState::Up;
                                    d.url = Some(format!("http://localhost:{port}"));
                                }) {
                                    let _ = app_e.emit(
                                        events::DEV_CHANGED,
                                        events::DevChanged { servers: state_e.dev_servers() },
                                    );
                                    let _ = updated;
                                }
                            }
                        }

                        let line = LogLine {
                            seq: handle_e.take_seq(),
                            stream,
                            severity,
                            text,
                            unix: crate::git::now_unix(),
                            repo: line_repo.clone(),
                        };
                        let dropped = handle_e.push_line(line.clone());
                        {
                            let mut s = handle_e.summary.lock().unwrap();
                            s.line_count += 1;
                            if dropped {
                                s.truncated = true;
                            }
                        }
                        pending.push(line);
                        if pending.len() >= FLUSH_BATCH {
                            flush(&app_e, &run_id_e, &mut pending);
                        }
                    }
                    None => {
                        flush(&app_e, &run_id_e, &mut pending);
                        break;
                    }
                },
                _ = ticker.tick() => flush(&app_e, &run_id_e, &mut pending),
            }
        }
    });

    // --- wait, honouring cancellation ----------------------------------------
    let status = loop {
        if handle.is_cancelled() {
            kill_tree(&handle, pid).await;
            // Still reap, so no zombie is left behind.
            let _ = child.wait().await;
            break RunStatus::Cancelled;
        }

        match tokio::time::timeout(Duration::from_millis(200), child.wait()).await {
            Ok(Ok(st)) => {
                break exit_status(st);
            }
            Ok(Err(e)) => {
                break RunStatus::Failed {
                    message: e.to_string(),
                }
            }
            Err(_) => continue, // still running — poll cancellation again
        }
    };

    let _ = emitter.await;
    finish(&app, &state, &handle, &run_id, status, began).await;
}

fn exit_status(st: std::process::ExitStatus) -> RunStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = st.signal() {
            return RunStatus::Signaled { signal: sig };
        }
    }
    RunStatus::Exited {
        code: st.code().unwrap_or(-1),
    }
}

fn flush(app: &AppHandle, run_id: &str, pending: &mut Vec<LogLine>) {
    if pending.is_empty() {
        return;
    }
    let lines = std::mem::take(pending);
    let _ = app.emit(
        events::RUN_OUTPUT,
        events::RunOutput {
            run_id: run_id.to_string(),
            lines,
        },
    );
}

async fn finish(
    app: &AppHandle,
    state: &Arc<AppState>,
    handle: &Arc<RunHandle>,
    run_id: &str,
    status: RunStatus,
    began: Instant,
) {
    let ended = crate::git::now_unix();
    let duration_ms = began.elapsed().as_millis() as u64;

    let (line_count, truncated) = {
        let mut s = handle.summary.lock().unwrap();
        s.status = status.clone();
        s.ended_unix = Some(ended);
        (s.line_count, s.truncated)
    };

    // A dev server that exits is either a deliberate stop or a crash. Either way
    // its entry must reflect reality, and a crash must keep its log so the user
    // can read the error.
    let dev_key = {
        let dev = state.dev.lock().unwrap();
        dev.iter()
            .find(|(_, v)| v.as_str() == run_id)
            .map(|(k, _)| k.clone())
    };
    if let Some(key) = dev_key {
        match &status {
            RunStatus::Cancelled | RunStatus::Signaled { .. } => state.remove_dev(&key),
            RunStatus::Exited { code } if *code == 0 => state.remove_dev(&key),
            _ => {
                state.patch_dev(&key, |d| d.state = crate::model::DevState::Crashed);
            }
        }
        state.persist_dev_runs();
        let _ = app.emit(
            events::DEV_CHANGED,
            events::DevChanged {
                servers: state.dev_servers(),
            },
        );
    }

    let _ = app.emit(
        events::RUN_EXIT,
        events::RunExit {
            run_id: run_id.to_string(),
            status,
            ended_unix: ended,
            duration_ms,
            line_count,
            truncated,
        },
    );
}

/// SIGTERM the whole group, wait out the grace period, then SIGKILL.
pub async fn kill_tree(handle: &Arc<RunHandle>, pid: u32) {
    #[cfg(unix)]
    {
        let pgid = *handle.pgid.lock().unwrap();
        let target = if pgid > 1 { pgid } else { pid as i32 };
        unsafe {
            libc::killpg(target, libc::SIGTERM);
        }
        tokio::time::sleep(KILL_GRACE).await;
        unsafe {
            libc::killpg(target, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (handle, pid);
    }
}

/// Synchronous best-effort teardown for app shutdown, where we cannot await.
pub fn kill_all_now(state: &AppState) {
    #[cfg(unix)]
    {
        let pgids = state.running_pgids();
        for pgid in &pgids {
            unsafe {
                libc::killpg(*pgid, libc::SIGTERM);
            }
        }
        if !pgids.is_empty() {
            std::thread::sleep(Duration::from_millis(600));
            for pgid in &pgids {
                unsafe {
                    libc::killpg(*pgid, libc::SIGKILL);
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = state;
    }
}

pub fn push_and_record(
    app: &AppHandle,
    handle: &Arc<RunHandle>,
    run_id: &str,
    stream: Stream,
    severity: Severity,
    text: String,
    repo: Option<String>,
) {
    let line = LogLine {
        seq: handle.take_seq(),
        stream,
        severity,
        text,
        unix: crate::git::now_unix(),
        repo,
    };
    let dropped = handle.push_line(line.clone());
    {
        let mut s = handle.summary.lock().unwrap();
        s.line_count += 1;
        if dropped {
            s.truncated = true;
        }
    }
    let _ = app.emit(
        events::RUN_OUTPUT,
        events::RunOutput {
            run_id: run_id.to_string(),
            lines: vec![line],
        },
    );
}

pub fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            if a.is_empty() || a.contains(' ') || a.contains('"') {
                format!("{a:?}")
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn cancel_run(state: &AppState, run_id: &str) -> AppResult<()> {
    let handle = state
        .run(run_id)
        .ok_or_else(|| AppError::RunUnknown(run_id.to_string()))?;
    handle
        .cancel
        .store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Is something already listening on this port? Used as a pre-flight warning.
pub async fn port_in_use(port: u16) -> bool {
    tokio::time::timeout(
        Duration::from_millis(250),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

/// A terminal emulator, and how it wants the command handed over.
pub struct TerminalCmd {
    pub program: String,
    /// Flags that come before the command.
    pub pre: Vec<String>,
    /// True when the command must arrive as one argument rather than as an argv.
    ///
    /// ptyxis is the reason this exists: its `--tab` only combines with `-x`, which
    /// takes the whole command line as a single string. Given a real argv after `--`
    /// it ignores `--tab` and opens a *window* instead, which is what it was doing.
    pub single_string: bool,
}

/// Finds a terminal emulator to hand an interactive script to.
///
/// Degrades to an error carrying the exact command, so the UI can offer "copy" —
/// which is far better than piping canned menu answers into a script that pushes
/// commits and publishes packages.
pub fn find_terminal(tc: &crate::toolchain::Toolchain) -> Option<TerminalCmd> {
    let _ = tc;
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.trim().is_empty() {
            // An unknown emulator: `-e cmd args` is the one convention nearly all of
            // them share, and a tab flag would be a guess.
            return Some(TerminalCmd {
                program: t,
                pre: vec!["-e".into()],
                single_string: false,
            });
        }
    }
    // A tab in the terminal you already have open, wherever the emulator can do it:
    // an install is something you watch and then leave, and a whole new window per
    // step means five windows to close by the end of a setup. The three that support
    // it fall back to opening a window themselves when none is open yet.
    //
    // `--`, not ptyxis's `-x`: `-x` takes the whole command as a single string, so
    // `-x bash -lc '…'` consumed "bash", choked on the unknown `-lc` and exited — a
    // click that opened nothing and said nothing. Fedora 42+ ships ptyxis as the
    // default terminal, so it is the branch most users land on.
    // (binary, flags, command-as-one-string)
    let candidates: [(&str, &[&str], bool); 8] = [
        ("ptyxis", &["--tab", "-x"], true),
        ("gnome-terminal", &["--tab", "--"], false),
        ("konsole", &["--new-tab", "-e"], false),
        // The rest have no usable tab flag: kitty and wezterm need a running instance
        // with remote control enabled, and alacritty and xterm have no tabs at all.
        ("kitty", &[], false),
        ("alacritty", &["-e"], false),
        ("wezterm", &["start", "--"], false),
        ("x-terminal-emulator", &["-e"], false),
        ("xterm", &["-e"], false),
    ];
    for (bin, pre, single_string) in candidates {
        if let Some(p) = which_path(bin) {
            return Some(TerminalCmd {
                program: p.display().to_string(),
                pre: pre.iter().map(|s| s.to_string()).collect(),
                single_string,
            });
        }
    }
    None
}

// Both moved to `platform`, which owns every difference between the POSIX shells
// and PowerShell. Re-exported rather than relocated at every call site, because
// `sh_quote` is still exactly the right quoter for a POSIX script — it is just no
// longer the *only* quoter.
pub use crate::platform::sh_quote;
use crate::platform::which as which_path;

/// Launches a GUI program and forgets about it.
///
/// Not tracked as a run: an editor keeps running after Work Alley exits, so it
/// must not be in the process group we tear down on shutdown.
pub fn spawn_detached(
    tc: &crate::toolchain::Toolchain,
    cwd: &Path,
    argv: &[String],
) -> AppResult<()> {
    let Some((program, args)) = argv.split_first() else {
        return Err(AppError::Invalid("empty command".into()));
    };

    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if !tc.path_env.is_empty() {
        cmd.env("PATH", &tc.path_env);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    cmd.spawn().map_err(|e| AppError::Spawn(e.to_string()))?;
    Ok(())
}

/// Builds the emulator invocation for a shell script.
///
/// Shared by both terminal entry points so the tab handling, the quoting and the
/// detachment are decided once. Not tracked as a run: the terminal has its own
/// window and outlives this app.
fn terminal_command(
    term: &TerminalCmd,
    sh: &crate::platform::Shell,
    script: &str,
    cwd: &Path,
) -> std::process::Command {
    let mut cmd = std::process::Command::new(&term.program);
    cmd.args(&term.pre);
    if term.single_string {
        // One argument, so the emulator's own parser sees a single command line.
        cmd.arg(sh.login_script_line(script));
    } else {
        cmd.args(sh.login_script_argv(script));
    }

    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Kept, not discarded: this is the only channel an emulator has to say it did
        // not like our arguments. See `watch_terminal`.
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        unsafe {
            // Its own session, so the terminal outlives this app rather than dying
            // with it — the same reasoning as for a GUI editor.
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    cmd
}

/// Opens the user's terminal at `cwd`, with a shell and no command.
///
/// The shell is started explicitly rather than left to the emulator's default,
/// because `exec` is what makes that equivalent: you get your login shell, not a
/// shell nested inside a wrapper. It is also the only way to be sure of the
/// directory — see the note in `open_terminal` about tabs.
pub fn open_shell(app: &AppHandle, tc: &crate::toolchain::Toolchain, cwd: &Path) -> AppResult<()> {
    let pretty = format!("cd {}", cwd.display());
    let Some(term) = find_terminal(tc) else {
        return Err(AppError::NoTerminal(pretty));
    };
    if !cwd.is_dir() {
        return Err(AppError::Invalid(format!(
            "that folder no longer exists: {}",
            cwd.display()
        )));
    }

    let sh = crate::platform::shell().ok_or_else(|| AppError::NoTerminal(pretty.clone()))?;
    let script = format!("{}; {}", sh.cd_or_exit(cwd), sh.exec_login());

    let child = terminal_command(&term, sh, &script, cwd)
        .spawn()
        .map_err(|e| AppError::Spawn(e.to_string()))?;
    watch_terminal(app, child, pretty);
    Ok(())
}

/// Reports a terminal emulator that refused to start.
///
/// Handing a command to a terminal is fire-and-forget: there is no run to attach to
/// and nothing waits on the child, so an emulator that rejects our arguments used to
/// print to a discarded stderr, exit, and leave the user looking at a screen where
/// pressing Install did nothing whatsoever. (It happened: ptyxis's `-x` wants the
/// command as one string and answered `Unknown option -lc`.)
///
/// A brief watch rather than a wait: emulators legitimately exit straight away after
/// handing the window to a D-Bus service, so success is "still running, or exited
/// zero", and only a non-zero exit is worth a word.
fn watch_terminal(app: &AppHandle, mut child: std::process::Child, pretty: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(100));
            match child.try_wait() {
                Ok(Some(status)) if !status.success() => {
                    let mut err = String::new();
                    if let Some(mut pipe) = child.stderr.take() {
                        use std::io::Read as _;
                        let _ = pipe.read_to_string(&mut err);
                    }
                    let detail = err.lines().next().unwrap_or("").trim().to_string();
                    log::warn!("terminal emulator exited {status}: {err}");
                    let _ = app.emit(
                        events::APP_TOAST,
                        events::Toast {
                            level: "err".into(),
                            message: if detail.is_empty() {
                                format!("The terminal did not open. Run it yourself: {pretty}")
                            } else {
                                format!("The terminal did not open ({detail}). Run it yourself: {pretty}")
                            },
                            run_id: None,
                        },
                    );
                    return
                }
                // Exited cleanly, or still running: both are the normal case.
                Ok(Some(_)) => return,
                Ok(None) => continue,
                Err(_) => return,
            }
        }
    });
}

pub fn open_terminal(
    app: &AppHandle,
    tc: &crate::toolchain::Toolchain,
    cwd: &Path,
    argv: &[String],
) -> AppResult<()> {
    let pretty = shell_join(argv);
    let Some(term) = find_terminal(tc) else {
        return Err(AppError::NoTerminal(pretty));
    };
    // Same trap as in `supervise`: a cwd that is not there fails the spawn with the
    // same ENOENT as a missing terminal emulator, sending you after the wrong one.
    if !cwd.is_dir() {
        return Err(AppError::Invalid(format!(
            "that folder no longer exists: {}",
            cwd.display()
        )));
    }

    // The `cd` is not redundant with `current_dir`. When this opens a *tab*, the
    // process we spawn only forwards the request to the emulator's primary instance
    // and exits — the tab is created by that instance and inherits *its* directory,
    // not ours. A script that must run inside a repo would silently run somewhere
    // else. Saying it in the command works whichever way the emulator goes.
    let sh = crate::platform::shell().ok_or_else(|| AppError::NoTerminal(pretty.clone()))?;
    let script = format!(
        "{}; {pretty}; {}",
        sh.cd_or_exit(cwd),
        sh.pause_tail()
    );

    let child = terminal_command(&term, sh, &script, cwd)
        .spawn()
        .map_err(|e| AppError::Spawn(e.to_string()))?;
    watch_terminal(app, child, pretty);
    Ok(())
}

/// Who is listening on a TCP port.
///
/// Uses `ss` where available, falling back to `lsof`. Returns pids with
/// the process name where known, so the confirmation dialog can say *what* it is
/// about to signal rather than just a number.
pub async fn port_holders(
    tc: &crate::toolchain::Toolchain,
    port: u16,
) -> Vec<(u32, String)> {
    if let Some(ss) = tc.path("ss") {
        let out = tokio::process::Command::new(ss)
            // -H omits the header, -p includes the owning process.
            .args(["-ltnpH", &format!("sport = :{port}")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await;
        if let Ok(o) = out {
            let holders = parse_ss_holders(&String::from_utf8_lossy(&o.stdout));
            if !holders.is_empty() {
                return holders;
            }
        }
    }

    if let Some(lsof) = tc.path("lsof") {
        let out = tokio::process::Command::new(lsof)
            .args(["-ti", &format!(":{port}"), "-sTCP:LISTEN"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await;
        if let Ok(o) = out {
            return String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().parse::<u32>().ok())
                .map(|pid| (pid, String::new()))
                .collect();
        }
    }

    Vec::new()
}

// Moved to `platform::ports`, which parses the Windows equivalents beside it.
pub use crate::platform::parse_ss_holders;

#[cfg(test)]
mod tests {
    use super::*;

    /// The command a terminal receives, as it would be spawned.
    fn built(term: &TerminalCmd, script: &str) -> Vec<String> {
        let sh = crate::platform::test_shell(crate::platform::ShellKind::Posix);
        let cmd = terminal_command(term, sh, script, Path::new("/"));
        cmd.get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn an_emulator_that_wants_one_string_gets_one_argument() {
        // ptyxis: `--tab` only combines with `-x`, which takes the whole command line
        // as a single argument. Handed a real argv after `--` it ignored `--tab` and
        // opened a window, and handed `-x bash -lc '…'` it replied "Unknown option
        // -lc" to a discarded stderr and opened nothing at all.
        let term = TerminalCmd {
            program: "/usr/bin/ptyxis".into(),
            pre: vec!["--tab".into(), "-x".into()],
            single_string: true,
        };
        let args = built(&term, "echo hi");
        assert_eq!(args, ["--tab", "-x", "bash -lc 'echo hi'"]);
    }

    #[test]
    fn a_quote_in_the_script_survives_being_wrapped() {
        // The wrapper's own `read -n1 -r -p '…'` puts quotes in every script, so this
        // is the normal case rather than an edge one.
        let term = TerminalCmd {
            program: "/usr/bin/ptyxis".into(),
            pre: vec!["-x".into()],
            single_string: true,
        };
        let args = built(&term, "read -p 'go on'");
        assert_eq!(args.last().unwrap(), r"bash -lc 'read -p '\''go on'\'''");
    }

    #[test]
    fn an_emulator_that_takes_an_argv_is_not_double_quoted() {
        let term = TerminalCmd {
            program: "/usr/bin/gnome-terminal".into(),
            pre: vec!["--tab".into(), "--".into()],
            single_string: false,
        };
        assert_eq!(built(&term, "echo hi"), ["--tab", "--", "bash", "-lc", "echo hi"]);
    }

    #[test]
    fn parses_ss_single_holder() {
        let out = r#"LISTEN 0 511 *:8100 *:* users:(("node",pid=12345,fd=20))"#;
        assert_eq!(parse_ss_holders(out), vec![(12345, "node".to_string())]);
    }

    #[test]
    fn parses_ss_multiple_holders_and_dedupes() {
        let out = "LISTEN 0 511 *:3000 *:* users:((\"node\",pid=111,fd=20),(\"node\",pid=222,fd=21))\n\
                   LISTEN 0 511 [::]:3000 [::]:* users:((\"node\",pid=111,fd=22))";
        let h = parse_ss_holders(out);
        assert_eq!(h.len(), 2);
        assert!(h.contains(&(111, "node".to_string())));
        assert!(h.contains(&(222, "node".to_string())));
    }

    #[test]
    fn no_holders_when_nothing_listens() {
        assert!(parse_ss_holders("").is_empty());
        assert!(parse_ss_holders("LISTEN 0 511 *:8100 *:*").is_empty());
    }
}

