//! The one-shot commands a repo's ecosystem offers.
//!
//! `pkg::available_scripts` already covers what a `package.json` declares. That is
//! the whole answer for a node repo and no answer at all for anything else: a
//! Flutter app's `pub get`, a Gradle module's `clean`, a crate's `clippy` and a
//! Django project's `migrate` are the commands you actually reach for, and none of
//! them is a script in a manifest we read.
//!
//! Every entry is a closed recipe built here, exactly like `runner`'s: a caller
//! supplies an id, which is looked up rather than turned into argv. Nothing on this
//! list is caller-composable, so "run a chore" can never widen into "run an
//! arbitrary command".
//!
//! What is deliberately absent: anything interactive (`django shell`,
//! `createsuperuser`), anything that touches the machine rather than the repo
//! (`docker system prune`), and anything long-running — those are `runner`'s
//! tasks, behind a Start/Stop pair.

use crate::model::ChoreInfo;
use crate::runner::RunVia;
use std::path::Path;

/// One command, ready to be looked up and spawned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chore {
    /// Stable and namespaced — "flutter.pub-get". Namespaced because two
    /// ecosystems in one repo can both offer a `clean`.
    pub id: String,
    /// What the menu item says: the command as you would type it.
    pub label: String,
    /// Submenu heading, so 40 commands stay navigable.
    pub group: String,
    pub via: RunVia,
    /// Runs in this subdirectory of the repo. A React Native `pod install` only
    /// works in `ios/`, and a Gradle task only in `android/`.
    pub cwd: Option<String>,
    /// Deletes build output or rewrites files in place, so the UI confirms first
    /// rather than doing it on a single click.
    pub destructive: bool,
}

impl Chore {
    pub fn info(&self) -> ChoreInfo {
        ChoreInfo {
            id: self.id.clone(),
            label: self.label.clone(),
            group: self.group.clone(),
            destructive: self.destructive,
        }
    }
}

// --- table helpers ----------------------------------------------------------
//
// The command tables below are the substance of this module, so these exist to
// keep them readable as tables rather than as pages of struct literals.

/// A command run by a program resolved from the toolchain.
fn cmd(group: &str, id: &str, bins: &'static [&'static str], args: &[&str]) -> Chore {
    Chore {
        id: format!("{}.{}", group.to_lowercase().replace(' ', "-"), id),
        // The label is the invocation, so the menu reads as the commands you know.
        label: format!("{} {}", bins[0], args.join(" ")),
        group: group.to_string(),
        via: RunVia::Program(bins, args.iter().map(|s| s.to_string()).collect()),
        cwd: None,
        destructive: false,
    }
}

/// A command run by a repo-local executable — `./gradlew`, `bin/rails`.
fn local_cmd(group: &str, id: &str, exe: &str, args: &[&str]) -> Chore {
    Chore {
        id: format!("{}.{}", group.to_lowercase().replace(' ', "-"), id),
        label: format!("{} {}", exe, args.join(" ")),
        group: group.to_string(),
        via: RunVia::Local(
            exe.to_string(),
            args.iter().map(|s| s.to_string()).collect(),
        ),
        cwd: None,
        destructive: false,
    }
}

/// A command run by the repo's own package manager — `<pm> install`.
fn pm_cmd(group: &str, id: &str, args: &[&str]) -> Chore {
    Chore {
        id: format!("{}.{}", group.to_lowercase().replace(' ', "-"), id),
        // No binary name: which manager it is depends on the repo, and the label is
        // built before that is resolved.
        label: args.join(" "),
        group: group.to_string(),
        via: RunVia::PmArgs(args.iter().map(|s| s.to_string()).collect()),
        cwd: None,
        destructive: false,
    }
}

/// A command run through the package manager's binary runner — `npm exec -- x`.
fn pm_exec(group: &str, id: &str, args: &[&str]) -> Chore {
    Chore {
        id: format!("{}.{}", group.to_lowercase().replace(' ', "-"), id),
        label: args.join(" "),
        group: group.to_string(),
        via: RunVia::PmExec(args.iter().map(|s| s.to_string()).collect()),
        cwd: None,
        destructive: false,
    }
}

impl Chore {
    fn destructive(mut self) -> Self {
        self.destructive = true;
        self
    }
    fn in_dir(mut self, dir: &str) -> Self {
        self.cwd = Some(dir.to_string());
        self
    }
}

const PY: &[&str] = &["python3", "python"];
const DART: &[&str] = &["dart"];
const FLUTTER: &[&str] = &["flutter"];

