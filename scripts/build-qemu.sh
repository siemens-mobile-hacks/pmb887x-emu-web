#!/bin/bash
# Build qemu-system-arm (pmb887x) as WebAssembly + assemble dist.
#
# Builds the qemu/ submodule as it is checked out (its gitlink is the pin;
# a checkout ahead of it is the normal state while developing, and is only
# warned about), then:
# the wasm64 TCG backend -> site/dist-jit/, plus site/dist/boards.tar
# (board configs from bsp; the page always fetches it from dist/).
# site/ is served directly by serve.mjs — nothing is copied for it.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$WEB_DIR/scripts/build-dirs.sh"
source "$WEB_DIR/scripts/submodules.sh"
TARGET="$DEPS_ROOT/target"
DIST="$WEB_DIR/site/dist"
mkdir -p "$BUILD" "$DIST"

use_emsdk
export PATH="$HOME/.local/bin:$PATH"
export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"

# --- qemu source: the qemu/ submodule as checked out ---
# A submodule is checked out only the first time; after that it is never
# moved (only pmb887x-emu's own top level, not its nested qemu).
for sub in qemu pmb887x-emu; do
  submodule_init "$sub"
  submodule_warn_off_pin "$sub"
done

# --- board configs from the bsp/ submodule ---
bash "$WEB_DIR/scripts/sync-bsp.sh"

# --- build: wasm64 TCG backend (site/dist-jit/, the page default) ---
# Its deploy (deploy-dist.sh) also packs boards.tar and builds the Siemens
# key module into site/dist/.
bash "$WEB_DIR/scripts/build-qemu-wasm64.sh"

echo "=== web dist ready: $WEB_DIR/site/dist-jit ==="
