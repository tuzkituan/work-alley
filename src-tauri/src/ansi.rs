use crate::model::{Severity, Stream};

/// Strips SGR escape sequences and carriage-return progress rewrites.
pub fn strip(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => {
                // CSI ... final-byte, or a two-char sequence like ESC(B
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for c2 in chars.by_ref() {
                        if c2.is_ascii_alphabetic() || c2 == '~' {
                            break;
                        }
                    }
                } else if chars.peek() == Some(&']') {
                    // OSC ... BEL | ST
                    chars.next();
                    while let Some(c2) = chars.next() {
                        if c2 == '\u{7}' {
                            break;
                        }
                        if c2 == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                } else {
                    chars.next();
                }
            }
            // A progress line rewrites itself with \r; keep only the last state.
            '\r' => out.clear(),
            _ => out.push(c),
        }
    }

    out.trim_end().to_string()
}

/// Classifies a line's severity from its *content*.
///
/// `stream` and `severity` are deliberately independent. git writes ordinary
/// progress to stderr, and vite writes warnings there — mapping stderr straight
/// to `err` paints healthy operations red and trains the user to ignore red.
pub fn classify(stream: Stream, text: &str) -> Severity {
    let t = text.trim_start();
    let lower = t.to_lowercase();

    // Markers the workspace scripts actually emit.
    if t.starts_with("[OK]") || t.starts_with('✓') || t.starts_with("✔") {
        return Severity::Ok;
    }
    if t.starts_with("[FAIL]") || t.starts_with('✗') || t.starts_with("✘") {
        return Severity::Err;
    }
    if t.starts_with("[SKIP]") || t.starts_with("! ") {
        return Severity::Warn;
    }
    if t.starts_with("[..]") || t.starts_with('▸') {
        return Severity::Info;
    }

    if lower.starts_with("fatal:")
        || lower.starts_with("error:")
        || lower.starts_with("error ")
        || lower.contains(" error ")
        || lower.starts_with("err!")
        || lower.starts_with("npm err")
    {
        return Severity::Err;
    }
    if lower.starts_with("warning:")
        || lower.starts_with("warn")
        || lower.starts_with("npm warn")
        || lower.contains("deprecated")
    {
        return Severity::Warn;
    }
    if lower.starts_with("hint:") || lower.starts_with("note:") || lower.starts_with("info") {
        return Severity::Info;
    }

    match stream {
        // NOT Severity::Err — see the doc comment.
        Stream::Stderr => Severity::Out,
        Stream::Stdout => Severity::Out,
        Stream::Meta => Severity::Info,
    }
}

/// vite prints `  ➜  Local:   http://localhost:5015/`. Sniffing this corrects a
/// wrong static port guess and covers repos with no VITE_APP_PORT at all.
pub fn sniff_port(text: &str) -> Option<u16> {
    let idx = text.find("localhost:")?;
    let rest = &text[idx + "localhost:".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_sgr() {
        assert_eq!(strip("\u{1b}[0;32m[OK]\u{1b}[0m  done"), "[OK]  done");
        assert_eq!(strip("\u{1b}[1;33m[SKIP]\u{1b}[0m x"), "[SKIP] x");
    }

    #[test]
    fn carriage_return_keeps_last_state() {
        assert_eq!(strip("Receiving 10%\rReceiving 100%"), "Receiving 100%");
    }

    #[test]
    fn script_markers_win_over_stream() {
        assert_eq!(classify(Stream::Stderr, "[OK]   ui → v26"), Severity::Ok);
        assert_eq!(classify(Stream::Stdout, "[FAIL] be — boom"), Severity::Err);
        assert_eq!(classify(Stream::Stdout, "[SKIP] sa — archived"), Severity::Warn);
    }

    #[test]
    fn plain_stderr_is_not_an_error() {
        // `git fetch` progress must not render red.
        assert_eq!(
            classify(Stream::Stderr, "remote: Enumerating objects: 12, done."),
            Severity::Out
        );
    }

    #[test]
    fn git_fatal_is_an_error() {
        assert_eq!(
            classify(Stream::Stderr, "fatal: could not read from remote"),
            Severity::Err
        );
    }

    #[test]
    fn sniffs_vite_port() {
        assert_eq!(sniff_port("  ➜  Local:   http://localhost:5015/"), Some(5015));
        assert_eq!(sniff_port("no port here"), None);
    }
}
