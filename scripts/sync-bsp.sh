#!/bin/bash
# Check out the pinned pmb887x-dev (BSP) revision into build/bsp and apply
# the board-config patches from bsp-patches/.
#
# Workaround (see versions.env): the BSP main branch references devices
# that the emulator does not define; bsp-patches/ re-points them at the
# closest defined stubs. Patches that do not apply (e.g. on older BSP
# revisions that lack the affected sections) are skipped with a notice.
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

shopt -s nullglob
for p in "$ROOT"/bsp-patches/*.patch; do
  if (cd "$BSP" && git apply --check "$p" 2>/dev/null); then
    echo "bsp: applying $(basename "$p")"
    (cd "$BSP" && git apply "$p")
  else
    echo "bsp: skip $(basename "$p") (already applied or not applicable to $(basename "$PMB887X_BSP_REV"))"
  fi
done
echo "bsp ready: $BSP @ $PMB887X_BSP_REV"
