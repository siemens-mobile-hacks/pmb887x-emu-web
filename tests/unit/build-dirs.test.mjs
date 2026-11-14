import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VARS = ["WEB_BUILD", "QEMU_NATIVE_BUILD", "QEMU_NATIVE_TCI_BUILD", "TEST_PLUGINS_DIR"];

function withEnv(set) {
  const env = { ...process.env };
  for (const v of VARS) delete env[v];
  return { ...env, ...set };
}

function shellDirs(set) {
  const script = 'WEB_DIR="$1"; source "$1/scripts/build-dirs.sh"; echo "$BUILD|$NATIVE_BUILD|$NATIVE_TCI_BUILD|$PLUGINS_DIR"';
  return execFileSync("bash", ["-c", script, "-", path.resolve(ROOT)], { env: withEnv(set), encoding: "utf8" }).trim();
}

function nodeDirs(set) {
  const script = 'const m = await import(process.argv[1]); console.log([m.BUILD, m.QEMU_NATIVE_BUILD, m.QEMU_NATIVE_TCI_BUILD, m.TEST_PLUGINS_DIR].join("|"));';
  const helper = new URL("../../tools/lib/build-dirs.mjs", import.meta.url).href;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script, helper], { env: withEnv(set), encoding: "utf8" }).trim();
}

test("build-dirs: the unset defaults are all under build/", () => {
  const r = path.resolve(ROOT);
  assert.equal(shellDirs({}),
    [`${r}/build`, `${r}/build/qemu-native-build`, `${r}/build/qemu-native-tci-build`, `${r}/build/test-plugins`].join("|"));
});

test("build-dirs: the test plugins follow WEB_BUILD", () => {
  assert.equal(shellDirs({ WEB_BUILD: "/x" }), "/x|/x/qemu-native-build|/x/qemu-native-tci-build|/x/test-plugins");
});

test("build-dirs: tools/lib/build-dirs.mjs resolves what scripts/build-dirs.sh does", () => {
  for (const set of [
    {},
    { WEB_BUILD: "" },
    { WEB_BUILD: "/x" },
    { WEB_BUILD: "/x", QEMU_NATIVE_BUILD: "/j" },
    { QEMU_NATIVE_TCI_BUILD: "/t", TEST_PLUGINS_DIR: "/p" },
    { WEB_BUILD: "/x", QEMU_NATIVE_BUILD: "/j", QEMU_NATIVE_TCI_BUILD: "/t", TEST_PLUGINS_DIR: "/p" },
  ]) {
    assert.equal(nodeDirs(set), shellDirs(set), JSON.stringify(set));
  }
});
