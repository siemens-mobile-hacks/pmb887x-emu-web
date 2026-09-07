// Watch an untraced wasm boot: the page pushes serial+vclock via console.
import { chromium } from "playwright-core";
const waitS = Number(process.argv[2] || 300);
const extra = process.argv[3] || "";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 250)));
await page.goto("http://127.0.0.1:8080/" + (extra ? "?" + extra : ""), { waitUntil: "networkidle" });
await page.addScriptTag({ content: `
  window.__watch = setInterval(() => {
    const m = window.__qemu;
    if (!m) return;
    let sl = -1, tail = "";
    try {
      if (m.FS.analyzePath("/serial.log").exists) {
        const d = m.FS.readFile("/serial.log");
        sl = d.length;
        tail = new TextDecoder("latin1").decode(d.subarray(Math.max(0, sl - 70)));
      }
    } catch (e) { tail = "E"; }
    console.log("WATCH v=" + (Number(m._wasm_vclock())/1e9).toFixed(2) +
      " u=" + Number(m._wasm_fb_updates()) + " serial=" + sl +
      " tbs=" + (m._wasm_tbs ? Number(m._wasm_tbs()) : "-") +
      " insns=" + (m._wasm_insns ? Number(m._wasm_insns()) : "-") +
      " ex=[" + [0,1,2,3].map((i) => m._wasm_exits ? Number(m._wasm_exits(i)) : 0).join(",") + "]" +
      " exNoReq=" + (m._wasm_exits ? Number(m._wasm_exits(8)) : 0) +
      " irq=0x" + (m._wasm_irq_bits ? m._wasm_irq_bits().toString(16) : "?") +
      " tail=" + JSON.stringify(tail.slice(-40)));
  }, 10000);
`});
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
console.log("booted (untraced)" + (extra ? " [" + extra + "]" : ""));
await new Promise((r) => setTimeout(r, waitS * 1000));
console.log("=== done waiting ===");
await browser.close();
