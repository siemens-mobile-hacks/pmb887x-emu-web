// JIT-mode boot watcher: instance table growth + insn rates + page errors
import { chromium } from "playwright-core";
const waitS = Number(process.argv[2] || 40);
const port = process.env.PORT || "8082";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => { const t = m.text(); if (t.startsWith("JW") || t.includes("EXIT") || t.includes("Error")) console.log("[page]", t.slice(0, 200)); });
page.on("pageerror", (e) => {
  const msg = String((e && e.message) || e);
  if (msg.includes("wasmTable")) return;
  console.log("[pageerror]", msg.slice(0, 100));
  console.log("[pagestack]", String((e && e.stack) || "").slice(0, 1500));
});
page.on("console", async (m) => {
  const t = m.text();
  if (process.env.DUMPALL || t.includes("at ") ) {
    const args = await m.args();
    console.log("[stack-frame]", t.slice(0, 150));
  }
});
await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "networkidle" });
await page.addScriptTag({ content: `
  window.__t0 = Date.now();
  window.__jw = setInterval(() => {
    const m = window.__qemu; if (!m) return;
    let sl = -1; try { sl = m.FS.readFile("/serial.log").length; } catch {}
    const tbl = (typeof wasmTable !== "undefined") ? wasmTable.length :
                (m.wasmTable ? m.wasmTable.length : -1);
    console.log("JW t=" + ((Date.now()-window.__t0)/1000).toFixed(1) +
      " tbl=" + tbl +
      " v=" + (Number(m._wasm_vclock())/1e9).toFixed(2) +
      " u=" + Number(m._wasm_fb_updates()) +
      " tbs=" + (m._wasm_tbs?Number(m._wasm_tbs()):0) +
      " insns=" + (m._wasm_insns?Number(m._wasm_insns()):0) +
      " serial=" + sl);
  }, 2000);
`});
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, waitS * 1000));
await browser.close();
