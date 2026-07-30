//! The Windows half of `platform`.
//!
//! Every function here has a counterpart in `unix.rs`, and the pure logic that
//! consumes them lives in `mod.rs` so it can be tested on a Linux dev box. What is
//! left in this file is what genuinely cannot be: registry-shaped directory
//! layouts, `PATHEXT`, and the absence of an exec bit.

use std::path::{Path, PathBuf};

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// The system drive's root, then the temp directory.
///
/// `%SystemDrive%` is normally `C:`, which as a *path* means "the current
/// directory on C:" rather than the root — hence the explicit separator.
pub fn fallback_dir() -> PathBuf {
    if let Some(drive) = std::env::var_os("SystemDrive") {
        let root = PathBuf::from(format!("{}\\", drive.to_string_lossy()));
        if root.is_dir() {
            return root;
        }
    }
    std::env::temp_dir()
}

/// Install locations that exist independently of any shell configuration.
///
/// This list is doing the job that `$SHELL -lic 'command -v …'` does on unix, and
/// it has to, because Windows has no login shell to ask. Ordered most-specific
/// first: a version manager's shim must win over a system-wide install, or
/// switching Node versions would silently have no effect.
pub fn tool_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    // nvm-windows re-points a single symlink rather than keeping a directory per
    // version on PATH, so the symlink *is* the answer and there is no list to sort.
    if let Some(d) = env_dir("NVM_SYMLINK") {
        dirs.push(d);
    }
    if let Some(home) = env_dir("NVM_HOME") {
        dirs.push(home);
    }

    if let Some(appdata) = env_dir("APPDATA") {
        dirs.push(appdata.join("fnm").join("aliases").join("default"));
        // npm's global prefix, which is where `npm i -g` puts its shims.
        dirs.push(appdata.join("npm"));
    }

    if let Some(local) = env_dir("LOCALAPPDATA") {
        dirs.push(local.join("Volta").join("bin"));
        dirs.push(local.join("fnm"));
        // App Execution Aliases live here — winget's own entry point among them.
        dirs.push(local.join("Microsoft").join("WindowsApps"));
        dirs.extend(programs_dirs(&local.join("Programs")));
    }

    if let Some(h) = super::home_dir() {
        dirs.push(h.join(".bun").join("bin"));
        dirs.push(h.join(".cargo").join("bin"));
        dirs.push(h.join("scoop").join("shims"));
    }

    dirs.extend(gui_install_dirs());
    dirs
}

/// Where an installer or a system component puts a binary.
pub fn gui_install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(data) = env_dir("ProgramData") {
        dirs.push(data.join("chocolatey").join("bin"));
    }

    // Both program-files roots: a 32-bit installer on a 64-bit machine lands in
    // the (x86) one, and `gh` in particular has shipped both ways.
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        let Some(pf) = env_dir(var) else { continue };
        dirs.push(pf.join("nodejs"));
        dirs.push(pf.join("GitHub CLI"));
        // Git for Windows: `cmd` holds the wrappers meant for outside callers,
        // `bin` holds bash.exe, and `usr/bin` holds the MSYS coreutils.
        dirs.push(pf.join("Git").join("cmd"));
        dirs.push(pf.join("Git").join("bin"));
        dirs.push(pf.join("Git").join("usr").join("bin"));
        dirs.push(pf.join("Docker").join("Docker").join("resources").join("bin"));
        dirs.push(pf.join("PowerShell").join("7"));
    }

    if let Some(windir) = env_dir("WINDIR") {
        let sys32 = windir.join("System32");
        // ssh-add.exe and ssh.exe have shipped in-box since Windows 10 1809, but
        // this directory is not on a GUI app's inherited PATH often enough to rely on.
        dirs.push(sys32.join("OpenSSH"));
        dirs.push(sys32.join("WindowsPowerShell").join("v1.0"));
        dirs.push(sys32);
    }

    dirs
}

/// Each immediate child of `%LOCALAPPDATA%\Programs`, plus its `bin`.
///
/// This is where per-user GUI installers land — VS Code, the JetBrains IDEs,
/// Cursor. Both levels are needed: some ship the launcher at the top, some under
/// `bin`.
fn programs_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.is_dir() {
            out.push(p.join("bin"));
            out.push(p);
        }
    }
    out
}

