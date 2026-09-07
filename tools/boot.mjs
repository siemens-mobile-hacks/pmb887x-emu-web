// Boots with a chosen startup scenario and watches the framebuffer.
//   node boot.mjs [startup] [totalSeconds]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const startup = process.argv[2] || "ONLINE";
const totalS = Number(process.argv[3] || 180);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
const q = process.env.QARGS ? "?" + process.env.QARGS : "";
await page.goto("http://127.0.0.1:8080/" + q, { waitUntil: "networkidle", timeout: 120000 });
await page.selectOption("#startup", startup);
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
console.log("booted with startup=" + startup);
for (let t = 0; t < totalS; t += 30) {
  await new Promise((r) => setTimeout(r, 30000));
  const s = await page.evaluate(() => {
    const m = window.__qemu;
    const c = document.getElementById("lcd");
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    return {
      updates: m?._wasm_fb_updates ? Number(m._wasm_fb_updates()) : -1,
      lit,
    };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  console.log(`t=${t + 30}s`, JSON.stringify(s));
}
await page.screenshot({ path: `boot-${startup.toLowerCase()}.png` });
await browser.close();
