//! One repo's dependencies: what it declares, what is installed, what is newer.
//!
//! Distinct from `packages`, which is about the tools on this machine. Everything
//! here is scoped to a repo directory and reads that repo's `package.json`,
//! `node_modules` and package manager. It borrows `packages`' hardened child-process
//! helpers rather than growing a second copy of them.
//!
//! The invariant that shapes the whole module: *not knowing* is a third answer.
//! A registry that timed out, a manager with no `outdated` command, a Yarn PnP repo
//! with nothing on disk to inspect — none of those may be reported as "up to date".
//! They come back as `checked: false` with a reason.

use crate::model::{DepUpdate, DepUpdateReport, PackageVersion, RepoDep, RepoPackages};
use crate::packages::{capture, parse_npm_versions, shape_versions};
use crate::pkg::{self, DepField};
use crate::toolchain::Toolchain;
use std::path::Path;
use std::time::Duration;

/// A registry query for one package. Matches `packages::npm_versions`.
const VERSIONS_TIMEOUT: Duration = Duration::from_secs(20);
/// An outdated check for a whole repo. Longer than the global-package check: 80
/// dependencies against a cold registry is a different amount of work.
const OUTDATED_TIMEOUT: Duration = Duration::from_secs(60);

// --- the local half ---------------------------------------------------------

/// The repo's dependency table. Manifest plus `node_modules`; no network.
pub async fn list(repo: &Path, tc: &Toolchain) -> RepoPackages {
    // Ecosystems are checked in the order a repo that has both would want: a Flutter
    // app with a package.json for its tooling is a Flutter app, and its dependency
    // table is pubspec.yaml. npm is the fallback, not the assumption.
    if crate::pubdeps::is_pub_repo(repo) {
        return crate::pubdeps::list(repo);
    }
    if !repo.join("package.json").exists() {
        return RepoPackages::default();
    }
    let declared = pkg::declared_deps(repo);

    let installed_tree = repo.join("node_modules").is_dir();
    let mut deps = Vec::with_capacity(declared.len());
    for (name, field, range) in declared {
        let installed = if installed_tree {
            installed_version(repo, &name).await
        } else {
            None
        };
        deps.push(RepoDep {
            linked: is_linked(&range),
            name,
            field,
            range,
            installed,
        });
    }

    RepoPackages {
        has_manifest: true,
        manifest: Some("package.json".into()),
        manager: pkg::package_manager(repo, tc.preferred_package_manager().unwrap_or("npm")),
        installed_tree,
        deps,
    }
}

