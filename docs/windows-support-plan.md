# Windows support for Work Alley

## Context

Work Alley is a Tauri 2 desktop app (React 19 frontend, ~14.5k lines of Rust in `src-tauri/src/`) that currently ships only Linux packages (`deb`, `rpm`, `appimage`). The goal is to run on Windows with **full feature parity** — not a degraded build.

The problem is not that it fails to compile. `main.rs` already carries `windows_subsystem`, config already goes through `app_config_dir()`, `icons/icon.ico` exists, and about a dozen `#[cfg(unix)]/#[cfg(not(unix))]` pairs already guard signals and mode bits. The problem is that it compiles and then **does nothing useful**, because the app's whole model of "run something" is unix-shaped:

- Every non-trivial action argv starts with `bash -c <posix script>` (`commands.rs`: bulk pull, clone-all, checkout-all, discard-changes, script runner; `packages.rs`, `setup.rs`).
- `which` is `dir.join(bin)` with no `PATHEXT`, so **no tool is ever found** — `git.exe`, `npm.cmd`, `winget.exe` are all invisible.
- Tool discovery is `$SHELL -lic 'command -v …'`; Windows has no login shell.
- Process teardown is `killpg`/`setsid`; the Toolbox package layer is dnf/apt/pacman/zypper/apk/brew prefixed with `sudo`.
- Every child is spawned from a GUI process with no `CREATE_NO_WINDOW`, so a 40-repo scan would strobe console windows across the screen.

Intended outcome: a Windows build where repos scan, git actions run, scripts run, the integrated terminal works, dev servers start and stop cleanly, and the Toolbox/Setup wizard install real packages via winget.

### Decisions already made

| | |
|---|---|
| **Shell** | Git Bash (`bash.exe` from Git for Windows) preferred, PowerShell fallback |
| **Packages** | Full parity via a new `SystemPm::Winget` variant |
| **Window chrome** | Keep `decorations: false`; add a platform signal and Windows-style controls |
| **External terminal** | `wt.exe` for "open a shell here"; script actions rewrite to the integrated PTY |
| **winget IDs** | Ship all mapped IDs, plus a validation script to run once on a real Windows box |
| **CI** | Out of scope. Config only, so a local `tauri build` works. |

**Non-negotiable constraint: zero Linux/macOS behaviour change.** Every existing test must pass untouched except where explicitly listed in §8.

---

## 1. The `platform` module

The single most important structural decision: **one new module owns every platform difference**, rather than sprinkling `cfg` attributes across 15 files. A directory, deliberately against the flat-file convention, so the Windows half is one contiguous read:

```
src-tauri/src/platform/
  mod.rs      — everything pure: quoting, PATHEXT, shell policy, step emitter, parsers
  unix.rs     — syscalls: setsid, killpg
  windows.rs  — syscalls: job objects, CREATE_NO_WINDOW
```

`mod.rs` holds all the pure logic so **the entire Windows code path is unit-testable on the Linux dev box** — the discipline `packages::plan_with(sys, …)` already established by taking the manager as a parameter.

Public API (full signatures are in the sub-agent design; the shape that matters):

```rust
// home & well-known dirs
pub fn home_dir() -> Option<PathBuf>;          // promoted verbatim from commands.rs:117
pub fn fallback_dir() -> PathBuf;              // "/" | %SystemDrive%\ then temp_dir()
pub fn tool_search_dirs() -> Vec<PathBuf>;     // replaces toolchain.rs:275 candidate_dirs
pub fn gui_install_dirs() -> Vec<PathBuf>;     // replaces toolchain.rs:420 + packages.rs:340
pub fn gh_config_path() -> Option<PathBuf>;
pub fn ssh_dir() -> Option<PathBuf>;
pub fn os_label() -> String;

// executable resolution — the change that makes anything work at all
pub fn path_exts() -> &'static [String];       // %PATHEXT% split, cached; [""] on unix
pub fn is_executable(p: &Path) -> bool;
pub fn which_in(dirs: &[PathBuf], bin: &str) -> Option<PathBuf>;
pub fn which(bin: &str) -> Option<PathBuf>;
pub fn strip_verbatim(p: &Path) -> PathBuf;    // drops \\?\ after canonicalize

// shell selection
pub enum ShellKind { Posix, PowerShell }
pub struct Shell { kind, program, command_args, login_args }
pub fn shell() -> Option<&'static Shell>;      // resolved ONCE into a OnceLock at startup
pub fn posix_shell() -> Option<PathBuf>;       // bash.exe only
pub fn login_shell_argv() -> Vec<String>;
impl Shell { fn script_argv(&self, &str); fn file_argv(&self, &Path, &[String]) -> Option<_>;
             fn quote(&self, &str); fn path_arg(&self, &Path); fn pause_tail(&self); }
pub fn sh_quote(s: &str) -> String;            // moved from procs.rs:649, unchanged
pub fn ps_quote(s: &str) -> String;

// bulk-action emission — data, not text, so one builder feeds two emitters
pub struct Step { key, skip_if_dir, skip_note, cmds: Vec<Vec<String>>, fail_note, on_fail }
pub fn steps_argv(sh: &Shell, steps: &[Step], tail: &str) -> Vec<String>;

// child shaping
pub fn hide_console(cmd: &mut tokio::process::Command);   // CREATE_NO_WINDOW
pub fn new_group(cmd: &mut tokio::process::Command);      // setsid | CREATE_NEW_PROCESS_GROUP
pub fn detach(cmd: &mut std::process::Command);           // setsid | DETACHED_PROCESS

// process groups
pub struct Group(Arc<imp::GroupInner>);        // a pgid | an owned Job Object handle
pub fn adopt(pid: u32, handle: Option<RawHandleOpaque>) -> Group;
pub async fn terminate(g: &Group, grace: Duration);
pub fn terminate_now(g: &Group);
pub fn hangup(g: &Group);

// ports & terminal
pub async fn port_holders(tc: &Toolchain, port: u16) -> Vec<(u32, String)>;
pub fn parse_ss_holders(&str);                 // moved from procs.rs:899
pub fn parse_netstat_holders(&str, u16);
pub fn kill_pids_argv(pids: &[u32]) -> Vec<Vec<String>>;   // Vec-of-Vec: taskkill is per-pid
pub fn find_terminal(tc: &Toolchain) -> Option<TerminalCmd>;
pub fn external_terminal_available(tc: &Toolchain) -> bool;
```

