//! Dart and Flutter dependencies: `pubspec.yaml`, the pub cache, and `pub outdated`.
//!
//! The second ecosystem the Packages tab understands, after npm. It is separate
//! from `deps.rs` rather than folded into it because almost nothing is shared: pub
//! has no `node_modules` to read a version out of, its manifest is YAML, and its
//! outdated report is a different shape with an extra column (`resolvable`) that npm
//! has no equivalent for.
//!
//! What *is* shared is the invariant, and it is the important part: **not knowing is
//! a third answer**. A repo whose packages have never been fetched, a machine with
//! no Flutter SDK, a `pub outdated` that failed — none of those may be reported as
//! "up to date". They come back as `checked: false` with a reason, exactly as the
//! npm path does.

use crate::model::{DepUpdate, DepUpdateReport, RepoDep, RepoPackages};
use crate::deps::capture_status_in;
use crate::pkg::DepField;
use crate::toolchain::Toolchain;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

/// `pub outdated` resolves the whole dependency graph against pub.dev.
const OUTDATED_TIMEOUT: Duration = Duration::from_secs(60);

pub fn is_pub_repo(repo: &Path) -> bool {
    repo.join("pubspec.yaml").is_file()
}

/// The repo's dependency table. Manifest plus the pub cache; no network.
pub fn list(repo: &Path) -> RepoPackages {
    let Ok(text) = std::fs::read_to_string(repo.join("pubspec.yaml")) else {
        return RepoPackages::default();
    };
    let installed = installed_versions(repo);
    let declared = parse_pubspec(&text);

    RepoPackages {
        has_manifest: true,
        manifest: Some("pubspec.yaml".into()),
        // Flutter drives pub for a Flutter app — `dart pub get` in one leaves the
        // Flutter SDK packages unresolved — so the label has to say which.
        manager: Some(if is_flutter(&text) { "flutter pub" } else { "dart pub" }.into()),
        installed_tree: !installed.is_empty(),
        deps: declared
            .into_iter()
            .map(|(name, field, range)| RepoDep {
                installed: installed.get(&name).cloned(),
                // The pub equivalents of npm's `workspace:`/`file:` ranges: a path
                // or git dependency resolves to something local, so there is no
                // published version for this app to offer.
                linked: range.starts_with("path:") || range.starts_with("git:"),
                name,
                field,
                range,
            })
            .collect(),
    }
}

/// Whether this pubspec is a Flutter package rather than a plain Dart one.
pub fn is_flutter(pubspec: &str) -> bool {
    pubspec.contains("sdk: flutter") || pubspec.contains("flutter:")
}

/// `(name, field, range)` for every declared dependency, in manifest order.
///
/// Hand-walked rather than deserialised into a struct: a range is a string
/// (`^1.2.0`), a map (`sdk: flutter`, `git: …`, `path: …`) or null (`any`), and the
/// map cases are exactly the ones the table has to show differently. Rendering
/// `[object]` for half a Flutter app's dependencies would be worse than the parse
/// being a few lines longer.
pub fn parse_pubspec(text: &str) -> Vec<(String, DepField, String)> {
    use yaml_rust2::{Yaml, YamlLoader};

    let Ok(docs) = YamlLoader::load_from_str(text) else {
        return Vec::new();
    };
    let Some(doc) = docs.first() else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (key, field) in [
        ("dependencies", DepField::Dependencies),
        ("dev_dependencies", DepField::DevDependencies),
        // Rare, and the same shape. Reported as peers because that is what they
        // are: a constraint on whoever depends on this package.
        ("dependency_overrides", DepField::PeerDependencies),
    ] {
        let Yaml::Hash(map) = &doc[key] else { continue };
        for (name, value) in map {
            let Some(name) = name.as_str() else { continue };
            out.push((name.to_string(), field, describe(value)));
        }
    }
    out
}

