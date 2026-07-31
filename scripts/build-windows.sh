#!/usr/bin/env bash
# Cross-builds the Windows installer from Linux, without root.
#
# Tauri's own advice is to build on Windows, and for a *release* that is still the
# right answer — see the caveats at the bottom. This exists because the alternative
# was having no way to check that the Windows target even links, and `cargo check`
# does not exercise the linker or the bundler.
#
# Everything is installed under $CACHE, nothing under /usr, and no sudo is used:
#
#   * cargo-xwin        — downloads Microsoft's CRT and Windows SDK on first run
#   * llvm / lld / clang — for lld-link, llvm-lib and llvm-rc
#   * mingw*-nsis        — for makensis, which builds the installer
#
# The LLVM and NSIS pieces come out of Fedora RPMs extracted with rpm2cpio rather
# than installed, which is what keeps this rootless.
#
# Usage:  scripts/build-windows.sh [--exe-only]

set -euo pipefail

CACHE="${WINXC_CACHE:-/tmp/claude-1000/winxc}"
FEDORA_VER="${FEDORA_VER:-21.1.8-6.fc43}"
NSIS_VER="${NSIS_VER:-3.11-2.fc43}"
TARGET=x86_64-pc-windows-msvc
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exe_only=false
[[ "${1:-}" == "--exe-only" ]] && exe_only=true

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- 1. rust target + cargo-xwin ---------------------------------------------

log "Rust target and cargo-xwin"
rustup target add "$TARGET"
command -v cargo-xwin >/dev/null || cargo install cargo-xwin

# --- 2. LLVM toolchain, extracted rather than installed -----------------------

mkdir -p "$CACHE"
cd "$CACHE"

if [[ ! -x "$CACHE/usr/bin/lld-link" ]]; then
  log "Fetching LLVM (lld-link, llvm-lib, llvm-rc)"
  # llvm-libs and lld-libs carry the shared objects the binaries link against;
  # without them lld-link cannot find liblldELF.so and exits before doing anything.
  dnf download llvm lld clang llvm-libs lld-libs
  for r in llvm lld clang llvm-libs lld-libs; do
    rpm2cpio "$r-$FEDORA_VER.x86_64.rpm" | cpio -idm --quiet
  done
fi

# --- 3. NSIS ------------------------------------------------------------------

if [[ ! -x "$CACHE/real/makensis" ]]; then
  log "Fetching NSIS"
  # mingw-nsis-base has the makensis binary; the two arch packages carry the
  # stubs and plugins. Both stub sets are needed: makensis defaults to the x86
  # one even when producing an x64 installer.
  dnf download mingw-nsis-base mingw32-nsis mingw64-nsis
  for r in mingw-nsis-base-$NSIS_VER.x86_64 mingw32-nsis-$NSIS_VER.noarch mingw64-nsis-$NSIS_VER.noarch; do
    rpm2cpio "$r.rpm" | cpio -idm --quiet
  done

  mkdir -p "$CACHE/real"
  mv "$CACHE/usr/bin/makensis" "$CACHE/real/makensis"

  # Fedora's makensis has /usr/share/nsis compiled in and Tauri spawns it without
  # forwarding NSISDIR, so a wrapper sets it where it cannot be lost. Both names
  # exist because Tauri looks for `makensis.exe` when cross-compiling and
  # `makensis` otherwise — whichever it picks has to be the wrapper, or the real
  # binary is found first and the override is skipped.
  for n in makensis makensis.exe; do
    cat > "$CACHE/usr/bin/$n" <<WRAP
#!/bin/sh
export NSISDIR="$CACHE/usr/share/nsis"
exec "$CACHE/real/makensis" "\$@"
WRAP
    chmod +x "$CACHE/usr/bin/$n"
  done
fi

# Tauri downloads its NSIS plugin into its own cache, but makensis only looks
# under NSISDIR — so it has to be copied across.
plugin="$HOME/.cache/tauri/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll"
if [[ -f "$plugin" ]]; then
  mkdir -p "$CACHE/usr/share/nsis/Plugins/x86-unicode/additional"
  cp -n "$plugin" "$CACHE/usr/share/nsis/Plugins/x86-unicode/additional/" || true
fi

# --- 4. build -----------------------------------------------------------------

export PATH="$HOME/.cargo/bin:$CACHE/usr/bin:$PATH"
export LD_LIBRARY_PATH="$CACHE/usr/lib64:$CACHE/usr/lib64/llvm21/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export XWIN_CACHE_DIR="${XWIN_CACHE_DIR:-$CACHE/../xwin-cache}"

cd "$ROOT"

if $exe_only; then
  log "Building work-alley.exe"
  cargo xwin build --release --target "$TARGET" --manifest-path src-tauri/Cargo.toml
  ls -la "src-tauri/target/$TARGET/release/work-alley.exe"
  exit 0
fi

log "Building the NSIS installer"
bunx tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis

log "Done"
ls -la "src-tauri/target/$TARGET/release/bundle/nsis/"

cat <<'NOTE'

Caveats, in the order they will bite:

  * The installer is UNSIGNED, so Windows SmartScreen warns on first run.
    Signing needs a certificate and, on a Linux host, a `bundle > windows >
    signCommand` in tauri.conf.json.

  * No MSI. WiX only runs on Windows or under Wine; `--bundles nsis` is
    deliberate rather than an oversight.

  * Tauri calls cross-compilation experimental, and it is right to. This build
    is for checking that the Windows target links and bundles at all. Ship from
    a windows-latest CI job.

  * Nothing here has ever been *run*. See docs/windows-support-plan.md for the
    list of things that still need a real Windows machine.
NOTE
