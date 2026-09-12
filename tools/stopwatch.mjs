// J2ME stopwatch pacing benchmark — the user-reported "Java timers run at
// ~0.1x".  Self-contained (own browser, no session daemon, no LLM):
//
//   PORT=8080 node tools/stopwatch.mjs [--dist dist-jit] [--measure 20]
//
// Boots S75v40lg1.bin (the same fullflash idlebench uses, so both tools
// measure the same guest), waits until the boot work is done, walks the
// keypad to Extras -> Stopwatch (main menu, asterisk, down to the entry),
// starts it and reports, over --measure wall seconds:
//   vratio  virtual seconds per wall second while the stopwatch runs — the
//           number the user sees (the app is compute-bound, so this is
//           its own display rate; 1.0 = real time)
//   MIPS    guest insns/s, fps = framebuffer updates/s, plus the cold
//           device counters (wasm_memstat: MMIO, TLB fills, TB lookups)
// Every keypad step is verified against a native-size LCD reference
// (tools/test_targets/s75v40lg1_*.png; pixel rule as compare-lcd/idlebench)
// and retried, so a dropped key press cannot derail it — the firmware
// drops presses freely under host load, so nothing here assumes a press
// landed.  Results: tests/results/stopwatch-<ts>.json + LCD screenshots;
// exit 1 on a stuck navigation.
//
// A different fullflash needs its own two references (--listref/--runref):
// capture them with tools/session.mjs at 132x176 via
//   node ctl.mjs eval "document.getElementById('lcd').toDataURL('image/png')"
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const dist = opt("dist", "dist-jit");
const measureS = Number(opt("measure", 20));
const idleMax = Number(opt("idlemax", 240));
const idleRate = Number(opt("idlerate", 3));   // M insns/s: below = idle
const idleWait = Number(opt("idlewait", 0));   // >0: skip rate detection, wait this many s
const keyScale = Number(opt("keyscale", 1));   // multiply every key wait (slow builds)
const port = process.env.PORT || "8080";
const extraQ = process.env.EXTRA_Q || "";
const here = fileURLToPath(new URL(".", import.meta.url));
// default: S75v40lg1.bin, the fullflash idlebench/bootbench measure, so a
// pacing number and a boot number describe the same guest (--flash plus
// --listref/--runref for another one)
const FLASH = opt("flash", here + "../fullflashes/S75v40lg1.bin");
const refs = {
  listSel: PNG.sync.read(readFileSync(opt("listref", here + "test_targets/s75v40lg1_extras_stopwatch_sel.png"))),
  running: PNG.sync.read(readFileSync(opt("runref", here + "test_targets/s75v40lg1_stopwatch_running.png"))),
};
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const outBase = path.join(here, `../tests/results/stopwatch-${stamp}-${dist}`);

// --devtools <port> exposes CDP (tools/wprof2.mjs PROF_ATTACH=<port>) and
// --hold <s> keeps the running stopwatch open that long after the
// measurement so a profile can be taken of exactly this state
const devtools = Number(opt("devtools", 0));
const holdS = Number(opt("hold", 0));
const b = await chromium.launch({ headless: true, args: devtools ? [`--remote-debugging-port=${devtools}`] : [] });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
let pageErr = null;
p.on("pageerror", (e) => { pageErr = String(e).slice(0, 200); });
let serialExit = false;
const dbgLines = [];
p.on("console", (m) => {
  const t = m.text();
  if (t.includes(">>EXIT<<")) serialExit = true;
  // CONSOLE_MATCH=<substr>: echo matching page console lines at the end
  if (process.env.CONSOLE_MATCH && t.includes(process.env.CONSOLE_MATCH) && dbgLines.length < 200) dbgLines.push(t.slice(0, 200));
});

