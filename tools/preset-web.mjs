// E2E browser test: preset fullflash picker (download-on-Start -> cache -> boot).
//   node tools/preset-web.mjs
// Requires the wasm build to be served (./serve.mjs) at 127.0.0.1:8080 and
// internet access — the inventory URLs are fetched from the real repo
// (git.siepatch.dev, CORS-enabled), exactly as a user's browser would.
// Covers: select-only-no-download, lazy download with progress on Start,
// Cache API persistence across reloads, boot-from-cache (flash + .cfi-efa
// sidecar into MEMFS), the Preset/Own file modes, and Clear cache.
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";

const REPO = "https://git.siepatch.dev/api/v1/repos/siepatch/fullflashes/raw/";

// sparse fingerprint of the reference fullflash, computed the same way in
// the browser over the cached bytes
const ref = new Uint8Array(await readFile("../fullflashes/KE800-v11b.bin"));
function fingerprint(a) {
  let h = 0x9e3779b9;
  for (let i = 0; i < a.length; i += 1048576) h = (h * 31 + a[i]) >>> 0;
  h = (h * 31 + a[a.length - 1]) >>> 0;
  return { len: a.length, h };
}
const refFp = fingerprint(ref);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));

await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 120000 });

let fail = 0;
const assert = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) fail++; };
const statusText = () => page.$eval("#ff-preset-status", (s) => s.textContent);
const pillText = () => page.$eval("#status-text", (s) => s.textContent);
const hidden = (sel) => page.$eval(sel, (e) => e.hidden);

// 1. selecting a preset must NOT download anything yet
await page.selectOption("#ff-preset", "ke800v11b");
await page.waitForFunction(
  () => document.getElementById("ff-preset-status").textContent.includes("128"));
assert("no auto-download: " + await statusText(),
  (await statusText()) === "Not downloaded · fetches 128 MiB on Start");
assert("Clear cache hidden (nothing cached)", await hidden("#ff-preset-delete"));
assert("device line", (await page.$eval("#ff-preset-device", (e) => e.textContent))
  === "Device: lg-ke800 (from preset)");
assert("keyboard inferred", (await page.$eval("#kbd-keyboard", (s) => s.value)) === "ke800");
assert("no file input in preset mode", !(await page.$("#fullflash")));

// 2. Start triggers the download (progress in the pill and on the status
//    line), then boots from it
await page.click("#btn-start");
await page.waitForFunction(
  () => /^Downloading · /.test(document.getElementById("status-text").textContent),
  null, { timeout: 300000 });
assert("pill shows download progress: " + await pillText(), true);
assert("Cancel replaced Start", !(await page.$("#btn-start")) && !!(await page.$("#btn-stop")));
assert("preset line shows progress: " + await statusText(),
  /^Downloading · /.test(await statusText()));
await page.screenshot({ path: "preset-web-dl.png" }).catch(() => {});
await page.waitForFunction(
  () => window.__ui.state === "running", null, { timeout: 300000 });
assert("boot status: " + await pillText(), /^Running · \d+:\d\d$/.test(await pillText()));
assert("booted device", (await page.evaluate(() => window.__ui.device)) === "lg-ke800");
assert("preset now cached: " + await statusText(),
  /^✓ Cached · 128(\.\d+)? MiB$/.test(await statusText()));
assert("option label carries no cache suffix",
  await page.$eval("#ff-preset option[value=ke800v11b]", (o) => !o.textContent.includes("cached")));
assert("fullflash in MEMFS",
  await page.evaluate(() => window.__qemu.FS.analyzePath("/data/fullflash.bin").exists));
assert("EFA sidecar in MEMFS",
  await page.evaluate(() => window.__qemu.FS.analyzePath("/data/fullflash.bin.cfi-efa").exists));
assert("cached bytes == repo bytes", await page.evaluate((fp) => {
  const a = window.__qemu.FS.readFile("/data/fullflash.bin", { encoding: "binary" });
  let h = 0x9e3779b9;
  for (let i = 0; i < a.length; i += 1048576) h = (h * 31 + a[i]) >>> 0;
  h = (h * 31 + a[a.length - 1]) >>> 0;
  return a.length === fp.len && h === fp.h;
}, refFp));
assert("Firmware panel locked while running",
  await page.$eval("#firmware-panel", (f) => f.disabled) && !(await hidden("#ff-lock-note")));
await page.click("#btn-stop").catch(() => {});
await page.waitForFunction(() => window.__ui.state === "idle", null, { timeout: 60000 });
assert("panel unlocked after Stop", await page.$eval("#firmware-panel", (f) => !f.disabled));
// the stopped run's MEMFS image is still there, and this one is an LG
assert("exports stay available after Stop",
  !(await page.$eval("#btn-save-flash", (b) => b.disabled))
  && (await hidden("#export-caption")));
assert("EFA export offered for the LG run",
  !(await hidden("#btn-save-efa")) && !(await page.$eval("#btn-save-efa", (b) => b.disabled)));

// 3. cache survives a reload; Own file mode keeps its own inference
await page.reload({ waitUntil: "networkidle" });
await page.selectOption("#ff-preset", "ke800v11b");
await page.waitForFunction(
  () => document.getElementById("ff-preset-status").textContent.startsWith("✓ Cached"),
  null, { timeout: 60000 });
assert("cached across reload: " + await statusText(), true);
assert("Clear cache shown when cached", !(await hidden("#ff-preset-delete")));

await page.click("#ff-mode-own");
assert("no preset dropdown in own-file mode", !(await page.$("#ff-preset")));
await page.setInputFiles("#fullflash", ["../fullflashes/s75_working20060710172101.bin"]);
assert("own-file inference works",
  (await page.$eval("#device", (s) => s.value)) === "siemens-s75");

// 4. back to the preset (still cached) -> Clear cache empties it
await page.click("#ff-mode-preset");
await page.waitForFunction(
  () => document.getElementById("ff-preset-status").textContent.startsWith("✓ Cached"),
  null, { timeout: 60000 });
assert("preset selection survived the mode round trip",
  (await page.$eval("#ff-preset", (s) => s.value)) === "ke800v11b");
await page.click("#ff-preset-delete");
await page.waitForFunction(
  () => document.getElementById("ff-preset-status").textContent.startsWith("Not downloaded"),
  null, { timeout: 60000 });
assert("Clear cache empties the cache: " + await statusText(),
  await page.evaluate(async (url) => {
    const c = await caches.open("fullflashes-v1");
    return !(await c.match(url));
  }, REPO + "KE800v11b.bin"));
assert("Clear cache hidden again", await hidden("#ff-preset-delete"));

await page.screenshot({ path: "preset-web.png" }).catch(() => {});
await browser.close();
console.log("page errors:", errors.length ? errors : "none");
if (fail || errors.length) process.exit(1);
console.log("PASS");