### Tree-kill: job objects, not `taskkill`

`windows-sys 0.61.2` is **already in `src-tauri/Cargo.lock`** (pulled in by tokio and tauri), so this adds no new crate and no compile time:

```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.61", features = [
  "Win32_Foundation", "Win32_System_JobObjects", "Win32_System_Threading",
] }
```

Use `CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `AssignProcessToJobObject`, terminated with `TerminateJobObject`. This is the true `killpg` analogue: descendants join automatically, termination is atomic, and kill-on-close gives the `kill_on_drop` parity `procs.rs:157` wants for free. `taskkill /F /T /PID` walks the *live* parent chain and therefore **misses orphans** — which is exactly the vite→esbuild case the comment at `procs.rs:163-165` exists for. Keep `taskkill` only as the fallback when `AssignProcessToJobObject` fails (`Group::is_tree() == false`) and for `KillPort`, where all we have is someone else's pid.

---

## 2. Rust: shell, process, discovery

### Phase 0 — land the module as a pure refactor
Create the three files, `mod platform;` in `lib.rs`. **Move, don't rewrite:** `procs::sh_quote` → `platform::sh_quote`, `procs::parse_ss_holders` → `platform`, `commands::dirs_home` → `platform::home_dir`. Re-export the two moved fns from `procs` so its existing tests compile unchanged. Add the `windows-sys` target dep. `cargo test` green, nothing observable changed.

### Phase 1 — home, paths, PATHEXT
Delete the four duplicate `which`/`is_executable` implementations (`toolchain.rs:347`, `packages.rs:349`, `procs.rs:653`, `scripts.rs:73`) in favour of the `platform` versions. Repoint every bare `HOME` read (`paths.rs:17`, `toolchain.rs:277`, `packages.rs:332` & `:368`, `creds.rs:130` & `:153`, `commands.rs:252`) at `platform::home_dir()`. `paths.rs:23`'s `PathBuf::from("/")` → `platform::fallback_dir()`. `paths.rs:210 ensure_inside` wraps both canonicalizations in `strip_verbatim`. `commands.rs:245`'s `parent != Path::new("/")` → `parent.parent().is_some()`, which covers a unix root and a drive root alike.

### Phase 2 — toolchain discovery
`TOOLS: [&str; 12]` → `tools() -> &'static [&'static str]`, dropping `ss`/`lsof` on Windows so they are not two permanently-missing Toolbox rows. Gate the `$SHELL -lic` probe stage (`toolchain.rs:106`) behind `cfg(unix)` — **with a comment explaining why, so nobody "fixes" it back**: under Git Bash, `command -v git` answers `/mingw64/bin/git`, an MSYS path that `Command::new` cannot exec. Stages 2 and 3 already work once `which` is PATHEXT-aware. `candidate_dirs` → `platform::tool_search_dirs()`, whose Windows list covers nvm-windows, fnm, Volta, `.bun\bin`, `.cargo\bin`, scoop shims, chocolatey bin, `%ProgramFiles%\{nodejs,Git\*,GitHub CLI,Docker\…}`, `%LOCALAPPDATA%\Programs\*`, `System32`, `System32\OpenSSH`, `WindowsApps`.

### Phase 3 — shell selection and argv builders *(largest phase)*
**Do the golden-string snapshot test first** (§8) — the `[..]`/`[OK]`/`[FAIL]`/`[SKIP]` markers are parsed by `ansi::marker` and `procs.rs:278`, so the POSIX emitter's output must stay byte-identical.

Thread a `&Shell` parameter through the four private bulk builders — `bulk_pull_argv` (`commands.rs:2657`), `clone_all_argv` (`:2680`), `checkout_default_argv` (`:2724`), `bulk_fetch_argv` (`:2785`) — and have each build `Vec<Step>` + `platform::steps_argv(...)` instead of concatenating shell text. Same for `DiscardChanges` (`:1906`). Delete `shell_single_quote` (`:2710`) in favour of `Shell::quote`/`Shell::path_arg`. `commands.rs:2368`/`:2621` (`vec!["bash", path]`) → `Shell::file_argv`. `packages::shell_path`/`shell_capture` and `setup.rs:531`/`:620` → `platform::shell()`.

Two Windows-specific gotchas that will otherwise bite silently:
- **Git Bash cannot `cd 'C:\w\fe\web'`** — backslash is literal inside single quotes. Every interpolated path goes through `Shell::path_arg`, which emits `C:/w/fe/web`; `cd`, `git` and `[ -d ]` all accept it.
- **PowerShell has no `&&`.** The emitter must use `if ($LASTEXITCODE -eq 0)`. Getting this wrong silently marks every step OK — hence a dedicated test.
- Add `platform::pty_argv(argv)`, called once inside `pty::open`, which prefixes `["cmd.exe","/C"]` when `argv[0]` ends `.cmd`/`.bat` — `portable-pty`'s ConPTY backend calls `CreateProcessW` with `lpApplicationName` and **cannot spawn a shim**. (`std::process::Command` handles this itself on Rust ≥ 1.77.2 — keep `rust-version = "1.77.2"` as a hard floor with a comment saying why.)

### Phase 4 — process groups and console windows
`state.rs:47` `pgid: Mutex<i32>` → `group: Mutex<Option<platform::Group>>` plus a `pid: Mutex<u32>` for display; update `state.rs:220`, `:288 running_pgids` → `running_groups()`, `:306 persist_dev_runs` (an i32 pgid in a JSON file is meaningless on Windows). `procs.rs:159` → `platform::new_group`; `:206` → `platform::adopt(pid, child.raw_handle())`; `:469 kill_tree` → `platform::terminate`; `:490 kill_all_now` → `terminate_now`. `procs.rs:683 spawn_detached` → `platform::detach` (and **not** `CREATE_NO_WINDOW` — a GUI editor needs `DETACHED_PROCESS` to outlive us).

**`hide_console` on every piped child.** Cheapest guaranteed coverage: call it inside `git::harden` (`git.rs:246`), which every scan child already passes through, then explicitly at `toolchain.rs:370`, `packages.rs:374`, `creds.rs:96`, `setup.rs:476`, `docker.rs`.

### Phase 5 — pty
`portable-pty 0.9`'s ConPTY backend is complete (`openpty`, `resize`, reader, writer, `process_id`, `wait`). Three deltas: `pgid: i32` → `Option<platform::Group>` (`pty.rs:99`, and fix the unix-only claim in the doc comment at `:108`); capture `child.as_raw_handle()` at `:220` *before* the `Child` moves into `spawn_waiter` at `:268`; `hangup` (`:465`) and `force_kill` (`:475`) → `platform::hangup`/`terminate_now`. Note `WinChildKiller::kill` is `TerminateProcess` on the direct child only and has inverted error logic — happily `pty.rs` already ignores its `Result`.

### Phase 6 — ports
`platform::port_holders` on Windows: `netstat.exe -ano -p tcp`, filter `LISTENING` rows whose local address ends `:<port>`, pid is the last column; then one `tasklist /FI "PID eq N" /NH /FO CSV` per pid for the name. `netstat -ano` needs no elevation. **Not `Get-NetTCPConnection`** — it costs a ~400ms PowerShell start on a path that runs while building the confirmation dialog (`commands.rs:1336`). `commands.rs:1367` → `platform::kill_pids_argv`, fed through `steps_argv` as one `Step` per pid, which incidentally gives KillPort the per-pid result markers it lacks today.

### Phase 7 — external terminal
`open_shell` on Windows: `wt.exe -w 0 nt -d <cwd> <login shell>` — a tab in the existing window, directory set natively, which makes the `cd` workaround at `procs.rs:835` unnecessary. `open_terminal` (a script) does **not** go through `wt`: it splits its own command line on `;` and every generated script is full of them. Instead `external_terminal_available()` returns false there and `commands.rs:2597`/`:2543` rewrite `external: true` to the `termScript`/`termShell` kind. Fall back to `powershell.exe`, then `conhost.exe`, then the existing `AppError::NoTerminal` + copy-the-command path. Say plainly in the UI copy that this is a deliberate reduction.

### Phase 8 — credentials & os_label
`creds.rs:89` returns `AgentState::Absent` when `SSH_AUTH_SOCK` is unset — on Windows the OpenSSH agent is a *service over a named pipe* and that variable is never set, so this step reports "nothing configured" forever. Gate the check to `cfg(unix)` and just run `ssh-add -l`; the three-exit-code contract at `creds.rs:76` is already correct (exit 2 covers "service not running"). `creds.rs:152 gh_account` → `platform::gh_config_path()` (`%AppData%\GitHub CLI\hosts.yml`, and honour `%GH_CONFIG_DIR%` on both platforms). `toolchain.rs:162`'s permanent unactionable `SSH_AUTH_SOCK` warning → `cfg(unix)`. `setup.rs:449 os_label` → `platform::os_label()`; `cmd.exe /C ver` parsed to `"Windows 10.0.26100"`, cached, falling back to `env::consts::OS`.

`detect.rs` needs **nothing** — 379 lines of pure `Path::join` and file checks. `git.rs` needs only `hide_console`; `harden`'s env vars including `GIT_SSH_COMMAND` work as-is under git's bundled `sh`.

---

## 3. Packages: `SystemPm::Winget`

Three existing mechanisms do most of the work for free and must not be disturbed:
- **An alias of `""` already means "not packaged here"**, and flows end-to-end: `package_name` → `manager_available` → `PackageStatus.manager_available` → the Toolbox `unavailable` badge (`Toolbox.tsx:454`) → `SetupItem.available` → the amber dot (`SetupPage.tsx:462`) → `done` ignoring unavailable items (`setup.rs:256`) → the group planner's skip warning (`packages.rs:1297`).
- `plan_with(sys, …)` / `plan_system_group_with(sys, …)` take the manager as a parameter, so **every winget behaviour is testable on Linux**.
- Plans are argv executed through `portable_pty::CommandBuilder`, so a plain `winget.exe` invocation needs no shell.

### 3.1 The variant
Add `SystemPm::Winget` **unconditionally** (so it compiles and tests on Linux); gate only *detection* (`packages.rs:86`) to `cfg(windows)`. `winget.exe` lives in `%LOCALAPPDATA%\Microsoft\WindowsApps` as an App Execution Alias — a zero-length reparse point that `is_file()` accepts but the current `dir.join("winget")` will never reach, so this depends on Phase 1's PATHEXT work. Make the "no system package manager" strings platform-specific while keeping that exact substring, so the test at `packages.rs:1417` survives.

### 3.2 Elevation: split the conflated boolean
`needs_root()` currently means both "prefix `sudo`" (`packages.rs:1091`, `:1290`) and "a password prompt is coming, warn" (`:1092`, `:1231`, `model.rs:549`, `Toolbox.tsx:445`). winget takes **no prefix** but *does* raise a UAC dialog the app cannot render, so a run that looks hung is a run silently waiting for a click.

```rust
pub enum Elevation { Sudo, None, Uac }
impl SystemPm {
    pub fn elevation(&self) -> Elevation { match self {
        Brew => None, Winget => Uac, _ => Sudo } }
    /// Kept, and now means exactly one thing: whether to prefix `sudo`.
    pub fn needs_root(&self) -> bool { matches!(self.elevation(), Elevation::Sudo) }
}
```
`Uac` ⇒ no prefix, `in_terminal = false`, `danger = Medium` (switch that guard from `needs_root` to `elevation != None`), and a warning: *"Windows will ask you to approve this install (UAC). Accept the dialog — the terminal below waits until you do."*

**Do not pass `--scope`.** Bare `winget install` prefers a user-scope installer when one exists and falls back to machine scope with UAC. `--scope user` makes machine-only packages fail hard; `--scope machine` forces needless prompts. The one cost — a new user-scope PATH entry the running app can't see — is a "restart Work Alley" note, exactly like the existing nvm note at `setup.rs:103`.

### 3.3 Verbs
`verb()` returns the args between program and package, and `plan_with_version` appends the target last, so **end each winget verb with `--id`** and let the target become its value. This keeps "target is the last argv element" true for every other manager, so the assertions at `packages.rs:1379`, `:1393`, `:1484` are untouched.

```rust
Install => &["install","--exact","--source","winget",
             "--accept-package-agreements","--accept-source-agreements",
             "--disable-interactivity","--id"],
