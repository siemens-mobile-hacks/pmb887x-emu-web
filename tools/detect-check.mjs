// Self-test for the page's device detection — the Siemens half being the
// siemensfw library's probeFullflash (through site/siemensfw.js) and the
// fallback scan for LG, exactly what site/fullflashes.js runs when a picked
// fullflash's name gives nothing away.
//
//   node tools/detect-check.mjs [fullflash.bin ...]
//
// Defaults to a spread over the flashes tools/testflash.local.json knows
// about plus every fullflashes/ dump present. Each file is presented under
// an opaque name, so only the image can say which phone it came off; the
// board it must land on is what the page's own filename rules make of the
// real name, and a file whose name names no model is skipped.
// Exit 0 iff every check passed and there was at least one.
import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { expectedBoard } from "./lib/boards.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, "..");

const { detectDevice } = await import(resolve(root, "site/fullflashes.js"));
const { untar } = await import(resolve(root, "site/boards.js"));

// the boards the page knows: the configs in its boards.tar, as app.js reads them
const tarBytes = await readFile(resolve(root, "site/dist/boards.tar"));
const boardFiles = new Set();
untar(tarBytes.buffer.slice(tarBytes.byteOffset, tarBytes.byteOffset + tarBytes.length),
  (name) => boardFiles.add(name));
const hasBoard = (dev) => boardFiles.has(dev + ".toml");

let paths = process.argv.slice(2);
if (!paths.length) {
  const local = resolve(root, "tools/testflash.local.json");
  if (existsSync(local)) {
    const { fullflash } = JSON.parse(await readFile(local, "utf8"));
    paths.push(resolve(root, fullflash));
  }
  const dir = resolve(root, "fullflashes");
  if (existsSync(dir)) {
    for (const f of await readdir(dir)) {
      if (f.endsWith(".bin") && !f.includes("no_recalc")) paths.push(resolve(dir, f));
    }
  }
}

if (!paths.length) {
  console.error("no fullflashes to check: pass some, or put them in fullflashes/");
  process.exit(1);
}

let fails = 0, count = 0;
function ok(name, cond, extra = "") {
  count++;
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
}

// The expectation comes from the name the file really has, which the
// detector never sees: what it detected cannot vouch for itself. A file
// whose name names no model has nothing to check against.
for (const p of paths) {
  const want = await expectedBoard(p);
  if (want == null) {
    console.log(`skip ${basename(p)}  — its name names no model`);
    continue;
  }
  const bytes = await readFile(p);
  // an opaque name: the filename rules must contribute nothing
  const file = new File([bytes], `backup_${Date.now()}.bin`);
  const hit = await detectDevice(file, hasBoard);
  ok(basename(p),
    hit != null && hit.device === want,
    (hit == null ? "nothing detected"
      : `${hit.vendor ? hit.vendor + " " : ""}${hit.model} → ${hit.device ?? "(no board)"}${hit.exact ? "" : " (stand-in)"}`)
    + (hit?.device !== want ? `, want ${want}` : ""));
}

if (!count) {
  console.error("no file's name names a model: nothing was checked");
  process.exit(1);
}
console.log(`\n${count - fails}/${count} checks passed`);
process.exit(fails ? 1 : 0);
