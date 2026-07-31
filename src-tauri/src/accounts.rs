//! Several git identities on one machine.
//!
//! The problem is mundane and constant: a work laptop with a personal repo on it
//! commits as the wrong person, pushes with the wrong key, and opens the pull
//! request from the wrong GitHub login — and the only cure is remembering three
//! `git config` incantations, an `ssh -i` flag and `gh auth switch` at the moment
//! you are thinking about something else.
//!
//! An account here is the whole set: who commits, which key signs and pushes, and
//! which `gh` login the Actions and PR tabs speak as. Switching writes them
//! together, because they are only ever wrong together.
//!
//! Two scopes, and the distinction matters more than it looks:
//!
//! - **Global** rewrites `~/.gitconfig` and switches `gh`. It is the machine's
//!   default identity, and it is the only scope that can touch `gh` — gh has one
//!   active account per machine, not one per repo.
//! - **Repo** writes `.git/config` in one repo, which overrides the global for that
//!   repo alone. This is the one you want on a work laptop: leave the default as
//!   work, and mark the three personal repos.
//!
//! Nothing here stores a secret. An account holds a *path* to a key and the *name*
//! of a gh login; the key itself stays in `~/.ssh` and the token stays in gh's
//! keyring, which is the only reason this can live in a plain JSON config file.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One identity, as stored in `config.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAccount {
    /// Stable across renames — the label is what the user edits.
    pub id: String,
    /// "Work", "Personal". What the tiles and menus show.
    pub label: String,
    pub name: String,
    pub email: String,
    /// Path to a private key. Written as `core.sshCommand`, which is per-repo
    /// capable and does not require an agent — unlike `~/.ssh/config`, which is
    /// keyed by host and so cannot tell two accounts on github.com apart.
    #[serde(default)]
    pub ssh_key: Option<String>,
    /// `user.signingkey`. Deliberately does not turn `commit.gpgsign` on: signing
    /// every commit is a decision with consequences at push time, and silently
    /// making it for someone is not this feature's business.
    #[serde(default)]
    pub signing_key: Option<String>,
    /// A `gh` login to make active. Only applied in the global scope.
    #[serde(default)]
    pub gh_user: Option<String>,
    /// An ssh host alias — `github.com-work` — for this account's key.
    ///
    /// The other half of `ssh_key`, and the one that makes *per-remote* identity
    /// possible: `core.sshCommand` picks a key per repo, but a URL written as
    /// `git@github.com-work:owner/repo.git` picks one per remote, which is what
    /// survives someone cloning the repo again or a submodule pulling its own.
    /// Written into `~/.ssh/config`; see `ssh_config_block`.
    #[serde(default)]
    pub ssh_host: Option<String>,
    /// The real host the alias points at. Defaults to github.com.
    #[serde(default)]
    pub ssh_hostname: Option<String>,
}

/// Where an account is being applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// `~/.gitconfig`, plus `gh auth switch`.
    Global,
    /// One repo's `.git/config`.
    Repo(PathBuf),
}

/// A gh login this machine is signed in as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAccount {
    pub login: String,
    pub host: String,
    pub active: bool,
}

/// Everything the accounts page renders.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsView {
    pub accounts: Vec<GitAccount>,
    /// The identity `~/.gitconfig` currently holds. Either half can be missing on a
    /// machine that has never been set up.
    pub global_name: Option<String>,
    pub global_email: Option<String>,
    /// Which account the global config matches, if any. Matched on email, because
    /// that is the field git actually attributes commits by — two accounts sharing
    /// a display name is normal, sharing an email is not.
    pub active_id: Option<String>,
    /// Logins `gh` is signed in as. Empty when gh is missing or logged out, which
    /// the page reports rather than treating as an error.
    pub gh_accounts: Vec<GhAccount>,
    pub gh_present: bool,
}

// --- validation --------------------------------------------------------------

