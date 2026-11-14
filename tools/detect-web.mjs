// Browser-side check of the page's device detection: pick an own-file
// fullflash under an opaque name and read back what the Device dropdown
// settled on. The Siemens half of that is the siemensfw library's
// probeFullflash (dist/siemens-recalc.wasm), the LG half the JS scan —
// node tools/detect-check.mjs covers the same code without a browser; this
// one proves the page wiring (app.js applyFullflashFile, boards.tar) too.
//
//   node tools/detect-web.mjs [fullflash.bin ...]
//
// The board each file must land on is what the page's own filename rules
// make of its real name (a file whose name names no model is skipped). A
// board the page does not list, one without a display, must leave the
// Device field empty with a note that says so.
import { chromium } from "playwright-core";
import { readdirSync, existsSync, readFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expectedBoard } from "./lib/boards.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

// an opaque name: the filename rules must contribute nothing
const OPAQUE = "backup_2006.bin";
const tmp = mkdtempSync(join(tmpdir(), "detect-web-"));
const PORT = process.env.PORT || "8080";
const browser = await chromium.launch({ headless: true });
let fails = 0, count = 0;

for (const p of paths) {
  // the page only ever sees the opaque name
  const want = await expectedBoard(p);
  if (want == null) {
    console.log(`skip ${basename(p)}  (its name names no model)`);
    continue;
  }
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
  // named a device, and a board it cannot run gets the no-display note
  // instead; one it cannot name is reported after the timeout
  await page.waitForFunction(() => window.__ui.ready ||
    /no display/.test(document.querySelector("#ff-device-note")?.textContent || ""),
  null, { timeout: 30000 }).catch(() => {});

  const seen = await page.$eval("#ff-bin-name", (e) => e.textContent);
  const device = await page.$eval("#device", (e) => e.value);
  const note = await page.$eval("#ff-device-note", (e) => e.textContent);
  const listed = await page.$$eval("#device option", (os) => os.map((o) => o.value));
  const runnable = listed.includes(want);
  const landed = runnable ? device === want : device === "" && /no display/.test(note);
  const okPick = seen === OPAQUE && landed && errs.length === 0;
  count++;
  if (!okPick) fails++;
  console.log(`${okPick ? "ok  " : "FAIL"} ${basename(p)} → ${device || "(none)"}` +
    `${landed ? "" : runnable ? `, want ${want}` : `, want ${want} refused for having no display`}` +
    `${seen !== OPAQUE ? `  (the page saw the name ${seen})` : ""}` +
    `${note ? `  [${note.trim()}]` : ""}${errs.length ? `  ERRS: ${errs.join("; ")}` : ""}`);
  await page.close();
}

await browser.close();
rmSync(tmp, { recursive: true, force: true });
if (!count) {
  console.error("no file's name names a model: nothing was checked");
  process.exit(1);
}
console.log(`\n${count - fails}/${count} checks passed`);
process.exit(fails ? 1 : 0);
