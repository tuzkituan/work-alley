//! Everything that differs between Linux/macOS and Windows, in one place.
//!
//! This is a directory rather than a flat file, against the convention of every
//! other module here, for one reason: the Windows half is reviewable as a single
//! contiguous read instead of as forty `#[cfg]` attributes scattered across
//! fifteen files.
//!
//! The split between this file and `unix.rs`/`windows.rs` is deliberate and worth
//! preserving: **everything pure lives here** — quoting, PATHEXT expansion, shell
//! policy, the bulk-action emitter, output parsers — and only what genuinely needs
//! a syscall or a platform-specific directory layout lives in the `imp` modules.
//!
//! That is what makes the Windows code path testable on a Linux dev box. The
//! alternative — `#[cfg(windows)]` around the logic itself — means the Windows
//! behaviour is only ever exercised on Windows, which for a port of this size
//! means it is only ever exercised by users. `packages::plan_with(sys, …)` already
//! established the discipline by taking the manager as a parameter rather than
//! detecting it; this module follows it.

#[cfg_attr(unix, path = "unix.rs")]
#[cfg_attr(windows, path = "windows.rs")]
mod imp;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// Home and well-known directories
// ---------------------------------------------------------------------------

/// The user's home directory.
///
/// The one reader of it in the codebase. Everything else went straight to `HOME`,
/// which on Windows is unset — so a dozen call sites silently degraded to `None`
/// or, worse, to a fallback of `/`.
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_dir())
}

/// A directory that certainly exists, for commands that do not care where they run.
///
/// See `paths::neutral_cwd`, which is the only caller and carries the full story:
/// `Command::current_dir("")` fails with ENOENT, so machine-scoped work needed
/// *some* real directory. `/` served on unix; Windows has no such path.
pub fn fallback_dir() -> PathBuf {
    imp::fallback_dir()
}

/// Install locations that exist independently of any shell configuration.
///
/// Ordered most-specific first, so a version manager's shim wins over a system
/// package. Only existing directories are returned.
pub fn tool_search_dirs() -> Vec<PathBuf> {
    imp::tool_search_dirs().into_iter().filter(|d| d.is_dir()).collect()
}

/// Directories a GUI installer writes to that a login shell's PATH often misses.
///
/// Separate from `tool_search_dirs` because the editor probe wants these and not
/// the version-manager shims: nobody installs VS Code under `~/.nvm`.
pub fn gui_install_dirs() -> Vec<PathBuf> {
    imp::gui_install_dirs().into_iter().filter(|d| d.is_dir()).collect()
}

/// Where the GitHub CLI keeps its host list.
///
/// `GH_CONFIG_DIR` first on both platforms, because gh honours it and a user who
/// set it means it.
pub fn gh_config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("GH_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("hosts.yml"));
    }
    imp::gh_config_path()
}

/// `~/.ssh`, which is the same place on Windows — OpenSSH kept the convention.
pub fn ssh_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ssh"))
}

/// A human-readable OS name for the setup page's header.
pub fn os_label() -> String {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(imp::os_label).clone()
}

// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------

/// The extensions that make a file executable, in the order they are tried.
///
/// `[""]` on unix, where the exec bit decides and the name is the whole name. On
/// Windows this is `%PATHEXT%`, and getting it wrong is not a subtle failure: with
/// a bare `dir.join("git")` — which is what every `which` in this codebase used to
/// do — **not one tool is ever found**, because the file is `git.exe`.
pub fn path_exts() -> &'static [String] {
    static EXTS: OnceLock<Vec<String>> = OnceLock::new();
    EXTS.get_or_init(imp::path_exts)
}

/// Whether a path names something we could hand to `Command::new`.
///
/// Unix: a regular file with an exec bit. Windows: a regular file whose extension
/// is in `PATHEXT` — there is no exec bit, and the extension is the whole of what
/// `CreateProcess` will consider.
pub fn is_executable(p: &Path) -> bool {
    imp::is_executable(p)
}

/// Whether a file carries an exec bit, for deciding if a *script* is meant to be run.
///
/// Distinct from `is_executable` and deliberately so. `scripts::is_script` asks a
/// different question — "did the author mean this to be runnable?" — and on Windows
/// there is no bit to answer it with, so every readable file qualifies and the
/// shebang check that follows does the real work. Routing that call through
/// `is_executable` instead would reject every `.sh` file on Windows, because `.sh`
/// is not in `PATHEXT`.
pub fn exec_bit_set(p: &Path) -> bool {
    imp::exec_bit_set(p)
}

/// Finds `bin` in `dirs`, trying each `PATHEXT` extension. First hit wins.
///
/// The single replacement for the four separate `which` implementations this
/// codebase had grown (`toolchain`, `packages`, `procs`, and the editor probe),
/// none of which knew about extensions.
pub fn which_in(dirs: &[PathBuf], bin: &str) -> Option<PathBuf> {
    // An explicit extension is honoured as given, so `which_in(dirs, "git.exe")`
    // and `which_in(dirs, "npm.cmd")` both work. Checked per-directory rather than
    // as a first pass, so directory order still decides between two candidates.
    let explicit = Path::new(bin).extension().is_some();

    for dir in dirs {
        if explicit {
            let c = dir.join(bin);
            if is_executable(&c) {
                return Some(c);
            }
        }
        for ext in path_exts() {
            let c = dir.join(format!("{bin}{ext}"));
            if is_executable(&c) {
                return Some(c);
            }
        }
    }
    None
}

