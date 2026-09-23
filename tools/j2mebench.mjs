// J2ME game throughput meter — launch a Java game and play it.
//
//   PORT=8080 node tools/j2mebench.mjs [--dist dist-jit] [--game 1,2,3]
//                                      [--warm 25000] [--window 45000]
//
// tools/stopwatch.mjs measures the S75's *native* stopwatch app and
// tools/uibench.mjs a board's idle/menu steady state.  Neither runs Java:
// the J2ME VM is a different workload — a bytecode interpreter over a
// software framebuffer whose frame loop sleeps on a guest timer — and
// § Open items 7 of doc/performance-handoff.md has wanted a meter for it
// since round nine.  This is that meter.
//
// Nothing here is specific to one firmware or one game.  The walk is
// driven by *screen change*, not by reference images: press, wait, and
// require the LCD to have moved, retrying the press when it has not.  The
// only assertion about content is the one that matters — at the end the
// game must be *drawing*, which a menu is not.
//
// Protocol (deterministic; it is an A/B meter):
//   - boot --flash ONLINE and wait for the display to go still (three
//     consecutive 1 s grabs that differ by under 2 %) — firmware-agnostic,
//     and unlike an instruction-rate threshold it is not fooled by rt=off,
//     where an idle guest still executes tens of millions of insns a second.
//   - clear whatever the image comes up in: --dismiss right soft presses
//     (this CX70 image asks "Copy all entries to addressbook?" and then
//     "Press joystick down ...", and only the right soft key answers them)
//     followed by two red keys, which return to idle from anywhere.
//   - walk --path (default "center,3,1": Menu ▸ Surf & fun ▸ Games), open
//     folder --folder if the list has folders, scroll to entry --game and
//     launch it.  --game takes a comma list and plays each in turn
//     within the same boot.
//   - from the launch on, drop the cap and schedule everything on the
//     guest's own virtual clock: --start taps past the splash, --warm
//     virtual ms settle, then a --window virtual-ms measured window with
//     the --play key pattern on repeat.  A J2ME game only draws when
//     something moves, so a meter that presses nothing measures the pause
//     screen; and the schedule is in *virtual time* so that every leg
//     plays the same frames of the same level (see step 4).  --window 0
//     falls back to --measure wall seconds.
//   - report cpu (MIPS/125: what fraction of a stock CX70's CPU this
//     build can sustain, and the number that decides whether a game
//     stutters -- v/wall counts warped-over idle as delivered time and
//     so reads 5.0 on a build that runs the busy stretches at 0.78),
//     v/wall, fps, MIPS, the guest's own duty cycle (insns x 8 ns against
//     the virtual time that passed: what share of a real phone's CPU the
//     game is asking for), Mi as the determinism check, and the counters.
//   - report MIPS/cpu as well: guest instructions per second of host CPU
//     the vCPU thread actually burned, read from /proc at the window's own
//     two ends.  Wall time on a busy host measures the host -- the same
//     build reads 12.2 and 15.3 ms/Mi when other tenants take the cores --
//     and MIPS/cpu removes the part of that which is the thread merely
//     being descheduled.  It does NOT remove the rest, and the rest is
//     most of it: fitted within identical configurations over 64 legs,
//     log(MIPS/cpu) on log(1-minute load) has slope -0.29, r -0.73, so a
//     load range of 4 to 42 moves this number by 1.96x on its own.  CPU
//     time divides out how many seconds the host gave the vCPU; it cannot
//     divide out how much work a second contains, and under SMT and
//     memory-bandwidth contention that is what varies.  Two legs of one
//     unchanged build read 82.25 and 144.35 with every guest-side counter
//     equal to 0.4 %.  So: hostBusy and hostLoad are recorded as
//     covariates, tools/perf/verdict.py corrects by the fitted exponent
//     and marks a verdict LOAD-SKEWED when its arms sat at different load,
//     and --maxload waits for a quiet host before opening the window.
//     busy = those seconds over wall: 1.0 is a quiet host, and a low busy
//     with a steady MIPS/cpu is exactly the case where MIPS lies.
//
// RT=off by default like uibench/idlebench: engine speed, not the shipping
// real-time cap's pacing.  RT=banked for what a user sees.
//
// --devtools <port> + --hold <s> keep the played game on screen for
// tools/wprof2.mjs PROF_ATTACH=<port>, which is the only way to profile a
// state that takes keypad navigation to reach.
//
// Results: tests/results/j2me-<ts>-<dist>.json + LCD screenshots.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// index -> name, parsed from wasm-diag.h: the numeric indices are the
// wasm_memstat() ABI and a transcribed list drifts silently
import { NAMES } from "./diagnames.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = fileURLToPath(new URL(".", import.meta.url));

