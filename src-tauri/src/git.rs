use crate::model::{
    BranchInfo, Category, CommitEntry, LastCommit, RepoRef, RepoStatus, StaleState, StashEntry,
    SyncState,
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

/// The branch a repo considers its default.
///
/// From `refs/remotes/origin/HEAD`, which `git clone` sets — the only *local*
/// source of truth for what the remote's default is. `git remote show origin`
/// would also answer, but it hits the network, and this runs for every repo.
///
/// Falls back to whichever of origin/main or origin/master exists, because
/// origin/HEAD is missing in repos cloned with older git or fetched by hand.
/// Returns None when nothing can be determined, which the caller must treat as
/// "leave this repo alone" rather than guessing.
pub async fn default_branch(git: &Path, repo: &Path) -> Option<String> {
    if let Ok(out) = git_output(
        git,
        repo,
        &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    )
    .await
    {
        if let Some(b) = parse_origin_head(&out) {
            return Some(b);
        }
    }

    // One process for both candidates, in preference order.
    if let Ok(out) = git_output(
        git,
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/origin/main",
            "refs/remotes/origin/master",
        ],
    )
    .await
    {
        let mut found: Vec<String> = out
            .lines()
            .filter_map(|l| parse_origin_head(l))
            .collect();
        // for-each-ref sorts alphabetically, so main lands before master anyway;
        // sort explicitly rather than relying on that.
        found.sort_by_key(|b| if b == "main" { 0 } else { 1 });
        if let Some(b) = found.into_iter().next() {
            return Some(b);
        }
    }

    None
}

/// Whether a branch exists in a repo, locally and/or on origin.
///
/// One process for both: `git checkout <b>` succeeds when either is true — if only
/// the remote has it, git creates a tracking branch — so the caller needs to know
/// "somewhere" rather than "where".
pub async fn branch_exists(git: &Path, repo: &Path, branch: &str) -> (bool, bool) {
    let local_ref = format!("refs/heads/{branch}");
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let Ok(out) = git_output(
        git,
        repo,
        &["for-each-ref", "--format=%(refname)", &local_ref, &remote_ref],
    )
    .await
    else {
        return (false, false);
    };
    (
        out.lines().any(|l| l.trim() == local_ref),
        out.lines().any(|l| l.trim() == remote_ref),
    )
}

/// Rejects anything git itself would reject, plus anything that has no business
/// being interpolated into a generated command.
///
/// The name reaches a shell single-quoted, so this is defence in depth rather than
/// the only guard — but a name git will refuse is better caught before 60 repos
/// each report the same failure.
pub fn valid_branch_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n.len() > 255 {
        return false;
    }
    // git-check-ref-format's rules, the ones that matter here.
    if n.starts_with('-') || n.starts_with('/') || n.ends_with('/') || n.ends_with('.') {
        return false;
    }
    if n.ends_with(".lock") || n.contains("..") || n.contains("//") || n.contains("@{") {
        return false;
    }
    if n == "@" {
        return false;
    }
    !n.chars().any(|c| {
        c.is_whitespace()
            || c.is_control()
            || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\' | '\'' | '"')
    })
}

