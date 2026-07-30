//! Works out what a repo *is* from its contents.
//!
//! Cheap on purpose: a handful of file existence checks plus one package.json
//! read, so it can run for every repo during a scan without slowing it down. No
//! network, no dependency resolution.

use crate::model::{RepoKind, RepoShape};
use std::path::Path;

/// Signals we look for, roughly in order of how conclusive they are.
pub fn detect(repo: &Path) -> RepoShape {
    let pkg = read_package_json(repo);
    let deps = pkg.as_ref().map(all_deps).unwrap_or_default();
    let has = |dep: &str| deps.iter().any(|d| d == dep);
    let has_any = |list: &[&str]| list.iter().any(|d| has(d));
    let file = |f: &str| repo.join(f).exists();

    let mut stack: Vec<String> = Vec::new();

    // --- non-JS ecosystems are the most conclusive ---------------------------
    if file("Cargo.toml") {
        stack.push("rust".into());
    }
    if file("go.mod") {
        stack.push("go".into());
    }
    if file("pom.xml") || file("build.gradle") || file("build.gradle.kts") {
        stack.push("java".into());
    }
    if file("pubspec.yaml") {
        stack.push("flutter".into());
    }
    if file("requirements.txt") || file("pyproject.toml") {
        stack.push("python".into());
    }
    if file("composer.json") {
        stack.push("php".into());
    }

    // --- JS frameworks ------------------------------------------------------
    if has("next") {
        stack.push("next".into());
    }
    if has("vite") || file("vite.config.ts") || file("vite.config.js") {
        stack.push("vite".into());
    }
    if has("react") {
        stack.push("react".into());
    }
    if has("vue") {
        stack.push("vue".into());
    }
    if has("svelte") {
        stack.push("svelte".into());
    }
    if has("@angular/core") {
        stack.push("angular".into());
    }
    if has("react-native") || has("expo") {
        stack.push("react-native".into());
    }
    if has("@nestjs/core") {
        stack.push("nestjs".into());
    }
    if has("express") {
        stack.push("express".into());
    }
    if has("fastify") {
        stack.push("fastify".into());
    }
    if has("@storybook/react") || has("storybook") || repo.join(".storybook").is_dir() {
        stack.push("storybook".into());
    }

    // --- ecosystems with no JS manifest -------------------------------------
    //
    // Everything below was previously invisible. A folder of CMake/Qt projects
    // reached `classify` with an empty stack and came out as Docs, on the strength
    // of having a README.
    if file("CMakeLists.txt") {
        stack.push("cmake".into());
    }
    if has_ext(repo, "pro") {
        stack.push("qmake".into());
    }
    if is_qt(repo) {
        stack.push("qt".into());
    }
    if file("Gemfile") {
        stack.push("ruby".into());
    }
    if file("mix.exs") {
        stack.push("elixir".into());
    }
    if file("Package.swift") {
        stack.push("swift".into());
    }
    if file("build.zig") {
        stack.push("zig".into());
    }
    if has_ext(repo, "csproj") || has_ext(repo, "sln") {
        stack.push("dotnet".into());
    }

    let language = language(repo, &stack, pkg.is_some());
    let kind = classify(repo, pkg.as_ref(), &deps, &stack, language.as_deref());

    RepoShape {
        kind,
        language,
        stack,
        has_dockerfile: file("Dockerfile") || file("docker-compose.yml") || file("compose.yml"),
        is_monorepo: file("pnpm-workspace.yaml")
            || file("turbo.json")
            || file("lerna.json")
            || pkg
                .as_ref()
                .and_then(|p| p.get("workspaces"))
                .is_some(),
    }
}

