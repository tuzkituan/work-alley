//! Setting up a new workspace from a list of git URLs.
//!
//! The parsing here is the security boundary for the clone action: every target
//! directory is `root.join(name)`, and `name` comes out of a URL the user pasted.
//! So a name is only ever accepted as a single, plain path segment — never
//! anything that could climb out of the workspace or collide with a dotfile.

use serde::Serialize;

/// A repository to clone, and the directory name it will land in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoUrl {
    pub url: String,
    /// Directory name, derived from the last path segment of the URL.
    pub name: String,
    /// Host, shown so the user can confirm they are cloning from where they meant.
    pub host: String,
}

/// A line that could not be used, with the reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedLine {
    /// 1-based, so it matches what the textarea shows.
    pub line: usize,
    pub text: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedUrls {
    pub repos: Vec<RepoUrl>,
    pub rejected: Vec<RejectedLine>,
}

/// Parses pasted git URLs, one per line.
///
/// Blank lines and `#` comments are skipped silently. Everything else either
/// becomes a repo or an explained rejection — nothing is dropped quietly, because
/// a URL that vanishes from a list of 40 is a repo the user will not notice is
/// missing until much later.
pub fn parse_repo_urls(text: &str) -> ParsedUrls {
    let mut out = ParsedUrls::default();

    for (i, raw) in text.lines().enumerate() {
        let line = i + 1;
        // Tolerate list punctuation: trailing commas and surrounding quotes are
        // what you get from pasting out of JSON or a spreadsheet.
        let t = raw.trim().trim_end_matches(',').trim_matches(['"', '\'']);
        if t.is_empty() || t.starts_with('#') {
            continue;
        }

        match parse_one(t) {
            Ok(repo) => {
                if let Some(prev) = out.repos.iter().find(|r| r.name == repo.name) {
                    // Two URLs wanting the same directory: cloning both would put
                    // the second on top of the first.
                    out.rejected.push(RejectedLine {
                        line,
                        text: t.to_string(),
                        reason: format!("would clone into \"{}\", same as {}", repo.name, prev.url),
                    });
                } else {
                    out.repos.push(repo);
                }
            }
            Err(reason) => out.rejected.push(RejectedLine {
                line,
                text: t.to_string(),
                reason,
            }),
        }
    }

    out
}

fn parse_one(s: &str) -> Result<RepoUrl, String> {
    let (host, path) = split_host_path(s)?;
    let name = repo_name(path)?;
    Ok(RepoUrl {
        url: s.to_string(),
        name,
        host,
    })
}

/// Splits the three URL shapes git accepts for a remote.
fn split_host_path(s: &str) -> Result<(String, &str), String> {
    // scp-like: git@host:org/repo.git
    if !s.contains("://") {
        let Some((userhost, path)) = s.split_once(':') else {
            return Err("not a git URL — expected git@host:org/repo or https://host/org/repo".into());
        };
        if path.is_empty() {
            return Err("no repository path after the colon".into());
        }
        let host = userhost.rsplit('@').next().unwrap_or(userhost);
        if host.is_empty() {
            return Err("no host".into());
        }
        return Ok((host.to_string(), path));
    }

    let (scheme, rest) = s.split_once("://").unwrap();
    match scheme {
        "https" | "http" | "ssh" | "git" => {}
        // file:// and local paths are deliberately not offered here: this screen
        // is for setting up from remotes, and a local path is a copy, not a clone
        // anyone means to make.
        other => return Err(format!("unsupported scheme \"{other}\"")),
    }
    let Some((authority, path)) = rest.split_once('/') else {
        return Err("no repository path in the URL".into());
    };
    let hostport = authority.rsplit('@').next().unwrap_or(authority);
    let host = hostport.split(':').next().unwrap_or(hostport);
    if host.is_empty() {
        return Err("no host".into());
    }
    Ok((host.to_string(), path))
}