Upgrade => &["upgrade","--exact",
             "--accept-package-agreements","--accept-source-agreements",
             "--disable-interactivity","--id"],
// `winget uninstall` rejects --accept-package-agreements and --source as
// unrecognised, which is why this belongs in the per-verb table and a shared
// "non-interactive flags" constant would be wrong.
Remove  => &["uninstall","--exact","--disable-interactivity","--id"],
```
`--exact` stops a substring match asking for disambiguation; `--source winget` stops an `msstore` package with a colliding name winning; the two `--accept-*` flags stop a first-run y/n block; **`--disable-interactivity` is the flag that makes winget safe to drive from a GUI at all** — it turns every remaining prompt into a non-zero exit instead of a hang. **No `--silent`**: winget's default is already silent-with-progress, and forcing it makes Docker Desktop and VS Build Tools fail rather than show their own UI.

Version pinning: winget *can* pin (unlike pacman/apk) — append `--version <v>` after the target.

### 3.4 Groups: winget is one package per invocation
This is the structural problem. `plan_system_group_with` (`packages.rs:1256`) builds one command with N names — the whole point of the setup page. `winget install --id A --id B` is invalid. So the Winget branch chains one invocation per package through the shell helper with `&&` (the closest analogue of a single atomic `dnf` transaction — one clear pass/fail; a partial failure is re-run and `missing_of` narrows it to what's still missing). Quote each id through the shell's quoting fn even though ids are `[A-Za-z0-9.+-]` — the catalog is data, and data reaching a shell gets quoted. The existing skip-warning and all-unavailable-refusal machinery is reused verbatim.

### 3.5 Reading versions and updates
**Keep `version_of`** (`packages.rs:373`) as the source of truth — it runs `<binary> --version` against the resolved path, which is what's actually on PATH. `winget list` reports what winget's registry *thinks*, which diverges the moment anything is installed outside winget.

`system_updates` gets a Winget arm parsing `winget upgrade --disable-interactivity`. **Split each row on runs of two-or-more spaces and read fields from the right** (`source`, `available`, `version`, `id`) — never slice by header offsets: widths vary, long names get elided with `…`, and the header is localized. Name is the only column that can contain double spaces, which is exactly why right-to-left works. Junk lines can't produce a false positive because `updates` only looks up names already in the catalog. **Accept `Some(0)` only and hardcode no HRESULTs** — winget's error codes are HRESULTs surfaced as large negative i32 and none are needed here: "nothing to upgrade" exits 0 and parses to an empty vec, which is the right answer. Omit `--include-unknown`, which turns every undeterminable version into a phantom upgrade.

`system_versions` gets `winget show --exact --id <Id> --versions --disable-interactivity`, skipping to the `---` rule then taking lines starting with a digit.

### 3.6 Per-platform axes on `Entry`
Two distinct reasons a row can't be installed, so two mechanisms:

- **Annotate** (existing empty-alias mechanism, already wired end-to-end) when the tool makes sense on Windows but winget doesn't carry it: `psql`, `mysql`, `redis-cli`, `kcat`, `make`, `cc`, `httpie`, `pipx`, `poetry`, `curl`. The user *should* see these.
- **Hide** (new `platforms: &'static [Os]` field) when the tool cannot exist there at all: `zsh`, `fish`, `tmux`, `podman-compose`. Two of those are `removable: false`, so they'd otherwise be permanently-unfinishable amber rows.

