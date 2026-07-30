//! How to run a repo, decided from what the repo contains.
//!
//! The old answer was "`<package manager> run dev`, always". That is wrong for
//! most of a mixed workspace: a repo whose long-running script is `start`, a Rust
//! service, a Django app and a compose stack each have a different answer, and
//! naming a script the repo does not declare failed with an error about `dev` that
//! said nothing about what the repo actually was.
//!
//! Detection is file-existence checks plus the manifests a scan already reads, so
//! it costs nothing per repo — the same budget `detect::detect` works to.
//!
//! Each entry is a closed recipe built here. A caller supplies only `RunTask.id`,
//! which is looked up rather than turned into argv, so `DevStart` keeps exactly the
//! gate it had when the set was "scripts in package.json".

use crate::error::AppError;
use crate::model::{PortSource, RunnableTask};
use crate::toolchain::Toolchain;
use std::path::Path;

/// How a task's argv gets built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunVia {
    /// A named script in package.json, through the repo's own package manager.
    /// `pkg::task_command` owns the yarn-takes-no-`run` quirk.
    Script(String),
    /// A package-manager subcommand that is not a script — `bun tauri dev`.
    PmArgs(Vec<String>),
    /// A standalone program, candidates in preference order so `python3` can fall
    /// back to `python` without becoming a second task.
    Program(&'static [&'static str], Vec<String>),
    /// The package manager's binary runner — `npm exec -- x`, `bun x x`. Separate
    /// from `PmArgs` because the spelling differs per manager, and `npm react-native
    /// doctor` is not a command.
    PmExec(Vec<String>),
    /// A repo-local executable: `./gradlew`, `bin/rails`. Not resolved through the
    /// toolchain — the point of a wrapper script is that it is the project's own.
    Local(String, Vec<String>),
    /// Compose, under whichever container runtime is installed.
    Compose(String),
    /// Compose with an explicit argument list, for the one-shot subcommands.
    ComposeArgs(Vec<String>),
}

/// One way to run a repo, long-running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunTask {
    /// Stable id, and the task half of every `repo#task` key — so it is what port
    /// and command overrides are stored against, and it must not drift.
    pub id: String,
    /// What a button says after "Start" / "Stop".
    pub label: String,
    pub via: RunVia,
    /// Best guess, with where it came from — the tooltip shows the source, so a
    /// Django 8000 must not claim to have been read out of a vite config. The
    /// authoritative port still arrives by sniffing the server's own banner.
    pub port: Option<(u16, PortSource)>,
}

impl RunTask {
    pub fn info(&self) -> RunnableTask {
        RunnableTask {
            id: self.id.clone(),
            label: self.label.clone(),
            port: self.port.map(|(p, _)| p),
        }
    }
}

const PY: &[&str] = &["python3", "python"];

/// Every way this repo can be run, best first.
///
/// A script the repo declares always leads: `package.json` is the repo stating how
/// it is meant to start, and no amount of file sniffing outranks that. The
/// ecosystem runners below it are what make a repo *without* such a script
/// runnable at all. Storybook trails everything — it is a companion to whatever
/// else the repo runs, never the thing "run this repo" meant.
pub fn run_tasks(repo: &Path) -> Vec<RunTask> {
    let mut out = Vec::new();
    let scripts = crate::pkg::available_tasks(repo);
    // One resolution shared by every script task: they all bind the same port,
    // because they are all the same dev server started a different way.
    let script_port = crate::pkg::detect_port(repo);

    for name in ["dev", "start", "serve"] {
        if scripts.iter().any(|s| s == name) {
            out.push(RunTask {
                id: name.to_string(),
                label: name.to_string(),
                via: RunVia::Script(name.to_string()),
                port: script_port,
            });
        }
    }

    // Offered, but never ahead of the repo's own script — even though a Tauri
    // app's `dev` script usually starts the frontend alone. Which of the two you
    // want is a judgement about the repo, so it stays one click away rather than
    // being made here.
    if let Some(t) = tauri_task(repo, script_port) {
        out.push(t);
    }

    out.extend(flutter_task(repo));
    out.extend(python_tasks(repo));

    // A Tauri app's crate lives in src-tauri/, and `cargo run` there builds the
    // shell without the frontend the tauri task already starts for it.
    if !out.iter().any(|t| t.id == "tauri") {
        out.extend(cargo_task(repo));
    }
    out.extend(go_task(repo));
    out.extend(compose_task(repo));

    if scripts.iter().any(|s| s == "storybook") {
        out.push(RunTask {
            id: "storybook".to_string(),
            label: "Storybook".to_string(),
            via: RunVia::Script("storybook".to_string()),
            port: crate::pkg::storybook_port(repo).map(|p| (p, PortSource::TaskDefault)),
        });
    }

    out
}