/// A gh login: GitHub's own rule, so a typo is caught here rather than by gh.
fn valid_login(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 39
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

/// Checks and normalises everything a caller can send.
///
/// Nothing here is composed into a shell string by hand — `Shell::cmd` quotes every
/// argument — so this is not the injection boundary. It is the *usefulness*
/// boundary: an email with a newline in it, or an ssh path that is a flag, produces
/// a git config that fails later and somewhere else.
pub fn clean(account: &GitAccount) -> Result<GitAccount, String> {
    let label = crate::setup::clean_identity("label", &account.label)?;
    let name = crate::setup::clean_identity("name", &account.name)?;
    let email = crate::setup::clean_identity("email", &account.email)?;

    let ssh_key = match opt(&account.ssh_key) {
        Some(p) => {
            let p = crate::setup::clean_identity("ssh key", &p)?;
            // A relative path resolves against whatever the run's cwd happens to
            // be, which for a global write is a neutral directory — never what the
            // user meant. A leading dash would be read as an option by ssh.
            if p.starts_with('-') {
                return Err("an ssh key path cannot start with '-'".into());
            }
            Some(p)
        }
        None => None,
    };

    let signing_key = match opt(&account.signing_key) {
        Some(k) => Some(crate::setup::clean_identity("signing key", &k)?),
        None => None,
    };

    // Host aliases and hostnames end up on an `ssh` command line and in a config
    // file whose grammar is whitespace-separated, so the character set is narrow on
    // purpose: a space here would silently split one directive into two.
    let ssh_host = match opt(&account.ssh_host) {
        Some(h) if valid_host(&h) => Some(h),
        Some(h) => return Err(format!("'{h}' is not a valid ssh host alias")),
        None => None,
    };
    let ssh_hostname = match opt(&account.ssh_hostname) {
        Some(h) if valid_host(&h) => Some(h),
        Some(h) => return Err(format!("'{h}' is not a valid hostname")),
        None => None,
    };

    let gh_user = match opt(&account.gh_user) {
        Some(u) if valid_login(&u) => Some(u),
        Some(u) => return Err(format!("'{u}' is not a GitHub username")),
        None => None,
    };

    Ok(GitAccount {
        id: if account.id.trim().is_empty() {
            slug(&label)
        } else {
            account.id.trim().to_string()
        },
        label,
        name,
        email,
        ssh_key,
        signing_key,
        gh_user,
        ssh_host,
        ssh_hostname,
    })
}

/// A host or alias: letters, digits, dot, dash, underscore. No wildcards — an ssh
/// `Host` pattern can contain `*`, and one in a generated block would capture every
/// connection the machine makes.
fn valid_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// Trims, and treats an empty string as absent — a cleared form field arrives as
/// `Some("")`, and storing that would write an empty `user.signingkey`.
fn opt(v: &Option<String>) -> Option<String> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// A url-ish id from a label. Only ever used when the caller sends none.
pub fn slug(label: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in label.chars().flat_map(|c| c.to_lowercase()) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    let s = out.trim_end_matches('-').to_string();
    if s.is_empty() { "account".into() } else { s }
}

/// `slug`, made unique against ids already in use.
pub fn unique_id(label: &str, taken: &[String]) -> String {
    let base = slug(label);
    if !taken.iter().any(|t| t == &base) {
        return base;
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !taken.iter().any(|t| t == &candidate) {
            return candidate;
        }
    }
    // A thousand accounts called "Work" is not a case worth handling gracefully.
    format!("{base}-{}", crate::git::now_unix())
}

// --- applying ------------------------------------------------------------------

/// The `ssh` invocation written to `core.sshCommand`.
///
/// `IdentitiesOnly=yes` is the load-bearing half: without it ssh offers every key
/// the agent holds *before* the one named here, and github.com authenticates as
/// whichever it recognises first — so the wrong account pushes, silently, while the
/// config claims otherwise.
fn ssh_command(key: &str) -> String {
    format!("ssh -i {key} -o IdentitiesOnly=yes")
}

/// Every `git config` pair this account writes, in order.
///
/// Separate from the argv builder so the UI can be shown exactly what will change
/// without a shell being involved.
pub fn config_pairs(account: &GitAccount) -> Vec<(String, String)> {
    let mut pairs = vec![
        ("user.name".to_string(), account.name.clone()),
        ("user.email".to_string(), account.email.clone()),
    ];
    if let Some(key) = &account.ssh_key {
        pairs.push(("core.sshCommand".into(), ssh_command(key)));
    }
    if let Some(key) = &account.signing_key {
        pairs.push(("user.signingkey".into(), key.clone()));
    }
    pairs
}

/// The one command that switches everything.
///
/// One run rather than five, for the reason `git_identity_argv` gives: a switch
/// that half-happened — the email moved but the ssh key did not — is worse than one
/// that failed, because it looks like it worked.
///
/// `gh auth switch` comes last and only globally. gh holds one active account per
/// machine, so applying an account to a single repo must not move it; and it goes
/// last so a machine with no gh, or a login that has since been removed, still gets
/// its git identity written before the chain stops.
pub fn apply_argv(
    sh: &crate::platform::Shell,
    git: &Path,
    gh: Option<&Path>,
    account: &GitAccount,
    scope: &Scope,
) -> Vec<String> {
    let g = git.display().to_string();
    let mut parts: Vec<String> = Vec::new();

    for (key, value) in config_pairs(account) {
        let mut argv = vec![g.clone()];
        if let Scope::Repo(path) = scope {
            argv.push("-C".into());
            argv.push(path.display().to_string());
        }
        argv.push("config".into());
        if matches!(scope, Scope::Global) {
            argv.push("--global".into());
        }
        argv.push(key);
        argv.push(value);
        parts.push(sh.cmd(&argv));
    }

    if let (Scope::Global, Some(gh), Some(user)) = (scope, gh, account.gh_user.as_deref()) {
        parts.push(sh.cmd(&[
            gh.display().to_string(),
            "auth".into(),
            "switch".into(),
            "--user".into(),
            user.into(),
        ]));
    }

    let script = parts
        .into_iter()
        .reduce(|acc, next| sh.both(&acc, &next))
        .unwrap_or_default();
    sh.login_script_argv(&script)
}

// --- ~/.ssh/config ---------------------------------------------------------------

/// Opens the managed region. Everything between this and `END` is ours to rewrite;
/// everything outside it is the user's and is copied through untouched.
pub const SSH_BEGIN: &str = "# >>> work-alley: managed accounts (do not edit inside this block)";
pub const SSH_END: &str = "# <<< work-alley";

/// The `Host` blocks for every account that has both an alias and a key.
///
/// An account with a key but no alias is not an error and not included: the key
/// still reaches git through `core.sshCommand`, which is the per-repo route. The
/// alias is the per-*remote* route, and only worth writing when asked for.
///
/// `IdentitiesOnly yes` is the load-bearing line, for the same reason it is in
/// `core.sshCommand`: without it ssh offers every key the agent holds before the one
/// named here, and GitHub authenticates as whichever it recognises first — so a
/// personal remote pushes as the work account, silently.
pub fn ssh_config_block(accounts: &[GitAccount]) -> String {
    let mut out = String::new();
    for a in accounts {
        let (Some(host), Some(key)) = (&a.ssh_host, &a.ssh_key) else {
            continue;
        };
        let hostname = a.ssh_hostname.as_deref().unwrap_or("github.com");
        out.push_str(&format!(
            "\n# {label}\nHost {host}\n    HostName {hostname}\n    User git\n    IdentityFile {key}\n    IdentitiesOnly yes\n",
            label = a.label,
        ));
    }
    out
}

/// One `Host` block already in the file.
///
/// The point of reading a file this app also writes is that most people already
/// have the aliases — hand-written, months ago, and forgotten. Parsing them means
/// the accounts page can adopt what is there instead of asking for it twice and
/// then generating a second block that says the same thing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostEntry {
    /// The first pattern after `Host`. A block can name several; the rest are kept
    /// in `aliases` so nothing is silently dropped from the display.
    pub host: String,
    pub aliases: Vec<String>,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub identities_only: bool,
    /// The `# comment` immediately above the block — which is where people put the
    /// human name, and so the best guess at a label.
    pub comment: Option<String>,
    /// Inside the app's own markers. Those are shown as already managed rather than
    /// offered for import.
    pub managed: bool,
}