Filter at the command boundary — the `for e in CATALOG` loops in `list` (`:295`) and `updates` (`:642`) — via `catalog(os)`, taking `os` as an internal parameter defaulting to `Os::current()` so it's testable on Linux. **`find(id)` stays unfiltered**: a stale id from a cached frontend query should hit `plan`'s real refusal, not "unknown package", and the setup test at `setup.rs:663` must resolve Windows-only step ids while running on Linux.

Also `manager_windows: Option<Manager>` and `bin_windows: &'static str`:

**Drop `Manager::Nvm` on Windows; install Node from winget.** `Nvm` is a POSIX shell-function assumption in four places (`nvm_script` looks for `~/.nvm/nvm.sh`; `node_versions` sources it; `node_update` compares against it; the plan emits `nvm install --lts --latest-npm && nvm alias default lts/*`). nvm-windows has none of it — no `nvm.sh`, no `--lts`, no `--latest-npm`, and `nvm use` needs administrator on *every switch* because it re-points a symlink under `Program Files`. Supporting it means reimplementing four code paths to deliver a feature the app only ever uses in its "give me latest LTS" form. So `node` → `Manager::System` + `OpenJS.NodeJS.LTS`, and `bun` → `Manager::System` + `Oven-sh.Bun` (which also deletes `curl https://bun.sh/install | bash` from the wizard). fnm (`Schniz.fnm`) is the right answer if per-project Node versions ever become a real Windows feature — note as deferred, don't build.