/// `which_in` over `PATH`.
pub fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    which_in(&dirs, bin)
}

/// Removes a `\\?\` prefix, so nothing downstream ever sees a verbatim path.
///
/// `Path::canonicalize` on Windows returns the extended-length form. It is a fine
/// `current_dir`, but `paths::ensure_inside` also feeds its result into generated
/// shell text and UI strings, and `git -C \\?\C:\w\api` fails. No-op on unix.
pub fn strip_verbatim(p: &Path) -> PathBuf {
    imp::strip_verbatim(p)
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/// POSIX single-quoting, so a path or a command can be embedded in a shell string
/// without the shell finding anything in it to interpret.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// PowerShell single-quoting: inside `'…'` nothing expands and `''` is a literal
/// quote, so this is total — no `$`, backtick or newline needs separate handling.
pub fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A Windows path as a POSIX shell will accept it.
///
/// Backslash is an escape character to `sh`, and inside `'…'` it is a *literal*
/// backslash — so `cd 'C:\w\api'` looks for a directory named `C:wapi`. Git Bash,
/// `git`, `cd` and `[ -d ]` all accept forward slashes on Windows, so translating
/// is both sufficient and simpler than escaping.
pub fn bash_path(p: &str) -> String {
    p.replace('\\', "/")
}

// ---------------------------------------------------------------------------
// Shell selection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// `sh`, `bash`, `zsh` — anything that takes `-c` and understands `&&`.
    Posix,
    /// `powershell.exe` or `pwsh.exe`. Not a POSIX shell in any respect that
    /// matters here: no `&&`, no `||`, no `[ -d x ]`, and `if (cmd)` tests the
    /// command's *output* rather than its exit code.
    PowerShell,
}

/// A shell, and how to hand it a script.
#[derive(Debug, Clone)]
pub struct Shell {
    pub kind: ShellKind,
    pub program: PathBuf,
    /// Args that precede a script passed as one string.
    pub command_args: Vec<String>,
    /// Args that start an interactive login shell with no command.
    pub login_args: Vec<String>,
}

/// The shell used for every generated script, resolved once.
///
/// Resolved into a `OnceLock` rather than per call, because the *preview* shown in
/// the confirmation dialog and the argv actually dispatched must never disagree —
/// they are the same string to the user, and a dialog that lies about what it is
/// going to run is worse than no dialog.
///
/// `None` is reachable only on Windows with neither Git Bash nor PowerShell, which
/// is a genuinely degraded machine. See `posix_shell` for what depends on bash
/// specifically.
pub fn shell() -> Option<&'static Shell> {
    static SHELL: OnceLock<Option<Shell>> = OnceLock::new();
    SHELL.get_or_init(resolve_shell).as_ref()
}

#[cfg(unix)]
fn resolve_shell() -> Option<Shell> {
    // $SHELL first: probing bash when the user runs zsh finds a different
    // environment than the one they configured.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(sh) = std::env::var_os("SHELL") {
        candidates.push(PathBuf::from(sh));
    }
    candidates.push(PathBuf::from("/bin/bash"));
    candidates.push(PathBuf::from("/bin/sh"));

    let program = candidates.into_iter().find(|p| is_executable(p))?;
    Some(Shell {
        kind: ShellKind::Posix,
        program,
        command_args: vec!["-c".into()],
        login_args: vec!["-l".into()],
    })
}

#[cfg(windows)]
fn resolve_shell() -> Option<Shell> {
    // Git Bash first, and by a wide margin: every generated script in this app is
    // POSIX, and Git for Windows is already a hard requirement because the app
    // cannot scan a workspace without git. Preferring it means the bulk actions,
    // the setup wizard and the workspace's own `.sh` scripts all keep working with
    // the text they already have.
    if let Some(program) = posix_shell() {
        return Some(Shell {
            kind: ShellKind::Posix,
            program,
            command_args: vec!["-c".into()],
            login_args: vec!["-li".into()],
        });
    }

    // The fallback. It can run the bulk actions, because those are emitted per
    // shell — but it cannot run a `.sh` file, which is why `posix_shell` stays a
    // separate question.
    for bin in ["pwsh", "powershell"] {
        if let Some(program) = which(bin) {
            return Some(Shell {
                kind: ShellKind::PowerShell,
                program,
                command_args: vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                ],
                login_args: vec!["-NoLogo".into()],
            });
        }
    }
    None
}

/// `bash` specifically, for the things that genuinely cannot be translated.
///
/// A workspace's own `scripts/*.sh` is the case that matters: PowerShell cannot run
/// one, and rewriting a user's scripts is out of the question. So this is a separate
/// question from `shell()`, and a `None` here is surfaced as a reason rather than as
/// a mystery failure.
pub fn posix_shell() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        shell().map(|s| s.program.clone())
    }
    #[cfg(windows)]
    {
        imp::posix_shell()
    }
}

/// The argv for an interactive login shell with no command.
pub fn login_shell_argv() -> Vec<String> {
    match shell() {
        Some(s) => {
            let mut argv = vec![s.program.display().to_string()];
            argv.extend(s.login_args.clone());
            argv
        }
        // Nothing resolved, so there is nothing honest to return but the name; the
        // caller reports the spawn failure.
        None => vec!["sh".into()],
    }
}

impl Shell {
    /// The full argv to run `script` as a one-shot command.
    pub fn script_argv(&self, script: &str) -> Vec<String> {
        let mut argv = vec![self.program.display().to_string()];
        argv.extend(self.command_args.clone());
        argv.push(script.to_string());
        argv
    }

