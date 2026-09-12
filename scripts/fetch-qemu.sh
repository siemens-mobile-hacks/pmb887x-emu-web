#!/bin/bash
# Ensure the qemu source tree is ready. qemu lives as a root submodule
# (branch wasm-browser-port — all former patches/*.patch committed on top
# of qemu-pmb887x master, plus the AFE + RTC-seed commits cherry-picked
# from the perk11/alula fork line, see versions.env). The pmb887x-emu
# meta-repo (also a root submodule) is initialized alongside it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/versions.env"

QEMU="$ROOT/qemu"

git submodule update --init pmb887x-emu qemu

if [ "$(git -C "$QEMU" rev-parse HEAD)" != "$QEMU_PMB887X_REV" ]; then
  git -C "$QEMU" checkout -q -B "$QEMU_PMB887X_BRANCH" "$QEMU_PMB887X_REV" 2>/dev/null \
    || git -C "$QEMU" checkout -q -f "$QEMU_PMB887X_REV"
fi
echo "qemu source ready: $QEMU @ $QEMU_PMB887X_REV"
