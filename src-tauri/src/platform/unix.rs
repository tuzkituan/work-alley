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
