// Boot CX70_games.bin and say only whether the guest got going, with the
// page's own console kept.  j2mebench's failure path reports an empty log
// tail and all-zero counters, which says "the guest never ran" without
// saying why; this keeps every console line and the pageerror so a failing
// boot names itself.
//
// Usage: EXTRA_Q=... node bootprobe.mjs [label] [maxSecs]
import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] || "probe";
const maxS = Number(process.argv[3] || 150);
// the meter calls a boot done at 70 guest seconds, so a probe that stops
// earlier can miss the stretch the failures die in
const okV = Number(process.argv[4] || 75);
const port = process.env.PORT || "8080";
const extraQ = process.env.EXTRA_Q || "";
const FLASH = "/workspace/fullflashes/CX70_games.bin";

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const lines = [];
let pageErr = null;
p.on("pageerror", (e) => { pageErr = String(e).slice(0, 300); });
p.on("console", (m) => {
  const t = m.text();
  if (/madvise/.test(t)) return;
  lines.push(`[${m.type()}] ${t.slice(0, 220)}`);
  if (lines.length > 400) lines.shift();
});

const q = ["dist=dist-jit", "rt=budget", ...(extraQ ? [extraQ] : [])].join("&");
await p.goto(`http://127.0.0.1:${port}/?${q}`, { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", FLASH);
const t0 = Date.now();
await p.click("#btn-start");

let verdict = "NOSTART", v = 0, insns = 0;
try {
  await p.waitForFunction(() => !!window.__qemu, null, { timeout: 120000 });
  // the guest is alive once its own clock has moved a real amount; the
  // overlay is the page's verdict and is checked the same way the meter
  // checks it
  while ((Date.now() - t0) / 1000 < maxS) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await p.evaluate(() => {
      const m = window.__qemu;
      const ov = document.getElementById("lcd-overlay");
      return {
        v: m ? Number(m._wasm_vclock()) / 1e9 : 0,
        insns: m ? Number(m._wasm_insns()) : 0,
        stopped: !!ov && !ov.classList.contains("hidden") &&
                 document.getElementById("ov-msg").textContent === "Guest stopped",
      };
    }).catch(() => null);
    if (!st) { verdict = "EVALFAIL"; break; }
    v = st.v; insns = st.insns;
    if (st.stopped) { verdict = "STOPPED"; break; }
    if (v >= okV) { verdict = "OK"; break; }
  }
  if (verdict === "NOSTART" && v > 0) verdict = "SLOW";
} catch (e) {
  verdict = "THREW:" + String(e).slice(0, 120);
}
const wall = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`BOOTPROBE ${label} verdict=${verdict} guestS=${v.toFixed(1)} insns=${insns} wall=${wall} q=${q}`);
if (verdict !== "OK") {
  if (pageErr) console.log("  pageerror: " + pageErr);
  console.log("  console tail:\n    " + lines.slice(-25).join("\n    "));
}
await b.close();
process.exit(verdict === "OK" ? 0 : 1);
