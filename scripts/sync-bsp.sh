#!/bin/bash
# The board configs come from the bsp/ submodule (pmb887x-dev), pinned by its
# gitlink. This checks it out the first time; after that the checkout is
# used as it is, with one warning line when it is not at its gitlink.
# PMB887X_BSP_DIR (scripts/build-dirs.sh) points the build at another
# checkout instead, which is then used as it is.
#
# There is nothing to patch or merge: bsp master absorbed everything this
# script used to carry — the hd155153np RF peripheral is commented out at
# the source (bsp 55752c5, 2026-09-15, which retired the old bsp-patches/
# dir), and perk11's "board: LG boards read the RTC counter as packed
# calendar fields" (PR#6) landed upstream as e8d490e (2026-09-20), which
# retired PMB887X_BSP_FIX_REV and the merge it used to recreate.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$WEB_DIR/scripts/build-dirs.sh"
source "$WEB_DIR/scripts/submodules.sh"

if [ "$BSP_DIR" = "$WEB_DIR/bsp" ]; then
  submodule_init bsp
  submodule_warn_off_pin bsp
fi

echo "bsp ready: $BSP_DIR @ $(git -C "$BSP_DIR" rev-parse --short HEAD)"
