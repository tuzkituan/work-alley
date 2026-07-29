use crate::model::UiDep;
use std::path::Path;

/// Reads the workspace UI package version a repo declares.
///
/// Ranges that semver cannot parse (`workspace:*`, git URLs, `*`) keep `declared`
/// and leave `resolved` as None — the UI renders "n/a" rather than crashing or
/// inventing a version.
pub async fn read_ui_dep(repo: &Path, ui_package: &str) -> UiDep {
    let Ok(text) = tokio::fs::read_to_string(repo.join("package.json")).await else {
        return UiDep::default();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return UiDep::default();
    };

    for field in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(range) = json
            .get(field)
            .and_then(|d| d.get(ui_package))
            .and_then(|v| v.as_str())
        {
            return UiDep {
                declared: Some(range.to_string()),
                resolved: clean_version(range),
                field: Some(field.to_string()),
            };
        }
    }

    UiDep::default()
}

/// Reads a package's own `version`, used to find the published UI version from
/// `ui/blazeup-lib-ui` itself.
pub async fn read_own_version(repo: &Path) -> Option<String> {
    let text = tokio::fs::read_to_string(repo.join("package.json")).await.ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    json.get("version")?.as_str().map(|s| s.to_string())
}

/// `"^1.22.6"` -> `Some("1.22.6")`; `"workspace:*"` -> `None`.
pub fn clean_version(range: &str) -> Option<String> {
    let t = range.trim().trim_start_matches(['^', '~', '=', '>', '<', 'v', ' ']);
    let head: String = t
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    semver::Version::parse(&head).ok().map(|v| v.to_string())
}

/// The newest version seen anywhere, so drift can be flagged relative to it.
pub fn max_version(candidates: impl IntoIterator<Item = String>) -> Option<String> {
    candidates
        .into_iter()
        .filter_map(|s| semver::Version::parse(&s).ok())
        .max()
        .map(|v| v.to_string())
}

/// Derives the dev command from the lockfile.
///
/// Hardcoding `bun run dev` would be wrong for roughly half the workspace: fe/
/// alone has 23 bun.lock, 19 package-lock.json and 2 yarn.lock.
pub fn dev_command(repo: &Path) -> Option<(&'static str, Vec<String>)> {
    if repo.join("bun.lock").exists() || repo.join("bun.lockb").exists() {
        Some(("bun", vec!["run".into(), "dev".into()]))
    } else if repo.join("yarn.lock").exists() {
        Some(("yarn", vec!["dev".into()]))
    } else if repo.join("package-lock.json").exists() {
        Some(("npm", vec!["run".into(), "dev".into()]))
    } else if repo.join("package.json").exists() {
        // No lockfile yet — bun is the workspace default.
        Some(("bun", vec!["run".into(), "dev".into()]))
    } else {
        None
    }
}

/// The long-running tasks this repo declares. Order is the UI's display order.
pub fn available_tasks(repo: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(repo.join("package.json")) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(scripts) = json.get("scripts").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    ["dev", "storybook"]
        .into_iter()
        .filter(|t| scripts.contains_key(*t))
        .map(|t| t.to_string())
        .collect()
}

/// The package-manager invocation for a named task.
pub fn task_command(repo: &Path, task: &str) -> Option<(&'static str, Vec<String>)> {
    let (tool, _) = dev_command(repo)?;
    let args = match tool {
        // yarn takes the script name directly; bun and npm need `run`.
        "yarn" => vec![task.to_string()],
        _ => vec!["run".to_string(), task.to_string()],
    };
    Some((tool, args))
}

/// Storybook's port: an explicit `-p` in the script, else its 6006 default.
pub fn storybook_port(repo: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(repo.join("package.json")).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let script = json.get("scripts")?.get("storybook")?.as_str()?;
    Some(parse_storybook_port(script).unwrap_or(6006))
}

/// `"storybook dev -p 6007"` -> 6007.
pub fn parse_storybook_port(script: &str) -> Option<u16> {
    let mut it = script.split_whitespace().peekable();
    while let Some(tok) = it.next() {
        if tok == "-p" || tok == "--port" {
            return it.next()?.parse().ok();
        }
        if let Some(rest) = tok.strip_prefix("--port=") {
            return rest.parse().ok();
        }
    }
    None
}

/// The port a named task will bind.
pub fn task_port(repo: &Path, task: &str) -> Option<(u16, crate::model::PortSource)> {
    if task == "storybook" {
        return storybook_port(repo).map(|p| (p, crate::model::PortSource::ViteConfigDefault));
    }
    detect_port(repo)
}

