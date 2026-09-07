// Verify a wasm-qemu build boots correctly + report guest insn rate.
//   node verify-boot.mjs <tag> <seconds> [port]
// FAIL if serial shows the early boot-ROM abort (FILE: flash);
// PASS if it keeps running with framebuffer activity (splash draws).
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";

const tag = process.argv[2] || "run";
const secs = Number(process.argv[3] || 90);
const port = process.argv[4] || "8080";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log(`[${tag}] [pageerror]`, String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle", timeout: 120000 });
await page.selectOption("#startup", "ONLINE");
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");

let lastInsns = 0, lastT = 0, verdict = "TIMEOUT (still running)";
for (let t = 10; t <= secs; t += 10) {
  await new Promise((r) => setTimeout(r, 10000));
  const s = await page.evaluate(() => {
    const m = window.__qemu;
    let ser = "";
    try { ser = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); } catch (e) {}
    let fb = { w: 0, h: 0, updates: -1, nonBlack: 0 };
    try {
      const w = m._wasm_fb_width(), h = m._wasm_fb_height(), ptr = m._wasm_fb_ptr();
      fb.updates = Number(m._wasm_fb_updates());
      fb.w = w; fb.h = h;
      if (ptr && w > 0) {
        const dv = new DataView(m.HEAPU8.buffer);
        for (let i = 0; i < w * h * 4; i += 4)
          if (dv.getUint32(Number(ptr) + i, true) & 0xffffff) fb.nonBlack++;
      }
    } catch (e) {}
    let insns = -1, tbs = -1;
    try { insns = Number(m._wasm_insns()); tbs = Number(m._wasm_tbs()); } catch (e) {}
    let vclock = -1;
    try { vclock = Number(m._wasm_vclock()); } catch (e) {}
    return { ser, fb, insns, tbs, vclock };
  }).catch((e) => ({ err: String(e).slice(0, 200) }));
  if (s.err) { console.log(`[${tag}] t=${t}s eval err:`, s.err); continue; }
  const rate = lastT ? Math.round((s.insns - lastInsns) / (t - lastT)) : 0;
  lastInsns = s.insns; lastT = t;
  const exit = (s.ser.match(/>>EXIT<<[^\r\n]*/) || [])[0] || "";
  console.log(`[${tag}] t=${t}s insns=${s.insns} rate=${rate}/s tbs=${s.tbs} vclock=${(s.vclock / 1e6).toFixed(1)}ms fb=${s.fb.updates}upd/${s.fb.nonBlack}px${exit ? " EXIT: " + exit : ""}`);
  if (/FILE:\s*flash/.test(s.ser)) { verdict = "FAIL: early boot-ROM abort (FILE: flash)"; break; }
  if (/>>EXIT<</.test(s.ser)) { verdict = "EXIT: " + exit; break; }
}
await page.screenshot({ path: `verify-${tag}.png` }).catch(() => {});
console.log(`[${tag}] verdict: ${verdict}`);
await browser.close();
process.exit(verdict.startsWith("FAIL") ? 1 : 0);
