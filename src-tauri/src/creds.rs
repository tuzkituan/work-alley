//! Whether this machine can authenticate a `git clone`.
//!
//! Cloning is the first thing a new user does and the first thing that fails: git asks
//! for a password it cannot prompt for from a GUI app, so with neither an ssh key nor a
//! signed-in `gh` the clone hangs or dies with `Permission denied (publickey)` and no
//! explanation. All the app used to offer was a warning saying "start an ssh-agent and
//! relaunch", which is not something a new user can act on.
//!
//! Detection only. Nothing here runs `ssh-keygen` or `gh auth login` — the setup page
//! shows the commands and the user runs them, which keeps a passphrase prompt and a
//! browser handoff out of this codebase.

use crate::toolchain::Toolchain;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

/// Every probe here is local. Nothing should ever take this long.
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    /// Keys are loaded and ready to authenticate.
    Loaded,
    /// An agent is running but holds nothing.
    Empty,
    /// No agent to talk to.
    Absent,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredsStatus {
    /// An agent is reachable, whether or not it holds keys.
    pub ssh_agent: bool,
    /// Fingerprints the agent is holding.
    pub ssh_keys: Vec<String>,
    /// `~/.ssh/*.pub` on disk. A key here with no agent is the "so close" state, and
    /// worth reporting separately so the advice can be `ssh-add` rather than keygen.
    pub ssh_key_files: Vec<String>,
    pub gh_present: bool,
    /// The signed-in login. `Some` is the whole test — gh does not store a token for
    /// an account that is not authenticated.
    pub gh_account: Option<String>,
}

impl CredsStatus {
    /// Either route working is enough; they are alternatives, not a checklist.
    pub fn satisfied(&self) -> bool {
        self.gh_account.is_some() || (!self.ssh_keys.is_empty() && self.ssh_agent)
    }
}

pub async fn status(tc: &Toolchain) -> CredsStatus {
    let agent = ssh_agent_state(tc).await;
    let (ssh_agent, ssh_keys) = match agent {
        (AgentState::Loaded, keys) => (true, keys),
        (AgentState::Empty, _) => (true, Vec::new()),
        (AgentState::Absent, _) => (false, Vec::new()),
    };

    CredsStatus {
        ssh_agent,
        ssh_keys,
        ssh_key_files: public_key_files(),
        gh_present: tc.has("gh"),
        gh_account: gh_account(),
    }
}

/// `ssh-add -l`'s three exit codes, which are the entire contract.
///
/// Its own function because inverting 1 and 2 is the classic bug here, and the
/// difference decides whether the advice is "add your key" or "start an agent".
pub fn ssh_add_verdict(code: Option<i32>) -> AgentState {
    match code {
        Some(0) => AgentState::Loaded,
        Some(1) => AgentState::Empty,
        // 2 is "could not open a connection to your authentication agent". Anything
        // else — killed, missing binary — cannot be claimed as a working agent either.
        _ => AgentState::Absent,
    }
}

async fn ssh_agent_state(tc: &Toolchain) -> (AgentState, Vec<String>) {
    // `SSH_AUTH_SOCK` unset is conclusive: there is nothing to ask. Skipping the
    // subprocess also keeps this off the critical path on a machine without one.
    if std::env::var_os("SSH_AUTH_SOCK").is_none() {
        return (AgentState::Absent, Vec::new());
    }
    let Some(bin) = resolve(tc, "ssh-add") else {
        return (AgentState::Absent, Vec::new());
    };

    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("-l")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::git::harden(&mut cmd);
    tc.apply_path(&mut cmd);

    let out = match tokio::time::timeout(TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        _ => return (AgentState::Absent, Vec::new()),
    };

    let verdict = ssh_add_verdict(out.status.code());
    let keys = parse_ssh_add(&String::from_utf8_lossy(&out.stdout));
    (verdict, keys)
}

/// `2048 SHA256:abc… ada@host (RSA)` per line → the fingerprint column.
///
/// The column must actually look like a fingerprint. `ssh-add` prints "The agent has
/// no identities." on stdout, whose second word is "agent" — taking column two
/// unconditionally reported that as a loaded key, i.e. exactly backwards.
pub fn parse_ssh_add(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.split_whitespace().nth(1))
        // Every hash form carries a colon: `SHA256:…`, and `MD5:aa:bb:…` under `-E md5`.
        .filter(|c| c.contains(':'))
        .map(str::to_string)
        .collect()
}

/// `~/.ssh/*.pub`, by name only. Never reads a private key.
fn public_key_files() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let dir = PathBuf::from(home).join(".ssh");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".pub"))
        .collect();
    // Stable order, so the UI does not reshuffle between probes.
    out.sort();
    out
}

