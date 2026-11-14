// The native build directories of scripts/build-dirs.sh, for the node tools:
// the same defaults and the same env overrides.
//   WEB_BUILD              the build tree (default build/ in the repository)
//   QEMU_NATIVE_BUILD      the JIT reference build ($WEB_BUILD/qemu-native-build)
//   QEMU_NATIVE_TCI_BUILD  the TCI build ($WEB_BUILD/qemu-native-tci-build)
//   TEST_PLUGINS_DIR       the test plugins' .so files: tests/ while WEB_BUILD
//                          is unset, else $WEB_BUILD/test-plugins
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = (name) => process.env[name] || "";

export const BUILD = env("WEB_BUILD") || path.join(ROOT, "build");
export const QEMU_NATIVE_BUILD = env("QEMU_NATIVE_BUILD") || path.join(BUILD, "qemu-native-build");
export const QEMU_NATIVE_TCI_BUILD = env("QEMU_NATIVE_TCI_BUILD") || path.join(BUILD, "qemu-native-tci-build");
export const TEST_PLUGINS_DIR = env("TEST_PLUGINS_DIR") ||
  (env("WEB_BUILD") ? path.join(BUILD, "test-plugins") : path.join(ROOT, "tests"));

export const NATIVE_JIT_BIN = path.join(QEMU_NATIVE_BUILD, "qemu-system-arm");
export const NATIVE_TCI_BIN = path.join(QEMU_NATIVE_TCI_BUILD, "qemu-system-arm");
export const testPlugin = (name) => path.join(TEST_PLUGINS_DIR, `${name}.so`);
