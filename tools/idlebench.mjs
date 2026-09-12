// End-to-end boot benchmark: wall-clock time from Start to the IDLE
// screen. This is the number a human observes with a stopwatch.
//
// Deterministic protocol (keep it this way for future sessions):
//   - fullflash: fullflashes/S75v40lg1.bin (override --flash=)
//   - reference: tools/test_targets/S75v40lg1_idle.png (committed;
//     override --ref=). Compare ONLY the bottom --rows (default 139)
//     rows: everything above that is animated at idle (network-search
//     spinner, clock), the bottom 139 are pixel-stable across boots.
//   - startup=ONLINE, fresh browser per run, SEQUENTIAL: one browser at
//     a time, dists interleaved (d1 r1, d2 r1, d1 r2, ...) so host-load
//     drift hits both sides equally.  --parallel runs all dists at once
//     (one browser each) — faster, but the dists then pace each other
//     (2026-09-11: parallel dist/dist-jit pairs finished their 1.3G
//     insns within 0.1 s of each other in 3/3 invocations while their
//     per-phase curves differed by 30 %); use it for smoke only.
//   - idle = FIRST LCD match once comparison is on; comparison turns on
//     at --floor (15) s after Start OR when insns >= --cmpinsns (1.2e9,
//     the boot's fixed work is ~1.345e9), whichever comes first — a
//     fixed 30 s floor used to clamp tIdle from below once boots got
//     close to 30 s.  Sampling is 1 s before that and 0.5 s after it, so
//     tIdle resolves to 0.5 s (it used to sit on a 2 s grid, which is
//     how a 30 % early-phase gap between /dist and /dist-jit read as
//     "median 76.4 s both"). Per-pixel rule follows compare-lcd.mjs: a
//     pixel differs when any channel differs by > 48; match when <=
//     --pct (0.5%) differ.
//   - GUEST-WORK MILESTONES (the sensitive A/B numbers): the boot to
//     idle executes a fixed ~1.345e9 guest insns on this flash (±0.3 %
//     across builds, hosts and load), so "wall s until N insns" is a
//     deterministic per-phase speed metric with no LCD, no grid and no
//     real-time gating: tInsns[0.1|0.25|0.5|0.75|1.0|1.2|1.3]G
//     (interpolated).  t0.5G is the early, translation/flash-heavy
//     phase (where the wasm64 JIT is slower than TCI); t1.3G is
//     "boot work done" (tIdle follows it by ~2-3 s).  Read these before
//     tIdle — tIdle alone hid the JIT's early-phase regression.
//   - --window LO:HI (default 2:7): wall seconds of guest work between
//     v=LO and v=HI, interpolated from the sample series — the A/B
//     metric that used to come from bootbench.mjs (now deprecated).
//   - --noref: skip the LCD comparison entirely (pct=100, match=false)
//     — pure window/metrics mode, equivalent to old bootbench.
//   - --quick: = --runs 1 --max 60 --noref — ~1 min per dist, reports
//     window + t0.1G/t0.25G/t0.5G (the phase where backend regressions
//     show first).  Use it as the iteration loop; full runs are gates.
//   - Every invocation compares itself against the previous
//     idlebench-latest.json (quick runs: idlebench-quick-latest.json; or
//     --baseline <json>; runs with JS_FLAGS/EXTRA_Q never become the
//     baseline) per dist and prints
//     the deltas of tIdle / window / t0.5G / t1.3G medians; |delta| >
//     --regress (5) % is flagged REGRESSION / IMPROVEMENT on stdout, so
//     a slower build cannot pass silently.
//   - RT env: real-time cap mode (0032) the page boots with — default
//     "off" so milestones measure engine speed; RT=banked measures the
//     shipping configuration (site/app.js default).  Like JS_FLAGS/
//     EXTRA_Q, an RT!=off run never becomes the baseline.
//   - JS_FLAGS env: extra V8 flags for the browser (e.g. "--no-wasm-lazy-compilation").
//   - EXTRA_Q env: extra query string appended to the page URL.
//   - RATES=1 env: per-sample guest insns/s added to the JSON.
//   - everything that can identify the run is pinned in the JSON:
//     sha256 of flash/ref/wasm/js, chrome version, host load, config.
//   - results: tests/results/idlebench-<ts>.json and the stable alias
//     tests/results/idlebench-latest.json (diff across sessions).
//   - screenshots: end-state page + LCD crop per run, next to the JSON
//     (tests/results/idlebench-<ts>-<dist>-r<N>[-lcd].png).
//
// Run classification:
//   IDLE     reached the idle screen (tIdle = the metric; also reports
//            tModule = Start click -> module instantiated, the 45 MB
//            fetch+compile the user's reload pays before boot begins)
//   NOIDLE   cap reached while still making forward progress
//   STALL    v frozen for --stall secs (10x-slowdown / crash-loop
//            class — the automatic salvage tells which)
//   CRASH    page error / worker death before idle
//
// Usage:
//   PORT=8094 node tools/idlebench.mjs [dists] [--runs N] [--max S]
//     dists: comma list, default "dist,dist-jit"
//   PORT=8094 node tools/idlebench.mjs --quick             # ~2 min A/B
//   PORT=8094 node tools/idlebench.mjs dist --runs 3
//   PORT=8094 node tools/idlebench.mjs dist-jit --runs 3 --max 1800
//   PORT=8094 node tools/idlebench.mjs --baseline tests/results/idlebench-<ts>.json
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const p = argv.find((a) => a.startsWith(`--${name}=`));
  if (p) return p.slice(name.length + 3);
  return dflt;
};
const dists = (argv.find((a) => !a.startsWith("--")) || "dist,dist-jit").split(",");
// A dist may be written "<dir>@<query>" to append per-dist query parameters
// (e.g. "dist-jit@env=W64_COMPACT_MEMBERS=100000000").  That makes a KNOB
// A/B interleavable the way a two-build A/B is: EXTRA_Q applies to every
// dist of the invocation and so can only compare across invocations, which
// on a shared host is exactly the comparison the playbook forbids.  Like
// EXTRA_Q, such a run never becomes a baseline.
const distDir = (spec) => spec.split("@")[0];
const distQuery = (spec) => {
  const i = spec.indexOf("@");
  return i < 0 ? "" : spec.slice(i + 1);
};
const quick = argv.includes("--quick");
const runs = Number(opt("runs", quick ? 1 : 3));
const maxSecs = Number(opt("max", quick ? 60 : 1500));
const parallel = argv.includes("--parallel");
const regressPct = Number(opt("regress", 5));
const stallSecs = Number(opt("stall", 300));
// idle detection starts at the floor OR once the deterministic boot work
// is nearly done (insns >= --cmpinsns), whichever is first: boots are now
// close to 30 s, so a fixed 30 s floor would clamp tIdle from below.
const floorSecs = Number(opt("floor", 15));
const cmpInsns = Number(opt("cmpinsns", 1.2e9));
const [winLo, winHi] = String(opt("window", "2:7")).split(":").map(Number);
const rows = Number(opt("rows", 139));
const pctMax = Number(opt("pct", 0.5));
const port = process.env.PORT || "8080";
const noref = argv.includes("--noref") || quick;
const jsFlags = process.env.JS_FLAGS || "";
const extraQ = process.env.EXTRA_Q || "";
// RT env: the 0032 real-time cap mode the page boots with.  The default
// stays "off" so the milestone numbers keep measuring engine speed (a
// boot that runs faster than wall must not be paced), but the cap IS the
// shipping default (site/app.js: banked), so a regression that only
// exists under it was invisible here until this knob existed — measure
// RT=banked whenever anything touches icount/halt/timers.
const rtMode = process.env.RT || "off";
const SAMPLE_MS = 1000;        // before the floor (v/insns curve)
const SAMPLE_MS_IDLE = 500;    // at/after the floor (tIdle resolution)
const INSN_MILESTONES = [0.1e9, 0.25e9, 0.5e9, 0.75e9, 1.0e9, 1.2e9, 1.3e9];
const V_MILESTONES = [2, 5, 10, 20, 40, 80, 120, 160, 200, 245];
const T_MILESTONES = [30, 60, 90, 110, 150, 240, 360, 600, 900];