pub fn find(repo: &Path, id: &str) -> Option<RunTask> {
    run_tasks(repo).into_iter().find(|t| t.id == id)
}

/// Resolves a task to an absolute-path argv.
///
/// Every program is resolved through the toolchain rather than left to PATH, for
/// the reason spelled out in `toolchain::probe`: a GUI-launched app inherits none
/// of the shell state that a version manager lives in.
pub fn argv(repo: &Path, task: &RunTask, tc: &Toolchain) -> Result<Vec<String>, AppError> {
    resolve(repo, &task.via, tc)
}

/// How each manager spells "run a binary from node_modules".
///
/// `npm` is the one that needs `exec --`; the others take the binary name directly.
/// Getting this wrong produces "Unknown command", which is why it is a table rather
/// than an assumption.
fn pm_exec_prefix(tool: &str) -> Vec<String> {
    match tool {
        "npm" => vec!["exec".to_string(), "--".to_string()],
        "bun" => vec!["x".to_string()],
        "pnpm" => vec!["exec".to_string()],
        // yarn runs a local binary by name.
        _ => Vec::new(),
    }
}

/// Turns any recipe into an absolute-path argv.
///
/// Shared by `runner`'s long-running tasks and `chores`' one-shot commands, so the
/// two can never disagree about how a package manager or a container runtime is
/// invoked.
pub fn resolve(repo: &Path, via: &RunVia, tc: &Toolchain) -> Result<Vec<String>, AppError> {
    match via {
        RunVia::Script(name) => {
            let fallback = tc.preferred_package_manager().unwrap_or("npm");
            let (tool, args) = crate::pkg::task_command(repo, name, fallback)
                .ok_or_else(|| AppError::Invalid("no package.json — nothing to run".into()))?;
            let bin = tc.require(&tool)?;
            let mut argv = vec![bin.display().to_string()];
            argv.extend(args);
            Ok(argv)
        }
        RunVia::PmExec(args) => {
            let fallback = tc.preferred_package_manager().unwrap_or("npm");
            let tool = crate::pkg::package_manager(repo, fallback)
                .ok_or_else(|| AppError::Invalid("no package.json — nothing to run".into()))?;
            let bin = tc.require(&tool)?;
            let mut argv = vec![bin.display().to_string()];
            argv.extend(pm_exec_prefix(&tool));
            argv.extend(args.clone());
            Ok(argv)
        }
        RunVia::Local(exe, args) => {
            // Resolved against the repo, and required to exist: a missing wrapper
            // should say so rather than surface as a bare ENOENT from the spawn.
            let path = repo.join(exe);
            if !path.exists() {
                return Err(AppError::Invalid(format!("{exe} is not in this repo")));
            }
            let mut argv = vec![path.display().to_string()];
            argv.extend(args.clone());
            Ok(argv)
        }
        RunVia::ComposeArgs(args) => {
            let runtime = tc
                .container_runtime()
                .ok_or_else(|| AppError::ToolMissing("docker".to_string()))?;
            let bin = tc.require(runtime.tool())?;
            let mut argv = vec![bin.display().to_string()];
            argv.extend(args.clone());
            Ok(argv)
        }
        RunVia::PmArgs(extra) => {
            let fallback = tc.preferred_package_manager().unwrap_or("npm");
            let tool = crate::pkg::package_manager(repo, fallback)
                .ok_or_else(|| AppError::Invalid("no package.json — nothing to run".into()))?;
            let bin = tc.require(&tool)?;
            let mut argv = vec![bin.display().to_string()];
            argv.extend(extra.clone());
            Ok(argv)
        }
        RunVia::Program(candidates, args) => {
            let bin = candidates
                .iter()
                .find_map(|c| tc.path(c))
                // Names the first candidate: "python3 was not found" is the
                // actionable half of "python3 or python was not found".
                .ok_or_else(|| AppError::ToolMissing(candidates[0].to_string()))?;
            let mut argv = vec![bin.display().to_string()];
            argv.extend(args.clone());
            Ok(argv)
        }
        RunVia::Compose(file) => {
            let runtime = tc
                .container_runtime()
                .ok_or_else(|| AppError::ToolMissing("docker".to_string()))?;
            let bin = tc.require(runtime.tool())?;
            Ok(vec![
                bin.display().to_string(),
                "compose".to_string(),
                "-f".to_string(),
                file.clone(),
                "up".to_string(),
            ])
        }
    }
}