const dist = opt("dist", "dist-jit");
const measureS = Number(opt("measure", 20));
const stillMax = Number(opt("stillmax", 420));   // give up waiting for the boot
const stillFloor = Number(opt("floor", 70));     // never call it booted before this
const stillN = Number(opt("stilln", 5));         // consecutive quiet grabs
const dismissN = Number(opt("dismiss", 3));      // first-boot dialogs to answer
const navPath = opt("path", "center,3,1").split(",").filter(Boolean);
const folderIx = Number(opt("folder", 1));       // 0 = the list has no folders
// 1-based entries in the game list.  A comma list plays them one after
// another within the same boot, which is the only affordable way to cover
// an image's whole catalogue: the boot is 70-150 s and a window is 10, so
// four games in four boots would spend nine tenths of the run booting the
// same phone four times.
const gameList = opt("game", "1").split(",").filter(Boolean).map(Number);
// Everything from the launch press onward is scheduled on the guest's own
// virtual clock, in virtual milliseconds: taps to get past the splash,
// then a settle, then the measured window with its key pattern on repeat.
const startSpec = opt("start", "center:9000,center:4000,center:4000");
const playSpec = opt("play", "6:1200,2:300");    // key:holdMs[,...] on repeat
const traceOn = argv.includes("--trace");
// --tracec: snapshot every counter at every trace sample, not just at the
// two window ends.  A J2ME game is not one workload: g1 spends 27 of 32
// bins at duty 0.15 and five at duty 1.0, so the window-wide perMi rollup
// is an average over phases that behave nothing alike, and it describes
// the idle one because that is where the instructions are not.  Per-bin
// counters let the saturated bins be profiled on their own.
const traceCOn = argv.includes("--tracec");
// --shots N: save the panel every Nth trace sample (every 2N virtual s).
// Frame counts cannot tell an animated title screen from play; these can.
const shotEvery = Number(opt("shots", 0));
// Virtual ms after the last --start tap before the window opens, and how
// long it stays open.  --trace --shots 4 is how these were placed, and
// they are the one thing here that is specific to a game: on Atomic
// Skater the first level is loaded and drawing by 16 virtual s, the
// second level transition lands at 44-55 s, and the run stays
// reproducible to ~0.7 % of guest work until ~65 s, after which small
// divergences compound into the player dying at a different time.  So
// the window is 20-65 s: steady play, one level transition, and nothing
// past the horizon where two runs stop agreeing.
const warmV = Number(opt("warm", 3000));
const windowV = Number(opt("window", 45000));    // 0 = wall-clock --measure instead
const keyScale = Number(opt("keyscale", 1));     // multiply every key wait (slow builds)
const port = process.env.PORT || "8080";
// The cap has to be ON while the menus are walked: uncapped, an idle guest
// warps hours of its own clock per wall minute and the phone's screensaver
// re-arms between key presses, which is what a first attempt at this meter
// spent three retries discovering.  It then has to be OFF to read engine
// throughput, or every leg reads v/wall = 1.000 and nothing resolves.  So
// the shipped cap boots and navigates, and --uncap drops it for the play
// window (wasm_rtcap_set, a measurement-only export).
const rt = process.env.RT || "budget";
const uncap = opt("uncap", "1") !== "0";
const extraQ = process.env.EXTRA_Q || "";
const devtools = Number(opt("devtools", 0));
const holdS = Number(opt("hold", 0));
const chromeArgs = (process.env.CHROME_ARGS || "").split(/\s+/).filter(Boolean);
const FLASH = opt("flash", here + "../fullflashes/CX70_games.bin");
const tag = opt("tag", "");

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const runBase = path.join(here, `../tests/results/j2me-${stamp}-${dist}${tag ? "-" + tag : ""}`);
// the per-game results of a sweep sit next to each other under the run's
// own stamp; a single game keeps the plain name it has always had
let outBase = runBase;

