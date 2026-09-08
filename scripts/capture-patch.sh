#!/bin/bash
# Capture uncommitted C edits from build/qemu into patches/ so that
# scripts/build-qemu.sh (which hard-resets the clone to the pinned rev)
# cannot lose iteration work, and other machines can reproduce the tree.
#
# The WIP diff is computed against (pinned rev + already-applied patches/)
# via a throwaway git worktree, so the resulting patch contains ONLY the
# new edits and stacks cleanly on top of patches/*.patch. Submodule trees
# (subprojects/teakra) are excluded — build-qemu.sh fetches those itself.
#
#   scripts/capture-patch.sh [name]     -> patches/NNNN-<name>.patch
set -euo pipefail
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$WEB_DIR/versions.env"
QEMU="$WEB_DIR/build/qemu"
PATCHES="$WEB_DIR/patches"
NAME="${1:-wip}"

[ -d "$QEMU/.git" ] || { echo "no qemu clone at $QEMU" >&2; exit 1; }

REV="$(git -C "$QEMU" rev-parse HEAD)"
PIN="$(git -C "$QEMU" rev-parse "$QEMU_PMB887X_REV^{commit}" 2>/dev/null || true)"
[ "$REV" = "$PIN" ] || [ "${FORCE:-0}" = "1" ] ||
  { echo "build/qemu is at $REV, versions.env pins $QEMU_PMB887X_REV — refusing (FORCE=1 to override)" >&2; exit 1; }

TMP="$(mktemp -d)"
cleanup() {
  git -C "$QEMU" worktree remove --force "$TMP/base" 2>/dev/null || true
  rm -rf "$TMP"
  git -C "$QEMU" worktree prune
}
trap cleanup EXIT

# baseline worktree: pinned rev + current patches = what build-qemu.sh recreates
# (same apply-or-skip logic as build-qemu.sh — e.g. 0005 wasm32 DRAFT only
# applies to the dist-jit tree and is skipped here)
git -C "$QEMU" worktree add --detach "$TMP/base" "$REV" >/dev/null 2>&1
for p in "$PATCHES"/*.patch; do
  if git -C "$TMP/base" apply --check "$p" 2>/dev/null; then
    git -C "$TMP/base" apply -q "$p"
  else
    echo "capture-patch: skip $(basename "$p") (does not apply to pinned rev — same as build-qemu.sh)"
  fi
done

# Candidate WIP files: modified-tracked + untracked-not-ignored per git
# status (respects .gitignore, unlike a raw tree diff). Files whose only
# change is an already-serialized patch diff empty against the baseline and
# drop out naturally.
SUBS="$(git config -f "$QEMU/.gitmodules" --get-regexp '^submodule\..*\.path$' 2>/dev/null | awk '{print $2}')"
: > "$TMP/wip.patch"
while IFS= read -r line; do
  st="${line:0:2}"; f="${line:3}"
  case "$st" in R*) echo "capture-patch: rename not captured: $line" >&2; continue;; esac
  case " $SUBS " in *" $f"*|*" $f/"*) continue;; esac
  [ -f "$TMP/base/$f" ] || [ -f "$QEMU/$f" ] || continue
  d="$(diff -uN "$TMP/base/$f" "$QEMU/$f" || true)"
  [ -n "$d" ] || continue
  if [ ! -e "$TMP/base/$f" ]; then
    printf 'diff --git a/%s b/%s\nnew file mode 100644\n' "$f" "$f" >> "$TMP/wip.patch"
  elif [ ! -e "$QEMU/$f" ]; then
    printf 'diff --git a/%s b/%s\ndeleted file mode 100644\n' "$f" "$f" >> "$TMP/wip.patch"
  else
    printf 'diff --git a/%s b/%s\n' "$f" "$f" >> "$TMP/wip.patch"
  fi
  printf '%s\n' "$d" | sed -E \
    -e "s|^--- ${TMP}/base/.*\t1970-01-01.*$|--- /dev/null|" \
    -e "s|^--- ${TMP}/base/|--- a/|" \
    -e "s|^\+\+\+ ${QEMU}/.*\t1970-01-01.*$|+++ /dev/null|" \
    -e "s|^\+\+\+ ${QEMU}/|+++ b/|" >> "$TMP/wip.patch"
done < <(git -C "$QEMU" status --porcelain -uall)

if ! grep -q "^diff --git" "$TMP/wip.patch"; then
  echo "capture-patch: no uncommitted changes in build/qemu beyond patches/ (nothing to do)"
  exit 0
fi

# sanity: the patch must apply on top of the pristine+patches baseline
git -C "$TMP/base" apply --check "$TMP/wip.patch"

NEXT=$(( 10#$(ls "$PATCHES" | grep -oE "^[0-9]{4}" | sort -n | tail -1) + 1 ))
OUT="$(printf '%s/%04d-%s.patch' "$PATCHES" "$NEXT" "$NAME")"
cp "$TMP/wip.patch" "$OUT"
echo "capture-patch: wrote $OUT ($(grep -c '^diff --git' "$OUT") file(s)) — build-qemu.sh now carries these edits"
