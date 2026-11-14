// wasm boot gate: boot every fullflash on one dist and check it gets
// somewhere, the way tests/run.mjs does for the native build.
//
// The native suite (tests/run.mjs) is the correctness reference; this is
// its browser twin, because most of the wasm patches (io barriers, the
// wasm64 backend, the halt/idle paths) are invisible to it.  Five boards
// make the set: S75 and EL71 exercise different firmware paths (EL71
// programs its flash file system during boot — the 0034 retaddr bug only
// ever showed there), KE800 and KE970 are the LG boards, CX70 the x65
// one.
//
//   node tools/bootcheck.mjs [--dist dist-jit] [--secs 150] [--flash id,id]
//
// PASS for a board, after --secs:
// - no firmware EXIT dump on the serial log (">>EXIT<<" on x75/x85, a bare
//   "EXIT: <code>" line on the x65 CX70) and the page not back at idle;
// - no page error, crash or wasm abort, and the page answered every probe;
// - the guest never stopped: instructions, vCPU halts (_wasm_halts) and
//   framebuffer updates were never all frozen for STALL_S (below);
// - the LCD drew something, and the board reached its minInsns, if any.
// Exit 0 iff every board passed.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { opt as argOpt } from "./lib/argv.mjs";
import { flashFiles } from "./lib/boards.mjs";
import { bootOwnFlash, bounded, pageCall } from "./lib/page.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, "tests", "results"), { recursive: true });
const argv = process.argv.slice(2);
const opt = (n, d) => argOpt(argv, n, d);

const DIST = opt("dist", "dist-jit");
const SECS = Number(opt("secs", 150));
const PORT = process.env.PORT || "8080";
const ONLY = opt("flash", "").split(",").filter(Boolean);
// --query "trace=dsp&tracebuf=1": extra page parameters for every board;
// with tracebuf=1 the page keeps qemu's stderr in window.__qemulog and
// each board's tail is saved next to the screenshot (device-trace diffs
// between dists / page orders are how timing-sensitive boot failures get
// pinned down).
const QUERY = [opt("query", ""), process.env.EXTRA_Q || ""].filter(Boolean).join("&");
// EXTRA_Q mirrors uibench.mjs: env knobs (env=W64_...) reach
// the page.  Without it, an EXTRA_Q= boot leg silently runs the default
// config and the "probe" measures nothing (this cost two bogus rounds).

// minInsns: instructions the board must have executed by --secs.  KE800
// needs ~1.3 G past the LG logo to reach the idle screen; a guest parked
// at the logo (the pre-0049 GPTU timer storm starved the vCPU there)
// still "made progress" at ~10 k insns/s.
const BOARDS = [
  { id: "s75" },
  { id: "el71" },
  { id: "ke800", minInsns: 1.5e9 },
  // KE970 boots to its idle screen at ~1.62 G insns (~50 s wall on a
  // quiet host - uibench's quiet detector), same LG L1-sync waits as
  // KE800; 1.2 G leaves margin for gate legs that share the host.
  { id: "ke970", minInsns: 1.2e9 },
  // the only SGOLD (PMB8875) board here, and the only one that exercises
  // hw/arm/pmb887x/dif_v1.c at all - every other board is PMB8876/dif_v2
  { id: "cx70" },
].filter((b) => (ONLY.length ? ONLY.includes(b.id) : true));
const unknown = ONLY.filter((id) => !BOARDS.some((b) => b.id === id));
if (unknown.length) {
  console.error(`unknown --flash id: ${unknown.join(", ")}`);
  process.exit(2);
}

// A stopped guest, as the page's own detector (trackStall in site/app.js)
// calls one: instructions, halts and framebuffer updates all unchanged for
// this long, counted from the first sample in which any of them has moved.
// One counter alone cannot tell idle from dead: EL71 waits at a static
// "set time and date?" screen, and KE800 spends minutes mostly halted around
// its GSM L1 sync, but their instruction and halt counts keep moving.  In the
// close gates of 2026-11-12 to 14 no board added fewer than 8M instructions
// in any 10 s sample; the page itself calls a stall after 15 s.
const STALL_S = 40;

// both dump openings the page's own EXIT parser knows (site/app.js)
// (the x65 line is padded, so it is the code's shape that marks it)
const EXIT_RE = />>EXIT<<[^\x00]{0,120}|EXIT: [0-9A-F]{4}:[0-9A-F]{4}[^\x00]{0,100}/;

const probe = (src) => {
  const m = window.__qemu;
  let ser = "";
  try { ser = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); } catch {}
  const ui = window.__ui ?? {};
  // the page's verdict too: its parsed EXIT report, or the run back at
  // idle (the guest is gone, whatever ended it)
  const ended = ui.state === "idle" ? `guest ended (page idle, exit code ${ui.exitCode})` : "";
  return {
    fb: m?._wasm_fb_updates ? Number(m._wasm_fb_updates()) : 0,
    insns: m?._wasm_insns ? Number(m._wasm_insns()) : 0,
    halts: m?._wasm_halts ? Number(m._wasm_halts()) : 0,
    vclock: m?._wasm_vclock && ui.state !== "idle" ? Number(m._wasm_vclock()) / 1e9 : null,
    exit: (ser.match(new RegExp(src)) || [""])[0].trim()
      || (ui.exit ? `EXIT ${[ui.exit.type, ui.exit.code].filter(Boolean).join(" ")}` : "") || ended,
  };
};

const browser = await chromium.launch({ headless: true });
const results = [];

