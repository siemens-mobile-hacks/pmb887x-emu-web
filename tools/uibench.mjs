// Per-board UI throughput meter — the S75 stopwatch for every phone.
//
//   PORT=8080 node tools/uibench.mjs --board el71 [--dist dist-jit]
//
// tools/stopwatch.mjs is the pacing gate for the S75 (it navigates one
// firmware's menus to one J2ME app); idlebench measures boots.  Nothing
// measured the *steady-state* cost of a board's UI, which is what a user
// calls "slow" — and the 240x320 boards (EL71, KE800) push 3.3x the
// pixels of the S75's 132x176 through the same per-word DIF/DMAC/LCD
// chain, so an S75-only meter cannot see their bottleneck at all.
//
// Protocol (keep it deterministic; it is an A/B meter):
//   - boot the board's fullflash, ONLINE, and wait for the guest to go
//     quiet (insn rate < --idlerate M/s for 4 s, at least --floor s) —
//     firmware-agnostic, no reference image needed.  A boot has slow
//     patches (a compile-bound stretch reads under the threshold), so
//     --settle <s> skips the detection and waits a fixed time instead:
//     use it whenever the number has to be comparable across runs.
//   - then run --measure (20) wall seconds in one of two states:
//       idle  : no input at all — what the phone costs sitting there.
//       menu  : press --keys (default center,end) every --period ms, i.e.
//               open the main menu and return to idle, over and over.
//               Every cycle repaints the whole screen, so this is the
//               display-path meter (fps/MIPS), and it needs no per-flash
//               reference: nothing is asserted about what is drawn.
//     --state idle|menu|both (default both, idle first).
//   - report per state: MIPS, v/wall (icount boards; 1.0 = real time),
//     fps (framebuffer blits/s), halts/s and the display counters per
//     second (difTxWord, dmacBurst, ...).  The LG boards run icount=none
//     (site/app.js), so their v/wall is meaningless by construction and
//     MIPS/fps are the numbers.
//   - rt=off by default like idlebench's milestones: engine speed, not
//     the shipping real-time cap's pacing.  RT=banked for the shipped
//     configuration.
//
// Results: tests/results/uibench-<ts>-<board>-<dist>.json + LCD shots.
// Comparable only within one board: boards run different firmware.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = fileURLToPath(new URL(".", import.meta.url));

// board -> fullflash (+ sidecars), mirroring tools/bootcheck.mjs
// keys: the open-menu / back-to-idle pair for that firmware (the LG's main
// menu is on the left soft key; on the Siemens it is the joystick centre)
const BOARDS = {
  s75: { flash: "S75v40lg1.bin", sidecars: [], keys: "center,end" },
  el71: { flash: "rr_ff_el71_stock.bin", sidecars: [], keys: "center,end" },
  ke800: { flash: "KE800-v11b.bin", sidecars: ["KE800-v11b.bin.cfi-efa"], keys: "left_soft,end" },
};
const boardId = opt("board", "s75");
const board = BOARDS[boardId];
if (!board && !opt("flash", null)) {
  console.error(`unknown --board ${boardId} (${Object.keys(BOARDS).join(", ")})`);
  process.exit(2);
}
const FLASH = opt("flash", here + "../fullflashes/" + board.flash);
const SIDECARS = opt("flash") ? [] : board.sidecars.map((f) => here + "../fullflashes/" + f);

const dist = opt("dist", "dist-jit");
const measureS = Number(opt("measure", 20));
const idleMax = Number(opt("idlemax", 300));
const idleFloor = Number(opt("floor", 20));
const idleRate = Number(opt("idlerate", 3));       // M insns/s: below = quiet
const settleS = Number(opt("settle", 0));          // >0: fixed wait, no detection
const state = opt("state", "both");                // idle | menu | both
const keys = opt("keys", board?.keys ?? "center,end").split(",").filter(Boolean);
const periodMs = Number(opt("period", 2000));
const port = process.env.PORT || "8080";
const rt = process.env.RT || "off";
const extraQ = process.env.EXTRA_Q || "";
const devtools = Number(opt("devtools", 0));       // CDP port for wprof2 PROF_ATTACH
const holdS = Number(opt("hold", 0));              // keep the page alive after measuring
const chromeArgs = (process.env.CHROME_ARGS || "").split(/\s+/).filter(Boolean);

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const outBase = path.join(here, `../tests/results/uibench-${stamp}-${boardId}-${dist}`);