/// `<pm> tauri dev`, when this really is a Tauri app.
///
/// Both halves are required. The config file alone can be a vendored example, and
/// without the CLI in the dependencies `<pm> tauri` is not a command at all.
fn tauri_task(repo: &Path, port: Option<(u16, PortSource)>) -> Option<RunTask> {
    let has_conf = ["src-tauri/tauri.conf.json", "tauri.conf.json"]
        .iter()
        .any(|c| repo.join(c).exists());
    if !has_conf {
        return None;
    }
    let manifest = crate::pkg::read_manifest(repo)?;
    if !manifest.deps.iter().any(|d| d == "@tauri-apps/cli") {
        return None;
    }
    Some(RunTask {
        id: "tauri".to_string(),
        label: "Tauri app".to_string(),
        via: RunVia::PmArgs(vec!["tauri".to_string(), "dev".to_string()]),
        // The window loads the frontend dev server, so its port is the useful one.
        port,
    })
}

/// `flutter run`, for a Flutter *app*.
///
/// A pubspec alone is not enough: a pure Dart package has one too, and `flutter
/// run` in it fails with "this project does not define an application". The entry
/// point or a platform directory is what distinguishes the two.
fn flutter_task(repo: &Path) -> Option<RunTask> {
    if !repo.join("pubspec.yaml").exists() {
        return None;
    }
    let runnable = repo.join("lib/main.dart").exists()
        || ["android", "ios", "web", "linux", "macos", "windows"]
            .iter()
            .any(|d| repo.join(d).is_dir());
    if !runnable {
        return None;
    }
    Some(RunTask {
        id: "flutter".to_string(),
        label: "flutter run".to_string(),
        via: RunVia::Program(&["flutter"], vec!["run".to_string()]),
        // The device is chosen interactively and the DevTools URL is printed at
        // startup, so there is no port to predict here.
        port: None,
    })
}

fn cargo_task(repo: &Path) -> Option<RunTask> {
    let manifest = std::fs::read_to_string(repo.join("Cargo.toml")).ok()?;
    // A library crate, or a bare workspace root, has nothing to run. `[[bin]]` or
    // src/main.rs is the whole test.
    if !repo.join("src/main.rs").exists() && !manifest.contains("[[bin]]") {
        return None;
    }
    Some(RunTask {
        id: "cargo".to_string(),
        label: "cargo run".to_string(),
        via: RunVia::Program(&["cargo"], vec!["run".to_string()]),
        // Nothing in Cargo.toml states a port, and inventing one would put a dead
        // link on the card. It is read from the output instead.
        port: None,
    })
}

fn go_task(repo: &Path) -> Option<RunTask> {
    if !repo.join("go.mod").exists() {
        return None;
    }
    // `go run` needs a package with a main function: the module root, or the
    // conventional cmd/<name> layout when the root is library code.
    let target = if has_main_package(repo) {
        ".".to_string()
    } else {
        go_cmd_target(repo)?
    };
    Some(RunTask {
        id: "go".to_string(),
        label: "go run".to_string(),
        via: RunVia::Program(&["go"], vec!["run".to_string(), target]),
        port: None,
    })
}

fn has_main_package(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("go") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if text
            .lines()
            .any(|l| l.trim_start().starts_with("package main"))
        {
            return true;
        }
    }
    false
}