/// The version actually on disk, from `node_modules/<name>/package.json`.
///
/// Read here rather than taken from a manager's `outdated` output, which is not
/// usable for this: npm prints `MISSING` for uninstalled packages and yarn v1 omits
/// current rows from its table entirely. A scoped name is a real nested directory,
/// and pnpm's symlinks into `.pnpm/` are followed by the OS.
pub async fn installed_version(repo: &Path, name: &str) -> Option<String> {
    let mut path = repo.join("node_modules");
    // Split so `@scope/pkg` becomes two path components on every platform.
    for part in name.split('/') {
        path.push(part);
    }
    let text = tokio::fs::read_to_string(path.join("package.json")).await.ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Ranges that name a location rather than a registry version.
///
/// These are edited in package.json, not installed over: running `npm install
/// pkg@latest` on a `workspace:*` dependency would quietly replace a local link
/// with a published copy.
pub fn is_linked(range: &str) -> bool {
    let r = range.trim();
    const PROTOCOLS: [&str; 9] = [
        "workspace:",
        "file:",
        "link:",
        "portal:",
        "git:",
        "git+",
        "github:",
        "http:",
        "https:",
    ];
    PROTOCOLS.iter().any(|p| r.starts_with(p))
        // `user/repo` and `user/repo#branch` are GitHub shorthand. A registry range
        // never contains a slash outside a leading scope.
        || r.trim_start_matches('@').contains('/')
}

/// A version the caller may install: strict semver, or nothing.
///
/// Every value the UI offers comes from `shape_versions`, so this is a floor, not a
/// filter. It exists so that a hand-built request cannot smuggle `--force` or a
/// shell-ish string into the position after `pkg@`, even though argv never reaches
/// a shell.
pub fn clean_target_version(v: &str) -> Option<String> {
    semver::Version::parse(v.trim()).ok().map(|v| v.to_string())
}

// --- argv -------------------------------------------------------------------

/// The install command for one dependency, minus the binary itself.
///
/// Pure and table-driven so every manager/field pair is covered by a test rather
/// than by whichever repo someone happened to try it in.
pub fn add_argv(
    tool: &str,
    repo: &Path,
    package: &str,
    version: Option<&str>,
    field: DepField,
) -> Vec<String> {
    let spec = format!("{package}@{}", version.unwrap_or("latest"));
    let mut argv: Vec<String> = Vec::new();

    match tool {
        "npm" => {
            argv.push("install".into());
            argv.push(spec);
            // Explicit even for prod: the confirm dialog shows this argv, and
            // "--save-prod" states what the default silently does.
            argv.push(
                match field {
                    DepField::Dependencies => "--save-prod",
                    DepField::DevDependencies => "--save-dev",
                    DepField::PeerDependencies => "--save-peer",
                }
                .into(),
            );
        }
        "pnpm" => {
            argv.push("add".into());
            argv.push(spec);
            argv.push(
                match field {
                    DepField::Dependencies => "--save-prod",
                    DepField::DevDependencies => "--save-dev",
                    DepField::PeerDependencies => "--save-peer",
                }
                .into(),
            );
            // pnpm refuses to add at the root of a workspace without this.
            if repo.join("pnpm-workspace.yaml").exists() {
                argv.push("-w".into());
            }
        }
        "yarn" => {
            argv.push("add".into());
            argv.push(spec);
            // Berry spells the same two flags differently, and rejects the long
            // forms outright.
            let berry = yarn_major(repo) >= 2;
            match (field, berry) {
                (DepField::Dependencies, _) => {}
                (DepField::DevDependencies, false) => argv.push("--dev".into()),
                (DepField::DevDependencies, true) => argv.push("-D".into()),
                (DepField::PeerDependencies, false) => argv.push("--peer".into()),
                (DepField::PeerDependencies, true) => argv.push("-P".into()),
            }
        }
        // bun, and anything else that follows npm's surface.
        _ => {
            argv.push("add".into());
            argv.push(spec);
            match field {
                DepField::Dependencies => {}
                DepField::DevDependencies => argv.push("--dev".into()),
                DepField::PeerDependencies => argv.push("--peer".into()),
            }
        }
    }

    argv
}

/// Yarn's major version, sniffed from the lockfile header and `.yarnrc.yml`.
///
/// Offline on purpose: this is asked once per panel open and once per upgrade, and
/// `yarn --version` is a Node startup each time.
pub fn yarn_major(repo: &Path) -> u32 {
    if let Ok(text) = std::fs::read_to_string(repo.join("yarn.lock")) {
        return parse_yarn_lock_major(&text);
    }
    // A berry repo with no lockfile yet still declares itself here.
    if repo.join(".yarnrc.yml").exists() {
        return 2;
    }
    1
}

/// v1 writes `# yarn lockfile v1`; berry writes a YAML `__metadata:` block.
pub fn parse_yarn_lock_major(text: &str) -> u32 {
    for line in text.lines().take(8) {
        let line = line.trim();
        if line.starts_with("# yarn lockfile v1") {
            return 1;
        }
        if line.starts_with("__metadata:") {
            return 2;
        }
    }
    1
}

// --- the network half -------------------------------------------------------

/// What this repo's manager says is out of date.
pub async fn check_updates(repo: &Path, tc: &Toolchain) -> DepUpdateReport {
    if crate::pubdeps::is_pub_repo(repo) {
        return crate::pubdeps::check_updates(repo, tc).await;
    }
    if !repo.join("package.json").exists() {
        return DepUpdateReport {
            reason: Some("This repo has no package.json.".into()),
            ..Default::default()
        };
    }

    let manager = pkg::package_manager(repo, tc.preferred_package_manager().unwrap_or("npm"))
        .unwrap_or_else(|| "npm".to_string());

    // npm and pnpm answer for themselves. yarn v1 has its own format. Berry and bun
    // are answered *through* npm: berry's `npm outdated` equivalent does not exist,
    // and `bun outdated`'s table has changed shape across releases — npm reads the
    // same package.json and node_modules and gives a stable answer for both.
    let native = match manager.as_str() {
        "npm" => npm_outdated(repo, tc, "npm").await,
        "pnpm" => pnpm_outdated(repo, tc).await,
        "yarn" if yarn_major(repo) < 2 => yarn_v1_outdated(repo, tc).await,
        _ => None,
    };
    if let Some(report) = native {
        return report;
    }

    // The fallback only works against a real node_modules tree. Under Yarn PnP
    // there is nothing on disk for npm to compare against, and it would report
    // every dependency as missing.
    if !repo.join("node_modules").is_dir() {
        return DepUpdateReport {
            reason: Some(format!(
                "Nothing is installed, so {manager} cannot say what is out of date. Install first."
            )),
            ..Default::default()
        };
    }
    if let Some(report) = npm_outdated(repo, tc, "npm").await {
        return report;
    }

    DepUpdateReport {
        reason: Some(format!(
            "Could not ask {manager} for outdated packages — no npm on PATH, or the registry did not answer."
        )),
        ..Default::default()
    }
}

async fn npm_outdated(repo: &Path, tc: &Toolchain, source: &str) -> Option<DepUpdateReport> {
    let npm = tc.path("npm")?;
    // npm exits 1 when anything is outdated, which is the normal case here.
    let (out, code) = capture_status_in(
        npm,
        &["outdated", "--json", "--long"],
        repo,
        &tc.path_env,
        OUTDATED_TIMEOUT,
    )
    .await;
    if !matches!(code, Some(0) | Some(1)) {
        return None;
    }
    let updates = parse_outdated_json(&out)?;
    Some(DepUpdateReport {
        checked: true,
        source: source.to_string(),
        updates,
        reason: None,
    })
}

async fn pnpm_outdated(repo: &Path, tc: &Toolchain) -> Option<DepUpdateReport> {
    let pnpm = tc.path("pnpm")?;
    let (out, code) = capture_status_in(
        pnpm,
        &["outdated", "--format", "json"],
        repo,
        &tc.path_env,
        OUTDATED_TIMEOUT,
    )
    .await;
    if !matches!(code, Some(0) | Some(1)) {
        return None;
    }
    let updates = parse_outdated_json(&out)?;
    Some(DepUpdateReport {
        checked: true,
        source: "pnpm".into(),
        updates,
        reason: None,
    })
}

async fn yarn_v1_outdated(repo: &Path, tc: &Toolchain) -> Option<DepUpdateReport> {
    let yarn = tc.path("yarn")?;
    let (out, code) = capture_status_in(
        yarn,
        &["outdated", "--json"],
        repo,
        &tc.path_env,
        OUTDATED_TIMEOUT,
    )
    .await;
    if !matches!(code, Some(0) | Some(1)) {
        return None;
    }
    let updates = parse_yarn_v1_outdated(&out)?;
    Some(DepUpdateReport {
        checked: true,
        source: "yarn".into(),
        updates,
        reason: None,
    })
}

/// npm's and pnpm's shared shape: `{"react":{"current":…,"wanted":…,"latest":…}}`,
/// and `{}` when everything is current.
///
/// None means the tool did not answer — the caller must not turn that into an empty
/// "all current" list. Unlike `packages::parse_npm_outdated`, a row with no
/// `current` is kept: for a repo, "declared, not installed, and behind" is a row
/// worth showing.
pub fn parse_outdated_json(json: &str) -> Option<Vec<DepUpdate>> {
    let text = json.trim();
    // pnpm prints nothing at all when a workspace has no outdated packages.
    if text.is_empty() {
        return Some(Vec::new());
    }
    let obj = serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .as_object()?
        .clone();

    Some(
        obj.into_iter()
            .filter_map(|(name, v)| {
                // pnpm nests the same fields; npm --long adds others we ignore.
                let latest = str_field(&v, "latest");
                let wanted = str_field(&v, "wanted");
                let current = str_field(&v, "current");
                // A package already at latest is not an upgrade. Managers do report
                // these when the declared range pins an older one.
                if let (Some(c), Some(l)) = (&current, &latest) {
                    if c == l {
                        return None;
                    }
                }
                (latest.is_some() || wanted.is_some()).then_some(DepUpdate {
                    name,
                    latest,
                    wanted,
                })
            })
            .collect(),
    )
}

/// pnpm reports `"latest": {"version": "2.0.0"}` in some releases and a bare string
/// in others; both mean the same thing.
fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    let f = v.get(key)?;
    f.as_str()
        .or_else(|| f.get("version").and_then(|s| s.as_str()))
        .map(String::from)
        .filter(|s| !s.is_empty() && s != "MISSING")
}

