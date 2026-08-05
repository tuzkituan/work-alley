#!/usr/bin/env bash
# Builds the packages here and uploads them to the GitHub release.
#
# This replaces the build jobs that used to run in Actions. The trade is
# deliberate: a Tauri release build is ~15 minutes of CI per platform to produce
# artifacts from a machine nobody is looking at, and the same build already runs
# locally when you want to try the thing. What CI was really buying was a clean
# room; what it cost was that every release went through a queue.
#
# The release is left as a **draft**. Publishing is a separate click, so a bad
# upload is never public.
#
#   scripts/release.sh                 # Linux packages + the Windows installer
#   scripts/release.sh --no-windows    # Linux only, when the cross-build is broken
#   scripts/release.sh --tag v0.1.1    # a tag other than package.json's version
#   scripts/release.sh --no-test       # skip the suites (they run by default)
#
# The tag must already exist and be pushed — this uploads to a release, it does
# not decide that one exists. See the release notes in README.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Windows is in by default: every published release so far carries an installer, and
# the one release built with this script did not — an opt-in flag on a step that
# belongs in every release is a step that gets forgotten.
with_windows=true
run_tests=true
tag=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-windows) with_windows=false ;;
    # Accepted and ignored: it is what the README said for two releases.
    --with-windows) with_windows=true ;;
    --no-test) run_tests=false ;;
    --tag) tag="${2:?--tag needs a value}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die "gh is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in — run: gh auth login"

version="$(node -p 'require("./package.json").version')"
conf_version="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
[[ "$version" == "$conf_version" ]] ||
  die "package.json says $version and tauri.conf.json says $conf_version"
tag="${tag:-v$version}"

# The tag, not HEAD: uploading a build of uncommitted work to a tag that names
# something else is the one mistake this script can make that nobody would catch.
git rev-parse -q --verify "refs/tags/$tag" >/dev/null ||
  die "tag $tag does not exist locally"
[[ -z "$(git status --porcelain)" ]] ||
  die "working tree is dirty — commit or stash before building a release"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse "$tag^{commit}")" ]] ||
  die "HEAD is not $tag — check out the tag you are releasing"

if $run_tests; then
  log "Tests"
  bun test
  bun run lint
  cargo test --manifest-path src-tauri/Cargo.toml
fi

log "Building Linux packages"
# NO_STRIP is not optional on a current distribution. linuxdeploy ships its own
# ancient binutils, and that `strip` cannot read the `.relr.dyn` sections in
# Fedora 43's system libraries — it fails on every one of the ~40 libraries it
# copies into the AppDir and takes the AppImage down with it. The deb and rpm are
# already built by then, so the failure looks like "two of three packages", which
# is a confusing way to find out. Nothing is lost by keeping the symbols: this is
# a debug-symbol strip of *system* libraries, not of the app.
NO_STRIP=true bun run tauri build

bundle="src-tauri/target/release/bundle"
artifacts=()

# Only this version's packages.
#
# `*.deb` collected every deb in the bundle directory, and cargo never cleans that
# directory out — so a machine that had built 0.1.0 through 0.1.2 uploaded all four
# debs and all four rpms to the 0.1.3 release. The AppImages happened not to pile up
# the same way (the older ones failed to bundle before NO_STRIP), which is why this
# looked like six stale assets rather than a glob that was never version-scoped.
#
# The version is in every bundler's filename, in three different shapes —
# `_0.1.3_amd64.deb`, `-0.1.3-1.x86_64.rpm`, `_0.1.3_x64-setup.exe` — so match it
# loosely and let the extension do the rest.
collect() {
  local dir="$1" ext="$2" found=0 f
  for f in "$dir"/*"$version"*"$ext"; do
    [[ -e "$f" ]] || continue
    artifacts+=("$f")
    found=1
  done
  [[ $found -eq 1 ]] || die "no $ext for $version under $dir"
}

collect "$bundle/deb" .deb
collect "$bundle/rpm" .rpm
collect "$bundle/appimage" .AppImage

if $with_windows; then
  log "Cross-building the Windows installer"
  # Unsigned, and never actually run on Windows — see the caveats this prints.
  scripts/build-windows.sh
  collect "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis" .exe
fi

log "Uploading to $tag"
if ! gh release view "$tag" >/dev/null 2>&1; then
  cat > /tmp/work-alley-notes.md <<NOTES
Built locally from \`$tag\`.

- \`.deb\` — Debian, Ubuntu and derivatives
- \`.rpm\` — Fedora, RHEL and openSUSE
- \`.AppImage\` — everything else, no install required

The Linux packages declare webkit2gtk 4.1 and GTK 3 as dependencies, so a package
manager will pull them in.
NOTES
  gh release create "$tag" --draft --title "Work Alley $tag" \
    --notes-file /tmp/work-alley-notes.md
fi

# `--clobber` so re-running after a failed upload replaces the partial asset
# rather than erroring on a name that is already taken.
gh release upload "$tag" "${artifacts[@]}" --clobber

# A draft can already hold assets — a half-finished earlier attempt, or a build of
# a different version someone attached by hand. `--clobber` only replaces names it
# is uploading, so those survive and the release ships two versions of itself.
# Reported rather than deleted: this script does not know what it did not upload.
stale="$(gh release view "$tag" --json assets \
  --jq "[.assets[].name | select(contains(\"$version\") | not)] | join(\" \")")"
if [[ -n "$stale" ]]; then
  printf '\033[33mwarning:\033[0m the draft also holds assets from another version:\n' >&2
  printf '  %s\n' $stale >&2
  printf 'Remove with:  gh release delete-asset %s <name> -y\n' "$tag" >&2
fi

log "Done — the release is a draft"
gh release view "$tag" --json url --jq .url
printf 'Publish it with:  gh release edit %s --draft=false\n' "$tag"
