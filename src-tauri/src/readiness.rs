//! Whether this machine can actually do what the dashboard offers.
//!
//! Distinct from `tools_ready`, which only means the probe finished — it is `true` on
//! a machine with nothing installed, which is why every button used to be live on a
//! machine where every button failed.
//!
//! Deliberately narrower than the setup page's required steps. This answers "will the
//! dashboard's buttons work", not "is this machine nicely furnished": a user with git,
//! Node, a package manager and a git identity gets a working app, and being nagged
//! about `delta` or `ripgrep` would be noise.

use crate::toolchain::Toolchain;
use serde::Serialize;

/// The Node package managers any one of which is enough.
///
/// Mirrors `Toolchain::preferred_package_manager` — if that finds one, dev servers and
/// scripts work, so requiring a specific one here would be stricter than the app is.
const PACKAGE_MANAGERS: [&str; 4] = ["bun", "pnpm", "yarn", "npm"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    /// The probe finished. NOT "the tools exist" — see the module note.
    pub tools_ready: bool,
    /// Tool ids the app genuinely cannot work without. Empty means it can.
    pub missing_required: Vec<String>,
    /// `user.name` and `user.email` are both set.
    pub git_identity: bool,
    /// An ssh key in an agent, or a signed-in gh. Reported, but see `ready`.
    pub credentials: bool,
    pub ready: bool,
}

/// The decision, as a pure function so it is testable with no machine.
///
/// `credentials` is reported but deliberately **not** part of `ready`: someone cloning
/// over HTTPS with a credential helper is perfectly set up, and taking over their
/// window would be wrong. The setup page still asks for it, because it is the most
/// common reason a first clone fails.
pub fn decide(
    has: impl Fn(&str) -> bool,
    git_identity: bool,
    credentials: bool,
    tools_ready: bool,
) -> Readiness {
    let mut missing_required = Vec::new();

    // Every scan and every repo action starts here.
    if !has("git") {
        missing_required.push("git".to_string());
    }
    // Dev servers, and `pkg::available_scripts` for the per-repo script buttons.
    if !has("node") {
        missing_required.push("node".to_string());
    }
    if !PACKAGE_MANAGERS.iter().any(|m| has(m)) {
        // Reported as npm because that is the one the setup page installs, and a list
        // of four alternatives in a banner reads as four problems.
        missing_required.push("npm".to_string());
    }

    // Nothing can be judged before the probe lands, so claim neither ready nor broken.
    let ready = tools_ready && missing_required.is_empty() && git_identity;

    Readiness {
        tools_ready,
        missing_required,
        git_identity,
        credentials,
        ready,
    }
}

/// Before the first probe: not ready, but not broken either.
///
/// `tools_ready: false` is load-bearing — it is what stops the UI reading a machine it
/// has not looked at yet as one that needs taking over.
pub fn unknown() -> Readiness {
    Readiness {
        tools_ready: false,
        missing_required: Vec::new(),
        git_identity: false,
        credentials: false,
        ready: false,
    }
}

/// Reads the machine, then decides.
///
/// Cheap on purpose — two `git config --get` calls and some map lookups. It must stay
/// that way: this runs on every `get_bootstrap`, and `setup::status` (which walks 44
/// catalog entries running `--version` sequentially) is far too expensive to sit here.
pub async fn probe(tc: &Toolchain) -> Readiness {
    let (name, email) = crate::setup::git_identity(tc).await;
    let creds = crate::creds::status(tc).await;
    decide(
        |t| tc.has(t),
        name.is_some() && email.is_some(),
        creds.satisfied(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A machine with the four things that matter.
    fn full(t: &str) -> bool {
        matches!(t, "git" | "node" | "npm")
    }

    #[test]
    fn a_complete_machine_is_ready() {
        let r = decide(full, true, true, true);
        assert!(r.ready);
        assert!(r.missing_required.is_empty());
    }

    #[test]
    fn a_missing_tool_is_named() {
        let r = decide(|t| t == "node", true, true, true);
        assert!(!r.ready);
        assert_eq!(r.missing_required, vec!["git", "npm"]);
    }

    #[test]
    fn any_one_package_manager_is_enough() {
        // Mirrors `preferred_package_manager`: bun alone is a working setup, and
        // demanding npm on a bun machine would be stricter than the app is.
        for pm in ["bun", "pnpm", "yarn", "npm"] {
            let r = decide(|t| t == "git" || t == "node" || t == pm, true, true, true);
            assert!(r.ready, "{pm} alone should satisfy the package-manager check");
        }
    }

    #[test]
    fn credentials_are_reported_but_do_not_block() {
        // Cloning over HTTPS with a credential helper is a valid setup, so this must
        // not take over the window.
        let r = decide(full, true, false, true);
        assert!(!r.credentials);
        assert!(r.ready);
    }

    #[test]
    fn a_missing_git_identity_blocks() {
        // Not cosmetic: every commit this app helps make would be unattributed.
        let r = decide(full, false, true, true);
        assert!(!r.ready);
        assert!(r.missing_required.is_empty(), "identity is not a missing tool");
    }

    #[test]
    fn nothing_is_ready_before_the_probe_lands() {
        // The reason `tools_ready` is a term at all: judging a half-probed machine
        // would flash a takeover screen on a perfectly good one.
        let r = decide(full, true, true, false);
        assert!(!r.ready);
    }
}