/// Every one-shot command this repo's ecosystems offer, grouped in table order.
///
/// A polyglot repo gets several groups, which is the point: a React Native app has
/// node scripts, a Gradle module and a CocoaPods project, and all three are things
/// you run from here.
/// Every group name this module can produce.
///
/// Only read by tests today — `ecosystems.rs` links against these names and both
/// sides are checked against this list — which is exactly what it is for. Kept out
/// of `cfg(test)` so the list sits beside the code that produces it rather than
/// beside the code that checks it.
#[allow(dead_code)]
///
/// Written out rather than derived, because it is a *contract*: `ecosystems.rs`
/// names these groups to say which stack owns which commands, and a rename here
/// would silently unlink them. The test below asserts the list is neither short nor
/// stale against what a polyglot repo actually offers.
pub const GROUPS: &[&str] = &[
    "Packages",
    "React Native",
    "Expo",
    "Dart",
    "Flutter",
    "Cargo",
    "Go",
    "Gradle",
    "Swift",
    "Xcode",
    "CocoaPods",
    "Python",
    "Django",
    "CMake",
    "Composer",
    "Artisan",
    "Bundler",
    "Rails",
    "Mix",
    "Maven",
    "dotnet",
    "Compose",
];

pub fn chores(repo: &Path) -> Vec<Chore> {
    let mut out = Vec::new();
    let file = |f: &str| repo.join(f).exists();

    if file("package.json") {
        out.extend(node_chores(repo));
    }
    if file("pubspec.yaml") {
        out.extend(dart_chores(repo));
    }
    if file("Cargo.toml") {
        out.extend(cargo_chores());
    }
    if file("go.mod") {
        out.extend(go_chores());
    }
    out.extend(gradle_chores(repo));
    out.extend(apple_chores(repo));
    out.extend(python_chores(repo));
    if file("CMakeLists.txt") {
        out.extend(cmake_chores());
    }
    if file("composer.json") {
        out.extend(php_chores(repo));
    }
    if file("Gemfile") {
        out.extend(ruby_chores(repo));
    }
    if file("mix.exs") {
        out.extend(elixir_chores());
    }
    if file("pom.xml") {
        out.extend(maven_chores());
    }
    if has_ext(repo, "csproj") || has_ext(repo, "sln") {
        out.extend(dotnet_chores());
    }
    if let Some(f) = compose_file(repo) {
        out.extend(compose_chores(&f));
    }
    out
}

pub fn find(repo: &Path, id: &str) -> Option<Chore> {
    chores(repo).into_iter().find(|c| c.id == id)
}

/// The chore that builds this repo's own artifact, if it has one.
///
/// A table rather than "any id ending in build", because the exceptions are the
/// substance: Elixir spells it `compile`, Maven's build is `package` (`install`
/// also publishes), Flutter's is per-platform, and `compose build` builds container
/// images — a different question from "build this repo". Order is preference, so a
/// repo with several ecosystems gets the one it is mostly written in.
///
/// Takes the list rather than a path: `chores()` stats a couple of dozen files, and
/// the scan already has the answer in hand.
pub fn pick_build(list: &[Chore]) -> Option<&Chore> {
    const ORDER: &[&str] = &[
        // Flutter first: a Flutter app has an android/ directory, so `gradle.build`
        // is present and would otherwise win — building the Android shell rather
        // than the app, which is not what Build means in a Flutter repo.
        "flutter.build-apk",
        "flutter.build-appbundle",
        "flutter.build-ios",
        "flutter.build-web",
        "flutter.build-linux",
        "cargo.build",
        "go.build",
        "gradle.build",
        "dotnet.build",
        "maven.package",
        "swift.build",
        "xcode.build",
        "cmake.build",
        "mix.compile",
        // Last on purpose: images, not this repo's artifact.
        "compose.build",
    ];
    ORDER
        .iter()
        .find_map(|id| list.iter().find(|c| c.id == *id))
}

// --- node -------------------------------------------------------------------

/// Manager-level commands only. The repo's *scripts* are already offered by
/// `pkg::available_scripts`, and duplicating them here would double every menu.
fn node_chores(repo: &Path) -> Vec<Chore> {
    let mut out = vec![
        pm_cmd("Packages", "install", &["install"]),
        pm_cmd("Packages", "outdated", &["outdated"]),
    ];

    // React Native's own diagnostics. Its native builds live under Gradle and
    // CocoaPods, which `gradle_chores` and `apple_chores` pick up separately.
    if depends_on(repo, "react-native") {
        out.push(pm_exec("React Native", "doctor", &["react-native", "doctor"]));
        out.push(pm_exec("React Native", "info", &["react-native", "info"]));
        out.push(pm_exec(
            "React Native",
            "bundle-android",
            &[
                "react-native",
                "bundle",
                "--platform",
                "android",
                "--dev",
                "false",
                "--entry-file",
                "index.js",
                "--bundle-output",
                "android/app/src/main/assets/index.android.bundle",
            ],
        ));
    }
    if depends_on(repo, "expo") {
        out.push(pm_exec("Expo", "doctor", &["expo-doctor"]));
        out.push(pm_exec("Expo", "prebuild", &["expo", "prebuild"]));
    }

    out
}