for (const board of BOARDS) {
  const files = flashFiles(board.id);
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`fullflash not found: ${f}`);
  }

  // wide enough for the three-column layout: below 900px the Firmware and
  // Run panels are bottom sheets, and a driver would have to open one to
  // reach the controls it sets here
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("crash", () => errors.push("page crashed"));
  page.on("console", (m) => {
    const t = m.text();
    if (/Aborted\(|Assertion failed|RuntimeError/.test(t)) errors.push(t.slice(0, 200));
  });

  await page.goto(`http://127.0.0.1:${PORT}/?dist=${DIST}${QUERY ? "&" + QUERY : ""}`,
                  { waitUntil: "domcontentloaded" });
  await bootOwnFlash(page, files, { startup: "ONLINE" });

  let last = { fb: 0, insns: 0, halts: 0, exit: "" };
  // when the counters last moved; null until they first have
  let lastMove = null;
  const stalledS = () => (lastMove ? (Date.now() - lastMove) / 1000 : 0);
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < SECS && !last.exit && !errors.length) {
    await new Promise((r) => setTimeout(r, 10000));
    // A frozen page (the pre-0034 KE800 deadlocked the renderer) makes
    // evaluate hang forever, so bound it and treat a timeout as a failure.
    const mx = await pageCall(page.evaluate(probe, EXIT_RE.source), "probe")
      .catch((e) => ({ err: String(e.message || e).slice(0, 120) }));
    if (mx.err) { errors.push(mx.err); break; }
    if (mx.insns !== last.insns || mx.halts !== last.halts || mx.fb !== last.fb) {
      lastMove = Date.now();
    }
    last = { ...mx, vclock: mx.vclock ?? last.vclock };
    console.log(`[${board.id}] t=${((Date.now() - t0) / 1000).toFixed(0)}s ` +
                `insns=${(mx.insns / 1e6).toFixed(0)}M halts=${mx.halts} fb=${mx.fb}` +
                `${mx.vclock != null ? ` guest=${mx.vclock.toFixed(1)}s` : ""}${mx.exit ? " *** EXIT ***" : ""}`);
    if (stalledS() >= STALL_S) break;
  }

  if (last.exit) {
    // The firmware's panic text trails the marker and is usually still
    // in the guest's UART FIFO when the marker is first seen: wait, then
    // keep the serial tail next to the screenshot for the post-mortem.
    await new Promise((r) => setTimeout(r, 3000));
    const tail = await bounded(page.evaluate(() => {
      try {
        const s = new TextDecoder("latin1").decode(window.__qemu.FS.readFile("/serial.log"));
        return s.slice(-4096);
      } catch { return ""; }
    }), "");
    const serPath = path.join(ROOT, "tests", "results", `bootcheck-${DIST}-${board.id}-serial.txt`);
    fs.writeFileSync(serPath, tail);
    const printable = tail.replace(/[\x00-\x09\x0b-\x1f\x7f-\xff]/g, " ");
    console.log(`[${board.id}] serial tail (${serPath}):`);
    for (const l of printable.split("\n").filter((l) => l.trim()).slice(-6)) console.log(`   | ${l.slice(0, 160)}`);
    last.exit = (printable.match(/>>EXIT<<[^\n]{0,120}|EXIT: [0-9A-F]{4}:[0-9A-F]{4}[^\n]{0,100}/) || [last.exit])[0].trim();
  }

  if (/(^|&)tracebuf=1/.test(QUERY)) {
    const lines = await bounded(page.evaluate(() => (window.__qemulog || []).slice(-30000)), []);
    const tracePath = path.join(ROOT, "tests", "results", `bootcheck-${DIST}-${board.id}-trace.txt`);
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");
    console.log(`[${board.id}] trace: ${lines.length} lines -> ${tracePath}`);
  }

  const stalled = stalledS() >= STALL_S;
  const blank = last.fb < 2;
  const why = last.exit.startsWith("guest ended") ? last.exit
    : last.exit ? `firmware exit: ${last.exit.replace(/[\x00-\x1f\xfe\xff]/g, " ")}`
    : errors.length ? errors[0]
    : stalled ? `guest stopped: insns, halts and fb all unchanged for ${stalledS().toFixed(0)}s` +
                ` (${(last.insns / 1e6).toFixed(0)}M insns, ${last.halts} halts, fb ${last.fb})`
    : blank ? "LCD never drew anything"
    : board.minInsns && last.insns < board.minInsns ? `only ${(last.insns / 1e6).toFixed(0)}M insns (need ${board.minInsns / 1e6}M)`
    : "";
  results.push({ id: board.id, pass: !why, why, fb: last.fb, insns: last.insns, vclock: last.vclock });

  const shot = path.join(ROOT, "tests", "results", `bootcheck-${DIST}-${board.id}.png`);
  const lcd = await bounded(page.$("#lcd"), null);
  if (lcd) await bounded(lcd.screenshot({ path: shot, timeout: 15000 }), null);
  await bounded(page.close(), null);
}

await bounded(browser.close(), null, { ms: 30000 });

console.log(`\n| board | ${DIST} | fb | insns | guest s | note |`);
console.log("| ----- | ------- | -- | ----- | ------- | ---- |");
for (const r of results) {
  console.log(`| ${r.id} | ${r.pass ? "PASS" : "FAIL"} | ${r.fb} | ${(r.insns / 1e6).toFixed(0)}M | ` +
    `${r.vclock != null ? r.vclock.toFixed(1) : "-"} | ${r.why} |`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
