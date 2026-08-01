//! GitHub Projects v2, read-only: owner-scoped `gh project` subprocess calls.
//!
//! Sibling to `commands::gh_json`, not a reuse of it — every `gh project`
//! subcommand takes `--owner`, never `--repo`, so there is no `remote_slug` to
//! resolve and no repo path to run the command from. A project can list items
//! from several repos at once, which is the whole point of it.

use crate::model::{
    GithubProjectListResult, GithubProjectRef, GithubProjectSummary, ProjectItem,
    ProjectItemContentType, ProjectItemsResult,
};
use crate::toolchain::Toolchain;
use std::time::Duration;

/// How an owner-scoped `gh project` call can fail before it has produced
/// anything to parse. Same shape as `commands::GhFail`, plus `MissingScope`:
/// Projects v2 needs the `read:project` OAuth scope, which a plain `gh auth
/// login` does not grant — "logged in" and "usable here" are different facts,
/// and the fix text the UI shows differs (`gh auth refresh -s read:project` vs
/// `gh auth login`).
enum GhOwnerFail {
    Missing,
    NotAuthed(String),
    MissingScope(String),
    Failed(String),
}

/// Runs `gh <args> --owner <owner>` and returns its stdout.
///
/// Mirrors `commands::gh_json`: same subprocess hardening, PATH resolution, and
/// 20s ceiling. The difference is that there is no repo to resolve a remote
/// from, so the caller supplies the owner directly.
async fn gh_owner_json(tc: &Toolchain, owner: &str, args: &[&str]) -> Result<String, GhOwnerFail> {
    let gh = tc.path("gh").cloned().ok_or(GhOwnerFail::Missing)?;

    let mut cmd = tokio::process::Command::new(&gh);
    crate::platform::hide_console(&mut cmd);
    cmd.args(args)
        .args(["--owner", owner])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::git::harden(&mut cmd);
    tc.apply_path(&mut cmd);

    let out = match tokio::time::timeout(Duration::from_secs(20), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(GhOwnerFail::Failed(e.to_string())),
        Err(_) => return Err(GhOwnerFail::Failed("gh timed out after 20s".into())),
    };

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let lower = err.to_lowercase();
        // Checked before the generic auth check: gh's real message —
        // "your authentication token is missing required scopes [read:project]"
        // — contains "authentication", which the check below would otherwise
        // match first and report the wrong fix.
        if lower.contains("missing required scope") || lower.contains("read:project") {
            return Err(GhOwnerFail::MissingScope(err));
        }
        if lower.contains("auth") || lower.contains("logged in") || lower.contains("token") {
            return Err(GhOwnerFail::NotAuthed(err));
        }
        return Err(GhOwnerFail::Failed(err));
    }

    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Every item on the configured project, plus its title/URL. Read-only.
pub async fn fetch_items(tc: &Toolchain, project: &GithubProjectRef) -> ProjectItemsResult {
    let number = project.number.to_string();

    let view = match gh_owner_json(
        tc,
        &project.owner,
        &["project", "view", &number, "--format", "json"],
    )
    .await
    {
        Ok(stdout) => stdout,
        Err(GhOwnerFail::Missing) => return ProjectItemsResult::GhMissing,
        Err(GhOwnerFail::NotAuthed(message)) => {
            return ProjectItemsResult::NotAuthenticated { message }
        }
        Err(GhOwnerFail::MissingScope(message)) => {
            return ProjectItemsResult::MissingScope { message }
        }
        Err(GhOwnerFail::Failed(message)) => return ProjectItemsResult::Failed { message },
    };
    let (project_title, project_url) = parse_gh_project_view(&view);

    let items_out = match gh_owner_json(
        tc,
        &project.owner,
        &[
            "project",
            "item-list",
            &number,
            "--format",
            "json",
            "--limit",
            "200",
        ],
    )
    .await
    {
        Ok(stdout) => stdout,
        Err(GhOwnerFail::Missing) => return ProjectItemsResult::GhMissing,
        Err(GhOwnerFail::NotAuthed(message)) => {
            return ProjectItemsResult::NotAuthenticated { message }
        }
        Err(GhOwnerFail::MissingScope(message)) => {
            return ProjectItemsResult::MissingScope { message }
        }
        Err(GhOwnerFail::Failed(message)) => return ProjectItemsResult::Failed { message },
    };

    ProjectItemsResult::Ok {
        owner: project.owner.clone(),
        number: project.number,
        project_title,
        project_url,
        items: parse_gh_project_items(&items_out),
        fetched_unix: crate::git::now_unix(),
    }
}