`bin_windows` is needed for exactly one entry: `python` → `python.exe`, not `python3`.

**Separate real bug:** `tc.path("npm")` resolves `npm.cmd`, and `CreateProcess` refuses a `.cmd`. So `Manager::NpmGlobal` (`:1157`) and `plan_npm_group` (`:1318`) would produce unspawnable argvs under `pty.rs:174`. Fix with a local `exec_argv(program, args)` helper wrapping in `cmd.exe /C` — preferred over routing through Git Bash because it's exact and doesn't make npm depend on the shell layer. Only the npm family is affected (`bun.exe`, `rustup.exe`, `cargo.exe` are fine).

### 3.7 The catalog mapping
All ~46 `Manager::System` entries get an **explicit** `("winget", …)` row — including `("winget", "")` for unavailable ones. Never let one fall through to `e.package` at `packages.rs:282`, which would send `fd-find` and `java-latest-openjdk-devel` to a real `winget install`. **A test enforces this** (§8) and is the highest-value test in the plan.

Confident: `Git.Git`, `GitHub.cli`, `Starship.Starship`, `sharkdp.fd`, `junegunn.fzf`, `jqlang.jq`, `Neovim.Neovim`, `GoLang.Go`, `MikeFarah.yq`, `Kubernetes.kubectl`, `Helm.Helm`, `Hashicorp.Terraform`, `Amazon.AWSCLI`, `Docker.DockerDesktop`, `OpenJS.NodeJS.LTS`, `Python.Python.3.13`.

To verify: `JesseDuffield.lazygit`, `dandavison.delta`, `BurntSushi.ripgrep.MSVC`, `astral-sh.uv`, `EclipseAdoptium.Temurin.21.JDK`, `Derailed.k9s`, `RedHat.Podman`, `Oven-sh.Bun`, `SQLite.SQLite`, `RubyInstallerTeam.Ruby.3.3`, `fullstorydev.grpcurl`, `ezwinports.make`, `PHP.PHP`.

Unavailable, with the reason carried in a note:
- **`psql`, `mysql`** — by *policy*, not absence. The only winget routes (`PostgreSQL.PostgreSQL.16`, `Oracle.MySQL`) are **server** MSIs, which violates the catalog's own "clients only, never servers" invariant (`packages.rs:219`). Note: run the server in a container and use its client.
- **`redis-cli`** — Redis has no official Windows build.
- **`kcat`** — librdkafka + POSIX; **no Windows build exists at all**. Note `docker run --rm edenhill/kcat`.
- **`cc`** — the one honest parity gap, and worth being explicit about rather than papering over. `Microsoft.VisualStudio.2022.BuildTools` installs only the *bootstrapper*; the C++ workload needs `--override "--add Microsoft.VisualStudio.Workload.VCTools …"`, which a name-only argv cannot express. And `bin: "gcc"` is wrong — the Windows compiler is `cl.exe`, on PATH only inside a Developer Prompt, so detection would report it missing forever. Mark unavailable; carry the truth in the note.
- **`curl`** — ships in `System32` since Win10 1803, so `installed: true, available: false`. The row reads "installed", no action, and the `essentials` step isn't blocked. Correct outcome, no code change.
- `httpie` (`HTTPie.HTTPie` is the desktop app, not the `http` binary this entry probes), `pipx`, `poetry` — pip-installed.

**Tally: 14 of 46 unavailable on Windows**, four of which are hidden rather than annotated.

