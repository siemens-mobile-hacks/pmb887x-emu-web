#!/bin/bash
# Release build: rebuild the wasm dists from the latest code, then bundle
# them for static deployment (dist/).
#
# What "latest code" means here: the superproject's HEAD is the source of
# truth —
#   - qemu/, bsp/ and pmb887x-emu/ must sit exactly on their gitlinks with no
#     local changes or untracked files, or the release stops (it never moves
#     or cleans a checkout: an edited file must not leak into a release
#     artifact, and a commit not yet in a gitlink must not either)
#   - the same goes for what this repo itself puts into the bundle or builds
#     it with: site/, site-src/, scripts/ and build.sh
#   - PMB887X_BSP_DIR must be unset: a bsp from elsewhere is no pin
#   - the built dist's qemu-source.txt must name the qemu gitlink exactly
#   - build/qemu-wasm64 is wiped, so no ninja object
#     from an earlier tree can survive into the artifacts
# The pinned toolchain/deps (build/deps: emsdk + glib/pixman/zlib/libffi)
# are KEPT — they are versions, not code, and rebuilding them is most of
# the first-run time for nothing.  DEPS_CLEAN=1 wipes them too.
#
#   scripts/build-release.sh          rebuild latest → ./build.sh → dist/
#   DEPS_CLEAN=1 ...                  cold build (toolchain/deps rebuilt)
#
# bundle-dist.sh env flags (BUNDLE_TESTS/BUNDLE_SYMBOLS/BUNDLE_OUT/
# GZIP_LEVEL) and build.sh env (WASM_DEPS, WEB_BUILD) pass through.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$WEB_DIR/scripts/build-dirs.sh"
source "$WEB_DIR/scripts/submodules.sh"
cd "$WEB_DIR"

note() { echo "build-release: $*"; }

# ---- 1. sources = the gitlinks, exactly --------------------------------

if [ -n "${PMB887X_BSP_DIR:-}" ]; then
  echo "build-release.sh: PMB887X_BSP_DIR is set ($PMB887X_BSP_DIR); a release builds the bsp/ gitlink, unset it" >&2
  exit 1
fi
# (only pmb887x-emu's own top level, not its nested qemu)
for sub in qemu bsp pmb887x-emu; do
  submodule_require_pin "$sub"
done
own="$(git status --porcelain --untracked-files=normal -- site site-src scripts build.sh)"
if [ -n "$own" ]; then
  echo "build-release.sh: uncommitted or untracked files in what the release bundles or builds with:" >&2
  echo "$own" >&2
  exit 1
fi
note "qemu @ $(git -C qemu rev-parse --short HEAD), bsp @ $(git -C bsp rev-parse --short HEAD) (the gitlinks)"

# ---- 2. wipe the qemu build dirs (toolchain/deps stay) ------------------

rm -rf "$BUILD/qemu-wasm64"
# site/dist holds assets only (boards.tar, the key module); drop any engine
# a former TCI build left there.
rm -f site/dist/qemu-system-arm.js site/dist/qemu-system-arm.wasm \
      site/dist/qemu-system-arm.js.symbols site/dist/qemu-system-arm.wasm.gz
if [ "${DEPS_CLEAN:-0}" = 1 ]; then
  rm -rf "$DEPS_ROOT"
  note "DEPS_CLEAN=1: $DEPS_ROOT wiped too — expect the full first-run cost"
fi

# ---- 3. rebuild + bundle ------------------------------------------------

# build.sh: deps (cached unless DEPS_CLEAN) → submodule init/sync-bsp/
# pack-boards/build-recalc-wasm (idempotent re-syncs) → build-qemu-wasm64
# → site/dist-jit.  Native build dirs
# (qemu-native*) are not part of the deploy path and are left alone.
bash ./build.sh

built="$(cat site/dist-jit/qemu-source.txt 2>/dev/null || true)"
pin="$(submodule_pin qemu)"
if [ "$built" != "$pin" ]; then
  echo "build-release.sh: site/dist-jit was built from qemu ${built:-<no qemu-source.txt>}, not its gitlink $pin" >&2
  exit 1
fi

bash scripts/bundle-dist.sh

note "done — bundle in $WEB_DIR/dist; deploy via deploy/nginx/README.md"