/// `./cmd/<name>` for the first cmd subdirectory holding a main package.
fn go_cmd_target(repo: &Path) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(repo.join("cmd"))
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir() && has_main_package(&e.path()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    // Sorted, so which one is offered does not depend on readdir order.
    names.sort();
    names.into_iter().next().map(|n| format!("./cmd/{n}"))
}

fn python_tasks(repo: &Path) -> Vec<RunTask> {
    let mut out = Vec::new();

    // manage.py is unambiguous — it exists only in a Django project, and
    // `runserver` is that project's dev server. Nothing below improves on it.
    if repo.join("manage.py").exists() {
        out.push(RunTask {
            id: "django".to_string(),
            label: "runserver".to_string(),
            via: RunVia::Program(
                PY,
                vec!["manage.py".to_string(), "runserver".to_string()],
            ),
            port: Some((8000, PortSource::TaskDefault)),
        });
        return out;
    }

    let deps = python_deps(repo);

    // Both of these are offered only when the entry point can be *seen*. Guessing
    // `main:app` for a layout that does not have it yields a command that always
    // fails, which is worse than offering nothing and letting the repo's own
    // scripts or a terminal handle it.
    if deps.contains("uvicorn") || deps.contains("fastapi") {
        if let Some(module) = asgi_module(repo) {
            out.push(RunTask {
                id: "uvicorn".to_string(),
                label: "uvicorn".to_string(),
                via: RunVia::Program(
                    PY,
                    vec![
                        "-m".to_string(),
                        "uvicorn".to_string(),
                        format!("{module}:app"),
                        "--reload".to_string(),
                    ],
                ),
                port: Some((8000, PortSource::TaskDefault)),
            });
        }
    }

    if deps.contains("flask") {
        if let Some(file) = ["app.py", "wsgi.py", "main.py"]
            .into_iter()
            .find(|f| repo.join(f).exists())
        {
            out.push(RunTask {
                id: "flask".to_string(),
                label: "flask run".to_string(),
                via: RunVia::Program(
                    PY,
                    vec![
                        "-m".to_string(),
                        "flask".to_string(),
                        "--app".to_string(),
                        file.trim_end_matches(".py").to_string(),
                        "run".to_string(),
                    ],
                ),
                port: Some((5000, PortSource::TaskDefault)),
            });
        }
    }

    out
}

/// The Python dependency files as one lowercased haystack.
///
/// A substring test, not a parse: the question is only "does this project use
/// fastapi", and every dependency syntax these files allow still spells the name
/// literally.
fn python_deps(repo: &Path) -> String {
    let mut out = String::new();
    for file in ["requirements.txt", "pyproject.toml", "Pipfile"] {
        if let Ok(text) = std::fs::read_to_string(repo.join(file)) {
            out.push_str(&text.to_lowercase());
            out.push('\n');
        }
    }
    out
}

/// The dotted module path of the file that builds the ASGI app.
fn asgi_module(repo: &Path) -> Option<String> {
    for (file, module) in [
        ("main.py", "main"),
        ("app/main.py", "app.main"),
        ("src/main.py", "src.main"),
        ("app.py", "app"),
    ] {
        let Ok(text) = std::fs::read_to_string(repo.join(file)) else {
            continue;
        };
        // `app = FastAPI(...)` is the near-universal form, and it is also what
        // makes `<module>:app` the right target.
        if text.contains("FastAPI(") {
            return Some(module.to_string());
        }
    }
    None
}

fn compose_task(repo: &Path) -> Option<RunTask> {
    let file = [
        "compose.yml",
        "compose.yaml",
        "docker-compose.yml",
        "docker-compose.yaml",
    ]
    .into_iter()
    .find(|f| repo.join(f).exists())?;

    let port = std::fs::read_to_string(repo.join(file))
        .ok()
        .and_then(|t| first_published_port(&t))
        .map(|p| (p, PortSource::TaskDefault));

    Some(RunTask {
        id: "compose".to_string(),
        label: "compose up".to_string(),
        via: RunVia::Compose(file.to_string()),
        port,
    })
}

