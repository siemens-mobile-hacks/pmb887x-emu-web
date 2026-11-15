// Verify a wasm-qemu build boots correctly + report guest insn rate.
//   node verify-boot.mjs <tag> <seconds> [port]
// FAIL if serial shows the early boot-ROM abort (FILE: flash), on a
// firmware EXIT, an error the page shows or throws, qemu exiting, a renderer
// crash or a page that stops answering, and if the guest never started or
// never drew; PASS if it is still running with framebuffer activity (splash
// draws) after <seconds>.
// SIEMENS_MODE=recalc|recover-esn|as-is picks the Siemens keys mode once the
// page has named the device (default: the page's own, recalc); as-is boots
// a broken image such as fullflashes/BROKEN)S66_no_recalc.bin into its EXIT.
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import { bounded, guestGone, pageCall, PAGE_CALL_MS } from "./lib/page.mjs";

const tag = process.argv[2] || "run";
const secs = Number(process.argv[3] || 90);
const port = process.argv[4] || "8080";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let pageErr = null;
page.on("pageerror", (e) => {
  console.log(`[${tag}] [pageerror]`, String(e).slice(0, 300));
  pageErr ??= String(e).slice(0, 200);
});
page.on("crash", () => { pageErr ??= "the renderer crashed"; });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle", timeout: 120000 });
await page.selectOption("#startup", "ONLINE");
await page.click("#ff-mode-own");
await page.setInputFiles("#fullflash", fullflash);
const mode = process.env.SIEMENS_MODE;
if (mode) {
  await page.waitForFunction(() => window.__ui.ready, null, { timeout: 30000 }).catch(() => {});
  const radio = await pageCall(page.$(`input[name="siemens-mode"][value="${mode}"]`), "the Siemens mode radio");
  if (radio) await radio.check();
  console.log(`[${tag}] Siemens keys: ${radio ? mode : "no such mode for this device"}`);
}
await page.click("#btn-start");

let lastInsns = 0, lastT = 0, verdict = null, last = null;
for (let t = 10; t <= secs; t += 10) {
  await new Promise((r) => setTimeout(r, 10000));
  let evalErr = null;
  const s = await bounded(page.evaluate(() => {
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
    let insns = -1;
    try { insns = Number(m._wasm_insns()); } catch (e) {}
    let vclock = -1;
    try { vclock = Number(m._wasm_vclock()); } catch (e) {}
    return { ser, fb, insns, vclock, ui: window.__ui ?? {} };
  }), null, { ms: PAGE_CALL_MS, onError: (e) => { evalErr = String(e).slice(0, 200); } });
  if (pageErr) { verdict = `FAIL: page error: ${pageErr}`; break; }
  if (!s) { verdict = `FAIL: the page did not answer at t=${t}s: ${evalErr}`; break; }
  last = s;
  const rate = lastT ? Math.round((s.insns - lastInsns) / (t - lastT)) : 0;
  lastInsns = s.insns; lastT = t;
  const exit = (s.ser.match(/>>EXIT<<[^\r\n]*/) || [])[0] || "";
  console.log(`[${tag}] t=${t}s insns=${s.insns} rate=${rate}/s vclock=${(s.vclock / 1e6).toFixed(1)}ms fb=${s.fb.updates}upd/${s.fb.nonBlack}px${exit ? " EXIT: " + exit : ""}`);
  if (/FILE:\s*flash/.test(s.ser)) { verdict = "FAIL: early boot-ROM abort (FILE: flash)"; break; }
  const gone = guestGone(s.ui);
  if (gone) { verdict = `FAIL: ${gone}`; break; }
}
verdict ??= !last || last.insns <= 0 ? "FAIL: the guest never started"
  : last.fb.updates <= 0 ? "FAIL: no framebuffer activity"
  : "PASS (still running)";
await bounded(page.screenshot({ path: `verify-${tag}.png` }), null);
console.log(`[${tag}] verdict: ${verdict}`);
await bounded(browser.close(), undefined);
process.exit(verdict.startsWith("FAIL") ? 1 : 0);
