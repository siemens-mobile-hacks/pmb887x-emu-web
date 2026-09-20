#!/bin/bash
# Check out the pinned pmb887x-dev (BSP) revision into build/bsp.
#
# There is nothing to patch or merge any more: bsp master absorbed
# everything this script used to carry — the hd155153np RF peripheral is
# commented out at the source (bsp 55752c5, 2026-09-15, which retired the
# old bsp-patches/ dir), and perk11's "board: LG boards read the RTC
# counter as packed calendar fields" (PR#6) landed upstream as e8d490e
# (2026-09-20), which retired PMB887X_BSP_FIX_REV and the merge it used to
# recreate. A plain checkout of PMB887X_BSP_REV is the whole story.
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

  # The checkout is left alone while it already sits on the pin —
  # rebuilding it from scratch on every run would churn for nothing.
  if [ "$(git rev-parse HEAD)" != "$PMB887X_BSP_REV" ]; then
    git checkout -q -f -B bsp "$PMB887X_BSP_REV"
  fi
  git checkout -q -f -- . 2>/dev/null || true
)

echo "bsp ready: $BSP @ $PMB887X_BSP_REV"