fn classify(
    repo: &Path,
    pkg: Option<&serde_json::Value>,
    deps: &[String],
    stack: &[String],
    language: Option<&str>,
) -> RepoKind {
    let has = |dep: &str| deps.iter().any(|d| d == dep);
    let in_stack = |s: &str| stack.iter().any(|x| x == s);
    let file = |f: &str| repo.join(f).exists();

    // Mobile beats everything: react-native and Flutter projects also look like
    // frontends by dependency alone.
    //
    // The native cases are here too. A Kotlin Android app has a `build.gradle`, so
    // it used to classify as Backend on the strength of `java` being in its stack,
    // and an iOS app with no manifest we read fell through to Docs.
    if in_stack("flutter")
        || in_stack("react-native")
        || repo.join("android").is_dir() && repo.join("ios").is_dir()
        || is_android_app(repo)
        || is_ios_app(repo)
    {
        return RepoKind::Mobile;
    }

    // An app shell is the strongest single signal of a frontend: it is the file a
    // browser loads. Checked before any backend framework, because a frontend can
    // legitimately depend on express or nest — a mock API, a preview server, or a
    // monorepo that holds the backend alongside the app.
    let app_shell = has_app_shell(repo);

    let js_backend =
        has("@nestjs/core") || has("express") || has("fastify") || has("koa") || has("@hapi/hapi");

    // Non-JS ecosystems are conclusive on their own, unless the repo also ships a
    // web app shell — then it is a service *and* a UI, and the UI is the part you
    // run a dev server for.
    if !app_shell {
        if in_stack("go") || in_stack("java") || in_stack("php") {
            return RepoKind::Backend;
        }
        if in_stack("rust") && !in_stack("vite") {
            // A Rust repo with no web frontend: a service or a CLI, not a UI.
            return RepoKind::Backend;
        }
        if in_stack("python") {
            return RepoKind::Backend;
        }
    }

    if app_shell && js_backend {
        return RepoKind::Frontend;
    }
    if js_backend {
        return RepoKind::Backend;
    }

    // A library publishes an entry point and has no app shell.
    let publishes_entry = pkg
        .map(|p| {
            p.get("main").is_some()
                || p.get("module").is_some()
                || p.get("exports").is_some()
                || p.get("types").is_some()
        })
        .unwrap_or(false);
    let is_private = pkg
        .and_then(|p| p.get("private"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if publishes_entry && !app_shell && !is_private {
        return RepoKind::Library;
    }

    // An app shell, or a frontend framework.
    if app_shell
        || in_stack("next")
        || in_stack("vite")
        || in_stack("react")
        || in_stack("vue")
        || in_stack("svelte")
        || in_stack("angular")
    {
        return RepoKind::Frontend;
    }

    // Storybook-only repos are component libraries in practice.
    if in_stack("storybook") {
        return RepoKind::Library;
    }

    if pkg.is_some() {
        return RepoKind::Unknown;
    }

    // No manifest we read. Docs only when there is genuinely no code here —
    // "has a README" used to be enough, which filed a whole folder of CMake and Qt
    // projects under Docs and tagged seven real repos DOC.
    let only_prose = matches!(language, None | Some("Markdown"));
    if only_prose && (repo.join("README.md").exists() || repo.join("docs").is_dir()) {
        return RepoKind::Docs;
    }

    RepoKind::Unknown
}

/// Whether this repo builds something a browser loads.
///
/// Looks one level into the conventional workspace directories as well as the
/// root: in a monorepo the app shell lives in `apps/<name>/index.html`, and only
/// checking the root makes the whole repo look like whatever its root manifest
/// happens to depend on.
fn has_app_shell(repo: &Path) -> bool {
    if repo.join("index.html").exists() {
        return true;
    }
    for workspace_dir in ["apps", "packages", "libs"] {
        let Ok(entries) = std::fs::read_dir(repo.join(workspace_dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().join("index.html").exists() {
                return true;
            }
        }
    }
    false
}

/// The language this repo is mostly written in, as a display name.
///
/// Manifest evidence first, because a manifest states the language outright and
/// costs one `exists()`. Only when nothing declares itself does this fall back to
/// counting source files — which is the only thing that works for the large class
/// of projects with no manifest we read at all.
fn language(repo: &Path, stack: &[String], has_pkg: bool) -> Option<String> {
    let in_stack = |s: &str| stack.iter().any(|x| x == s);
    let named = |s: &str| Some(s.to_string());

    if in_stack("flutter") {
        return named("Dart");
    }
    if in_stack("rust") {
        return named("Rust");
    }
    if in_stack("go") {
        return named("Go");
    }
    // A tsconfig is what decides it; `package.json` alone says nothing about which
    // of the two a repo is written in.
    if has_pkg {
        return if repo.join("tsconfig.json").exists() {
            named("TypeScript")
        } else {
            named("JavaScript")
        };
    }
    if in_stack("python") {
        return named("Python");
    }
    if in_stack("php") {
        return named("PHP");
    }
    if in_stack("ruby") {
        return named("Ruby");
    }
    if in_stack("elixir") {
        return named("Elixir");
    }
    if in_stack("swift") {
        return named("Swift");
    }
    if in_stack("zig") {
        return named("Zig");
    }
    if in_stack("dotnet") {
        return named("C#");
    }

    // Java and C-family build files name a toolchain, not a language: gradle builds
    // Kotlin as readily as Java, and CMake builds both C and C++. The census is what
    // tells them apart, so these fall through to it with a floor rather than an
    // answer.
    let census = dominant_language(repo);
    if census.is_some() {
        return census;
    }
    if in_stack("java") {
        return named("Java");
    }
    if in_stack("cmake") || in_stack("qmake") || in_stack("qt") {
        return named("C++");
    }
    None
}

/// Directories that hold code nobody wrote here, so counting them would report the
/// language of a dependency tree.
const SKIP_DIRS: [&str; 12] = [
    ".git",
    "node_modules",
    "target",
    "build",
    "dist",
    "out",
    "vendor",
    "third_party",
    ".venv",
    "venv",
    "Pods",
    ".next",
];

/// The most common source language among this repo's own files.
///
/// Root plus one level down, capped — enough to characterise a repo without turning
/// a scan into a full tree walk. Ties break on name so the answer is stable across
/// scans rather than dependent on readdir order.
fn dominant_language(repo: &Path) -> Option<String> {
    use std::collections::BTreeMap;

    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut seen = 0usize;

    count_files(repo, &mut counts, &mut seen);
    if let Ok(entries) = std::fs::read_dir(repo) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            count_files(&path, &mut counts, &mut seen);
        }
    }

    // Prose loses to any real code: a C++ project with two source files and nine
    // pages of docs is a C++ project.
    if counts.len() > 1 {
        counts.remove("Markdown");
    }

    counts
        .into_iter()
        .max_by_key(|(lang, n)| (*n, std::cmp::Reverse(*lang)))
        .map(|(lang, _)| lang.to_string())
}

/// Tallies one directory's files by language, stopping at the shared cap.
fn count_files(
    dir: &Path,
    counts: &mut std::collections::BTreeMap<&'static str, usize>,
    seen: &mut usize,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *seen >= 600 {
            return;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        *seen += 1;
        if let Some(lang) = path
            .extension()
            .and_then(|e| e.to_str())
            .and_then(language_of_ext)
        {
            *counts.entry(lang).or_insert(0) += 1;
        }
    }
}

/// Extension to language, for the census only.
///
/// Implementation files only. `.h` is deliberately absent: it belongs to C and C++
/// equally, so counting it decides the very question the census is here to answer.
fn language_of_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "rs" => "Rust",
        "go" => "Go",
        "ts" | "tsx" | "mts" | "cts" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "py" => "Python",
        "rb" => "Ruby",
        "php" => "PHP",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "swift" => "Swift",
        "c" => "C",
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => "C++",
        "cs" => "C#",
        "m" => "Objective-C",
        "mm" => "Objective-C++",
        "sh" | "bash" | "zsh" => "Shell",
        "ps1" => "PowerShell",
        "lua" => "Lua",
        "vim" => "Vim script",
        "qml" => "QML",
        "dart" => "Dart",
        "ex" | "exs" => "Elixir",
        "zig" => "Zig",
        "hs" => "Haskell",
        "scala" => "Scala",
        "pl" | "pm" => "Perl",
        "css" | "scss" | "sass" | "less" => "CSS",
        "html" | "htm" => "HTML",
        "md" | "markdown" => "Markdown",
        _ => return None,
    })
}