// --- dart / flutter ---------------------------------------------------------

/// Flutter's commands when the pubspec says Flutter, Dart's when it does not.
///
/// The distinction matters: `flutter test` in a pure Dart package works only if the
/// Flutter SDK is installed at all, and `flutter build apk` in one is meaningless.
fn dart_chores(repo: &Path) -> Vec<Chore> {
    let is_flutter = std::fs::read_to_string(repo.join("pubspec.yaml"))
        .map(|t| t.contains("sdk: flutter") || t.contains("flutter:"))
        .unwrap_or(false);

    if !is_flutter {
        return vec![
            cmd("Dart", "pub-get", DART, &["pub", "get"]),
            cmd("Dart", "pub-upgrade", DART, &["pub", "upgrade"]),
            cmd("Dart", "pub-outdated", DART, &["pub", "outdated"]),
            cmd("Dart", "analyze", DART, &["analyze"]),
            cmd("Dart", "test", DART, &["test"]),
            cmd("Dart", "format", DART, &["format", "."]).destructive(),
            cmd("Dart", "fix", DART, &["fix", "--apply"]).destructive(),
        ];
    }

    let mut out = vec![
        cmd("Flutter", "pub-get", FLUTTER, &["pub", "get"]),
        cmd("Flutter", "pub-upgrade", FLUTTER, &["pub", "upgrade"]),
        cmd("Flutter", "pub-outdated", FLUTTER, &["pub", "outdated"]),
        cmd("Flutter", "analyze", FLUTTER, &["analyze"]),
        cmd("Flutter", "test", FLUTTER, &["test"]),
        cmd("Flutter", "doctor", FLUTTER, &["doctor", "-v"]),
        cmd("Flutter", "devices", FLUTTER, &["devices"]),
        cmd("Flutter", "format", DART, &["format", "."]).destructive(),
        cmd("Flutter", "fix", DART, &["fix", "--apply"]).destructive(),
        // Deletes build/ and .dart_tool/, so the next build is a cold one.
        cmd("Flutter", "clean", FLUTTER, &["clean"]).destructive(),
    ];

    // Build targets, only for platforms this app actually has. Offering `build ios`
    // for an app with no ios/ directory produces an error and nothing else.
    if repo.join("l10n.yaml").exists() {
        out.push(cmd("Flutter", "gen-l10n", FLUTTER, &["gen-l10n"]));
    }
    if repo.join("android").is_dir() {
        out.push(cmd("Flutter", "build-apk", FLUTTER, &["build", "apk"]));
        out.push(cmd(
            "Flutter",
            "build-appbundle",
            FLUTTER,
            &["build", "appbundle"],
        ));
    }
    if repo.join("ios").is_dir() {
        out.push(cmd("Flutter", "build-ios", FLUTTER, &["build", "ios"]));
    }
    if repo.join("web").is_dir() {
        out.push(cmd("Flutter", "build-web", FLUTTER, &["build", "web"]));
    }
    if repo.join("linux").is_dir() {
        out.push(cmd("Flutter", "build-linux", FLUTTER, &["build", "linux"]));
    }

    out
}

// --- rust / go --------------------------------------------------------------

fn cargo_chores() -> Vec<Chore> {
    const C: &[&str] = &["cargo"];
    vec![
        cmd("Cargo", "build", C, &["build"]),
        cmd("Cargo", "check", C, &["check"]),
        cmd("Cargo", "test", C, &["test"]),
        cmd("Cargo", "clippy", C, &["clippy", "--all-targets"]),
        cmd("Cargo", "fmt", C, &["fmt"]).destructive(),
        cmd("Cargo", "update", C, &["update"]).destructive(),
        cmd("Cargo", "tree", C, &["tree", "--depth", "1"]),
        cmd("Cargo", "doc", C, &["doc", "--no-deps"]),
        cmd("Cargo", "clean", C, &["clean"]).destructive(),
    ]
}

fn go_chores() -> Vec<Chore> {
    const G: &[&str] = &["go"];
    vec![
        cmd("Go", "build", G, &["build", "./..."]),
        cmd("Go", "test", G, &["test", "./..."]),
        cmd("Go", "vet", G, &["vet", "./..."]),
        cmd("Go", "fmt", G, &["fmt", "./..."]).destructive(),
        cmd("Go", "mod-tidy", G, &["mod", "tidy"]).destructive(),
        cmd("Go", "mod-download", G, &["mod", "download"]),
        cmd("Go", "generate", G, &["generate", "./..."]).destructive(),
        cmd("Go", "clean", G, &["clean", "-cache", "-testcache"]).destructive(),
    ]
}

// --- gradle / android -------------------------------------------------------