/// gh's own default on Windows, which is *not* `~/.config/gh`.
pub fn gh_config_path() -> Option<PathBuf> {
    env_dir("APPDATA").map(|d| d.join("GitHub CLI").join("hosts.yml"))
}

/// `Microsoft Windows [Version 10.0.26100.4061]` → `Windows 10.0.26100`.
///
/// Reading `ProductName` from the registry would give the nicer "Windows 11 Pro",
/// but that means a registry dependency this crate does not otherwise need. The
/// result is cached by the caller, so the process spawn happens at most once.
pub fn os_label() -> String {
    let fallback = || std::env::consts::OS.to_string();

    let mut cmd = std::process::Command::new("cmd.exe");
    cmd.args(["/C", "ver"]).stdin(std::process::Stdio::null());
    hide_console_std(&mut cmd);

    let Ok(out) = cmd.output() else { return fallback() };
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(version) = text.split('[').nth(1).and_then(|s| s.split(']').next()) else {
        return fallback();
    };
    // "Version 10.0.26100.4061" → the first three components, which is the part
    // that identifies the release.
    let digits = version.trim().trim_start_matches("Version").trim();
    let short: Vec<&str> = digits.split('.').take(3).collect();
    if short.is_empty() || short[0].is_empty() {
        return fallback();
    }
    format!("Windows {}", short.join("."))
}

/// `%PATHEXT%`, lowercased and deduplicated, in the order Windows tries them.
///
/// Order matters and is not ours to choose: `PATHEXT` is why `foo.com` beats
/// `foo.exe` beats `foo.bat`, and a `which` that reorders them would resolve a
/// different program than the shell would.
pub fn path_exts() -> Vec<String> {
    let raw = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());

    let mut out: Vec<String> = Vec::new();
    for part in raw.split(';') {
        let e = part.trim().to_ascii_lowercase();
        if e.is_empty() {
            continue;
        }
        let e = if e.starts_with('.') { e } else { format!(".{e}") };
        if !out.contains(&e) {
            out.push(e);
        }
    }
    if out.is_empty() {
        out.push(".exe".to_string());
    }
    out
}

/// A file whose extension is one Windows will execute.
///
/// There is no exec bit to consult, so the extension is the whole of the test —
/// which is also why a bare `dir.join(name)` finds nothing at all.
pub fn is_executable(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    let Some(ext) = p.extension().and_then(|s| s.to_str()) else {
        return false;
    };
    let dotted = format!(".{}", ext.to_ascii_lowercase());
    super::path_exts().iter().any(|e| *e == dotted)
}

/// Every readable file, because Windows has no exec bit to ask about.
///
/// `scripts::is_script` follows this with a shebang check, which is what actually
/// decides. See the doc comment on `platform::exec_bit_set` for why this must not
/// be `is_executable`.
pub fn exec_bit_set(p: &Path) -> bool {
    p.is_file()
}

/// Drops the `\\?\` extended-length prefix that `canonicalize` adds.
///
/// A verbatim path is a valid `current_dir` but breaks anything that parses it —
/// `git -C \\?\C:\w\api` fails, and it reads as line noise in the UI.
pub fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    // A UNC share becomes \\?\UNC\server\share, whose correct plain form is
    // \\server\share — a different rewrite from the drive-letter case.
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

