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

    let kind = classify(repo, pkg.as_ref(), &deps, &stack);

    RepoShape {
        kind,
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
) -> RepoKind {
    let has = |dep: &str| deps.iter().any(|d| d == dep);
    let in_stack = |s: &str| stack.iter().any(|x| x == s);
    let file = |f: &str| repo.join(f).exists();

    // Mobile beats everything: react-native and Flutter projects also look like
    // frontends by dependency alone.
    if in_stack("flutter") || in_stack("react-native") || repo.join("android").is_dir() && repo.join("ios").is_dir() {
        return RepoKind::Mobile;
    }

    // Explicit backend frameworks.
    if has("@nestjs/core") || has("express") || has("fastify") || has("koa") || has("@hapi/hapi") {
        return RepoKind::Backend;
    }
    if in_stack("go") || in_stack("java") || in_stack("php") {
        return RepoKind::Backend;
    }
    if in_stack("rust") && !in_stack("vite") {
        // A Rust repo with no web frontend: a service or a CLI, not a UI.
        return RepoKind::Backend;
    }
    if in_stack("python") && !file("index.html") {
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

    if publishes_entry && !file("index.html") && !is_private {
        return RepoKind::Library;
    }

    // An app shell, or a frontend framework.
    if file("index.html")
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

    // No manifest at all: docs, config, or notes.
    if repo.join("README.md").exists() || repo.join("docs").is_dir() {
        return RepoKind::Docs;
    }

    RepoKind::Unknown
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
    }
}
