use crate::model::TrackedDep;
use std::path::Path;

const DEP_FIELDS: [&str; 3] = ["dependencies", "devDependencies", "peerDependencies"];

/// What a repo's `package.json` says about itself and what it depends on.
pub struct Manifest {
    pub name: Option<String>,
    pub version: Option<String>,
    pub deps: Vec<String>,
    /// Raw `packageManager` field, e.g. `"pnpm@9.1.0"`.
    pub package_manager: Option<String>,
}

/// Reads a repo's manifest. Absent or malformed files are simply "no manifest".
pub fn read_manifest(repo: &Path) -> Option<Manifest> {
    let text = std::fs::read_to_string(repo.join("package.json")).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;

    let mut deps = Vec::new();
    for field in DEP_FIELDS {
        if let Some(obj) = json.get(field).and_then(|v| v.as_object()) {
            deps.extend(obj.keys().cloned());
        }
    }

    Some(Manifest {
        name: json.get("name").and_then(|v| v.as_str()).map(String::from),
        version: json.get("version").and_then(|v| v.as_str()).map(String::from),
        deps,
        package_manager: json
            .get("packageManager")
            .and_then(|v| v.as_str())
            .map(String::from),
    })
}

/// A shared package that lives in this workspace and that other repos consume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedPackage {
    pub name: String,
    /// The version the library repo itself declares, when it is cloned here.
    pub published: Option<String>,
    pub dependents: usize,
}

/// The workspace's own shared package, or None.
///
/// Chosen rather than configured: the package that lives in this workspace *and*
/// that the most other repos depend on is, by definition, the one whose version
/// drift matters. A hardcoded package name only ever describes one workspace.
///
/// Two dependents is the floor — a library nothing consumes yet is not a column
/// worth showing on 60 cards.
pub fn pick_tracked(manifests: &[Manifest]) -> Option<TrackedPackage> {
    let local: Vec<&Manifest> = manifests.iter().filter(|m| m.name.is_some()).collect();

    let mut best: Option<TrackedPackage> = None;
    for lib in &local {
        let name = lib.name.as_deref().unwrap();
        let dependents = manifests
            .iter()
            .filter(|m| m.name.as_deref() != Some(name))
            .filter(|m| m.deps.iter().any(|d| d == name))
            .count();
        if dependents < 2 {
            continue;
        }
        // Ties break on name so the choice is stable across scans.
        let better = match &best {
            Some(b) => (dependents, std::cmp::Reverse(name)) > (b.dependents, std::cmp::Reverse(b.name.as_str())),
            None => true,
        };
        if better {
            best = Some(TrackedPackage {
                name: name.to_string(),
                published: lib.version.clone(),
                dependents,
            });
        }
    }

    best
}

