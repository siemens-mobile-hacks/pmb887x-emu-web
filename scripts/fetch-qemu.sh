#!/bin/bash
# Ensure the pinned qemu revision exists in build/qemu (clone if needed).
#
# The pinned QEMU_PMB887X_REV may live on a fork branch
# (QEMU_PMB887X_ALT_REPO/BRANCH, see versions.env); fetch it explicitly
# when origin does not have the commit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/versions.env"

SRC="${1:-$ROOT/build/qemu}"

if [ ! -d "$SRC/.git" ]; then
  git clone "$QEMU_PMB887X_REPO" "$SRC"
fi
cd "$SRC"
git fetch --all --quiet 2>/dev/null || true

if ! git cat-file -e "$QEMU_PMB887X_REV^{commit}" 2>/dev/null; then
  if [ -n "${QEMU_PMB887X_ALT_REPO:-}" ]; then
    echo "qemu: $QEMU_PMB887X_REV not on $QEMU_PMB887X_REPO — fetching $QEMU_PMB887X_ALT_REPO ($QEMU_PMB887X_ALT_BRANCH)"
    git remote add alt "$QEMU_PMB887X_ALT_REPO" 2>/dev/null || git remote set-url alt "$QEMU_PMB887X_ALT_REPO"
    git fetch alt "$QEMU_PMB887X_ALT_BRANCH" --quiet
    git cat-file -e "$QEMU_PMB887X_REV^{commit}"  # verify
  else
    echo "qemu: revision $QEMU_PMB887X_REV not found" >&2
    exit 1
  fi
fi
echo "qemu source ready: $SRC @ $QEMU_PMB887X_REV"
