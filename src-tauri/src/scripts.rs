//! Catalog of the workspace's own scripts, with the metadata the UI needs to
//! render the right affordance for each.
//!
//! Triage is based on reading all 8 scripts. The split that matters is whether a
//! script prompts with `read -rp`: those cannot be driven from a GUI.
//!
//! DO NOT "solve" the interactive ones by piping canned stdin. They select targets
//! by *menu index*, and they push commits, open PRs and publish npm packages. Add
//! a repo to fe/ — or reorder a menu — and a hardcoded `printf '2\n1\n'` silently
//! acts on a different repo. The failure would be silent, remote and irreversible.
//! Interactive scripts are launched in a real terminal instead.

use crate::error::{AppError, AppResult};
use crate::model::{Danger, ScriptArg, ScriptDescriptor, ScriptMode};
use std::path::{Path, PathBuf};

/// Discovers runnable scripts in the workspace.
///
/// Looks in `scripts/` then the workspace root, and reads each file to decide how
/// it can be run. Nothing is hardcoded: a workspace with different scripts gets
/// its own list.
pub fn discover(root: &Path) -> Vec<ScriptDescriptor> {
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    for dir in [crate::paths::scripts_dir(root), root.to_path_buf()] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && is_script(p))
            .collect();
        files.sort();

        for path in files {
            let Some(file) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !seen.insert(file.to_string()) {
                continue;
            }
            out.push(describe(&path, file));
        }
    }

    out
}

fn is_script(p: &Path) -> bool {
    let ext_ok = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e, "sh" | "bash" | "zsh"));
    if ext_ok {
        return true;
    }
    // An extensionless executable with a shebang counts too.
    if !is_executable(p) {
        return false;
    }
    std::fs::read_to_string(p)
        .map(|t| t.starts_with("#!"))
        .unwrap_or(false)
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn describe(path: &Path, file: &str) -> ScriptDescriptor {
    let body = std::fs::read_to_string(path).unwrap_or_default();
    let id = file.trim_end_matches(".sh").trim_end_matches(".bash").to_string();

    ScriptDescriptor {
        id: id.clone(),
        file: file.to_string(),
        title: title_from(&id),
        description: doc_comment(&body),
        mode: if is_interactive(&body) {
            // Reads from stdin, so it cannot be driven from a GUI.
            ScriptMode::TerminalOnly
        } else {
            ScriptMode::Headless
        },
        danger: danger_of(&body),
        required_tools: required_tools(&body),
        arg_schema: arg_schema(&body),
        non_zero_exit_meaning: None,
        hint: hint_of(&body),
    }
}

/// `fe-auto-create-pr` -> `Fe auto create pr`, minus a leading noise prefix.
fn title_from(id: &str) -> String {
    let cleaned = id.replace(['-', '_'], " ");
    let mut chars = cleaned.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => cleaned,
    }
}

/// The first run of `#` comments after the shebang, which is where these scripts
/// explain themselves.
pub fn doc_comment(body: &str) -> String {
    let mut lines = Vec::new();
    for line in body.lines() {
        let t = line.trim();
        if t.starts_with("#!") || t.is_empty() && lines.is_empty() {
            continue;
        }
        if let Some(rest) = t.strip_prefix('#') {
            let rest = rest.trim();
            // Skip separator bars like "# ----" and shellcheck directives.
            if rest.chars().all(|c| c == '-' || c == '=') || rest.starts_with("shellcheck") {
                continue;
            }
            lines.push(rest.to_string());
            if lines.len() >= 2 {
                break;
            }
        } else if !lines.is_empty() || !t.is_empty() {
            break;
        }
    }

    let text = lines.join(" ");
    if text.is_empty() {
        "No description in the script's header comment.".to_string()
    } else {
        text
    }
}

/// True when the script blocks on stdin. Such a script cannot be run headless: it
/// would hang forever with its prompt written into a pipe nobody reads.
pub fn is_interactive(body: &str) -> bool {
    body.lines().any(|l| {
        let t = l.trim();
        if t.starts_with('#') {
            return false;
        }
        t.contains("read -rp")
            || t.contains("read -p")
            || t.contains("read -r -p")
            || t.starts_with("read ")
            || t.contains("select ")
    })
}

/// Conservative: anything that can destroy work or publish is high.
pub fn danger_of(body: &str) -> Danger {
    let hay = body.to_lowercase();
    let destructive = [
        "reset --hard",
        "clean -fd",
        "rm -rf",
        "push --force",
        "push -f",
        "npm publish",
        "checkout --",
        "branch -d",
    ];
    if destructive.iter().any(|d| hay.contains(d)) {
        return Danger::High;
    }
    let writes = ["git push", "git commit", "gh pr create", "git clone", "npm version"];
    if writes.iter().any(|d| hay.contains(d)) {
        return Danger::Medium;
    }
    Danger::Low
}

/// Tools the script invokes, so a missing one can be warned about up front.
pub fn required_tools(body: &str) -> Vec<String> {
    let candidates = ["git", "gh", "jq", "npm", "bun", "yarn", "pnpm", "docker", "podman", "claude"];
    let mut out = Vec::new();
    for c in candidates {
        // Word-ish match: the tool followed by a space, so "github" is not "gh".
        if body.contains(&format!("{c} ")) || body.contains(&format!("{c}\n")) {
            out.push(c.to_string());
        }
    }
    out
}