const here = fileURLToPath(new URL(".", import.meta.url));
const FLASH = opt("flash", here + "../fullflashes/S75v40lg1.bin");
const REF = opt("ref", here + "test_targets/S75v40lg1_idle.png");
const refB64 = readFileSync(REF).toString("base64");

const sha256 = (p) => {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16); }
  catch { return "MISSING"; }
};

const chromeVer = (() => {
  try {
    return execSync(
      `"${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-"*/chrome-headless-shell-linux64/chrome-headless-shell --version`,
      { encoding: "ascii", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch { return "unknown"; }
})();

// summed RSS (MB) of the chromium process tree spawned by this run.
// browser.process() is gone in playwright-core 1.63, so we tag each
// browser with a unique launch arg and find its pid via pgrep.
function rssMB(marker) {
  try {
    let pid;
    try { pid = +execSync(`pgrep -f "${marker}" | head -1`, { encoding: "ascii" }).trim(); } catch { return null; }
    if (!pid) return null;
    const out = execSync("ps -eo pid=,ppid=,rss=,comm=", { encoding: "ascii" });
    const rowsArr = [];
    for (const l of out.split("\n")) {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (m) rowsArr.push({ pid: +m[1], ppid: +m[2], rss: +m[3] });
    }
    const kids = new Map();
    for (const r of rowsArr) if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    for (const r of rowsArr) kids.get(r.ppid).push(r.pid);
    let sum = 0;
    const walk = (p) => {
      for (const r of rowsArr) if (r.pid === p) sum += r.rss;
      for (const k of kids.get(p) || []) walk(k);
    };
    walk(pid);
    return Math.round(sum / 1024);
  } catch { return null; }
}

// in-page sampler: returns {v, pct, u, insns, tbs, match} in one shot.
// The reference image is decoded once and cached on the window.
const SAMPLER = async (cfg) => {
  const { refB64, rowsCmp, pctMax, cmp } = cfg;
  const m = window.__qemu;
  if (!m || !m._wasm_vclock) return null;
  const v = Number(m._wasm_vclock()) / 1e9;
  const c = document.getElementById("lcd");
  let pct = 100;
  if (cmp) try {
    const live = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    if (!window.__ref) {
      const img = new Image();
      img.src = "data:image/png;base64," + refB64;
      window.__ref = { img, dec: img.decode(), rc: new OffscreenCanvas(0, 0) };
    }
    const r = window.__ref;
    await r.dec; // drawImage of an undecoded image paints nothing -> false "no match"
    r.rc.width = r.img.width; r.rc.height = r.img.height;
    r.rc.getContext("2d").drawImage(r.img, 0, 0);
    const ref = r.rc.getContext("2d").getImageData(0, 0, r.img.width, r.img.height);
    // bottom rowsCmp rows of the overlap only — the rows above animate
    const H = Math.min(live.height, ref.height);
    const W = Math.min(live.width, ref.width);
    const y0 = Math.max(0, H - rowsCmp);
    let diff = 0, n = 0;
    for (let y = y0; y < H; y++) {
      const li = y * live.width * 4, ri = y * ref.width * 4;
      for (let x = 0; x < W; x++) {
        const i = li + x * 4, j = ri + x * 4;
        n++;
        if (Math.abs(live.data[i] - ref.data[j]) > 48 ||
            Math.abs(live.data[i + 1] - ref.data[j + 1]) > 48 ||
            Math.abs(live.data[i + 2] - ref.data[j + 2]) > 48) diff++;
      }
    }
    pct = n ? (100 * diff) / n : 100;
  } catch {}
  let sl = -1;
  try { sl = m.FS.readFile("/serial.log").length; } catch {}
  return {
    v, pct, serial: sl,
    u: Number(m._wasm_fb_updates()),
    insns: m._wasm_insns ? Number(m._wasm_insns()) : 0,
    tbs: m._wasm_tbs ? Number(m._wasm_tbs()) : 0,
    match: pct <= pctMax,
  };
};

const results = [];

// wall-time (s from Start) at which the sample series crosses value x
// in column col (1 = v, 2 = insns), linear interpolation — null if never
function crossAt(samples, x, col = 1) {
  for (let k = 1; k < samples.length; k++) {
    const [t0, a] = [samples[k - 1][0], samples[k - 1][col]];
    const [t1, b] = [samples[k][0], samples[k][col]];
    if (a < x && x <= b) return t0 + ((x - a) / (b - a)) * (t1 - t0);
  }
  return null;
}
const insnKey = (i) => `${i / 1e9}G`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// same stamp as the JSON below, so screenshots sort next to their run
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);

// end-state screenshot -> tests/results (page + LCD crop). Never fatal:
// a wedged/crashed page just means no shot.
async function shoot(p, tag) {
  const base = path.join(here, `../tests/results/idlebench-${stamp}-${tag}`);
  try { await p.screenshot({ path: `${base}.png` }); } catch { return null; }
  const shots = { page: `${base}.png` };
  try {
    const lcd = await p.$("#lcd");
    if (lcd) {
      await lcd.screenshot({ path: `${base}-lcd.png` });
      shots.lcd = `${base}-lcd.png`;
    }
  } catch {}
  return shots;
}

// one run of one dist -> rec (never throws; failures are classified)
async function runOne(dist, hashes, r) {
    const tag = `${dist}-r${r}`;
    console.log(`\n=== ${tag} (max ${maxSecs}s) ===`);
    const procTag = `idlebench-proc-${process.pid}-${dist}-r${r}`;
    const b = await chromium.launch({ headless: true, args: ["--" + procTag, ...(jsFlags ? [`--js-flags=${jsFlags}`] : [])] });
    const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
    const rec = {
      dist, run: r, hashes, chromeVer, started: new Date().toISOString(),
      loadavg: (execSync("cat /proc/loadavg", { encoding: "ascii" }).split(" ").slice(0, 3).join(" ")),
    };
    const w64lines = [];
    let crashed = null;
    p.on("console", (m) => {
      const t = m.text();
      if (/^W64|^WASM_DIAG/.test(t)) {
        w64lines.push(t.slice(0, 200));
        if (w64lines.length <= 40) console.log(`  [${tag}] [page] ${t.slice(0, 160)}`);
      }
      if (t.includes(">>EXIT<<")) rec.serialExit = true;
    });
    p.on("pageerror", (e) => {
      crashed = String(e).slice(0, 200);
      console.log(`  [${tag}] [pageerror] ${crashed}`);
    });

    try {
      // rt=off by default: the real-time cap would pace a
      // faster-than-realtime boot (RT=banked measures what users get)
      await p.goto(`http://127.0.0.1:${port}/?dist=${distDir(dist)}${distQuery(dist) ? "&" + distQuery(dist) : ""}&rt=${rtMode}${extraQ ? "&" + extraQ : ""}`, { waitUntil: "domcontentloaded", timeout: 120000 });
      await p.selectOption("#startup", "ONLINE");
      await p.setInputFiles("#fullflash", FLASH);
    } catch (e) {
      rec.cls = "CRASH"; rec.why = "setup: " + String(e).slice(0, 120);
      console.log(`  [${tag}] CRASH ${rec.why}`);
      rec.shots = await shoot(p, tag);
      await b.close(); return rec;
    }

    const t0 = Date.now();
    await p.click("#btn-start");
    // the 45 MB module is fetched + compiled only on Start
    try {
      await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });
      rec.tModule = +((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${tag}] [step] module ready ${rec.tModule}s after Start`);
    } catch (e) {
      rec.cls = "CRASH"; rec.why = "module never loaded: " + String(e).slice(0, 120);
      console.log(`  [${tag}] CRASH ${rec.why}`);
      rec.shots = await shoot(p, tag);
      await b.close(); return rec;
    }

    rec.vAt = {}; rec.vHitAt = {}; rec.samples = [];
    let lastSample = null, rssPeak = 0;
    let cmpOn = false;

    while (true) {
      const t = (Date.now() - t0) / 1000;
      if (t >= maxSecs) { rec.cls = "NOIDLE"; break; }
      let s = null;
      cmpOn = cmpOn || (!noref && (t >= floorSecs || (lastSample && lastSample.insns >= cmpInsns)));
      try {
        s = await p.evaluate(SAMPLER, {
          refB64, rowsCmp: rows, pctMax,
          cmp: cmpOn,
        });
      } catch (e) { crashed = "evaluate: " + String(e).slice(0, 120); }
      if (crashed) { rec.cls = "CRASH"; rec.why = crashed; break; }
      if (s) {
        if (lastSample && s.v === lastSample.v) {
          s.stallSince = lastSample.stallSince ?? t;
        }
        lastSample = s;
        // [t, v, insns, tbEntries]: insns/tb per interval = how much
        // each TB entry (prologue, chain hop) is amortised over
        rec.samples.push([+t.toFixed(1), +s.v.toFixed(2), s.insns, s.tbs]);
        for (const tv of T_MILESTONES) {
          if (rec.vAt[tv] === undefined && t >= tv) rec.vAt[tv] = +s.v.toFixed(1);
        }
        for (const mv of V_MILESTONES) {
          if (rec.vHitAt[mv] === undefined && s.v >= mv) rec.vHitAt[mv] = +t.toFixed(1);
        }
        // first LCD match at/after floorSecs = idle (s.match stays false
        // until the comparison starts at floorSecs, or with --noref)
        if (s.match && cmpOn) {
          rec.cls = "IDLE";
          rec.tIdle = +t.toFixed(1);
          rec.at = { v: +s.v.toFixed(1), pct: +s.pct.toFixed(3), insns: s.insns, tbs: s.tbs };
          break;
        }
        if (s.stallSince !== undefined && t - s.stallSince >= stallSecs) {
          rec.cls = "STALL";
          rec.why = `v frozen at ${s.v.toFixed(1)} for ${Math.round(t - s.stallSince)}s`;
          break;
        }
      }
      rssPeak = Math.max(rssPeak, rssMB(procTag) || 0);
      await new Promise((r2) => setTimeout(r2, cmpOn ? SAMPLE_MS_IDLE : SAMPLE_MS));
    }
    rec.wall = +((Date.now() - t0) / 1000).toFixed(1);
    rec.rssPeakMB = rssPeak;
    rec.last = lastSample && {
      v: +lastSample.v.toFixed(1), pct: +lastSample.pct.toFixed(3),
      u: lastSample.u, insns: lastSample.insns, tbs: lastSample.tbs,
    };
    if (w64lines.length) rec.w64lines = w64lines;

    // A/B window metric (ex-bootbench): wall secs of guest work between
    // v=winLo and v=winHi, interpolated over the sample series
    const wLo = crossAt(rec.samples, winLo), wHi = crossAt(rec.samples, winHi);
    if (wLo !== null && wHi !== null) rec.window = +(wHi - wLo).toFixed(1);
    // guest-work milestones: wall s until N insns executed (deterministic
    // work -> pure speed; no LCD, no grid, immune to idle real-time gating)
    rec.tInsns = {};
    for (const i of INSN_MILESTONES) {
      const t = crossAt(rec.samples, i, 2);
      if (t !== null) rec.tInsns[insnKey(i)] = +t.toFixed(1);
    }
    if (process.env.RATES)
      rec.rates = rec.samples.map(([t, v, i], k) =>
        k === 0 || t === rec.samples[k - 1][0] ? null
          : +((i - rec.samples[k - 1][2]) / ((t - rec.samples[k - 1][0]) * 1e6)).toFixed(2));

    rec.shots = await shoot(p, tag);

    if (rec.cls !== "IDLE") {
      const dir = `/tmp/idlebench-${tag}`;
      try { mkdirSync(dir, { recursive: true }); } catch {}
      try {
        const names = await p.evaluate(() => {
          const m = window.__qemu;
          return m ? m.FS.readdir("/").filter((f) => /^(serial\.log|w64bad-|w64fail-)/.test(f)) : [];
        });
        for (const n of names || []) {
          try {
            const bytes = await p.evaluate((f) => window.__qemu.FS.readFile("/" + f), n);
            writeFileSync(`${dir}/${n}`, Buffer.from(bytes));
            console.log(`  [${tag}] salvaged ${n} (${bytes.length} B) -> ${dir}`);
          } catch {}
        }
      } catch {}
      rec.salvageDir = dir;
    }
    const ms = Object.entries(rec.tInsns).map(([k, t]) => `${k}:${t}`).join(" ");
    console.log(`  [${tag}] -> ${rec.cls}  tModule=${rec.tModule}s  tIdle=${rec.tIdle ?? "-"}s` +
      `  window=${rec.window ?? "-"}s  tInsns[${ms}]  insns@end=${rec.last ? (rec.last.insns / 1e6).toFixed(0) + "M" : "-"}  rss=${rssPeak}MB`);
    await b.close();
    return rec;
}

async function runDist(dist) {
  const hashes = {
    wasm: sha256(here + `../site/${distDir(dist)}/qemu-system-arm.wasm`),
    js: sha256(here + `../site/${distDir(dist)}/qemu-system-arm.js`),
  };
  for (let r = 1; r <= runs; r++) results.push(await runOne(dist, hashes, r));
}

const hashesOf = (dist) => ({
  wasm: sha256(here + `../site/${distDir(dist)}/qemu-system-arm.wasm`),
  js: sha256(here + `../site/${distDir(dist)}/qemu-system-arm.js`),
});
if (parallel) {
  // all dists at once (runs within a dist sequential) — smoke only, the
  // dists pace each other (see header)
  await Promise.all(dists.map(runDist));
} else {
  // one browser at a time, dists interleaved per run index
  for (let r = 1; r <= runs; r++)
    for (const dist of dists) results.push(await runOne(dist, hashesOf(dist), r));
}
// restore deterministic ordering in the JSON
results.sort((a, b) => dists.indexOf(a.dist) - dists.indexOf(b.dist) || a.run - b.run);

const summary = {};
for (const dist of dists) {
  const rs = results.filter((r) => r.dist === dist && r.cls === "IDLE").map((r) => r.tIdle).sort((a, b) => a - b);
  const ws = results.filter((r) => r.dist === dist && r.window !== undefined).map((r) => r.window).sort((a, b) => a - b);
  const tInsns = {};
  for (const i of INSN_MILESTONES) {
    const k = insnKey(i);
    const ts = results.filter((r) => r.dist === dist && r.tInsns && r.tInsns[k] !== undefined).map((r) => r.tInsns[k]);
    if (ts.length) tInsns[k] = { n: ts.length, min: Math.min(...ts), median: median(ts), max: Math.max(...ts) };
  }
  summary[dist] = {
    idle: rs.length ? { n: rs.length, min: rs[0], median: rs[Math.floor(rs.length / 2)], max: rs[rs.length - 1] } : null,
    window: ws.length ? { n: ws.length, min: ws[0], median: ws[Math.floor(ws.length / 2)], max: ws[ws.length - 1] } : null,
    tInsns,
    hashes: hashesOf(dist),
    nonIdle: results.filter((r) => r.dist === dist && r.cls !== "IDLE").map((r) => `${r.run}:${r.cls}`),
  };
}
const out = {
  ts: new Date().toISOString(), chromeVer,
  flash: FLASH.split("/").pop(), flashSha: sha256(FLASH),
  ref: REF.split("/").pop(), refSha: sha256(REF),
  config: { maxSecs, stallSecs, floorSecs, rows, pctMax, sampleMs: SAMPLE_MS, sampleMsIdle: SAMPLE_MS_IDLE, startup: "ONLINE", noref, parallel, window: `${winLo}:${winHi}`, jsFlags, extraQ },
  summary, results,
};
// "latest" aliases: full runs -> idlebench-latest.json, --quick runs ->
// idlebench-quick-latest.json (different caps, keep the baselines apart).
// Knob runs (JS_FLAGS / EXTRA_Q / RT set) never become a baseline.
const latestPath = here + `../tests/results/idlebench-${quick ? "quick-" : ""}latest.json`;
const knobRun = !!(jsFlags || extraQ || rtMode !== "off" ||
                   dists.some((d) => d.includes("@")));
const baselinePath = opt("baseline", latestPath);
let baseline = null;
try { baseline = JSON.parse(readFileSync(baselinePath, "utf8")); } catch {}
const outPath = here + `../tests/results/idlebench-${stamp}.json`;
writeFileSync(outPath, JSON.stringify(out, null, 2));
if (!knobRun) copyFileSync(outPath, latestPath);
console.log("\n=== summary ===");
for (const [dist, s] of Object.entries(summary)) {
  const ms = Object.entries(s.tInsns).map(([k, m]) => `${k}:${m.median}`).join(" ");
  console.log(`${dist} [wasm ${s.hashes.wasm}]: ` + (s.idle
    ? `IDLE min ${s.idle.min}s / median ${s.idle.median}s / max ${s.idle.max}s (n=${s.idle.n})`
    : `NO IDLE RUNS (${(s.nonIdle || []).join(", ")})`) +
    (s.window ? ` | window ${s.window.median}s (min ${s.window.min}s, max ${s.window.max}s, n=${s.window.n})` : "") +
    (ms ? ` | tInsns median [${ms}]` : ""));
}
// A/B across dists of this invocation: per-metric ratios vs the first dist
if (dists.length > 1) {
  const ref = summary[dists[0]];
  const pick = (s) => ({ tIdle: s.idle?.median, window: s.window?.median, ...Object.fromEntries(Object.entries(s.tInsns).map(([k, m]) => ["t" + k, m.median])) });
  const a = pick(ref);
  for (const dist of dists.slice(1)) {
    const b = pick(summary[dist]);
    const parts = Object.keys(a).filter((k) => a[k] != null && b[k] != null)
      .map((k) => `${k} ${b[k]}/${a[k]} = ${(100 * (b[k] / a[k] - 1)).toFixed(0).replace(/^(\d)/, "+$1")} %`);
    if (parts.length) console.log(`A/B ${dist} vs ${dists[0]}: ` + parts.join(" | ") + "   (positive = slower)");
  }
}
// regression check vs the previous latest (or --baseline): same flash + protocol only
if (baseline && baseline.flashSha === out.flashSha && baseline.config?.startup === "ONLINE") {
  console.log(`\n=== vs baseline ${path.basename(baselinePath)} (${baseline.ts}) ===`);
  for (const dist of dists) {
    const b = baseline.summary?.[dist];
    if (!b) { console.log(`${dist}: no baseline runs`); continue; }
    const rows = [
      ["tIdle", summary[dist].idle?.median, b.idle?.median],
      ["window", summary[dist].window?.median, b.window?.median],
      ...INSN_MILESTONES.map((i) => ["t" + insnKey(i), summary[dist].tInsns[insnKey(i)]?.median, b.tInsns?.[insnKey(i)]?.median]),
    ].filter(([, x, y]) => x != null && y != null);
    if (!rows.length) { console.log(`${dist}: no comparable metrics (baseline predates tInsns? run once more)`); continue; }
    const parts = rows.map(([k, x, y]) => {
      const d = 100 * (x / y - 1);
      const tag = d > regressPct ? " REGRESSION" : d < -regressPct ? " IMPROVEMENT" : "";
      return `${k} ${y}->${x} (${d >= 0 ? "+" : ""}${d.toFixed(0)} %${tag})`;
    });
    const hashNote = b.hashes && b.hashes.wasm !== summary[dist].hashes.wasm ? ` [wasm ${b.hashes.wasm} -> ${summary[dist].hashes.wasm}]` : " [same wasm]";
    console.log(`${dist}${hashNote}: ` + parts.join(" | "));
  }
} else if (baseline) {
  console.log(`\n(no baseline comparison: ${path.basename(baselinePath)} uses a different flash/protocol)`);
}
console.log(`results: ${outPath}` + (knobRun ? " (knob run: latest alias NOT updated)" : ` (+ ${path.basename(latestPath)})`));
