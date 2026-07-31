/**
 * Web addresses for a repo's commits and branches.
 *
 * The base comes from Rust (`RepoStatus.remoteWebBase`), which resolves the origin
 * remote and returns a URL only for a host the opener capability allows — so a
 * self-hosted GitLab or a repo with no remote yields null here, and the UI renders
 * plain text rather than a link the app would silently refuse to open.
 *
 * The per-forge paths are here rather than in Rust because they are pure string
 * shape and the components need them synchronously, per row.
 */
export function commitUrl(base: string | null, sha: string | null): string | null {
  if (!base || !sha) return null
  // GitLab nests project routes under `/-/` so a group can be called `commit`;
  // Bitbucket pluralises. Either wrong gives a 404, not an error.
  if (base.includes('://gitlab.com/')) return `${base}/-/commit/${sha}`
  if (base.includes('://bitbucket.org/')) return `${base}/commits/${sha}`
  return `${base}/commit/${sha}`
}

export function branchUrl(base: string | null, branch: string | null): string | null {
  if (!base || !branch) return null
  // Slashes stay — `feat/x` is a path on every forge. `#` and `?` would end the
  // path, and git permits neither, but encoding them costs nothing.
  const b = branch.replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/ /g, '%20')
  if (base.includes('://gitlab.com/')) return `${base}/-/tree/${b}`
  if (base.includes('://bitbucket.org/')) return `${base}/src/${b}`
  return `${base}/tree/${b}`
}

/** "github.com" / "gitlab.com" — for a tooltip that says where a link goes. */
export function forgeHost(base: string | null): string | null {
  if (!base) return null
  return base.split('://')[1]?.split('/')[0] ?? null
}