### 3.8 ID validation script
`scripts/verify-winget-ids.ps1` (or `.sh` driving `winget.exe`): iterate every non-empty `("winget", …)` alias, run `winget show --exact --id <Id>`, report misses. Run once on a Windows box before shipping; drive the fixes back into the catalog. Also worth checking there: whether the two-space table split survives a non-English locale, and whether the WindowsApps reparse point is found by the new PATHEXT `which`.

---

## 4. Setup wizard

`STEPS` (`setup.rs:61`) differs on Windows in ids, order, kinds *and* prose, and the `nvm` step disappears entirely — parameterising one table gets ugly fast. Add `STEPS_WINDOWS` and route `find_step` (`:222`), `blocked_reason` (`:231`) and `status` (`:249`) through `fn steps() -> &'static [Step]`.

1. **`essentials`** — `System(&["git","jq"])`. `curl` is in-box; `make`/`cc` don't belong in a required Windows step. *"Git for Windows first, because everything below is cloned with it — and because it brings Git Bash, which Work Alley uses to run scripts."*
2. **`git-identity`** — unchanged logic, but `git_identity_argv` (`:617`) must stop hardcoding `shell_path()`/`-lc`/POSIX `sh_quote`. Chaining both `git config` calls into one run is deliberate (`:614`) and worth keeping.
3. **`node`** — `System(&["node"])`, replacing both the `nvm` (`:87`) and `node` (`:109`) steps. *"Windows has no nvm worth using — nvm-windows needs administrator rights for every version switch. If you later need per-project versions, fnm is the tool."*
4. **`js-tools`** — `NpmGlobal(&["pnpm","yarn","typescript"])`, unchanged; depends on `exec_argv`.
5. **`github`** — `System(&["gh"])`, unchanged.
6. **`credentials`** — unchanged shape, but **dead without all three `creds.rs` fixes from Phase 8**. Note: *"If `ssh-add` says the agent isn't running: `Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent` in an elevated PowerShell."*
7. **`bun`** — `System(&["bun"])`, replacing `curl -fsSL https://bun.sh/install | bash` (`:165`). This makes the Windows table contain **no `Kind::Script` at all**, so the vendor-script warnings hardcoded at `setup.rs:535` never render — the cleanest possible resolution of the curl|bash problem: delete the need rather than translate it.
8. **`terminal`** — `System(&["ripgrep","fd","fzf","neovim","delta"])`, unchanged; all five have winget ids.
9. **`containers`** — `System(&["docker"])`. Replace the `systemctl`/`usermod` note (`:190`) with: *"Docker Desktop needs WSL2 and a sign-out before it will start. You don't need a group change — the installer adds you to the local `docker-users` group, which takes effect at your next sign-in."*
10. **`databases`** — all three (`mysql`, `redis-cli`, `kcat`) are unavailable on Windows, so the card renders `unavailable`: functionally correct, experientially poor. Ship the honest version first — keep the ids and put the truth in the note (`docker exec -it mysql mysql`, `docker exec -it redis redis-cli`, `docker run --rm edenhill/kcat`). Add a Windows-only `mysqlsh` entry (`Oracle.MySQLShell`) once its id is verified, so the step has something to do.
11. **`backend`** — `NpmGlobal(&["nest","mongosh"])`, unchanged.

Also: `manager_label`'s `Kind::Script => "curl"` (`:438`) → `"installer"`.

---

## 5. Frontend

Currently there is **no way for the UI to branch on platform** — no `navigator.platform`, no `plugin-os`. Add one:

- A tiny `platform_info` IPC command returning `{ os: "windows" | "linux" | "macos" }` plus a `usePlatform()` hook. Prefer this over adding `@tauri-apps/plugin-os` — it's one command and the Rust side already computes `os_label`. If an existing startup snapshot is fetched on mount, piggyback on it instead of adding a round trip.
- **`WindowControls.tsx`** — swap in Windows-style controls when `os === 'windows'`: 46×32 hit targets, flat (no gap), Segoe-style glyphs, red close hover. Keep `decorations: false`; Snap Layouts stay unavailable.
- **Right-click system menu on the drag region** — Tauri v2 exposes no cross-platform API for this, so it needs a small Rust command using `GetSystemMenu` + `TrackPopupMenu` + `WM_SYSCOMMAND` via `windows-sys`. Genuinely optional polish; **defer it** unless the rest lands early.
- **`WorkspacePicker.tsx:30 abbreviate()`** — strips the home prefix then checks `rest.startsWith('/')`, and `:97` does `current.split('/')`. Both fail on `C:\Users\x\…`. Split on `/[/\\]/` and check for either separator.
- **`SetupPage.tsx:547`** — the hardcoded `ssh-add ~/.ssh/id_ed25519` / `cat ~/.ssh/id_ed25519.pub` clipboard commands need Windows variants (`Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub`).
- **`use-theme.ts:62`** — the WebKitGTK theme-signal workaround is redundant but harmless under WebView2; leave it, note it.

No capability changes needed: `default.json` is platform-neutral, and `gen/schemas/` is gitignored and regenerated per platform.

---

## 6. Config

`src-tauri/tauri.conf.json`:
```json
"bundle": {
  "targets": ["deb", "rpm", "appimage", "nsis", "msi"],
  "windows": {
    "webviewInstallMode": { "type": "downloadBootstrapper" },
    "nsis": { "installMode": "currentUser" }
  }
}
```
`downloadBootstrapper` keeps the installer small and is right for a dev tool; `currentUser` avoids a UAC prompt just to install the app. Icons need no work — `icons/icon.ico` and the full `Square*Logo.png` set already exist. Signing (`certificateThumbprint`, `timestampUrl`) is deliberately left out; unsigned means a SmartScreen warning on first run, which is a separate decision.

