// Single place where tools resolve the test fullflash path.
// Order: TESTFLASH env var -> tools/testflash.local.json -> error.
// testflash.local.json is gitignored; see testflash.local.json.example.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withSidecar } from "./lib/boards.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolsDir, "..");

function load() {
  if (process.env.TESTFLASH) return process.env.TESTFLASH;
  try {
    const j = JSON.parse(readFileSync(resolve(toolsDir, "testflash.local.json"), "utf8"));
    if (j.fullflash) return resolve(repoRoot, j.fullflash);
  } catch {}
  return null;
}

const p = load();
if (!p)
  throw new Error(
    "no test fullflash configured: copy tools/testflash.local.json.example " +
      "to tools/testflash.local.json or set TESTFLASH=<path>"
  );
if (!existsSync(p)) throw new Error(`test fullflash not found: ${p}`);

export const fullflash = p;

// The fullflash plus its .cfi-efa sidecar when one sits next to it (LG
// fullflashes need it): what every boot puts in the page's file picker.
export const files = withSidecar(p);
