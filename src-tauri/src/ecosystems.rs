//! Which languages and frameworks this app knows about, as one table.
//!
//! Three features need the same answer and used to derive it three different ways:
//! the repo table wants to *label* a repo, the Toolbox wants to know which tools a
//! stack implies, and Guided setup wants the steps that install them. The third is
//! a user preference — "these are the stacks I work in" — which means the list has
//! to be enumerable and stable-id'd rather than implied by control flow, and that
//! is what this file is.
//!
//! Deliberately coarser than `detect.rs`. That module answers "what *is* this
//! repo" and is specific — `next`, `vite`, `nestjs` are three different answers.
//! This one answers "what does this machine need installed", where all three are
//! the same answer: Node. So a stack here collects the detected strings that imply
//! it (`stacks`) and names what follows from that (`tools`, `steps`).
//!
//! Detection is not repeated here. Every stack is recognised through the
//! `RepoShape::stack` strings `detect.rs` already produces, so there is exactly one
//! place that looks at a repo's files and exactly one set of markers to keep right.

use serde::Serialize;

/// How the picker groups stacks. Ordering here is the order they are offered in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Family {
    Web,
    Mobile,
    Backend,
    Systems,
    Infra,
}

impl Family {
    pub fn label(self) -> &'static str {
        match self {
            Family::Web => "Web",
            Family::Mobile => "Mobile",
            Family::Backend => "Backend",
            Family::Systems => "Systems",
            Family::Infra => "Infrastructure",
        }
    }
}

pub struct Stack {
    /// Stable across renames — it is persisted in `config.stacks`.
    pub id: &'static str,
    pub label: &'static str,
    /// One line for the picker. Says what it *is*, not what it does.
    pub hint: &'static str,
    pub family: Family,
    /// `RepoShape::stack` strings that mean "this repo is this stack".
    pub stacks: &'static [&'static str],
    /// Catalog ids in `packages.rs` this stack wants. Drives the Toolbox filter.
    pub tools: &'static [&'static str],
    /// Setup step ids in `setup.rs` that belong to it. Drives the setup filter.
    pub steps: &'static [&'static str],
    /// Chore group names from `chores.rs`, so the two tables cannot drift apart.
    /// Empty is legitimate: a stack can be worth installing tools for and have no
    /// commands of its own yet.
    ///
    /// Read only by the drift test at the bottom of this file, which is the whole
    /// job: it is documentation the compiler checks, not data the app branches on.
    #[allow(dead_code)]
    pub chore_groups: &'static [&'static str],
}