/// The host side of the first `ports:` entry.
///
/// A scoped line scan rather than a YAML parse: the only thing wanted is a number
/// to put in a URL, and it is corrected from the output anyway. Scoping to the
/// `ports:` block is what keeps a `volumes:` entry like `- ./data:/data` from
/// being read as a published port.
pub fn first_published_port(text: &str) -> Option<u16> {
    // Some(indent of the `ports:` key) while inside such a block.
    let mut inside: Option<usize> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();

        if trimmed == "ports:" {
            inside = Some(indent);
            continue;
        }
        let Some(key_indent) = inside else { continue };

        // Anything no deeper than the key itself has ended the block.
        if indent <= key_indent {
            inside = None;
            continue;
        }

        // Long form: `- target: 80` / `  published: 8080`.
        if let Some(rest) = trimmed.strip_prefix("published:") {
            if let Ok(p) = rest.trim().trim_matches(['"', '\'']).parse::<u16>() {
                return Some(p);
            }
            continue;
        }

        // Short form: `- "8080:80"`, `- 8080:80`, `- 127.0.0.1:8080:80`.
        let Some(rest) = trimmed.strip_prefix('-') else {
            continue;
        };
        let value = rest.trim().trim_matches(['"', '\'']);
        let parts: Vec<&str> = value.split(':').collect();
        if parts.len() < 2 {
            continue;
        }
        // The container port is last, so the host port is second to last.
        if let Ok(p) = parts[parts.len() - 2].parse::<u16>() {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("wa-runner-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(dir: &Path, name: &str, body: &str) {
        if let Some(parent) = Path::new(name).parent() {
            let _ = fs::create_dir_all(dir.join(parent));
        }
        fs::write(dir.join(name), body).unwrap();
    }

    fn ids(repo: &Path) -> Vec<String> {
        run_tasks(repo).into_iter().map(|t| t.id).collect()
    }

    /// What a bare "run this repo" resolves to — `run_tasks`' first entry, which is
    /// exactly what `DevStart` falls back to when no task is named.
    fn primary(repo: &Path) -> Option<RunTask> {
        run_tasks(repo).into_iter().next()
    }

    #[test]
    fn a_repo_whose_only_long_script_is_start_is_still_runnable() {
        // The whole point: this used to be "no dev script in package.json".
        let d = scratch("start-only");
        write(&d, "package.json", r#"{"scripts":{"start":"node ."}}"#);
        assert_eq!(ids(&d), vec!["start"]);
        assert_eq!(primary(&d).unwrap().id, "start");
    }

    #[test]
    fn dev_outranks_start_and_serve() {
        let d = scratch("rank");
        write(
            &d,
            "package.json",
            r#"{"scripts":{"serve":"x","start":"y","dev":"vite"}}"#,
        );
        assert_eq!(ids(&d), vec!["dev", "start", "serve"]);
    }

    #[test]
    fn storybook_is_never_the_primary_way_to_run_a_repo() {
        let d = scratch("sb");
        write(
            &d,
            "package.json",
            r#"{"scripts":{"storybook":"storybook dev -p 6007","dev":"vite"}}"#,
        );
        assert_eq!(ids(&d), vec!["dev", "storybook"]);
        // Still reachable, and still carrying its own port.
        let sb = find(&d, "storybook").unwrap();
        assert_eq!(sb.port, Some((6007, PortSource::TaskDefault)));
    }

    #[test]
    fn a_storybook_only_repo_falls_back_to_storybook() {
        let d = scratch("sb-only");
        write(&d, "package.json", r#"{"scripts":{"storybook":"storybook dev"}}"#);
        assert_eq!(primary(&d).unwrap().id, "storybook");
    }

    #[test]
    fn a_declared_script_stays_primary_even_for_a_tauri_app() {
        let d = scratch("tauri");
        write(&d, "src-tauri/tauri.conf.json", "{}");
        write(
            &d,
            "package.json",
            r#"{"scripts":{"dev":"vite"},"devDependencies":{"@tauri-apps/cli":"^2"}}"#,
        );
        // The repo said `dev`, so `dev` leads — but `<pm> tauri dev` is right there.
        assert_eq!(ids(&d), vec!["dev", "tauri"]);
        assert_eq!(
            find(&d, "tauri").unwrap().via,
            RunVia::PmArgs(vec!["tauri".into(), "dev".into()])
        );
    }

    #[test]
    fn a_tauri_app_with_no_dev_script_is_still_runnable() {
        // The fallback case the ecosystem runners exist for.
        let d = scratch("tauri-noscript");
        write(&d, "src-tauri/tauri.conf.json", "{}");
        write(&d, "package.json", r#"{"devDependencies":{"@tauri-apps/cli":"^2"}}"#);
        assert_eq!(primary(&d).unwrap().id, "tauri");
    }

    #[test]
    fn a_tauri_config_without_the_cli_dependency_is_not_a_tauri_app() {
        // A vendored example, or a template someone copied in. `<pm> tauri` would
        // not be a command.
        let d = scratch("tauri-noclie");
        write(&d, "src-tauri/tauri.conf.json", "{}");
        write(&d, "package.json", r#"{"scripts":{"dev":"vite"}}"#);
        assert_eq!(ids(&d), vec!["dev"]);
    }

    #[test]
    fn a_rust_binary_runs_with_cargo_and_a_library_does_not() {
        let d = scratch("cargo-bin");
        write(&d, "Cargo.toml", "[package]\nname='x'");
        write(&d, "src/main.rs", "fn main() {}");
        assert_eq!(ids(&d), vec!["cargo"]);

        let lib = scratch("cargo-lib");
        write(&lib, "Cargo.toml", "[package]\nname='x'");
        write(&lib, "src/lib.rs", "");
        // Nothing to run is a legitimate answer; it must not become `cargo run`.
        assert!(ids(&lib).is_empty());
    }

    #[test]
    fn an_explicit_bin_section_counts_without_src_main() {
        let d = scratch("cargo-bin-section");
        write(&d, "Cargo.toml", "[package]\nname='x'\n\n[[bin]]\nname='y'\npath='y.rs'");
        assert_eq!(ids(&d), vec!["cargo"]);
    }

    #[test]
    fn a_tauri_repo_does_not_also_offer_cargo_run() {
        let d = scratch("tauri-cargo");
        write(&d, "Cargo.toml", "[package]\nname='x'");
        write(&d, "src/main.rs", "fn main() {}");
        write(&d, "tauri.conf.json", "{}");
        write(&d, "package.json", r#"{"devDependencies":{"@tauri-apps/cli":"^2"}}"#);
        assert_eq!(ids(&d), vec!["tauri"]);
    }

    #[test]
    fn go_runs_the_root_package_when_it_has_a_main() {
        let d = scratch("go-root");
        write(&d, "go.mod", "module x");
        write(&d, "main.go", "package main\nfunc main() {}");
        assert_eq!(
            find(&d, "go").unwrap().via,
            RunVia::Program(&["go"], vec!["run".into(), ".".into()])
        );
    }

    #[test]
    fn go_falls_back_to_the_cmd_layout() {
        let d = scratch("go-cmd");
        write(&d, "go.mod", "module x");
        write(&d, "pkg/thing.go", "package pkg");
        write(&d, "cmd/api/main.go", "package main\nfunc main() {}");
        assert_eq!(
            find(&d, "go").unwrap().via,
            RunVia::Program(&["go"], vec!["run".into(), "./cmd/api".into()])
        );
    }

    #[test]
    fn a_go_library_with_no_main_anywhere_is_not_runnable() {
        let d = scratch("go-lib");
        write(&d, "go.mod", "module x");
        write(&d, "thing.go", "package x");
        assert!(ids(&d).is_empty());
    }

    #[test]
    fn a_flutter_app_runs_with_flutter_run() {
        let d = scratch("flutter");
        write(&d, "pubspec.yaml", "name: app\nflutter:\n  uses-material-design: true");
        write(&d, "lib/main.dart", "void main() {}");
        assert_eq!(ids(&d), vec!["flutter"]);
        assert_eq!(
            find(&d, "flutter").unwrap().via,
            RunVia::Program(&["flutter"], vec!["run".into()])
        );
    }

    #[test]
    fn a_platform_directory_is_enough_without_lib_main() {
        let d = scratch("flutter-plat");
        write(&d, "pubspec.yaml", "name: app");
        fs::create_dir_all(d.join("android")).unwrap();
        assert_eq!(primary(&d).unwrap().id, "flutter");
    }

    #[test]
    fn a_pure_dart_package_is_not_offered_flutter_run() {
        // `flutter run` here fails with "does not define an application", so
        // offering it would only ever produce that error.
        let d = scratch("dart-pkg");
        write(&d, "pubspec.yaml", "name: mylib");
        write(&d, "lib/mylib.dart", "class X {}");
        assert!(ids(&d).is_empty());
    }

    #[test]
    fn manage_py_means_django_runserver() {
        let d = scratch("django");
        write(&d, "manage.py", "#!/usr/bin/env python");
        write(&d, "requirements.txt", "Django==5.0\n");
        let t = find(&d, "django").unwrap();
        assert_eq!(t.port, Some((8000, PortSource::TaskDefault)));
        assert_eq!(
            t.via,
            RunVia::Program(PY, vec!["manage.py".into(), "runserver".into()])
        );
    }

    #[test]
    fn fastapi_is_offered_only_when_the_module_is_visible() {
        let d = scratch("fastapi");
        write(&d, "requirements.txt", "fastapi\nuvicorn\n");
        // No entry point yet: guessing `main:app` here would only ever fail.
        assert!(ids(&d).is_empty());

        write(&d, "app/main.py", "app = FastAPI(title='x')");
        assert_eq!(
            find(&d, "uvicorn").unwrap().via,
            RunVia::Program(
                PY,
                vec!["-m".into(), "uvicorn".into(), "app.main:app".into(), "--reload".into()]
            )
        );
    }

    #[test]
    fn flask_uses_the_app_file_it_finds() {
        let d = scratch("flask");
        write(&d, "requirements.txt", "Flask==3.0\n");
        write(&d, "wsgi.py", "app = Flask(__name__)");
        let t = find(&d, "flask").unwrap();
        assert_eq!(t.port, Some((5000, PortSource::TaskDefault)));
        assert_eq!(
            t.via,
            RunVia::Program(
                PY,
                vec!["-m".into(), "flask".into(), "--app".into(), "wsgi".into(), "run".into()]
            )
        );
    }

    #[test]
    fn compose_is_last_and_carries_its_first_published_port() {
        let d = scratch("compose");
        write(&d, "package.json", r#"{"scripts":{"dev":"vite"}}"#);
        write(
            &d,
            "compose.yml",
            "services:\n  web:\n    volumes:\n      - ./src:/app\n    ports:\n      - \"8080:80\"\n",
        );
        assert_eq!(ids(&d), vec!["dev", "compose"]);
        assert_eq!(find(&d, "compose").unwrap().port, Some((8080, PortSource::TaskDefault)));
    }

    #[test]
    fn a_volume_mapping_is_not_mistaken_for_a_port() {
        // The reason the scan is scoped to the ports: block at all.
        let yaml = "services:\n  db:\n    volumes:\n      - 5432:/var/lib\n";
        assert_eq!(first_published_port(yaml), None);
    }

    #[test]
    fn published_port_forms() {
        assert_eq!(first_published_port("ports:\n  - 3000:3000\n"), Some(3000));
        // An interface prefix leaves the host port second to last.
        assert_eq!(
            first_published_port("ports:\n  - \"127.0.0.1:8080:80\"\n"),
            Some(8080)
        );
        // Long form.
        assert_eq!(
            first_published_port("ports:\n  - target: 80\n    published: 9090\n"),
            Some(9090)
        );
        // A block that ends before any entry must not leak into the next key.
        assert_eq!(
            first_published_port("ports:\nenvironment:\n  - PGPORT=5432\n"),
            None
        );
    }

    #[test]
    fn an_empty_directory_runs_nothing_rather_than_defaulting_to_dev() {
        let d = scratch("empty");
        assert!(ids(&d).is_empty());
        assert_eq!(primary(&d), None);
    }

    #[test]
    fn one_repo_can_offer_several_ecosystems_at_once() {
        // A polyglot repo: the node dev server leads, but the stack and the Go
        // service it also holds stay reachable.
        let d = scratch("poly");
        write(&d, "package.json", r#"{"scripts":{"dev":"vite","serve":"x"}}"#);
        write(&d, "go.mod", "module x");
        write(&d, "main.go", "package main\nfunc main() {}");
        write(&d, "docker-compose.yml", "services: {}\n");
        assert_eq!(ids(&d), vec!["dev", "serve", "go", "compose"]);
    }
}
