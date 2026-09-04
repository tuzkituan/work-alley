//! "Is there a newer Work Alley?" — asked on demand, never enforced.
//!
//! Deliberately *not* `tauri-plugin-updater`. That one downloads and swaps the
//! binary in place, which needs a signing keypair, a `latest.json` endpoint and a
//! release pipeline that produces both — and then does the wrong thing on two of
//! the five targets this app ships: a `.deb` and an `.rpm` are owned by the
//! system package manager, and an app that overwrites files apt installed leaves
//! the two disagreeing about what is on disk. What survives that subtraction is
//! the part people actually wanted: say when there is a new version, and open the
//! page that has it.
//!
//! The transport is `git ls-remote`, not an HTTP client. git is already a hard
//! requirement of this app, is already hardened for non-interactive use in
//! `git.rs`, and already knows whatever proxy and CA bundle the machine is
//! configured with — where `reqwest` sits in the dependency tree with no TLS
//! backend, so one HTTPS call a month would have pulled in a whole rustls stack.
//!
//! The cost is worth stating plainly: tags are not releases. A tag pushed before
//! its binaries finish uploading reads here as an update whose download page is
//! still empty. `scripts/release.sh` tags and uploads in one run, so that window
//! is minutes long — and the failure mode is a page that says "no assets yet",
//! not a broken install.

use semver::Version;
use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

/// Where releases come from. A constant, not a setting: an update source someone
/// else can point at is a way to hand the user someone else's binary.
const REPO_URL: &str = "https://github.com/tuzkituan/work-alley.git";

/// Where "Download" goes. On the opener allowlist in `capabilities/default.json`
/// by virtue of being on github.com.
pub const RELEASES_PAGE: &str = "https://github.com/tuzkituan/work-alley/releases/latest";

/// Longer than `git.rs`'s ten seconds for a local repo, because this one is a TCP
/// handshake and a TLS negotiation to another continent, and the honest answer to
/// a slow hotel network is to wait a little rather than to report a failure that
/// is not one.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// The answer, including the ways it can go wrong.
///
/// Being offline is not "the frontend asked for something impossible" — the rule
/// `error.rs` opens with — so it is data, and the row renders it as a sentence
/// rather than raising a toast the user did not ask for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateCheck {
    #[serde(rename_all = "camelCase")]
    UpToDate { current: String },
    #[serde(rename_all = "camelCase")]
    Available {
        current: String,
        latest: String,
        url: String,
    },
    #[serde(rename_all = "camelCase")]
    Failed { current: String, reason: String },
}

/// The version this build reports. `Cargo.toml` and `tauri.conf.json` are kept in
/// step by `scripts/release.sh`; this reads the one the binary was compiled from.
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub async fn check(git: Option<&Path>, cwd: &Path) -> UpdateCheck {
    let current = current_version().to_string();

    let Ok(parsed) = Version::parse(&current) else {
        return UpdateCheck::Failed {
            reason: format!("this build's own version ({current}) is not a version number"),
            current,
        };
    };

    let Some(git) = git else {
        return UpdateCheck::Failed {
            current,
            reason: "git is not installed, and the check reads the release tags with it".into(),
        };
    };

    let out = match ls_remote_tags(git, cwd).await {
        Ok(o) => o,
        Err(reason) => return UpdateCheck::Failed { current, reason },
    };

    match newest(&out, &parsed) {
        Some(latest) => UpdateCheck::Available {
            current,
            latest: latest.to_string(),
            url: RELEASES_PAGE.to_string(),
        },
        None => UpdateCheck::UpToDate { current },
    }
}

/// The newest tag that beats `current`, or None when there is nothing newer.
///
/// Split from the process call so the interesting half — which tag wins, and what
/// counts as newer — is testable with no network and no git binary, the same
/// bargain `platform/mod.rs` strikes for the Windows paths.
pub fn newest(ls_remote: &str, current: &Version) -> Option<Version> {
    ls_remote
        .lines()
        .filter_map(tag_version)
        // A stable build is never pushed towards a release candidate: someone
        // running 0.1.3 did not opt into 0.2.0-rc.1, and offering it would make
        // "there is an update" mean two different things. A build that is itself a
        // pre-release is already on that track, so for it they count.
        .filter(|v| v.pre.is_empty() || !current.pre.is_empty())
        .filter(|v| v > current)
        .max()
}

