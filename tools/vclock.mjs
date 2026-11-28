// Measures guest virtual-clock progression in the browser for page query
// variants (bank=0, idlelead=0, ...).
//   node vclock.mjs [query] [totalSeconds] [intervalSeconds]
import { chromium } from "playwright-core";
import { files as fullflashFiles } from "./testflash.mjs";
const q = process.argv[2] || "";
const totalS = Number(process.argv[3] || 180);
const everyS = Number(process.argv[4] || 30);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${process.env.PORT || 8080}/` + (q ? "?" + q : ""), { waitUntil: "networkidle", timeout: 120000 });
await page.click("#ff-mode-own");
await page.setInputFiles("#fullflash", fullflashFiles);
await page.click("#btn-start");
console.log("booted", q || "(default clock)");
let last = 0n, lastWall = performance.now();
for (let t = 0; t < totalS; t += everyS) {
  await new Promise((r) => setTimeout(r, everyS * 1000));
  const s = await page.evaluate(() => {
    const m = window.__qemu;
    return {
      vclock: m?._wasm_vclock ? m._wasm_vclock() : -1,
      updates: m?._wasm_fb_updates ? Number(m._wasm_fb_updates()) : -1,
    };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  if (s.err) { console.log(`t=${t + everyS}s error: ${s.err}`); process.exitCode = 1; break; }
  const vc = Number(s.vclock), wall = performance.now();
  // guest seconds per wall second over the interval actually elapsed
  const rate = ((vc - Number(last)) / 1e9 / ((wall - lastWall) / 1e3)).toFixed(3);
  last = BigInt(vc); lastWall = wall;
  console.log(`t=${t + everyS}s vclock=${(vc / 1e9).toFixed(2)}s (${rate} v/wall) updates=${s.updates}`);
}
await browser.close();
