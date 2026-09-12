#!/bin/bash
# Ensure the qemu source tree is ready: the pmb887x-emu meta-repo is
# checked out at the repo root as pmb887x-emu/ (a submodule of this
# repo), and its qemu submodule is checked out at the pinned revision
# (the wasm-patches branch tip, see versions.env). All wasm/tci patches
# are committed on that branch — nothing is applied from patches/ here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/versions.env"

EMU="$ROOT/pmb887x-emu"
QEMU="$EMU/qemu"

if [ ! -e "$EMU/.git" ]; then
  echo "pmb887x-emu missing — run: git submodule update --init pmb887x-emu" >&2
  exit 1
fi
git -C "$EMU" submodule update --init qemu

if [ "$(git -C "$QEMU" rev-parse HEAD)" != "$QEMU_PMB887X_REV" ]; then
  git -C "$QEMU" checkout -q -B "$QEMU_PMB887X_BRANCH" "$QEMU_PMB887X_REV" 2>/dev/null \
    || git -C "$QEMU" checkout -q -f "$QEMU_PMB887X_REV"
fi
echo "qemu source ready: $QEMU @ $QEMU_PMB887X_REV"