/// yarn v1 prints NDJSON; the row we want is the `table` message.
///
/// Columns are located by header name rather than position: the table gains and
/// loses columns between releases (`Package Type`, `URL`, `Workspace`), and reading
/// index 3 as "Latest" is exactly how that breaks silently.
pub fn parse_yarn_v1_outdated(text: &str) -> Option<Vec<DepUpdate>> {
    let mut table = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if msg.get("type").and_then(|t| t.as_str()) == Some("table") {
            table = msg.get("data").cloned();
        }
    }

    // No table at all is yarn's way of saying nothing is outdated — but only if it
    // printed *something*, otherwise it never ran.
    let Some(data) = table else {
        return text
            .lines()
            .any(|l| !l.trim().is_empty())
            .then(Vec::new);
    };

    let head: Vec<String> = data
        .get("head")?
        .as_array()?
        .iter()
        .filter_map(|h| h.as_str().map(str::to_lowercase))
        .collect();
    let col = |name: &str| head.iter().position(|h| h == name);
    let (pkg_i, latest_i, wanted_i) = (col("package")?, col("latest"), col("wanted"));

    let cell = |row: &Vec<serde_json::Value>, i: Option<usize>| {
        i.and_then(|i| row.get(i))
            .and_then(|c| c.as_str())
            .map(String::from)
            .filter(|s| !s.is_empty() && s != "exotic")
    };

    Some(
        data.get("body")?
            .as_array()?
            .iter()
            .filter_map(|row| {
                let row = row.as_array()?;
                let name = row.get(pkg_i)?.as_str()?.to_string();
                Some(DepUpdate {
                    name,
                    latest: cell(row, latest_i),
                    wanted: cell(row, wanted_i),
                })
            })
            .collect(),
    )
}