/// Gradle tasks, from wherever the wrapper is.
///
/// The wrapper is preferred over an installed `gradle` for the usual reason: it
/// pins the version the project expects. A React Native app keeps its build under
/// `android/`, which is why the directory is part of the answer.
///
/// Skipped for Flutter, whose own `flutter build apk` covers the same ground and
/// is the supported way in.
fn gradle_chores(repo: &Path) -> Vec<Chore> {
    if repo.join("pubspec.yaml").exists() {
        return Vec::new();
    }

    let (subdir, exe): (Option<&str>, Option<String>) = if repo.join("gradlew").exists() {
        (None, Some("./gradlew".to_string()))
    } else if repo.join("android/gradlew").exists() {
        (Some("android"), Some("./gradlew".to_string()))
    } else if repo.join("build.gradle").exists() || repo.join("build.gradle.kts").exists() {
        (None, None)
    } else {
        return Vec::new();
    };

    let android = repo.join("app/src/main/AndroidManifest.xml").exists()
        || repo.join("android/app/src/main/AndroidManifest.xml").exists();

    let make = |id: &str, args: &[&str]| -> Chore {
        let c = match &exe {
            Some(e) => local_cmd("Gradle", id, e, args),
            // No wrapper in this project; fall back to whatever is installed.
            None => cmd("Gradle", id, &["gradle"], args),
        };
        match subdir {
            Some(d) => c.in_dir(d),
            None => c,
        }
    };

    let mut out = vec![
        make("build", &["build"]),
        make("test", &["test"]),
        make("tasks", &["tasks"]),
        make("dependencies", &["dependencies"]),
        make("clean", &["clean"]).destructive(),
    ];
    if android {
        out.push(make("assemble-debug", &["assembleDebug"]));
        out.push(make("assemble-release", &["assembleRelease"]));
        out.push(make("install-debug", &["installDebug"]));
        out.push(make("lint", &["lint"]));
    }
    out
}

// --- swift / xcode / cocoapods ----------------------------------------------

fn apple_chores(repo: &Path) -> Vec<Chore> {
    const SWIFT: &[&str] = &["swift"];
    const XC: &[&str] = &["xcodebuild"];
    const POD: &[&str] = &["pod"];
    let mut out = Vec::new();

    if repo.join("Package.swift").exists() {
        out.extend([
            cmd("Swift", "build", SWIFT, &["build"]),
            cmd("Swift", "test", SWIFT, &["test"]),
            cmd("Swift", "resolve", SWIFT, &["package", "resolve"]),
            cmd("Swift", "update", SWIFT, &["package", "update"]).destructive(),
            cmd("Swift", "clean", SWIFT, &["package", "clean"]).destructive(),
        ]);
    }

    if has_ext(repo, "xcodeproj") || has_ext(repo, "xcworkspace") {
        out.extend([
            cmd("Xcode", "list", XC, &["-list"]),
            cmd("Xcode", "build", XC, &["build"]),
            cmd("Xcode", "clean", XC, &["clean"]).destructive(),
        ]);
    }

    // A Podfile at the root, or under ios/ as React Native and Flutter lay it out.
    if repo.join("Podfile").exists() {
        out.push(cmd("CocoaPods", "install", POD, &["install"]));
        out.push(cmd("CocoaPods", "update", POD, &["update"]).destructive());
    } else if repo.join("ios/Podfile").exists() {
        out.push(cmd("CocoaPods", "install", POD, &["install"]).in_dir("ios"));
        out.push(
            cmd("CocoaPods", "update", POD, &["update"])
                .in_dir("ios")
                .destructive(),
        );
    }

    out
}

// --- python -----------------------------------------------------------------

fn python_chores(repo: &Path) -> Vec<Chore> {
    let mut out = Vec::new();
    let file = |f: &str| repo.join(f).exists();

    if file("requirements.txt") {
        out.push(
            cmd(
                "Python",
                "install-requirements",
                PY,
                &["-m", "pip", "install", "-r", "requirements.txt"],
            )
            .destructive(),
        );
    }
    if file("pyproject.toml") {
        out.push(
            cmd("Python", "install-editable", PY, &["-m", "pip", "install", "-e", "."])
                .destructive(),
        );
    }
    if !file("requirements.txt") && !file("pyproject.toml") && !file("Pipfile") {
        return out;
    }

    let deps = python_deps(repo);
    if deps.contains("pytest") || repo.join("tests").is_dir() {
        out.push(cmd("Python", "pytest", PY, &["-m", "pytest"]));
    }
    if deps.contains("ruff") {
        out.push(cmd("Python", "ruff-check", PY, &["-m", "ruff", "check", "."]));
        out.push(
            cmd("Python", "ruff-format", PY, &["-m", "ruff", "format", "."]).destructive(),
        );
    }
    if deps.contains("black") {
        out.push(cmd("Python", "black", PY, &["-m", "black", "."]).destructive());
    }
    if deps.contains("mypy") {
        out.push(cmd("Python", "mypy", PY, &["-m", "mypy", "."]));
    }

    // Django's own management commands. Non-interactive ones only — `shell` and
    // `createsuperuser` both sit and wait for a prompt this pane cannot answer.
    if repo.join("manage.py").exists() {
        out.extend([
            cmd("Django", "migrate", PY, &["manage.py", "migrate"]).destructive(),
            cmd("Django", "makemigrations", PY, &["manage.py", "makemigrations"]).destructive(),
            cmd("Django", "showmigrations", PY, &["manage.py", "showmigrations"]),
            cmd("Django", "check", PY, &["manage.py", "check"]),
            cmd("Django", "test", PY, &["manage.py", "test"]),
            cmd(
                "Django",
                "collectstatic",
                PY,
                &["manage.py", "collectstatic", "--noinput"],
            )
            .destructive(),
        ]);
    }

    out
}

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

