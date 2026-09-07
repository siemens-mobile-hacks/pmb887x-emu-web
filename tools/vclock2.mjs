import { chromium } from "playwright-core";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
console.log("booted");
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 20000));
  const s = await page.evaluate(() => {
    const m = window.__qemu;
    return {
      v: m._wasm_vclock().toString(),
      u: Number(m._wasm_fb_updates()),
    };
  });
  console.log(`t=${(i + 1) * 20}s vclock=${(Number(s.v) / 1e9).toFixed(2)}s updates=${s.u}`);
}
await browser.close();