/// Published versions of one package, for the version menu.
///
/// A preference chain rather than a per-manager branch: the registry answer is the
/// same whoever asks, so the only question is which client is installed.
pub async fn versions(repo: &Path, tc: &Toolchain, package: &str) -> Vec<PackageVersion> {
    if let Some(npm) = tc.path("npm") {
        let out = capture(
            npm,
            &["view", package, "versions", "--json"],
            &tc.path_env,
            VERSIONS_TIMEOUT,
        )
        .await;
        let list = parse_npm_versions(&out);
        if !list.is_empty() {
            return list;
        }
    }

    if let Some(pnpm) = tc.path("pnpm") {
        // pnpm mirrors npm's output for `view`.
        let out = capture(
            pnpm,
            &["view", package, "versions", "--json"],
            &tc.path_env,
            VERSIONS_TIMEOUT,
        )
        .await;
        let list = parse_npm_versions(&out);
        if !list.is_empty() {
            return list;
        }
    }

    if let Some(yarn) = tc.path("yarn") {
        let berry = yarn_major(repo) >= 2;
        let args: Vec<&str> = if berry {
            vec!["npm", "info", package, "--fields", "versions", "--json"]
        } else {
            vec!["info", package, "versions", "--json"]
        };
        let out = capture_status_in(yarn, &args, repo, &tc.path_env, VERSIONS_TIMEOUT)
            .await
            .0;
        let list = parse_yarn_versions(&out);
        if !list.is_empty() {
            return list;
        }
    }

    Vec::new()
}

/// Both yarn spellings wrap the array in an object: berry's `yarn npm info` prints
/// `{"versions":[…]}`, v1's `yarn info` prints `{"type":"inspect","data":[…]}`.
pub fn parse_yarn_versions(text: &str) -> Vec<PackageVersion> {
    for line in text.lines() {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let array = msg
            .get("versions")
            .or_else(|| msg.get("data"))
            .and_then(|v| v.as_array());
        if let Some(array) = array {
            let list: Vec<String> = array
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            if !list.is_empty() {
                return shape_versions(list);
            }
        }
    }
    Vec::new()
}