/// Whether the build files mention Qt. Cheap and specific: the marker is the same
/// in both build systems, and it is what distinguishes a Qt app from any other
/// CMake tree.
fn is_qt(repo: &Path) -> bool {
    if let Ok(text) = std::fs::read_to_string(repo.join("CMakeLists.txt")) {
        if text.contains("find_package(Qt") || text.contains("Qt5") || text.contains("Qt6") {
            return true;
        }
    }
    // qmake's own form, in whichever .pro file is here.
    let Ok(entries) = std::fs::read_dir(repo) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path().extension().and_then(|x| x.to_str()) == Some("pro")
            && std::fs::read_to_string(e.path())
                .map(|t| t.contains("QT +=") || t.contains("QT+="))
                .unwrap_or(false)
    })
}

/// An Android app module. The manifest is the definitive marker — a Gradle build
/// file alone says only "JVM project".
fn is_android_app(repo: &Path) -> bool {
    ["app/src/main/AndroidManifest.xml", "src/main/AndroidManifest.xml"]
        .iter()
        .any(|p| repo.join(p).exists())
}

/// An Xcode project or workspace. Both are directories, not files.
fn is_ios_app(repo: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(repo) else {
        return false;
    };
    entries.flatten().any(|e| {
        matches!(
            e.path().extension().and_then(|x| x.to_str()),
            Some("xcodeproj") | Some("xcworkspace")
        )
    })
}