// A run that dies without reaching its own close() -- a timeout, a Ctrl-C,
// an OOM kill -- leaves its headless browser behind, still emulating, and
// PID 1 here is `sleep infinity`, which never reaps.  Two costs follow.
// The survivor burns a core of its own for as long as the host is up; and
// it lands in *this* tool's CPU denominator, because chromeTree() has to
// take every chrome process on the host (zygote children reparent away
// from us) and cannot tell one run's browser from another's.  A session
// that leaks one browser per leg therefore measures each leg on a dirtier
// host than the last, which is drift that looks exactly like a
// regression.  So: kill the orphans first, then remember what survived,
// so the denominator can exclude anything that was already running.
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
if (process.env.J2ME_NOREAP !== "1") {
  let reaped = 0;
  for (const { pid, ppid } of liveChromePids()) {
    if (ppid !== 1) continue;                   // a live run owns its own
    try { process.kill(pid, "SIGKILL"); reaped++; } catch {}
  }
  if (reaped) {
    console.log(`[j2me] reaped ${reaped} orphaned browser process(es)`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const preChrome = new Set(liveChromePids().map((e) => e.pid));
console.log(`[j2me] host load ${readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" ")}`);

const b = await chromium.launch({ headless: true, args: [...(devtools ? [`--remote-debugging-port=${devtools}`] : []), ...chromeArgs] });
// close() on the way out of *every* exit that can still run code, so this
// process stops being the thing that creates the orphans above
let closing = false;
const closeBrowser = async (code) => {
  if (closing) return;
  closing = true;
  await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
  process.exit(code);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => closeBrowser(130));
process.on("uncaughtException", (e) => { console.error("[j2me] uncaught", e); closeBrowser(1); });
process.on("unhandledRejection", (e) => { console.error("[j2me] unhandled", e); closeBrowser(1); });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
let pageErr = null;
p.on("pageerror", (e) => { pageErr = String(e).slice(0, 200); });
let serialExit = false;
// --log <substring>: echo matching guest/console lines.  The emulator's
// own diagnostics (stderr in the vCPU worker) reach the page console, and
// a device question like "which branch does this DMA take" has no counter
// that can answer it.
const logMatch = opt("log", "");
// A "Guest stopped" overlay is the page's watchdog, not a guest panic: it
// fires when insns, halts and fb have all been frozen for 15 s, which a
// wasm trap, an emulator abort and a cap that slept too long all look like
// from the outside.  __qemutail carries only the guest's own output, so a
// stop with nothing in it says nothing at all -- the emulator's stderr and
// any trap reach the *page* console instead, and that is what tells the
// three apart.
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

// --- host CPU accounting ------------------------------------------------
// The window is a fixed span of the guest's virtual clock, so the work it
// contains is fixed.  What varies between legs on a shared host is how
// much wall time that work took, and most of that variance is the host,
// not the build.  CPU time is the honest denominator: sum utime+stime per
// *thread* across the browser's process tree at the window's two ends, and
// the busiest single thread is the vCPU.  (Per thread, not per process:
// the renderer's main thread runs this tool's own polling loop.)
const TICK = 100;
// The measurement window is 6-11 s of wall; the 1-minute load average is
// smoothed over 60 s, so it mostly describes seconds this window did not
// contain.  /proc/stat's all-CPU line differenced across the window's two
// ends is the occupancy of the window itself.
// The file default exists so the threshold can be turned on for a battery
// that is already running: every leg execs this file afresh, but the shell
// drivers above it were launched with their environment already fixed, and
// editing a script bash is currently reading corrupts it mid-leg.
const loadFile = (n, d) => {
  try { return readFileSync(here + "../tests/.j2me-" + n, "ascii").trim() || d; }
  catch { return d; }
};
const MAXLOAD = Number(opt("maxload", loadFile("maxload", 0)));
// One budget for the whole process, not one per window: the wait sits
// inside the three-attempt walk loop and a sweep runs one window per
// --game, so a per-wait budget would let three attempts across two games
// spend six times this and walk straight through ab4.sh's 1800 s leg
// timeout, which drops the leg -- the thing the wait exists to avoid.
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
    if (f[0] === "Z") continue;                 // reaped time is not ours
    const ppid = +f[1];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(+e);
    // chromium's zygote children can end up reparented away from us, so a
    // chrome process outside our subtree still has to be taken -- but only
    // if it was not already running when we launched, or the denominator
    // picks up whatever some earlier run left behind
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
// The set is resolved once, before the window: the /proc walk has to step
// over this host's thousands of zombies, and inside the window only these
// pids' task/ directories are read.
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

async function grab() {
  return p.evaluate(() => {
    const c = document.getElementById("lcd");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    return { w: d.width, h: d.height, data: Array.from(d.data) };
  });
}
// % of pixels differing by more than 48 in any channel, over rows [y0, y1)
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
// pointerup in the same tick, which the firmware drops and a J2ME game
// never sees as movement at all.
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
// press until the screen moves: a dropped press is the normal case here
async function keyUntilChange(k, waitMs, minPct = 4, tries = 3) {
  let before = await grab();
  for (let i = 0; i < tries; i++) {
    await key(k, 140, waitMs);
    const after = await grab();
    if (diffOf(before, after) >= minPct) return true;
    console.log(`[j2me] "${k}" did not move the screen (try ${i + 1})`);
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
  console.log("J2ME FAIL " + why + (pageErr ? " pageerror=" + pageErr : "") + (serialExit ? " serial=EXIT" : ""));
  // the guest's own last words.  A failed walk is usually a stalled guest,
  // and the screenshot only says "Guest stopped" -- this says what it was
  // doing when it stopped, which is the difference between a flaky meter
  // and a bug report
  try {
    const tail = await p.evaluate(() => (window.__qemutail || []).slice(-25));
    if (tail.length) console.log("J2ME FAIL log tail:\n  " + tail.join("\n  "));
  } catch {}
  // The page already worked out why it stopped -- stallReason() names the
  // fatal, which for a vCPU worker is the only place it appears at all --
  // and put it in the overlay's subtitle.  Reading only ov-msg threw that
  // away and left every stop looking identical.
  try {
    const sub = await p.evaluate(() => {
      const e = document.getElementById("ov-sub");
      return e ? e.textContent : "";
    });
    if (sub) console.log("J2ME FAIL overlay: " + sub);
  } catch {}
  if (conTail.length) {
    console.log("J2ME FAIL console tail:\n  " + conTail.slice(-30).join("\n  "));
  }
  // Is it frozen, or merely slow?  Two samples a second apart separate a
  // guest that has stopped from one the cap is pacing.
  try {
    const rd = () => p.evaluate(() => {
      const m = window.__qemu;
      return m ? [Number(m._wasm_insns()), Number(m._wasm_vclock())] : null;
    });
    const s0 = await rd();
    await new Promise((r) => setTimeout(r, 1000));
    const s1 = await rd();
    if (s0 && s1) {
      console.log(`J2ME FAIL still-moving: dInsns=${s1[0] - s0[0]} dVirtMs=` +
        `${((s1[1] - s0[1]) / 1e6).toFixed(1)}`);
    }
  } catch {}
  // A quiet vCPU is not the same thing as a stopped one.  The real-time
  // cap sleeps the guest on purpose, and the page's watchdog cannot see
  // the difference, so read the cap's own counters before blaming a bug:
  // rtcapWaitMax in the seconds is the cap pacing, not a freeze.
  try {
    const c = await p.evaluate((n) => {
      const m = window.__qemu; if (!m || !m._wasm_memstat) return null;
      const o = []; for (let i = 0; i < n; i++) o.push(Number(m._wasm_memstat(i)));
      return o;
    }, NAMES.length);
    if (c) {
      const g = (k) => c[NAMES.indexOf(k)] || 0;
      console.log(`J2ME FAIL rtcap: waits=${g("rtcapWait")} waitS=${(g("rtcapWaitNs") / 1e9).toFixed(1)}` +
        ` waitMaxS=${(g("rtcapWaitMax") / 1e9).toFixed(1)} throts=${g("rtcapThrot")}` +
        ` throtS=${(g("rtcapThrotNs") / 1e9).toFixed(1)} halt=${g("halt")}`);
    }
  } catch {}
  await shoot("fail");
  await b.close();
  process.exit(1);
};
// A stalled guest is not a dropped key press: retrying the walk against one
// burns three minutes to arrive at the same overlay.  The page's own
// watchdog has already decided (15 s of frozen insns, halts and fb), so ask
// it rather than re-deriving the judgement here.
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

// The page asks for a CPU sample at the window's own two ends, so the
// sample and the counter snapshot are taken at the same guest moment
// rather than a CDP round trip apart.
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

// 1. boot done = the display stopped moving.  An insn-rate threshold is
//    not usable here: under rt=off an idle guest warps its clock and still
//    retires tens of millions of instructions a second.
//
//    The floor underneath that is counted in the *guest's* seconds, not the
//    host's.  The cap is on for the walk, so a guest that keeps up advances
//    its clock with the wall and a starved one does not: measuring the floor
//    in wall seconds meant that on a loaded host "booted" was called while
//    the firmware was still coming up, and the walk then fed keys to
//    something that swallowed them -- three attempts, then a dropped leg,
//    which is worse than a slow one because it leaves the A/B unbalanced.
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
console.log(`[j2me] booted at ~${tBoot.toFixed(0)}s wall / ${vBoot.toFixed(0)}s guest`);
await shoot("boot");

// 2. whatever the image came up in, get to idle.  The right soft key is
//    what answers this image's first-boot dialogs (center answers
//    neither); a surplus press lands in some menu, and the red key backs
//    out of any menu to idle.
for (let i = 0; i < dismissN; i++) { await key("right_soft", 140, 2500); await bail("dialogs"); }
for (let i = 0; i < 2; i++) await key("end", 140, 1800);
await sleep(1500);
const idle = await grab();
await shoot("idle");

// 4. play.  Holding a key is the point: the game's work is per *moved*
//    frame, so a meter that presses nothing measures the pause screen.
//
//    Everything below is scheduled on the guest's *virtual* clock, and
//    that is the whole difference between a meter and a number.  A game's
//    state is a function of virtual time -- its frame loop sleeps on a
//    guest timer -- so a window that opens at a fixed virtual offset from
//    the launch and spans a fixed virtual duration puts every leg through
//    the same frames of the same level.  Under icount that means the same
//    instruction stream, which is why `Mi` is a determinism check here
//    and not a result: the result is `v/wall`, virtual seconds delivered
//    per wall second, i.e. how much of a real phone this build is.
//
//    Anchoring on guest instructions instead was wrong for exactly the
//    reason it looked right.  900 Mi is the same amount of *work*, but
//    two builds spend it over different amounts of game time -- 48.1 vs
//    46.5 virtual seconds -- so they end up in different places in the
//    level and their wall times are not comparable after all.  Anchoring
//    on wall time is worse still: two runs of one build read 12.16 and
//    15.32 ms/Mi.
// --start and --play take one plan per --game entry, separated by "|":
// games do not share a splash.  Game 1 of CX70_games walks past its title
// on three centre taps, but game 2 comes up on a language picker whose
// only affirmative key is the left soft key ("SELEC."), and three centre
// taps leave it sitting on that list for the whole window -- 5 fps and
// duty 0.09, which reads as a game with enormous headroom and is really a
// game that was never started.  A short list is reused for the rest.
const parsePlan = (spec, defMs) => spec.split(",").filter(Boolean).map((s) => {
  const [k, ms] = s.split(":");
  return { k, ms: Number(ms || defMs) };
});
const playPlans = playSpec.split("|").map((x) => parsePlan(x, 500));
const startPlans = startSpec.split("|").map((x) => parsePlan(x, 3000));
const forGame = (a, gi) => a[Math.min(gi, a.length - 1)];
const plan = playPlans[0], startPlan = startPlans[0];
const rtcap = (on) => p.evaluate((v) => {
  const m = window.__qemu;
  if (!m._wasm_rtcap_set) return false;
  m._wasm_rtcap_set(v);
  return true;
}, on ? 1 : 0);
// The whole window runs inside the page: a virtual-clock milestone
// resolved over a CDP round trip would be as wall-dependent as the thing
// it replaces.
const playWindow = (startPlan, plan, warmV, windowV, nCounters, traceC) =>
  p.evaluate(async ([startPlan, plan, warmV, windowV, n, wallCapS, shotEvery, traceC]) => {
  const m = window.__qemu;
  const vns = () => Number(m._wasm_vclock());
  const shot = () => {
    const c = []; if (m._wasm_memstat) for (let i = 0; i < n; i++) c.push(Number(m._wasm_memstat(i)));
    return { t: performance.now(), v: vns(), insns: Number(m._wasm_insns()),
      tbs: m._wasm_tbs ? Number(m._wasm_tbs()) : 0, fb: Number(m._wasm_fb_updates()), c };
  };
  const t0 = performance.now();
  const v0 = vns();
  // A coarse trace of the whole post-launch timeline, sampled on the
  // guest's clock: where the intro ends, where play starts, where a life
  // ends.  --trace prints it, and it is how --warm/--window get placed in
  // steady play instead of across a title screen.
  const trace = [], shots = [], traceCs = [];
  let nextTrace = v0;
  const startAt = v0 + (startPlan.reduce((s, x) => s + x.ms, 0) + warmV) * 1e6;
  const endAt = startAt + windowV * 1e6;
  let a = null, c = null, stalled = false;
  // setTimeout(0) is the shortest yield that still lets the page breathe;
  // the counters live in shared memory the vCPU worker writes, so the poll
  // sees them without any message round trip.
  const yieldOnce = () => new Promise((r) => setTimeout(r, 0));
  const pump = async (target) => {
    while (true) {
      const v = vns();
      if (v >= nextTrace) {
        nextTrace = v + 2e9;
        trace.push([Math.round((v - v0) / 1e6), Number(m._wasm_fb_updates()),
          Math.round(Number(m._wasm_insns()) / 1e6)]);
        // Exact ns and exact insns, not the rounded Mi the printed line
        // carries: a bin is differenced against its neighbour, and two
        // roundings of a large cumulative counter swamp a small delta.
        if (traceC) {
          const s = shot();
          traceCs.push([v - v0, s.insns, s.fb, s.c]);
        }
        // a frame count says how busy the guest is, not what it is doing:
        // a title screen with an animation looks like play.  --shots asks
        // the panel itself, from inside the loop, on the same clock.
        if (shotEvery && (trace.length - 1) % shotEvery === 0) {
          shots.push([trace[trace.length - 1][0],
            document.getElementById("lcd").toDataURL("image/png")]);
        }
      }
      if (!a && v >= startAt) { a = shot(); a.cpuIx = await window.__hostcpu(); }
      if (v >= endAt) { if (!c) { c = shot(); c.cpuIx = await window.__hostcpu(); } return false; }
      if (v >= target) return true;
      // a guest that has stopped advancing its own clock never reaches
      // any milestone; without this the page would poll forever
      if (performance.now() - t0 > wallCapS * 1000) { stalled = true; return false; }
      await yieldOnce();
    }
  };
  const tap = (k, down) => {
    const btn = document.querySelector(`[data-key="${k}"]`);
    btn.dispatchEvent(new PointerEvent(down ? "pointerdown" : "pointerup", { bubbles: true }));
    return btn;
  };

  let at = v0;
  // past the splash: short taps, each followed by its own wait
  for (const s of startPlan) {
    tap(s.k, true);
    at += Math.min(140, s.ms) * 1e6;
    if (!(await pump(at))) break;
    tap(s.k, false);
    at += Math.max(0, s.ms - 140) * 1e6;
    if (!(await pump(at))) break;
  }
  let step = 0, held = null;
  while (!c && !stalled) {
    const s = plan[step++ % plan.length];
    held = tap(s.k, true);
    at += s.ms * 1e6;
    const go = await pump(at);
    tap(s.k, false);
    held = null;
    if (!go) break;
    at += 120 * 1e6;                   // a beat between presses
    if (!(await pump(at))) break;
  }
  if (held) held.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  return { a, c, stalled, trace, shots, traceCs };
}, [startPlan, plan, warmV, windowV, nCounters, 240, shotEvery, traceC]);
// wall-clock play, for --hold: a profiler slows the guest by ~3x, so an
// instruction budget there would take three times as long to spend.
const playFor = (secs) => p.evaluate(async ([plan, secs]) => {
  const t = performance.now();
  while (performance.now() - t < secs * 1000) {
    for (const step of plan) {
      const btn = document.querySelector(`[data-key="${step.k}"]`);
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await new Promise((r) => setTimeout(r, step.ms));
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      if (performance.now() - t >= secs * 1000) break;
    }
  }
}, [plan, secs]);

const swept = [];
// --game 1,1,1 is the repeatability form: three independent windows on one
// boot, which is the only cheap way to get a spread when the boot is 150 s
// and the window is 10.
for (const [gi, gameIx] of gameList.entries()) {
outBase = gameList.length > 1
  ? `${runBase}-g${gameIx}${gameList.indexOf(gameIx) === gi ? "" : "-" + (gi + 1)}` : runBase;

// 3+4. the walk to a running game and the window it plays, retried as one
//      unit.  The drawing check is the window's own frame count: a J2ME
//      canvas only blits when something moved, so a window that produced
//      no frames was not spent in a game and the walk has to be redone.
//      The cap stays on for the walk -- uncapped, an idle guest warps
//      hours of its own clock between presses -- and comes off at the
//      launch, which is where the virtual-time schedule is anchored.
let a = null, c = null, traceCs = null;
for (let attempt = 1; attempt <= 3 && !c; attempt++) {
  let ok = true;
  for (const k of navPath) {
    if (!(await keyUntilChange(k, 2500))) { ok = false; break; }
    await bail("walk");
  }
  if (ok && folderIx > 0) {
    for (let i = 1; i < folderIx; i++) await key("down", 140, 700);
    ok = await keyUntilChange("center", 3000);
  }
  if (ok) {
    for (let i = 1; i < gameIx; i++) await key("down", 140, 700);
    ok = await keyUntilChange("center", 6000);       // launch
  }
  if (ok) {
    await shoot("game");
    // Before the cap comes off, not after: uncapped, the guest warps its
    // own clock as fast as the host allows, so a ten-minute wait here would
    // play the game for hours of its own time and the window would open on
    // something the --start plan never aimed at.  Capped, the game simply
    // sits on its title at real time.
    if (MAXLOAD > 0) {
      let l = loadNow();
      while (l > MAXLOAD && Date.now() < LOAD_DEADLINE) {
        console.log(`[j2me] waiting for a quiet host: load ${l} > ${MAXLOAD} ` +
          `(${Math.round((LOAD_DEADLINE - Date.now()) / 1000)}s of budget left)`);
        await sleep(15000);
        l = loadNow();
      }
      // Wait, then measure anyway.  Failing here would retry the leg three
      // times and drop it, and a dropped leg punctures the palindrome --
      // worse than a leg taken against a busy host, which the read-time
      // correction can at least partly undo.  The load is recorded either
      // way, so a leg taken after giving up is visible rather than silent.
      console.log(l > MAXLOAD
        ? `[j2me] host never fell to ${MAXLOAD} within the ${LOADWAIT}s budget (load ${l}) -- measuring anyway`
        : `[j2me] host quiet at load ${l}`);
    }
    if (uncap && !(await rtcap(false)))
      await fail("this build has no wasm_rtcap_set — rebuild, or pass --uncap 0");
    cpuPids = chromeTree(process.pid);
    if (windowV > 0) {
      const w = await playWindow(forGame(startPlans, gi), forGame(playPlans, gi),
        warmV, windowV, NAMES.length, traceCOn);
      if (w.stalled) console.log(`[j2me] attempt ${attempt}: the guest's virtual clock stopped`);
      for (const [v, url] of w.shots || []) {
        writeFileSync(`${outBase}-v${String(Math.round(v / 1000)).padStart(3, "0")}.png`,
          Buffer.from(url.split(",")[1], "base64"));
      }
      if (traceOn && w.trace) {
        // frames and Mi per 2 virtual seconds: a busy stretch is play, a
        // quiet one is a menu, and a spike is a level load
        let pf = 0, pi = 0;
        console.log("[j2me] trace (virtual s : frames/Mi in the 2 s before it) " + w.trace.map(([v, f, i]) => {
          const r = `${(v / 1000).toFixed(0)}s:${f - pf}f/${i - pi}Mi`; pf = f; pi = i; return r;
        }).join(" "));
      }
      if (w.a && w.c) {
        const fps = (w.c.fb - w.a.fb) / ((w.c.t - w.a.t) / 1000);
        if (fps >= 2) { ({ a, c } = w); traceCs = w.traceCs || null; }
        else console.log(`[j2me] attempt ${attempt}: window drew ${fps.toFixed(1)} fps — not a game`);
      }
    } else {
      a = await snap();
      a.cpuIx = cpuSamples.push(cpuSample()) - 1;
      await playFor(measureS);
      c = await snap();
      c.cpuIx = cpuSamples.push(cpuSample()) - 1;
    }
  }
  await bail("play");
  if (c) break;
  console.log(`[j2me] attempt ${attempt}: backing out and retrying`);
  // a premature "booted" call is the usual reason the walk goes nowhere —
  // the firmware is still coming up and swallows everything — so give it
  // real time before trying again, then return to idle
  if (uncap) await rtcap(true);
  await sleep(20000);
  for (let i = 0; i < 5; i++) await key("end", 140, 1500);
  await sleep(2000);
  if (diffOf(idle, await grab()) > 12) await key("end", 600, 2500);   // long red: force idle
}
if (!c) await fail(`could not reach game ${gameIx}`);

const d = {}; for (const k in a) if (k !== "c" && k !== "cpuIx") d[k] = c[k] - a[k];
const wall = d.t / 1000;
const hostCpu = a.cpuIx != null && c.cpuIx != null
  ? cpuDelta(cpuSamples[a.cpuIx], cpuSamples[c.cpuIx]) : { top: 0, all: 0 };
// every counter that moved, per second and per Mi of guest work: the
// mechanism meter for this workload (a counter's spread is 0.04 %, a
// clock's is several %), and the only way to tell a J2ME window apart
// from a boot window without guessing
const counters = {}, perMi = {};
for (let i = 0; i < NAMES.length; i++) {
  const dv = c.c[i] - a.c[i];
  if (!dv) continue;
  counters[NAMES[i]] = dv;
  perMi[NAMES[i]] = +(dv / (d.insns / 1e6)).toFixed(3);
}
const g = (n) => counters[n] || 0;
const rec = {
  tool: "j2mebench", dist, rt, uncap, stamp, tag, flash: path.basename(FLASH), game: gameIx, folder: folderIx,
  tBoot: +tBoot.toFixed(1), play: playSpec, start: startSpec, warmV, windowV,
  wall: +wall.toFixed(2),
  vWin: +(d.v / 1e9).toFixed(3),
  fps: +(d.fb / wall).toFixed(2),
  mips: +(d.insns / 1e6 / wall).toFixed(2),
  // What "full speed" actually means, and it is not v/wall.  A stock CX70
  // is 125 MIPS (icount shift=3, 8 ns an instruction), and v/wall counts
  // warped-over idle as delivered time -- so a window whose average is
  // 5.0 still stutters through every stretch where the guest wants its
  // whole CPU, and a J2ME game wants exactly that while it loads a level.
  // cpu is MIPS/125: below 1.0 the busy phases run slow no matter how
  // idle the rest of the second was.
  cpu: +(d.insns / 1e6 / wall / 125).toFixed(3),
  // The partly load-robust A/B number, and the "partly" is load-bearing.
  // The window holds the guest's work fixed, so what a build is being
  // judged on is how much host CPU it takes to retire it; hostCpuS is the
  // busiest browser thread's own utime+stime over the window, which is the
  // vCPU.  Against MIPS this removes the thread being descheduled.  It
  // does not remove a slower second: measured, not assumed, the residual
  // load dependence is MIPS/cpu proportional to load**-0.29 (r -0.73, 64
  // legs, fitted within identical configs).  Read it next to hostBusy.
  hostCpuS: hostCpu.top,
  hostAllS: hostCpu.all,
  hostLoad: +readFileSync("/proc/loadavg", "ascii").split(" ")[0],
  hostPids: cpuPids.length,
  // The covariate MIPS/cpu needs and did not have.  hostBusy is every
  // core's non-idle fraction over this window alone; hostLoad0/hostLoad
  // bracket it so drift across the window is visible rather than inferred.
  // A verdict whose two arms sat at different hostBusy is measuring the
  // host.
  hostBusy: hostCpu.hostBusy,
  hostLoad0: hostCpu.load0,
  mipsCpu: hostCpu.top ? +(d.insns / 1e6 / hostCpu.top).toFixed(2) : null,
  // < 1.0 means the vCPU thread spent part of the window off-CPU: the host
  // was contended, MIPS is understated by roughly this factor, and
  // mipsCpu is the number to compare.
  busy: hostCpu.top ? +(hostCpu.top / wall).toFixed(3) : null,
  // The A/B number: virtual seconds of phone delivered per wall second.
  // 1.0 is a real CX70 in real time; the shipping cap holds it there and
  // this window runs uncapped so that the engine's own ceiling shows.
  // Higher is better.
  vratio: +(d.v / 1e9 / wall).toFixed(3),
  duty: +((d.insns * 8) / (d.v || 1)).toFixed(3),
  // The determinism check, and it is not optional: the window is a fixed
  // span of the guest's own clock, so under icount the instructions it
  // retires are a property of the guest alone.  Legs whose mi disagrees
  // by more than a fraction of a percent played different games, and
  // their wall times are not comparable.
  msPerMi: +((wall * 1000) / (d.insns / 1e6)).toFixed(3),
  insnsPerFrame: Math.round(d.insns / (d.fb || 1)),
  // 0 unless the build counts TB entries (W64_TBSTATS=1): under icount
  // the shipped prologue carries no counter
  insnsPerTb: d.tbs ? +(d.insns / d.tbs).toFixed(2) : null,
  haltsPerS: Math.round(g("halt") / wall),
  mi: +(d.insns / 1e6).toFixed(1),
  counters, perMi,
  traceCs,
  loadavg: readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" "),
  extraQ,
};
await shoot("end");
writeFileSync(`${outBase}.json`, JSON.stringify(rec, null, 1));
console.log(`J2ME ${dist} rt=${uncap ? "off(play)" : rt} game=${gameIx} MIPS/cpu=${rec.mipsCpu} ` +
  `hostBusy=${rec.hostBusy} load=${rec.hostLoad0}->${rec.hostLoad} busy=${rec.busy} ` +
  `cpu=${rec.cpu} v/wall=${rec.vratio} fps=${rec.fps} MIPS=${rec.mips} ` +
  `ms/Mi=${rec.msPerMi} duty=${rec.duty} insns/frame=${rec.insnsPerFrame} Mi=${rec.mi} vWin=${rec.vWin} ` +
  // the warm-up check: a window that is still translating is measuring the
  // translator.  Settled play is ~1.4 tbGen/Mi; 3+ means --warm was short.
  `tbGen/Mi=${perMi.tbGen ?? 0} ` +
  `halts/s=${rec.haltsPerS} wall=${rec.wall} load=${rec.loadavg}`);
// per Mi, so the shape of the workload is comparable between windows of
// different lengths and between legs of different speeds
console.log("perMi: " + Object.entries(perMi).filter(([, v]) => v >= 0.01)
  .sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(" "));
console.log(`results: ${outBase}.json (+ -game.png/-end.png)`);
swept.push(rec);

// back to idle for the next game in the sweep.  The cap goes back on
// first: the walk is wall-scheduled, and an uncapped guest warps its own
// clock far enough between presses to re-arm the screensaver.
if (gi !== gameList.length - 1) {
  if (uncap) await rtcap(true);
  for (let i = 0; i < 6; i++) await key("end", 140, 1600);
  await sleep(2000);
  if (diffOf(idle, await grab()) > 12) {
    await key("end", 600, 3000);
    await sleep(2000);
  }
}
}
if (swept.length > 1) {
  writeFileSync(`${runBase}-sweep.json`, JSON.stringify(swept, null, 1));
  console.log(`J2ME sweep ${dist}: ` + swept.map((r) => `g${r.game}: MIPS/cpu=${r.mipsCpu} cpu=${r.cpu} Mi=${r.mi} load=${r.hostLoad}`).join("  ") +
    `  ${runBase}-sweep.json`);
}
// The hold keeps *playing*, not just sitting there: a profile of a paused
// J2ME canvas is a profile of an idle guest, which is not the state this
// tool exists to measure.
if (holdS) {
  console.log(`[j2me] PLAYHOLD ${holdS}s (devtools ${devtools || "off"}) — attach now`);
  await playFor(holdS);
}
await b.close();
