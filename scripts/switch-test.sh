#!/bin/bash
# Switch qemu to a given patch-set configuration and rebuild+deploy.
#   switch-test.sh PRISTINE            reset to pinned rev, no patches
#   switch-test.sh FULL                apply patches/*.patch
#   switch-test.sh MINUS:NNNN          apply all patches except NNNN
#   switch-test.sh REVERT:N1,N2,...    apply all, then reverse-apply the
#                                      listed patches (last-first, i.e. the
#                                      same order they stack in)
# Then runs scripts/ninja-fast.sh (rebuild + deploy).
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$WEB_DIR/versions.env"
QEMU="$WEB_DIR/qemu"
MODE="${1:?PRISTINE|FULL|MINUS:NNNN|REVERT:NNNN}"

cd "$QEMU"
if [ -e tcg/wasm32.c ] || [ -n "$(git status --porcelain -- tcg/wasm32.c tcg/wasm32 2>/dev/null)" ]; then
  echo "REFUSING: uncommitted wasm32 draft present" >&2; exit 1
fi
rm -rf subprojects/teakra
git checkout -qf "$QEMU_PMB887X_REV"
git reset -q --hard "$QEMU_PMB887X_REV"
git clean -qfd

apply_all_except() {
  local skip="$1"
  for p in "$WEB_DIR"/patches/0*.patch; do
    [ -n "$skip" ] && [ "$(basename "$p" | cut -c1-4)" = "$skip" ] && continue
    git apply "$p" || { echo "APPLY FAILED: $(basename "$p")" >&2; exit 1; }
  done
}

case "$MODE" in
  PRISTINE) ;;
  FULL)
    apply_all_except "" ;;
  MINUS:*)
    apply_all_except "${MODE#MINUS:}" ;;
  REVERT:*)
    REVERTS=""
    for n in $(echo "${MODE#REVERT:}" | tr ',' ' '); do
      found=$(ls "$WEB_DIR"/patches/${n}-*.patch 2>/dev/null || true)
      [ -n "$found" ] || { echo "no patch $n" >&2; exit 1; }
      REVERTS="$REVERTS $found"
    done
    apply_all_except ""
    for p in $REVERTS; do
      git apply -R "$p" || { echo "REVERT FAILED: $(basename "$p") (structurally load-bearing)" >&2; exit 2; }
    done ;;
  *) echo "bad mode" >&2; exit 1 ;;
esac
echo "tree: $MODE ($(git status --porcelain | wc -l) modified files)"
bash "$WEB_DIR/scripts/ninja-fast.sh"
