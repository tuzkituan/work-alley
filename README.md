# Work Alley

A desktop dashboard for a folder full of git repositories.

If your work lives in twenty or forty repos, the day starts with the same questions:
what did I leave uncommitted, what is behind its upstream, what is still on a branch I
forgot about, and which of these do I actually have to touch. Work Alley scans the
whole folder and answers those in one window — then lets you fetch, pull, check out,
install, run scripts and open a terminal in any of them without leaving it.

Built with Tauri 2, React 19 and Rust. Linux and Windows.

---

## Install

### Download a package

Grab the latest build from the [Releases page](https://github.com/lewisnguyen2804/work-alley/releases).

| File | For |
| --- | --- |
| `.deb` | Debian, Ubuntu and derivatives |
| `.rpm` | Fedora, RHEL, openSUSE |
| `.AppImage` | any other Linux — no install, just `chmod +x` and run |
| `.exe` | Windows, per-user install — when a build is attached |

The Linux packages declare `webkit2gtk 4.1` and `GTK 3` as dependencies, so your
package manager pulls them in. The Windows installer fetches the WebView2 runtime if it
is missing; it is unsigned, so SmartScreen warns on first run, and it is cross-built
from Linux rather than tested on Windows — see `docs/windows-support-plan.md`.

```bash
sudo apt install ./work-alley_0.1.0_amd64.deb      # Debian / Ubuntu
sudo dnf install ./work-alley-0.1.0-1.x86_64.rpm   # Fedora
chmod +x Work_Alley_0.1.0_amd64.AppImage && ./Work_Alley_0.1.0_amd64.AppImage
```

### Build from source

You need [Rust](https://rustup.rs) (stable), [Bun](https://bun.sh), and on Linux the
Tauri prerequisites:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libxdo-dev libssl-dev patchelf build-essential file wget
```

Then:

```bash
git clone https://github.com/lewisnguyen2804/work-alley.git
cd work-alley
bun install
bun run tauri build     # packages land in src-tauri/target/release/bundle/
```

macOS is not packaged or tested. The Unix code path is shared, so a source build may
work, but nothing here verifies it.

### What Work Alley needs on your machine

Only **git** is truly required. Everything else is optional and unlocks a feature:
`gh` for pull requests and GitHub Actions, `docker` or `podman` for container status,
and whichever runtimes your repos use (`node`/`bun`/`npm`/`pnpm`/`yarn`, `cargo`, `go`,
`python3`, `flutter`/`dart`, `gradle`, `mvn`, `composer`, `dotnet`, …).

You don't have to install those by hand. The **Toolbox** and the **Setup** page inside
the app do it for you, in the right order, with one password prompt instead of five —
see below.

---

## First run

The app opens on a folder picker. There are three ways past it:

1. **Open a folder you already have.** Any directory with git repos in it, or one level
   under it, counts as a workspace.
2. **Clone a new one.** *Set up a new workspace* takes a pasted list of remotes — one
   URL per line, `#` comments and blank lines ignored — picks an empty folder, and
   clones them all into it.
3. **Set up the machine first.** On a fresh install with no tooling, the Setup page
   takes over: it installs git, a Node runtime, `gh` and the rest in dependency order,
   and sets your git identity. It works before any workspace exists.

### How your folder is read

One rule, applied per repo:

```
~/work/
├── frontend/          ← a folder of repos: the folder name is the group
│   ├── web/
│   └── admin/
├── backend/
│   └── api/
└── design-system/     ← a repo sitting directly in the root: grouped by what it
                         is (frontend / backend / library / …), or by language
```

So a workspace that is already organised keeps its organisation, and a flat one gets
grouped by what the repos actually are. Mixed folders get both. `node_modules`,
`target`, `dist`, `build`, `vendor` and dotfolders are skipped.

To pin a workspace for one launch regardless of what is saved:

```bash
WORK_ALLEY_ROOT=~/work work-alley
```

---

## Using it

### The window

- **Left rail** — groups, pinned repos, CI status, and the state of your toolchain.
- **Needs you** — a strip of counts across the top: uncommitted, behind, stale,
  errored, package drift, detached HEAD. They are *filters*, not decoration — click one
  to narrow the table to those repos.
- **Repo table** — one row per repo: branch, ahead/behind, dirty files, last commit, and
  what it is. Click a row to open it.
- **Output pane** — on the right, where everything you start shows up.

### Per-repo detail

Opening a repo gives you tabs for **Changes** (with diffs), **Commits**, **Branches**
(including checkout), **Packages**, **Pull requests**, **GitHub Actions** and **Runs** —
plus an action bar for fetch, pull, install, dev server and scripts.

### Running things

Every action — a pull, a script, a checkout, an install — is built in Rust from a closed
set of operations, shown to you with the exact command line, and only then run.
Destructive ones say what they will touch and how many repos are involved before you
confirm.

Bulk actions work the same way: **Fetch all**, **Pull all**, and checkout-across-repos
run over the whole workspace or a selection, with per-repo progress in the log.

### The output pane

Runs and terminals are grouped into **scopes** — the workspace, plus a tab per repo that
has something happening in it. Starting something brings it to the front: the pane
switches to its scope and shows its log. A tab you are not on shows a blinking dot and a
count when its scope is busy, so a run elsewhere is one click away rather than invisible.
Tabs stay until you close them with their `×`.

`+` opens a real terminal (a pty, with full colour and interactivity) in the current
scope's folder. `Ctrl+C` cancels the run on screen.

### The Toolbox and Setup

Machine-scoped, full-window pages that work with no workspace open:

- **Toolbox** — install, upgrade or remove developer tooling from a curated list. It
  knows what is installed and what has an update waiting.
- **Setup** — the ordered first-run sequence for a bare machine.
- **Git accounts** — several git identities (name, email, SSH key, `gh` login) that you
  switch between per machine.

### Keyboard

| Key | Does |
| --- | --- |
| `Ctrl`/`⌘` + `K` | Command palette — jump to a repo, run a workspace script, fetch/pull all, switch theme or skin, open Settings |
| `Ctrl`/`⌘` + `O` | Open a different folder |
| `Ctrl`/`⌘` + `+` / `-` / `0` | Zoom the whole interface in, out, back to 100% |
| `Ctrl` + `C` | Cancel the run showing in the output pane |

The palette searches on repo name, group, the shortened display name and the current
branch — `fe/emp` and `subapp-task` both find what you mean.

---

## Configuration

Settings live in two places, deliberately. Appearance is local and instant; behaviour is
saved to `config.json` in the app config directory
(`~/.config/com.workalley.desktop/` on Linux, `%APPDATA%\com.workalley.desktop\` on
Windows).

**Appearance** — light or dark (it does not follow the OS, by design), three skins
(*Classic* rounded, *Metro* flat tiles, *Adwaita* GNOME), UI and monospace font choice,
zoom, and a console theme that can be pinned against the app theme.

**Behaviour**

| Setting | Default | What it does |
| --- | --- | --- |
| `autoFetchMinutes` | on | Minutes between quiet background fetches. Every "behind" number is computed from local refs, so with this off a long-open workspace grows confidently wrong. `0` disables it. |
| `reopenLastWorkspace` | on | Skip the picker and reopen the folder you last had open. |
| `staleDays` | — | How old a branch has to be to count as stale. |
| `scanConcurrency` | — | How many repos are scanned at once. |
| `recentCommitLimit` | — | Commits loaded per repo. |
| `maxLogLinesPerRun` | — | Where a run's log is truncated. |
| `preferredPackageManager` | auto | Tie-break for repos that state nothing. A lockfile or a `packageManager` field always wins. |
| `stacks` | all | Languages and frameworks this machine cares about, which narrows the Toolbox. Empty means show everything. |
| `trackedPackage` | auto | Pins the shared package whose version drift is reported. Normally detected. |

Dev-server commands and ports can be overridden per repo from the repo's own menu.

---

## Development

```bash
bun install
bun run tauri dev        # app with HMR
bun run dev              # frontend only (shows a "not in Tauri" notice)

bun test                 # frontend tests
bun run lint             # oxlint
cargo test --manifest-path src-tauri/Cargo.toml
```

Layout:

```
src/            React frontend
  domain/       types and derivations shared across features
  features/     one folder per area of the UI
  ipc/          the Tauri bridge: commands in, events out
  stores/       zustand state
  styles/       theme tokens and the three skins
src-tauri/src/  Rust backend
  commands.rs   every IPC command, and the action builder
  git.rs        the scanner
  procs.rs      process spawning and run streaming
  pty.rs        the integrated terminal
  paths.rs      workspace and repo resolution — the only thing that maps a ref to a path
```

One rule worth knowing before changing anything: **the frontend never composes a command
line.** It sends a variant of a closed `ActionSpec` enum; Rust resolves it to an argv
from validated, absolute paths. That is what keeps a UI action from becoming arbitrary
shell.

### Releasing

Packages are built here, not in CI, and uploaded to a draft release. Actions only runs
the suites (`.github/workflows/ci.yml`); a Tauri bundle is a quarter of an hour per
platform and produced nothing a local build does not.

```bash
npm version patch --no-git-tag-version   # bump package.json…
# …and src-tauri/tauri.conf.json, src-tauri/Cargo.toml and the lock to match:
# the Rust version is what `get_bootstrap` reports as the app version in the UI
git commit -am 'release: v0.1.1'
git tag -a v0.1.1 -m 'Work Alley v0.1.1'   # annotated: --follow-tags skips lightweight ones
git push --follow-tags

scripts/release.sh                       # test, build, upload — leaves it a draft
scripts/release.sh --no-windows          # Linux only, if the cross-build is broken
gh release edit v0.1.1 --draft=false     # publish when the assets look right
```

The Linux packages and the Windows NSIS installer are both built, and only the
version being released is uploaded — the bundle directories still hold every older
build, so the upload is version-scoped rather than "everything in the folder".

The script refuses to run on a dirty tree, or when `HEAD` is not the tag it is
uploading to — a build of uncommitted work attached to a tag that names something else
is the one mistake nobody would catch later.

---

## Troubleshooting

**The picker won't accept my folder.** It needs at least one git repo in it or one level
below it. A folder of folders of folders is one level too deep.

**A tool shows as missing even though it is installed.** Tools are resolved once at
startup by absolute path. If you installed something while the app was open, use the
refresh control on the toolchain card — or restart.

**Everything says "in sync" and I doubt it.** Background fetch is probably off. Check
`autoFetchMinutes` in Settings, or hit **Fetch all**.

**Windows warns about the installer.** The builds are unsigned. Signing needs a
certificate and a `bundle > windows > certificateThumbprint` entry in `tauri.conf.json`.

**AppImage won't start.** It still needs `webkit2gtk 4.1` and `GTK 3` present on the
system; unlike the `.deb`/`.rpm` it cannot pull them in.