/// Projects for one owner, for the Settings picker. Read-only.
pub async fn list_projects(tc: &Toolchain, owner: &str) -> GithubProjectListResult {
    match gh_owner_json(
        tc,
        owner,
        &["project", "list", "--format", "json", "--limit", "100"],
    )
    .await
    {
        Ok(stdout) => GithubProjectListResult::Ok {
            projects: parse_gh_project_list(&stdout),
        },
        Err(GhOwnerFail::Missing) => GithubProjectListResult::GhMissing,
        Err(GhOwnerFail::NotAuthed(message)) => {
            GithubProjectListResult::NotAuthenticated { message }
        }
        Err(GhOwnerFail::MissingScope(message)) => {
            GithubProjectListResult::MissingScope { message }
        }
        Err(GhOwnerFail::Failed(message)) => GithubProjectListResult::Failed { message },
    }
}

/// `gh project view <n> --format json`'s title and URL.
///
/// Exact key names unconfirmed on this dev machine — the token here lacks
/// `read:project`, so this could not be checked against a live payload before
/// writing it (see the plan's verification step 1). Falls back to an empty
/// string per field rather than failing the whole fetch over a label.
fn parse_gh_project_view(stdout: &str) -> (String, String) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return (String::new(), String::new());
    };
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let url = v
        .get("url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    (title, url)
}

/// `gh project item-list`'s items.
///
/// Defensive in the same spirit as `commands::parse_gh_workflows`: the exact
/// key names could not be confirmed on this machine (missing `read:project`
/// scope), and `item-list` has no `--json <fields>` selector to pin them down
/// in advance — whatever shape gh's fixed exporter emits is what this parses.
/// Handles both a bare items array and an `{ "items": [...] }` wrapper, since
/// which one gh actually emits is itself one of the unconfirmed facts.
fn parse_gh_project_items(stdout: &str) -> Vec<ProjectItem> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return Vec::new();
    };
    let items: Vec<serde_json::Value> = root
        .get("items")
        .and_then(|v| v.as_array())
        .or_else(|| root.as_array())
        .cloned()
        .unwrap_or_default();

    items
        .into_iter()
        .filter_map(|v| {
            let str_of =
                |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
            let strs_of = |k: &str| -> Vec<String> {
                v.get(k)
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|e| e.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default()
            };

            let content = v.get("content");
            let content_type = match content
                .and_then(|c| c.get("type"))
                .and_then(|t| t.as_str())
            {
                Some("Issue") => ProjectItemContentType::Issue,
                Some("PullRequest") => ProjectItemContentType::PullRequest,
                Some("DraftIssue") => ProjectItemContentType::DraftIssue,
                _ => ProjectItemContentType::Unknown,
            };
            let title = content
                .and_then(|c| c.get("title"))
                .and_then(|t| t.as_str())
                .map(str::to_string)
                .or_else(|| str_of("title"))
                .unwrap_or_default();
            let number = content.and_then(|c| c.get("number")).and_then(|n| n.as_u64());
            let url = content
                .and_then(|c| c.get("url"))
                .and_then(|u| u.as_str())
                .map(str::to_string)
                .or_else(|| str_of("url"));
            // Confirmed against a live payload: the item's own top-level
            // `repository` is a full URL (`https://github.com/owner/repo`), not
            // the `"owner/repo"` slug this field is documented to carry — that
            // slug is `content.repository` instead. A draft issue's `content` has
            // neither, which is correct: it belongs to no repo.
            let repository = content
                .and_then(|c| c.get("repository"))
                .and_then(|r| r.as_str())
                .map(str::to_string);

            Some(ProjectItem {
                id: str_of("id")?,
                title,
                status: str_of("status"),
                assignees: strs_of("assignees"),
                labels: strs_of("labels"),
                content_type,
                repository,
                number,
                url,
            })
        })
        .collect()
}