/// `"origin/main"` -> `Some("main")`. Anything without the prefix is not a branch
/// on this remote and is ignored rather than passed through.
pub fn parse_origin_head(text: &str) -> Option<String> {
    let line = text.trim();
    if line.is_empty() {
        return None;
    }
    let name = line.strip_prefix("origin/")?;
    (!name.is_empty() && name != "HEAD").then(|| name.to_string())
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
    // No console window. This app owns no console, so on Windows every child that
    // does not say otherwise allocates one, paints it and destroys it — forty of
    // them across a forty-repo scan. Applied here because every child in the app
    // passes through this function, which makes coverage impossible to forget.
    crate::platform::hide_console(c);
    // Fail fast instead of hanging forever on a passphrase prompt written into a
    // pipe with no reader.
    c.env("GIT_TERMINAL_PROMPT", "0");
    c.env(
        "GIT_SSH_COMMAND",
        "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    );
    // This is what *enforces* a read-only scan: plain `git status` refreshes and
    // writes .git/index, which would dirty every repo's mtime and fight the user's
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
    tracked_package: Option<String>,
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

    status.tracked_dep = crate::pkg::read_tracked_dep(&path, tracked_package.as_deref()).await;
    status.available_tasks = crate::pkg::available_tasks(&path);

    // One detection pass, reused three ways — it reads package.json and stats a
    // dozen paths, so doing it once per scanned repo is the whole budget for it.
    let runnable = crate::runner::run_tasks(&path);
    status.primary_task = runnable.first().map(|t| t.id.clone());
    // The port belongs to whatever this repo actually runs: a Django repo's 8000 is
    // as much "the dev port" as a vite repo's 5173, and reading only .env and
    // vite.config left every non-JS card blank.
    status.dev_port = runnable.first().and_then(|t| t.port).map(|(p, _)| p);
    status.runnable = runnable.iter().map(|t| t.info()).collect();

    // One `git remote get-url` per repo per scan, on the same budget as the rest of
    // the scan. Resolved here rather than in the UI because the frontend has never
    // known a repo's remote at all — a slug only reached it through `gh`.
    status.remote_web_base = remote_web_base(&git, &path).await;

    status.available_scripts = crate::pkg::available_scripts(&path);
    let chore_list = crate::chores::chores(&path);
    status.chores = chore_list.iter().map(|c| c.info()).collect();
    // The declared script wins: a repo that ships a `build` script has already said
    // what building means there, and it is usually more than `cargo build`.
    status.primary_build = if status.available_scripts.iter().any(|s| s == "build") {
        Some(crate::model::BuildTarget::Script {
            name: "build".into(),
            label: "build".into(),
        })
    } else {
        crate::chores::pick_build(&chore_list).map(|c| crate::model::BuildTarget::Chore {
            id: c.id.clone(),
            label: c.label.clone(),
        })
    };
    status.shape = crate::detect::detect(&path);
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

/// How many entries are on the stash. Read-only preflight for stash actions:
/// "pop" with nothing stashed is an error worth saying up front, and a growing
/// stack is worth mentioning before pushing another entry onto it.
pub async fn stash_count(git: &Path, repo: &Path) -> u32 {
    git_output(git, repo, &["stash", "list"])
        .await
        .map(|t| t.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0)
}

/// Field separator for the `for-each-ref` format below.
///
/// A tab, because every field that can contain arbitrary text is last-but-one and
/// commit subjects contain almost everything else. `splitn` bounds the damage: a
/// subject with a tab in it keeps the tab rather than eating the next field.
const REF_SEP: char = '\t';

/// Local + remote branches, most recently committed first. Read-only.
///
/// One `for-each-ref` for everything: which branches exist, whether each is local,
/// its upstream and how far it has drifted, and its tip. This used to return bare
/// strings with `origin/` stripped and duplicates merged, which threw away the
/// local-vs-remote distinction and every date — so the UI could list branches and
/// say nothing whatsoever about them.
pub async fn list_branches(state: &AppState, repo: &RepoRef) -> Result<Vec<BranchInfo>, String> {
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
            "--count=120",
            // Order matters: the subject is free-form text, so it goes last.
            "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09\
             %(committerdate:unix)%09%(objectname:short)%09%(contents:subject)",
            "refs/heads",
            "refs/remotes/origin",
        ],
    )
    .await?;

    Ok(parse_branch_lines(&text))
}

