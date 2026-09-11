// End-to-end boot benchmark: wall-clock time from Start to the IDLE
// screen. This is the number a human observes with a stopwatch.
//
// Deterministic protocol (keep it this way for future sessions):
//   - fullflash: fullflashes/S75v40lg1.bin (override --flash=)
//   - reference: tools/test_targets/S75v40lg1_idle.png (committed;
//     override --ref=). Compare ONLY the bottom --rows (default 139)
//     rows: everything above that is animated at idle (network-search
//     spinner, clock), the bottom 139 are pixel-stable across boots.
//   - startup=ONLINE, fresh browser per run; runs of the same dist are
//     sequential (deterministic protocol), but ALL DISTS RUN IN PARALLEL
//     (one browser each). Note: parallel dists share host load, so
//     wall-clock metrics across dists in the same invocation are still
//     comparable only if the dists behave similarly — cross-session
//     diffing of idlebench-latest.json remains the reliable comparison.
//   - idle = FIRST LCD match at/after --floor (30) s after Start;
//     tIdle is that sample. Pixel comparison doesn't even start until
//     floorSecs (reaching idle earlier is unlikely) to keep the sampler
//     cheap. Per-pixel rule follows compare-lcd.mjs: a pixel differs when
//     any channel differs by > 48; match when <= --pct (0.5%) differ.
//   - --window LO:HI (default 2:7): wall seconds of guest work between
//     v=LO and v=HI, interpolated from the sample series — the A/B
//     metric that used to come from bootbench.mjs (now deprecated).
//   - --noref: skip the LCD comparison entirely (pct=100, match=false)
//     — pure window/metrics mode, equivalent to old bootbench.
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
//   PORT=8094 node tools/idlebench.mjs dist --runs 3
//   PORT=8094 node tools/idlebench.mjs dist-jit --runs 3 --max 1800
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
const runs = Number(opt("runs", 3));
const maxSecs = Number(opt("max", 1500));
const stallSecs = Number(opt("stall", 300));
const floorSecs = Number(opt("floor", 30));
const [winLo, winHi] = String(opt("window", "2:7")).split(":").map(Number);
const rows = Number(opt("rows", 139));
const pctMax = Number(opt("pct", 0.5));
const port = process.env.PORT || "8080";
const noref = argv.includes("--noref");
const jsFlags = process.env.JS_FLAGS || "";
const extraQ = process.env.EXTRA_Q || "";
const SAMPLE_MS = 2000;
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
const SAMPLER = (cfg) => {
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

// wall-time (s from Start) at which the sample series crosses v
// (linear interpolation between samples) — null if never reached
function crossAt(samples, v) {
  for (let k = 1; k < samples.length; k++) {
    const [t0, v0] = samples[k - 1], [t1, v1] = samples[k];
    if (v0 < v && v <= v1) return t0 + ((v - v0) / (v1 - v0)) * (t1 - t0);
  }
  return null;
}

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
      await p.goto(`http://127.0.0.1:${port}/?dist=${dist}${extraQ ? "&" + extraQ : ""}`, { waitUntil: "domcontentloaded", timeout: 120000 });
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

    while (true) {
      const t = (Date.now() - t0) / 1000;
      if (t >= maxSecs) { rec.cls = "NOIDLE"; break; }
      let s = null;
      try {
        s = await p.evaluate(SAMPLER, {
          refB64, rowsCmp: rows, pctMax,
          cmp: !noref && t >= floorSecs,
        });
      } catch (e) { crashed = "evaluate: " + String(e).slice(0, 120); }
      if (crashed) { rec.cls = "CRASH"; rec.why = crashed; break; }
      if (s) {
        if (lastSample && s.v === lastSample.v) {
          s.stallSince = lastSample.stallSince ?? t;
        }
        lastSample = s;
        rec.samples.push([+t.toFixed(1), +s.v.toFixed(2), s.insns]);
        for (const tv of T_MILESTONES) {
          if (rec.vAt[tv] === undefined && t >= tv) rec.vAt[tv] = +s.v.toFixed(1);
        }
        for (const mv of V_MILESTONES) {
          if (rec.vHitAt[mv] === undefined && s.v >= mv) rec.vHitAt[mv] = +t.toFixed(1);
        }
        // first LCD match at/after floorSecs = idle (s.match stays false
        // until the comparison starts at floorSecs, or with --noref)
        if (s.match && t >= floorSecs) {
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
      await new Promise((r2) => setTimeout(r2, SAMPLE_MS));
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
    console.log(`  [${tag}] -> ${rec.cls}  tModule=${rec.tModule}s  tIdle=${rec.tIdle ?? "-"}s` +
      `  window=${rec.window ?? "-"}s  v@110s=${rec.vAt[110] ?? "-"}  vHit245=${rec.vHitAt[245] ?? "-"}s  rss=${rssPeak}MB`);
    await b.close();
    return rec;
}

async function runDist(dist) {
  const hashes = {
    wasm: sha256(here + `../site/${dist}/qemu-system-arm.wasm`),
    js: sha256(here + `../site/${dist}/qemu-system-arm.js`),
  };
  for (let r = 1; r <= runs; r++) results.push(await runOne(dist, hashes, r));
}

// all dists in parallel (runs within a dist sequential)
await Promise.all(dists.map(runDist));
// restore deterministic ordering in the JSON
results.sort((a, b) => dists.indexOf(a.dist) - dists.indexOf(b.dist) || a.run - b.run);

const summary = {};
for (const dist of dists) {
  const rs = results.filter((r) => r.dist === dist && r.cls === "IDLE").map((r) => r.tIdle).sort((a, b) => a - b);
  const ws = results.filter((r) => r.dist === dist && r.window !== undefined).map((r) => r.window).sort((a, b) => a - b);
  summary[dist] = {
    idle: rs.length ? { n: rs.length, min: rs[0], median: rs[Math.floor(rs.length / 2)], max: rs[rs.length - 1] } : null,
    window: ws.length ? { n: ws.length, min: ws[0], median: ws[Math.floor(ws.length / 2)], max: ws[ws.length - 1] } : null,
    nonIdle: results.filter((r) => r.dist === dist && r.cls !== "IDLE").map((r) => `${r.run}:${r.cls}`),
  };
}
const out = {
  ts: new Date().toISOString(), chromeVer,
  flash: FLASH.split("/").pop(), flashSha: sha256(FLASH),
  ref: REF.split("/").pop(), refSha: sha256(REF),
  config: { maxSecs, stallSecs, floorSecs, rows, pctMax, sampleMs: SAMPLE_MS, startup: "ONLINE", noref, window: `${winLo}:${winHi}`, jsFlags, extraQ },
  summary, results,
};
const outPath = here + `../tests/results/idlebench-${stamp}.json`;
writeFileSync(outPath, JSON.stringify(out, null, 2));
copyFileSync(outPath, here + "../tests/results/idlebench-latest.json");
console.log("\n=== summary ===");
for (const [dist, s] of Object.entries(summary)) {
  console.log(`${dist}: ` + (s.idle
    ? `IDLE min ${s.idle.min}s / median ${s.idle.median}s / max ${s.idle.max}s (n=${s.idle.n})`
    : `NO IDLE RUNS (${(s.nonIdle || []).join(", ")})`) +
    (s.window ? ` | window ${s.window.median}s (min ${s.window.min}s, max ${s.window.max}s, n=${s.window.n})` : ""));
}
console.log(`results: ${outPath} (+ idlebench-latest.json)`);
