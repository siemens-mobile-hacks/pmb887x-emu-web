// Boot a dist in Playwright's Firefox (or chromium with BROWSER=chromium),
// sampling vclock/insns/RSS and capturing console errors — the
// cross-browser smoke for the wasm64 backend (Firefox OOM repro).
// Usage: [BROWSER=firefox|chromium] [PORT=8080] [MAX=180] node ffboot.mjs [dist] [extraQ]
import { firefox, chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import { execSync } from "node:child_process";

const dist = process.argv[2] || "dist-jit";
const extraQ = process.argv[3] || "";
const port = process.env.PORT || "8080";
const maxSecs = Number(process.env.MAX || 180);
const which = process.env.BROWSER || "firefox";
const tag = `ffboot-${process.pid}`;

function rssMB() {
  try {
    const rows = execSync("ps -eo pid=,ppid=,rss=,args=", { encoding: "ascii" }).split("\n");
    const procs = [];
    for (const l of rows) { const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); if (m) procs.push({ pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] }); }
    const roots = procs.filter(p => p.args.includes(tag)).map(p => p.pid);
    const set = new Set(roots);
    let grew = true;
    while (grew) { grew = false; for (const p of procs) if (!set.has(p.pid) && set.has(p.ppid)) { set.add(p.pid); grew = true; } }
    let sum = 0, max = 0;
    for (const p of procs) if (set.has(p.pid)) { sum += p.rss; max = Math.max(max, p.rss); }
    return { sum: Math.round(sum / 1024), max: Math.round(max / 1024) };
  } catch { return null; }
}

const launcher = which === "chromium" ? chromium : firefox;
const b = await launcher.launch({ headless: true, args: ["--" + tag] });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
p.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" || m.type() === "warning" || /^W64|out of memory|OOM/i.test(t)) {
    errs.push(`[${m.type()}] ${t.slice(0, 200)}`);
    console.log(`  [console.${m.type()}] ${t.slice(0, 200)}`);
  }
});
p.on("pageerror", (e) => { errs.push("pageerror " + String(e).slice(0, 200)); console.log("  [pageerror]", String(e).slice(0, 200)); });
p.on("crash", () => { errs.push("PAGE CRASH"); console.log("  [crash] page crashed"); });

await p.goto(`http://127.0.0.1:${port}/?dist=${dist}${extraQ ? "&" + extraQ : ""}`, { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.setInputFiles("#fullflash", fullflash);
const t0 = Date.now();
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });
console.log(`${which}/${dist}: module ready ${((Date.now() - t0) / 1000).toFixed(1)}s`);
let last = null;
while ((Date.now() - t0) / 1000 < maxSecs) {
  await new Promise(r => setTimeout(r, 2000));
  let s = null;
  try {
    s = await p.evaluate(() => {
      const m = window.__qemu; if (!m || !m._wasm_vclock) return null;
      const st = m._wasm_memstat ? [7, 9, 2, 8].map(i => Number(m._wasm_memstat(i))) : null;
      const pcs = []; if (m._wasm_pc) { for (let i = 0; i < 8; i++) pcs.push(Number(m._wasm_pc()).toString(16)); }
      return { v: Number(m._wasm_vclock()) / 1e9, insns: m._wasm_insns ? Number(m._wasm_insns()) : 0, u: m._wasm_fb_updates ? Number(m._wasm_fb_updates()) : 0, st, pcs };
    });
  } catch (e) { console.log("  [evaluate failed]", String(e).slice(0, 120)); break; }
  const r = rssMB();
  const t = ((Date.now() - t0) / 1000).toFixed(1);
  if (s) { last = s; console.log(`t=${t}s v=${s.v.toFixed(2)} insns=${(s.insns / 1e6).toFixed(0)}M u=${s.u} rss=${r ? r.sum + "MB (max proc " + r.max + ")" : "?"}` + (s.st ? ` tbgen=${s.st[0]} rewind=${s.st[1]} iold=${s.st[2]} flush=${s.st[3]}` : "") + (s.pcs ? " pc=" + s.pcs.join(",") : "")); }
  else console.log(`t=${t}s (no module) rss=${r ? r.sum : "?"}`);
  if (errs.some(e => /CRASH|out of memory/i.test(e))) break;
}
console.log(`END ${which}/${dist} last=${JSON.stringify(last)} errors=${errs.length}`);
for (const e of errs.slice(0, 30)) console.log("  ERR " + e);
await b.close();