fn hint_of(body: &str) -> String {
    let tools = required_tools(body);
    for preferred in ["gh", "npm", "jq", "git"] {
        if tools.iter().any(|t| t == preferred) {
            return preferred.to_string();
        }
    }
    "sh".to_string()
}

/// Extracts an argument schema from a `case "$MODE" in a|b|c)` pattern, which is
/// how these scripts validate their own enum arguments.
pub fn arg_schema(body: &str) -> Vec<ScriptArg> {
    let mut out = Vec::new();

    // Positional defaults: MODE="${1:-normal}" / BRANCH="${2:-v26}"
    for line in body.lines() {
        let t = line.trim();
        if t.starts_with('#') {
            continue;
        }
        let Some((lhs, rhs)) = t.split_once('=') else {
            continue;
        };
        let name = lhs.trim();
        if !name.chars().all(|c| c.is_ascii_uppercase() || c == '_') || name.is_empty() {
            continue;
        }
        let rhs = rhs.trim().trim_matches('"');
        // ${1:-normal}
        let Some(inner) = rhs.strip_prefix("${").and_then(|r| r.strip_suffix('}')) else {
            continue;
        };
        let Some((pos, default)) = inner.split_once(":-") else {
            continue;
        };
        if !pos.chars().all(|c| c.is_ascii_digit()) || pos.is_empty() {
            continue;
        }

        let options = enum_options(body, name);
        out.push(ScriptArg {
            name: name.to_lowercase(),
            kind: if options.is_some() { "enum".into() } else { "text".into() },
            options,
            default: Some(default.to_string()),
        });
    }

    out.sort_by_key(|a| a.name.clone());
    out.dedup_by(|a, b| a.name == b.name);
    out
}

/// Finds `case "$NAME" in normal|stash|force)` and returns the alternatives.
fn enum_options(body: &str, var: &str) -> Option<Vec<String>> {
    let needle = format!("\"${var}\"");
    let mut lines = body.lines();
    while let Some(l) = lines.next() {
        if !l.contains("case") || !l.contains(&needle) {
            continue;
        }
        for inner in lines.by_ref().take(12) {
            let t = inner.trim();
            let Some(alts) = t.strip_suffix(')') else { continue };
            if !alts.contains('|') {
                continue;
            }
            let opts: Vec<String> = alts
                .split('|')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
                .collect();
            if opts.len() >= 2 {
                return Some(opts);
            }
        }
    }
    None
}

pub fn find(root: &Path, id: &str) -> AppResult<ScriptDescriptor> {
    discover(root)
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| AppError::UnknownScript(id.to_string()))
}

/// Validates user-supplied args against the descriptor's schema.
///
/// Enum args must match an option exactly; free-text args are rejected if they
/// contain shell metacharacters. Nothing is ever passed through a shell, but a
/// value that looks like an injection attempt is a bug worth surfacing.
pub fn validate_args(desc: &ScriptDescriptor, args: &[String]) -> AppResult<Vec<String>> {
    if args.len() > desc.arg_schema.len() {
        return Err(AppError::Invalid(format!(
            "{} accepts at most {} argument(s)",
            desc.file,
            desc.arg_schema.len()
        )));
    }

    let mut out = Vec::new();
    for (i, value) in args.iter().enumerate() {
        let schema = &desc.arg_schema[i];
        if let Some(options) = &schema.options {
            if !options.contains(value) {
                return Err(AppError::Invalid(format!(
                    "{} must be one of: {}",
                    schema.name,
                    options.join(", ")
                )));
            }
        } else if value.chars().any(|c| ";|&$`<>()\n\r\\\"'".contains(c)) {
            return Err(AppError::Invalid(format!(
                "{} contains characters that are not allowed",
                schema.name
            )));
        }
        out.push(value.clone());
    }
    Ok(out)
}

/// The `force` mode of fe-sa-switch-pull.sh runs `git reset --hard` and `git clean`
/// across every sa/ repo. That is the one action in the workspace that destroys
/// work irrecoverably, so it demands a typed confirmation.
/// A high-danger script, or one being asked to run a destructive mode, demands a
/// typed confirmation. Derived from the script's own content and arguments rather
/// than from a list of known names.
pub fn typed_confirm_for(desc: &ScriptDescriptor, args: &[String]) -> Option<String> {
    if let Some(first) = args.first() {
        if matches!(first.as_str(), "force" | "hard" | "reset" | "clean") {
            return Some(first.clone());
        }
    }
    if desc.danger == Danger::High {
        return Some("run".to_string());
    }
    None
}

/// Warnings derived from what the script actually contains.
pub fn extra_warnings(desc: &ScriptDescriptor, args: &[String], body: &str) -> Vec<String> {
    let mut w = Vec::new();
    let hay = body.to_lowercase();

    if hay.contains("reset --hard") {
        w.push("This script runs `git reset --hard` — uncommitted work will be destroyed.".into());
    }
    if hay.contains("clean -fd") {
        w.push("This script runs `git clean -fd` — untracked files will be deleted.".into());
    }
    if hay.contains("npm publish") {
        w.push("This script publishes to a package registry.".into());
    }
    if hay.contains("push --force") || hay.contains("push -f") {
        w.push("This script force-pushes, which can overwrite remote history.".into());
    }
    if hay.contains("git clone") {
        w.push("Clones over the network — a working ssh-agent may be required.".into());
    }
    if let Some(first) = args.first() {
        if first == "force" {
            w.push(format!("Running {} in 'force' mode.", desc.file));
        }
    }
    w
}