/// How a dependency's constraint reads in the table.
fn describe(value: &yaml_rust2::Yaml) -> String {
    use yaml_rust2::Yaml;
    match value {
        Yaml::String(s) => s.clone(),
        Yaml::Real(_) | Yaml::Integer(_) => s_or_number(value),
        // `http:` with nothing after it means "any version", which is what pub
        // itself calls it.
        Yaml::Null | Yaml::BadValue => "any".into(),
        Yaml::Hash(h) => {
            // The three forms that are not a version range, each named by its key.
            for key in ["sdk", "path", "git", "hosted"] {
                if let Some(v) = h.get(&Yaml::String(key.into())) {
                    let detail = v.as_str().map(str::to_string).unwrap_or_else(|| {
                        // `git: {url: …, ref: …}` — the url is the useful half.
                        v["url"].as_str().unwrap_or("").to_string()
                    });
                    return if detail.is_empty() {
                        key.to_string()
                    } else {
                        format!("{key}: {detail}")
                    };
                }
            }
            // A hosted dependency with an explicit version.
            h.get(&Yaml::String("version".into()))
                .and_then(|v| v.as_str())
                .unwrap_or("any")
                .to_string()
        }
        _ => s_or_number(value),
    }
}

fn s_or_number(value: &yaml_rust2::Yaml) -> String {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_i64().map(|n| n.to_string()))
        .or_else(|| value.as_f64().map(|n| n.to_string()))
        .unwrap_or_else(|| "any".into())
}

/// What is actually resolved, from `.dart_tool/package_config.json`.
///
/// The version is not a field in that file — it is the tail of the cache path,
/// `…/hosted/pub.dev/http-1.2.0`. That looks fragile and is not: the layout is pub's
/// own contract with itself, every tool that inspects a cache relies on it, and a
/// path that does not match simply yields no version rather than a wrong one.
///
/// A path or git dependency has no version in its rootUri, which is correct — the
/// table shows those as linked.
pub fn installed_versions(repo: &Path) -> HashMap<String, String> {
    let Ok(text) = std::fs::read_to_string(repo.join(".dart_tool/package_config.json")) else {
        return HashMap::new();
    };
    parse_package_config(&text)
}

pub fn parse_package_config(text: &str) -> HashMap<String, String> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for entry in json["packages"].as_array().into_iter().flatten() {
        let (Some(name), Some(root)) = (entry["name"].as_str(), entry["rootUri"].as_str()) else {
            continue;
        };
        if let Some(version) = version_from_cache_path(name, root) {
            out.insert(name.to_string(), version);
        }
    }
    out
}

/// `…/hosted/pub.dev/http-1.2.0` → `1.2.0`, for that package only.
fn version_from_cache_path(name: &str, root: &str) -> Option<String> {
    let last = root.trim_end_matches('/').rsplit('/').next()?;
    let rest = last.strip_prefix(name)?.strip_prefix('-')?;
    // A version starts with a digit. Without this, `flutter_test` inside
    // `flutter_test_utils-1.0.0` would come back as `utils-1.0.0`.
    rest.chars().next().filter(char::is_ascii_digit).map(|_| rest.to_string())
}

// --- the network half -------------------------------------------------------

/// `pub outdated --json`, which answers for the whole repo in one call.
///
/// Through `flutter` when this is a Flutter package and `dart` otherwise: running
/// `dart pub outdated` in a Flutter app reports every Flutter SDK package as
/// unresolvable, which reads as a broken repo rather than a wrong command.
pub async fn check_updates(repo: &Path, tc: &Toolchain) -> DepUpdateReport {
    let Ok(text) = std::fs::read_to_string(repo.join("pubspec.yaml")) else {
        return DepUpdateReport {
            reason: Some("This repo has no pubspec.yaml.".into()),
            ..Default::default()
        };
    };

    let flutter = is_flutter(&text);
    let tool = if flutter { "flutter" } else { "dart" };
    let Some(bin) = tc.path(tool) else {
        return DepUpdateReport {
            reason: Some(format!(
                "{tool} is not installed, so pub cannot say what is out of date."
            )),
            ..Default::default()
        };
    };

    // pub exits non-zero when anything is outdated, exactly as npm does, so the
    // code is not the test — whether the JSON parsed is.
    let (stdout, code) = capture_status_in(
        bin,
        &["pub", "outdated", "--json"],
        repo,
        &tc.path_env,
        OUTDATED_TIMEOUT,
    )
    .await;

    if code.is_none() {
        return DepUpdateReport {
            reason: Some(format!(
                "`{tool} pub outdated` did not finish within {}s.",
                OUTDATED_TIMEOUT.as_secs()
            )),
            ..Default::default()
        };
    }

    match parse_pub_outdated(&stdout) {
        Some(updates) => DepUpdateReport {
            checked: true,
            source: format!("{tool} pub"),
            updates,
            reason: None,
        },
        None => DepUpdateReport {
            reason: Some(format!(
                "`{tool} pub outdated` returned something this build could not read. \
                 Run it in a terminal to see what it said."
            )),
            ..Default::default()
        },
    }
}