---

## 7. Degraded states to surface honestly

1. **No bash ⇒ the workspace's own `.sh` scripts can't run.** PowerShell can't execute them and rewriting a user's scripts is out of the question. `scripts::discover` should still *find* them — greyed, with a reason. Add `blocked: Option<String>` to `ScriptDescriptor` (or reuse `hint`, `scripts.rs:106`) set to *"needs bash — install Git for Windows"*; `ActionSpec::Script`/`OpenInTerminal` return `ToolMissing("bash")`; add a `Toolchain::warnings` entry so it shows in the startup banner. Rare (git is already a hard requirement and the official installer ships `bash.exe`) but reachable via MinGit/portable-scoop layouts, so it must be honest rather than a mystery failure.
2. **No graceful stop.** There is no SIGTERM. `GenerateConsoleCtrlEvent` needs a shared console a GUI app doesn't have; `taskkill` without `/F` posts `WM_CLOSE`, which console processes ignore. "Stop dev" terminates. `commands.rs:2316`'s description must say so, and `RunStatus::Signaled` never occurs — reword the "these are signalled directly" copy at `commands.rs:1350`.
3. **Job assignment can fail** (only when the app is already inside a job forbidding breakaway). Fall back to `taskkill /F /T`, log once, don't fail the action.
4. **External terminal for scripts** rewrites to the integrated PTY (§Phase 7) — a deliberate reduction.
5. **`ss`/`lsof` vanish from the Toolbox**, intended, via `tools()`.
6. **`cc`/build-tools** is the one real package gap (§3.7).

---

## 8. Tests

**Nothing in the current suite breaks on Linux** if the phases are done as described, because every replacement keeps its signature and the POSIX emitter stays byte-identical. Adaptations needed:

- `procs.rs:939` — the three `terminal_command` tests build `TerminalCmd` by hand, so they survive the move; what breaks them is `terminal_command` reading `platform::shell()`. Fix by making it take `sh: &Shell` as a parameter and having the tests pass a hand-built `Shell { kind: Posix, program: "bash" }`. **Then add a `PowerShell` twin — this is how the entire Windows script path gets covered on a Linux box.**
- `commands.rs:3438` — the seven `checkout_default_argv` tests assert on `argv.last()`. **Snapshot today's output for a 3-repo `Stash` plan as a golden string before refactoring**, assert equality after, then add `&posix()` to the seven calls and a PowerShell twin.
- `setup.rs:692`/`:704` — call `pos("nvm")` and assert the exact required list; parameterise on the table and add Windows counterparts (`["essentials","git-identity","node","js-tools","github","credentials"]`). `:663` must iterate both tables (works only because `find()` stays unfiltered). `:798` splits into POSIX and PowerShell quoting tests.
- `packages.rs:1596 alias_keys_name_a_real_manager` — add `Winget.id()` to `known`, or every alias added in §3.7 fails.
- `pty.rs:552` — the harness hardcodes `/bin/bash` and every script is POSIX (`stty size`, `seq`). Leave `cfg(unix)`-gated; a Windows PTY test needs its own `cmd.exe` scripts and is worth exactly one smoke test (open → `echo hi` → exit detected), not eight.

