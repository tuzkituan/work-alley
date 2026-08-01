export const keys = {
  bootstrap: ['bootstrap'] as const,
  config: ['config'] as const,
  commits: ['commits'] as const,
  runs: ['runs'] as const,
  packages: ['packages'] as const,
  packageUpdates: ['packageUpdates'] as const,
  setupPlan: ['setupPlan'] as const,
  stacks: ['stacks'] as const,
  gitAccounts: ['gitAccounts'] as const,
  // Flat: exactly one project is configured at a time, same shape as `gitAccounts`.
  githubProjectItems: ['githubProjectItems'] as const,
  githubProjects: (owner: string) => ['githubProjects', owner] as const,
  sshConfig: ['sshConfig'] as const,
  checkoutPreview: (scope: string, branch: string) =>
    ['checkoutPreview', scope, branch] as const,
  packageVersions: (id: string) => ['packageVersions', id] as const,
  branches: (key: string) => ['branches', key] as const,
  runCommand: (key: string, task: string) => ['runCommand', key, task] as const,
  repoPackages: (key: string) => ['repoPackages', key] as const,
  repoPackageUpdates: (key: string) => ['repoPackageUpdates', key] as const,
  depVersions: (key: string, name: string) => ['depVersions', key, name] as const,
  prs: (key: string) => ['prs', key] as const,
  ghWorkflows: (key: string) => ['ghWorkflows', key] as const,
  // `workflow` last, so invalidating the 2-element prefix ['ghRuns', id] clears
  // every filter at once — the same trick `repoCommits` uses for its page size.
  ghRuns: (key: string, workflow: string) => ['ghRuns', key, workflow] as const,
  ghDispatch: (key: string, workflow: string) => ['ghDispatch', key, workflow] as const,
  changedFiles: (key: string) => ['changedFiles', key] as const,
  stashes: (key: string) => ['stashes', key] as const,
  // `staged` is part of the key: the staged and unstaged halves of one file are two
  // different patches, and sharing a key would show one under the other's row.
  fileDiff: (key: string, path: string, staged: boolean) =>
    ['fileDiff', key, path, staged] as const,
  // `limit` last, so invalidating the 2-element prefix ['repoCommits', id] clears
  // every page size at once — the panel refetches whatever it is currently showing.
  repoCommits: (key: string, limit: number) => ['repoCommits', key, limit] as const,
}
