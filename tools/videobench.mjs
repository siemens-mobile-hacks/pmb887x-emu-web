// Video-playback throughput meter — play a clip from the phone's own file
// manager and measure how much of it the engine delivers per wall second.
//
//   PORT=8080 node tools/videobench.mjs [--dist dist-jit] [--warm 4000]
//                                       [--window 12000] [--trace]
//
// The user-visible complaint this exists for: on a phone (Android Chrome,
// ~5x slower per instruction than the desktop this A/Bs on) the SL65's
// video player runs below real time.  None of the existing meters covers
// that workload.  uibench measures an idle/menu steady state, workbench a
// stretch of the boot, j2mebench a Java game — a bytecode interpreter over
// a software framebuffer.  A 3GP clip is none of those: it is a fixed,
// self-paced decode that blits every frame it produces through the display
// path, and it is the only workload here whose *correct* behaviour is
// defined by a deadline.  Measured, it is also the most syscall-dense
// thing this guest does: 2 360 `excSwi` per Mi, one every 424 guest
// instructions.
//
// Why a virtual-time window (the j2mebench argument, and it matters more
// here): under icount the guest is a deterministic function of its
// instruction count, and the player schedules frames on its own clock, so
// a window that opens at a fixed virtual offset from the play press and
// spans a fixed virtual duration decodes *the same frames of the same
// clip* in every leg of every build.  Wall time across it is then host
// speed with none of the guest in it, and `mi` is a determinism check
// rather than a result.  Anchoring on instructions instead would put two
// builds at different points in the clip; anchoring on wall time measures
// the host's mood.
//
// The number: `rt` — virtual seconds of phone delivered per wall second
// while the clip decodes.  1.0 is real time, which is what the shipping
// real-time cap holds a fast host to; the window runs *uncapped*
// (wasm_rtcap_set) so the engine's own ceiling shows instead of the cap.
// `duty` is the guest's own demand over the same window (insns x 8 ns per
// virtual second): what share of a real SL65's CPU the player asks for.
// It measures **1.000** — the player never idles, so there is no warped-
// over idle inflating `rt` and no headroom to spend either.  A phone runs
// roughly 5x slower per guest instruction than this desktop, so its `rt`
// is about this one divided by five: anything under 5 here is under real
// time there, which is the report.  See doc/performance-handoff.md
// § round thirty-nine.
//
// Protocol:
//   - boot --flash ONLINE, wait for the display to go still (firmware-
//     agnostic; an insn-rate threshold is not usable because an uncapped
//     idle guest still retires tens of millions of insns a second).
//   - walk --path (default "center,8,down,center": Menu ▸ My stuff ▸
//     Videos ▸ open) and press --play on the clip at --entry.  Every press
//     is verified by screen change and retried, because this firmware
//     drops presses freely — the first one after boot always.
//   - drop the cap at the play press, let --warm virtual ms of decode go
//     by, then measure --window virtual ms.
//   - the window must have *drawn*: a still picture viewer or a dropped
//     press produces no frames, and that is a failed walk, not a result.
//
// Results: tests/results/video-<ts>-<dist>.json + LCD screenshots.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// index -> name, parsed from wasm-diag.h: the numeric indices are the
// wasm_memstat() ABI and a transcribed list drifts silently.  The 2026-09-22
// review removed both the header and the export; without them the meter
// still reads rt and ms/Mi, it just has no census.
let NAMES = [];
try { ({ NAMES } = await import("./diagnames.mjs")); } catch {}

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = fileURLToPath(new URL(".", import.meta.url));