New tests, **all Linux-runnable**:
- `every_system_entry_declares_a_winget_id_or_declares_it_unavailable` — the highest-value test here; without it `package_name`'s fallthrough silently ships `fd-find` to `winget install`.
- `path_exts` parsing (dedup, case-insensitivity, order precedence); `which_in` extension precedence; `ps_quote` against `'`, `$`, `` ` ``; `bash_path("C:\\w\\My Projects")` → `C:/w/My Projects`; `strip_verbatim` no-op on unix.
- `steps_argv` PowerShell output **for a failing step** — `$LASTEXITCODE` handling, since getting it wrong silently marks every step OK.
- winget: install-is-not-sudo-and-non-interactive; uninstall-omits-the-agreement-flags; version pinning; `elevation == Uac` (asserts `needs_root() == false`, `in_terminal == false`, warning present, `danger == Medium`); group chains N installs with N-1 `&&`; group skips-and-says-so for `["git","kcat"]`; group refuses `["redis-cli","kcat"]`.
- `parse_winget_upgrade` / `parse_winget_versions` fixtures: a name with spaces, an elided `…` name, the `---` rule, the trailing *"N upgrades available"*, and the *"No installed package found"* zero-row case.
- `the_windows_catalog_omits_what_cannot_exist_there` + `the_unix_catalog_is_unchanged` (id snapshot, guarding against a `platforms` typo regressing Linux).
- `npm_plans_are_launchable_on_windows` — argv[0] is never a bare `.cmd`.
- `the_windows_steps_never_pipe_a_download_into_a_shell` — scan `STEPS_WINDOWS` for `Kind::Script` and the substrings `"| bash"`/`"curl"`, assert none. One cheap test that permanently locks in the point of §4.

---

## 9. Sequencing

| Order | Work | Risk to Linux |
|---|---|---|
| 0 | `platform` module as a pure move | none — `cargo test` proves it |
| 1–2 | home/PATHEXT/`which`, toolchain discovery | none; independently mergeable, makes the app *boot* on Windows |
| 3 | Shell + argv builders **(golden snapshot first)** | highest — the only phase touching generated-script semantics |
| 4 → 5 | Groups/`hide_console`, then pty (reuses `Group`) | low; 4 must precede 5 |
| 6, 7, 8 | Ports, external terminal, credentials | independent leaves, parallelisable |
| P1–P8 | Packages: variant → aliases → platform axes → groups → parsers → wizard → creds | independent of the Rust shell phases except for the Phase 1 helpers |
| — | Frontend platform signal + control polish; `tauri.conf.json` | none |
| last | Run `verify-winget-ids` on a Windows box, fix the catalog | none |

## 10. Verification

**On Linux, continuously** — this is the main safety net, and it is a strong one because `platform/mod.rs` keeps the Windows logic pure:
```
cargo test --manifest-path src-tauri/Cargo.toml
bun test && bun run lint
```
Every PowerShell emitter, every winget verb and group plan, every parser, and PATHEXT resolution are all covered without a Windows machine. Then confirm no Linux regression by hand: open a workspace, run a bulk pull and a checkout-all, run a script, open a PTY tab, start and stop a dev server (check no orphaned esbuild via `pgrep -f esbuild`), open an external terminal tab, install one Toolbox package.

**Cross-compile check, cheap and early** — `rustup target add x86_64-pc-windows-msvc` then `cargo check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml`. Catches every `cfg` mistake in seconds without a Windows box. Worth wiring in after Phase 0 and re-running each phase.

**On a Windows box, at the end:**
1. `bun install && bun run build && bunx tauri build` → NSIS + MSI in `src-tauri/target/release/bundle/`.
2. Install and launch — confirm the custom titlebar draws with Windows glyphs and drag/resize/min/max/close work.
3. Toolbox populates with real versions; **no console windows flash** during a multi-repo scan (this is the most visible defect if `hide_console` coverage is incomplete).
4. Run `scripts/verify-winget-ids` and fix the catalog.
5. Install one winget package end-to-end and accept the UAC dialog; confirm the terminal reports success and the warning text appeared beforehand.
6. Start a Vite dev server, then Stop — confirm via Task Manager that **no `esbuild.exe` survives** (the job-object test that matters).
7. Bulk pull, clone-all, discard-changes, and a `.sh` script action, all under Git Bash. Then rename `bash.exe` and confirm the PowerShell fallback handles the bulk actions and that scripts degrade with the "install Git for Windows" reason rather than a mystery failure.
8. Open a PTY tab; run `npm -v` (the `.cmd` shim path) and `git log` (pager/ANSI).
9. `wt.exe` opens a shell tab at the right directory; a script action opens an integrated tab instead.
10. Setup wizard: every step reports a real state, `credentials` detects an `ssh-add`-loaded key and a `gh auth login` session.

---

# Implementation status

All phases are implemented. 201 Rust tests, 129 frontend tests, both targets compile.

## What shipped

| Area | State |
|---|---|
| `platform` module (mod/unix/windows) | done — all pure logic in `mod.rs`, testable on Linux |
| Home dirs, PATHEXT, `which` | done — four duplicate `which` impls collapsed into one |
| Toolchain discovery | done — `$SHELL -lic` probe stays unix-only, with the reason in a comment |
| Shell layer (Git Bash → PowerShell) | done — both emitters, PowerShell twins tested on Linux |
| Process groups (Job Objects) | done — `windows-sys` was already in `Cargo.lock` |
| `hide_console` | done — inside `git::harden`, so coverage cannot be forgotten |
| pty / ConPTY | done — `.cmd` shims wrapped via `pty_argv` |
| Ports (`netstat`) | done |
| External terminal (`wt.exe`) | done — shells only; scripts rewrite to the integrated PTY |
| Credentials, `os_label` | done |
| `SystemPm::Winget` + `Elevation` | done — 42 winget aliases across the catalog |
| `STEPS_WINDOWS` | done — contains no `Kind::Script` at all |
| Frontend platform signal | done — `os` on the bootstrap payload, `usePlatform()` |
| `tauri.conf.json` nsis/msi | done |
| CI | **deliberately not done** — out of scope, see the decisions table |

## Verifying the Windows half without a Windows machine

This is the main safety net and it caught three real errors that the Linux build
cannot see (`portable_pty::Child::as_raw_handle` returns an `Option`, tokio's
`raw_handle` is inherent, and `is_executable` is unix-only after the probe was gated).
Run it after any change under `src-tauri/src/platform/`:

```sh
rustup target add x86_64-pc-windows-msvc
cargo check --target x86_64-pc-windows-msvc --all-targets --manifest-path src-tauri/Cargo.toml
```

`tauri-winres` needs a Windows resource compiler for this. On Fedora:

```sh
sudo dnf install llvm     # provides llvm-rc
```

## Still needs a real Windows box

1. **Run `scripts/verify-winget-ids.ps1`** and fix the catalog. Roughly half the ids
   are unverified; the script reports every one that does not resolve. A wrong id is
   an Install button that cannot work.
2. Confirm the `winget upgrade` two-space table split survives a non-English locale.
3. Confirm no console windows flash during a multi-repo scan.
4. Start a Vite dev server, Stop it, and confirm via Task Manager that no
   `esbuild.exe` survives — the job-object test that actually matters.
5. Rename `bash.exe` and confirm the PowerShell fallback drives the bulk actions, and
   that `.sh` scripts degrade with the "install Git for Windows" reason.