    /// The argv to run a script *file* with arguments.
    ///
    /// `None` for PowerShell: a `.sh` file has no PowerShell equivalent, and
    /// guessing one would run the wrong thing rather than fail.
    pub fn file_argv(&self, file: &Path, args: &[String]) -> Option<Vec<String>> {
        if self.kind != ShellKind::Posix {
            return None;
        }
        let mut argv = vec![self.program.display().to_string()];
        argv.push(bash_path(&file.display().to_string()));
        argv.extend(args.iter().cloned());
        Some(argv)
    }

    /// Quotes a value so the shell finds nothing in it to interpret.
    pub fn quote(&self, s: &str) -> String {
        match self.kind {
            ShellKind::Posix => sh_quote(s),
            ShellKind::PowerShell => ps_quote(s),
        }
    }

    /// Quotes only if the value would not survive being written bare.
    ///
    /// Separate from `arg` because that one also translates path separators, which
    /// must not happen to a *script body*: a `\` inside a script is the script's own
    /// escape or regex, not a directory separator, and rewriting it would silently
    /// change what the script does.
    pub fn quote_min(&self, s: &str) -> String {
        if self.safe_bare(s) {
            s.to_string()
        } else {
            self.quote(s)
        }
    }

    /// One argument, ready to paste into a script: separators translated for the
    /// shell, and quoted only if it would not survive being written bare.
    ///
    /// Minimal quoting is deliberate. The generated script is not only executed, it
    /// is also shown to the user as the confirmation dialog's preview, and
    /// `git -C /w/api pull` reads better than `'git' '-C' '/w/api' 'pull'`. Safety
    /// does not depend on it: anything with a metacharacter, a space or a backslash
    /// is still quoted, so a `;` in a clone URL cannot become a second command.
    pub fn arg(&self, s: &str) -> String {
        let v = match self.kind {
            ShellKind::Posix => bash_path(s),
            ShellKind::PowerShell => s.to_string(),
        };
        self.quote_min(&v)
    }

    /// `arg` for a path.
    ///
    /// This is the method that keeps `cd 'C:\w\api'` from looking for a directory
    /// called `C:wapi`. See `bash_path`.
    pub fn path_arg(&self, p: &Path) -> String {
        self.arg(&p.display().to_string())
    }