/// Everything the app knows how to work in.
///
/// Tools and steps name ids that must exist in `packages.rs::CATALOG` and
/// `setup.rs::STEPS`; the tests at the bottom enforce that in both directions, the
/// same way `setup.rs` already checks its own package references.
pub const STACKS: &[Stack] = &[
    Stack {
        id: "web",
        label: "Web (JS/TS)",
        hint: "React, Next, Vue, Svelte, Angular, Nest, Express — anything with a package.json",
        family: Family::Web,
        stacks: &[
            "next", "vite", "react", "vue", "svelte", "angular", "nestjs", "express", "fastify",
            "storybook", "nuxt", "astro", "remix", "solid", "qwik", "gatsby", "electron", "deno",
        ],
        tools: &[
            "node", "bun", "pnpm", "yarn", "typescript", "vercel", "serve", "nest", "prisma",
            "pm2", "nodemon",
        ],
        steps: &["nvm", "node", "js-tools", "bun"],
        chore_groups: &["Packages"],
    },
    Stack {
        id: "flutter",
        label: "Flutter",
        hint: "Dart and Flutter, with the Android and iOS toolchains they build through",
        family: Family::Mobile,
        stacks: &["flutter", "dart"],
        tools: &["flutter", "dart", "android-sdk", "cocoapods", "jdk"],
        steps: &["flutter", "android"],
        chore_groups: &["Flutter", "Dart", "Gradle", "CocoaPods", "Xcode"],
    },
    Stack {
        id: "react-native",
        label: "React Native",
        hint: "React Native and Expo — Node plus the same native toolchains as Flutter",
        family: Family::Mobile,
        stacks: &["react-native", "expo"],
        tools: &["node", "watchman", "cocoapods", "android-sdk", "jdk", "eas-cli"],
        steps: &["nvm", "node", "android"],
        chore_groups: &["React Native", "Expo", "Gradle", "CocoaPods", "Xcode"],
    },
    Stack {
        id: "python",
        label: "Python",
        hint: "Django, FastAPI, Flask, and the packaging tools around them",
        family: Family::Backend,
        stacks: &["python", "django", "fastapi", "flask"],
        tools: &["python", "uv", "pipx", "poetry"],
        steps: &["python"],
        chore_groups: &["Python", "Django"],
    },
    Stack {
        id: "rust",
        label: "Rust",
        hint: "Cargo, clippy and rustfmt",
        family: Family::Systems,
        stacks: &["rust"],
        tools: &["rustup", "cargo-watch"],
        steps: &["rust"],
        chore_groups: &["Cargo"],
    },
    Stack {
        id: "go",
        label: "Go",
        hint: "Go modules, vet and the toolchain's own formatter",
        family: Family::Backend,
        stacks: &["go"],
        tools: &["go"],
        steps: &["go"],
        chore_groups: &["Go"],
    },
    Stack {
        id: "java",
        label: "Java / Kotlin",
        hint: "Gradle, Maven and Spring",
        family: Family::Backend,
        stacks: &["java", "spring"],
        tools: &["jdk", "gradle", "maven"],
        steps: &["java"],
        chore_groups: &["Gradle", "Maven"],
    },
    Stack {
        id: "dotnet",
        label: ".NET",
        hint: "C# and the dotnet CLI",
        family: Family::Backend,
        stacks: &["dotnet"],
        tools: &["dotnet"],
        steps: &["dotnet"],
        chore_groups: &["dotnet"],
    },
    Stack {
        id: "php",
        label: "PHP",
        hint: "Composer and Laravel",
        family: Family::Backend,
        stacks: &["php", "laravel"],
        tools: &["php", "composer"],
        steps: &["php"],
        chore_groups: &["Composer", "Artisan"],
    },
    Stack {
        id: "ruby",
        label: "Ruby",
        hint: "Bundler and Rails",
        family: Family::Backend,
        stacks: &["ruby", "rails"],
        tools: &["ruby", "bundler"],
        steps: &["ruby"],
        chore_groups: &["Bundler", "Rails"],
    },
    Stack {
        id: "elixir",
        label: "Elixir",
        hint: "Mix and Phoenix",
        family: Family::Backend,
        stacks: &["elixir", "phoenix"],
        tools: &[],
        steps: &[],
        chore_groups: &["Mix"],
    },
    Stack {
        id: "cpp",
        label: "C / C++",
        hint: "CMake, qmake and Qt",
        family: Family::Systems,
        stacks: &["cmake", "qmake", "qt", "zig", "swift"],
        tools: &["cc", "make"],
        steps: &[],
        chore_groups: &["CMake", "Swift"],
    },
    // The two below are not languages, and are here for the same reason the others
    // are: they own a slice of the catalog that most people never want to see.
    // Without them, "filter the Toolbox to my stacks" would still list kubectl.
    Stack {
        id: "containers",
        label: "Containers",
        hint: "Docker or Podman, and Compose",
        family: Family::Infra,
        stacks: &[],
        tools: &["docker", "podman", "podman-compose"],
        steps: &["containers"],
        chore_groups: &["Compose"],
    },
    Stack {
        id: "cloud",
        label: "Cloud & data",
        hint: "Kubernetes, Terraform, AWS, and the database clients",
        family: Family::Infra,
        stacks: &[],
        tools: &[
            "kubectl", "helm", "k9s", "terraform", "awscli", "psql", "mysql", "redis-cli",
            "sqlite", "mongosh", "kcat", "grpcurl",
        ],
        steps: &["databases", "backend"],
        chore_groups: &[],
    },
];

pub fn find(id: &str) -> Option<&'static Stack> {
    STACKS.iter().find(|s| s.id == id)
}

/// The stacks a repo's detected shape implies. Usually one, sometimes two — a
/// Flutter app with an `android/` Gradle build is both.
pub fn for_shape(shape: &[String]) -> Vec<&'static Stack> {
    STACKS
        .iter()
        .filter(|s| s.stacks.iter().any(|m| shape.iter().any(|d| d == m)))
        .collect()
}

/// Which stacks are in force: the user's choice, or everything when they have not
/// chosen.
///
/// Empty means "no opinion", not "nothing" — a fresh config has no stacks and must
/// still show a full Toolbox. Only an explicit choice narrows anything.
pub fn chosen(config: &[String]) -> Vec<&'static Stack> {
    if config.is_empty() {
        return STACKS.iter().collect();
    }
    config.iter().filter_map(|id| find(id)).collect()
}