/// The parse half of `list_branches`, split out so it can be tested without a repo.
pub fn parse_branch_lines(text: &str) -> Vec<BranchInfo> {
    let mut out: Vec<BranchInfo> = Vec::new();

    for line in text.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let mut f = line.splitn(6, REF_SEP);
        let refname = f.next().unwrap_or("").trim();
        let upstream = f.next().unwrap_or("").trim();
        let track = f.next().unwrap_or("").trim();
        let date = f.next().unwrap_or("").trim();
        let sha = f.next().unwrap_or("").trim();
        let subject = f.next().unwrap_or("").trim();

        // `origin/HEAD` is a symbolic ref to the default branch, not a branch.
        if refname.is_empty() || refname == "origin/HEAD" {
            continue;
        }

        let remote_only = refname.starts_with("origin/");
        let name = refname.trim_start_matches("origin/").to_string();
        if name.is_empty() || name == "HEAD" {
            continue;
        }

        let (ahead, behind) = parse_track(track);
        let info = BranchInfo {
            name,
            local: !remote_only,
            // A remote-only branch tracks nothing from here; the field describes the
            // local branch's configured upstream.
            upstream: if remote_only || upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
            ahead,
            behind,
            last_commit_unix: date.parse().ok(),
            tip_sha: if sha.is_empty() { None } else { Some(sha.to_string()) },
            subject: if subject.is_empty() { None } else { Some(subject.to_string()) },
        };

        // Local wins on a name held by both. refs/heads is listed first only when it
        // also sorts first by date, so this cannot rely on ordering: a remote branch
        // one commit ahead sorts above its local counterpart.
        match out.iter_mut().find(|b| b.name == info.name) {
            Some(existing) if !existing.local && info.local => *existing = info,
            Some(_) => {}
            None => out.push(info),
        }
    }

    out
}

/// `[ahead 2, behind 1]` → `(2, 1)`. `[gone]` and an empty field mean no numbers.
fn parse_track(track: &str) -> (u32, u32) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    let mut ahead = 0;
    let mut behind = 0;
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// Stash entries as data, rather than as text in the output pane.
///
/// Its own command rather than a field on `RepoStatus`: the scan already runs this
/// per repo across a whole folder and is the app's latency budget, and only the
/// detail page ever wants this.
pub async fn list_stashes(state: &AppState, repo: &RepoRef) -> Result<Vec<StashEntry>, String> {
    let git = state
        .toolchain()
        .require("git")
        .map_err(|e| e.to_string())?;
    let path = crate::paths::resolve_repo(&state.workspace_root(), repo)
        .map_err(|e| e.to_string())?;
    let text = git_output(
        &git,
        &path,
        &["stash", "list", "--format=%gd%09%ct%09%gs"],
    )
    .await?;

    let now = now_unix();
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let mut f = line.splitn(3, REF_SEP);
            let selector = f.next()?.trim().to_string();
            let unix: i64 = f.next()?.trim().parse().unwrap_or(0);
            let message = f.next().unwrap_or("").trim().to_string();
            Some(StashEntry {
                selector,
                message,
                unix,
                relative: relative_time(unix, now),
            })
        })
        .collect())
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

/// The host part of a remote URL, lowercased. `parse_remote_slug` throws it away.
///
/// SSH aliases are normalised — `git@github.com-work:acme/ui` is a `~/.ssh/config`
/// Host, not a domain, and the suffix after the first dot-segment match is what the
/// alias adds. Anything unrecognisable stays as-is and simply fails to match a
/// known forge below, which is the safe direction.
pub fn parse_remote_host(url: &str) -> Option<String> {
    let u = url.trim();
    let host = if let Some(after) = u.split("://").nth(1) {
        // scheme://[user@]host/...
        after.split('/').next()?
    } else {
        // [user@]host:owner/repo
        u.split(':').next()?
    };
    let host = host.rsplit('@').next()?.trim();
    if host.is_empty() {
        return None;
    }
    let host = host.to_ascii_lowercase();

    // github.com-work / gitlab.com-personal: an ssh alias built by suffixing a real
    // domain, which is common enough that failing on it means no links for anyone
    // who juggles two accounts.
    for known in ["github.com", "gitlab.com", "bitbucket.org"] {
        if host == known || host.starts_with(&format!("{known}-")) {
            return Some(known.to_string());
        }
    }
    Some(host)
}

/// The web address of a repo, for linking a commit or a branch.
///
/// Only the forges the opener capability allows — see
/// `capabilities/default.json`. An unknown or self-hosted host returns None, and
/// the UI renders plain text rather than a link that would be silently refused.
pub fn web_base(host: &str, slug: &str) -> Option<String> {
    matches!(host, "github.com" | "gitlab.com" | "bitbucket.org")
        .then(|| format!("https://{host}/{slug}"))
}

/// `base` plus the path each forge uses for one commit.
pub fn commit_url(base: &str, sha: &str) -> String {
    // GitLab nests everything under `/-/` so a group can be named `commit`;
    // Bitbucket pluralises. Getting either wrong yields a 404, not an error.
    if base.contains("://gitlab.com/") {
        format!("{base}/-/commit/{sha}")
    } else if base.contains("://bitbucket.org/") {
        format!("{base}/commits/{sha}")
    } else {
        format!("{base}/commit/{sha}")
    }
}

