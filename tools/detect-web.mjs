// Browser-side check of the page's device detection: pick an own-file
// fullflash under an opaque name and read back what the Device dropdown
// settled on. The Siemens half of that is the siemensfw library's
// probeFullflash (dist/siemens-recalc.wasm), the LG half the JS scan —
// node tools/detect-check.mjs covers the same code without a browser; this
// one proves the page wiring (app.js applyFullflashFile, boards.tar) too.
//
//   node tools/detect-web.mjs [fullflash.bin ...]
import { chromium } from "playwright-core";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function dirname(p) { return p.slice(0, p.lastIndexOf("/")); }

const EXPECT = {
  S75: "siemens-s75", EL71: "siemens-el71", C81: "siemens-c81",
  CX70: "siemens-cx70", S66: "siemens-s65", KE800: "lg-ke800", KE970: "lg-ke970",
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

const PORT = process.env.PORT || "8080";
const browser = await chromium.launch({ headless: true });
let fails = 0, count = 0;

for (const p of paths) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });

  await page.click("#ff-mode-own");
  // an opaque name: the filename rules must contribute nothing
  await page.setInputFiles("#fullflash", p, { name: "backup_2006.bin" });
  await page.waitForTimeout(1500);   // wasm fetch + probe (+ LG scan)

  const device = await page.$eval("#device", (e) => e.value);
  const note = await page.$eval("#device-note", (e) => e.textContent).catch(() => "");
  const want = Object.entries(EXPECT).find(([m]) => note.includes(m))?.[1];
  const okPick = device !== "" && errs.length === 0 &&
    (want == null || device === want);
  count++;
  if (!okPick) fails++;
  console.log(`${okPick ? "ok  " : "FAIL"} ${basename(p)} → ${device || "(none)"}${note ? `  [${note.trim()}]` : ""}${errs.length ? `  ERRS: ${errs.join("; ")}` : ""}`);
  await page.close();
}

await browser.close();
console.log(`\n${count - fails}/${count} checks passed`);
process.exit(fails ? 1 : 0);