/// `packages::capture_status`, run inside a repo.
///
/// Every command here is about one directory, and `npm outdated` in the wrong cwd
/// answers a different question rather than failing.
pub(crate) async fn capture_status_in(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    path_env: &str,
    timeout: Duration,
) -> (String, Option<i32>) {
    // The helper takes no cwd, so borrow the process's own for the call. Doing it
    // by chdir would race every other task in the runtime.
    let mut cmd = tokio::process::Command::new(program);
    crate::platform::hide_console(&mut cmd);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    if !path_env.is_empty() {
        cmd.env("PATH", path_env);
    }
    cmd.env("NO_COLOR", "1").env("CI", "1");

    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(out)) => (
            String::from_utf8_lossy(&out.stdout).into_owned(),
            out.status.code(),
        ),
        _ => (String::new(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_reports_nothing_when_everything_is_current() {
        assert_eq!(parse_outdated_json("{}"), Some(Vec::new()));
        // pnpm prints an empty body rather than an empty object.
        assert_eq!(parse_outdated_json("  \n"), Some(Vec::new()));
    }

    #[test]
    fn a_tool_that_did_not_answer_is_not_up_to_date() {
        // The trap this whole module is shaped around: None, never Some(vec![]).
        assert_eq!(parse_outdated_json("npm ERR! code E404"), None);
        assert_eq!(parse_outdated_json("[]"), None);
        assert_eq!(parse_yarn_v1_outdated(""), None);
    }

    #[test]
    fn parses_npm_outdated_rows() {
        let json = r#"{
            "react":{"current":"18.2.0","wanted":"18.3.1","latest":"19.1.0"},
            "zustand":{"current":"5.0.2","wanted":"5.0.2","latest":"5.0.2"},
            "vite":{"wanted":"5.4.0","latest":"7.0.0"}
        }"#;
        let mut got = parse_outdated_json(json).expect("answered");
        got.sort_by(|a, b| a.name.cmp(&b.name));

        // zustand is already at latest, so it is not an upgrade. vite has no
        // `current` — declared but not installed — and must still be listed.
        assert_eq!(
            got,
            vec![
                DepUpdate {
                    name: "react".into(),
                    latest: Some("19.1.0".into()),
                    wanted: Some("18.3.1".into())
                },
                DepUpdate {
                    name: "vite".into(),
                    latest: Some("7.0.0".into()),
                    wanted: Some("5.4.0".into())
                },
            ]
        );
    }

    #[test]
    fn parses_the_pnpm_object_form_and_ignores_missing() {
        let json = r#"{
            "react":{"current":"18.2.0","wanted":{"version":"18.3.1"},"latest":{"version":"19.1.0"}},
            "ghost":{"current":"MISSING","latest":"MISSING"}
        }"#;
        let got = parse_outdated_json(json).expect("answered");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].latest.as_deref(), Some("19.1.0"));
    }

    #[test]
    fn parses_yarn_v1_columns_by_name() {
        // Columns deliberately in a non-default order, with an extra one.
        let ndjson = r#"{"type":"info","data":"Colors legend"}
{"type":"table","data":{"head":["Package","Workspace","Latest","Current","Wanted","URL"],"body":[["react","app","19.1.0","18.2.0","18.3.1","https://react.dev"],["left-pad","app","exotic","1.0.0","exotic","x"]]}}"#;
        let got = parse_yarn_v1_outdated(ndjson).expect("answered");
        assert_eq!(got[0].name, "react");
        assert_eq!(got[0].latest.as_deref(), Some("19.1.0"));
        assert_eq!(got[0].wanted.as_deref(), Some("18.3.1"));
        // "exotic" is yarn's word for a non-registry range, not a version.
        assert_eq!(got[1].latest, None);
    }

    #[test]
    fn yarn_printing_no_table_means_nothing_is_outdated() {
        let ndjson = r#"{"type":"info","data":"No outdated packages."}"#;
        assert_eq!(parse_yarn_v1_outdated(ndjson), Some(Vec::new()));
    }

    #[test]
    fn spots_ranges_that_are_not_registry_installs() {
        for r in [
            "workspace:*",
            "file:../ui",
            "link:../ui",
            "portal:../ui",
            "git+ssh://git@github.com/a/b.git",
            "github:acme/ui",
            "https://example.com/a.tgz",
            "acme/ui#next",
        ] {
            assert!(is_linked(r), "{r} should be linked");
        }
        for r in ["^1.2.3", "~1.2.3", "1.2.3", ">=5", "*", "latest"] {
            assert!(!is_linked(r), "{r} should be installable");
        }
    }

    #[test]
    fn only_real_versions_reach_argv() {
        assert_eq!(clean_target_version("1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(clean_target_version(" 1.2.3 ").as_deref(), Some("1.2.3"));
        assert_eq!(clean_target_version("^1.2.3"), None);
        assert_eq!(clean_target_version("--force"), None);
        assert_eq!(clean_target_version("latest"), None);
    }

    #[test]
    fn reads_the_yarn_major_from_the_lockfile() {
        assert_eq!(parse_yarn_lock_major("# yarn lockfile v1\n\n"), 1);
        assert_eq!(
            parse_yarn_lock_major("# This file is generated\n\n__metadata:\n  version: 8\n"),
            2
        );
        // An unrecognised header is treated as v1, which is the conservative
        // choice: berry rejects the long flags loudly rather than silently.
        assert_eq!(parse_yarn_lock_major(""), 1);
    }

    fn argv(tool: &str, field: DepField) -> Vec<String> {
        add_argv(tool, Path::new("/nope"), "react", Some("19.1.0"), field)
    }

    #[test]
    fn builds_install_argv_per_manager_and_field() {
        assert_eq!(
            argv("npm", DepField::Dependencies),
            ["install", "react@19.1.0", "--save-prod"]
        );
        assert_eq!(
            argv("npm", DepField::DevDependencies),
            ["install", "react@19.1.0", "--save-dev"]
        );
        assert_eq!(
            argv("npm", DepField::PeerDependencies),
            ["install", "react@19.1.0", "--save-peer"]
        );
        assert_eq!(
            argv("pnpm", DepField::DevDependencies),
            ["add", "react@19.1.0", "--save-dev"]
        );
        assert_eq!(
            argv("bun", DepField::DevDependencies),
            ["add", "react@19.1.0", "--dev"]
        );
        assert_eq!(argv("bun", DepField::Dependencies), ["add", "react@19.1.0"]);
        // No version means latest, spelled explicitly so the preview says so.
        assert_eq!(
            add_argv(
                "npm",
                Path::new("/nope"),
                "react",
                None,
                DepField::Dependencies
            ),
            ["install", "react@latest", "--save-prod"]
        );
    }

    #[test]
    fn yarn_argv_follows_the_lockfile_major() {
        let d = std::env::temp_dir().join(format!("wa-yarn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();

        std::fs::write(d.join("yarn.lock"), "# yarn lockfile v1\n").unwrap();
        assert_eq!(
            add_argv("yarn", &d, "react", Some("19.1.0"), DepField::DevDependencies),
            ["add", "react@19.1.0", "--dev"]
        );

        std::fs::write(d.join("yarn.lock"), "__metadata:\n  version: 8\n").unwrap();
        assert_eq!(
            add_argv("yarn", &d, "react", Some("19.1.0"), DepField::DevDependencies),
            ["add", "react@19.1.0", "-D"]
        );
    }

    #[test]
    fn pnpm_adds_the_workspace_flag_only_at_a_workspace_root() {
        let d = std::env::temp_dir().join(format!("wa-pnpmws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(
            add_argv("pnpm", &d, "react", None, DepField::Dependencies),
            ["add", "react@latest", "--save-prod"]
        );

        std::fs::write(d.join("pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n").unwrap();
        assert_eq!(
            add_argv("pnpm", &d, "react", None, DepField::Dependencies),
            ["add", "react@latest", "--save-prod", "-w"]
        );
    }

    #[test]
    fn parses_both_yarn_version_listings() {
        let berry = r#"{"versions":["1.0.0","1.1.0","2.0.0"]}"#;
        let got = parse_yarn_versions(berry);
        assert_eq!(got[0].value, "2.0.0");
        assert_eq!(got[0].note.as_deref(), Some("latest"));

        let v1 = r#"{"type":"inspect","data":["1.0.0","1.1.0"]}"#;
        assert_eq!(parse_yarn_versions(v1)[0].value, "1.1.0");

        assert!(parse_yarn_versions("not json").is_empty());
    }
}