/// Whether a catalog tool should be offered, given the stacks in force.
///
/// A tool no stack claims — git, ripgrep, fzf, the shells — is always offered.
/// Those are not a stack's tools, they are the app's, and hiding `git` because
/// someone said "Flutter" would be absurd.
pub fn tool_allowed(tool_id: &str, chosen: &[&'static Stack]) -> bool {
    let claimed = STACKS.iter().any(|s| s.tools.contains(&tool_id));
    !claimed || chosen.iter().any(|s| s.tools.contains(&tool_id))
}

/// Whether a setup step should be offered. Same rule as `tool_allowed`.
pub fn step_allowed(step_id: &str, chosen: &[&'static Stack]) -> bool {
    let claimed = STACKS.iter().any(|s| s.steps.contains(&step_id));
    !claimed || chosen.iter().any(|s| s.steps.contains(&step_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_labels_are_unique() {
        let mut ids: Vec<&str> = STACKS.iter().map(|s| s.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate stack id");
    }

    #[test]
    fn every_tool_exists_in_the_catalog() {
        // The same invariant `setup.rs` holds over its own package references. An id
        // that does not exist would silently hide a tool from every stack that
        // claims it, which looks exactly like the filter working.
        for s in STACKS {
            for t in s.tools {
                assert!(
                    crate::packages::find(t).is_some(),
                    "stack '{}' names unknown tool '{t}'",
                    s.id
                );
            }
        }
    }

    #[test]
    fn every_step_exists_on_some_platform() {
        for s in STACKS {
            for id in s.steps {
                assert!(
                    crate::setup::step_exists(id),
                    "stack '{}' names unknown setup step '{id}'",
                    s.id
                );
            }
        }
    }

    #[test]
    fn every_chore_group_a_stack_claims_exists() {
        // The other half of `chores::GROUPS`. A stack claiming "Flutterr" would
        // look right in this file and own nothing in the app.
        for s in STACKS {
            for g in s.chore_groups {
                assert!(
                    crate::chores::GROUPS.contains(g),
                    "stack '{}' claims unknown chore group '{g}'",
                    s.id
                );
            }
        }
    }

    #[test]
    fn no_two_stacks_claim_the_same_detected_string() {
        // A repo would then belong to two stacks for the same reason, and the
        // Toolbox filter would answer differently depending on which was chosen.
        let mut seen: Vec<(&str, &str)> = Vec::new();
        for s in STACKS {
            for m in s.stacks {
                if let Some((other, _)) = seen.iter().find(|(_, d)| d == m) {
                    panic!("'{m}' is claimed by both '{other}' and '{}'", s.id);
                }
                seen.push((s.id, m));
            }
        }
    }

    #[test]
    fn a_shape_maps_to_its_stacks() {
        let flutter = for_shape(&["flutter".to_string()]);
        assert_eq!(flutter.len(), 1);
        assert_eq!(flutter[0].id, "flutter");

        // The common real case: a Next app is Web, and only Web.
        let web = for_shape(&["next".to_string(), "react".to_string()]);
        assert_eq!(web.iter().map(|s| s.id).collect::<Vec<_>>(), vec!["web"]);

        // An Expo app is React Native, not Web, even though it has a package.json —
        // `react-native`/`expo` are its own strings.
        let rn = for_shape(&["react-native".to_string(), "expo".to_string()]);
        assert_eq!(rn.iter().map(|s| s.id).collect::<Vec<_>>(), vec!["react-native"]);

        assert!(for_shape(&[]).is_empty());
    }

    #[test]
    fn no_choice_means_everything() {
        // A fresh config has no stacks and must still show a full Toolbox: the
        // filter is an opt-in narrowing, never a default.
        assert_eq!(chosen(&[]).len(), STACKS.len());
        // An unknown id — a stack removed in a later build — is skipped rather than
        // treated as "everything", which would silently widen the list back out.
        assert!(chosen(&["nonsense".to_string()]).is_empty());
    }

    #[test]
    fn unclaimed_tools_survive_every_filter() {
        let flutter = chosen(&["flutter".to_string()]);
        assert!(tool_allowed("git", &flutter), "git belongs to no stack");
        assert!(tool_allowed("ripgrep", &flutter));
        assert!(tool_allowed("jdk", &flutter), "flutter claims the JDK");
        assert!(!tool_allowed("kubectl", &flutter));
        assert!(!tool_allowed("rustup", &flutter));

        // And with no choice made, nothing is filtered at all.
        let all = chosen(&[]);
        assert!(tool_allowed("kubectl", &all));
    }

    #[test]
    fn unclaimed_steps_survive_every_filter() {
        let flutter = chosen(&["flutter".to_string()]);
        // git-identity and essentials belong to no stack: every machine needs them.
        assert!(step_allowed("essentials", &flutter));
        assert!(step_allowed("git-identity", &flutter));
        assert!(step_allowed("credentials", &flutter));
        // The Node path is Web's and React Native's, not Flutter's.
        assert!(!step_allowed("js-tools", &flutter));
        assert!(step_allowed("js-tools", &chosen(&["web".to_string()])));
    }

    #[test]
    fn a_shared_tool_shows_for_either_owner() {
        // The JDK is Android's as much as Java's — a cross-link a flat catalog
        // cannot express, and the reason `tools` is a list per stack rather than one
        // owner per tool.
        for id in ["flutter", "react-native", "java"] {
            assert!(tool_allowed("jdk", &chosen(&[id.to_string()])), "{id}");
        }
    }
}