    /// Whether a value can be written bare, without the shell finding anything in it.
    ///
    /// Quoting is decided per value rather than left to the caller to remember. The
    /// old hand-written `format!` scripts got this right by convention — literals
    /// bare, user input through `shell_single_quote` — but a convention is only as
    /// good as the next person adding an argument, and a `;` in a clone URL would be
    /// a second command.
    fn safe_bare(&self, s: &str) -> bool {
        if s.is_empty() {
            return false;
        }
        s.chars().all(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' => true,
            '_' | '.' | '/' | '-' | '=' | ':' => true,
            // A Windows path is written with backslashes for PowerShell, but for a
            // POSIX shell a backslash is an escape character and must be quoted.
            '\\' => self.kind == ShellKind::PowerShell,
            // `@` starts a splat and `,` separates array elements in PowerShell, but
            // both are inert in sh — and they appear in every scp-style clone URL.
            '@' | ',' | '+' => self.kind == ShellKind::Posix,
            _ => false,
        })
    }

    /// One command: the program followed by its arguments.
    ///
    /// The program is quoted when it needs to be, which the old `format!` scripts
    /// never did. That was safe only because `/usr/bin/git` has no space in it;
    /// `C:\Program Files\Git\cmd\git.exe` does.
    pub fn cmd(&self, argv: &[String]) -> String {
        let parts: Vec<String> = argv.iter().map(|a| self.arg(a)).collect();
        match self.kind {
            ShellKind::Posix => parts.join(" "),
            // The call operator, so PowerShell runs the first token as a program
            // rather than echoing it as a value — which is what it does when the
            // name is quoted, and quoting is not ours to predict here.
            ShellKind::PowerShell => format!("& {}", parts.join(" ")),
        }
    }

    /// Prints a line of literal text.
    ///
    /// The `[..]`/`[OK]`/`[FAIL]`/`[SKIP]` markers the UI parses all come through
    /// here, so both emitters must produce text that reaches stdout unaltered.
    pub fn echo(&self, text: &str) -> String {
        match self.kind {
            // Double quotes, byte-for-byte as these scripts have always emitted.
            // Marker text is generated by us and contains no `$` or backtick.
            ShellKind::Posix => format!("echo \"{text}\""),
            ShellKind::PowerShell => format!("Write-Output {}", ps_quote(text)),
        }
    }

    /// `cmd`, then a message only if it failed.
    pub fn or_fail(&self, cmd: &str, fail: &str) -> String {
        match self.kind {
            ShellKind::Posix => format!("{cmd} || {}", self.echo(fail)),
            // PowerShell has no `||`. Testing `$LASTEXITCODE` is the only way to
            // branch on an external command's exit status.
            ShellKind::PowerShell => {
                format!("{cmd}; if ($LASTEXITCODE -ne 0) {{ {} }}", self.echo(fail))
            }
        }
    }

    /// `cmd`, then one of two messages depending on whether it succeeded.
    pub fn and_or(&self, cmd: &str, ok: &str, fail: &str) -> String {
        match self.kind {
            ShellKind::Posix => {
                format!("{cmd} && {} || {}", self.echo(ok), self.echo(fail))
            }
            ShellKind::PowerShell => format!(
                "{cmd}; if ($LASTEXITCODE -eq 0) {{ {} }} else {{ {} }}",
                self.echo(ok),
                self.echo(fail)
            ),
        }
    }

    /// Two commands where the second only runs if the first succeeded, and the
    /// whole thing counts as failed if either did.
    ///
    /// Used as the condition of an `if_ok`, which is why the PowerShell form has to
    /// leave a usable `$LASTEXITCODE` behind: `a; if (ok) { b }` would report *b*'s
    /// status when it ran and `a`'s when it did not, which is exactly right, whereas
    /// `if (ok) { a; b }` would not run at all.
    pub fn both(&self, first: &str, second: &str) -> String {
        match self.kind {
            ShellKind::Posix => format!("{first} && {second}"),
            ShellKind::PowerShell => {
                format!("{first}; if ($LASTEXITCODE -eq 0) {{ {second} }}")
            }
        }
    }

    /// Branch on whether `cmd` succeeded.
    pub fn if_ok(&self, cmd: &str, then: &[String], els: &[String]) -> String {
        match self.kind {
            ShellKind::Posix => format!(
                "if {cmd}; then {}; else {}; fi",
                then.join("; "),
                els.join("; ")
            ),
            ShellKind::PowerShell => format!(
                "{cmd}; if ($LASTEXITCODE -eq 0) {{ {} }} else {{ {} }}",
                then.join("; "),
                els.join("; ")
            ),
        }
    }

    /// Branch on whether a directory exists.
    pub fn if_dir(&self, dir: &Path, then: &[String], els: &[String]) -> String {
        match self.kind {
            ShellKind::Posix => format!(
                "if [ -d {} ]; then {}; else {}; fi",
                self.path_arg(dir),
                then.join("; "),
                els.join("; ")
            ),
            ShellKind::PowerShell => format!(
                "if (Test-Path -LiteralPath {} -PathType Container) {{ {} }} else {{ {} }}",
                self.path_arg(dir),
                then.join("; "),
                els.join("; ")
            ),
        }
    }

    /// Removes a directory only if it is empty, saying nothing if it is not.
    ///
    /// Never `rm -rf`: this exists to clear the husk an interrupted clone leaves
    /// behind, and it must be incapable of deleting anything with content in it.
    pub fn rmdir_quiet(&self, dir: &Path) -> String {
        match self.kind {
            ShellKind::Posix => format!("rmdir {} 2>/dev/null", self.path_arg(dir)),
            // `-Recurse` is deliberately absent, matching `rmdir`: without it
            // Remove-Item refuses a non-empty directory.
            ShellKind::PowerShell => format!(
                "Remove-Item -LiteralPath {} -ErrorAction SilentlyContinue",
                self.path_arg(dir)
            ),
        }
    }

    /// A terminated statement line.
    pub fn stmt(&self, parts: &[String]) -> String {
        match self.kind {
            ShellKind::Posix => format!("{};\n", parts.join("; ")),
            ShellKind::PowerShell => format!("{}\n", parts.join("; ")),
        }
    }

    /// A line that is already a complete compound statement, e.g. an `if … fi`.
    pub fn line(&self, s: &str) -> String {
        format!("{s}\n")
    }

    /// argv for running a script in a *login* shell.
    ///
    /// Distinct from `script_argv`: a script handed to a terminal emulator is meant
    /// to run in the user's real environment, profile and all, because they will keep
    /// typing in that window afterwards. A script run into the output pane is not.
    pub fn login_script_argv(&self, script: &str) -> Vec<String> {
        let prog = self.program.display().to_string();
        match self.kind {
            ShellKind::Posix => vec![prog, "-lc".into(), script.to_string()],
            // No -NoProfile here, for the reason above.
            ShellKind::PowerShell => {
                vec![prog, "-NoLogo".into(), "-Command".into(), script.to_string()]
            }
        }
    }

    /// `login_script_argv` collapsed into one command line.
    ///
    /// For an emulator that insists on parsing the command line itself — see the
    /// `single_string` field on `TerminalCmd` and the ptyxis story behind it.
    pub fn login_script_line(&self, script: &str) -> String {
        let argv = self.login_script_argv(script);
        let (prog, args) = argv.split_first().expect("argv is never empty");
        let mut out = self.quote_min(prog);
        for a in args {
            out.push(' ');
            out.push_str(&self.quote_min(a));
        }
        out
    }

    /// A `cd` that aborts rather than carrying on in the wrong directory.
    pub fn cd_or_exit(&self, dir: &Path) -> String {
        match self.kind {
            ShellKind::Posix => format!("cd {} || exit 1", self.path_arg(dir)),
            // `-ErrorAction Stop` turns a missing directory into a terminating error,
            // which is what `|| exit 1` achieves for sh.
            ShellKind::PowerShell => format!(
                "Set-Location -LiteralPath {} -ErrorAction Stop",
                self.path_arg(dir)
            ),
        }
    }

    /// Replaces this shell with an interactive login shell.
    pub fn exec_login(&self) -> String {
        match self.kind {
            ShellKind::Posix => format!("exec {} -l", self.quote(&self.program.display().to_string())),
            // PowerShell has no `exec`; starting a nested one is the closest thing,
            // and the extra process is invisible to the user.
            ShellKind::PowerShell => {
                format!("& {} -NoLogo", self.quote(&self.program.display().to_string()))
            }
        }
    }

    /// Holds the window open after a script finishes, so its output can be read.
    pub fn pause_tail(&self) -> String {
        match self.kind {
            ShellKind::Posix => {
                "echo; read -n1 -r -p 'Press any key to close…'".to_string()
            }
            // `read -n1` has no PowerShell equivalent that works in every host, and
            // Read-Host waiting for Enter is close enough for a window that is about
            // to be closed anyway.
            ShellKind::PowerShell => {
                "Write-Output ''; Read-Host -Prompt 'Press Enter to close'".to_string()
            }
        }
    }
}

