use crate::model::{
    CommitEntry, Category, LastCommit, RepoRef, RepoStatus, StaleState, SyncState,
};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Per-git-call ceiling. Without it, one NFS-stalled or lock-contended repo hangs
/// the entire scan.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

// --- pure parsing -----------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
pub struct Porcelain {
    pub branch: Option<String>,
    pub head_sha: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: u32,
    pub untracked: u32,
    pub conflicts: u32,
}

/// Parses `git status --porcelain=v2 --branch`.
///
/// One invocation yields branch, upstream, ahead/behind and every changed path —
/// so a full per-repo scan is 2 processes (this plus `log -1`), not 5.
pub fn parse_porcelain_v2(input: &str) -> Porcelain {
    let mut p = Porcelain::default();

    for line in input.lines() {
        if let Some(rest) = line.strip_prefix("# branch.oid ") {
            let v = rest.trim();
            if v != "(initial)" {
                p.head_sha = Some(v.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.head ") {
            let v = rest.trim();
            // Literally "(detached)" when HEAD is not on a branch. Treating this
            // as a branch name would show a repo "on branch (detached)" with
            // meaningless ahead/behind.
            if v == "(detached)" {
                p.detached = true;
            } else {
                p.branch = Some(v.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            p.upstream = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for tok in rest.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    p.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    p.behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(first) = line.split_whitespace().next() {
            match first {
                // 1 = ordinary change, 2 = rename/copy
                "1" | "2" => p.dirty += 1,
                "u" => p.conflicts += 1,
                "?" => p.untracked += 1,
                _ => {}
            }
        }
    }

    p
}

impl Porcelain {
    pub fn sync_state(&self) -> SyncState {
        if self.upstream.is_none() {
            SyncState::NoUpstream
        } else if self.ahead == 0 && self.behind == 0 {
            SyncState::InSync
        } else {
            SyncState::Diverged {
                ahead: self.ahead,
                behind: self.behind,
            }
        }
    }
}

/// "22m" / "4h" / "9d" — matching the design's compact form.
pub fn relative_time(unix: i64, now: i64) -> String {
    let d = (now - unix).max(0);
    match d {
        0..=59 => format!("{d}s"),
        60..=3599 => format!("{}m", d / 60),
        3600..=86_399 => format!("{}h", d / 3600),
        86_400..=2_591_999 => format!("{}d", d / 86_400),
        2_592_000..=31_535_999 => format!("{}mo", d / 2_592_000),
        _ => format!("{}y", d / 31_536_000),
    }
}

/// Parses `%h\t%ct\t%an\t%s`.
pub fn parse_log_line(line: &str, now: i64) -> Option<(String, i64, String, String)> {
    let mut parts = line.splitn(4, '\t');
    let sha = parts.next()?.trim().to_string();
    let unix: i64 = parts.next()?.trim().parse().ok()?;
    let author = parts.next()?.trim().to_string();
    let subject = parts.next().unwrap_or("").trim().to_string();
    let _ = now;
    Some((sha, unix, author, subject))
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// --- running git ------------------------------------------------------------

/// Builds a `git` command with the hardening every child gets.
pub fn git_cmd(git: &Path, repo: &Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(git);
    c.arg("-C").arg(repo);
    harden(&mut c);
    c
}

/// Applied to *every* spawned child, git or not.
pub fn harden(c: &mut tokio::process::Command) {
    // No child can ever block on a prompt nobody is reading.
    c.stdin(Stdio::null());
    // Fail fast instead of hanging forever on a passphrase prompt written into a
    // pipe with no reader.
    c.env("GIT_TERMINAL_PROMPT", "0");
    c.env(
        "GIT_SSH_COMMAND",
        "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    );
    // This is what *enforces* a read-only scan: plain `git status` refreshes and
    // writes .git/index, which would dirty 63 repos' mtimes and fight the user's
    // own git.
    c.env("GIT_OPTIONAL_LOCKS", "0");
    c.env("NO_COLOR", "1");
    c.env("CI", "1");
    c.env("FORCE_COLOR", "0");
}

async fn git_output(git: &Path, repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut c = git_cmd(git, repo);
    c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());

    let child = c.spawn().map_err(|e| e.to_string())?;
    let out = match tokio::time::timeout(GIT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err(format!("timed out after {}ms", GIT_TIMEOUT.as_millis())),
    };

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// --- staleness --------------------------------------------------------------

/// Uses `.git/FETCH_HEAD` mtime, falling back through the remote ref and
/// packed-refs. `unknown` is a legitimate answer, not a failure.
pub fn staleness(repo: &Path, branch: Option<&str>, stale_days: i64) -> StaleState {
    let candidates = {
        let mut v = vec![repo.join(".git/FETCH_HEAD")];
        if let Some(b) = branch {
            v.push(repo.join(format!(".git/refs/remotes/origin/{b}")));
        }
        v.push(repo.join(".git/packed-refs"));
        v
    };

    for c in candidates {
        if let Ok(meta) = std::fs::metadata(&c) {
            if let Ok(mtime) = meta.modified() {
                if let Ok(d) = mtime.duration_since(UNIX_EPOCH) {
                    let unix = d.as_secs() as i64;
                    let days = (now_unix() - unix) / 86_400;
                    return if days >= stale_days {
                        StaleState::Stale {
                            last_fetch_unix: unix,
                            days,
                        }
                    } else {
                        StaleState::Fresh {
                            last_fetch_unix: unix,
                        }
                    };
                }
            }
        }
    }

    StaleState::Unknown
}

// --- per-repo scan ----------------------------------------------------------

/// Scans one repo. **Never returns Err** — a failure is recorded in
/// `RepoStatus::error`, which makes "one broken repo fails the whole scan"
/// unrepresentable in the type rather than merely unlikely.
pub async fn scan_one(
    git: PathBuf,
    repo: RepoRef,
    path: PathBuf,
    stale_days: i64,
    ui_package: String,
) -> RepoStatus {
    let started = Instant::now();
    let now = now_unix();

    if !crate::paths::has_git(&path) {
        return RepoStatus::errored(repo, path, "not a git repository");
    }

    let mut status = RepoStatus::errored(repo.clone(), path.clone(), "");
    status.error = None;

    match git_output(&git, &path, &["status", "--porcelain=v2", "--branch"]).await {
        Ok(text) => {
            let p = parse_porcelain_v2(&text);
            status.branch = p.branch.clone();
            status.head_sha = p.head_sha.clone();
            status.detached = p.detached;
            status.dirty_count = p.dirty;
            status.untracked_count = p.untracked;
            status.conflict_count = p.conflicts;
            status.sync = p.sync_state();
            status.stale = staleness(&path, p.branch.as_deref(), stale_days);
        }
        Err(e) => {
            // Partial failure: keep going so the card still shows a name, a path
            // and its package.json version.
            status.error = Some(e);
        }
    }

    if let Ok(text) = git_output(
        &git,
        &path,
        &["log", "-1", "--no-color", "--format=%h%x09%ct%x09%an%x09%s"],
    )
    .await
    {
        if let Some(line) = text.lines().next() {
            if let Some((sha, unix, author, subject)) = parse_log_line(line, now) {
                status.last_commit = Some(LastCommit {
                    sha,
                    subject,
                    author,
                    unix,
                    relative: relative_time(unix, now),
                });
            }
        }
    }

    status.ui_dep = crate::pkg::read_ui_dep(&path, &ui_package).await;
    status.dev_port = crate::pkg::detect_port(&path).map(|(p, _)| p);
    status.available_tasks = crate::pkg::available_tasks(&path);
    status.scan_ms = started.elapsed().as_millis() as u64;
    status
}

/// Recent commits for one repo, for the workspace-wide merge.
pub async fn recent_for(
    git: &Path,
    repo: &RepoRef,
    path: &Path,
    limit: u32,
) -> Vec<CommitEntry> {
    let now = now_unix();
    let arg = format!("-{limit}");
    let Ok(text) = git_output(
        git,
        path,
        &[
            "log",
            &arg,
            "--no-merges",
            "--no-color",
            "--format=%h%x09%ct%x09%an%x09%s",
        ],
    )
    .await
    else {
        return Vec::new();
    };

    text.lines()
        .filter_map(|l| parse_log_line(l, now))
        .map(|(sha, unix, author, subject)| CommitEntry {
            repo: repo.clone(),
            sha,
            subject,
            author,
            unix,
            relative: relative_time(unix, now),
        })
        .collect()
}

/// Local + remote branches, most recently committed first. Read-only.
pub async fn list_branches(state: &AppState, repo: &RepoRef) -> Result<Vec<String>, String> {
    let git = state
        .toolchain()
        .require("git")
        .map_err(|e| e.to_string())?;
    let path = crate::paths::resolve_repo(&state.workspace_root(), repo)
        .map_err(|e| e.to_string())?;
    let text = git_output(
        &git,
        &path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--count=60",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes/origin",
        ],
    )
    .await?;

    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let b = line.trim().trim_start_matches("origin/");
        if b.is_empty() || b == "HEAD" {
            continue;
        }
        if seen.insert(b.to_string()) {
            out.push(b.to_string());
        }
    }
    Ok(out)
}

/// Extracts `owner/repo` from a remote URL.
///
/// Derived from the remote rather than from repos.json's `org`, so it stays right
/// for a fork or a repo in a different org.
pub fn parse_remote_slug(url: &str) -> Option<String> {
    let u = url.trim().trim_end_matches('/');
    let u = u.strip_suffix(".git").unwrap_or(u);

    // git@host:owner/repo  (host may be an ssh alias like github.com-work)
    if let Some(rest) = u.split_once(':').map(|(_, r)| r) {
        if !u.starts_with("http") {
            let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
            if parts.len() >= 2 {
                return Some(format!(
                    "{}/{}",
                    parts[parts.len() - 2],
                    parts[parts.len() - 1]
                ));
            }
        }
    }

    // https://host/owner/repo  or  ssh://git@host/owner/repo
    let after_scheme = u.split("://").nth(1).unwrap_or(u);
    let parts: Vec<&str> = after_scheme.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 3 {
        return Some(format!(
            "{}/{}",
            parts[parts.len() - 2],
            parts[parts.len() - 1]
        ));
    }

    None
}

pub async fn remote_slug(git: &Path, repo: &Path) -> Option<String> {
    let out = git_output(git, repo, &["remote", "get-url", "origin"]).await.ok()?;
    parse_remote_slug(out.lines().next()?)
}

/// Parses `git status --porcelain=v2` into per-file entries for the detail view.
pub fn parse_changed_files(input: &str) -> Vec<crate::model::ChangedFile> {
    use crate::model::ChangedFile;
    let mut out = Vec::new();

    for line in input.lines() {
        let mut it = line.split_whitespace();
        let Some(kind) = it.next() else { continue };

        match kind {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            "1" => {
                let xy = it.next().unwrap_or("..").to_string();
                let path = line.split_whitespace().skip(8).collect::<Vec<_>>().join(" ");
                if path.is_empty() {
                    continue;
                }
                out.push(ChangedFile {
                    staged: !xy.starts_with('.'),
                    untracked: false,
                    conflicted: false,
                    code: xy,
                    path,
                });
            }
            // 2 <XY> … <path><tab><origPath>
            "2" => {
                let xy = it.next().unwrap_or("..").to_string();
                let tail = line.split_whitespace().skip(9).collect::<Vec<_>>().join(" ");
                let path = tail.split('\t').next().unwrap_or("").to_string();
                if path.is_empty() {
                    continue;
                }
                out.push(ChangedFile {
                    staged: !xy.starts_with('.'),
                    untracked: false,
                    conflicted: false,
                    code: xy,
                    path,
                });
            }
            "u" => {
                let xy = it.next().unwrap_or("UU").to_string();
                let path = line.split_whitespace().skip(10).collect::<Vec<_>>().join(" ");
                if path.is_empty() {
                    continue;
                }
                out.push(ChangedFile {
                    staged: false,
                    untracked: false,
                    conflicted: true,
                    code: xy,
                    path,
                });
            }
            "?" => {
                let path = line.split_whitespace().skip(1).collect::<Vec<_>>().join(" ");
                if path.is_empty() {
                    continue;
                }
                out.push(ChangedFile {
                    code: "??".into(),
                    staged: false,
                    untracked: true,
                    conflicted: false,
                    path,
                });
            }
            _ => {}
        }
    }

    out
}

pub async fn changed_files(
    git: &Path,
    repo: &Path,
) -> Result<Vec<crate::model::ChangedFile>, String> {
    let text = git_output(git, repo, &["status", "--porcelain=v2"]).await?;
    Ok(parse_changed_files(&text))
}

pub fn categories_or_all(opt: Option<Vec<Category>>) -> Vec<Category> {
    opt.filter(|v| !v.is_empty())
        .unwrap_or_else(|| Category::ALL.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured verbatim from fe/blazeup-hostapp on this machine.
    const REAL: &str = "\
# branch.oid 291bc21a9f1e0c8f9b1c2d3e4f5a6b7c8d9e0f1a
# branch.head v26
# branch.upstream origin/v26
# branch.ab +0 -6
1 .M N... 100644 100644 100644 aaa bbb src/App.tsx
1 M. N... 100644 100644 100644 ccc ddd package.json
? .env.local
";

    #[test]
    fn parses_real_status() {
        let p = parse_porcelain_v2(REAL);
        assert_eq!(p.branch.as_deref(), Some("v26"));
        assert_eq!(p.upstream.as_deref(), Some("origin/v26"));
        assert_eq!(p.ahead, 0);
        assert_eq!(p.behind, 6);
        assert_eq!(p.dirty, 2);
        assert_eq!(p.untracked, 1);
        assert_eq!(p.conflicts, 0);
        assert!(!p.detached);
        assert!(matches!(
            p.sync_state(),
            SyncState::Diverged { ahead: 0, behind: 6 }
        ));
    }

    #[test]
    fn detached_head_is_not_a_branch() {
        let p = parse_porcelain_v2("# branch.oid abc123\n# branch.head (detached)\n");
        assert!(p.detached);
        assert_eq!(p.branch, None);
    }

    #[test]
    fn no_upstream_is_distinct_from_in_sync() {
        let p = parse_porcelain_v2("# branch.oid abc\n# branch.head main\n");
        assert!(matches!(p.sync_state(), SyncState::NoUpstream));

        let q = parse_porcelain_v2(
            "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n",
        );
        assert!(matches!(q.sync_state(), SyncState::InSync));
    }

    #[test]
    fn counts_renames_and_conflicts() {
        let p = parse_porcelain_v2(
            "2 R. N... 100644 100644 100644 aaa bbb R100 new\told\nu UU N... 1 2 3 x y z conflicted.ts\n",
        );
        assert_eq!(p.dirty, 1);
        assert_eq!(p.conflicts, 1);
    }

    #[test]
    fn ahead_and_behind_both_parsed() {
        let p = parse_porcelain_v2("# branch.ab +3 -11\n");
        assert_eq!(p.ahead, 3);
        assert_eq!(p.behind, 11);
    }

    #[test]
    fn empty_input_is_safe() {
        let p = parse_porcelain_v2("");
        assert_eq!(p, Porcelain::default());
    }

    #[test]
    fn parses_remote_slugs() {
        // The workspace uses an ssh alias, which must not be mistaken for the owner.
        assert_eq!(
            parse_remote_slug("git@github.com-work:blazeupai/blazeup-hostapp.git").as_deref(),
            Some("blazeupai/blazeup-hostapp")
        );
        assert_eq!(
            parse_remote_slug("git@github.com:owner/repo").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(
            parse_remote_slug("https://github.com/owner/repo.git").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(
            parse_remote_slug("ssh://git@github.com/owner/repo.git").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(parse_remote_slug("not a url"), None);
    }

    #[test]
    fn parses_changed_files() {
        let input = "\
# branch.head main
1 .M N... 100644 100644 100644 aaa bbb src/App.tsx
1 M. N... 100644 100644 100644 ccc ddd package.json
u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts
? .env.local
";
        let files = parse_changed_files(input);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "src/App.tsx");
        assert!(!files[0].staged, "'.M' is unstaged");
        assert!(files[1].staged, "'M.' is staged");
        assert!(files[2].conflicted);
        assert!(files[3].untracked);
        assert_eq!(files[3].path, ".env.local");
    }

    #[test]
    fn relative_times() {
        let now = 1_000_000_000;
        assert_eq!(relative_time(now - 30, now), "30s");
        assert_eq!(relative_time(now - 22 * 60, now), "22m");
        assert_eq!(relative_time(now - 4 * 3600, now), "4h");
        assert_eq!(relative_time(now - 9 * 86_400, now), "9d");
        // A clock skew must not produce a negative duration.
        assert_eq!(relative_time(now + 500, now), "0s");
    }

    #[test]
    fn parses_log_line_with_tabs_in_subject() {
        let (sha, unix, author, subject) =
            parse_log_line("4f21ab9\t1700000000\tKim Tuan\tfeat: saved\tviews", 0).unwrap();
        assert_eq!(sha, "4f21ab9");
        assert_eq!(unix, 1_700_000_000);
        assert_eq!(author, "Kim Tuan");
        // splitn(4) keeps the remainder intact.
        assert_eq!(subject, "feat: saved\tviews");
    }
}
