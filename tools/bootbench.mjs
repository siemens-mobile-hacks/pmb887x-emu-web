// Boot benchmark: start a phone and follow its boot from the Start click to
// the idle screen, sampling the guest clock, the instruction count and the
// audio ring header every 200 ms.  It answers how far behind real time the
// boot falls, and what that does to the sounds the phone plays while booting
// (the boot chime): the worklet slows a sound down while the guest renders it
// slower than real time.
//
//   PORT=8080 node tools/bootbench.mjs <phone> [dist[,dist@query...]]
//        [--runs 3] [--warm] [--flash path] [--after S]
//
// Phones: el71, s75, c81, sl65, ke800, ke970, cx70 (the flashes under
// fullflashes/ next to or one level above the repo; --flash overrides).
// --warm boots once in the same browser context before each measured boot,
// so the engine's compiled code comes from Chrome's wasm code cache, as on a
// returning visitor's second boot.  --after S keeps sampling S seconds past
// the idle detection (default 5).
//
// Per run:
//   tIdle      wall s from Start to the idle screen (the instruction rate
//              stayed low for 4 s, as tools/scenebench.mjs detects it)
//   tQemu      wall s from Start until the guest ran its first instruction
//   w@<v>      wall s from the guest's first instruction until its clock
//              read v seconds; while it is behind real time this is the
//              raw speed of the emulator
//   lagMax     the most the guest clock fell behind wall time (s)
//   vratio<a>-<b>  guest s per wall s over that span of guest time
//   sounds     every stretch of time the audio ring moved: guest s at its
//              start, wall s, the producer speed (ring s per wall s) and the
//              ring audio the worklet replayed to slow it down (stretchedMs)
//   stretchedMs, underruns, gapMs  totals over the boot
//
// Env: BOOTBENCH_CHROME_ARGS extra chrome args, BOOTBENCH_CONSOLE=<text>
// prints the page's console lines containing it (cut at BOOTBENCH_CONSOLE_MAX
// chars, default 300), BOOTBENCH_SAMPLES=1 keeps the 200 ms samples.
//
// Runs interleave across dists.  Results: tests/results/bootbench-<phone>-<ts>.json.
import { chromium } from "playwright-core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes("--" + n);
const BOOL = ["--warm"];
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !BOOL.includes(argv[i - 1])));
const phones = {
  el71: { image: "EL71v41lg91.bin", bootInsns: 1e9 },
  s75: { image: "S75v40lg1.bin", bootInsns: 1e9 },
  c81: { image: "rrC81 .bin", bootInsns: 1e9 },
  sl65: { image: "SL65v49lg1_TIM.bin", bootInsns: 5e8 },
  ke800: { image: "KE800v11b.bin", bootInsns: 3e8 },
  ke970: { image: "KE970v10d.bin", bootInsns: 3e8 },
  cx70: { image: "CX70v56lg3.bin", bootInsns: 5e8 },
};
const phoneName = positional[0];
const ph = phones[phoneName];
if (!ph) {
  console.error(`usage: node bootbench.mjs <${Object.keys(phones).join("|")}> [dists] [--runs N] [--warm]`);
  process.exit(2);
}
const dists = (positional[1] || "dist-jit").split(",");
const runs = Number(opt("runs", 3));
const warm = flag("warm");
const afterS = Number(opt("after", 5));
const port = process.env.PORT || "8080";
const flash = opt("flash", [here + "../../fullflashes/" + ph.image, here + "../fullflashes/" + ph.image]
  .find((f) => existsSync(f)));