/// Rewrites an argv so a pty can actually spawn it.
///
/// On Windows, `npm`, `pnpm`, `yarn` and `npx` are `.cmd` batch shims. `std::process`
/// handles that itself — since Rust 1.77.2 it routes a `.bat`/`.cmd` program through
/// `cmd.exe /c` with correct quoting, which is why `Cargo.toml` pins that as the
/// minimum and must keep doing so — but `portable_pty`'s ConPTY backend does not: it
/// calls `CreateProcessW` with `lpApplicationName` set, and `CreateProcess` refuses a
/// batch file outright. So a Toolbox install run in a terminal tab would fail to
/// start at all.
///
/// Applied once inside `pty::open` rather than at each call site, so no future caller
/// can reintroduce the bug.
pub fn pty_argv(argv: &[String]) -> Vec<String> {
    #[cfg(not(windows))]
    {
        argv.to_vec()
    }
    #[cfg(windows)]
    {
        let Some(program) = argv.first() else {
            return argv.to_vec();
        };
        let is_batch = Path::new(program)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| {
                let e = e.to_ascii_lowercase();
                e == "cmd" || e == "bat"
            });
        if !is_batch {
            return argv.to_vec();
        }
        // `/C` and then the argv as given: cmd.exe re-parses the tail, and every
        // element here is either a resolved absolute path or a package name from the
        // closed catalog.
        let mut out = vec!["cmd.exe".to_string(), "/C".to_string()];
        out.extend(argv.iter().cloned());
        out
    }
}

/// Fixed shells for tests.
///
/// The point of taking `&Shell` as a parameter everywhere rather than calling
/// `shell()` internally: a generated script can be asserted byte-for-byte without
/// depending on what `$SHELL` happens to be on the machine running the tests — and
/// **the PowerShell emitter can be tested on Linux**, which is the only way it will
/// ever be exercised outside a Windows box.
#[cfg(test)]
pub fn test_shell(kind: ShellKind) -> &'static Shell {
    static POSIX: OnceLock<Shell> = OnceLock::new();
    static PS: OnceLock<Shell> = OnceLock::new();
    match kind {
        ShellKind::Posix => POSIX.get_or_init(|| Shell {
            kind: ShellKind::Posix,
            program: PathBuf::from("bash"),
            command_args: vec!["-c".into()],
            login_args: vec!["-l".into()],
        }),
        ShellKind::PowerShell => PS.get_or_init(|| Shell {
            kind: ShellKind::PowerShell,
            program: PathBuf::from("powershell.exe"),
            command_args: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
            ],
            login_args: vec!["-NoLogo".into()],
        }),
    }
}

// ---------------------------------------------------------------------------
// Child-process shaping
// ---------------------------------------------------------------------------

