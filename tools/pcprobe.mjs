import { chromium } from "playwright-core";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const s = await page.evaluate(() => {
    const m = window.__qemu;
    return {
      halted: m._wasm_cpu_halted ? m._wasm_cpu_halted() : -1,
      v: (Number(m._wasm_vclock()) / 1e9).toFixed(1),
      u: Number(m._wasm_fb_updates()),
    };
  });
  console.log(`t=${(i + 1) * 15}s`, JSON.stringify(s));
}
await browser.close();