/// Finds `bash.exe` from Git for Windows.
///
/// Every generated script in this app is POSIX, so this is the difference between
/// the Windows build working and the Windows build being a demo. Git for Windows is
/// already a hard requirement — the app cannot scan a workspace without git — and
/// its standard installer ships `bash.exe`, so this normally succeeds.
///
/// The layouts checked, in order of how likely they are to be the *right* bash:
///   1. `PATH`, which is what the user's own shell would pick;
///   2. the directory of the resolved `git`, walked up — this catches scoop, winget
///      and portable installs without knowing their layouts, because
///      `<root>/cmd/git.exe` and `<root>/bin/bash.exe` are siblings;
///   3. the standard install roots.
///
/// Deliberately does *not* accept `bash.exe` from a WSL distribution: `wsl bash`
/// runs inside a different filesystem namespace, where `C:\w\api` is `/mnt/c/w/api`
/// and every path this app generates would be wrong.
pub fn posix_shell() -> Option<PathBuf> {
    if let Some(p) = super::which("bash") {
        if !is_wsl_stub(&p) {
            return Some(p);
        }
    }

    // Relative to git itself, which is the one tool we know we resolved.
    if let Some(git) = super::which("git") {
        let mut dir = git.parent().map(Path::to_path_buf);
        // `<root>/cmd/git.exe` and `<root>/mingw64/bin/git.exe` are both real
        // layouts, so walk up a couple of levels rather than assuming one.
        for _ in 0..3 {
            let Some(d) = dir else { break };
            for sub in ["bin", "usr/bin"] {
                let c = d.join(sub).join("bash.exe");
                if c.is_file() {
                    return Some(c);
                }
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }

    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"] {
        let Some(root) = env_dir(var) else { continue };
        for mid in ["Git", "Programs/Git"] {
            for sub in ["bin", "usr/bin"] {
                let c = root.join(mid).join(sub).join("bash.exe");
                if c.is_file() {
                    return Some(c);
                }
            }
        }
    }

    None
}

/// Whether this `bash.exe` is the WSL launcher rather than a real MSYS bash.
///
/// `%WINDIR%\System32\bash.exe` is a stub that enters a WSL distribution. It would
/// run a POSIX script perfectly well and then fail on every path in it, which is a
/// far more confusing failure than not finding bash at all.
fn is_wsl_stub(p: &Path) -> bool {
    let Some(windir) = env_dir("WINDIR") else {
        return false;
    };
    p.starts_with(windir.join("System32")) || p.starts_with(windir.join("SysWOW64"))
}

// ---------------------------------------------------------------------------
// Child-process shaping and process groups
// ---------------------------------------------------------------------------

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// Keeps a child process from flashing a console window.
///
/// Every child in this app is spawned from a `windows_subsystem = "windows"`
/// process, which owns no console — so each `git status` would allocate and destroy
/// one. Across a forty-repo scan that is forty windows appearing and vanishing.
pub fn hide_console_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt as _;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

pub fn new_group(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

pub fn detach(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt as _;
    // No CREATE_NO_WINDOW: this is for a GUI child, and DETACHED_PROCESS is what
    // stops it being torn down with us.
    cmd.creation_flags(DETACHED_PROCESS);
}

/// A Job Object owning a child and every process it goes on to create.
///
/// The raw handle is kept as an `isize` and the `Send`/`Sync` impls are asserted by
/// hand, because a Windows `HANDLE` is a raw pointer and therefore neither. That is
/// sound here: a job handle is not thread-affine, every use below is a single
/// syscall, and the handle is closed exactly once, by `Drop`.
pub struct GroupInner {
    /// `None` when the job could not be created or assigned — see `is_tree`.
    job: Option<isize>,
    pid: u32,
}

unsafe impl Send for GroupInner {}
unsafe impl Sync for GroupInner {}

impl Drop for GroupInner {
    fn drop(&mut self) {
        // The job carries KILL_ON_JOB_CLOSE, so this is also what makes the whole
        // tree die when the app exits — the `kill_on_drop` parity `supervise` wants.
        if let Some(h) = self.job.take() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(h as _);
            }
        }
    }
}

pub fn adopt(pid: u32, handle: Option<isize>) -> GroupInner {
    match create_job(pid, handle) {
        Some(job) => GroupInner { job: Some(job), pid },
        None => {
            log::warn!(
                "could not put pid {pid} in a job object; falling back to taskkill, \
                 which cannot reach a reparented grandchild"
            );
            GroupInner { job: None, pid }
        }
    }
}

fn create_job(pid: u32, handle: Option<isize>) -> Option<isize> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    unsafe {
        let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }

        // Without this the children survive us, which is the whole failure this
        // abstraction exists to prevent.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return None;
        }

        // A handle from the spawn is preferred: by the time we could open one by pid
        // the pid may already have been recycled onto a different process.
        let (proc, borrowed) = match handle {
            Some(h) if !(h as *mut std::ffi::c_void).is_null() => (h as HANDLE, true),
            _ => {
                let h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if h.is_null() {
                    CloseHandle(job);
                    return None;
                }
                (h, false)
            }
        };

        let ok = AssignProcessToJobObject(job, proc) != 0;
        if !borrowed {
            CloseHandle(proc);
        }
        if !ok {
            CloseHandle(job);
            return None;
        }
        Some(job as isize)
    }
}

