use crate::error::{AppError, AppResult};
use crate::model::{Category, RepoRef};
use std::path::{Path, PathBuf};

/// A directory that certainly exists, for commands that do not care where they run.
///
/// Installing a package, writing a global git config or asking docker what is
/// running are all about the machine, not about a folder — but they were all given
/// the workspace root as their cwd, and with no workspace open that root is the
/// empty path. `Command::current_dir("")` fails with ENOENT, so the Toolbox and the
/// setup page — the two screens whose whole point is to work *before* you have a
/// workspace — died with "failed to spawn: No such file or directory".
pub fn neutral_cwd(root: &Path) -> PathBuf {
    if root.is_dir() {
        return root.to_path_buf();
    }
    if let Some(home) = crate::platform::home_dir() {
        return home;
    }
    // Guaranteed to exist, and nothing here writes to its cwd. Not a literal "/":
    // Windows has no such path, so `platform` supplies the system drive's root.
    crate::platform::fallback_dir()
}

/// Best-effort guess at a workspace, used only when nothing is saved yet.
///
/// Returns None rather than an error: with a user-chosen folder, "no workspace
/// yet" is the normal first-run state, not a failure.
pub fn guess_workspace_root() -> Option<PathBuf> {
    discover_workspace_root().ok()
}

/// Finds a workspace root: an explicit env var, else the nearest ancestor of the
/// working directory that contains repos.
///
/// There is deliberately no "well-known folder" fallback. Guessing a directory
/// name would only ever be right for whoever chose the name, and the first-run
/// picker already covers the case where nothing is saved yet.
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

    Err(AppError::WorkspaceNotFound(
        "no folder with git repos in it was found above the working directory".into(),
    ))
}

/// A folder counts as a workspace if any git repo can be found in or under it:
/// the folder itself, a repo directly inside it, or a repo one level down.
pub fn is_workspace(dir: &Path) -> bool {
    if dir.as_os_str().is_empty() || !dir.is_dir() {
        return false;
    }
    !discover_all(dir).is_empty() || dir.join("repos.json").is_file()
}

const IGNORED_DIRS: [&str; 6] = ["node_modules", "target", "dist", "build", "vendor", ".git"];

fn skippable(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name)
}

/// Every repo in the workspace, with the group it belongs to.
///
/// One rule covers every workspace shape:
///   - a repo inside a subfolder takes that **subfolder name** as its group, so a
///     workspace that already organises its repos keeps that organisation;
///   - a repo sitting **directly** in the workspace is grouped by its **detected
///     kind** (frontend / backend / library / …), or by its **language** when the
///     kind is unknown, because a flat folder has no organisation to preserve.
///
/// A mixed workspace gets both, which is why this is expressed per-repo rather
/// than as a mode switch.
pub fn discover_all(root: &Path) -> Vec<(RepoRef, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut subdirs: Vec<(String, PathBuf)> = Vec::new();
    let mut flat: Vec<(String, PathBuf)> = Vec::new();

    for e in entries.filter_map(|e| e.ok()) {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if skippable(name) {
            continue;
        }

        if has_git(&path) {
            // The directory is a repo, so it is not a group.
            flat.push((name.to_string(), path));
        } else {
            subdirs.push((name.to_string(), path));
        }
    }

    let mut out: Vec<(RepoRef, PathBuf)> = Vec::new();

    for (group, dir) in subdirs {
        let Ok(inner) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<String> = inner
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir() && has_git(p))
            .filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(String::from))
            .collect();
        names.sort_by_key(|n| n.to_lowercase());

        for name in names {
            let path = dir.join(&name);
            out.push((
                RepoRef {
                    category: group.clone(),
                    name,
                },
                path,
            ));
        }
    }

    flat.sort_by_key(|(n, _)| n.to_lowercase());
    for (name, path) in flat {
        // Detection is a few file checks plus one package.json read.
        let group = crate::detect::detect(&path).group_name();
        out.push((RepoRef { category: group, name }, path));
    }

    // Last resort: the chosen folder is itself a repo and holds no others, so it is
    // a single-project workspace.
    //
    // This must come *after* the search, not before it. A workspace can perfectly
    // well be a git repo in its own right — one that tracks a repos.json and some
    // scripts, say — and short-circuiting on that collapsed a whole workspace
    // into one entry.
    if out.is_empty() && has_git(root) {
        let name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("repo")
            .to_string();
        let group = crate::detect::detect(root).group_name();
        out.push((RepoRef { category: group, name }, root.to_path_buf()));
    }

    out
}

/// Group names with repo counts, biggest first.
pub fn discover_groups(root: &Path) -> Vec<(Category, u32)> {
    let mut counts: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for (r, _) in discover_all(root) {
        *counts.entry(r.category).or_insert(0) += 1;
    }
    let mut v: Vec<(Category, u32)> = counts.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v
}

pub fn category_dir(root: &Path, c: &str) -> PathBuf {
    if c.is_empty() {
        root.to_path_buf()
    } else {
        root.join(c)
    }
}