/// `base` plus the path each forge uses for one branch.
pub fn branch_url(base: &str, branch: &str) -> String {
    let b = urlencode_path(branch);
    if base.contains("://gitlab.com/") {
        format!("{base}/-/tree/{b}")
    } else if base.contains("://bitbucket.org/") {
        format!("{base}/src/{b}")
    } else {
        format!("{base}/tree/{b}")
    }
}

/// Percent-encodes a branch name for a URL path.
///
/// Slashes stay: `feat/x` is a path segment pair on every forge. `#` and `?` are
/// the ones that must not, since a branch may legally contain neither in git but
/// the encoder is cheap insurance against the ones it can.
fn urlencode_path(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            ' ' => "%20".to_string(),
            c => c.to_string(),
        })
        .collect()
}

/// The repo's web address, if it has one this app can open.
pub async fn remote_web_base(git: &Path, repo: &Path) -> Option<String> {
    let out = git_output(git, repo, &["remote", "get-url", "origin"]).await.ok()?;
    let line = out.lines().next()?;
    let host = parse_remote_host(line)?;
    let slug = parse_remote_slug(line)?;
    web_base(&host, &slug)
}

/// `git_output` for callers outside this module.
///
/// Deliberately narrow rather than making `git_output` public: everything reachable
/// through this still goes through `git_cmd`/`harden` and the shared timeout, so a
/// new read-only query cannot accidentally skip either.
pub async fn git_output_public(
    git: &Path,
    repo: &Path,
    args: &[&str],
) -> Result<String, String> {
    git_output(git, repo, args).await
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
                    added: 0,
                    deleted: 0,
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
                    added: 0,
                    deleted: 0,
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
                    added: 0,
                    deleted: 0,
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
                    added: 0,
                    deleted: 0,
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
    let mut files = parse_changed_files(&text);

    // Line counts come from two separate diffs, because they answer different
    // questions: `--cached` is what is staged, the bare one is what is not. A file
    // edited, staged, then edited again has both, so they are summed rather than one
    // overriding the other.
    //
    // Best-effort on purpose: a repo mid-rebase or with no HEAD yet makes these fail,
    // and a missing count is worth far less than the file list it would take down.
    let (unstaged, staged) = tokio::join!(
        git_output(git, repo, &["diff", "--numstat"]),
        git_output(git, repo, &["diff", "--cached", "--numstat"]),
    );
    let mut counts: std::collections::HashMap<String, (u32, u32)> = std::collections::HashMap::new();
    for text in [unstaged, staged].into_iter().flatten() {
        for (path, added, deleted) in parse_numstat(&text) {
            let e = counts.entry(path).or_insert((0, 0));
            e.0 += added;
            e.1 += deleted;
        }
    }
    for f in &mut files {
        if let Some(&(added, deleted)) = counts.get(&f.path) {
            f.added = added;
            f.deleted = deleted;
        }
    }

    Ok(files)
}

/// Whether git knows who the user is, in this repo.
///
/// Checked before a commit rather than left to git, whose own failure for this is a
/// twelve-line lecture about `--global` that buries the one thing to do about it.
/// `--get` sees the local value or the global one, which is exactly the question.
pub async fn has_identity(git: &Path, repo: &Path) -> bool {
    let name = git_output(git, repo, &["config", "--get", "user.name"]).await;
    let email = git_output(git, repo, &["config", "--get", "user.email"]).await;
    matches!((name, email), (Ok(n), Ok(e)) if !n.trim().is_empty() && !e.trim().is_empty())
}

