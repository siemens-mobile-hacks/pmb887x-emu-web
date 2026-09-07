import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text().slice(0, 150)));
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, 8000));
const s = await page.evaluate(() => {
  const m = window.__qemu;
  return {
    hasQemu: !!m,
    fns: m ? Object.keys(m).filter((k) => k.startsWith("_wasm")).join(",") : "",
    vclockRaw: m && m._wasm_vclock ? String(m._wasm_vclock()) : "missing",
    updates: m && m._wasm_fb_updates ? String(m._wasm_fb_updates()) : "missing",
  };
});
console.log(JSON.stringify(s, null, 1));
await browser.close();