/// Parses `pub outdated --json`.
///
/// Shape: `{"packages":[{"package":"http","current":{"version":"1.1.0"},
/// "upgradable":{…},"resolvable":{…},"latest":{"version":"1.2.0"}}]}`. Any of the
/// four can be null — a discontinued package has no `latest`, and one that is not
/// installed has no `current`.
///
/// `upgradable` is npm's `wanted`: the newest the declared constraint already
/// allows. `resolvable` — what could be had by loosening *other* constraints — has
/// no npm equivalent and is dropped rather than mislabelled.
///
/// Returns None when the output is not pub's JSON at all, so the caller can say
/// "could not read" rather than "nothing is out of date".
pub fn parse_pub_outdated(stdout: &str) -> Option<Vec<DepUpdate>> {
    let json: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let packages = json.get("packages")?.as_array()?;

    let version = |v: &serde_json::Value, key: &str| -> Option<String> {
        v.get(key)?.get("version")?.as_str().map(str::to_string)
    };

    Some(
        packages
            .iter()
            .filter_map(|p| {
                let name = p.get("package")?.as_str()?.to_string();
                let latest = version(p, "latest");
                let wanted = version(p, "upgradable");
                let current = version(p, "current");
                // Only rows that are actually behind. `pub outdated --json` lists
                // every dependency, unlike `npm outdated`, so without this the
                // "updates" count would be the dependency count.
                let behind = match (&current, &latest, &wanted) {
                    (Some(c), Some(l), _) if c != l => true,
                    (Some(c), _, Some(w)) if c != w => true,
                    // Never resolved locally: worth showing, since installing it is
                    // exactly what the row would prompt.
                    (None, Some(_), _) => true,
                    _ => false,
                };
                behind.then_some(DepUpdate {
                    name,
                    latest,
                    wanted,
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBSPEC: &str = r#"
name: my_app
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
  http: ^1.1.0
  provider: 6.1.1
  shared_prefs:
  local_thing:
    path: ../local_thing
  from_git:
    git:
      url: https://github.com/x/y.git
      ref: main
dev_dependencies:
  flutter_test:
    sdk: flutter
  very_good_analysis: ^5.1.0
"#;

    #[test]
    fn a_pubspec_yields_every_declaration_with_its_constraint() {
        let deps = parse_pubspec(PUBSPEC);
        let get = |name: &str| deps.iter().find(|(n, _, _)| n == name).map(|(_, f, r)| (*f, r.clone()));

        assert_eq!(get("http"), Some((DepField::Dependencies, "^1.1.0".into())));
        // A bare version, which YAML reads as a number-ish scalar rather than a string.
        assert_eq!(get("provider"), Some((DepField::Dependencies, "6.1.1".into())));
        // The three map forms, each named by the key that makes it not a version.
        assert_eq!(get("flutter"), Some((DepField::Dependencies, "sdk: flutter".into())));
        assert_eq!(get("local_thing"), Some((DepField::Dependencies, "path: ../local_thing".into())));
        assert_eq!(
            get("from_git"),
            Some((DepField::Dependencies, "git: https://github.com/x/y.git".into()))
        );
        // `shared_prefs:` with nothing after it means any version.
        assert_eq!(get("shared_prefs"), Some((DepField::Dependencies, "any".into())));
        assert_eq!(
            get("very_good_analysis"),
            Some((DepField::DevDependencies, "^5.1.0".into()))
        );
    }

    #[test]
    fn a_path_or_git_dependency_is_linked_and_has_nothing_to_upgrade() {
        let d = std::env::temp_dir().join(format!("wa-pub-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("pubspec.yaml"), PUBSPEC).unwrap();

        let table = list(&d);
        assert_eq!(table.manifest.as_deref(), Some("pubspec.yaml"));
        // A Flutter package, so pub is driven through flutter.
        assert_eq!(table.manager.as_deref(), Some("flutter pub"));
        let linked: Vec<&str> = table
            .deps
            .iter()
            .filter(|d| d.linked)
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(linked, vec!["local_thing", "from_git"]);
    }

    #[test]
    fn a_plain_dart_package_is_driven_through_dart() {
        assert!(!is_flutter("name: x\ndependencies:\n  http: ^1.0.0\n"));
        assert!(is_flutter("dependencies:\n  flutter:\n    sdk: flutter\n"));
    }

    #[test]
    fn the_installed_version_comes_out_of_the_cache_path() {
        let config = r#"{"packages":[
          {"name":"http","rootUri":"file:///home/u/.pub-cache/hosted/pub.dev/http-1.2.0/"},
          {"name":"provider","rootUri":"file:///home/u/.pub-cache/hosted/pub.dev/provider-6.1.1"},
          {"name":"local_thing","rootUri":"../../local_thing"},
          {"name":"my_app","rootUri":"../"}
        ]}"#;
        let got = parse_package_config(config);
        assert_eq!(got.get("http").map(String::as_str), Some("1.2.0"));
        assert_eq!(got.get("provider").map(String::as_str), Some("6.1.1"));
        // A path dependency has no version in its path, which is correct: there is
        // no published version to report.
        assert_eq!(got.get("local_thing"), None);
    }

    #[test]
    fn a_prefix_collision_does_not_borrow_another_packages_version() {
        // `flutter_test` inside `flutter_test_utils-1.0.0` would otherwise come back
        // as "utils-1.0.0", which is not a version at all.
        let config = r#"{"packages":[
          {"name":"flutter_test","rootUri":"file:///c/hosted/pub.dev/flutter_test_utils-1.0.0"}
        ]}"#;
        assert!(parse_package_config(config).is_empty());
    }

    #[test]
    fn nonsense_yields_nothing_rather_than_panicking() {
        for input in ["", "not json", "{}", r#"{"packages":null}"#] {
            assert!(parse_package_config(input).is_empty(), "{input:?}");
        }
        for input in ["", "\t- not: [yaml", "42"] {
            let _ = parse_pubspec(input);
        }
    }

    #[test]
    fn outdated_reports_only_what_is_behind() {
        let json = r#"{"packages":[
          {"package":"http","current":{"version":"1.1.0"},"upgradable":{"version":"1.1.2"},
           "resolvable":{"version":"1.2.0"},"latest":{"version":"1.2.0"}},
          {"package":"provider","current":{"version":"6.1.1"},"upgradable":{"version":"6.1.1"},
           "resolvable":{"version":"6.1.1"},"latest":{"version":"6.1.1"}},
          {"package":"never_fetched","current":null,"upgradable":{"version":"2.0.0"},
           "resolvable":{"version":"2.0.0"},"latest":{"version":"2.0.0"}}
        ]}"#;
        let got = parse_pub_outdated(json).unwrap();
        let names: Vec<&str> = got.iter().map(|u| u.name.as_str()).collect();
        // `pub outdated --json` lists every dependency, unlike npm's — a package at
        // its latest version must not be reported as an update.
        assert_eq!(names, vec!["http", "never_fetched"]);

        let http = &got[0];
        assert_eq!(http.latest.as_deref(), Some("1.2.0"));
        // pub's `upgradable` is npm's `wanted`: the best the constraint allows.
        assert_eq!(http.wanted.as_deref(), Some("1.1.2"));
    }

    #[test]
    fn a_discontinued_package_with_no_latest_is_not_an_update() {
        let json = r#"{"packages":[
          {"package":"dead","current":{"version":"1.0.0"},"upgradable":{"version":"1.0.0"},
           "resolvable":null,"latest":null}
        ]}"#;
        assert!(parse_pub_outdated(json).unwrap().is_empty());
    }

    #[test]
    fn unreadable_output_is_not_reported_as_up_to_date() {
        // The invariant the whole module is built on. `None` becomes "could not
        // read"; an empty Vec would become "nothing is out of date".
        assert!(parse_pub_outdated("").is_none());
        assert!(parse_pub_outdated("Waiting for another flutter command...").is_none());
        assert!(parse_pub_outdated("{}").is_none());
        assert!(parse_pub_outdated(r#"{"packages":[]}"#).unwrap().is_empty());
    }
}
