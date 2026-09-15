#!/bin/bash
# Check out the pinned pmb887x-dev (BSP) revision into build/bsp.
#
# There is nothing to patch any more: the hd155153np RF peripheral the
# emulator has no table entry for is commented out at the source as of
# bsp 55752c5, so the bsp-patches/ directory this script used to apply
# was removed on 2026-09-15.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/versions.env"

BSP="${PMB887X_BSP_DIR:-$ROOT/build/bsp}"

if [ ! -d "$BSP/.git" ]; then
  git clone "$PMB887X_BSP_REPO" "$BSP"
fi
(
  cd "$BSP"
  git fetch --all --quiet 2>/dev/null || true
  git checkout -q "$PMB887X_BSP_REV"
  git checkout -q -- . 2>/dev/null || true
)

echo "bsp ready: $BSP @ $PMB887X_BSP_REV"