/// The directory name a clone lands in: the last path segment, minus `.git`.
///
/// Validated as a plain single segment. This is what stops a crafted URL from
/// choosing a path outside the workspace.
fn repo_name(path: &str) -> Result<String, String> {
    let last = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    let name = last.strip_suffix(".git").unwrap_or(last);

    if name.is_empty() {
        return Err("no repository name in the URL".into());
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return Err(format!("\"{name}\" is not a usable directory name"));
    }
    // A whitelist, not a blacklist. Real repository names are alphanumerics with
    // dots, dashes and underscores; anything else is either a portability problem
    // or a shell metacharacter, and enumerating the bad ones always misses some.
    if let Some(bad) = name.chars().find(|c| !is_name_char(*c)) {
        return Err(format!("\"{name}\" contains {bad:?}, which is not allowed in a folder name"));
    }
    Ok(name.to_string())
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(text: &str) -> Vec<String> {
        parse_repo_urls(text).repos.into_iter().map(|r| r.name).collect()
    }

    #[test]
    fn accepts_the_three_shapes_git_supports() {
        let text = "\
git@github.com:acme/web.git
https://github.com/acme/api.git
ssh://git@git.example.com:2222/acme/worker.git
https://gitlab.com/acme/group/subgroup/deep-repo";
        let p = parse_repo_urls(text);
        assert_eq!(p.rejected, vec![], "all four should parse");
        assert_eq!(names(text), ["web", "api", "worker", "deep-repo"]);
        assert_eq!(p.repos[0].host, "github.com");
        assert_eq!(p.repos[2].host, "git.example.com");
    }

    #[test]
    fn skips_blank_lines_and_comments_without_complaining() {
        let p = parse_repo_urls("\n# my repos\n\ngit@github.com:acme/web.git\n\n");
        assert_eq!(p.repos.len(), 1);
        assert_eq!(p.rejected, vec![]);
    }

    #[test]
    fn tolerates_paste_punctuation() {
        // What you get from pasting out of JSON or a spreadsheet column.
        let p = parse_repo_urls("\"https://github.com/acme/web.git\",\n'git@github.com:acme/api'");
        assert_eq!(p.repos.len(), 2, "{:?}", p.rejected);
        assert_eq!(p.repos[0].name, "web");
        assert_eq!(p.repos[1].name, "api");
    }

    #[test]
    fn a_name_can_never_escape_the_workspace() {
        // The whole point of validating: every target is root.join(name).
        for url in [
            "https://github.com/acme/..",
            "https://github.com/acme/.",
            "git@github.com:acme/.ssh",
        ] {
            let p = parse_repo_urls(url);
            assert!(p.repos.is_empty(), "{url} must be rejected");
            assert_eq!(p.rejected.len(), 1);
        }
    }

    #[test]
    fn rejects_non_git_input_with_a_reason_and_a_line_number() {
        let p = parse_repo_urls("git@github.com:acme/web.git\nnot a url at all\nfile:///tmp/x");
        assert_eq!(p.repos.len(), 1);
        assert_eq!(p.rejected.len(), 2);
        assert_eq!(p.rejected[0].line, 2);
        assert_eq!(p.rejected[1].line, 3);
        assert!(p.rejected[1].reason.contains("file"), "{:?}", p.rejected[1]);
        assert!(!p.rejected[0].reason.is_empty());
    }

    #[test]
    fn two_urls_wanting_the_same_folder_is_an_error_not_a_silent_overwrite() {
        let p = parse_repo_urls("git@github.com:one/web.git\nhttps://gitlab.com/two/web.git");
        assert_eq!(p.repos.len(), 1);
        assert_eq!(p.rejected.len(), 1);
        assert!(p.rejected[0].reason.contains("same as"));
    }

    #[test]
    fn shell_metacharacters_in_a_name_are_rejected() {
        // The name is interpolated into a generated bash command, so this is the
        // line of defence against a crafted URL running a second command.
        for url in [
            "https://github.com/acme/web;rm -rf x",
            "https://github.com/acme/we$b",
            "https://github.com/acme/we`id`b",
            "https://github.com/acme/we b",
        ] {
            let p = parse_repo_urls(url);
            assert!(p.repos.is_empty(), "{url} must be rejected");
        }
    }

    #[test]
    fn ordinary_names_still_pass() {
        assert_eq!(
            names("https://github.com/acme/my-repo.v2_beta"),
            ["my-repo.v2_beta"]
        );
    }

    #[test]
    fn a_trailing_slash_does_not_lose_the_name() {
        assert_eq!(names("https://github.com/acme/web/"), ["web"]);
    }
}