/// Stops a child from flashing a console window.
///
/// Must be called on every piped child. This app is a `windows_subsystem = "windows"`
/// process, so it owns no console — which means each `git status` allocates one,
/// paints it, and destroys it. Across a forty-repo scan that is forty windows
/// appearing and vanishing, and it is the single most visible defect on Windows if
/// any call site is missed.
///
/// No-op on unix.
pub fn hide_console(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    cmd.creation_flags(imp::CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Prepares a child to be torn down as a whole tree.
///
/// Unix: its own session, so `killpg` reaches every descendant. vite spawns esbuild;
/// killing only the direct child orphans it and leaves the port bound, which makes
/// the next start fail confusingly.
///
/// Windows: a new process group plus no console window. The tree part is handled by
/// `adopt`, which needs the pid and so cannot happen until after the spawn.
pub fn new_group(cmd: &mut tokio::process::Command) {
    imp::new_group(cmd);
}

/// Prepares a GUI child that must outlive this app.
///
/// An editor keeps running after Work Alley exits, so it must not be in the group we
/// tear down on shutdown. Deliberately *not* given `CREATE_NO_WINDOW` on Windows: a
/// GUI program needs no console, and `DETACHED_PROCESS` is what stops it dying with us.
pub fn detach(cmd: &mut std::process::Command) {
    imp::detach(cmd);
}

// ---------------------------------------------------------------------------
// Process groups
// ---------------------------------------------------------------------------

/// A child and everything it spawns, as one thing that can be killed.
///
/// Unix: a process-group id. Windows: an owned Job Object, which is the only real
/// analogue — descendants join it automatically, `TerminateJobObject` is atomic, and
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` means our own exit tears them down for free.
///
/// `taskkill /T` is *not* the analogue, which is why it is only the fallback: it walks
/// the live parent chain, so the moment vite's esbuild is reparented it is missed —
/// exactly the case this abstraction exists for.
#[derive(Clone)]
pub struct Group(std::sync::Arc<imp::GroupInner>);

/// Takes ownership of a just-spawned child's tree.
///
/// `handle` is the OS process handle where the caller has one (`tokio`'s
/// `Child::raw_handle`, `portable_pty`'s `Child::as_raw_handle`); `None` falls back to
/// opening the process by pid. Ignored entirely on unix.
///
/// On Windows the child is assigned a few hundred microseconds after `CreateProcess`
/// returns, so a child that forks in that window escapes. No real package manager or
/// dev server does, and documenting the race is more honest than pretending the
/// alternative — suspended-start plus resume — is worth its complexity here.
pub fn adopt(pid: u32, handle: Option<isize>) -> Group {
    Group(std::sync::Arc::new(imp::adopt(pid, handle)))
}

impl Group {
    /// The pid to show the user.
    ///
    /// Unix: the pgid, which is the leader's pid. Windows: the direct child's pid, the
    /// job itself having no number worth showing.
    pub fn pid(&self) -> u32 {
        self.0.display_pid()
    }

    /// Whether the whole-tree guarantee actually holds.
    ///
    /// False only on Windows when the job could not be created — which in practice
    /// means this app is already inside a job that forbids breakaway. The kill paths
    /// then degrade to `taskkill /F /T` rather than failing the action.
    pub fn is_tree(&self) -> bool {
        self.0.is_tree()
    }
}

/// Asks the tree to stop, waits out the grace period, then kills it.
///
/// There is no graceful phase on Windows and cannot be: `GenerateConsoleCtrlEvent`
/// needs a console this GUI process does not have, and `taskkill` without `/F` posts
/// `WM_CLOSE`, which console programs ignore. So "Stop" terminates there, and the
/// action descriptions say so.
pub async fn terminate(g: &Group, grace: std::time::Duration) {
    if g.0.request_stop() {
        tokio::time::sleep(grace).await;
    }
    g.0.kill();
}

/// The synchronous variant, for app shutdown where nothing can be awaited.
pub fn terminate_now(g: &Group) {
    g.0.kill();
}

/// Whether a process with this pid exists.
///
/// Best-effort by nature — a recycled pid reads as alive — so it is only ever used
/// to *retire* a dev row that already looks dead, never to claim one is up. The
/// failure mode is a row that lingers a little longer, not a dead server reported
/// as running. pid 0 and 1 are never ours, and asking about them is meaningless.
pub fn pid_alive(pid: u32) -> bool {
    pid > 1 && imp::pid_alive(pid)
}

/// Ends a terminal session's tree the way closing its window would.
///
/// Unix: `SIGHUP`, which is what a hangup on the controlling terminal delivers.
/// Windows: there is no SIGHUP for a ConPTY child, and dropping the pseudoconsole is
/// the nearest equivalent — which `pty` already does — so this terminates.
pub fn hangup(g: &Group) {
    g.0.hangup();
}

// ---------------------------------------------------------------------------
// Port inspection
// ---------------------------------------------------------------------------

/// Who is listening on a TCP port.
///
/// `ss` then `lsof` on unix; `netstat` on Windows, which is always present and needs
/// no elevation. Returns pids with the process name where known, so the confirmation
/// dialog can say *what* it is about to signal rather than just a number.
pub async fn port_holders(tc: &crate::toolchain::Toolchain, port: u16) -> Vec<(u32, String)> {
    imp::port_holders(tc, port).await
}

/// One command per pid to free a port.
///
/// A `Vec` of argvs rather than one, because `taskkill` takes a single `/PID` — so
/// the Windows form is inherently per-process, and the caller runs them as a
/// sequence of steps. That also gives the action per-pid result markers, which the
/// single `kill -TERM a b c` never had.
pub fn kill_pids_argv(pids: &[u32]) -> Vec<Vec<String>> {
    pids.iter().map(|p| imp::kill_pid_argv(*p)).collect()
}

/// What "free this port" actually does to a process, for the confirmation dialog.
///
/// Not cosmetic: on unix these get a SIGTERM they can catch and clean up after, and
/// on Windows they are terminated outright. Saying "signalled" on Windows would be a
/// lie, and this is a dialog whose whole job is to be believed.
pub fn kill_verb_note() -> &'static str {
    #[cfg(windows)]
    {
        "These are terminated outright — Windows has no signal for a polite stop. \
         Anything unsaved in them is lost."
    }
    #[cfg(not(windows))]
    {
        "These are signalled directly. Anything unsaved in them is lost."
    }
}

/// Parses the `users:(("node",pid=12345,fd=20))` tail of an `ss -p` line.
///
/// `ss` exists only on unix; kept under `test` too so the parser stays covered.
#[cfg(any(unix, test))]
pub fn parse_ss_holders(stdout: &str) -> Vec<(u32, String)> {
    let mut out: Vec<(u32, String)> = Vec::new();

    for line in stdout.lines() {
        let Some(users) = line.split("users:(").nth(1) else {
            continue;
        };
        // Each entry looks like ("name",pid=N,fd=M)
        for entry in users.split("),(") {
            let name = entry.split('"').nth(1).unwrap_or_default().to_string();
            if let Some(rest) = entry.split("pid=").nth(1) {
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(pid) = digits.parse::<u32>() {
                    if !out.iter().any(|(p, _)| *p == pid) {
                        out.push((pid, name));
                    }
                }
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// External terminal
// ---------------------------------------------------------------------------

/// A terminal emulator, and how it wants the command handed over.
pub struct TerminalCmd {
    pub program: String,
    /// Flags that come before the command.
    pub pre: Vec<String>,
    /// True when the command must arrive as one argument rather than as an argv.
    ///
    /// ptyxis is the reason this exists: its `--tab` only combines with `-x`, which
    /// takes the whole command line as a single string. Given a real argv after `--`
    /// it ignores `--tab` and opens a *window* instead, which is what it was doing.
    pub single_string: bool,
}

/// Finds a terminal emulator to hand an interactive script to.
///
/// Degrades to an error carrying the exact command, so the UI can offer "copy" —
/// which is far better than piping canned menu answers into a script that pushes
/// commits and publishes packages.
pub fn find_terminal(tc: &crate::toolchain::Toolchain) -> Option<TerminalCmd> {
    let _ = tc;
    imp::find_terminal()
}

/// Whether handing a *script* to an external terminal can work at all here.
///
/// False on Windows, deliberately, and this is a feature reduction rather than a
/// port. `wt.exe` splits its own command line on `;`, and every script this app
/// generates is full of them — escaping through two layers of quoting is exactly the
/// class of bug the `single_string` field above is a monument to. The integrated PTY
/// already handles an interactive script well, so `commands` rewrites the request to
/// use it instead of failing.
///
/// "Open a shell here" is unaffected: it has no script, so it still gets a real
/// Windows Terminal tab. See `imp::find_terminal`.
pub fn external_terminal_available(tc: &crate::toolchain::Toolchain) -> bool {
    #[cfg(windows)]
    {
        let _ = tc;
        false
    }
    #[cfg(not(windows))]
    {
        find_terminal(tc).is_some()
    }
}

/// Pids listening on `port`, from `netstat -ano -p tcp`.
///
/// ```text
///   Proto  Local Address      Foreign Address    State       PID
///   TCP    0.0.0.0:3000       0.0.0.0:0          LISTENING   12345
///   TCP    [::]:3000          [::]:0             LISTENING   12345
/// ```
///
/// The address is matched on its `:port` suffix rather than parsed, because the local
/// column is `0.0.0.0:3000`, `127.0.0.1:3000` or `[::]:3000` depending on the bind —
/// and a suffix match handles all three without caring which.
pub fn parse_netstat_holders(stdout: &str, port: u16) -> Vec<u32> {
    let suffix = format!(":{port}");
    let mut out: Vec<u32> = Vec::new();

    for line in stdout.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Proto, local, foreign, state, pid.
        if cols.len() < 5 {
            continue;
        }
        if !cols[0].eq_ignore_ascii_case("tcp") {
            continue;
        }
        // Only a listener holds the port; an outbound connection from an ephemeral
        // port that happens to equal this one must not be reported.
        if !cols[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        if !cols[1].ends_with(&suffix) {
            continue;
        }
        if let Ok(pid) = cols[4].parse::<u32>() {
            // The same server appears once per bound address family.
            if pid != 0 && !out.contains(&pid) {
                out.push(pid);
            }
        }
    }
    out
}

/// The image name from one `tasklist /NH /FO CSV` row: `"node.exe","12345",…`.
pub fn parse_tasklist_csv(stdout: &str) -> Option<String> {
    let line = stdout.lines().find(|l| l.trim_start().starts_with('"'))?;
    let name = line.split('"').nth(1)?.trim();
    // "INFO: No tasks are running…" has no quotes at all, so reaching here means a
    // real row — but an empty name is still not worth reporting as one.
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every child in the crate is shaped by one of the four functions above.
    ///
    /// This is a source-text test rather than a behavioural one because there is no
    /// way to read creation flags back off a `Command`, and the failure it catches is
    /// invisible on a Linux dev box and glaring on Windows: a child built by hand,
    /// with no `CREATE_NO_WINDOW`, flashes a console window per spawn. `autofetch`
    /// missed it and produced a wall of `git.exe` windows every cycle, one per repo,
    /// which is what this exists to stop happening a second time.
    ///
    /// `detach` counts: a GUI child wants no console flag. So does the ConPTY path in
    /// `windows.rs`, which owns a pseudoconsole rather than allocating one.
    #[test]
    fn every_spawned_child_is_shaped_by_this_module() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut unshaped: Vec<String> = Vec::new();

        for entry in walk_rs(&dir) {
            let text = std::fs::read_to_string(&entry).unwrap();
            let name = entry.file_name().unwrap().to_string_lossy().to_string();
            // This module defines the shaping, and pty.rs spawns through ConPTY/openpty
            // rather than through Command.
            if matches!(name.as_str(), "mod.rs" | "windows.rs" | "unix.rs" | "pty.rs") {
                continue;
            }

            let lines: Vec<&str> = text.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                // A comment is allowed to name the type it is talking about.
                if !line.contains("Command::new") || line.trim_start().starts_with("//") {
                    continue;
                }
                // The shaping call sits with the rest of the builder, a handful of
                // lines at most — args and stdio are all that come between.
                let end = (i + 25).min(lines.len());
                let shaped = lines[i..end].iter().any(|l| {
                    l.contains("hide_console")
                        || l.contains("new_group")
                        || l.contains("platform::detach")
                        || l.contains("git::harden")
                        || l.contains("harden(&mut")
                });
                if !shaped {
                    unshaped.push(format!("{name}:{}", i + 1));
                }
            }
        }

        assert!(
            unshaped.is_empty(),
            "these spawn sites shape no child — call platform::hide_console (or \
             new_group/detach, or git::harden) on them: {unshaped:?}"
        );
    }

    fn walk_rs(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk_rs(&path));
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
        out
    }

    #[test]
    fn parses_ss_single_holder() {
        let out = r#"LISTEN 0 511 *:8100 *:* users:(("node",pid=12345,fd=20))"#;
        assert_eq!(parse_ss_holders(out), vec![(12345, "node".to_string())]);
    }

    #[test]
    fn parses_ss_multiple_holders_and_dedupes() {
        let out = "LISTEN 0 511 *:3000 *:* users:((\"node\",pid=111,fd=20),(\"node\",pid=222,fd=21))\n\
                   LISTEN 0 511 [::]:3000 [::]:* users:((\"node\",pid=111,fd=22))";
        let h = parse_ss_holders(out);
        assert_eq!(h.len(), 2);
        assert!(h.contains(&(111, "node".to_string())));
        assert!(h.contains(&(222, "node".to_string())));
    }

    #[test]
    fn no_holders_when_nothing_listens() {
        assert!(parse_ss_holders("").is_empty());
        assert!(parse_ss_holders("LISTEN 0 511 *:8100 *:*").is_empty());
    }

    #[test]
    fn netstat_reports_only_listeners_on_the_asked_for_port() {
        let out = "\
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12345
  TCP    [::]:3000              [::]:0                 LISTENING       12345
  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       999
  TCP    192.168.1.5:53000      93.184.216.34:3000     ESTABLISHED     777
  UDP    0.0.0.0:3000           *:*                                    555
";
        // Deduplicated across address families, which is one server, not two.
        assert_eq!(parse_netstat_holders(out, 3000), vec![12345]);
        assert_eq!(parse_netstat_holders(out, 3001), vec![999]);
        // An outbound connection *to* :3000 does not hold :3000.
        assert!(!parse_netstat_holders(out, 3000).contains(&777));
        assert!(parse_netstat_holders(out, 9999).is_empty());
    }

    #[test]
    fn netstat_does_not_confuse_a_port_with_its_suffix() {
        let out = "  TCP    0.0.0.0:13000          0.0.0.0:0              LISTENING       42\n";
        // `:13000` must not match a query for port 3000.
        assert!(parse_netstat_holders(out, 3000).is_empty());
        assert_eq!(parse_netstat_holders(out, 13000), vec![42]);
    }

    #[test]
    fn tasklist_names_the_process_and_tolerates_no_match() {
        assert_eq!(
            parse_tasklist_csv("\"node.exe\",\"12345\",\"Console\",\"1\",\"52,000 K\"\n").as_deref(),
            Some("node.exe")
        );
        assert!(parse_tasklist_csv("INFO: No tasks are running which match.\n").is_none());
        assert!(parse_tasklist_csv("").is_none());
    }

    #[test]
    fn freeing_a_port_is_one_command_per_pid() {
        let argv = kill_pids_argv(&[10, 20]);
        assert_eq!(argv.len(), 2, "taskkill takes a single /PID");
        // And the verb note must match what actually happens to the process.
        #[cfg(windows)]
        assert!(kill_verb_note().contains("terminated"));
        #[cfg(not(windows))]
        assert!(kill_verb_note().contains("signalled"));
    }

    #[test]
    fn posix_quoting_survives_an_apostrophe() {
        assert_eq!(sh_quote("O'Brien"), r"'O'\''Brien'");
        assert_eq!(sh_quote("plain"), "'plain'");
    }

    #[test]
    fn powershell_quoting_doubles_the_quote_and_swallows_everything_else() {
        assert_eq!(ps_quote("O'Brien"), "'O''Brien'");
        // The three characters that would expand in a double-quoted PowerShell
        // string are inert in a single-quoted one, which is why this is total.
        assert_eq!(ps_quote("$x `n \"q\""), "'$x `n \"q\"'");
    }

    #[test]
    fn a_windows_path_is_translated_not_escaped() {
        // `cd 'C:\w\api'` would look for a directory literally named `C:wapi`.
        assert_eq!(bash_path(r"C:\w\api"), "C:/w/api");
        // A space is left alone: quoting handles it, and translating it would be wrong.
        assert_eq!(bash_path(r"C:\My Projects\api"), "C:/My Projects/api");
        assert_eq!(bash_path("/home/x/api"), "/home/x/api");
    }

    #[test]
    fn unix_path_extensions_are_the_empty_string() {
        // The invariant `which_in` relies on: on unix the name is the whole name,
        // so exactly one candidate per directory is ever tried.
        #[cfg(unix)]
        assert_eq!(path_exts(), &["".to_string()]);
    }

    #[test]
    fn a_verbatim_prefix_is_only_ever_stripped_on_windows() {
        #[cfg(unix)]
        assert_eq!(strip_verbatim(Path::new("/home/x")), PathBuf::from("/home/x"));
    }

    #[test]
    fn a_batch_shim_is_wrapped_only_on_windows() {
        // `npm` is `npm.cmd` on Windows, and ConPTY's CreateProcessW refuses a batch
        // file outright — so without this a Toolbox install in a terminal tab never
        // starts. Unix must be left completely alone.
        let argv = vec![r"C:\Program Files\nodejs\npm.cmd".to_string(), "-v".to_string()];
        let out = pty_argv(&argv);
        #[cfg(windows)]
        assert_eq!(out[..2], ["cmd.exe", "/C"]);
        #[cfg(unix)]
        assert_eq!(out, argv);

        // A real executable is never wrapped, on either platform.
        let exe = vec!["/usr/bin/git".to_string(), "status".to_string()];
        assert_eq!(pty_argv(&exe), exe);
    }

    #[test]
    fn which_finds_a_real_binary_and_misses_a_made_up_one() {
        // Guards the PATHEXT loop against the obvious regression of never matching.
        #[cfg(unix)]
        assert!(which("sh").is_some());
        assert!(which("definitely-not-a-real-binary-xyzzy").is_none());
    }
}