pub fn has_dev_script(repo: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(repo.join("package.json")) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|j| j.get("scripts")?.get("dev").cloned())
        .is_some()
}

/// Resolves the dev-server port without starting anything.
///
/// `VITE_APP_PORT` in `.env` covers 40 of 44 repos here; the rest fall back to the
/// literal default baked into vite.config.ts, which differs per repo. A wrong
/// guess is corrected later by sniffing vite's own banner.
pub fn detect_port(repo: &Path) -> Option<(u16, crate::model::PortSource)> {
    use crate::model::PortSource;

    for env_file in [".env", ".env.local", ".env.development"] {
        if let Ok(text) = std::fs::read_to_string(repo.join(env_file)) {
            if let Some(p) = parse_env_port(&text) {
                return Some((p, PortSource::Env));
            }
        }
    }

    for cfg in ["vite.config.ts", "vite.config.js", "vite.config.mts"] {
        if let Ok(text) = std::fs::read_to_string(repo.join(cfg)) {
            if let Some(p) = parse_vite_default_port(&text) {
                return Some((p, PortSource::ViteConfigDefault));
            }
        }
    }

    None
}

pub fn parse_env_port(text: &str) -> Option<u16> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        for key in ["VITE_APP_PORT", "PORT", "VITE_PORT"] {
            if let Some(rest) = line.strip_prefix(key) {
                let Some(after_eq) = rest.trim_start().strip_prefix('=') else {
                    continue;
                };
                let v = after_eq.trim().trim_matches(['"', '\'']);
                if let Ok(p) = v.parse::<u16>() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Matches the workspace convention:
/// `const port = env.VITE_APP_PORT ? Number(env.VITE_APP_PORT) : 8000`
pub fn parse_vite_default_port(text: &str) -> Option<u16> {
    for line in text.lines() {
        if line.contains("VITE_APP_PORT") {
            if let Some(idx) = line.rfind(':') {
                let tail = &line[idx + 1..];
                let digits: String = tail
                    .trim()
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(p) = digits.parse::<u16>() {
                    return Some(p);
                }
            }
        }
        if let Some(idx) = line.find("port:") {
            let tail = &line[idx + 5..];
            let digits: String = tail
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(p) = digits.parse::<u16>() {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_ranges() {
        assert_eq!(clean_version("^1.22.6").as_deref(), Some("1.22.6"));
        assert_eq!(clean_version("~1.15.2").as_deref(), Some("1.15.2"));
        assert_eq!(clean_version("1.24.1").as_deref(), Some("1.24.1"));
        assert_eq!(clean_version(">=2.0.0").as_deref(), Some("2.0.0"));
        // Unparseable ranges must not crash or invent a version.
        assert_eq!(clean_version("workspace:*"), None);
        assert_eq!(clean_version("*"), None);
        assert_eq!(clean_version("git+ssh://x/y.git"), None);
    }

    #[test]
    fn picks_max_version() {
        let v = max_version(vec!["1.15.2".into(), "1.24.1".into(), "1.22.6".into()]);
        assert_eq!(v.as_deref(), Some("1.24.1"));
        // 1.9 vs 1.10 must compare numerically, not lexically.
        let v2 = max_version(vec!["1.9.0".into(), "1.10.0".into()]);
        assert_eq!(v2.as_deref(), Some("1.10.0"));
    }

    #[test]
    fn parses_env_port() {
        assert_eq!(parse_env_port("VITE_APP_PORT=5015\n"), Some(5015));
        assert_eq!(parse_env_port("# VITE_APP_PORT=1\nVITE_APP_PORT=3000"), Some(3000));
        assert_eq!(parse_env_port("OTHER=1\n"), None);
    }

    #[test]
    fn parses_storybook_port_flag() {
        assert_eq!(parse_storybook_port("storybook dev -p 6007"), Some(6007));
        assert_eq!(parse_storybook_port("storybook dev --port 7000"), Some(7000));
        assert_eq!(parse_storybook_port("storybook dev --port=7001"), Some(7001));
        // No flag => caller applies the 6006 default.
        assert_eq!(parse_storybook_port("storybook dev"), None);
    }

    #[test]
    fn parses_vite_default() {
        let src = "const port = env.VITE_APP_PORT ? Number(env.VITE_APP_PORT) : 8000";
        assert_eq!(parse_vite_default_port(src), Some(8000));
        assert_eq!(parse_vite_default_port("  server: { port: 5015 }"), Some(5015));
    }
}
