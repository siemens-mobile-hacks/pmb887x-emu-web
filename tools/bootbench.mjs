// Deterministic A/B boot benchmark for the wasm build (patch-series work).
//
// Boots the S75 fullflash in headless Chromium for --secs seconds and
// reports metrics that are comparable across builds independent of page
// start-up skew:
//
//   window   wall seconds of guest work between virtual time v=LO and v=HI
//            (interpolated from 10 s WATCH samples; deterministic guest
//            work, so less wall = faster)
//   final    v / guest insns reached after --secs
//
// The window metric is the primary A/B number: boot is deterministic in
// guest work, and idle (WFI) windows are real-time-gated for every build,
// so differences in the window are pure execution-speed differences.
//
// Usage:
//   PORT=8080 node tools/bootbench.mjs [secs]     (default 110)
//   LO=2 HI=7 ... to move the window
//
// Methodology notes (learned the hard way — see doc/optimization-playbook.md):
//   - align samples by INDEX (WATCH lines), never by raw file line number:
//     interleaved [qemu] warnings corrupt line-based time math.
//   - the first WATCH sample fires ~10 s after page load; page-load skew
//     cancels in the window metric but NOT in "final" numbers of runs of
//     different lengths — always compare equal-duration runs.

import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { fullflash } from "./testflash.mjs";

// summed RSS (MB) of the chromium process tree spawned by this run
function rssMB(browser) {
  try {
    const pid = browser.process()?.pid;
    if (!pid) return null;
    const out = execSync("ps -eo pid=,ppid=,rss=,comm=", { encoding: "ascii" });
    const rows = [];
    for (const l of out.split("\n")) {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (m) rows.push({ pid: +m[1], ppid: +m[2], rss: +m[3] });
    }
    const kids = new Map();
    for (const r of rows) {
      if (!kids.has(r.ppid)) kids.set(r.ppid, []);
      kids.get(r.ppid).push(r.pid);
    }
    let sum = 0;
    const walk = (p) => {
      for (const r of rows) if (r.pid === p) sum += r.rss;
      for (const k of kids.get(p) || []) walk(k);
    };
    walk(pid);
    return Math.round(sum / 1024);
  } catch { return null; }
}

const secs = Number(process.argv[2] || 110);
const LO = Number(process.env.LO || 2.0);
const HI = Number(process.env.HI || 7.0);
const port = process.env.PORT || "8080";

// JS_FLAGS: V8 flags for the benchmarked browser, e.g.
//   JS_FLAGS="--no-wasm-lazy-compilation" node tools/bootbench.mjs 110
// Lets us measure V8-side levers (lazy compilation, tiering budget) that a
// plain page cannot set — the numbers quantify what a page-side workaround
// would be worth.
const jsFlags = process.env.JS_FLAGS || "";
const dist = process.env.DIST || "";
// extra query string for A/B knobs (e.g. EXTRA_Q="env=W64_NOBATCH=1")
const extraQ = process.env.EXTRA_Q || "";
const b = await chromium.launch({ headless: true, args: jsFlags ? [`--js-flags=${jsFlags}`] : [] });
const p = await b.newPage();
const samples = [];
const milestones = {};          // first wall-time (s, from Start) at each v
const MS = [2, 5, 10, 20, 40, 80, 120, 160, 200];
let exitSeen = false, failMsg = null, stalledAt = null;
let nClose = 0, nFlush = 0, rssPeak = 0;
const bootT0 = Date.now();
p.on("console", (m) => {
  const t = m.text();
  if (t.includes(">>EXIT<<")) exitSeen = true;
  if (t.startsWith("W64BATCHFAIL")) { failMsg = t.slice(0, 120); return; }
  if (/W64BATCH close/.test(t)) { nClose++; return; }
  if (/W64FLUSH/.test(t)) { nFlush++; return; }
  if (t.includes("W64BATCH") || t.includes("W64DBG")) console.log("[page] " + t);
  const match = t.match(/v=([\d.]+).*?insns=(\d+)/);
  if (match) {
    const v = parseFloat(match[1]);
    samples.push([v, Number(match[2])]);
    for (const msv of MS) {
      if (v >= msv && milestones[msv] === undefined)
        milestones[msv] = +(((Date.now() - bootT0) / 1000).toFixed(1));
    }
    const k = samples.length;
    if (k >= 4 && samples[k-1][0] === samples[k-4][0] && stalledAt === null)
      stalledAt = samples[k-1][0];
  }
});
const q = [dist ? `dist=${dist}` : "", extraQ].filter(Boolean).join("&");
await p.goto(`http://127.0.0.1:${port}/${q ? `?${q}` : ""}`, { waitUntil: "domcontentloaded" });
await p.addScriptTag({ content: `
  window.__watch = setInterval(() => {
    const m = window.__qemu;
    if (!m) return;
    let sl = -1;
    try { sl = m.FS.readFile("/serial.log").length; } catch {}
    console.log("WATCH v=" + (Number(m._wasm_vclock())/1e9).toFixed(2) +
      " u=" + Number(m._wasm_fb_updates()) + " serial=" + sl +
      " insns=" + (m._wasm_insns ? Number(m._wasm_insns()) : 0));
  }, 10000);
` });
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
const tEnd = Date.now() + secs * 1000;
while (Date.now() < tEnd && !failMsg) {
  await new Promise((r) => setTimeout(r, Math.min(2000, tEnd - Date.now())));
  rssPeak = Math.max(rssPeak, rssMB(b) || 0);
}
await b.close();

function cross(v) {
  for (let k = 1; k < samples.length; k++) {
    if (samples[k - 1][0] < v && v <= samples[k][0]) {
      const f = (v - samples[k - 1][0]) / (samples[k][0] - samples[k - 1][0]);
      return (k - 1) * 10 + f * 10;
    }
  }
  return null;
}

const t0 = cross(LO), t1 = cross(HI);
const last = samples[samples.length - 1] || [0, 0];
const out = {
  samples: samples.length,
  window: t0 !== null && t1 !== null ? (t1 - t0).toFixed(1) : null,
  finalV: last[0].toFixed(1),
  finalInsns: (last[1] / 1e6).toFixed(0),
  exit: exitSeen,
  fail: failMsg,
  stalledAtV: stalledAt,
  rssPeakMB: rssPeak || null,
  batchCloses: nClose || null,
  tbFlushes: nFlush || null,
  milestones,
};
// RATES=1: per-sample guest insns/s (Minsns/s over each 10 s WATCH interval)
// — shows the V8 tier-up warm-up curve directly.
if (process.env.RATES)
  out.rates = samples.map(([v, i], k) =>
    k === 0 ? null : Number(((i - samples[k - 1][1]) / 1e7).toFixed(2)));
console.log(`BOOTBENCH ${JSON.stringify(out)}`);
