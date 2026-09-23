// E2E browser test: engine wasm background prefetch (download after page
// load, Start before it finishes, Cancel, warm Start).
//   node tools/engine-prefetch-web.mjs
// Requires the wasm build to be served (./serve.mjs) at 127.0.0.1:8080 and
// ../fullflashes/s75_working20060710172101.bin on disk. The network is
// throttled via CDP (~4 Mbps) so the download window is wide enough to hit
// Start inside it deterministically. Covers: prefetch starts on its own
// after load and shows in the idle pill, the page stays interactive while
// it streams, Start rides the very same in-flight fetch (no second
// request), Cancel aborts it, the next Start re-fetches and boots from the
// prefetched module (posted to the pthread workers), and a warm Start
// fetches nothing at all.
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FF = fileURLToPath(new URL("../fullflashes/s75_working20060710172101.bin", import.meta.url));
if (!existsSync(FF)) { console.error(`missing ${FF}`); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

// ~4 Mbps: the 4.1 MB (gz) engine wasm takes ~9 s — a wide window to hit
// Start in
const cdp = await ctx.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", {
  offline: false, latency: 40, downloadThroughput: 500_000, uploadThroughput: 500_000,
});

const wasmReqs = [];
let loadAt = 0;
const errors = [];
page.on("request", (r) => { if (r.url().endsWith("qemu-system-arm.wasm")) wasmReqs.push(Date.now()); });
page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 300)));
page.on("console", (m) => {
  const t = m.text();
  if ((m.type() === "error" || m.type() === "warning") && !/favicon|net::ERR/.test(t))
    errors.push(`${m.type()}: ${t.slice(0, 200)}`);
});

let fail = 0;
const assert = (name, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) fail++; };
const pill = () => page.$eval("#status-text", (e) => e.textContent);

await page.goto("http://127.0.0.1:8080/", { waitUntil: "load" });
loadAt = Date.now();

// 1. the prefetch starts on its own after load, and the page stays usable
await page.waitForFunction(
  () => /^Prefetching emulator · /.test(document.getElementById("status-text").textContent),
  null, { timeout: 15000 });
assert("background prefetch visible: " + await pill(), true);
assert("prefetch started after load", wasmReqs.length === 1 && wasmReqs[0] > loadAt);

await page.click("#ff-mode-own");
await page.setInputFiles("#fullflash", [FF]);
await page.waitForFunction(() => document.getElementById("device").value === "siemens-s75",
  null, { timeout: 15000 });
assert("page interactive mid-download (device inferred)", true);

// 2. Start before the download finishes rides the same fetch out
await page.click("#btn-start");
await page.waitForFunction(
  () => /^Downloading emulator · /.test(document.getElementById("status-text").textContent),
  null, { timeout: 5000 });
const ridingBytes = await page.evaluate(() => window.__engine().loaded);
assert(`Start rides the in-flight download (${(ridingBytes / 1048576).toFixed(1)} MiB in): `
  + await pill(), ridingBytes > 0);
assert("no second fetch for the riding Start", wasmReqs.length === 1);

// Cancel aborts, page back to idle
await page.click("#btn-stop");
await page.waitForFunction(() => window.__ui.state === "idle", null, { timeout: 10000 });
assert("Cancel aborts the engine download", true);

// 3. Start again: one fresh fetch (fast now), then boot from the module
await cdp.send("Network.emulateNetworkConditions", {
  offline: false, latency: 10, downloadThroughput: 100_000_000, uploadThroughput: 100_000_000 });
await page.click("#btn-start");
await page.waitForFunction(() => window.__ui.state === "running", null, { timeout: 90000 });
assert("boot reached running (rode download out)", true);
assert("exactly one refetch after the abort (got " + wasmReqs.length + ")", wasmReqs.length === 2);
assert("emulator instantiated (prefetched module posted to pthreads)",
  await page.evaluate(() => !!window.__qemu?._wasm_fb_ptr && !!window.__qemu?._wasm_audio_ring_ptr));

await page.click("#btn-stop");
await page.waitForFunction(() => window.__ui.state === "idle", null, { timeout: 60000 });

// 4. Start with the prefetch in hand: no network at all
const before = wasmReqs.length;
await page.click("#btn-start");
await page.waitForFunction(() => window.__ui.state === "running", null, { timeout: 90000 });
await page.waitForTimeout(1000);
assert("warm boot: zero wasm fetches", wasmReqs.length === before);
assert("warm boot pill: " + await pill(), /^Running · \d+:\d\d/.test(await pill()));

await page.click("#btn-stop").catch(() => {});
await page.waitForFunction(() => window.__ui.state === "idle", null, { timeout: 60000 });
await browser.close();

console.log("console/page errors:", errors.length ? errors : "none");
if (fail || errors.length) process.exit(1);
console.log("PASS");
