// WASM-mode screenshot: boot until the splash renders, then capture.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 150)));
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
console.log("booted; waiting for LCD content…");
for (let t = 0; t < 240; t += 10) {
  await new Promise((r) => setTimeout(r, 10000));
  const u = await page.evaluate(() => Number(window.__qemu?._wasm_fb_updates?.() ?? 0));
  console.log(`t=${t + 10}s updates=${u}`);
  if (u > 50) break;
}
await new Promise((r) => setTimeout(r, 5000));
await page.screenshot({ path: "wasm-shot.png" });
const lcd = await page.$("#lcd");
if (lcd) await lcd.screenshot({ path: "wasm-shot-lcd.png" });
console.log("status:", await page.$eval("#status", (e) => e.textContent));
await browser.close();
