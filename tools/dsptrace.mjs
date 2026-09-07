// Deep capture: boot with tracing, watch the serial log, stop after the
// firmware's L1 task exit (">>EXIT<<") or timeout; dump serial + DSP trace.
//   node dsptrace.mjs [maxWaitSeconds] [traceChannels]
import { chromium } from "playwright-core";
const maxWait = Number(process.argv[2] || 420);
const channels = process.argv[3] || "dsp,dsp_interrupt";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:8080/?trace=${encodeURIComponent(channels)}&tracebuf=1&debug=0`,
  { waitUntil: "networkidle", timeout: 120000 });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
console.log("booted (trace=" + channels + "); waiting for >>EXIT<<…");

let exited = false;
for (let t = 0; t < maxWait; t += 15) {
  await new Promise((r) => setTimeout(r, 15000));
  const s = await page.evaluate(() => {
    const m = window.__qemu;
    let serial = "";
    try {
      if (m?.FS?.analyzePath("/serial.log")?.exists)
        serial = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log"));
    } catch {}
    return {
      serialLen: serial.length,
      exitSeen: serial.includes(">>EXIT<<"),
      v: m?._wasm_vclock ? Number(m._wasm_vclock()) / 1e9 : -1,
      u: m?._wasm_fb_updates ? Number(m._wasm_fb_updates()) : -1,
    };
  });
  console.log(`t=${t + 15}s`, JSON.stringify(s));
  if (s.exitSeen) { exited = true; await new Promise((r) => setTimeout(r, 20000)); break; }
}

const dump = await page.evaluate(() => {
  const m = window.__qemu;
  let serial = "";
  try {
    if (m?.FS?.analyzePath("/serial.log")?.exists)
      serial = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log"));
  } catch {}
  const log = window.__qemulog ?? [];
  return { serial, log };
});

console.log("=== SERIAL (last 2500 chars) ===");
console.log(dump.serial.slice(-2500));
console.log("=== TRACE: boot command / comm / irqs (last 120) ===");
const hits = dump.log.filter((l) =>
  /boot command|runtime command|COM_SET|COM_CLEAR|COM_STATUS|TOMCU|MCU|SCU_DSP_INT|core initialized|stopped|halted/i.test(l));
console.log(hits.slice(-120).join("\n"));
console.log("=== TRACE: last 30 lines ===");
console.log(dump.log.slice(-30).join("\n"));
await browser.close();
