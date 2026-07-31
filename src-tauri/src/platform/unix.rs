//! The Linux and macOS half of `platform`.
//!
//! Deliberately thin: almost everything the app does is already POSIX-shaped, so
//! this file exists mostly to name the assumptions the rest of the codebase used
//! to make implicitly.

use std::path::{Path, PathBuf};

/// `/`, which is guaranteed to exist and which nothing here writes to.
pub fn fallback_dir() -> PathBuf {
    PathBuf::from("/")
}

/// Install locations that exist independently of any shell configuration.
///
/// The version managers come first and newest-first within nvm, so a stale old
/// install cannot win over the current one.
pub fn tool_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(h) = super::home_dir() {
        dirs.extend(nvm_bin_dirs(&h));
        dirs.push(h.join(".bun/bin"));
        dirs.push(h.join(".local/share/fnm/aliases/default/bin"));
        dirs.push(h.join(".asdf/shims"));
        dirs.push(h.join(".volta/bin"));
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(".cargo/bin"));
    }

    dirs.extend(gui_install_dirs());
    dirs
}

/// Where a GUI installer or a system package puts a binary.
pub fn gui_install_dirs() -> Vec<PathBuf> {
    ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/snap/bin"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

/// `~/.nvm/versions/node/*/bin`, newest version first.
fn nvm_bin_dirs(home: &Path) -> Vec<PathBuf> {
    let root = home.join(".nvm/versions/node");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut versions: Vec<(Vec<u32>, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.join("bin").is_dir())
        .map(|p| {
            let name = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .trim_start_matches('v')
                .to_string();
            (crate::toolchain::parse_version(&name), p.join("bin"))
        })
        .collect();

    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, p)| p).collect()
}

pub fn gh_config_path() -> Option<PathBuf> {
    super::home_dir().map(|h| h.join(".config/gh/hosts.yml"))
}

/// The distro's own name for itself, which is far more useful on the setup page
/// than "linux".
pub fn os_label() -> String {
    for path in ["/etc/os-release", "/usr/lib/os-release"] {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                let v = v.trim().trim_matches('"');
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
    }
    std::env::consts::OS.to_string()
}

/// One candidate per directory: on unix a program's name is its whole name.
pub fn path_exts() -> Vec<String> {
    vec![String::new()]
}

pub fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

pub fn exec_bit_set(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Nothing to strip: `canonicalize` returns a plain absolute path.
pub fn strip_verbatim(p: &Path) -> PathBuf {
    p.to_path_buf()
}

// ---------------------------------------------------------------------------
// Child-process shaping and process groups
// ---------------------------------------------------------------------------

pub fn new_group(cmd: &mut tokio::process::Command) {
    unsafe {
        // pre_exec runs post-fork/pre-exec and must be async-signal-safe. setsid()
        // is. Do not add anything else to this closure.
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

pub fn detach(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt as _;
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

/// A process group. The child was made a session leader by `new_group`, so its pid
/// is also its pgid.
pub struct GroupInner {
    pgid: i32,
}

pub fn adopt(pid: u32, _handle: Option<isize>) -> GroupInner {
    GroupInner { pgid: pid as i32 }
}

impl GroupInner {
    pub fn display_pid(&self) -> u32 {
        self.pgid.max(0) as u32
    }

    /// Always true: a process group *is* the whole tree.
    pub fn is_tree(&self) -> bool {
        self.pgid > 1
    }

    /// Returns whether a grace period is worth waiting: SIGTERM is a request, so it is.
    pub fn request_stop(&self) -> bool {
        if self.pgid <= 1 {
            return false;
        }
        unsafe {
            libc::killpg(self.pgid, libc::SIGTERM);
        }
        true
    }

    pub fn kill(&self) {
        if self.pgid <= 1 {
            return;
        }
        unsafe {
            libc::killpg(self.pgid, libc::SIGKILL);
        }
    }

    pub fn hangup(&self) {
        if self.pgid <= 1 {
            return;
        }
        unsafe {
            libc::killpg(self.pgid, libc::SIGHUP);
        }
    }
}

// ---------------------------------------------------------------------------
// Port inspection
// ---------------------------------------------------------------------------

use std::process::Stdio;

/// `ss` where available, falling back to `lsof`.
pub async fn port_holders(tc: &crate::toolchain::Toolchain, port: u16) -> Vec<(u32, String)> {
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
            let holders = super::parse_ss_holders(&String::from_utf8_lossy(&o.stdout));
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

/// SIGTERM, which a well-behaved server catches to shut down cleanly.
pub fn kill_pid_argv(pid: u32) -> Vec<String> {
    vec!["kill".to_string(), "-TERM".to_string(), pid.to_string()]
}

// ---------------------------------------------------------------------------
// External terminal
// ---------------------------------------------------------------------------

pub fn find_terminal() -> Option<super::TerminalCmd> {
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.trim().is_empty() {
            // An unknown emulator: `-e cmd args` is the one convention nearly all of
            // them share, and a tab flag would be a guess.
            return Some(super::TerminalCmd {
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
        if let Some(p) = super::which(bin) {
            return Some(super::TerminalCmd {
                program: p.display().to_string(),
                pre: pre.iter().map(|s| s.to_string()).collect(),
                single_string,
            });
        }
    }
    None
}
