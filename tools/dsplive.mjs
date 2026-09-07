// Live DSP-trace watcher: page pushes serial status + NEW filtered trace hits
// via console.log every 10s (no final evaluate needed).
import { chromium } from "playwright-core";
const waitS = Number(process.argv[2] || 600);
const extra = process.argv[3] || "trace=dsp&tracebuf=1";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 250)));
await page.goto("http://127.0.0.1:8080/?" + extra, { waitUntil: "networkidle" });
await page.addScriptTag({ content: `
  window.__seen = 0;
  window.__watch = setInterval(() => {
    const m = window.__qemu;
    const log = window.__qemulog ?? [];
    const re = /boot command|COM_SET|COM_CLEAR|SCU_DSP_INT|core initialized|DE0|TOMCU|CFR|CFSTA|cold program|\\[DSP\\]/;
    const fresh = [];
    for (let i = window.__seen; i < log.length; i++) if (re.test(log[i])) fresh.push(log[i]);
    window.__seen = log.length;
    let sl = -1, tail = "";
    try {
      if (m && m.FS.analyzePath("/serial.log").exists) {
        const d = m.FS.readFile("/serial.log");
        sl = d.length;
        tail = new TextDecoder("latin1").decode(d.subarray(Math.max(0, sl - 80)));
      }
    } catch (e) {}
    console.log("WATCH v=" + (m ? (Number(m._wasm_vclock())/1e9).toFixed(1) : "-") +
      " u=" + (m ? Number(m._wasm_fb_updates()) : "-") + " serial=" + sl +
      (fresh.length ? "\\n" + fresh.slice(-12).join("\\n") : ""));
    if (tail.includes(">>EXIT<<") && !window.__exited) { window.__exited = true; console.log("SERIAL_EXIT " + JSON.stringify(tail)); }
  }, 10000);
`});
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
console.log("booted [" + extra + "]");
await new Promise((r) => setTimeout(r, waitS * 1000));
console.log("=== done ===");
await browser.close();