/// `gh project list`'s projects, for the picker. Same defensiveness as
/// `parse_gh_project_items`, for the same reason.
fn parse_gh_project_list(stdout: &str) -> Vec<GithubProjectSummary> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return Vec::new();
    };
    let items: Vec<serde_json::Value> = root
        .get("projects")
        .and_then(|v| v.as_array())
        .or_else(|| root.as_array())
        .cloned()
        .unwrap_or_default();

    items
        .into_iter()
        .filter_map(|v| {
            Some(GithubProjectSummary {
                number: v.get("number")?.as_u64()? as u32,
                title: v
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                url: v
                    .get("url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                closed: v.get("closed").and_then(|x| x.as_bool()).unwrap_or(false),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a real `gh project item-list 1 --owner Dave-Nguyen-PM
    /// --format json` (gh 2.95.0) against a throwaway test board: one issue with
    /// an assignee and a label, one issue with neither, and a draft issue with no
    /// repository at all. This is what caught `repository` being a full URL at
    /// the top level rather than the `"owner/repo"` slug — that slug lives at
    /// `content.repository` instead.
    const ITEM_LIST_FIXTURE: &str = r#"{"items":[{"assignees":["Dave-Nguyen-PM"],"content":{"body":"Second repo, to confirm the board spans repos.","number":1,"repository":"Dave-Nguyen-PM/anthropool","title":"Test issue: cross-repo project item","type":"Issue","url":"https://github.com/Dave-Nguyen-PM/anthropool/issues/1"},"id":"PVTI_lAHOCza8uM4BfHNtzg07X38","labels":["bug"],"repository":"https://github.com/Dave-Nguyen-PM/anthropool","status":"Todo","title":"Test issue: cross-repo project item"},{"content":{"body":"Created to verify the GitHub Projects v2 read-only feature end-to-end.","number":1,"repository":"Dave-Nguyen-PM/work-alley","title":"Test issue: read-only Projects board","type":"Issue","url":"https://github.com/Dave-Nguyen-PM/work-alley/issues/1"},"id":"PVTI_lAHOCza8uM4BfHNtzg07X8k","repository":"https://github.com/Dave-Nguyen-PM/work-alley","status":"Todo","title":"Test issue: read-only Projects board"},{"content":{"body":"A draft issue, to confirm items with no repository render correctly.","id":"DI_lAHOCza8uM4BfHNtzgK3iPo","title":"Test draft item: no repo","type":"DraftIssue"},"id":"PVTI_lAHOCza8uM4BfHNtzg07X-o","status":"Todo","title":"Test draft item: no repo"}],"totalCount":3}"#;

    /// Captured from a real `gh project view 1 --owner Dave-Nguyen-PM --format
    /// json` against the same board.
    const VIEW_FIXTURE: &str = r#"{"closed":false,"fields":{"totalCount":13},"id":"PVT_kwHOCza8uM4BfHNt","items":{"totalCount":3},"number":1,"owner":{"login":"Dave-Nguyen-PM","type":"User"},"public":false,"readme":"","shortDescription":"","title":"Work Alley test board","url":"https://github.com/users/Dave-Nguyen-PM/projects/1"}"#;

    /// Captured from a real `gh project list --owner Dave-Nguyen-PM --format json`.
    const LIST_FIXTURE: &str = r#"{"projects":[{"closed":false,"fields":{"totalCount":13},"id":"PVT_kwHOCza8uM4BfHNt","items":{"totalCount":3},"number":1,"owner":{"login":"Dave-Nguyen-PM","type":"User"},"public":false,"readme":"","shortDescription":"","title":"Work Alley test board","url":"https://github.com/users/Dave-Nguyen-PM/projects/1"}],"totalCount":1}"#;

    #[test]
    fn garbage_parses_to_nothing_rather_than_panicking() {
        for bad in ["", "not json", "{}", "[null]", "[1,2]"] {
            assert!(parse_gh_project_items(bad).is_empty(), "items: {bad:?}");
            assert!(parse_gh_project_list(bad).is_empty(), "list: {bad:?}");
            assert_eq!(parse_gh_project_view(bad), (String::new(), String::new()));
        }
    }

    #[test]
    fn parses_a_real_item_list() {
        let items = parse_gh_project_items(ITEM_LIST_FIXTURE);
        assert_eq!(items.len(), 3);

        let issue = &items[0];
        assert_eq!(issue.title, "Test issue: cross-repo project item");
        assert_eq!(issue.status.as_deref(), Some("Todo"));
        assert_eq!(issue.assignees, vec!["Dave-Nguyen-PM".to_string()]);
        assert_eq!(issue.labels, vec!["bug".to_string()]);
        assert_eq!(issue.content_type, ProjectItemContentType::Issue);
        // The regression this guards: the item's own top-level `repository` is a
        // full URL, not this slug — only `content.repository` is.
        assert_eq!(issue.repository.as_deref(), Some("Dave-Nguyen-PM/anthropool"));
        assert_eq!(issue.number, Some(1));
        assert_eq!(
            issue.url.as_deref(),
            Some("https://github.com/Dave-Nguyen-PM/anthropool/issues/1")
        );

        let unassigned = &items[1];
        assert!(unassigned.assignees.is_empty());
        assert!(unassigned.labels.is_empty());

        let draft = &items[2];
        assert_eq!(draft.title, "Test draft item: no repo");
        assert_eq!(draft.content_type, ProjectItemContentType::DraftIssue);
        assert_eq!(draft.repository, None);
        assert_eq!(draft.number, None);
        assert_eq!(draft.url, None);
    }

    #[test]
    fn parses_a_real_view() {
        let (title, url) = parse_gh_project_view(VIEW_FIXTURE);
        assert_eq!(title, "Work Alley test board");
        assert_eq!(url, "https://github.com/users/Dave-Nguyen-PM/projects/1");
    }

    #[test]
    fn parses_a_real_list() {
        let projects = parse_gh_project_list(LIST_FIXTURE);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].number, 1);
        assert_eq!(projects[0].title, "Work Alley test board");
        assert!(!projects[0].closed);
    }
}