// pixel diff of the live LCD against a reference over rows [y0, y1):
// % of pixels with any channel differing by > 48
async function grab() {
  return p.evaluate(() => {
    const c = document.getElementById("lcd");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    return { w: d.width, h: d.height, data: Array.from(d.data) };
  });
}
async function diffPct(ref, y0 = 0, y1 = ref.height, live = null) {
  live = live || await grab();
  if (live.w !== ref.width || live.h !== ref.height) return 100;
  let diff = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < live.w; x++) {
    const i = (y * live.w + x) * 4;
    n++;
    if (Math.abs(live.data[i] - ref.data[i]) > 48 || Math.abs(live.data[i + 1] - ref.data[i + 1]) > 48 ||
        Math.abs(live.data[i + 2] - ref.data[i + 2]) > 48) diff++;
  }
  return n ? (100 * diff) / n : 100;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function key(k, waitMs = 700) {
  await p.click(`[data-key="${k}"]`);
  await sleep(waitMs * keyScale);
}
async function snap() {
  return p.evaluate(() => {
    const m = window.__qemu; const g = (i) => Number(m._wasm_memstat(i));
    return { t: performance.now(), v: Number(m._wasm_vclock()), insns: Number(m._wasm_insns()),
      tbs: Number(m._wasm_tbs()), fb: Number(m._wasm_fb_updates()),
      ioLd: g(2), ioSt: g(3), fill: g(4), lookup: g(13), qhtHit: g(15), tlbFlush: g(18), tlbFlushRange: g(19),
      fillFetch: g(20), fillProbe: g(21), fillSame: g(22), fillInvalid: g(23), fillLarge: g(24), fillIdx: g(25),
      fillEvict: g(26), tlbSize0: g(27), tlbUsed0: g(28), romdFlip: g(10), topC: g(11), topoReuse: g(12), halts: g(29) };
  });
}
async function shoot(tag) {
  try { const lcd = await p.$("#lcd"); await lcd.screenshot({ path: `${outBase}-${tag}.png` }); } catch {}
}
const fail = async (why) => {
  console.log("STOPWATCH FAIL " + why + (pageErr ? " pageerror=" + pageErr : "") + (serialExit ? " serial=EXIT" : ""));
  await shoot("fail");
  await b.close();
  process.exit(1);
};

await p.goto(`http://127.0.0.1:${port}/?dist=${dist}${extraQ ? "&" + extraQ : ""}`, { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.setInputFiles("#fullflash", FLASH);
const t0 = Date.now();
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });

// 1. boot done: firmware-agnostic — the guest goes idle (insn rate under
//    --idlerate M/s for 4 consecutive seconds, after at least 15 s)
let tIdle = null, quiet = 0, last = await snap();
if (idleWait) { await sleep(idleWait * 1000); tIdle = idleWait; }
while (tIdle === null && (Date.now() - t0) / 1000 < idleMax) {
  await sleep(1000);
  if (serialExit || pageErr) await fail("boot: " + (pageErr || "guest EXIT"));
  const s = await snap();
  const rate = (s.insns - last.insns) / ((s.t - last.t) / 1000);
  last = s;
  quiet = rate < idleRate * 1e6 ? quiet + 1 : 0;
  // the S75 boot is a fixed ~1.345e9 insns: a slow host can dip under the
  // rate threshold mid-boot, so the work must be done too
  if ((Date.now() - t0) / 1000 >= 15 && quiet >= 4 && s.insns >= 1.2e9) { tIdle = (Date.now() - t0) / 1000 - 4; break; }
}
if (tIdle === null) await fail(`guest never went idle within ${idleMax}s`);
console.log(`[stopwatch] idle at ~${tIdle.toFixed(0)}s`);
await sleep(3000); // let the idle screen settle (network-search dialog etc.)

// 2. navigate: idle -> main menu grid -> asterisk (Extras) -> down until
//    the Stopwatch entry is selected, every step checked against the LCD.
// The firmware drops key presses freely (the first one after boot always,
// and any of them under host load), so no press is assumed to have
// landed: the menu press is repeated while the screen still looks like
// idle, asterisk is retried with a Back in between, and the scroll
// re-checks after every down.
const isExtras = async () => (await diffPct(refs.listSel, 0, 22)) <= 1.0;
// The idle screen as this flash renders it, captured before any key is
// pressed: its soft-key row ("Info | Menu") is what tells idle apart from
// the dialer ("Options | <C", which a stray asterisk lands in and which
// the red key does NOT clear) and from any menu ("Options | Back").  The
// body above it is not compared — the clock and the network-search banner
// change on their own.
const idle0 = await grab();
const idleRef = { width: idle0.w, height: idle0.h, data: idle0.data };
const SOFTKEY_ROWS = 28;
const atIdle = async () =>
  (await diffPct(idleRef, idle0.h - SOFTKEY_ROWS, idle0.h)) <= 2;

let onEntry = false;
for (let attempt = 1; attempt <= 6 && !onEntry; attempt++) {
  // back to a clean idle screen: the red key leaves any menu, the right
  // soft key is "<C" (delete) when the dialer holds a stray character
  for (let i = 0; i < 6 && !(await atIdle()); i++) {
    await key(i % 2 ? "right_soft" : "end", 1200);
  }
  // idle -> main menu grid.  The very first press after boot is swallowed
  // by the firmware, so this repeats while the screen still looks idle.
  for (let i = 0; i < 3; i++) {
    await key("center", 3000);
    if (!(await atIdle())) break;
  }
  let extras = false;
  for (let i = 0; i < 3 && !extras; i++) {             // grid -> Extras
    await key("star", 2500);
    extras = await isExtras();
    // a swallowed asterisk leaves us in the grid: Back would drop to idle
    // (where the next asterisk would type into the dialer), so only press
    // it when we are deeper than the grid, else just press asterisk again
    if (!extras && (await atIdle())) break;            // restart the attempt
  }
  if (!extras) {
    console.log(`[stopwatch] attempt ${attempt}: Extras list not open, retrying`);
    if (serialExit || pageErr) await fail("navigation: " + (pageErr || "guest EXIT"));
    continue;
  }
  for (let i = 0; i < 12; i++) {                       // down to Stopwatch
    if ((await diffPct(refs.listSel)) <= 1.0) { onEntry = true; break; }
    await key("down", 900);
  }
  if (!onEntry) console.log(`[stopwatch] attempt ${attempt}: stopwatch entry not reached, retrying`);
  if (serialExit || pageErr) await fail("navigation: " + (pageErr || "guest EXIT"));
}
if (!onEntry) await fail("could not reach the stopwatch entry");

