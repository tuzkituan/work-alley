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

pub fn catalog() -> Vec<ScriptDescriptor> {
    vec![
        ScriptDescriptor {
            id: "verify-repos".into(),
            file: "verify-repos.sh".into(),
            title: "Verify repos".into(),
            description: "Diff repos.json against what is cloned on disk.".into(),
            mode: ScriptMode::Headless,
            danger: Danger::Low,
            required_tools: vec!["jq".into()],
            arg_schema: vec![],
            // Generic "nonzero means broken" handling would mislabel this script's
            // normal, informative result as a crash.
            non_zero_exit_meaning: Some("drift detected between repos.json and disk".into()),
            hint: "jq".into(),
        },
        ScriptDescriptor {
            id: "fe-sa-switch-pull".into(),
            file: "fe-sa-switch-pull.sh".into(),
            title: "Switch + pull Super Admin".into(),
            description: "Move every sa/ repo to a branch and pull.".into(),
            mode: ScriptMode::Headless,
            danger: Danger::High,
            required_tools: vec!["git".into()],
            arg_schema: vec![
                ScriptArg {
                    name: "mode".into(),
                    kind: "enum".into(),
                    options: Some(vec!["normal".into(), "stash".into(), "force".into()]),
                    default: Some("normal".into()),
                },
                ScriptArg {
                    name: "branch".into(),
                    kind: "text".into(),
                    options: None,
                    default: Some("v26".into()),
                },
            ],
            non_zero_exit_meaning: Some("one or more repos failed to switch".into()),
            hint: "git".into(),
        },
        ScriptDescriptor {
            id: "clone-all".into(),
            file: "clone-all.sh".into(),
            title: "Clone all repos".into(),
            description: "Clone or update every repo declared in repos.json.".into(),
            mode: ScriptMode::Headless,
            danger: Danger::Medium,
            required_tools: vec!["git".into()],
            arg_schema: vec![ScriptArg {
                name: "ssh_host_alias".into(),
                kind: "text".into(),
                options: None,
                default: Some("github.com-work".into()),
            }],
            non_zero_exit_meaning: Some("one or more repos failed to clone".into()),
            hint: "git".into(),
        },
        ScriptDescriptor {
            id: "fe-auto-review-pr".into(),
            file: "fe-auto-review-pr.sh".into(),
            title: "Review a PR".into(),
            // Non-interactive when given both args, but it then execs the claude
            // TUI, which needs a real terminal.
            description: "Open a PR review in Claude Code. Needs a terminal.".into(),
            mode: ScriptMode::TerminalOnly,
            danger: Danger::Low,
            required_tools: vec!["gh".into()],
            arg_schema: vec![
                ScriptArg {
                    name: "repo".into(),
                    kind: "text".into(),
                    options: None,
                    default: None,
                },
                ScriptArg {
                    name: "pr_number".into(),
                    kind: "text".into(),
                    options: None,
                    default: None,
                },
            ],
            non_zero_exit_meaning: None,
            hint: "gh".into(),
        },
        ScriptDescriptor {
            id: "fe-auto-create-pr".into(),
            file: "fe-auto-create-pr.sh".into(),
            title: "Create a PR".into(),
            description: "Branch, commit, push and open a PR. Prompts interactively.".into(),
            mode: ScriptMode::TerminalOnly,
            danger: Danger::Medium,
            required_tools: vec!["gh".into()],
            arg_schema: vec![],
            non_zero_exit_meaning: None,
            hint: "gh".into(),
        },
        ScriptDescriptor {
            id: "fe-auto-create-pr-ui".into(),
            file: "fe-auto-create-pr-ui.sh".into(),
            title: "Create a PR (blazeup-ui)".into(),
            description: "The blazeup-lib-ui PR flow. Prompts interactively.".into(),
            mode: ScriptMode::TerminalOnly,
            danger: Danger::Medium,
            required_tools: vec!["gh".into()],
            arg_schema: vec![],
            non_zero_exit_meaning: None,
            hint: "gh".into(),
        },
        ScriptDescriptor {
            id: "fe-auto-release-ui".into(),
            file: "fe-auto-release-ui.sh".into(),
            title: "Release blazeup-ui".into(),
            description: "Version, build and publish the UI library. Publishes to npm.".into(),
            mode: ScriptMode::TerminalOnly,
            danger: Danger::High,
            required_tools: vec!["npm".into()],
            arg_schema: vec![],
            non_zero_exit_meaning: None,
            hint: "npm".into(),
        },
        ScriptDescriptor {
            id: "setup".into(),
            file: "setup.sh".into(),
            title: "Workspace setup".into(),
            description: "One-time bootstrap: clone repos and link Claude memory.".into(),
            mode: ScriptMode::TerminalOnly,
            danger: Danger::Medium,
            required_tools: vec!["git".into()],
            arg_schema: vec![],
            non_zero_exit_meaning: None,
            hint: "env".into(),
        },
    ]
}

pub fn find(id: &str) -> AppResult<ScriptDescriptor> {
    catalog()
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
pub fn typed_confirm_for(desc: &ScriptDescriptor, args: &[String]) -> Option<String> {
    if desc.id == "fe-sa-switch-pull" && args.first().map(|s| s.as_str()) == Some("force") {
        return Some("force".to_string());
    }
    None
}

pub fn extra_warnings(desc: &ScriptDescriptor, args: &[String]) -> Vec<String> {
    let mut w = Vec::new();
    if desc.id == "fe-sa-switch-pull" && args.first().map(|s| s.as_str()) == Some("force") {
        w.push(
            "force mode runs `git reset --hard` and `git clean -fd` in every sa/ repo. \
             Uncommitted work there will be destroyed."
                .into(),
        );
    }
    if desc.id == "clone-all" {
        w.push("Clones over SSH — a working ssh-agent is required.".into());
    }
    w
}
