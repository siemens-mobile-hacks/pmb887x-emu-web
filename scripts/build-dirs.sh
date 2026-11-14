# The directories the build scripts share, sourced by each of them so that
# one setting moves them all:
#   WEB_BUILD        the wasm build tree (default build/ in the repository):
#                    qemu-wasm64/ and the default deps/
#   WASM_DEPS        the emsdk + wasm64 dependency stack (default $WEB_BUILD/deps)
#   PMB887X_BSP_DIR  the bsp checkout (default the bsp/ submodule); every
#                    native boot reads it through run-native.sh
# WEB_BUILD does not move the native builds: build-native.sh always builds
# build/qemu-native-build and build/qemu-native-tci-build, the paths the
# gate, the native test drivers and the lockstep tools run (QEMU_BIN,
# QEMU_JIT/QEMU_TCI or --a-bin/--b-bin point them at another binary).
# Expects WEB_DIR, the repository root.
BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DEPS_ROOT="${WASM_DEPS:-$BUILD/deps}"
BSP_DIR="${PMB887X_BSP_DIR:-$WEB_DIR/bsp}"

# the pinned emsdk's environment, quietly, or what to run to get it
use_emsdk() {
  if [ ! -f "$DEPS_ROOT/emsdk/emsdk_env.sh" ]; then
    echo "$(basename "$0"): no emsdk in $DEPS_ROOT/emsdk (scripts/build-deps.sh installs it)" >&2
    exit 1
  fi
  source "$DEPS_ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1 || {
    echo "$(basename "$0"): $DEPS_ROOT/emsdk/emsdk_env.sh failed; rerun it by hand to see why" >&2
    exit 1
  }
}
