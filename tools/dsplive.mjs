// Live DSP-trace watcher: page pushes serial status + NEW filtered trace hits
// via console.log every 10s (no final evaluate needed).
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import { QEMULOG_COUNT, QEMULOG_SINCE } from "./lib/page.mjs";
const waitS = Number(process.argv[2] || 600);
const extra = process.argv[3] || "trace=dsp&tracebuf=1";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 250)));
await page.addInitScript(QEMULOG_COUNT);
await page.goto(`http://127.0.0.1:${process.env.PORT || 8080}/?` + extra, { waitUntil: "networkidle" });
await page.addScriptTag({ content: `
  window.__seen = 0;
  window.__watch = setInterval(() => {
    const m = window.__qemu;
    const re = /boot command|COM_SET|COM_CLEAR|SCU_DSP_INT|core initialized|DE0|TOMCU|CFR|CFSTA|cold program|\\[DSP\\]/;
    const got = ${QEMULOG_SINCE}(window.__qemulog, window.__seen);
    const fresh = got.lines.filter((l) => re.test(l));
    window.__seen = got.total;
    let sl = -1;
    try {
      if (m && m.FS.analyzePath("/serial.log").exists) sl = m.FS.readFile("/serial.log").length;
    } catch (e) {}
    console.log("WATCH v=" + (m ? (Number(m._wasm_vclock())/1e9).toFixed(1) : "-") +
      " u=" + (m ? Number(m._wasm_fb_updates()) : "-") + " serial=" + sl +
      " hits=" + fresh.length + (got.lost ? " cut-unread=" + got.lost : "") +
      (fresh.length ? "\\n" + fresh.slice(-12).join("\\n") : ""));
    const x = window.__ui?.exit;
    if (x && !window.__exited) {
      window.__exited = true;
      console.log("SERIAL_EXIT " + JSON.stringify([x.type, x.code].filter(Boolean).join(" ") || "no details"));
    }
  }, 10000);
`});
await page.click("#ff-mode-own");
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
console.log("booted [" + extra + "]");
await new Promise((r) => setTimeout(r, waitS * 1000));
console.log("=== done ===");
await browser.close();
