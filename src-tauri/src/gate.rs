//! The pure half of the confirmation gate, extracted so it can be tested.
//!
//! The impure half — that `run_action` uses `remove()` rather than `get()`, and so
//! consumes the intent — lives in commands.rs. Single-use is enforced by the map
//! operation itself, which is why there is no "used" flag to get wrong.

use crate::error::{AppError, AppResult};
use crate::model::Danger;
use std::time::Instant;

pub fn check_expiry(expires_at: Instant, now: Instant) -> AppResult<()> {
    if now > expires_at {
        // A dialog left open over lunch must not fire against repo state that has
        // since changed.
        return Err(AppError::IntentExpired);
    }
    Ok(())
}

/// Exact match. No trimming, no case folding — the phrase guards a `git reset
/// --hard` across every sa/ repo, so "Force " must not pass for "force".
pub fn check_typed_confirm(expected: Option<&str>, given: Option<&str>) -> AppResult<()> {
    match expected {
        None => Ok(()),
        Some(want) => match given {
            Some(got) if got == want => Ok(()),
            _ => Err(AppError::ConfirmMismatch),
        },
    }
}

/// Whether a mutating action runs without a confirmation dialog.
///
/// `read_only` used to answer both "does this change anything" and "does this need
/// a dialog", which made "confirm the two that matter and nothing else" impossible
/// to say. This is the second question only; `read_only` keeps its one meaning.
///
/// Three conditions, and all of them have to hold. The allowlist is the policy: a
/// deliberately short list of PR writes where the click is itself the decision, or
/// where a form already collected one. The other two are structural, and they are
/// the reason this is a function rather than a field on every action: an intent
/// that carries a typed phrase or `Danger::High` **cannot** be auto-confirmed, no
/// matter what any future caller puts in the list.
///
/// `Danger::Low` also makes the flag computed rather than fixed, which one arm
/// leans on: a PR checkout of a dirty tree is Medium, so the single case with
/// something worth reading gets a dialog to read it in.
///
/// Merging and closing are absent on purpose. Both are hard to walk back, and both
/// carry warnings that exist to be read.
///
/// The allowlist is still needed rather than "Low danger alone": `gitIdentity` and
/// `useGitAccount` are both Low mutations that must keep their dialogs.
pub fn skips_confirm(kind: &str, danger: Danger, typed: Option<&str>) -> bool {
    let allowed = matches!(
        kind,
        "ghPrCreate"
            | "ghPrReview"
            | "ghPrComment"
            | "ghPrReopen"
            | "ghPrReady"
            | "ghPrDraft"
            | "ghPrCheckout"
    );
    allowed && danger == Danger::Low && typed.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn fresh_intent_passes() {
        let now = Instant::now();
        assert!(check_expiry(now + Duration::from_secs(60), now).is_ok());
    }

    #[test]
    fn expired_intent_is_refused() {
        let now = Instant::now();
        let err = check_expiry(now - Duration::from_millis(1), now).unwrap_err();
        assert_eq!(err.code(), "INTENT_EXPIRED");
    }

    #[test]
    fn no_phrase_needed_means_anything_passes() {
        assert!(check_typed_confirm(None, None).is_ok());
        assert!(check_typed_confirm(None, Some("whatever")).is_ok());
    }

    #[test]
    fn exact_phrase_required() {
        assert!(check_typed_confirm(Some("force"), Some("force")).is_ok());
    }

    #[test]
    fn near_misses_are_refused() {
        for given in [None, Some(""), Some("Force"), Some("force "), Some(" force"), Some("forc")] {
            let err = check_typed_confirm(Some("force"), given).unwrap_err();
            assert_eq!(
                err.code(),
                "TYPED_CONFIRM_MISMATCH",
                "expected {given:?} to be refused"
            );
        }
    }

    #[test]
    fn the_light_pr_writes_skip_their_dialog() {
        for kind in [
            "ghPrCreate",
            "ghPrReview",
            "ghPrComment",
            "ghPrReopen",
            "ghPrReady",
            "ghPrDraft",
            "ghPrCheckout",
        ] {
            assert!(skips_confirm(kind, Danger::Low, None), "{kind}");
        }
    }

    #[test]
    fn merging_and_closing_always_confirm() {
        // The requirement, and the whole reason this function exists.
        for kind in ["ghPrMerge", "ghPrClose"] {
            for danger in [Danger::Low, Danger::Medium, Danger::High] {
                assert!(!skips_confirm(kind, danger, None), "{kind} at {danger:?}");
            }
        }
    }

    #[test]
    fn danger_and_a_typed_phrase_override_the_allowlist() {
        // Structural, not a convention: an arm that escalates its own danger gets
        // its dialog back without touching this list. `ghPrCheckout` does exactly
        // that on a dirty tree.
        assert!(!skips_confirm("ghPrCheckout", Danger::Medium, None));
        assert!(!skips_confirm("ghPrCheckout", Danger::High, None));
        assert!(!skips_confirm("ghPrCheckout", Danger::Low, Some("discard")));
    }

    #[test]
    fn everything_else_keeps_its_dialog() {
        // Including the two Low-danger mutations that are not PR writes, which is
        // why the allowlist cannot be replaced by a danger check alone.
        for kind in [
            "gitIdentity",
            "useGitAccount",
            "push",
            "commit",
            "discardChanges",
            "ghRunRerun",
            "prList",
            "",
            "ghPr",
            "ghPrSomethingNew",
        ] {
            assert!(!skips_confirm(kind, Danger::Low, None), "{kind}");
        }
    }
}
