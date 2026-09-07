// Lean capture: boot with trace, wait fixed time, dump serial + DSP trace once.
import { chromium } from "playwright-core";
const waitS = Number(process.argv[2] || 240);
const channels = process.argv[3] || "dsp,dsp_interrupt";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:8080/?trace=${encodeURIComponent(channels)}&tracebuf=1`,
  { waitUntil: "networkidle", timeout: 120000 });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
console.log("booted; waiting", waitS, "s…");
await new Promise((r) => setTimeout(r, waitS * 1000));
const dump = await page.evaluate(() => {
  const m = window.__qemu;
  let serial = "";
  try {
    if (m?.FS?.analyzePath("/serial.log")?.exists)
      serial = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log"));
  } catch (e) { serial = "ERR:" + e; }
  const log = window.__qemulog ?? [];
  return { serial, log, v: m ? Number(m._wasm_vclock()) : -1, u: m ? Number(m._wasm_fb_updates()) : -1 };
}).catch((e) => ({ err: String(e).slice(0, 300) }));
if (dump.err) { console.log("EVAL FAILED:", dump.err); await browser.close(); process.exit(1); }
console.log("vclock(s):", (dump.v / 1e9).toFixed(1), "fb updates:", dump.u);
console.log("=== SERIAL tail ===");
console.log(dump.serial.slice(-1200));
console.log("=== TRACE filtered ===");
const hits = dump.log.filter((l) =>
  /boot command|COM_SET|COM_STATUS|COM_CLEAR|TOMCU|SCU_DSP_INT|core initialized|cold program|DE02|CFR|CFSTA|icount2/i.test(l));
console.log("hits:", hits.length);
console.log(hits.slice(-90).join("\n"));
await browser.close();