// --- c / c++ ----------------------------------------------------------------

/// `build/` is the near-universal convention and the one `cmake -B build` creates,
/// so the configure step and everything after it agree on it.
fn cmake_chores() -> Vec<Chore> {
    const CM: &[&str] = &["cmake"];
    const CT: &[&str] = &["ctest"];
    vec![
        cmd("CMake", "configure", CM, &["-B", "build"]),
        cmd("CMake", "build", CM, &["--build", "build"]),
        cmd("CMake", "test", CT, &["--test-dir", "build"]),
        cmd("CMake", "clean", CM, &["--build", "build", "--target", "clean"]).destructive(),
    ]
}

// --- php / ruby / elixir / jvm / dotnet -------------------------------------

fn php_chores(repo: &Path) -> Vec<Chore> {
    const CO: &[&str] = &["composer"];
    const PHP: &[&str] = &["php"];
    let mut out = vec![
        cmd("Composer", "install", CO, &["install"]).destructive(),
        cmd("Composer", "update", CO, &["update"]).destructive(),
        cmd("Composer", "outdated", CO, &["outdated"]),
        cmd("Composer", "dump-autoload", CO, &["dump-autoload"]),
    ];
    // Laravel.
    if repo.join("artisan").exists() {
        out.extend([
            cmd("Artisan", "migrate", PHP, &["artisan", "migrate"]).destructive(),
            cmd("Artisan", "route-list", PHP, &["artisan", "route:list"]),
            cmd("Artisan", "cache-clear", PHP, &["artisan", "cache:clear"]).destructive(),
            cmd("Artisan", "config-clear", PHP, &["artisan", "config:clear"]).destructive(),
        ]);
    }
    out
}

fn ruby_chores(repo: &Path) -> Vec<Chore> {
    const BU: &[&str] = &["bundle"];
    let mut out = vec![
        cmd("Bundler", "install", BU, &["install"]).destructive(),
        cmd("Bundler", "update", BU, &["update"]).destructive(),
        cmd("Bundler", "outdated", BU, &["outdated"]),
    ];
    if repo.join("bin/rails").exists() {
        out.extend([
            local_cmd("Rails", "migrate", "bin/rails", &["db:migrate"]).destructive(),
            local_cmd("Rails", "routes", "bin/rails", &["routes"]),
            local_cmd("Rails", "test", "bin/rails", &["test"]),
        ]);
    }
    out
}

fn elixir_chores() -> Vec<Chore> {
    const MIX: &[&str] = &["mix"];
    vec![
        cmd("Mix", "deps-get", MIX, &["deps.get"]).destructive(),
        cmd("Mix", "compile", MIX, &["compile"]),
        cmd("Mix", "test", MIX, &["test"]),
        cmd("Mix", "format", MIX, &["format"]).destructive(),
        cmd("Mix", "clean", MIX, &["clean"]).destructive(),
    ]
}

fn maven_chores() -> Vec<Chore> {
    const MVN: &[&str] = &["mvn"];
    vec![
        cmd("Maven", "install", MVN, &["install"]),
        cmd("Maven", "test", MVN, &["test"]),
        cmd("Maven", "package", MVN, &["package"]),
        cmd("Maven", "dependency-tree", MVN, &["dependency:tree"]),
        cmd("Maven", "clean", MVN, &["clean"]).destructive(),
    ]
}

fn dotnet_chores() -> Vec<Chore> {
    const DN: &[&str] = &["dotnet"];
    vec![
        cmd("dotnet", "restore", DN, &["restore"]),
        cmd("dotnet", "build", DN, &["build"]),
        cmd("dotnet", "test", DN, &["test"]),
        cmd("dotnet", "format", DN, &["format"]).destructive(),
        cmd("dotnet", "clean", DN, &["clean"]).destructive(),
    ]
}

// --- compose ----------------------------------------------------------------

