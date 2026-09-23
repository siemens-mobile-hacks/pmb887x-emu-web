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
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", fullflash);
const t0 = Date.now();
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });
console.log(`${which}/${dist}: module ready ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const samples = [];
let last = null;
while ((Date.now() - t0) / 1000 < maxSecs) {
  await new Promise(r => setTimeout(r, 2000));
  let s = null;
  try {
    s = await p.evaluate(() => {
      const m = window.__qemu; if (!m || !m._wasm_vclock) return null;
      return { v: Number(m._wasm_vclock()) / 1e9, insns: m._wasm_insns ? Number(m._wasm_insns()) : 0, u: m._wasm_fb_updates ? Number(m._wasm_fb_updates()) : 0 };
    });
  } catch (e) { console.log("  [evaluate failed]", String(e).slice(0, 120)); break; }
  const r = rssMB();
  const t = (Date.now() - t0) / 1000;
  if (s) { last = s; samples.push({ t, ...s }); console.log(`t=${t.toFixed(1)}s v=${s.v.toFixed(2)} insns=${(s.insns / 1e6).toFixed(0)}M u=${s.u} rss=${r ? r.sum + "MB (max proc " + r.max + ")" : "?"}`); }
  else console.log(`t=${t.toFixed(1)}s (no module) rss=${r ? r.sum : "?"}`);
  if (errs.some(e => /CRASH|out of memory/i.test(e))) break;
}
// The page exposes no module counters (2026-09-22 review), so the module
// budget shows up only as what exhausting it does: an error, or a guest
// that stops executing.  An idle phone still runs ~1 M insns/s.
const why = [];
if (!last) why.push("no sample");
else {
  if (last.v < 20) why.push(`vclock ${last.v.toFixed(1)}s < 20s`);
  if (last.u < 1) why.push("no framebuffer update");
  const ref = samples.filter(x => x.t <= samples[samples.length - 1].t - 20).pop();
  if (!ref) why.push("run shorter than 20s");
  else if (last.insns <= ref.insns) why.push("insns stalled over the last 20s");
}
console.log(`END ${which}/${dist} last=${JSON.stringify(last)} errors=${errs.length} progress=${why.length ? "FAIL (" + why.join("; ") + ")" : "ok"}`);
for (const e of errs.slice(0, 30)) console.log("  ERR " + e);
await b.close();