/// The signed-in gh login, from gh's own config.
///
/// Read from disk rather than by running `gh auth status`, which makes a network round
/// trip — that would put a multi-second hang into readiness, which is computed on every
/// bootstrap.
fn gh_account() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join(".config/gh/hosts.yml");
    let text = std::fs::read_to_string(path).ok()?;
    parse_gh_hosts(&text)
}

/// Pulls the first login out of gh's `hosts.yml`.
///
/// Hand-parsed rather than with a YAML crate: the shape is two levels of fixed keys and
/// a dependency for one file would be the wrong trade. Indentation decides the level —
/// a `user:` under a host is the login; the `users:` map that follows lists the same
/// name again, and either is a fine answer.
///
/// A keyring-backed install has no `oauth_token` at all and is still signed in, so the
/// presence of a token is deliberately not the test.
///
/// Known limit: returns the *first* host's login, so a multi-account or GHES-only setup
/// may read as a different account than the one a given repo needs.
pub fn parse_gh_hosts(yaml: &str) -> Option<String> {
    for line in yaml.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Indented `user: name` — the account for the host above it.
        if line.starts_with(char::is_whitespace) {
            if let Some(rest) = trimmed.strip_prefix("user:") {
                let name = rest.trim().trim_matches(['"', '\''].as_ref());
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
        }
    }
    None
}

/// Finds a binary the startup probe does not resolve.
///
/// `ssh-add` is not in `toolchain::TOOLS` on purpose: that list is probed with
/// `--version` at startup, and `ssh-add --version` exits non-zero, which would add a
/// spurious warning to every launch.
fn resolve(tc: &Toolchain, bin: &str) -> Option<PathBuf> {
    crate::packages::which_in(&crate::packages::search_dirs(tc), bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_ssh_add_exit_codes() {
        // Inverting 1 and 2 is the classic bug: it decides whether we tell someone to
        // add their key or to start an agent.
        assert_eq!(ssh_add_verdict(Some(0)), AgentState::Loaded);
        assert_eq!(ssh_add_verdict(Some(1)), AgentState::Empty);
        assert_eq!(ssh_add_verdict(Some(2)), AgentState::Absent);
        // Killed by a signal, or a binary that is not ssh-add at all.
        assert_eq!(ssh_add_verdict(None), AgentState::Absent);
    }

    #[test]
    fn reads_fingerprints_from_ssh_add() {
        let out = "256 SHA256:AbC ada@host (ED25519)\n2048 SHA256:XyZ old@host (RSA)\n";
        assert_eq!(parse_ssh_add(out), vec!["SHA256:AbC", "SHA256:XyZ"]);
        // The "agent has no identities" line has no fingerprint column.
        assert!(parse_ssh_add("The agent has no identities.\n").is_empty());
    }

    #[test]
    fn finds_the_login_in_a_real_hosts_file() {
        let yaml = "\
github.com:
    user: ada
    oauth_token: gho_xxx
    git_protocol: ssh
";
        assert_eq!(parse_gh_hosts(yaml).as_deref(), Some("ada"));
    }

    #[test]
    fn a_keyring_backed_install_still_counts_as_signed_in() {
        // No oauth_token anywhere — the token lives in the OS keyring. Testing for a
        // token would report this perfectly authenticated machine as signed out.
        let yaml = "\
github.com:
    users:
        ada:
    user: ada
    git_protocol: https
";
        assert_eq!(parse_gh_hosts(yaml).as_deref(), Some("ada"));
    }

    #[test]
    fn an_empty_or_hostless_file_is_not_signed_in() {
        assert_eq!(parse_gh_hosts(""), None);
        assert_eq!(parse_gh_hosts("# nothing here\n"), None);
        // A host with no user is not an account.
        assert_eq!(parse_gh_hosts("github.com:\n    git_protocol: ssh\n"), None);
    }

    #[test]
    fn a_top_level_user_key_is_not_a_login() {
        // Indentation is what distinguishes a host's user from a stray top-level key,
        // and mistaking one would invent an account.
        assert_eq!(parse_gh_hosts("user: notahost\n"), None);
    }

    #[test]
    fn either_route_satisfies_and_neither_alone_is_enough() {
        let gh = CredsStatus {
            gh_account: Some("ada".into()),
            ..Default::default()
        };
        assert!(gh.satisfied());

        let ssh = CredsStatus {
            ssh_agent: true,
            ssh_keys: vec!["SHA256:AbC".into()],
            ..Default::default()
        };
        assert!(ssh.satisfied());

        // A key on disk with no agent holding it cannot authenticate — this is the
        // state the old "start an ssh-agent" warning was about.
        let stranded = CredsStatus {
            ssh_key_files: vec!["id_ed25519.pub".into()],
            ..Default::default()
        };
        assert!(!stranded.satisfied());
        assert!(!CredsStatus::default().satisfied());
    }
}
