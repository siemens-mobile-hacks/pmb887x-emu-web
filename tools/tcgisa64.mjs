// op-suite runner against the wasm64 dist-jit build (parameterized dist)
import { chromium } from "playwright-core";
const port = process.argv[2] || "8094";
const dist = process.argv[3] || "dist-jit";
const outFile = process.argv[4] || null;
const envs = process.argv.slice(5);   // extra ?env=K=V page knobs
let bridge = null;
const timeoutMs = 10 * 60 * 1000;
const envQ = envs.map((e) => `&env=${encodeURIComponent(e)}`).join("");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.exposeFunction("__suiteReport", (text, code) => { bridge = { text, code }; });
const qemuLog = [];
page.on("console", (m) => { const t = m.text(); if (t.startsWith("[qemu]")) qemuLog.push(t); });
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 800)));
await page.goto(`http://127.0.0.1:${port}/?suite=dist/tcgisa.bin&dist=${dist}${envQ}`,
                { waitUntil: "networkidle", timeout: 120000 });
let serial = "";
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  if (bridge) { serial = bridge.text; break; }
  try {
    const s = await page.evaluate(() => {
      const m = window.__qemu;
      try { return new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); }
      catch (e) { return ""; }
    });
    serial = s;
    if (/^# result:/m.test(serial)) break;
  } catch (e) { break; }
  if (Date.now() - t0 > timeoutMs) { console.error(`TIMEOUT after ${timeoutMs/1000}s`); break; }
}
process.stdout.write(serial);
if (outFile) { const { writeFileSync } = await import("node:fs"); writeFileSync(outFile, serial); }
const result = (serial.match(/^# result: pass=(\d+) fail=(\d+)/m) || [])[0] || null;
if (qemuLog.length) console.error(`[tcgisa] qemu stderr tail:\n  ` + qemuLog.slice(-10).join("\n  "));
await browser.close();
if (!result) { console.error("[tcgisa] no suite result line — boot/exit failure?"); process.exit(1); }
console.error(`[tcgisa] ${result}`);
process.exit(/fail=(\d+)/.exec(result)?.[1] === "0" ? 0 : 1);
