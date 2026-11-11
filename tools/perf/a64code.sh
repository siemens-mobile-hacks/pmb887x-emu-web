#!/bin/bash
# Print the arm64 code V8's optimizing tier makes of a wasm module, with
# explicit bounds checks as on Android: what a phone runs, read on an x64
# host.  The module is one that tools/perf/wasmgrab.mjs saved.
#
#   tools/perf/a64code.sh <module.wasm> [out file]
#
# Runs an arm64 Node under qemu-user (scripts/setup-android-emu.sh
# linux-install brings qemu-user and the arm64 libraries), fetched on first
# use.  A64_NODE picks the release: take the one whose V8 is the phone's
# Chrome's (`node -p process.versions.v8`; Chrome 156 is V8 15.6).  Older
# V8s differ where it matters: 12.4 (Node 22) spills a TB's parameters at
# entry and does not inline the pc-cache probe.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
U="$ROOT/build/android-emu/linux-arm64"
V="${A64_NODE:-v27.0.0-alpha.0.0.0}"
N="$U/node-$V"
if [ ! -x "$N/bin/node" ]; then
  mkdir -p "$N"
  curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-arm64.tar.xz" | tar -xJ -C "$N" --strip-components=1
fi
exec qemu-aarch64 -L "$U/root" "$N/bin/node" --no-liftoff --no-wasm-lazy-compilation \
  --wasm-enforce-bounds-checks --print-wasm-code \
  -e 'new WebAssembly.Module(require("fs").readFileSync(process.argv[1]))' "$1" > "${2:-/dev/stdout}" 2>&1
