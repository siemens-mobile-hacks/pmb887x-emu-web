# The directories the build scripts share, sourced by each of them so that
# one setting moves them all:
#   WEB_BUILD        the build tree (default build/ in the repository):
#                    qemu-wasm64/, the default deps/ and the native builds
#   WASM_DEPS        the emsdk + wasm64 dependency stack (default $WEB_BUILD/deps)
#   QEMU_NATIVE_BUILD      the native JIT reference build, the binary of
#                          run-native.sh, the gate and the lockstep a-side
#                          (default $WEB_BUILD/qemu-native-build)
#   QEMU_NATIVE_TCI_BUILD  the native TCI build with plugins, the lockstep
#                          b-side (default $WEB_BUILD/qemu-native-tci-build)
#   TEST_PLUGINS_DIR the test plugins insncount.so and lockstep.so (default
#                    $WEB_BUILD/test-plugins)
#   PMB887X_BSP_DIR  the bsp checkout (default the bsp/ submodule); every
#                    native boot reads it through run-native.sh
# The node tools take the native ones from tools/lib/build-dirs.mjs, with the
# same defaults. QEMU_BIN, QEMU_JIT/QEMU_TCI or --a-bin/--b-bin still point
# a single run at another binary.
# A relative directory is taken from the current directory. It is made
# absolute and exported, so the scripts this one runs, which may cd, see the
# same directory.
# Expects WEB_DIR, the repository root.
for _v in WEB_BUILD WASM_DEPS QEMU_NATIVE_BUILD QEMU_NATIVE_TCI_BUILD TEST_PLUGINS_DIR PMB887X_BSP_DIR; do
  if [ -n "${!_v:-}" ]; then export "$_v=$(realpath -m -- "${!_v}")"; fi
done
unset _v
BUILD="${WEB_BUILD:-$WEB_DIR/build}"
DEPS_ROOT="${WASM_DEPS:-$BUILD/deps}"
NATIVE_BUILD="${QEMU_NATIVE_BUILD:-$BUILD/qemu-native-build}"
NATIVE_TCI_BUILD="${QEMU_NATIVE_TCI_BUILD:-$BUILD/qemu-native-tci-build}"
PLUGINS_DIR="${TEST_PLUGINS_DIR:-$BUILD/test-plugins}"
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
