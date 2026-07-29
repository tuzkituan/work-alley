export const keys = {
  bootstrap: ['bootstrap'] as const,
  commits: ['commits'] as const,
  docker: ['docker'] as const,
  devServers: ['devServers'] as const,
  runs: ['runs'] as const,
  packages: ['packages'] as const,
  checkoutPreview: (scope: string, branch: string) =>
    ['checkoutPreview', scope, branch] as const,
  packageVersions: (id: string) => ['packageVersions', id] as const,
  branches: (key: string) => ['branches', key] as const,
  prs: (key: string) => ['prs', key] as const,
  changedFiles: (key: string) => ['changedFiles', key] as const,
  repoCommits: (key: string) => ['repoCommits', key] as const,
}