impl GroupInner {
    pub fn display_pid(&self) -> u32 {
        self.pid
    }

    pub fn is_tree(&self) -> bool {
        self.job.is_some()
    }

    /// Always false: there is no graceful stop to ask for.
    ///
    /// `GenerateConsoleCtrlEvent` needs a console this GUI process does not own, and
    /// `taskkill` without `/F` posts `WM_CLOSE`, which console programs ignore. So
    /// there is nothing to wait a grace period *for*, and pretending otherwise would
    /// only add a delay before the kill.
    pub fn request_stop(&self) -> bool {
        false
    }

    pub fn kill(&self) {
        match self.job {
            Some(h) => unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(h as _, 1);
            },
            // Cannot reach a reparented grandchild, which is why it is the fallback.
            None => taskkill(self.pid),
        }
    }

    /// Terminates: a ConPTY child has no SIGHUP, and closing the pseudoconsole —
    /// which `pty::close` does by dropping the master — is the nearest equivalent.
    pub fn hangup(&self) {
        self.kill();
    }
}

/// `/T` for the tree, `/F` because a console program ignores a polite close.
pub fn taskkill(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill.exe");
    cmd.args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    hide_console_std(&mut cmd);
    let _ = cmd.status();
}

// ---------------------------------------------------------------------------
// Port inspection
// ---------------------------------------------------------------------------

/// `netstat -ano`, then one `tasklist` per pid for the name.
///
/// Deliberately not `Get-NetTCPConnection`: it means paying a PowerShell start —
/// roughly 400ms — on a path that runs while building a confirmation dialog. `netstat`
/// is in-box, needs no elevation, and there is rarely more than one holder to name.
pub async fn port_holders(tc: &crate::toolchain::Toolchain, port: u16) -> Vec<(u32, String)> {
    let _ = tc;
    let mut cmd = tokio::process::Command::new("netstat.exe");
    cmd.args(["-ano", "-p", "tcp"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    super::hide_console(&mut cmd);

    let Ok(out) = cmd.output().await else {
        return Vec::new();
    };
    let pids = super::parse_netstat_holders(&String::from_utf8_lossy(&out.stdout), port);

    let mut holders = Vec::with_capacity(pids.len());
    for pid in pids {
        holders.push((pid, tasklist_name(pid).await.unwrap_or_default()));
    }
    holders
}

async fn tasklist_name(pid: u32) -> Option<String> {
    let mut cmd = tokio::process::Command::new("tasklist.exe");
    cmd.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    super::hide_console(&mut cmd);
    let out = cmd.output().await.ok()?;
    super::parse_tasklist_csv(&String::from_utf8_lossy(&out.stdout))
}

/// `/T` for the tree and `/F` because a console program ignores a polite close —
/// there is no Windows equivalent of a catchable SIGTERM.
pub fn kill_pid_argv(pid: u32) -> Vec<String> {
    vec![
        "taskkill.exe".to_string(),
        "/F".to_string(),
        "/T".to_string(),
        "/PID".to_string(),
        pid.to_string(),
    ]
}

// ---------------------------------------------------------------------------
// External terminal
// ---------------------------------------------------------------------------

/// Windows Terminal, then a bare PowerShell window.
///
/// `wt.exe -w 0 nt -d <cwd>` maps onto this app's existing tab concept better than
/// any Linux emulator does: it opens a tab in the window you already have and sets
/// the directory natively, which makes the `cd` prelude unnecessary.
///
/// The catch, and the reason `external_terminal_available` returns false for scripts:
/// `wt` splits its *own* command line on `;`, and every script this app generates is
/// full of them.
pub fn find_terminal() -> Option<super::TerminalCmd> {
    if let Some(wt) = super::which("wt") {
        return Some(super::TerminalCmd {
            program: wt.display().to_string(),
            // `-w 0` targets the most recently used window; `nt` is new-tab.
            pre: vec!["-w".into(), "0".into(), "nt".into()],
            single_string: false,
        });
    }
    // No tabs, but a real window with a real shell in it.
    for bin in ["pwsh", "powershell"] {
        if let Some(p) = super::which(bin) {
            return Some(super::TerminalCmd {
                program: p.display().to_string(),
                pre: vec!["-NoLogo".into(), "-NoExit".into(), "-Command".into()],
                single_string: true,
            });
        }
    }
    None
}
