// Browser-side check of the page's device detection: pick an own-file
// fullflash under an opaque name and read back what the Device dropdown
// settled on. The Siemens half of that is the siemensfw library's
// probeFullflash (dist/siemens-recalc.wasm), the LG half the JS scan —
// node tools/detect-check.mjs covers the same code without a browser; this
// one proves the page wiring (app.js applyFullflashFile, boards.tar) too.
//
//   node tools/detect-web.mjs [fullflash.bin ...]
import { chromium } from "playwright-core";
import { readdirSync, existsSync, readFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECT = {
  S75: "siemens-s75", EL71: "siemens-el71", C81: "siemens-c81",
  CX70: "siemens-cx70", SL65: "siemens-sl65", S66: "siemens-s65",
  KE800: "lg-ke800", KE970: "lg-ke970",
};

let paths = process.argv.slice(2);
if (!paths.length) {
  const local = resolve(root, "tools/testflash.local.json");
  if (existsSync(local)) {
    const { fullflash } = JSON.parse(readFileSync(local, "utf8"));
    paths.push(resolve(root, fullflash));
  }
  const dir = resolve(root, "fullflashes");
  if (existsSync(dir))
    paths.push(...readdirSync(dir).filter(f => f.endsWith(".bin")).map(f => resolve(dir, f)));
}

if (!paths.length) {
  console.error("no fullflashes to check: pass some, or put them in fullflashes/");
  process.exit(1);
}

// The expectation comes from the model in the file's real name; the page
// only ever sees the opaque one.
function expected(p) {
  const up = basename(p).toUpperCase();
  const model = Object.keys(EXPECT).find((m) => up.includes(m));
  return model ? EXPECT[model] : null;
}

// an opaque name: the filename rules must contribute nothing
const OPAQUE = "backup_2006.bin";
const tmp = mkdtempSync(join(tmpdir(), "detect-web-"));
const PORT = process.env.PORT || "8080";
const browser = await chromium.launch({ headless: true });
let fails = 0, count = 0;

for (const p of paths) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });

  await page.click("#ff-mode-own");
  const opaque = join(tmp, OPAQUE);
  rmSync(opaque, { force: true });
  symlinkSync(resolve(p), opaque);
  await page.setInputFiles("#fullflash", opaque);
  // wasm fetch + probe (+ LG scan): __ui.ready turns true once the page has
  // named a device; one it cannot name is reported after the timeout
  await page.waitForFunction(() => window.__ui.ready, null, { timeout: 30000 }).catch(() => {});

  const seen = await page.$eval("#ff-bin-name", (e) => e.textContent);
  const device = await page.$eval("#device", (e) => e.value);
  const note = await page.$eval("#ff-device-note", (e) => e.textContent);
  const want = expected(p);
  const okPick = seen === OPAQUE && want != null && device === want && errs.length === 0;
  count++;
  if (!okPick) fails++;
  console.log(`${okPick ? "ok  " : "FAIL"} ${basename(p)} → ${device || "(none)"}` +
    `${want == null ? "  (no expected board for this file name)" : device !== want ? `, want ${want}` : ""}` +
    `${seen !== OPAQUE ? `  (the page saw the name ${seen})` : ""}` +
    `${note ? `  [${note.trim()}]` : ""}${errs.length ? `  ERRS: ${errs.join("; ")}` : ""}`);
  await page.close();
}

await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${count - fails}/${count} checks passed`);
process.exit(fails ? 1 : 0);