if (!flash || !existsSync(flash)) throw new Error(`${ph.image} not found: pass --flash <path>`);
const distDir = (spec) => spec.split("@")[0];
const distQuery = (spec) => { const i = spec.indexOf("@"); return i < 0 ? "" : spec.slice(i + 1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const outBase = path.join(here, `../tests/results/bootbench-${phoneName}-${stamp}`);

// Sampled in the page every 200 ms from the Start click; the samples stay in
// the page so a busy main thread cannot skew them, and are read out at the end.
const SAMPLER = `(() => {
  const S = window.__bootSamples = [];
  const t0 = performance.now();
  const tick = () => {
    const m = window.__qemu;
    const r = { t: (performance.now() - t0) / 1000 };
    if (m && m._wasm_insns) {
      r.v = Number(m._wasm_vclock()) / 1e9;
      r.i = Number(m._wasm_insns());
      const ptr = m._wasm_audio_ring_ptr ? Number(m._wasm_audio_ring_ptr()) : 0;
      if (ptr) {
        const h = new Int32Array(m.HEAPU8.buffer, ptr, 16);
        r.f = h[3]; r.w = Atomics.load(h, 5); r.u = Atomics.load(h, 8); r.g = Atomics.load(h, 9);
        r.s = h[15]; r.st = h[12]; r.a = h[6];
      }
    }
    S.push(r);
  };
  tick();
  window.__bootTimer = setInterval(tick, 200);
})()`;

async function boot(p, spec, measured) {
  const q = distQuery(spec);
  await p.goto(`http://127.0.0.1:${port}/?dist=${distDir(spec)}${q ? "&" + q : ""}`,
    { waitUntil: "domcontentloaded", timeout: 120000 });
  // boots are timed without the GSM network, as scenebench.mjs measures
  await p.evaluate(() => {
    const gsm = document.querySelector("#gsm");
    gsm.checked = false;
    for (const type of ["input", "change"]) gsm.dispatchEvent(new Event(type, { bubbles: true }));
  });
  await p.selectOption("#startup", "ONLINE");
  await p.click("#ff-mode-own");
  await p.setInputFiles("#fullflash", [flash]);
  // the engine prefetch compiles the module in the background; a Start that
  // beats it waits for the same compile, so let it finish for every leg alike
  await p.waitForFunction(() => !/Prefetching|Downloading/.test(document.body.innerText), null, { timeout: 120000 })
    .catch(() => {});
  await p.evaluate(SAMPLER);
  const t0 = Date.now();
  await p.click("#btn-start");
  await p.waitForFunction(() => !!window.__qemu?._wasm_insns, null, { timeout: 240000 });
  let quiet = 0, idleAt = null;
  let last = await p.evaluate(() => ({ t: performance.now(), i: Number(window.__qemu._wasm_insns()) }));
  for (;;) {
    await sleep(1000);
    if ((Date.now() - t0) / 1000 > 300) throw new Error("guest never went idle");
    const c = await p.evaluate(() => ({ t: performance.now(), i: Number(window.__qemu._wasm_insns()) }));
    quiet = (c.i - last.i) / ((c.t - last.t) / 1000) < 8e6 ? quiet + 1 : 0;
    last = c;
    if (idleAt == null && (Date.now() - t0) / 1000 >= 15 && quiet >= 4 && c.i >= ph.bootInsns)
      idleAt = (Date.now() - t0) / 1000 - 4;
    if (idleAt != null && (Date.now() - t0) / 1000 >= idleAt + 4 + (measured ? afterS : 0)) break;
  }
  const samples = await p.evaluate(() => { clearInterval(window.__bootTimer); return window.__bootSamples; });
  return { idleAt, samples };
}

function analyse(idleAt, S) {
  const r = { tIdle: +idleAt.toFixed(1) };
  const g = S.filter((x) => x.v != null);
  const first = g.find((x) => x.i > 0) || g[0];
  r.tQemu = +first.t.toFixed(2);
  // wall time since the first instruction at which the clock reached v
  const wallAt = (v) => {
    for (let k = 1; k < g.length; k++)
      if (g[k].v >= v) {
        const a = g[k - 1], b = g[k], f = b.v > a.v ? (v - a.v) / (b.v - a.v) : 1;
        return a.t + f * (b.t - a.t) - first.t;
      }
    return null;
  };
  const marks = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25];
  for (const v of marks) {
    const w = wallAt(v);
    if (w != null) r["w@" + v] = +w.toFixed(2);
  }
  let lag = 0;
  for (const x of g) lag = Math.max(lag, x.t - first.t - x.v);
  r.lagMax = +lag.toFixed(2);
  for (const [a, b] of [[0, 3], [3, 6], [6, 10], [10, 15], [15, 20]]) {
    const wa = a === 0 ? 0 : wallAt(a), wb = wallAt(b);
    if (wa != null && wb != null) r[`vratio${a}-${b}`] = +((b - a) / (wb - wa)).toFixed(3);
  }
  // sounds: runs of samples in which the ring's write cursor moved
  const au = g.filter((x) => x.f);
  if (au.length) {
    const freq = au[0].f, sounds = [];
    let cur = null;
    for (let k = 1; k < au.length; k++) {
      const a = au[k - 1], b = au[k];
      const moved = ((b.w - a.w) | 0) > 0;
      if (moved && !cur) cur = { a, last: b, n: 0 };
      if (moved) { cur.last = b; cur.n = 0; }
      else if (cur && ++cur.n >= 5) { sounds.push(cur); cur = null; }
    }
    if (cur) sounds.push(cur);
    r.sounds = sounds.map(({ a, last }) => {
      const wall = last.t - a.t, prod = ((last.w - a.w) | 0) / freq;
      return {
        v: +a.v.toFixed(2), wall: +(a.t - first.t).toFixed(2), len: +prod.toFixed(2),
        speed: wall > 0 ? +(prod / wall).toFixed(2) : null,
        stretchedMs: Math.round(((last.s - a.s) | 0) / freq * 1000),
      };
    });
    const z = au[au.length - 1], y = au[0];
    r.stretchedMs = Math.round(((z.s - y.s) | 0) / freq * 1000);
    r.underruns = z.u - y.u;
    // the page runs the ring at the context's rate, which the worklet counts gaps in
    r.gapMs = Math.round(((z.g - y.g) | 0) / freq * 1000);
    r.audioS = +(((z.w - y.w) | 0) / freq).toFixed(2);
  }
  return r;
}

async function runOnce(spec, run) {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required",
    ...(process.env.BOOTBENCH_CHROME_ARGS || "").split(" ").filter(Boolean)] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const result = { dist: spec, run, warm };
  try {
    if (warm) {
      const p0 = await ctx.newPage();
      await boot(p0, spec, false);
      await p0.close();
    }
    const p = await ctx.newPage();
    let pageErr = null;
    p.on("pageerror", (e) => { pageErr = String(e).slice(0, 200); });
    const conMatch = process.env.BOOTBENCH_CONSOLE;
    if (conMatch) p.on("console", (m) => { if (m.text().includes(conMatch)) console.log(`[console] ${m.text().slice(0, +(process.env.BOOTBENCH_CONSOLE_MAX || 300))}`); });
    const { idleAt, samples } = await boot(p, spec, true);
    Object.assign(result, analyse(idleAt, samples));
    if (pageErr) result.pageErr = pageErr;
    if (process.env.BOOTBENCH_SAMPLES) result.samples = samples;
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = String(e.message || e).slice(0, 300);
  }
  await browser.close();
  return result;
}

const results = [];
for (let r = 1; r <= runs; r++) {
  for (const d of dists) {
    const res = await runOnce(d, r);
    results.push(res);
    const show = Object.entries(res).filter(([k]) => !["dist", "run", "samples"].includes(k))
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
    console.log(`[bootbench] ${phoneName} ${d} r${r}: ${show}`);
  }
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : null; };
const summary = {};
for (const d of dists) {
  const ok = results.filter((x) => x.dist === d && x.ok);
  summary[d] = { ok: ok.length, of: runs };
  const keys = [...new Set(ok.flatMap((x) => Object.keys(x)))]
    .filter((k) => typeof ok.find((x) => x[k] != null)?.[k] === "number" && !["run"].includes(k));
  for (const k of keys) summary[d][k] = median(ok.map((x) => x[k]));
  console.log(`BOOTBENCH ${phoneName} ${d} median: ` + Object.entries(summary[d]).map(([k, v]) => `${k}=${v}`).join(" "));
}
writeFileSync(`${outBase}.json`, JSON.stringify({
  phone: phoneName, stamp, warm, flash: path.basename(flash),
  loadavg: readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" "),
  summary, results,
}, null, 1));
console.log(`results: ${outBase}.json`);
