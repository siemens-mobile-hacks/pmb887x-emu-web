// Self-test for the page's device detection — the Siemens half being the
// siemensfw library's probeFullflash (through site/siemensfw.js) and the
// fallback scan for LG, exactly what site/fullflashes.js runs when a picked
// fullflash's name gives nothing away.
//
//   node tools/detect-check.mjs [fullflash.bin ...]
//
// Defaults to a spread over the flashes tools/testflash.local.json knows
// about plus every fullflashes/ dump present. Each file is presented under
// an opaque name, so only the image can say which phone it came off.
// Exit 0 iff every check passed.
import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, "..");

const { detectDevice } = await import(resolve(root, "site/fullflashes.js"));

// model -> the board the page must land on (null: "has no board yet")
const EXPECT = {
  S75: "siemens-s75", EL71: "siemens-el71", C81: "siemens-c81",
  CX70: "siemens-cx70", SL65: "siemens-sl65",
  // S66 is an S65 under another name — the stand-in table's job
  S66: "siemens-s65",
  KE800: "lg-ke800", KE970: "lg-ke970",
};

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

let fails = 0, count = 0;
function ok(name, cond, extra = "") {
  count++;
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
}

for (const p of paths) {
  const bytes = await readFile(p);
  // an opaque name: the filename rules must contribute nothing
  const file = new File([bytes], `backup_${Date.now()}.bin`);
  const hit = await detectDevice(file);
  const want = EXPECT[hit?.model] ?? null;
  ok(basename(p),
    hit != null && hit.device === want && (want == null || hit.model),
    hit == null ? "nothing detected"
      : `${hit.vendor ? hit.vendor + " " : ""}${hit.model} → ${hit.device ?? "(no board)"}${hit.exact ? "" : " (stand-in)"}`);
}

console.log(`\n${count - fails}/${count} checks passed`);
process.exit(fails ? 1 : 0);
