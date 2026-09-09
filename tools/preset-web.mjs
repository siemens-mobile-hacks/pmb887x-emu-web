// E2E browser test: preset fullflash picker (download-on-Start -> cache -> boot).
//   node tools/preset-web.mjs
// Requires the wasm build to be served (./serve.mjs) at 127.0.0.1:8080 and
// internet access — the inventory URLs are fetched from the real repo
// (git.siepatch.dev, CORS-enabled), exactly as a user's browser would.
// Covers: select-only-no-download, lazy download with progress on Start,
// Cache API persistence across reloads, boot-from-cache (flash + .cfi-efa
// sidecar into MEMFS), Browse enable/disable, and the trash button.
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
const pillText = () => page.$eval("#status", (s) => s.textContent);

// 1. selecting a preset must NOT download anything yet; Browse goes gray
await page.selectOption("#ff-preset", "ke800v11b");
await page.waitForFunction(
  () => document.getElementById("ff-preset-status").textContent.length > 0);
assert("no auto-download: " + await statusText(),
  (await statusText()) === "not downloaded yet — downloads when you press Start");
assert("Browse disabled while preset selected",
  await page.$eval("#fullflash", (i) => i.disabled));
assert("trash disabled (nothing cached)",
  await page.$eval("#ff-preset-delete", (b) => b.disabled));
assert("device inferred", (await page.$eval("#device", (s) => s.value)) === "lg-ke800");
assert("keyboard layout inferred", (await page.$eval("#kbd-layout", (s) => s.value)) === "ke800_en");

// 2. Start triggers the download (progress visible), then boots from it
await page.click("#btn-start");
await page.waitForFunction(
  () => /downloading fullflash/.test(document.getElementById("status").textContent),
  null, { timeout: 300000 });
assert("status pill shows download progress: " + await pillText(), true);
await page.screenshot({ path: "preset-web-dl.png" }).catch(() => {});
await page.waitForFunction(
  () => /^running/.test(document.getElementById("status").textContent), null, { timeout: 300000 });
const stBoot = await pillText();
assert("boot status: " + stBoot, stBoot === "running — lg-ke800");
assert("preset now cached: " + await statusText(),
  /cached \(128(\.\d+)? MiB\) — boots from the local cache/.test(await statusText()));
assert("option marked cached",
  await page.$eval("#ff-preset option[value=ke800v11b]", (o) => o.textContent.includes("— cached")));
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
await page.click("#btn-stop").catch(() => {});

// 3. cache survives a reload; switching back to "my own file" re-enables
//    Browse and re-infers from the picked file
await page.reload({ waitUntil: "networkidle" });
await page.selectOption("#ff-preset", "ke800v11b");
await page.waitForFunction(
  () => document.getElementById("ff-preset-status").textContent.startsWith("cached ("),
  null, { timeout: 60000 });
assert("cached across reload: " + await statusText(), true);
assert("trash enabled when cached",
  await page.$eval("#ff-preset-delete", (b) => !b.disabled));

await page.selectOption("#ff-preset", "");
assert("Browse re-enabled on 'my own file'",
  await page.$eval("#fullflash", (i) => !i.disabled));
assert("preset status cleared", (await statusText()) === "");
await page.setInputFiles("#fullflash", ["../fullflashes/s75_working20060710172101.bin"]);
assert("own-file inference works again",
  (await page.$eval("#device", (s) => s.value)) === "siemens-s75");

// 4. back to the preset (still cached) -> Browse gray again; trash empties
await page.selectOption("#ff-preset", "ke800v11b");
await page.waitForFunction(
  () => document.getElementById("ff-preset-status").textContent.startsWith("cached ("),
  null, { timeout: 60000 });
assert("Browse disabled again", await page.$eval("#fullflash", (i) => i.disabled));
await page.click("#ff-preset-delete");
await page.waitForFunction(
  () => document.getElementById("ff-preset-status").textContent.includes("not downloaded"),
  null, { timeout: 60000 });
assert("delete empties cache: " + await statusText(),
  await page.evaluate(async (url) => {
    const c = await caches.open("fullflashes-v1");
    return !(await c.match(url));
  }, REPO + "KE800v11b.bin"));
assert("trash disabled after delete",
  await page.$eval("#ff-preset-delete", (b) => b.disabled));

await page.screenshot({ path: "preset-web.png" }).catch(() => {});
await browser.close();
console.log("page errors:", errors.length ? errors : "none");
if (fail || errors.length) process.exit(1);
console.log("PASS");
