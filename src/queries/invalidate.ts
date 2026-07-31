import { keys } from './keys'
import type { RepoId } from '@/domain/types'

/**
 * Which per-repo queries a finished run can have made stale.
 *
 * A table rather than "invalidate everything for this repo", for two reasons.
 *
 * `keys.prs` is a `gh` network round trip with a 20s ceiling in Rust, so firing it
 * after every run turns a free local inspection into a network call per click.
 *
 * And the read-only inspections — status, diff, log graph — change nothing on
 * disk. Refetching after them would be pure waste: the answer cannot have moved.
 *
 * Returns key *prefixes*: react-query matches partially, so ['repoCommits', id]
 * clears every page size under it.
 */
export function staleKeysFor(kind: string, id: RepoId): readonly unknown[][] {
  const changed = [...keys.changedFiles(id)]
  const commits = ['repoCommits', id]
  const branches = [...keys.branches(id)]
  const prs = [...keys.prs(id)]
  const ghRuns = ['ghRuns', id]
  const deps = [...keys.repoPackages(id)]
  const depUpdates = [...keys.repoPackageUpdates(id)]

  // The run list itself always moved: a run just finished.
  const always = [[...keys.runs]]

  switch (kind) {
    // Moves HEAD and the working tree, so everything about this repo is suspect.
    case 'pull':
    case 'pullMany':
    case 'push':
    case 'checkout':
      // package.json moves with the working tree, and with it every version in
      // the dependency table.
      return [changed, commits, branches, prs, deps, depUpdates, ...always]

    // A fetch moves remote refs only — the working tree is untouched, so the
    // changed-file list cannot have changed.
    case 'fetchAll':
    case 'fetchMany':
      return [commits, branches, ...always]

    // A commit empties the index and moves HEAD, so the file list, the log and the
    // branch's ahead count have all moved. Not `prs`: a local commit cannot change
    // what GitHub thinks, and that key is a network round trip.
    case 'commit':
      return [changed, commits, branches, ...always]

    case 'stash':
    case 'stashPop':
    case 'discardChanges':
      return [changed, ...always]

    // A `format` or `lint:fix` rewrites files, and almost any script can touch a
    // lockfile. Commits and branches cannot move without a git command.
    case 'runScript':
      return [changed, deps, ...always]

    // An install rewrites package.json and the lockfile, so the changed-file list,
    // the installed column and the outdated answer have all moved. Not the commit
    // or branch keys: nothing here runs git.
    case 'upgradeDep':
      return [changed, deps, depUpdates, ...always]

    case 'prList':
      return [prs, ...always]

    // Which identity is active moved, and it is read from `git config` rather than
    // remembered — so the page has to ask again. Also `bootstrap`, whose readiness
    // block reports the git identity, and `setupPlan`, which has a step for it.
    // Nothing about the repos themselves changed: no commit, no ref, no file.
    case 'useGitAccount':
      return [[...keys.gitAccounts], [...keys.bootstrap], [...keys.setupPlan], ...always]

    // A re-run or a cancel changes what GitHub reports and nothing on disk, so
    // none of the git views move. The prefix covers every workflow filter.
    case 'ghRunRerun':
    case 'ghRunCancel':
    case 'ghWorkflowRun':
      return [ghRuns, ...always]

    // Read-only, or nothing to do with git state: status, diff, logGraph,
    // branchList, stashList, openShell, openInEditor, killPort, dockerPs…
    default:
      return always
  }
}
