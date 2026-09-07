// Measures guest virtual-clock progression in the browser for ?icount= variants.
//   node vclock.mjs [icountQuery] [totalSeconds] [intervalSeconds]
import { chromium } from "playwright-core";
const q = process.argv[2] || "";
const totalS = Number(process.argv[3] || 180);
const everyS = Number(process.argv[4] || 30);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.goto("http://127.0.0.1:8080/" + (q ? "?" + q : ""), { waitUntil: "networkidle", timeout: 120000 });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
console.log("booted", q || "(default icount)");
let last = 0n;
for (let t = 0; t < totalS; t += everyS) {
  await new Promise((r) => setTimeout(r, everyS * 1000));
  const s = await page.evaluate(() => {
    const m = window.__qemu;
    return {
      vclock: m?._wasm_vclock ? m._wasm_vclock() : -1,
      updates: m?._wasm_fb_updates ? Number(m._wasm_fb_updates()) : -1,
    };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  const vc = Number(s.vclock);
  const rate = ((vc - Number(last)) / 1e6 / everyS).toFixed(1);
  last = BigInt(vc);
  console.log(`t=${t + everyS}s vclock=${(vc / 1e9).toFixed(2)}s (+${rate} vms/wms) updates=${s.updates}`);
}
await browser.close();