/// Reads every `Host` block in an ssh config.
///
/// Deliberately shallow: `Include`d files are not followed and `Match` blocks are
/// ignored. This is here to *recognise* the handful of GitHub aliases a developer
/// has written by hand, not to reimplement ssh's config resolution — and guessing
/// wrong about an Include would mean offering to import an entry this file does not
/// actually own.
pub fn parse_ssh_config(text: &str) -> Vec<SshHostEntry> {
    let mut out: Vec<SshHostEntry> = Vec::new();
    let mut comment: Option<String> = None;
    let mut managed = false;

    for raw in text.lines() {
        let line = raw.trim();

        if line.starts_with(SSH_BEGIN) {
            managed = true;
            continue;
        }
        if line.starts_with(SSH_END) {
            managed = false;
            continue;
        }
        if let Some(rest) = line.strip_prefix('#') {
            // Remembered only until the next block or blank line: a comment three
            // paragraphs up is not this host's name.
            comment = Some(rest.trim().to_string()).filter(|c| !c.is_empty());
            continue;
        }
        if line.is_empty() {
            comment = None;
            continue;
        }

        let Some((key, value)) = split_directive(line) else {
            continue;
        };
        let lower = key.to_ascii_lowercase();

        if lower == "host" {
            let mut patterns = value.split_whitespace().map(str::to_string);
            let Some(host) = patterns.next() else { continue };
            out.push(SshHostEntry {
                host,
                aliases: patterns.collect(),
                hostname: None,
                user: None,
                identity_file: None,
                identities_only: false,
                comment: comment.take(),
                managed,
            });
            continue;
        }

        // A directive before any Host line is a global default, which belongs to no
        // entry — and attaching it to the first block would misreport that block.
        let Some(entry) = out.last_mut() else { continue };
        match lower.as_str() {
            "hostname" => entry.hostname = Some(value.to_string()),
            "user" => entry.user = Some(value.to_string()),
            "identityfile" => entry.identity_file = Some(value.to_string()),
            "identitiesonly" => entry.identities_only = value.eq_ignore_ascii_case("yes"),
            _ => {}
        }
    }

    out
}

