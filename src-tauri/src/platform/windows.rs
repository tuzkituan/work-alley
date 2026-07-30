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

/// Keeps a child process from flashing a console window.
///
/// Every child in this app is spawned from a `windows_subsystem = "windows"`
/// process, which owns no console — so each `git status` would allocate and destroy
/// one. Across a forty-repo scan that is forty windows appearing and vanishing.
pub fn hide_console_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
