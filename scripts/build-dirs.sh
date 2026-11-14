# The directories the build scripts share, sourced by each of them so that
# one setting moves them all:
#   WEB_BUILD        the build tree (default build/ in the repository)
#   WASM_DEPS        the emsdk + wasm64 dependency stack (default $WEB_BUILD/deps)
#   PMB887X_BSP_DIR  the bsp checkout (default $WEB_BUILD/bsp)
# Expects WEB_DIR, the repository root.
BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DEPS_ROOT="${WASM_DEPS:-$BUILD/deps}"
BSP_DIR="${PMB887X_BSP_DIR:-$BUILD/bsp}"