/// One `ls-remote` line — `<sha>\trefs/tags/v0.1.3` — as a version.
fn tag_version(line: &str) -> Option<Version> {
    let (_sha, r#ref) = line.split_once('\t')?;
    let tag = r#ref.trim().strip_prefix("refs/tags/")?;
    // `--refs` drops the peeled `^{}` entries already. Kept because the cost is a
    // method call and the alternative is every annotated tag counting twice.
    let tag = tag.strip_suffix("^{}").unwrap_or(tag);
    // Tags here are `v`-prefixed; semver is not.
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

async fn ls_remote_tags(git: &Path, cwd: &Path) -> Result<String, String> {
    let mut c = tokio::process::Command::new(git);
    // Same hardening every other child gets: no console window, no credential
    // prompt into a pipe nobody is reading. The repo is public, so there is
    // nothing to authenticate — which is precisely why a prompt here would hang
    // rather than help.
    crate::git::harden(&mut c);
    c.current_dir(cwd)
        .args(["ls-remote", "--tags", "--refs", REPO_URL])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = c.spawn().map_err(|e| e.to_string())?;
    let out = match tokio::time::timeout(CHECK_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err("no answer from github.com within 20s".into()),
    };

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // git's own words when it has them: "Could not resolve host" tells someone
        // they are offline, where "the check failed" tells them nothing.
        return Err(if err.is_empty() {
            "could not reach github.com".into()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `git ls-remote --tags --refs` output, tab-separated.
    const TAGS: &str = "ffb55c94fa6d15bf207c248a7d4feb754b170ad7\trefs/tags/v0.1.0\n\
                        f1040034d54c54aa48f7358ac9db487b7e8b5a49\trefs/tags/v0.1.1\n\
                        559bf11fe3c5911d9ff4aa537d7ed686d1793a80\trefs/tags/v0.1.2\n\
                        52eab85cab19a3a7c5afebbe1b79773c6cd874cd\trefs/tags/v0.1.3\n";

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn picks_the_highest_tag_rather_than_the_last_line() {
        // ls-remote sorts lexically, so 0.1.10 arrives *before* 0.1.9 and "the last
        // line" would ship an older release than the one that exists.
        let out = format!("{TAGS}aaa\trefs/tags/v0.1.10\nbbb\trefs/tags/v0.1.9\n");
        assert_eq!(newest(&out, &v("0.1.3")), Some(v("0.1.10")));
    }

    #[test]
    fn nothing_newer_is_none() {
        assert_eq!(newest(TAGS, &v("0.1.3")), None);
    }

    #[test]
    fn a_build_ahead_of_every_tag_is_up_to_date() {
        // Running a locally built binary is normal here — the releases are built by
        // hand — and being told to "update" to an older tag would be nonsense.
        assert_eq!(newest(TAGS, &v("0.2.0")), None);
    }

    #[test]
    fn a_stable_build_is_not_offered_a_release_candidate() {
        let out = format!("{TAGS}ccc\trefs/tags/v0.2.0-rc.1\n");
        assert_eq!(newest(&out, &v("0.1.3")), None);
        // ...but a build already on that track sees it.
        assert_eq!(newest(&out, &v("0.2.0-rc.0")), Some(v("0.2.0-rc.1")));
    }

    #[test]
    fn junk_refs_and_unparseable_tags_are_skipped_not_fatal() {
        let out = "aaa\trefs/tags/nightly\n\
                   bbb\trefs/heads/main\n\
                   no-tab-here\n\
                   \n\
                   ccc\trefs/tags/v0.9.0\n";
        assert_eq!(newest(out, &v("0.1.3")), Some(v("0.9.0")));
    }

    #[test]
    fn peeled_annotated_tags_do_not_confuse_the_comparison() {
        // What arrives without `--refs`: every annotated tag twice, the second
        // spelled `^{}`. Both must read as the same version.
        let out = "aaa\trefs/tags/v0.9.0\nbbb\trefs/tags/v0.9.0^{}\n";
        assert_eq!(newest(out, &v("0.1.3")), Some(v("0.9.0")));
    }

    #[test]
    fn an_empty_answer_is_up_to_date_not_a_crash() {
        assert_eq!(newest("", &v("0.1.3")), None);
    }

    #[test]
    fn the_build_reports_a_parseable_version() {
        // Guards the `Failed` branch in `check` that exists only for this being
        // false, and catches a `Cargo.toml` version that stops being semver.
        assert!(Version::parse(current_version()).is_ok());
    }
}