/// Reads the version of the tracked package that a repo declares.
///
/// Ranges that semver cannot parse (`workspace:*`, git URLs, `*`) keep `declared`
/// and leave `resolved` as None — the UI renders "n/a" rather than crashing or
/// inventing a version.
pub async fn read_tracked_dep(repo: &Path, tracked: Option<&str>) -> TrackedDep {
    let Some(tracked) = tracked else {
        return TrackedDep::default();
    };
    let Ok(text) = tokio::fs::read_to_string(repo.join("package.json")).await else {
        return TrackedDep::default();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return TrackedDep::default();
    };

    for field in DEP_FIELDS {
        if let Some(range) = json
            .get(field)
            .and_then(|d| d.get(tracked))
            .and_then(|v| v.as_str())
        {
            return TrackedDep {
                declared: Some(range.to_string()),
                resolved: clean_version(range),
                field: Some(field.to_string()),
            };
        }
    }

    TrackedDep::default()
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

/// Which package manager runs this repo's scripts.
///
/// Order of evidence: the standard `packageManager` field, then the lockfile, then
/// whatever the caller found installed. Hardcoding one manager is wrong even
/// inside a single workspace — mixed lockfiles across repos are normal.
pub fn package_manager(repo: &Path, fallback: &str) -> Option<String> {
    if !repo.join("package.json").exists() {
        return None;
    }

    // `"packageManager": "pnpm@9.1.0"` is the corepack standard and the most
    // explicit statement a repo can make.
    if let Some(m) = read_manifest(repo) {
        if let Some(declared) = declared_package_manager(&m) {
            return Some(declared);
        }
    }

    for (lockfile, tool) in [
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
    ] {
        if repo.join(lockfile).exists() {
            return Some(tool.to_string());
        }
    }

    Some(fallback.to_string())
}

fn declared_package_manager(m: &Manifest) -> Option<String> {
    // Stored on the Manifest only as raw text; parse "name@version".
    let raw = m.package_manager.as_deref()?;
    let name = raw.split('@').next()?.trim();
    matches!(name, "bun" | "npm" | "pnpm" | "yarn").then(|| name.to_string())
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
    // Long-running by convention. A curated list on purpose: offering every script
    // as a "task" would put `build` and `test` behind a Stop button.
    LONG_RUNNING
        .into_iter()
        .filter(|t| scripts.contains_key(*t))
        .map(|t| t.to_string())
        .collect()
}

/// Scripts that run, finish, and are worth a menu entry — `build`, `lint`,
/// `format` and friends.
///
/// The complement of `available_tasks`: anything long-running is excluded, since
/// those belong behind a Start/Stop pair rather than a fire-and-forget item. The
/// well-known names lead, in that order, because they are what people reach for;
/// whatever else the repo declares follows alphabetically.
pub fn available_scripts(repo: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(repo.join("package.json")) else {
        return Vec::new();
    };
    parse_available_scripts(&text)
}

/// The ordering and filtering half of `available_scripts`, split out so it can be
/// tested without a package.json on disk.
pub fn parse_available_scripts(text: &str) -> Vec<String> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(scripts) = json.get("scripts").and_then(|v| v.as_object()) else {
        return Vec::new();
    };

    let mut out: Vec<String> = COMMON_SCRIPTS
        .iter()
        .filter(|s| scripts.contains_key(**s))
        .map(|s| s.to_string())
        .collect();

    let mut rest: Vec<String> = scripts
        .keys()
        .filter(|k| !LONG_RUNNING.contains(&k.as_str()))
        .filter(|k| !COMMON_SCRIPTS.contains(&k.as_str()))
        // Lifecycle hooks fire on their own; running one by hand is never the
        // intent, and `prepare` in particular re-runs an install.
        .filter(|k| !k.starts_with("pre") && !k.starts_with("post") && *k != "prepare")
        .cloned()
        .collect();
    rest.sort();
    out.append(&mut rest);
    out
}

/// Scripts offered as long-running tasks instead, by `available_tasks`.
const LONG_RUNNING: [&str; 4] = ["dev", "start", "serve", "storybook"];

/// Display order for the scripts people actually reach for.
const COMMON_SCRIPTS: [&str; 8] = [
    "build",
    "lint",
    "lint:fix",
    "format",
    "format:check",
    "typecheck",
    "test",
    "check",
];