const dist = opt("dist", "dist-jit");
const stillMax = Number(opt("stillmax", 420));   // give up waiting for the boot
const stillFloor = Number(opt("floor", 60));     // guest seconds before "booted"
const stillN = Number(opt("stilln", 4));         // consecutive quiet grabs
const dismissN = Number(opt("dismiss", 0));      // first-boot dialogs to answer
// Menu ▸ My stuff (key 8) ▸ down to Videos ▸ open the folder.  Keys that
// move a selection rather than a whole screen are matched with a smaller
// change threshold (a highlight bar is a few percent of the panel).
const navPath = opt("path", "center,8,down,center").split(",").filter(Boolean);
const entryIx = Number(opt("entry", 1));         // 1-based clip in the folder
const playKey = opt("play", "center");
// Virtual ms of decode before the window opens, and its length.  Defaults
// sit inside the shipped clip (Berlin.3gp, ~25 virtual s end to end, of
// which the first ~3 are the file being opened): --trace is how they were
// placed and how they should be re-placed for another clip.
const warmV = Number(opt("warm", 4000));
const windowV = Number(opt("window", 12000));
const traceOn = argv.includes("--trace");
const traceCOn = argv.includes("--tracec"); // every counter at every sample
const traceEveryV = Number(opt("traceevery", 1000));  // virtual ms per bin
// --shots N: save the panel every Nth trace bin.  A frame count cannot
// tell a decoding clip from an animated menu; these can.
const shotEvery = Number(opt("shots", 0));
const keyScale = Number(opt("keyscale", 1));
const port = process.env.PORT || "8080";
// The cap has to be ON for the walk (uncapped, an idle guest warps hours
// of its own clock between presses and the screensaver re-arms) and OFF
// for the window, or every leg reads rt = 1.000 and nothing resolves.
const rt = process.env.RT || "budget";
const uncap = opt("uncap", "1") !== "0";
const extraQ = process.env.EXTRA_Q || "";
const devtools = Number(opt("devtools", 0));
const holdS = Number(opt("hold", 0));
const chromeArgs = (process.env.CHROME_ARGS || "").split(/\s+/).filter(Boolean);
const FLASH = opt("flash", here + "../fullflashes/SL65v49lg1_TIM.bin");
const tag = opt("tag", "");
const runs = Number(opt("runs", 1));             // windows per boot (spread)

