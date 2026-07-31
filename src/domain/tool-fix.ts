/**
 * Which setup step installs a given tool.
 *
 * So a "tool not available: git" failure can offer to fix itself. Before this, every
 * missing-tool error was a bottom-corner toast with no button, no link and no mention
 * that the app has a page which installs exactly that — and the control that produced
 * it stayed enabled, so it did the same nothing every time.
 *
 * Keyed by the ids `toolchain::tools()` resolves and `Toolchain::require` reports, which
 * is what arrives in `IpcError.detail`.
 */
const STEP_FOR: Record<string, string> = {
  // essentials: git, curl, make, cc, jq
  git: 'essentials',
  curl: 'essentials',
  make: 'essentials',
  cc: 'essentials',
  jq: 'essentials',
  // Node comes from nvm, which is its own step; pointing at `node` is right because
  // that step is blocked with a reason until nvm exists.
  node: 'node',
  // js-tools: pnpm, yarn, typescript. npm arrives with Node itself.
  npm: 'node',
  pnpm: 'js-tools',
  yarn: 'js-tools',
  tsc: 'js-tools',
  typescript: 'js-tools',
  bun: 'bun',
  gh: 'github',
  delta: 'github',
  docker: 'containers',
  podman: 'containers',
  // The per-stack steps. Each of these tools has exactly one step that installs
  // it, so a missing-tool toast can offer to jump there — which is the whole point
  // of this table. Tools that several steps could claim (a JDK is Android's and
  // Java's) point at the more specific one.
  flutter: 'flutter',
  dart: 'flutter',
  adb: 'android',
  javac: 'android',
  gradle: 'java',
  mvn: 'java',
  python3: 'python',
  uv: 'python',
  cargo: 'rust',
  rustc: 'rust',
  go: 'go',
  dotnet: 'dotnet',
  php: 'php',
  composer: 'php',
  ruby: 'ruby',
  bundle: 'ruby',
}

export interface ToolFix {
  /** The step id, for focusing the setup page on it. */
  stepId: string
}

export function toolFix(tool: string | null | undefined): ToolFix | null {
  if (!tool) return null
  const stepId = STEP_FOR[tool]
  return stepId ? { stepId } : null
}