/// The package-manager invocation for a named task.
pub fn task_command(repo: &Path, task: &str, fallback: &str) -> Option<(String, Vec<String>)> {
    let tool = package_manager(repo, fallback)?;
    let args = match tool.as_str() {
        // yarn takes the script name directly; the others need `run`.
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
/// An env file is the most common place a project pins its port; failing that, the
/// literal default in the vite config. Either can be wrong, so a guess is always
/// corrected later by sniffing the dev server's own startup banner.
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

/// Handles both the plain `server: { port: N }` form and the common
/// `const port = env.VITE_APP_PORT ? Number(env.VITE_APP_PORT) : 8000` idiom,
/// where the literal after the colon is the fallback.
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
    fn lists_one_shot_scripts_in_display_order() {
        let json = r#"{"scripts":{
            "zip":"x","dev":"vite","build":"tsc","postbuild":"x","lint":"eslint .",
            "storybook":"sb","prepare":"husky","format":"prettier -w .","apidocs":"x"
        }}"#;
        assert_eq!(
            parse_available_scripts(json),
            // Well-known names first in their own order, then the rest alphabetically.
            vec!["build", "lint", "format", "apidocs", "zip"]
        );
    }

    #[test]
    fn no_scripts_is_empty_not_a_panic() {
        assert!(parse_available_scripts("{}").is_empty());
        assert!(parse_available_scripts("not json").is_empty());
        // Only long-running ones: those are offered as tasks instead.
        assert!(parse_available_scripts(r#"{"scripts":{"dev":"vite","start":"node ."}}"#).is_empty());
    }

    #[test]
    fn picks_max_version() {
        let v = max_version(vec!["1.15.2".into(), "1.24.1".into(), "1.22.6".into()]);
        assert_eq!(v.as_deref(), Some("1.24.1"));
        // 1.9 vs 1.10 must compare numerically, not lexically.
        let v2 = max_version(vec!["1.9.0".into(), "1.10.0".into()]);
        assert_eq!(v2.as_deref(), Some("1.10.0"));
    }

    fn manifest(name: Option<&str>, version: Option<&str>, deps: &[&str]) -> Manifest {
        Manifest {
            name: name.map(String::from),
            version: version.map(String::from),
            deps: deps.iter().map(|s| s.to_string()).collect(),
            package_manager: None,
        }
    }

    #[test]
    fn tracks_the_local_package_with_the_most_dependents() {
        let ms = vec![
            manifest(Some("@acme/ui"), Some("2.1.0"), &[]),
            manifest(Some("@acme/utils"), Some("1.0.0"), &[]),
            manifest(Some("app-a"), None, &["@acme/ui", "react"]),
            manifest(Some("app-b"), None, &["@acme/ui"]),
            manifest(Some("app-c"), None, &["@acme/utils", "@acme/ui"]),
        ];
        let t = pick_tracked(&ms).expect("a shared package exists");
        assert_eq!(t.name, "@acme/ui");
        assert_eq!(t.dependents, 3);
        // The library repo's own version is the drift baseline.
        assert_eq!(t.published.as_deref(), Some("2.1.0"));
    }

    #[test]
    fn a_library_nobody_consumes_is_not_tracked() {
        let ms = vec![
            manifest(Some("@acme/ui"), Some("1.0.0"), &[]),
            manifest(Some("app-a"), None, &["@acme/ui"]),
        ];
        // One dependent is not a workspace-wide concern worth a column.
        assert_eq!(pick_tracked(&ms), None);
    }

    #[test]
    fn a_workspace_with_no_shared_package_tracks_nothing() {
        let ms = vec![
            manifest(Some("app-a"), None, &["react"]),
            manifest(Some("app-b"), None, &["react"]),
            manifest(None, None, &[]),
        ];
        assert_eq!(pick_tracked(&ms), None);
        // External deps must never be mistaken for a local library.
        assert!(pick_tracked(&ms).is_none());
    }

    #[test]
    fn package_manager_prefers_the_declared_field_over_the_lockfile() {
        let d = std::env::temp_dir().join(format!("wa-pm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("package.json"), r#"{"packageManager":"pnpm@9.1.0"}"#).unwrap();
        std::fs::write(d.join("package-lock.json"), "{}").unwrap();
        assert_eq!(package_manager(&d, "npm").as_deref(), Some("pnpm"));

        // Without the field, the lockfile decides.
        std::fs::write(d.join("package.json"), "{}").unwrap();
        assert_eq!(package_manager(&d, "bun").as_deref(), Some("npm"));

        // With neither, the caller's installed manager decides — not a constant.
        std::fs::remove_file(d.join("package-lock.json")).unwrap();
        assert_eq!(package_manager(&d, "bun").as_deref(), Some("bun"));
        assert_eq!(package_manager(&d, "yarn").as_deref(), Some("yarn"));
    }

    #[test]
    fn a_repo_without_a_manifest_has_no_package_manager() {
        let d = std::env::temp_dir().join(format!("wa-pm-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(package_manager(&d, "npm"), None);
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
