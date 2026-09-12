#!/bin/bash
# Ensure the qemu source tree is ready. qemu lives as a root submodule
# (branch wasm-browser-port — the whole wasm/TCI/perf series committed on top
# of qemu-pmb887x master, plus the AFE + RTC-seed commits cherry-picked
# from the perk11/alula fork line, see versions.env). The pmb887x-emu
# meta-repo is kept at master alongside it; its own qemu submodule is
# NOT used — the root qemu submodule is the build source.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/versions.env"

QEMU="$ROOT/qemu"

# init only the top-level submodules (not pmb887x-emu's nested qemu)
git submodule update --init

if [ "$(git -C "$QEMU" rev-parse HEAD)" != "$QEMU_PMB887X_REV" ]; then
  git -C "$QEMU" checkout -q -B "$QEMU_PMB887X_BRANCH" "$QEMU_PMB887X_REV" 2>/dev/null \
    || git -C "$QEMU" checkout -q -f "$QEMU_PMB887X_REV"
fi
echo "qemu source ready: $QEMU @ $QEMU_PMB887X_REV"