// The clip is part of the image, so the meter is only as available as the
// image: this one is the page's own SL65 preset, and the repo does not
// carry fullflashes.
if (!existsSync(FLASH)) {
  console.error(`videobench: no fullflash at ${FLASH}\n` +
    "  the default is the page's SL65v49 (TIM) preset, which has Berlin.3gp in My stuff ▸ Videos:\n" +
    "  curl -o fullflashes/SL65v49lg1_TIM.bin \\\n" +
    "    https://git.siepatch.dev/api/v1/repos/siepatch/fullflashes/raw/SL65v49lg1_TIM.bin\n" +
    "  (another image needs its own --path/--entry, and --trace to place --warm/--window)");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const runBase = path.join(here, `../tests/results/video-${stamp}-${dist}${tag ? "-" + tag : ""}`);
let outBase = runBase;

// A run that dies before its own close() leaves a headless browser behind,
// still emulating; PID 1 here is `sleep infinity` and never reaps.  The
// survivor burns a core and lands in this tool's CPU denominator, which is
// drift that looks exactly like a regression.  (j2mebench's argument,
// verbatim — same host, same failure.)
function liveChromePids() {
  const out = [];
  for (const e of readdirSync("/proc")) {
    const c = e.charCodeAt(0);
    if (c < 48 || c > 57) continue;
    let s;
    try { s = readFileSync(`/proc/${e}/stat`, "ascii"); } catch { continue; }
    const rp = s.lastIndexOf(")");
    const f = s.slice(rp + 2).split(" ");
    if (f[0] === "Z") continue;
    if (/chrome|headless/.test(s.slice(s.indexOf("(") + 1, rp))) out.push({ pid: +e, ppid: +f[1] });
  }
  return out;
}
if (process.env.VIDEO_NOREAP !== "1") {
  let reaped = 0;
  for (const { pid, ppid } of liveChromePids()) {
    if (ppid !== 1) continue;                    // a live run owns its own
    try { process.kill(pid, "SIGKILL"); reaped++; } catch {}
  }
  if (reaped) {
    console.log(`[video] reaped ${reaped} orphaned browser process(es)`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const preChrome = new Set(liveChromePids().map((e) => e.pid));
console.log(`[video] host load ${readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" ")}`);

const b = await chromium.launch({ headless: true, args: [...(devtools ? [`--remote-debugging-port=${devtools}`] : []), ...chromeArgs] });
let closing = false;
const closeBrowser = async (code) => {
  if (closing) return;
  closing = true;
  await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
  process.exit(code);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => closeBrowser(130));
process.on("uncaughtException", (e) => { console.error("[video] uncaught", e); closeBrowser(1); });
process.on("unhandledRejection", (e) => { console.error("[video] unhandled", e); closeBrowser(1); });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
let pageErr = null;
p.on("pageerror", (e) => { pageErr = String(e).slice(0, 200); });
let serialExit = false;
const logMatch = opt("log", "");
const conTail = [];
p.on("console", (m) => {
  const t = m.text();
  if (t.includes(">>EXIT<<")) serialExit = true;
  if (!/madvise/.test(t)) {
    conTail.push(`[${m.type()}] ${t.slice(0, 220)}`);
    if (conTail.length > 200) conTail.shift();
  }
  if (logMatch && t.includes(logMatch)) console.log("[guest] " + t.slice(0, 300));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- host CPU accounting (j2mebench's, unchanged) --------------------- */
const TICK = 100;
const loadFile = (n, d) => {
  try { return readFileSync(here + "../tests/.j2me-" + n, "ascii").trim() || d; }
  catch { return d; }
};
const MAXLOAD = Number(opt("maxload", loadFile("maxload", 0)));
const LOADWAIT = Number(opt("loadwait", loadFile("loadwait", 600)));
const LOAD_DEADLINE = Date.now() + LOADWAIT * 1000;
const loadNow = () => {
  try { return +readFileSync("/proc/loadavg", "ascii").split(" ")[0]; } catch { return null; }
};
function hostJiffies() {
  try {
    const f = readFileSync("/proc/stat", "ascii").split("\n", 1)[0].trim().split(/\s+/).slice(1).map(Number);
    return { tot: f.reduce((s, v) => s + v, 0), idle: (f[3] || 0) + (f[4] || 0) };
  } catch { return null; }
}
function chromeTree(root) {
  const kids = new Map(), stray = [];
  for (const e of readdirSync("/proc")) {
    const c = e.charCodeAt(0);
    if (c < 48 || c > 57) continue;
    let s;
    try { s = readFileSync(`/proc/${e}/stat`, "ascii"); } catch { continue; }
    const rp = s.lastIndexOf(")");
    const f = s.slice(rp + 2).split(" ");
    if (f[0] === "Z") continue;
    const ppid = +f[1];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(+e);
    if (!preChrome.has(+e) && /chrome|headless/.test(s.slice(s.indexOf("(") + 1, rp))) stray.push(+e);
  }
  const out = new Set(stray), stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    out.add(pid);
    for (const k of kids.get(pid) || []) stack.push(k);
  }
  return [...out];
}
let cpuPids = [];
function cpuSample() {
  const th = new Map();
  let total = 0;
  for (const pid of cpuPids) {
    let tids;
    try { tids = readdirSync(`/proc/${pid}/task`); } catch { continue; }
    for (const tid of tids) {
      let s;
      try { s = readFileSync(`/proc/${pid}/task/${tid}/stat`, "ascii"); } catch { continue; }
      const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
      const t = (+f[11] + +f[12]) / TICK;
      th.set(pid + ":" + tid, t);
      total += t;
    }
  }
  return { total, th, hj: hostJiffies(), load: loadNow() };
}
function cpuDelta(a, c) {
  let top = 0;
  for (const [k, v] of c.th) top = Math.max(top, v - (a.th.get(k) || 0));
  let hostBusy = null;
  if (a.hj && c.hj && c.hj.tot > a.hj.tot)
    hostBusy = +(1 - (c.hj.idle - a.hj.idle) / (c.hj.tot - a.hj.tot)).toFixed(3);
  return { top: +top.toFixed(2), all: +(c.total - a.total).toFixed(2), hostBusy, load0: a.load };
}

/* --- panel helpers ---------------------------------------------------- */
async function grab() {
  return p.evaluate(() => {
    const c = document.getElementById("lcd");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    return { w: d.width, h: d.height, data: Array.from(d.data) };
  });
}
function diffOf(a, c, y0 = 0, y1 = a.h) {
  if (a.w !== c.w || a.h !== c.h) return 100;
  let diff = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < a.w; x++) {
    const i = (y * a.w + x) * 4;
    n++;
    if (Math.abs(a.data[i] - c.data[i]) > 48 || Math.abs(a.data[i + 1] - c.data[i + 1]) > 48 ||
        Math.abs(a.data[i + 2] - c.data[i + 2]) > 48) diff++;
  }
  return n ? (100 * diff) / n : 100;
}
// A real press has a duration: Playwright's click() is a pointerdown and a
// pointerup in the same tick, which this firmware drops.
async function key(k, holdMs = 140, waitMs = 600) {
  await p.evaluate(async ([sel, ms]) => {
    const btn = document.querySelector(`[data-key="${sel}"]`);
    if (!btn) throw new Error("no such key: " + sel);
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r, ms));
    btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }, [k, holdMs]);
  await sleep(waitMs * keyScale);
}
// A moved selection is a few percent of the panel, an opened screen is
// most of it; asking 4 % of a "down" would retry a press that landed.
const MOVE_KEYS = new Set(["up", "down", "left", "right"]);
const minPctFor = (k) => (MOVE_KEYS.has(k) ? 1 : 4);
async function keyUntilChange(k, waitMs, minPct = minPctFor(k), tries = 3) {
  let before = await grab();
  for (let i = 0; i < tries; i++) {
    await key(k, 140, waitMs);
    const after = await grab();
    if (diffOf(before, after) >= minPct) return true;
    console.log(`[video] "${k}" did not move the screen (try ${i + 1})`);
    before = after;
  }
  return false;
}
async function snap() {
  return p.evaluate((n) => {
    const m = window.__qemu;
    const c = []; if (m._wasm_memstat) for (let i = 0; i < n; i++) c.push(Number(m._wasm_memstat(i)));
    return { t: performance.now(), v: Number(m._wasm_vclock()), insns: Number(m._wasm_insns()),
      tbs: m._wasm_tbs ? Number(m._wasm_tbs()) : 0, fb: Number(m._wasm_fb_updates()), c };
  }, NAMES.length);
}
async function shoot(what) {
  try { const lcd = await p.$("#lcd"); await lcd.screenshot({ path: `${outBase}-${what}.png` }); } catch {}
}
const fail = async (why) => {
  console.log("VIDEO FAIL " + why + (pageErr ? " pageerror=" + pageErr : "") + (serialExit ? " serial=EXIT" : ""));
  try {
    const tail = await p.evaluate(() => (window.__qemutail || []).slice(-25));
    if (tail.length) console.log("VIDEO FAIL log tail:\n  " + tail.join("\n  "));
  } catch {}
  try {
    const sub = await p.evaluate(() => {
      const e = document.getElementById("ov-sub");
      return e ? e.textContent : "";
    });
    if (sub) console.log("VIDEO FAIL overlay: " + sub);
  } catch {}
  if (conTail.length) console.log("VIDEO FAIL console tail:\n  " + conTail.slice(-30).join("\n  "));
  // frozen or merely slow?  Two samples a second apart tell a stopped
  // guest from one the cap is pacing.
  try {
    const rd = () => p.evaluate(() => {
      const m = window.__qemu;
      return m ? [Number(m._wasm_insns()), Number(m._wasm_vclock())] : null;
    });
    const s0 = await rd();
    await new Promise((r) => setTimeout(r, 1000));
    const s1 = await rd();
    if (s0 && s1) console.log(`VIDEO FAIL still-moving: dInsns=${s1[0] - s0[0]} dVirtMs=${((s1[1] - s0[1]) / 1e6).toFixed(1)}`);
  } catch {}
  await shoot("fail");
  await b.close();
  process.exit(1);
};
const stalledOut = async () => {
  try {
    return await p.evaluate(() => {
      const ov = document.getElementById("lcd-overlay");
      return !!ov && !ov.classList.contains("hidden") &&
        document.getElementById("ov-msg").textContent === "Guest stopped";
    });
  } catch { return false; }
};
const bail = async (why) => {
  if (serialExit || pageErr) await fail(why + ": " + (pageErr || "guest EXIT"));
  if (await stalledOut()) await fail(why + ": guest stalled");
};

// The page asks for a CPU sample at the window's own two ends, so sample
// and counter snapshot are taken at the same guest moment rather than a
// CDP round trip apart.
const cpuSamples = [];
await p.exposeFunction("__hostcpu", () => { cpuSamples.push(cpuSample()); return cpuSamples.length - 1; });

const q = [`dist=${dist}`, `rt=${rt}`, ...(extraQ ? [extraQ] : [])].join("&");
await p.goto(`http://127.0.0.1:${port}/?${q}`, { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", FLASH);
const t0 = Date.now();
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });

// 1. booted = the display stopped moving, with a floor counted in the
//    *guest's* seconds (the cap is on, so a starved guest is not called
//    booted early and then fed keys it swallows).
const vSec = async () => {
  try { return await p.evaluate(() => Number(window.__qemu._wasm_vclock()) / 1e9); }
  catch { return 0; }
};
const v0 = await vSec();
let tBoot = null, still = 0, vBoot = 0, prev = await grab();
while (tBoot === null && (Date.now() - t0) / 1000 < stillMax) {
  await sleep(1000);
  await bail("boot");
  const now = await grab();
  still = diffOf(prev, now) < 2 ? still + 1 : 0;
  prev = now;
  const v = (await vSec()) - v0;
  if (v >= stillFloor && still >= stillN) { tBoot = (Date.now() - t0) / 1000 - stillN; vBoot = v; break; }
}
if (tBoot === null) await fail(`display never went still within ${stillMax}s (guest reached ${((await vSec()) - v0).toFixed(0)}s of ${stillFloor}s)`);
console.log(`[video] booted at ~${tBoot.toFixed(0)}s wall / ${vBoot.toFixed(0)}s guest`);
await shoot("boot");

for (let i = 0; i < dismissN; i++) { await key("right_soft", 140, 2500); await bail("dialogs"); }
for (let i = 0; i < 2; i++) await key("end", 140, 1800);
await sleep(1500);
const idle = await grab();
await shoot("idle");

const rtcap = (on) => p.evaluate((v) => {
  const m = window.__qemu;
  if (!m._wasm_rtcap_set) return false;
  m._wasm_rtcap_set(v);
  return true;
}, on ? 1 : 0);

// 2. the play press and the window that follows it, both scheduled on the
//    guest's own clock and both run inside the page: a virtual milestone
//    resolved over a CDP round trip would be as wall-dependent as the
//    thing it replaces.  Unlike a game, nothing is pressed while the clip
//    runs — the player is its own source of work.
const playWindow = (playKey, warmV, windowV, nCounters, traceC) =>
  p.evaluate(async ([playKey, warmV, windowV, n, wallCapS, shotEvery, traceC, traceEveryV]) => {
  const m = window.__qemu;
  const vns = () => Number(m._wasm_vclock());
  const shot = () => {
    const c = []; if (m._wasm_memstat) for (let i = 0; i < n; i++) c.push(Number(m._wasm_memstat(i)));
    // tools/perf/bench-hooks.patch census slots, after the memstat ones
    if (m._wasm_bench_ctr_get) for (let i = 0; i < 8; i++) c.push(Number(m._wasm_bench_ctr_get(i)));
    return { t: performance.now(), v: vns(), insns: Number(m._wasm_insns()),
      tbs: m._wasm_tbs ? Number(m._wasm_tbs()) : 0, fb: Number(m._wasm_fb_updates()), c };
  };
  const t0 = performance.now();
  const trace = [], shots = [], traceCs = [];
  const yieldOnce = () => new Promise((r) => setTimeout(r, 0));
  const btn = document.querySelector(`[data-key="${playKey}"]`);
  // The anchor is the press itself: v0 is read between down and up, so
  // every leg's window opens the same virtual distance into the clip.
  btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  const v0 = vns();
  let nextTrace = v0;
  const startAt = v0 + warmV * 1e6;
  const endAt = startAt + windowV * 1e6;
  let a = null, c = null, stalled = false, up = false;
  while (true) {
    const v = vns();
    if (!up && v >= v0 + 140e6) { btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); up = true; }
    if (v >= nextTrace) {
      nextTrace = v + traceEveryV * 1e6;
      trace.push([Math.round((v - v0) / 1e6), Number(m._wasm_fb_updates()),
        Math.round(Number(m._wasm_insns()) / 1e6)]);
      if (traceC) { const s = shot(); traceCs.push([v - v0, s.insns, s.fb, s.c]); }
      if (shotEvery && (trace.length - 1) % shotEvery === 0)
        shots.push([trace[trace.length - 1][0], document.getElementById("lcd").toDataURL("image/png")]);
    }
    if (!a && v >= startAt) { a = shot(); if (m._wasm_hc_mark) m._wasm_hc_mark(0); a.cpuIx = await window.__hostcpu(); }
    if (v >= endAt) { c = shot(); if (m._wasm_hc_mark) m._wasm_hc_mark(1); c.cpuIx = await window.__hostcpu(); break; }
    // a guest that has stopped advancing its clock never reaches any
    // milestone; without this the page would poll forever
    if (performance.now() - t0 > wallCapS * 1000) { stalled = true; break; }
    await yieldOnce();
  }
  if (!up) btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  return { a, c, stalled, trace, shots, traceCs };
}, [playKey, warmV, windowV, nCounters, 600, shotEvery, traceC, traceEveryV]);

const results = [];
for (let run = 0; run < runs; run++) {
outBase = runs > 1 ? `${runBase}-r${run + 1}` : runBase;

// 3. the walk to a playing clip and its window, retried as one unit: the
//    drawing check belongs to the window, because a dropped press lands
//    in a picture viewer or a menu, both of which look fine on a
//    screenshot and produce no frames.
let a = null, c = null, trace = null, traceCs = null;
for (let attempt = 1; attempt <= 3 && !c; attempt++) {
  let ok = true;
  for (const k of navPath) {
    if (!(await keyUntilChange(k, 2500))) { ok = false; break; }
    await bail("walk");
  }
  if (ok) {
    for (let i = 1; i < entryIx; i++) await key("down", 140, 700);
    await shoot("entry");
    if (MAXLOAD > 0) {
      let l = loadNow();
      while (l > MAXLOAD && Date.now() < LOAD_DEADLINE) {
        console.log(`[video] waiting for a quiet host: load ${l} > ${MAXLOAD} ` +
          `(${Math.round((LOAD_DEADLINE - Date.now()) / 1000)}s of budget left)`);
        await sleep(15000);
        l = loadNow();
      }
      console.log(l > MAXLOAD
        ? `[video] host never fell to ${MAXLOAD} within the ${LOADWAIT}s budget (load ${l}) -- measuring anyway`
        : `[video] host quiet at load ${l}`);
    }
    // Uncap immediately before the press, never earlier: an uncapped
    // guest warps its own clock while this tool decides anything, and the
    // window is anchored on the press.
    if (uncap && !(await rtcap(false)))
      await fail("this build has no wasm_rtcap_set — rebuild, or pass --uncap 0");
    cpuPids = chromeTree(process.pid);
    const w = await playWindow(playKey, warmV, windowV, NAMES.length, traceCOn);
    if (w.stalled) console.log(`[video] attempt ${attempt}: the guest's virtual clock stopped`);
    for (const [v, url] of w.shots || [])
      writeFileSync(`${outBase}-v${String(Math.round(v / 1000)).padStart(3, "0")}.png`,
        Buffer.from(url.split(",")[1], "base64"));
    if (w.a && w.c) {
      const fps = (w.c.fb - w.a.fb) / ((w.c.v - w.a.v) / 1e9);
      // A decoding clip blits every frame it produces (~13 fps of the
      // guest's own time).  Under 6 is a still viewer, a menu (the main
      // menu's animation draws 2-3), or a clip that ended before the
      // window did — none of them a measurement.
      if (fps >= 6) { a = w.a; c = w.c; trace = w.trace; traceCs = w.traceCs || null; }
      else console.log(`[video] attempt ${attempt}: window drew ${fps.toFixed(1)} fps of guest time — not a playing clip`);
    }
  }
  await bail("play");
  if (c) break;
  console.log(`[video] attempt ${attempt}: backing out and retrying`);
  if (uncap) await rtcap(true);
  await sleep(15000);
  for (let i = 0; i < 5; i++) await key("end", 140, 1500);
  await sleep(2000);
  if (diffOf(idle, await grab()) > 12) await key("end", 600, 2500);   // long red: force idle
}
if (!c) await fail(`could not play entry ${entryIx}`);

const d = {}; for (const k in a) if (k !== "c" && k !== "cpuIx") d[k] = c[k] - a[k];
const wall = d.t / 1000;
const vWin = d.v / 1e9;
const hostCpu = a.cpuIx != null && c.cpuIx != null
  ? cpuDelta(cpuSamples[a.cpuIx], cpuSamples[c.cpuIx]) : { top: 0, all: 0 };
const counters = {}, perMi = {};
const CNAMES = [...NAMES, ...Array.from({ length: 8 }, (_, i) => "bench" + i)];
for (let i = 0; i < c.c.length; i++) {
  const dv = (c.c[i] ?? 0) - (a.c[i] ?? 0);
  if (!dv) continue;
  counters[CNAMES[i]] = dv;
  perMi[CNAMES[i]] = +(dv / (d.insns / 1e6)).toFixed(3);
}
const g = (n) => counters[n] || 0;
const rec = {
  tool: "videobench", dist, rt, uncap, stamp, tag, flash: path.basename(FLASH),
  entry: entryIx, path: navPath.join(","), tBoot: +tBoot.toFixed(1), warmV, windowV,
  wall: +wall.toFixed(2),
  vWin: +vWin.toFixed(3),
  // THE number: virtual seconds of phone per wall second while the clip
  // decodes.  1.0 is real time on a real SL65; below it the clip stutters
  // and the audio breaks up, which is the report this meter exists for.
  rt: +(vWin / wall).toFixed(3),
  // What the clip asks of the phone it thinks it is running on: guest
  // insns x 8 ns (icount shift=3) over the virtual time they span.  1.0 is
  // a saturated SL65 — a clip at duty 0.9 has almost no headroom, so
  // delivering it needs rt near 1/0.9 of the engine, not 1.0.
  duty: +((d.insns * 8) / (d.v || 1)).toFixed(3),
  // Frames per second of *guest* time (what the phone would show) and per
  // wall second (what the viewer actually sees here).
  fpsGuest: +(d.fb / vWin).toFixed(2),
  fps: +(d.fb / wall).toFixed(2),
  mips: +(d.insns / 1e6 / wall).toFixed(2),
  cpu: +(d.insns / 1e6 / wall / 125).toFixed(3),
  // The partly load-robust A/B number: host CPU seconds the vCPU thread
  // burned for a fixed span of guest work.  See j2mebench's header for
  // what it does and does not remove (residual load exponent -0.29).
  hostCpuS: hostCpu.top,
  hostAllS: hostCpu.all,
  hostLoad: +readFileSync("/proc/loadavg", "ascii").split(" ")[0],
  hostPids: cpuPids.length,
  hostBusy: hostCpu.hostBusy,
  hostLoad0: hostCpu.load0,
  mipsCpu: hostCpu.top ? +(d.insns / 1e6 / hostCpu.top).toFixed(2) : null,
  busy: hostCpu.top ? +(hostCpu.top / wall).toFixed(3) : null,
  msPerMi: +((wall * 1000) / (d.insns / 1e6)).toFixed(3),
  insnsPerFrame: Math.round(d.insns / (d.fb || 1)),
  insnsPerTb: d.tbs ? +(d.insns / d.tbs).toFixed(2) : null,
  haltsPerS: Math.round(g("halt") / wall),
  // The determinism check: the window is a fixed span of the guest's own
  // clock, so under icount the instructions in it are a property of the
  // guest alone.  Legs whose mi disagrees by more than a fraction of a
  // percent decoded different frames and are not comparable.
  mi: +(d.insns / 1e6).toFixed(1),
  counters, perMi, trace, traceCs,
  loadavg: readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" "),
  extraQ,
};
await shoot("end");
writeFileSync(`${outBase}.json`, JSON.stringify(rec, null, 1));
console.log(`VIDEO ${dist} rt=${rec.rt} duty=${rec.duty} fps=${rec.fps} fpsGuest=${rec.fpsGuest} ` +
  `MIPS=${rec.mips} MIPS/cpu=${rec.mipsCpu} cpu=${rec.cpu} busy=${rec.busy} ` +
  `hostBusy=${rec.hostBusy} load=${rec.hostLoad0}->${rec.hostLoad} ms/Mi=${rec.msPerMi} ` +
  `insns/frame=${rec.insnsPerFrame} Mi=${rec.mi} vWin=${rec.vWin} ` +
  // the warm-up check: a window still translating is measuring the
  // translator, not the decoder
  `tbGen/Mi=${perMi.tbGen ?? 0} halts/s=${rec.haltsPerS} wall=${rec.wall} load=${rec.loadavg}`);
console.log("perMi: " + Object.entries(perMi).filter(([, v]) => v >= 0.01)
  .sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(" "));
if (traceOn && trace && trace.length) {
  // The first sample is the anchor, not a bin: its counters are absolute
  // (a boot's worth of frames and instructions) and differencing from zero
  // prints that total as if it happened in one second.
  let [, pf, pi] = trace[0];
  console.log(`[video] trace (virtual s : frames/Mi in the ${traceEveryV} ms before it) ` +
    trace.slice(1).map(([v, f, i]) => {
      const r = `${(v / 1000).toFixed(0)}s:${f - pf}f/${i - pi}Mi`; pf = f; pi = i; return r;
    }).join(" "));
}
console.log(`results: ${outBase}.json (+ -entry.png/-end.png)`);
results.push(rec);

// back to idle for the next window: the cap goes back on first, because
// the walk is wall-scheduled and an uncapped guest warps far enough
// between presses to re-arm the screensaver.
if (run !== runs - 1) {
  if (uncap) await rtcap(true);
  for (let i = 0; i < 6; i++) await key("end", 140, 1600);
  await sleep(2000);
  if (diffOf(idle, await grab()) > 12) { await key("end", 600, 3000); await sleep(2000); }
}
}
if (results.length > 1) {
  writeFileSync(`${runBase}-sweep.json`, JSON.stringify(results, null, 1));
  const rts = results.map((r) => r.rt);
  const spread = (Math.max(...rts) / Math.min(...rts) - 1) * 100;
  console.log(`VIDEO sweep ${dist}: ` + results.map((r, i) => `r${i + 1}: rt=${r.rt} MIPS/cpu=${r.mipsCpu} Mi=${r.mi}`).join("  ") +
    `  spread=${spread.toFixed(1)}%  ${runBase}-sweep.json`);
}
// The hold keeps the clip *playing* — a profile of a finished clip is a
// profile of an idle guest, which is not the state this tool measures.
// The clip is finite (~26 virtual s) and a profile is longer than that, so
// the hold restarts it: when the frame counter stops moving the player has
// reached the end and is sitting on "Play", where the same key starts it
// again.
if (holdS) {
  console.log(`[video] PLAYHOLD ${holdS}s (devtools ${devtools || "off"}) — attach now`);
  await p.evaluate(async ([playKey, secs]) => {
    const m = window.__qemu;
    const btn = document.querySelector(`[data-key="${playKey}"]`);
    const t0 = performance.now();
    let lastFb = Number(m._wasm_fb_updates()), lastMove = t0;
    while (performance.now() - t0 < secs * 1000) {
      await new Promise((r) => setTimeout(r, 300));
      const fb = Number(m._wasm_fb_updates());
      if (fb !== lastFb) { lastFb = fb; lastMove = performance.now(); continue; }
      if (performance.now() - lastMove < 1500) continue;
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 140));
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      lastMove = performance.now();
    }
  }, [playKey, holdS]);
}
await b.close();