const b = await chromium.launch({
  headless: true,
  args: [...(devtools ? [`--remote-debugging-port=${devtools}`] : []), ...chromeArgs],
});
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
let pageErr = null, serialExit = false;
p.on("pageerror", (e) => { pageErr = String(e).slice(0, 200); });
p.on("console", (m) => { if (m.text().includes(">>EXIT<<")) serialExit = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// counter indices follow qemu/include/qemu/wasm-diag.h (see tools/diagall.mjs)
async function snap() {
  return p.evaluate(() => {
    const m = window.__qemu; const g = (i) => Number(m._wasm_memstat(i));
    return {
      t: performance.now(), v: Number(m._wasm_vclock()), insns: Number(m._wasm_insns()),
      tbs: Number(m._wasm_tbs()), fb: Number(m._wasm_fb_updates()),
      ioLd: g(2), ioSt: g(3), fill: g(4), lookup: g(13), halts: g(29),
      difMuxRebuild: g(59), difTxWord: g(60), dmacBurst: g(61),
      dmacSchedTimer: g(62), dmacXlatFill: g(63), gptuTimer: g(64),
      ioRecomp: g(65), ioBarrierEvict: g(66), ioBarrierSplit: g(67),
      tbGen: g(7), modCount: g(34), jcFlush: g(16),
    };
  });
}
async function shoot(tag) {
  try { const lcd = await p.$("#lcd"); if (lcd) await lcd.screenshot({ path: `${outBase}-${tag}.png` }); } catch {}
}
const fail = async (why) => {
  console.log(`UIBENCH FAIL ${boardId} ${why}${pageErr ? " pageerror=" + pageErr : ""}${serialExit ? " serial=EXIT" : ""}`);
  await shoot("fail");
  await b.close();
  process.exit(1);
};

await p.goto(`http://127.0.0.1:${port}/?dist=${dist}&rt=${rt}${extraQ ? "&" + extraQ : ""}`,
             { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.setInputFiles("#fullflash", [FLASH, ...SIDECARS]);
const t0 = Date.now();
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });

// boot done = the guest goes quiet (no reference image, so this works for
// any firmware); the floor keeps a mid-boot dip from ending it early
let tIdle = null, quiet = 0, last = await snap();
if (settleS) {
  while ((Date.now() - t0) / 1000 < settleS) {
    await sleep(1000);
    if (serialExit || pageErr) await fail("boot: " + (pageErr || "guest EXIT"));
  }
  tIdle = settleS;
  last = await snap();
}
while (tIdle === null && (Date.now() - t0) / 1000 < idleMax) {
  await sleep(1000);
  if (serialExit || pageErr) await fail("boot: " + (pageErr || "guest EXIT"));
  const s = await snap();
  const rate = (s.insns - last.insns) / ((s.t - last.t) / 1000);
  last = s;
  quiet = rate < idleRate * 1e6 ? quiet + 1 : 0;
  if ((Date.now() - t0) / 1000 >= idleFloor && quiet >= 4) { tIdle = (Date.now() - t0) / 1000 - 4; break; }
}
if (tIdle === null) await fail(`guest never went quiet within ${idleMax}s (insns=${(last.insns / 1e6).toFixed(0)}M fb=${last.fb})`);
console.log(`[uibench] ${boardId}: quiet at ~${tIdle.toFixed(0)}s (${(last.insns / 1e6).toFixed(0)}M insns, fb=${last.fb})`);
await sleep(3000);   // let the idle screen settle
await shoot("idle");

// one measurement window; `drive` runs concurrently with it
async function measure(name, drive) {
  const a = await snap();
  const done = drive ? drive() : Promise.resolve();
  await sleep(measureS * 1000);
  stopDriving = true;
  await done;
  const c = await snap();
  const d = {}; for (const k in a) d[k] = c[k] - a[k];
  const wall = d.t / 1000;
  const rec = {
    state: name, wall: +wall.toFixed(2),
    mips: +(d.insns / 1e6 / wall).toFixed(1),
    vratio: +(d.v / 1e9 / wall).toFixed(3),
    fps: +(d.fb / wall).toFixed(1),
    haltsPerS: Math.round(d.halts / wall),
    insnsPerTb: +(d.insns / (d.tbs || 1)).toFixed(2),
    ioLdPerS: Math.round(d.ioLd / wall), ioStPerS: Math.round(d.ioSt / wall),
    fillsPerS: Math.round(d.fill / wall), lookupsPerS: Math.round(d.lookup / wall),
    difTxWordPerS: Math.round(d.difTxWord / wall), dmacBurstPerS: Math.round(d.dmacBurst / wall),
    difMuxRebuildPerS: Math.round(d.difMuxRebuild / wall),
    dmacSchedTimerPerS: Math.round(d.dmacSchedTimer / wall),
    dmacXlatFillPerS: Math.round(d.dmacXlatFill / wall), gptuTimerPerS: Math.round(d.gptuTimer / wall),
    // mid-TB MMIO unwinds and the io-barrier set that is meant to stop them
    // recurring (accel/tcg/translate-all.c); the LG boards take that path
    ioRecompPerS: Math.round(d.ioRecomp / wall),
    ioBarrierEvictPerS: Math.round(d.ioBarrierEvict / wall),
    ioBarrierSplitPerS: Math.round(d.ioBarrierSplit / wall),
    tbGenPerS: Math.round(d.tbGen / wall), modCountPerS: Math.round(d.modCount / wall),
    jcFlushPerS: Math.round(d.jcFlush / wall),
  };
  console.log(`UIBENCH ${boardId} ${dist} ${name} MIPS=${rec.mips} v/wall=${rec.vratio} fps=${rec.fps} ` +
    `halts/s=${rec.haltsPerS} ioLd/s=${rec.ioLdPerS} ioSt/s=${rec.ioStPerS} difTxWord/s=${rec.difTxWordPerS} ` +
    `dmacBurst/s=${rec.dmacBurstPerS} gptuTimer/s=${rec.gptuTimerPerS} fills/s=${rec.fillsPerS} ` +
    `ioRecomp/s=${rec.ioRecompPerS} barrierEvict/s=${rec.ioBarrierEvictPerS} barrierSplit/s=${rec.ioBarrierSplitPerS} ` +
    `tbGen/s=${rec.tbGenPerS} mod/s=${rec.modCountPerS} jcFlush/s=${rec.jcFlushPerS} wall=${rec.wall}`);
  return rec;
}

let stopDriving = false;
const driveKeys = () => (async () => {
  for (let i = 0; !stopDriving; i++) {
    try { await p.click(`[data-key="${keys[i % keys.length]}"]`, { timeout: 5000 }); } catch {}
    for (let w = 0; w < periodMs && !stopDriving; w += 100) await sleep(100);
  }
})();

const out = { board: boardId, dist, rt, extraQ, stamp, tIdle: +tIdle.toFixed(1), keys, periodMs, states: [],
  loadavg: readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" ") };
if (state === "idle" || state === "both") out.states.push(await measure("idle", null));
if (state === "menu" || state === "both") {
  stopDriving = false;
  out.states.push(await measure("menu", driveKeys));
  await shoot("menu");
}
writeFileSync(`${outBase}.json`, JSON.stringify(out, null, 1));
console.log(`results: ${outBase}.json  load=${out.loadavg}`);
if (holdS) {
  console.log(`[uibench] holding ${holdS}s (devtools ${devtools || "off"})`);
  stopDriving = false;
  if (state !== "idle") driveKeys();
  await sleep(holdS * 1000);
  stopDriving = true;
}
await b.close();
