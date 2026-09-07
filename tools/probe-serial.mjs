import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:8080/?debug=1", { waitUntil: "networkidle", timeout: 120000 });
await page.selectOption("#startup", "ONLINE");
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
let last = "";
for (let t = 0; t < 3; t++) {
  await new Promise((r) => setTimeout(r, 20000));
  const s = await page.evaluate(() => {
    const el = document.getElementById("serial");
    const m = window.__qemu;
    let ctrs = {};
    try { ctrs = m._wasm_counters ? m._wasm_counters() : {}; } catch (e) {}
    return { serial: el ? el.value.slice(-1500) : "", ctrs };
  }).catch(e => ({ err: String(e).slice(0,200) }));
  console.log(`=== t=${(t+1)*20}s`, JSON.stringify(s.ctrs ?? {}).slice(0,400));
  if (s.serial && s.serial !== last) { console.log("--- serial tail:\n" + s.serial.slice(-800)); last = s.serial; }
}
await browser.close();