/// Note what is not here: `up`. That is long-running, so it belongs to `runner` and
/// its Start/Stop pair, not to a fire-and-forget menu item.
fn compose_chores(file: &str) -> Vec<Chore> {
    let with = |id: &str, args: &[&str]| -> Chore {
        let mut full = vec!["compose", "-f", file];
        full.extend(args);
        Chore {
            id: format!("compose.{id}"),
            label: format!("compose {}", args.join(" ")),
            group: "Compose".to_string(),
            via: RunVia::ComposeArgs(full.iter().map(|s| s.to_string()).collect()),
            cwd: None,
            destructive: false,
        }
    };
    vec![
        with("ps", &["ps"]),
        with("build", &["build"]),
        with("pull", &["pull"]),
        with("config", &["config"]),
        with("logs", &["logs", "--tail", "200"]),
        with("restart", &["restart"]),
        // Stops and removes the containers this file defines.
        with("down", &["down"]).destructive(),
    ]
}

// --- shared probes ----------------------------------------------------------

fn compose_file(repo: &Path) -> Option<String> {
    [
        "compose.yml",
        "compose.yaml",
        "docker-compose.yml",
        "docker-compose.yaml",
    ]
    .into_iter()
    .find(|f| repo.join(f).exists())
    .map(String::from)
}

fn depends_on(repo: &Path, dep: &str) -> bool {
    crate::pkg::read_manifest(repo)
        .map(|m| m.deps.iter().any(|d| d == dep))
        .unwrap_or(false)
}