/// Resolves a repo's path.
///
/// A group is a directory name for a nested workspace but a *detected kind* for a
/// flat one, so `root/<group>/<name>` only sometimes exists. Falling back to
/// `root/<name>` handles the flat case without threading a mode flag everywhere.
pub fn repo_path(root: &Path, r: &RepoRef) -> PathBuf {
    let nested = root.join(&r.category).join(&r.name);
    if !r.category.is_empty() && nested.is_dir() {
        return nested;
    }
    let flat = root.join(&r.name);
    if flat.is_dir() {
        return flat;
    }
    // Single-project workspace: the root *is* the repo. Checked last, so a repo
    // that happens to share its parent folder's name still resolves correctly.
    if has_git(root) && root.file_name().and_then(|s| s.to_str()) == Some(r.name.as_str()) {
        return root.to_path_buf();
    }
    flat
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
    // `strip_verbatim`, because on Windows `canonicalize` returns the `\\?\C:\…`
    // extended-length form. That is a fine `current_dir`, but this function's result
    // also reaches generated shell text and UI strings, and `git -C \\?\C:\w\api`
    // fails.
    let root_c = crate::platform::strip_verbatim(
        &root
            .canonicalize()
            .map_err(|e| AppError::PathEscape(format!("workspace root unreadable: {e}")))?,
    );
    let cand_c = crate::platform::strip_verbatim(
        &candidate
            .canonicalize()
            .map_err(|e| AppError::PathEscape(format!("{}: {e}", candidate.display())))?,
    );
    if !cand_c.starts_with(&root_c) {
        return Err(AppError::PathEscape(cand_c.display().to_string()));
    }
    Ok(cand_c)
}

/// Validates a RepoRef against the filesystem and returns its canonical path.
pub fn resolve_repo(root: &Path, r: &RepoRef) -> AppResult<PathBuf> {
    // The group is a discovered directory name and the repo name a discovered
    // entry, but both arrive over IPC — so neither may contain a separator.
    let bad = |s: &str| s.contains('/') || s.contains('\\') || s.starts_with('.');
    if r.name.is_empty() || bad(&r.name) || bad(&r.category) {
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

/// The repos in the requested groups.
pub fn discover_repos(root: &Path, categories: &[Category]) -> Vec<(RepoRef, PathBuf)> {
    discover_all(root)
        .into_iter()
        .filter(|(r, _)| categories.iter().any(|c| c == &r.category))
        .collect()
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_machine_scoped_command_always_gets_a_cwd_that_exists() {
        // The empty path is what config falls back to when no workspace could be
        // found, and it is what made every install fail with ENOENT.
        assert!(neutral_cwd(Path::new("")).is_dir());
        assert!(neutral_cwd(Path::new("/definitely/not/a/real/directory")).is_dir());
        // A real folder is still used as given.
        let tmp = std::env::temp_dir();
        assert_eq!(neutral_cwd(&tmp), tmp);
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wa-paths-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn repo(at: &Path) {
        fs::create_dir_all(at.join(".git")).unwrap();
    }

    #[test]
    fn a_folder_that_is_itself_a_repo_is_a_one_repo_workspace() {
        let d = scratch("single");
        repo(&d);
        fs::write(d.join("package.json"), r#"{"dependencies":{"vite":"5"}}"#).unwrap();

        assert!(is_workspace(&d), "a plain project folder must be openable");
        let all = discover_all(&d);
        assert_eq!(all.len(), 1);
        // Grouped by detected kind, and the path is the root itself.
        assert_eq!(all[0].0.category, "frontend");
        assert_eq!(all[0].1, d);
        assert_eq!(repo_path(&d, &all[0].0), d);
    }

    #[test]
    fn subfolders_become_groups() {
        let d = scratch("nested");
        repo(&d.join("fe/app"));
        repo(&d.join("be/api"));

        let groups: Vec<String> = discover_groups(&d).into_iter().map(|(g, _)| g).collect();
        assert!(groups.contains(&"fe".to_string()));
        assert!(groups.contains(&"be".to_string()));

        let all = discover_all(&d);
        let app = all.iter().find(|(r, _)| r.name == "app").unwrap();
        assert_eq!(app.0.category, "fe");
        assert_eq!(repo_path(&d, &app.0), d.join("fe/app"));
    }

    #[test]
    fn flat_repos_are_grouped_by_detected_kind() {
        let d = scratch("flat");
        repo(&d.join("web"));
        fs::write(d.join("web/index.html"), "<html>").unwrap();
        repo(&d.join("api"));
        fs::write(
            d.join("api/package.json"),
            r#"{"dependencies":{"express":"4"}}"#,
        )
        .unwrap();

        let all = discover_all(&d);
        let web = all.iter().find(|(r, _)| r.name == "web").unwrap();
        let api = all.iter().find(|(r, _)| r.name == "api").unwrap();
        assert_eq!(web.0.category, "frontend");
        assert_eq!(api.0.category, "backend");
        // Flat repos live directly under the root, not under a group directory.
        assert_eq!(repo_path(&d, &api.0), d.join("api"));
    }

    #[test]
    fn a_workspace_that_is_also_a_repo_still_lists_its_contents() {
        // A common shape: a git repo that tracks repos.json and scripts, and also
        // holds every other repo in subfolders. Treating it as a single repo hid
        // all of them.
        let d = scratch("both");
        repo(&d);
        repo(&d.join("fe/app"));
        repo(&d.join("be/api"));

        let all = discover_all(&d);
        assert_eq!(all.len(), 2, "the contained repos must win over the root repo");
        assert!(all.iter().any(|(r, _)| r.name == "app" && r.category == "fe"));
        assert!(all.iter().any(|(r, _)| r.name == "api" && r.category == "be"));
        assert!(
            !all.iter().any(|(r, _)| r.name == "both"),
            "the root itself must not appear as a repo"
        );
    }

    #[test]
    fn a_folder_with_no_repos_is_not_a_workspace() {
        let d = scratch("empty");
        fs::create_dir_all(d.join("notes")).unwrap();
        assert!(!is_workspace(&d));
    }

    #[test]
    fn build_dirs_are_never_treated_as_groups() {
        let d = scratch("noise");
        repo(&d.join("node_modules/pkg"));
        repo(&d.join("target/x"));
        assert!(discover_groups(&d).is_empty());
    }
}