/// `Key value` or `Key = value`, ssh's two accepted spellings.
fn split_directive(line: &str) -> Option<(&str, &str)> {
    let (key, rest) = line.split_once(|c: char| c.is_whitespace() || c == '=')?;
    let value = rest.trim_start_matches(['=', ' ', '\t']).trim();
    (!key.is_empty() && !value.is_empty()).then_some((key, value))
}

/// The account an existing `Host` block implies.
///
/// Everything git needs that ssh does not know — the name and the email — is left
/// blank for the user to fill in. The label is the block's own comment, then the
/// part of the alias after the host, then the alias: `# Work GitHub` beats
/// `github.com-work` beats nothing.
pub fn account_from_entry(entry: &SshHostEntry) -> GitAccount {
    let label = entry
        .comment
        .clone()
        .or_else(|| {
            let hostname = entry.hostname.as_deref()?;
            entry
                .host
                .strip_prefix(hostname)
                .map(|s| s.trim_start_matches(['-', '_', '.']).to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| entry.host.clone());

    GitAccount {
        id: String::new(),
        label,
        name: String::new(),
        email: String::new(),
        ssh_key: entry.identity_file.clone(),
        signing_key: None,
        gh_user: None,
        ssh_host: Some(entry.host.clone()),
        ssh_hostname: entry.hostname.clone(),
    }
}

/// Puts `block` into `existing`, inside the markers, leaving everything else alone.
///
/// Three cases, and the third is why this returns a Result. No markers: append,
/// after a blank line. Both markers: replace what is between them. A start marker
/// with no end — someone deleted a line, or an earlier write was interrupted — is
/// refused, because the only ways to proceed are to guess where the region ends or
/// to truncate the rest of the file, and both can silently destroy an ssh config
/// that is holding a machine's access to everything.
pub fn splice_ssh_config(existing: &str, block: &str) -> Result<String, String> {
    let region = format!("{SSH_BEGIN}\n{}{SSH_END}\n", block.trim_start_matches('\n'));

    let Some(start) = existing.find(SSH_BEGIN) else {
        if existing.trim().is_empty() {
            return Ok(region);
        }
        let sep = if existing.ends_with("\n\n") {
            ""
        } else if existing.ends_with('\n') {
            "\n"
        } else {
            "\n\n"
        };
        return Ok(format!("{existing}{sep}{region}"));
    };

    let after = &existing[start..];
    let Some(end_rel) = after.find(SSH_END) else {
        return Err(format!(
            "{SSH_BEGIN} has no matching {SSH_END} — refusing to guess where the managed block ends. Fix or remove it by hand."
        ));
    };
    // Past the end marker's own line, so the newline after it is not duplicated.
    let end = start + end_rel + SSH_END.len();
    let tail = existing[end..].strip_prefix('\n').unwrap_or(&existing[end..]);

    Ok(format!("{}{region}{tail}", &existing[..start]))
}

/// Removes the managed region entirely. Used when no account defines an alias any
/// more — leaving an empty marked block behind would be litter in a file the user
/// also edits by hand.
pub fn strip_ssh_config(existing: &str) -> Result<String, String> {
    if !existing.contains(SSH_BEGIN) {
        return Ok(existing.to_string());
    }
    let spliced = splice_ssh_config(existing, "")?;
    let region = format!("{SSH_BEGIN}\n{SSH_END}\n");
    Ok(spliced.replace(&region, "").trim_end().to_string() + "\n")
}

// --- reading -------------------------------------------------------------------

/// Which stored account the current global identity is.
pub fn match_account(accounts: &[GitAccount], email: Option<&str>) -> Option<String> {
    let email = email?.trim();
    accounts
        .iter()
        .find(|a| a.email.eq_ignore_ascii_case(email))
        .map(|a| a.id.clone())
}

/// Parses `gh auth status`.
///
/// Text, not JSON: `gh auth status` has no `--json`, and the one machine-readable
/// alternative (`gh api user`) reports only the *active* account, which is the one
/// thing already known. Two output shapes are handled because both are still in the
/// wild — gh ≥ 2.40 prints one indented block per account with an explicit "Active
/// account: true", while older builds print a single "Logged in to github.com as
/// <login>" line and have no notion of a second account.
///
/// Unparseable output yields an empty list, never an error: gh being in a shape this
/// does not know is a reason to stop offering the switcher, not a reason to fail the
/// page around it.
pub fn parse_gh_accounts(stdout: &str) -> Vec<GhAccount> {
    let mut out: Vec<GhAccount> = Vec::new();
    let mut host = String::from("github.com");

    for raw in stdout.lines() {
        let line = raw.trim();
        // A bare, unindented line naming a host heads each block.
        if !raw.starts_with(char::is_whitespace)
            && !line.is_empty()
            && line.contains('.')
            && !line.contains(' ')
        {
            host = line.trim_end_matches(':').to_string();
            continue;
        }

        if let Some(login) = logged_in_login(line) {
            out.push(GhAccount {
                login,
                host: host.clone(),
                // The modern format states this on a following line; the legacy
                // format has exactly one account, so it is active by definition.
                active: false,
            });
        } else if line.starts_with("- Active account: true") {
            if let Some(last) = out.last_mut() {
                last.active = true;
            }
        }
    }

    // Legacy output, or a gh that never printed the marker: one account is active.
    if out.len() == 1 && !out[0].active {
        out[0].active = true;
    }
    out
}

/// `✓ Logged in to github.com account ada (keyring)` → `ada`, and the older
/// `✓ Logged in to github.com as ada (oauth_token)` → `ada`.
fn logged_in_login(line: &str) -> Option<String> {
    let rest = line.split_once("Logged in to ")?.1;
    let mut words = rest.split_whitespace();
    let _host = words.next()?;
    let keyword = words.next()?;
    if keyword != "account" && keyword != "as" {
        return None;
    }
    let login = words.next()?.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
    (!login.is_empty()).then(|| login.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc() -> GitAccount {
        GitAccount {
            id: "work".into(),
            label: "Work".into(),
            name: "Ada Lovelace".into(),
            email: "ada@corp.com".into(),
            ssh_key: None,
            signing_key: None,
            gh_user: None,
            ssh_host: None,
            ssh_hostname: None,
        }
    }

    #[test]
    fn a_label_becomes_a_usable_id() {
        assert_eq!(slug("Work"), "work");
        assert_eq!(slug("Work — GitHub"), "work-github");
        assert_eq!(slug("  ??  "), "account");
        assert_eq!(slug("Ada's laptop"), "ada-s-laptop");
    }

    #[test]
    fn ids_do_not_collide() {
        let taken = vec!["work".to_string(), "work-2".to_string()];
        assert_eq!(unique_id("Work", &taken), "work-3");
        assert_eq!(unique_id("Personal", &taken), "personal");
    }

    #[test]
    fn an_account_is_checked_before_it_is_stored() {
        assert!(clean(&acc()).is_ok());

        let mut bad = acc();
        bad.email = "not-an-email".into();
        assert!(clean(&bad).is_err());

        let mut bad = acc();
        bad.gh_user = Some("not a login".into());
        assert!(clean(&bad).is_err());

        // The one path rule: ssh would read it as an option.
        let mut bad = acc();
        bad.ssh_key = Some("-oProxyCommand=x".into());
        assert!(clean(&bad).is_err());
    }

    #[test]
    fn a_cleared_field_is_absent_rather_than_empty() {
        // The form sends "" for a field the user emptied. Stored as-is, it would
        // write `user.signingkey ""` and git would then try to sign with nothing.
        let mut a = acc();
        a.signing_key = Some("   ".into());
        a.ssh_key = Some(String::new());
        let cleaned = clean(&a).unwrap();
        assert_eq!(cleaned.signing_key, None);
        assert_eq!(cleaned.ssh_key, None);
    }

    #[test]
    fn an_id_is_generated_only_when_one_is_not_supplied() {
        let mut a = acc();
        a.id = String::new();
        a.label = "My Work".into();
        assert_eq!(clean(&a).unwrap().id, "my-work");
        assert_eq!(clean(&acc()).unwrap().id, "work");
    }

    #[test]
    fn the_global_switch_writes_config_and_moves_gh() {
        let sh = crate::platform::test_shell(crate::platform::ShellKind::Posix);
        let mut a = acc();
        a.ssh_key = Some("/home/ada/.ssh/id_corp".into());
        a.gh_user = Some("ada".into());

        let argv = apply_argv(
            sh,
            Path::new("/usr/bin/git"),
            Some(Path::new("/usr/bin/gh")),
            &a,
            &Scope::Global,
        );
        let script = argv.last().unwrap();

        // Quoted only where the shell needs it — see `Shell::arg`.
        assert!(script.contains("config --global user.name 'Ada Lovelace'"), "{script}");
        assert!(script.contains("config --global user.email ada@corp.com"), "{script}");
        // IdentitiesOnly is what stops the agent's other keys being offered first.
        assert!(script.contains("IdentitiesOnly=yes"));
        assert!(script.contains("auth switch --user ada"), "{script}");
        // One run: every step chained onto the success of the last.
        assert_eq!(script.matches("&&").count(), 3);
    }

    #[test]
    fn a_repo_switch_never_touches_gh_or_the_global_config() {
        let sh = crate::platform::test_shell(crate::platform::ShellKind::Posix);
        let mut a = acc();
        a.gh_user = Some("ada".into());

        let argv = apply_argv(
            sh,
            Path::new("/usr/bin/git"),
            Some(Path::new("/usr/bin/gh")),
            &a,
            &Scope::Repo(PathBuf::from("/w/fe/web")),
        );
        let script = argv.last().unwrap();

        assert!(script.contains("-C /w/fe/web"), "{script}");
        assert!(!script.contains("--global"));
        // gh has one active account per machine, so a repo-scoped switch must not
        // move it — the whole point of the repo scope is that it is local.
        assert!(!script.contains("auth"));
    }

    #[test]
    fn a_machine_without_gh_still_writes_its_identity() {
        let sh = crate::platform::test_shell(crate::platform::ShellKind::Posix);
        let mut a = acc();
        a.gh_user = Some("ada".into());
        let argv = apply_argv(sh, Path::new("/usr/bin/git"), None, &a, &Scope::Global);
        let script = argv.last().unwrap();
        assert!(script.contains("user.email ada@corp.com"), "{script}");
        assert!(!script.contains("auth"));
    }

    #[test]
    fn the_active_account_is_matched_on_email() {
        let accounts = vec![acc()];
        assert_eq!(
            match_account(&accounts, Some("ADA@corp.com")).as_deref(),
            Some("work")
        );
        // A shared display name must not count as a match: `user.name` is a label,
        // `user.email` is what a commit is attributed by.
        assert_eq!(match_account(&accounts, Some("ada@personal.com")), None);
        assert_eq!(match_account(&accounts, None), None);
    }

    fn with_alias() -> GitAccount {
        let mut a = acc();
        a.ssh_key = Some("~/.ssh/id_ed25519_work".into());
        a.ssh_host = Some("github.com-work".into());
        a
    }

    #[test]
    fn the_ssh_block_names_the_key_and_pins_it() {
        let block = ssh_config_block(&[with_alias()]);
        assert!(block.contains("Host github.com-work"));
        assert!(block.contains("HostName github.com"));
        assert!(block.contains("User git"));
        assert!(block.contains("IdentityFile ~/.ssh/id_ed25519_work"));
        // Without this, the agent's other keys are offered first and the wrong
        // account authenticates.
        assert!(block.contains("IdentitiesOnly yes"));
        // The label, as a comment, so the file explains itself to whoever opens it.
        assert!(block.contains("# Work"));
    }

    #[test]
    fn an_account_with_no_alias_or_no_key_writes_nothing() {
        // A key with no alias is still useful — `core.sshCommand` uses it — so this
        // is a normal state, not an error.
        let mut key_only = acc();
        key_only.ssh_key = Some("~/.ssh/id".into());
        assert_eq!(ssh_config_block(&[key_only]), "");

        let mut alias_only = acc();
        alias_only.ssh_host = Some("github.com-x".into());
        assert_eq!(ssh_config_block(&[alias_only]), "");
    }

    #[test]
    fn splicing_appends_when_the_file_has_no_block() {
        let existing = "Host bastion\n    User ops\n";
        let out = splice_ssh_config(existing, ssh_config_block(&[with_alias()]).as_str()).unwrap();
        // The user's own config survives, first and unchanged.
        assert!(out.starts_with("Host bastion\n    User ops\n"));
        assert!(out.contains(SSH_BEGIN));
        assert!(out.contains("Host github.com-work"));
        assert!(out.trim_end().ends_with(SSH_END));
    }

    #[test]
    fn splicing_replaces_only_the_managed_region() {
        let first = splice_ssh_config(
            "Host bastion\n    User ops\n",
            &ssh_config_block(&[with_alias()]),
        )
        .unwrap();

        let mut renamed = with_alias();
        renamed.ssh_host = Some("github.com-personal".into());
        let second = splice_ssh_config(&first, &ssh_config_block(&[renamed])).unwrap();

        assert!(second.contains("Host bastion"), "{second}");
        assert!(second.contains("Host github.com-personal"));
        // The old alias is gone rather than accumulating on every save, which is
        // the failure mode of appending.
        assert!(!second.contains("Host github.com-work"), "{second}");
        assert_eq!(second.matches(SSH_BEGIN).count(), 1);
    }

    #[test]
    fn content_after_the_block_is_kept() {
        let existing = format!("{SSH_BEGIN}\nold\n{SSH_END}\nHost later\n    User me\n");
        let out = splice_ssh_config(&existing, "\nHost new\n").unwrap();
        assert!(out.contains("Host later"), "{out}");
        assert!(!out.contains("old"), "{out}");
    }

    #[test]
    fn a_half_written_block_is_refused_rather_than_guessed() {
        // Truncating from the start marker to EOF would take the rest of the file
        // with it — and this file is what a machine's access to everything runs on.
        let existing = format!("{SSH_BEGIN}\nHost x\nHost mine\n    User me\n");
        assert!(splice_ssh_config(&existing, "\nHost new\n").is_err());
    }

    #[test]
    fn stripping_leaves_the_users_own_config() {
        let existing = splice_ssh_config(
            "Host bastion\n    User ops\n",
            &ssh_config_block(&[with_alias()]),
        )
        .unwrap();
        let out = strip_ssh_config(&existing).unwrap();
        assert_eq!(out, "Host bastion\n    User ops\n");
        // Idempotent: a file that never had a block is returned untouched.
        assert_eq!(strip_ssh_config(&out).unwrap(), out);
    }

    #[test]
    fn a_wildcard_alias_is_refused() {
        // `Host *` in a generated block would capture every ssh connection the
        // machine makes, including ones that have nothing to do with git.
        let mut a = acc();
        a.ssh_host = Some("*".into());
        assert!(clean(&a).is_err());
    }

    #[test]
    fn an_existing_config_is_read_back() {
        // The shape people actually have — two GitHub aliases, written by hand.
        let text = "\
# Personal GitHub
Host github.com-personal
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_personal
    IdentitiesOnly yes

# Work GitHub
Host github.com-work
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_work
    IdentitiesOnly yes
";
        let got = parse_ssh_config(text);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].host, "github.com-personal");
        assert_eq!(got[0].hostname.as_deref(), Some("github.com"));
        assert_eq!(got[0].user.as_deref(), Some("git"));
        assert_eq!(got[0].identity_file.as_deref(), Some("~/.ssh/id_ed25519_personal"));
        assert!(got[0].identities_only);
        assert_eq!(got[0].comment.as_deref(), Some("Personal GitHub"));
        assert!(!got[0].managed);
        assert_eq!(got[1].host, "github.com-work");
    }

    #[test]
    fn the_apps_own_block_is_marked_as_managed() {
        let text = format!(
            "Host mine\n    User me\n{SSH_BEGIN}\n# Work\nHost github.com-work\n    IdentityFile ~/.ssh/k\n{SSH_END}\n"
        );
        let got = parse_ssh_config(&text);
        assert_eq!(got.len(), 2);
        assert!(!got[0].managed);
        // Otherwise the page would offer to import the entries it wrote itself,
        // which would then generate a duplicate of each on the next write.
        assert!(got[1].managed);
    }

    #[test]
    fn odd_but_legal_spellings_still_parse() {
        // ssh accepts `Key = value` and is case-insensitive about keys.
        let got = parse_ssh_config("host x\n  hostname=github.com\n  IDENTITYFILE ~/.ssh/k\n");
        assert_eq!(got[0].host, "x");
        assert_eq!(got[0].hostname.as_deref(), Some("github.com"));
        assert_eq!(got[0].identity_file.as_deref(), Some("~/.ssh/k"));
    }

    #[test]
    fn a_multi_pattern_host_keeps_its_other_names() {
        let got = parse_ssh_config("Host gh gh2 *.example.com\n    User git\n");
        assert_eq!(got[0].host, "gh");
        assert_eq!(got[0].aliases, vec!["gh2", "*.example.com"]);
    }

    #[test]
    fn directives_before_any_host_belong_to_nobody() {
        // A global default at the top of the file must not be reported as the first
        // block's own setting.
        let got = parse_ssh_config("ServerAliveInterval 60\nUser someone\nHost x\n    User git\n");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].user.as_deref(), Some("git"));
    }

    #[test]
    fn an_imported_entry_prefills_what_ssh_knows() {
        let entry = &parse_ssh_config(
            "# Work GitHub\nHost github.com-work\n    HostName github.com\n    IdentityFile ~/.ssh/id_work\n",
        )[0];
        let a = account_from_entry(entry);
        assert_eq!(a.label, "Work GitHub");
        assert_eq!(a.ssh_host.as_deref(), Some("github.com-work"));
        assert_eq!(a.ssh_key.as_deref(), Some("~/.ssh/id_work"));
        // ssh knows nothing about who commits, so these stay for the user to fill.
        assert_eq!(a.name, "");
        assert_eq!(a.email, "");
    }

    #[test]
    fn a_label_falls_back_to_the_part_of_the_alias_that_is_not_the_host() {
        let entry = &parse_ssh_config("Host github.com-personal\n    HostName github.com\n")[0];
        assert_eq!(account_from_entry(entry).label, "personal");
    }

    #[test]
    fn gh_status_lists_every_account_and_marks_the_active_one() {
        let out = "\
github.com
  ✓ Logged in to github.com account ada (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  ✓ Logged in to github.com account ada-work (keyring)
  - Active account: false
  - Git operations protocol: ssh
";
        let got = parse_gh_accounts(out);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].login, "ada");
        assert!(got[0].active);
        assert_eq!(got[1].login, "ada-work");
        assert!(!got[1].active);
        assert_eq!(got[1].host, "github.com");
    }

    #[test]
    fn the_older_single_account_output_still_parses() {
        // gh < 2.40 has no notion of a second account and prints no marker, so the
        // one account it names has to be taken as the active one.
        let out = "github.com\n  ✓ Logged in to github.com as ada (oauth_token)\n";
        let got = parse_gh_accounts(out);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].login, "ada");
        assert!(got[0].active);
    }

    #[test]
    fn nonsense_yields_no_accounts_rather_than_an_error() {
        // gh logged out prints to stderr and exits non-zero; a gh in a shape this
        // parser does not know must degrade to "no switcher", not to a failed page.
        for input in ["", "not gh output at all", "You are not logged into any hosts"] {
            assert!(parse_gh_accounts(input).is_empty(), "{input:?}");
        }
    }
}