fn has_ext(repo: &Path, ext: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(repo) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some(ext))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("wa-chores-{name}-{}", std::process::id()));
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
        chores(repo).into_iter().map(|c| c.id).collect()
    }

    fn groups(repo: &Path) -> Vec<String> {
        let mut g: Vec<String> = Vec::new();
        for c in chores(repo) {
            if !g.contains(&c.group) {
                g.push(c.group);
            }
        }
        g
    }

    fn build_id(repo: &Path) -> Option<String> {
        pick_build(&chores(repo)).map(|c| c.id.clone())
    }

    #[test]
    fn each_ecosystem_offers_its_own_build() {
        let d = scratch("build-cargo");
        write(&d, "Cargo.toml", "[package]\nname = \"x\"");
        assert_eq!(build_id(&d).as_deref(), Some("cargo.build"));

        let d = scratch("build-go");
        write(&d, "go.mod", "module x");
        assert_eq!(build_id(&d).as_deref(), Some("go.build"));

        let d = scratch("build-gradle");
        write(&d, "build.gradle", "");
        assert_eq!(build_id(&d).as_deref(), Some("gradle.build"));

        // Maven's build is `package`; `install` also publishes, which is a
        // different thing to do to someone's machine.
        let d = scratch("build-maven");
        write(&d, "pom.xml", "<project/>");
        assert_eq!(build_id(&d).as_deref(), Some("maven.package"));

        // Elixir spells it compile.
        let d = scratch("build-mix");
        write(&d, "mix.exs", "defmodule X.MixProject do end");
        assert_eq!(build_id(&d).as_deref(), Some("mix.compile"));
    }

    #[test]
    fn a_compose_file_never_wins_the_build_button() {
        // `compose build` builds container images, which is not this repo's
        // artifact — so it is the last resort, never the answer for a Rust service
        // that happens to ship a compose file.
        let d = scratch("build-mixed");
        write(&d, "Cargo.toml", "[package]\nname = \"x\"");
        write(&d, "docker-compose.yml", "services: {}");
        assert_eq!(build_id(&d).as_deref(), Some("cargo.build"));

        // On its own it is still better than nothing.
        let d = scratch("build-compose-only");
        write(&d, "docker-compose.yml", "services: {}");
        assert_eq!(build_id(&d).as_deref(), Some("compose.build"));
    }

    #[test]
    fn a_repo_with_no_build_step_has_none() {
        let d = scratch("build-none");
        write(&d, "README.md", "# docs");
        assert_eq!(build_id(&d), None);
    }

    #[test]
    fn a_flutter_app_offers_pub_get_and_clean() {
        let d = scratch("flutter");
        write(&d, "pubspec.yaml", "name: app\nenvironment:\n  sdk: flutter");
        write(&d, "lib/main.dart", "");
        let list = ids(&d);
        assert!(list.contains(&"flutter.pub-get".to_string()));
        assert!(list.contains(&"flutter.clean".to_string()));
        assert!(list.contains(&"flutter.doctor".to_string()));
        // clean deletes build output, so it must not be a one-click item.
        assert!(find(&d, "flutter.clean").unwrap().destructive);
        assert!(!find(&d, "flutter.pub-get").unwrap().destructive);
    }

    #[test]
    fn build_targets_follow_the_platforms_the_app_actually_has() {
        let d = scratch("flutter-plat");
        write(&d, "pubspec.yaml", "name: app\nflutter:\n  assets: []");
        fs::create_dir_all(d.join("android")).unwrap();
        let list = ids(&d);
        assert!(list.contains(&"flutter.build-apk".to_string()));
        // No ios/ here, and `flutter build ios` in that case only ever errors.
        assert!(!list.contains(&"flutter.build-ios".to_string()));
    }

    #[test]
    fn a_pure_dart_package_gets_dart_commands_not_flutter_ones() {
        let d = scratch("dart");
        write(&d, "pubspec.yaml", "name: mylib\nenvironment:\n  sdk: '>=3.0.0'");
        assert_eq!(groups(&d), vec!["Dart"]);
        assert_eq!(
            find(&d, "dart.pub-get").unwrap().via,
            RunVia::Program(DART, vec!["pub".into(), "get".into()])
        );
    }

    #[test]
    fn a_react_native_app_gets_node_gradle_and_cocoapods_at_once() {
        // The case that motivates grouping: three ecosystems, one repo.
        let d = scratch("rn");
        write(
            &d,
            "package.json",
            r#"{"dependencies":{"react-native":"0.74"}}"#,
        );
        write(&d, "android/gradlew", "#!/bin/sh");
        write(&d, "android/app/src/main/AndroidManifest.xml", "<manifest/>");
        write(&d, "ios/Podfile", "platform :ios");
        let g = groups(&d);
        assert!(g.contains(&"Packages".to_string()));
        assert!(g.contains(&"React Native".to_string()));
        assert!(g.contains(&"Gradle".to_string()));
        assert!(g.contains(&"CocoaPods".to_string()));
    }

    #[test]
    fn native_commands_run_in_their_own_directory() {
        // `pod install` only works in ios/, and the gradle wrapper only in android/.
        let d = scratch("rn-cwd");
        write(&d, "package.json", r#"{"dependencies":{"react-native":"0.74"}}"#);
        write(&d, "android/gradlew", "#!/bin/sh");
        write(&d, "ios/Podfile", "platform :ios");
        assert_eq!(find(&d, "cocoapods.install").unwrap().cwd.as_deref(), Some("ios"));
        assert_eq!(find(&d, "gradle.build").unwrap().cwd.as_deref(), Some("android"));
    }

    #[test]
    fn the_gradle_wrapper_is_preferred_over_an_installed_gradle() {
        // The wrapper pins the version the project expects.
        let d = scratch("gradlew");
        write(&d, "gradlew", "#!/bin/sh");
        write(&d, "build.gradle.kts", "");
        assert_eq!(
            find(&d, "gradle.build").unwrap().via,
            RunVia::Local("./gradlew".into(), vec!["build".into()])
        );

        let bare = scratch("gradle-bare");
        write(&bare, "build.gradle", "");
        assert_eq!(
            find(&bare, "gradle.build").unwrap().via,
            RunVia::Program(&["gradle"], vec!["build".into()])
        );
    }

    #[test]
    fn a_flutter_repo_does_not_also_offer_raw_gradle_tasks() {
        // Flutter ships an android/gradlew, but `flutter build apk` is the supported
        // way in and the two menus would say the same thing twice.
        let d = scratch("flutter-gradle");
        write(&d, "pubspec.yaml", "name: app\nflutter:\n  assets: []");
        write(&d, "android/gradlew", "#!/bin/sh");
        assert!(!groups(&d).contains(&"Gradle".to_string()));
    }

    #[test]
    fn android_only_tasks_need_a_manifest() {
        let d = scratch("jvm");
        write(&d, "gradlew", "#!/bin/sh");
        write(&d, "build.gradle.kts", "");
        let list = ids(&d);
        assert!(list.contains(&"gradle.build".to_string()));
        // A plain JVM library has nothing to assemble for a device.
        assert!(!list.contains(&"gradle.assemble-debug".to_string()));
    }

    #[test]
    fn swift_and_xcode_are_separate_groups() {
        let d = scratch("swift");
        write(&d, "Package.swift", "// swift-tools-version:5.9");
        fs::create_dir_all(d.join("App.xcodeproj")).unwrap();
        let g = groups(&d);
        assert!(g.contains(&"Swift".to_string()));
        assert!(g.contains(&"Xcode".to_string()));
    }

    #[test]
    fn django_commands_appear_and_the_interactive_ones_do_not() {
        let d = scratch("django");
        write(&d, "manage.py", "");
        write(&d, "requirements.txt", "Django==5.0\npytest\n");
        let list = ids(&d);
        assert!(list.contains(&"django.migrate".to_string()));
        assert!(list.contains(&"django.collectstatic".to_string()));
        assert!(list.contains(&"python.pytest".to_string()));
        // Both sit waiting on a prompt this pane cannot answer.
        assert!(!list.iter().any(|i| i.contains("shell")));
        assert!(!list.iter().any(|i| i.contains("createsuperuser")));
    }

    #[test]
    fn python_linters_are_offered_only_when_declared() {
        let d = scratch("py-lint");
        write(&d, "pyproject.toml", "[project]\nname='x'");
        assert!(!ids(&d).contains(&"python.ruff-check".to_string()));

        write(&d, "pyproject.toml", "[project]\nname='x'\ndependencies=['ruff']");
        assert!(ids(&d).contains(&"python.ruff-check".to_string()));
    }

    #[test]
    fn cargo_and_go_cover_the_usual_maintenance_commands() {
        let rust = scratch("cargo");
        write(&rust, "Cargo.toml", "[package]\nname='x'");
        let list = ids(&rust);
        for want in ["cargo.build", "cargo.test", "cargo.clippy", "cargo.fmt", "cargo.clean"] {
            assert!(list.contains(&want.to_string()), "missing {want}");
        }
        // fmt rewrites files in place.
        assert!(find(&rust, "cargo.fmt").unwrap().destructive);

        let go = scratch("go");
        write(&go, "go.mod", "module x");
        let list = ids(&go);
        for want in ["go.build", "go.test", "go.vet", "go.mod-tidy"] {
            assert!(list.contains(&want.to_string()), "missing {want}");
        }
    }

    #[test]
    fn compose_offers_everything_except_up() {
        // `up` is long-running, so it lives in `runner` behind Start/Stop.
        let d = scratch("compose");
        write(&d, "compose.yml", "services: {}");
        let list = ids(&d);
        assert!(list.contains(&"compose.ps".to_string()));
        assert!(list.contains(&"compose.down".to_string()));
        assert!(!list.iter().any(|i| i == "compose.up"));
        assert!(find(&d, "compose.down").unwrap().destructive);
    }

    #[test]
    fn a_repo_with_nothing_recognisable_offers_nothing() {
        let d = scratch("empty");
        assert!(ids(&d).is_empty());
    }

    #[test]
    fn every_group_a_chore_emits_is_declared() {
        // `GROUPS` is what `ecosystems.rs` links against, so an undeclared group
        // means a stack quietly owns nothing.
        let d = scratch("groups");
        write(&d, "package.json", r#"{"dependencies":{"react-native":"0.74","expo":"51"}}"#);
        write(&d, "pubspec.yaml", "name: x\ndependencies:\n  flutter:\n    sdk: flutter\n");
        write(&d, "Cargo.toml", "[package]\nname='x'");
        write(&d, "go.mod", "module x");
        write(&d, "CMakeLists.txt", "project(x)");
        write(&d, "compose.yml", "services: {}");
        write(&d, "requirements.txt", "ruff\n");
        write(&d, "manage.py", "");
        write(&d, "composer.json", "{}");
        write(&d, "artisan", "");
        write(&d, "Gemfile", "");
        write(&d, "bin/rails", "");
        write(&d, "mix.exs", "");
        write(&d, "pom.xml", "");
        write(&d, "x.csproj", "");
        write(&d, "Package.swift", "");
        write(&d, "ios/Podfile", "");

        for c in chores(&d) {
            assert!(GROUPS.contains(&c.group.as_str()), "undeclared group '{}'", c.group);
        }
    }

    #[test]
    fn every_id_is_unique_in_a_polyglot_repo() {
        // Ids key the lookup, so a collision would run the wrong command.
        let d = scratch("poly");
        write(&d, "package.json", r#"{"dependencies":{"react-native":"0.74"}}"#);
        write(&d, "Cargo.toml", "[package]\nname='x'");
        write(&d, "go.mod", "module x");
        write(&d, "CMakeLists.txt", "project(x)");
        write(&d, "compose.yml", "services: {}");
        write(&d, "requirements.txt", "ruff\n");
        write(&d, "android/gradlew", "#!/bin/sh");
        write(&d, "ios/Podfile", "")
        ;
        let list = ids(&d);
        let unique: std::collections::BTreeSet<&String> = list.iter().collect();
        assert_eq!(unique.len(), list.len(), "duplicate ids in {list:?}");
        assert!(list.len() > 30, "expected a broad menu, got {}", list.len());
    }
    #[test]
    fn a_flutter_app_builds_flutter_not_its_android_shell() {
        // A Flutter app has an android/ directory, so `gradle.build` is on offer.
        // Building that produces the host shell, not the app — which is what Build
        // means here, and why Flutter leads the table.
        let d = scratch("flutter-build");
        write(&d, "pubspec.yaml", "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n");
        write(&d, "android/gradlew", "#!/bin/sh");
        let list = chores(&d);
        assert_eq!(pick_build(&list).map(|c| c.id.as_str()), Some("flutter.build-apk"));
    }

}
