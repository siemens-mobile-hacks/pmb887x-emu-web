// Retry-loop S75 boot repro: captures the failing batch module + telemetry.
// usage: node repro.mjs [attempts] [secsPerAttempt]
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { fullflash } from "./testflash.mjs";
const attempts = Number(process.argv[2] || 6);
const secs = Number(process.argv[3] || 150);
let captured = 0;

for (let a = 1; a <= attempts && captured < 1; a++) {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  const t0 = Date.now();
  let failed = false, failMeta = "";
  p.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("W64BATCHFAIL")) {
      failed = true; failMeta = t;
      console.log(`[a${a} +${((Date.now()-t0)/1000)|0}s] ${t.slice(0, 140)}`);
      return;
    }
    if (t.startsWith("W64FAILSAVED")) {
      console.log(`[a${a}] ` + t);
      return;
    }
    if (/^WATCH/.test(t)) console.log(`[a${a} +${((Date.now()-t0)/1000)|0}s] ` + t);
    if (/W64BATCHBAD|W64BATCHSKIP|W64BATCHRETRY|staged hdr|body_len=|mod  @|src  @|prev tail/.test(t))
      console.log(`[a${a}] ` + t.replace(/^\[qemu\] /, ""));
  });
  p.on("pageerror", (e) => {
    const s = String(e);
    if (!/BigInt/.test(s)) console.log(`[a${a}] pageerror: ` + s.slice(0, 200));
  });
  try {
    await p.goto("http://127.0.0.1:8094/?dist=dist-jit&env=W64_DEBUG=1", { waitUntil: "domcontentloaded" });
    await p.addScriptTag({ content: `
      window.__watch = setInterval(() => {
        const m = window.__qemu;
        if (!m) return;
        let sl = -1;
        try { sl = m.FS.readFile("/serial.log").length; } catch {}
        console.log("WATCH v=" + (Number(m._wasm_vclock())/1e9).toFixed(2) +
          " insns=" + (m._wasm_insns ? Number(m._wasm_insns()) : 0) + " serial=" + sl);
      }, 10000);
    `});
    await p.setInputFiles("#fullflash", fullflash);
    await p.click("#btn-start");
    await new Promise((r) => setTimeout(r, secs * 1000));
  } catch (e) { console.log(`[a${a}] nav error: ${String(e).slice(0, 120)}`); }
  if (failed) {
    captured++;
    try {
      const names = await p.evaluate(() => {
        const m = window.__qemu;
        return m ? m.FS.readdir("/").filter((f) => f.startsWith("w64fail-")) : [];
      });
      for (const n of names) {
        const bytes = await p.evaluate((f) => window.__qemu.FS.readFile("/" + f), n);
        const out = `/tmp/${n}`;
        writeFileSync(out, Buffer.from(bytes));
        console.log(`[a${a}] SAVED ${out} (${bytes.length} bytes)`);
      }
    } catch (e) { console.log(`[a${a}] FS salvage failed: ${String(e).slice(0, 120)}`); }
    console.log(`[a${a}] ${failMeta}`);
  } else {
    console.log(`[a${a}] attempt done, no batch failure`);
  }
  await b.close();
}
console.log(captured ? `captured ${captured} failing module(s)` : "NO FAILURE REPRODUCED");