/// The branch a commit would land on, for the confirmation dialog.
///
/// `--abbrev-ref HEAD` rather than the scan's branch field: this runs at
/// confirmation time, and the scan may be minutes old. Returns None on an unborn
/// HEAD — a repo with no commits yet — which is a state a first commit is allowed
/// to be in.
pub async fn current_branch(git: &Path, repo: &Path) -> Option<String> {
    let out = git_output(git, repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()?;
    let name = out.trim();
    (!name.is_empty() && name != "HEAD").then(|| name.to_string())
}

/// `12\t3\tsrc/main.rs` per line. A binary file reports `-`, which is not a count.
pub fn parse_numstat(text: &str) -> Vec<(String, u32, u32)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut f = line.splitn(3, '\t');
        let added = f.next().unwrap_or("").trim();
        let deleted = f.next().unwrap_or("").trim();
        let path = f.next().unwrap_or("").trim();
        if path.is_empty() {
            continue;
        }
        // A rename reads `old => new` or `dir/{a => b}/file`; the porcelain status
        // reports the new path, so anything unmatched simply gets no counts.
        out.push((
            path.to_string(),
            added.parse().unwrap_or(0),
            deleted.parse().unwrap_or(0),
        ));
    }
    out
}

/// The requested groups, or every discovered one.
pub fn categories_or_all(opt: Option<Vec<Category>>, root: &Path) -> Vec<Category> {
    opt.filter(|v| !v.is_empty()).unwrap_or_else(|| {
        crate::paths::discover_groups(root)
            .into_iter()
            .map(|(g, _)| g)
            .collect()
    })
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
    fn validates_branch_names() {
        for good in ["main", "develop", "v26", "release/2026.1", "fix/lewis.nguyen/sync", "a_b-c.d"] {
            assert!(valid_branch_name(good), "{good} should be valid");
        }
        for bad in [
            "",
            "   ",
            "-start-with-dash",
            "/leading",
            "trailing/",
            "trailing.",
            "some.lock",
            "a..b",
            "a//b",
            "HEAD@{0}",
            "@",
            "has space",
            "tilde~1",
            "caret^",
            "colon:x",
            "question?",
            "star*",
            "bracket[",
            // Quotes and backslashes would also be a problem in a generated command.
            "quote'x",
            "dquote\"x",
        ] {
            assert!(!valid_branch_name(bad), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn parses_origin_head_into_a_branch_name() {
        assert_eq!(parse_origin_head("origin/main").as_deref(), Some("main"));
        assert_eq!(parse_origin_head("  origin/develop\n").as_deref(), Some("develop"));
        // A branch with slashes in it is still one branch.
        assert_eq!(
            parse_origin_head("origin/release/2026.1").as_deref(),
            Some("release/2026.1")
        );
        // Not on this remote, or not a branch: must not be passed through.
        assert_eq!(parse_origin_head("main"), None);
        assert_eq!(parse_origin_head("upstream/main"), None);
        assert_eq!(parse_origin_head("origin/HEAD"), None);
        assert_eq!(parse_origin_head(""), None);
        assert_eq!(parse_origin_head("   "), None);
    }
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
    fn reads_the_host_an_ssh_alias_stands_for() {
        // The alias is a ~/.ssh/config Host, not a domain. Failing to normalise it
        // means no links at all for anyone juggling two accounts — which is exactly
        // who has aliases.
        assert_eq!(
            parse_remote_host("git@github.com-work:acme/ui.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            parse_remote_host("https://gitlab.com/acme/ui.git").as_deref(),
            Some("gitlab.com")
        );
        assert_eq!(
            parse_remote_host("ssh://git@bitbucket.org/acme/ui").as_deref(),
            Some("bitbucket.org")
        );
        // Case is not information in a hostname.
        assert_eq!(
            parse_remote_host("git@GitHub.com:acme/ui").as_deref(),
            Some("github.com")
        );
        // A self-hosted forge comes back as itself and simply matches nothing.
        assert_eq!(
            parse_remote_host("git@git.internal.example:acme/ui").as_deref(),
            Some("git.internal.example")
        );
    }

    #[test]
    fn only_hosts_the_app_may_open_get_a_base() {
        assert_eq!(
            web_base("github.com", "acme/ui").as_deref(),
            Some("https://github.com/acme/ui")
        );
        // Not in the opener capability, so a link would be silently refused — the
        // UI needs None here to know to render plain text instead.
        assert_eq!(web_base("git.internal.example", "acme/ui"), None);
        assert_eq!(web_base("gitea.example.com", "acme/ui"), None);
    }

    #[test]
    fn each_forge_spells_its_paths_differently() {
        let gh = "https://github.com/acme/ui";
        let gl = "https://gitlab.com/acme/ui";
        let bb = "https://bitbucket.org/acme/ui";

        assert_eq!(commit_url(gh, "abc123"), "https://github.com/acme/ui/commit/abc123");
        // GitLab nests project routes under /-/ so a group can be named `commit`.
        assert_eq!(commit_url(gl, "abc123"), "https://gitlab.com/acme/ui/-/commit/abc123");
        assert_eq!(commit_url(bb, "abc123"), "https://bitbucket.org/acme/ui/commits/abc123");

        assert_eq!(branch_url(gh, "main"), "https://github.com/acme/ui/tree/main");
        assert_eq!(branch_url(gl, "main"), "https://gitlab.com/acme/ui/-/tree/main");
        assert_eq!(branch_url(bb, "main"), "https://bitbucket.org/acme/ui/src/main");

        // A slash is a path separator on every forge and must survive; a `#` would
        // end the path.
        assert_eq!(
            branch_url(gh, "feat/new-thing"),
            "https://github.com/acme/ui/tree/feat/new-thing"
        );
        assert_eq!(branch_url(gh, "fix/#12"), "https://github.com/acme/ui/tree/fix/%2312");
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

#[cfg(test)]
mod branch_tests {
    use super::*;

    #[test]
    fn parses_local_and_remote_branches() {
        // Tab-separated, exactly as the for-each-ref format emits it.
        let text = "main\torigin/main\t[ahead 2, behind 1]\t1730000000\tabc1234\tfeat: add thing\n\
                    origin/feature/x\t\t\t1729000000\tdef5678\tfix: a bug\n\
                    origin/HEAD\t\t\t1730000000\tabc1234\tfeat: add thing\n";
        let out = parse_branch_lines(text);

        assert_eq!(out.len(), 2, "origin/HEAD is a symbolic ref, not a branch");

        assert_eq!(out[0].name, "main");
        assert!(out[0].local);
        assert_eq!(out[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!((out[0].ahead, out[0].behind), (2, 1));
        assert_eq!(out[0].last_commit_unix, Some(1730000000));
        assert_eq!(out[0].subject.as_deref(), Some("feat: add thing"));

        // origin/ is stripped, so the name is what you would check out.
        assert_eq!(out[1].name, "feature/x");
        assert!(!out[1].local, "exists only on the remote");
        assert_eq!(out[1].upstream, None);
    }

    #[test]
    fn local_wins_over_remote_regardless_of_order() {
        // The remote copy is listed first, which is what happens when it is ahead:
        // for-each-ref sorts by committerdate, not by ref namespace.
        let text = "origin/main\t\t\t1730000100\taaa\tremote tip\n\
                    main\torigin/main\t[behind 1]\t1730000000\tbbb\tlocal tip\n";
        let out = parse_branch_lines(text);
        assert_eq!(out.len(), 1);
        assert!(out[0].local, "the local branch must win the merge");
        assert_eq!(out[0].behind, 1);
    }

    #[test]
    fn a_gone_upstream_yields_no_counts() {
        let out = parse_branch_lines("old\torigin/old\t[gone]\t1720000000\tccc\tsubject\n");
        assert_eq!((out[0].ahead, out[0].behind), (0, 0));
    }

    #[test]
    fn subject_containing_a_tab_does_not_eat_fields() {
        // splitn(6) is what bounds this: the subject keeps its tab.
        let out = parse_branch_lines("b\t\t\t1730000000\tsha\tfeat: a\tb\n");
        assert_eq!(out[0].last_commit_unix, Some(1730000000));
        assert_eq!(out[0].subject.as_deref(), Some("feat: a\tb"));
    }

    #[test]
    fn numstat_sums_and_ignores_binaries() {
        let text = "12\t3\tsrc/main.rs\n-\t-\tlogo.png\n0\t0\tempty.txt\n";
        let rows = parse_numstat(text);
        assert_eq!(rows[0], ("src/main.rs".to_string(), 12, 3));
        // A binary file reports "-", which parses to no count rather than a panic.
        assert_eq!(rows[1], ("logo.png".to_string(), 0, 0));
        assert_eq!(rows.len(), 3);
    }
}
