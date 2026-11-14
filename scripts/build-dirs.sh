# The directories the build scripts share, sourced by each of them so that
# one setting moves them all:
#   WEB_BUILD        the build tree (default build/ in the repository)
#   WASM_DEPS        the emsdk + wasm64 dependency stack (default $WEB_BUILD/deps)
#   PMB887X_BSP_DIR  the bsp checkout (default $WEB_BUILD/bsp)
# Expects WEB_DIR, the repository root.
BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DEPS_ROOT="${WASM_DEPS:-$BUILD/deps}"
BSP_DIR="${PMB887X_BSP_DIR:-$BUILD/bsp}"

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
