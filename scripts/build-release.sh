#!/bin/bash
# Release build: rebuild the wasm dists from the latest code, then bundle
# them for static deployment (dist/).
#
# What "latest code" means here: versions.env is the source of truth —
#   - qemu/ is hard-synced to the pinned rev (fetch-qemu.sh inits, then
#     a forced checkout discards any local edits — an edited file in the
#     tree must never leak into a release artifact)
#   - bsp is re-synced and bsp-patches re-applied (sync-bsp.sh, idempotent)
#   - build/qemu-wasm64 and build/qemu-wasm are wiped, so no ninja object
#     from an earlier tree can survive into the artifacts
# The pinned toolchain/deps (build/deps: emsdk + glib/pixman/zlib/libffi)
# are KEPT — they are versions, not code, and rebuilding them is most of
# the first-run time for nothing.  DEPS_CLEAN=1 wipes them too.
#
#   scripts/build-release.sh          rebuild latest → ./build.sh → dist/
#   TCI=1 scripts/build-release.sh    also build the TCI reference dist
#   DEPS_CLEAN=1 ...                  cold build (toolchain/deps rebuilt)
#
# bundle-dist.sh env flags (BUNDLE_TESTS/BUNDLE_SYMBOLS/BUNDLE_OUT/
# GZIP_LEVEL) and build.sh env (TCI, WASM_DEPS, WEB_BUILD) pass through.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WEB_DIR"
source ./versions.env

note() { echo "build-release: $*"; }

# ---- 1. qemu source = the pin, exactly --------------------------------

# Best-effort: make the pinned objects available when the pin was just
# bumped (GitHub allows fetching SHAs).  Harmless when present, tolerated
# when offline.
git -C qemu fetch origin "$QEMU_PMB887X_REV" 2>/dev/null ||
  note "fetch of $QEMU_PMB887X_REV failed (offline?) — continuing with local objects"

bash scripts/fetch-qemu.sh
# fetch-qemu.sh only checks out when HEAD moved; force the worktree to
# the pin unconditionally so local edits cannot ride along.
git -C qemu checkout -q -f -B "$QEMU_PMB887X_BRANCH" "$QEMU_PMB887X_REV"
[ -z "$(git -C qemu status --porcelain)" ] ||
  note "WARNING: qemu/ still dirty after forced checkout (untracked files — inspect with: git -C qemu status)"
note "qemu @ $(git -C qemu rev-parse --short HEAD) (versions.env pin $QEMU_PMB887X_REV)"

# ---- 2. wipe the qemu build dirs (toolchain/deps stay) ------------------

rm -rf build/qemu-wasm64 build/qemu-wasm
# Without TCI=1 nothing rebuilds site/dist's engine, and its build dir is
# gone — drop a stale copy instead of letting bundle-dist ship an engine
# that was not built from the pin (?dist=dist 404s on the deployed page
# rather than silently running old code; boards.tar is repacked fresh).
if [ -z "${TCI:-}" ]; then
  rm -f site/dist/qemu-system-arm.js site/dist/qemu-system-arm.wasm \
        site/dist/qemu-system-arm.js.symbols site/dist/qemu-system-arm.wasm.gz
fi
if [ "${DEPS_CLEAN:-0}" = 1 ]; then
  rm -rf build/deps
  note "DEPS_CLEAN=1: build/deps wiped too — expect the full first-run cost"
fi

# ---- 3. rebuild + bundle ------------------------------------------------

# build.sh: deps (cached unless DEPS_CLEAN) → fetch-qemu/sync-bsp/
# pack-boards (idempotent re-syncs) → build-qemu-wasm64 → site/dist-jit
# (+ site/dist with TCI=1).  Native build dirs (qemu-native*) are not
# part of the deploy path and are left alone.
TCI="${TCI:-}" bash ./build.sh

bash scripts/bundle-dist.sh

note "done — bundle in $WEB_DIR/dist; deploy via deploy/nginx/README.md"