// 3. open it (title bar = top 22 rows of the running reference)
let opened = false;
for (let tries = 0; tries < 3 && !opened; tries++) {
  await key("center", 5000);
  for (let i = 0; i < 8 && !opened; i++) {
    opened = (await diffPct(refs.running, 0, 22)) <= 1.0;
    if (!opened) await sleep(1000);
  }
  if (!opened) console.log("[stopwatch] app not open yet, pressing center again");
}
if (!opened) await fail("stopwatch app did not open");

// 4. start: center toggles run/stop, so "is it running" must be read off
// the LCD (the digits redraw) — a rate threshold would misfire on a
// loaded host and the retry would press center again, stopping it.
async function digitsMoving(waitMs = 1500) {
  const a = await grab();
  await sleep(waitMs);
  return (await diffPct({ width: a.w, height: a.h, data: a.data })) > 0.2;
}
let running = false;
for (let i = 0; i < 3 && !running; i++) {
  await key("center", 1500);
  running = await digitsMoving();
  if (!running) console.log("[stopwatch] not counting yet, pressing again");
}
if (!running) await fail("stopwatch did not start");
await shoot("start");

// 5. measure
const a = await snap();
await sleep(measureS * 1000);
const c = await snap();
const d = {}; for (const k in a) d[k] = c[k] - a[k];
const wall = d.t / 1000;
const rec = {
  dist, stamp, tIdle, wall: +wall.toFixed(2), vratio: +(d.v / 1e9 / wall).toFixed(3),
  mips: +(d.insns / 1e6 / wall).toFixed(1), fps: +(d.fb / wall).toFixed(1),
  haltsPerS: Math.round(d.halts / wall), warpShare: +(1 - (d.insns * 8) / (d.v || 1)).toFixed(3),
  insnsPerTb: +(d.insns / d.tbs).toFixed(2), lookupsPerS: Math.round(d.lookup / wall),
  qhtHitsPerS: Math.round(d.qhtHit / wall), ioLdPerS: Math.round(d.ioLd / wall),
  ioStPerS: Math.round(d.ioSt / wall), fillsPerS: Math.round(d.fill / wall),
  tlbFlushPerS: Math.round(d.tlbFlush / wall), tlbFlushRangePerS: Math.round(d.tlbFlushRange / wall),
  fillKinds: { fetch: d.fillFetch, probe: d.fillProbe, samePage: d.fillSame, invalid: d.fillInvalid, large: d.fillLarge, avgMmuIdx: +(d.fillIdx / (d.fill || 1)).toFixed(2), evict: d.fillEvict, total: d.fill, tlbSize0: c.tlbSize0, tlbUsed0: c.tlbUsed0, romdFlip: d.romdFlip, topC: d.topC, topoReuse: d.topoReuse },
  loadavg: readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" "),
  extraQ, wasmSha: null,
};
await shoot("end");
writeFileSync(`${outBase}.json`, JSON.stringify(rec, null, 1));
console.log(`STOPWATCH ${dist} vratio=${rec.vratio} MIPS=${rec.mips} fps=${rec.fps} halts/s=${rec.haltsPerS} warpShare=${rec.warpShare} insns/tb=${rec.insnsPerTb} lookups/s=${rec.lookupsPerS} ioLd/s=${rec.ioLdPerS} ioSt/s=${rec.ioStPerS} fills/s=${rec.fillsPerS} tlbFlush/s=${rec.tlbFlushPerS} tlbFlushRange/s=${rec.tlbFlushRangePerS} wall=${rec.wall} load=${rec.loadavg}`);
console.log(`fills: ${JSON.stringify(rec.fillKinds)}`);
for (const l of dbgLines) console.log("[console] " + l);
console.log(`results: ${outBase}.json (+ -start.png/-end.png)`);
if (holdS) { console.log(`[stopwatch] holding ${holdS}s (devtools ${devtools || "off"})`); await sleep(holdS * 1000); }
await b.close();