/// Whether any file at the repo root has this extension.
fn has_ext(repo: &Path, ext: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(repo) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some(ext))
}

fn read_package_json(repo: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(repo.join("package.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn all_deps(pkg: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    for field in ["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(obj) = pkg.get(field).and_then(|v| v.as_object()) {
            out.extend(obj.keys().cloned());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("wa-detect-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(dir: &Path, name: &str, body: &str) {
        if let Some(parent) = std::path::Path::new(name).parent() {
            let _ = fs::create_dir_all(dir.join(parent));
        }
        fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn vite_react_app_is_a_frontend() {
        let d = scratch("fe");
        write(&d, "index.html", "<html></html>");
        write(
            &d,
            "package.json",
            r#"{"dependencies":{"react":"18","vite":"5"}}"#,
        );
        let s = detect(&d);
        assert_eq!(s.kind, RepoKind::Frontend);
        assert!(s.stack.contains(&"react".to_string()));
        assert!(s.stack.contains(&"vite".to_string()));
    }

    #[test]
    fn an_app_shell_outranks_an_express_dependency() {
        // A real frontend that also ships a mock API server. Seen in the wild, and
        // it used to be filed under Backend on the strength of one dev dependency.
        let d = scratch("shell-vs-express");
        write(&d, "index.html", "<html></html>");
        write(&d, "vite.config.ts", "export default {}");
        write(
            &d,
            "package.json",
            r#"{"private":true,"dependencies":{"react":"18","vite":"5","express":"4"}}"#,
        );
        assert_eq!(detect(&d).kind, RepoKind::Frontend);
    }

    #[test]
    fn a_monorepo_app_shell_is_found_one_level_down() {
        // Nx/turbo layout: the root manifest mentions nest and react, and the shell
        // lives in apps/<name>/. Only looking at the root called this a backend.
        let d = scratch("monorepo-shell");
        write(&d, "nx.json", "{}");
        write(&d, "apps/web/index.html", "<html></html>");
        write(
            &d,
            "package.json",
            r#"{"private":true,"dependencies":{"@nestjs/core":"10","react":"18","vite":"5"}}"#,
        );
        assert_eq!(detect(&d).kind, RepoKind::Frontend);
    }

    #[test]
    fn a_backend_monorepo_with_no_shell_is_still_a_backend() {
        // The mirror case: nothing a browser loads, so the fix must not drag every
        // monorepo into Frontend.
        let d = scratch("monorepo-be");
        write(&d, "nx.json", "{}");
        write(&d, "apps/api/main.ts", "");
        write(
            &d,
            "package.json",
            r#"{"private":true,"dependencies":{"@nestjs/core":"10"}}"#,
        );
        assert_eq!(detect(&d).kind, RepoKind::Backend);
    }

    #[test]
    fn a_python_service_that_also_serves_a_web_app_is_a_frontend() {
        let d = scratch("py-shell");
        write(&d, "requirements.txt", "flask");
        write(&d, "index.html", "<html></html>");
        write(&d, "package.json", r#"{"private":true,"dependencies":{"vite":"5"}}"#);
        assert_eq!(detect(&d).kind, RepoKind::Frontend);
    }

    #[test]
    fn nestjs_service_is_a_backend() {
        let d = scratch("be");
        write(
            &d,
            "package.json",
            r#"{"dependencies":{"@nestjs/core":"10","rxjs":"7"}}"#,
        );
        let s = detect(&d);
        assert_eq!(s.kind, RepoKind::Backend);
        assert!(s.stack.contains(&"nestjs".to_string()));
    }

    #[test]
    fn published_package_without_an_app_shell_is_a_library() {
        let d = scratch("lib");
        write(
            &d,
            "package.json",
            r#"{"name":"@x/ui","main":"dist/index.js","dependencies":{"react":"18"}}"#,
        );
        let s = detect(&d);
        assert_eq!(s.kind, RepoKind::Library);
    }

    #[test]
    fn react_native_beats_the_react_frontend_signal() {
        let d = scratch("mobile");
        write(
            &d,
            "package.json",
            r#"{"dependencies":{"react":"18","react-native":"0.74"}}"#,
        );
        assert_eq!(detect(&d).kind, RepoKind::Mobile);
    }

    #[test]
    fn rust_service_is_a_backend_not_a_frontend() {
        let d = scratch("rust");
        write(&d, "Cargo.toml", "[package]\nname='x'");
        let s = detect(&d);
        assert_eq!(s.kind, RepoKind::Backend);
        assert!(s.stack.contains(&"rust".to_string()));
    }

    #[test]
    fn readme_only_repo_is_docs() {
        let d = scratch("docs");
        write(&d, "README.md", "# notes");
        assert_eq!(detect(&d).kind, RepoKind::Docs);
    }

    #[test]
    fn detects_docker_and_monorepo_markers() {
        let d = scratch("mono");
        write(&d, "package.json", r#"{"workspaces":["packages/*"]}"#);
        write(&d, "Dockerfile", "FROM node");
        let s = detect(&d);
        assert!(s.is_monorepo);
        assert!(s.has_dockerfile);
    }

    #[test]
    fn empty_directory_does_not_panic() {
        let d = scratch("empty");
        assert_eq!(detect(&d).kind, RepoKind::Unknown);
        assert_eq!(detect(&d).language, None);
    }

    #[test]
    fn a_cmake_qt_project_is_cpp_and_not_docs() {
        // The whole folder of these used to come out as Docs, tagged DOC, on the
        // strength of having a README.
        let d = scratch("qt");
        write(&d, "README.md", "# aero");
        write(
            &d,
            "CMakeLists.txt",
            "cmake_minimum_required(VERSION 3.16)\nfind_package(Qt6 REQUIRED)",
        );
        write(&d, "src/main.cpp", "int main() {}");
        write(&d, "src/window.cpp", "");
        let s = detect(&d);
        assert_eq!(s.language.as_deref(), Some("C++"));
        assert_ne!(s.kind, RepoKind::Docs);
        assert!(s.stack.contains(&"cmake".to_string()));
        assert!(s.stack.contains(&"qt".to_string()));
    }

    #[test]
    fn a_readme_only_repo_still_has_no_language() {
        // The mirror of the case above: prose alone must stay Docs.
        let d = scratch("prose");
        write(&d, "README.md", "# notes");
        write(&d, "guide.md", "");
        let s = detect(&d);
        assert_eq!(s.kind, RepoKind::Docs);
        // Markdown is a language, but it is the one that means "no code".
        assert_eq!(s.language.as_deref(), Some("Markdown"));
    }

    #[test]
    fn a_tsconfig_is_what_makes_a_node_repo_typescript() {
        let d = scratch("ts");
        write(&d, "package.json", r#"{"dependencies":{"react":"18"}}"#);
        assert_eq!(detect(&d).language.as_deref(), Some("JavaScript"));
        write(&d, "tsconfig.json", "{}");
        assert_eq!(detect(&d).language.as_deref(), Some("TypeScript"));
    }

    #[test]
    fn a_manifest_outranks_the_file_census() {
        // A Rust crate with more generated JS than Rust is still a Rust repo.
        let d = scratch("rust-census");
        write(&d, "Cargo.toml", "[package]\nname='x'");
        write(&d, "src/main.rs", "fn main() {}");
        for i in 0..5 {
            write(&d, &format!("web/bundle{i}.js"), "");
        }
        assert_eq!(detect(&d).language.as_deref(), Some("Rust"));
    }

    #[test]
    fn the_census_decides_between_c_and_cpp() {
        // CMake builds both, so the build file cannot answer this.
        let c = scratch("plain-c");
        write(&c, "CMakeLists.txt", "project(x)");
        write(&c, "main.c", "");
        write(&c, "util.c", "");
        assert_eq!(detect(&c).language.as_deref(), Some("C"));
    }

    #[test]
    fn dependency_directories_are_not_counted() {
        // Otherwise every repo with a node_modules reports JavaScript.
        let d = scratch("skip-deps");
        write(&d, "main.py", "");
        for i in 0..20 {
            write(&d, &format!("node_modules/p{i}.js"), "");
        }
        assert_eq!(detect(&d).language.as_deref(), Some("Python"));
    }

    #[test]
    fn a_kotlin_android_app_is_mobile_not_a_java_backend() {
        // `build.gradle.kts` put `java` in the stack, and `java` meant Backend.
        let d = scratch("android");
        write(&d, "build.gradle.kts", "plugins { id(\"com.android.application\") }");
        write(&d, "app/src/main/AndroidManifest.xml", "<manifest/>");
        write(&d, "app/src/main/kotlin/Main.kt", "fun main() {}");
        let s = detect(&d);
        assert_eq!(s.kind, RepoKind::Mobile);
        // And the census names the language the tag shows, rather than "java".
        assert_eq!(s.language.as_deref(), Some("Kotlin"));
    }

    #[test]
    fn an_xcode_project_is_mobile() {
        let d = scratch("ios");
        fs::create_dir_all(d.join("App.xcodeproj")).unwrap();
        write(&d, "App/AppDelegate.swift", "");
        let s = detect(&d);
        assert_eq!(s.kind, RepoKind::Mobile);
        assert_eq!(s.language.as_deref(), Some("Swift"));
    }

    #[test]
    fn a_shell_script_repo_is_shell_rather_than_unknown() {
        let d = scratch("sh");
        write(&d, "README.md", "# scripts");
        write(&d, "deploy.sh", "#!/bin/sh");
        write(&d, "backup.sh", "#!/bin/sh");
        assert_eq!(detect(&d).language.as_deref(), Some("Shell"));
    }
}
