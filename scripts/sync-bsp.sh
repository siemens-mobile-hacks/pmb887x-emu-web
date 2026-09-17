#!/bin/bash
# Check out the pinned pmb887x-dev (BSP) revision into build/bsp, with the
# still-unmerged PR#6 fix kept on top.
#
# There is nothing to patch any more: the hd155153np RF peripheral the
# emulator has no table entry for is commented out at the source as of
# bsp 55752c5, so the bsp-patches/ directory this script used to apply
# was removed on 2026-09-15. What is kept is perk11's "board: LG boards
# read the RTC counter as packed calendar fields" (PR#6 of
# siemens-mobile-hacks/pmb887x-dev, also origin/rtc-calendar-format): it is
# what the LG firmware needs and master does not have it yet, so it is
# merged onto the pinned master rev — a merge this script can recreate on a
# fresh clone, which is why the pin is (master, fix) and not the merge
# commit itself.
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

  # The checkout is left alone while it already carries both the pin and
  # the fix (this script's own output) — rebuilding it from scratch on every
  # run would churn the merge commit for nothing.
  up_to_date() {
    git rev-parse -q --verify HEAD >/dev/null 2>&1 || return 1
    git merge-base --is-ancestor "$PMB887X_BSP_REV" HEAD || return 1
    [ -z "${PMB887X_BSP_FIX_REV:-}" ] && return 0
    git merge-base --is-ancestor "$PMB887X_BSP_FIX_REV" HEAD
  }

  if ! up_to_date; then
    git checkout -q -f -B bsp "$PMB887X_BSP_REV"
    if ! git merge-base --is-ancestor "$PMB887X_BSP_FIX_REV" HEAD; then
      git merge --no-edit -m "Merge the LG RTC calendar fix (PR#6) onto bsp master" "$PMB887X_BSP_FIX_REV"
    fi
  fi
  git checkout -q -- . 2>/dev/null || true
)

echo "bsp ready: $BSP @ $PMB887X_BSP_REV$( [ -n "${PMB887X_BSP_FIX_REV:-}" ] && echo " + $PMB887X_BSP_FIX_REV (PR#6)" )"
