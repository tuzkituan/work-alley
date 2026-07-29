use crate::error::{AppError, AppResult};
use crate::model::{Category, RepoRef};
use std::path::{Path, PathBuf};

/// Best-effort guess at a workspace, used only when nothing is saved yet.
///
/// Returns None rather than an error: with a user-chosen folder, "no workspace
/// yet" is the normal first-run state, not a failure.
pub fn guess_workspace_root() -> Option<PathBuf> {
    discover_workspace_root().ok()
}

/// Finds a workspace root by walking up from the cwd, then `$HOME/work-alley`.
pub fn discover_workspace_root() -> AppResult<PathBuf> {
    if let Ok(explicit) = std::env::var("WORK_ALLEY_ROOT") {
        let p = PathBuf::from(explicit);
        if is_workspace(&p) {
            return Ok(p);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let mut cur: Option<&Path> = Some(cwd.as_path());
        while let Some(dir) = cur {
            if is_workspace(dir) {
                return Ok(dir.to_path_buf());
            }
            cur = dir.parent();
        }
    }

    if let Some(home) = std::env::var_os("HOME") {
        let p = PathBuf::from(home).join("work-alley");
        if is_workspace(&p) {
            return Ok(p);
        }
    }

    Err(AppError::WorkspaceNotFound(
        "no ancestor directory contains repos.json and a be/fe/sa/ui dir".into(),
    ))
}

/// A folder counts as a workspace if it has at least one category directory
/// containing a git repo. `repos.json` is a nice-to-have, not a requirement — it
/// only supplies the "declared but not cloned" counts.
pub fn is_workspace(dir: &Path) -> bool {
    if dir.as_os_str().is_empty() || !dir.is_dir() {
        return false;
    }
    Category::ALL.iter().any(|c| {
        let d = dir.join(c.dir());
        d.is_dir()
            && std::fs::read_dir(&d)
                .map(|mut e| e.any(|x| x.map(|x| has_git(&x.path())).unwrap_or(false)))
                .unwrap_or(false)
    }) || dir.join("repos.json").is_file()
}

pub fn category_dir(root: &Path, c: Category) -> PathBuf {
    root.join(c.dir())
}

pub fn repo_path(root: &Path, r: &RepoRef) -> PathBuf {
    root.join(r.category.dir()).join(&r.name)
}

pub fn scripts_dir(root: &Path) -> PathBuf {
    root.join("scripts")
}

/// Every cwd handed to a child process passes through here.
///
/// Canonicalizes and asserts containment inside the workspace, so `..`, a symlink
/// pointing out, or an absolute path from a compromised frontend cannot escape.
/// The repo name itself is also rejected if it contains a separator.
pub fn ensure_inside(root: &Path, candidate: &Path) -> AppResult<PathBuf> {
    let root_c = root
        .canonicalize()
        .map_err(|e| AppError::PathEscape(format!("workspace root unreadable: {e}")))?;
    let cand_c = candidate
        .canonicalize()
        .map_err(|e| AppError::PathEscape(format!("{}: {e}", candidate.display())))?;
    if !cand_c.starts_with(&root_c) {
        return Err(AppError::PathEscape(cand_c.display().to_string()));
    }
    Ok(cand_c)
}

/// Validates a RepoRef against the filesystem and returns its canonical path.
pub fn resolve_repo(root: &Path, r: &RepoRef) -> AppResult<PathBuf> {
    if r.name.is_empty()
        || r.name.contains('/')
        || r.name.contains('\\')
        || r.name.starts_with('.')
    {
        return Err(AppError::UnknownRepo(r.key()));
    }
    let p = repo_path(root, r);
    if !p.is_dir() {
        return Err(AppError::UnknownRepo(r.key()));
    }
    ensure_inside(root, &p)
}

/// A repo is scannable if it has a `.git` — which may be a directory or, for
/// worktrees and submodules, a file.
pub fn has_git(dir: &Path) -> bool {
    let g = dir.join(".git");
    g.is_dir() || g.is_file()
}

/// Lists every cloned repo on disk, ordered by category then name.
pub fn discover_repos(root: &Path, categories: &[Category]) -> Vec<(RepoRef, PathBuf)> {
    let mut out = Vec::new();
    for c in categories {
        let dir = category_dir(root, *c);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue; // category dir may be absent (be/ is empty here) — not an error
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort_by_key(|n| n.to_lowercase());
        for name in names {
            let path = dir.join(&name);
            if has_git(&path) {
                out.push((
                    RepoRef {
                        category: *c,
                        name,
                    },
                    path,
                ));
            }
        }
    }
    out
}
