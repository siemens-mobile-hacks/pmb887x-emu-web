// Framebuffer probe: boots a fresh instance and reports wasm-side fb state.
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 120000 });
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 30000));
  const s = await page.evaluate(() => {
    const m = window.__qemu;
    if (!m?._wasm_fb_ptr) return { no: "module" };
    const w = m._wasm_fb_width(), h = m._wasm_fb_height(), ptr = m._wasm_fb_ptr();
    const d1 = m._wasm_fb_take_dirty();
    let nz = 0;
    let updates = m._wasm_fb_updates ? Number(m._wasm_fb_updates()) : -1;
    if (ptr && w > 0) {
      const dv = new DataView(m.HEAPU8.buffer);
      for (let i = 0; i < w * h * 4; i += 4) {
        const px = dv.getUint32(Number(ptr) + i, true) & 0xffffff;
        if (px) nz++;
      }
    }
    return { w, h, dirtyTook: d1, updates, nonBlack: nz };
  }).catch((e) => ({ err: String(e).slice(0, 200) }));
  console.log(`t=${(i + 1) * 30}s`, JSON.stringify(s));
}
await browser.close();
