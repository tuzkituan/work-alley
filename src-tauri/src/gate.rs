//! The pure half of the confirmation gate, extracted so it can be tested.
//!
//! The impure half — that `run_action` uses `remove()` rather than `get()`, and so
//! consumes the intent — lives in commands.rs. Single-use is enforced by the map
//! operation itself, which is why there is no "used" flag to get wrong.

use crate::error::{AppError, AppResult};
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
}
