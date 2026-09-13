// wasm boot gate: boot every fullflash on one dist and check it gets
// somewhere, the way tests/run.mjs does for the native build.
//
// The native suite (tests/run.mjs) is the correctness reference; this is
// its browser twin, because most of the wasm patches (io barriers, the
// wasm64 backend, the halt/idle paths) are invisible to it.  Three boards
// is the useful set: S75 and EL71 are icount boards that exercise
// different firmware paths (EL71 programs its flash file system during
// boot — the 0034 retaddr bug only ever showed there), KE800 is the LG
// board and the only one that boots without icount.
//
//   node tools/bootcheck.mjs [--dist dist-jit] [--secs 150] [--flash id,id]
//
// PASS for a board = no firmware ">>EXIT<<" on the serial log, no page
// error / wasm abort, the LCD drew something, and the guest kept
// executing.  Progress is measured in instructions, not framebuffer
// updates: EL71 stops at a "set time and date?" wizard (a static screen
// that never redraws) and is perfectly healthy there, while a KE800 stuck
// on a device poll it can never satisfy stops executing altogether.
// Exit 0 iff every board passed.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? argv[i + 1] : d;
};

const DIST = opt("dist", "dist-jit");
const SECS = Number(opt("secs", 150));
const PORT = process.env.PORT || "8080";
const ONLY = opt("flash", "").split(",").filter(Boolean);
// --query "trace=dsp&tracebuf=1": extra page parameters for every board;
// with tracebuf=1 the page keeps qemu's stderr in window.__qemulog and
// each board's tail is saved next to the screenshot (device-trace diffs
// between dists / page orders are how timing-sensitive boot failures get
// pinned down).
const QUERY = opt("query", "");

const BOARDS = [
  { id: "s75", file: "s75_working20060710172101.bin" },
  { id: "el71", file: "rr_ff_el71_stock.bin" },
  { id: "ke800", file: "KE800-v11b.bin", efa: "KE800-v11b.bin.cfi-efa" },
].filter((b) => (ONLY.length ? ONLY.includes(b.id) : true));

// Progress = executed instructions or a framebuffer update.  A board is
// only failed when *neither* moves for this long: KE800 spends minutes
// around its GSM L1 sync mostly halted, executing well under a million
// instructions per poll while it waits on radio-frame timing, and that is
// healthy — what is not is a guest wedged on a device poll it can never
// satisfy (both counters pinned, as KE800 was before 0035/0037/0038).
const STALL_S = 150;
const STALL_INSNS = 1e6;

const probe = () => {
  const m = window.__qemu;
  let ser = "";
  try { ser = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); } catch {}
  return {
    fb: m?._wasm_fb_updates ? Number(m._wasm_fb_updates()) : 0,
    insns: m?._wasm_insns ? Number(m._wasm_insns()) : 0,
    exit: (ser.match(/>>EXIT<<[^\x00]{0,120}/) || [""])[0],
  };
};

const browser = await chromium.launch({ headless: true });
const results = [];

for (const board of BOARDS) {
  const files = [path.join(ROOT, "fullflashes", board.file)];
  if (board.efa) files.push(path.join(ROOT, "fullflashes", board.efa));
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`fullflash not found: ${f}`);
  }

  const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("crash", () => errors.push("page crashed"));
  page.on("console", (m) => {
    const t = m.text();
    if (/Aborted\(|Assertion failed|RuntimeError/.test(t)) errors.push(t.slice(0, 200));
  });

  await page.goto(`http://127.0.0.1:${PORT}/?dist=${DIST}${QUERY ? "&" + QUERY : ""}`,
                  { waitUntil: "domcontentloaded" });
  await page.selectOption("#startup", "ONLINE");
  await page.setInputFiles("#fullflash", files);
  await page.click("#btn-start");

  let last = { fb: 0, insns: 0, exit: "" };
  let lastProgress = { t: Date.now(), insns: 0 };
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < SECS && !last.exit && !errors.length) {
    await new Promise((r) => setTimeout(r, 10000));
    // A frozen page (the pre-0034 KE800 deadlocked the renderer) makes
    // evaluate hang forever, so bound it and treat a timeout as a failure.
    const mx = await Promise.race([
      page.evaluate(probe).catch((e) => ({ err: String(e).slice(0, 120) })),
      new Promise((r) => setTimeout(() => r({ err: "page unresponsive" }), 20000)),
    ]);
    if (mx.err) { errors.push(mx.err); break; }
    if (mx.insns - lastProgress.insns >= STALL_INSNS || mx.fb !== last.fb) {
      lastProgress = { t: Date.now(), insns: mx.insns };
    }
    last = mx;
    console.log(`[${board.id}] t=${((Date.now() - t0) / 1000).toFixed(0)}s ` +
                `insns=${(mx.insns / 1e6).toFixed(0)}M fb=${mx.fb}${mx.exit ? " *** EXIT ***" : ""}`);
    if ((Date.now() - lastProgress.t) / 1000 > STALL_S) break;
  }

  if (last.exit) {
    // The firmware's panic text trails the marker and is usually still
    // in the guest's UART FIFO when the marker is first seen: wait, then
    // keep the serial tail next to the screenshot for the post-mortem.
    await new Promise((r) => setTimeout(r, 3000));
    const tail = await page.evaluate(() => {
      try {
        const s = new TextDecoder("latin1").decode(window.__qemu.FS.readFile("/serial.log"));
        return s.slice(-4096);
      } catch { return ""; }
    }).catch(() => "");
    const serPath = path.join(ROOT, "tests", "results", `bootcheck-${DIST}-${board.id}-serial.txt`);
    fs.writeFileSync(serPath, tail);
    const printable = tail.replace(/[\x00-\x09\x0b-\x1f\x7f-\xff]/g, " ");
    console.log(`[${board.id}] serial tail (${serPath}):`);
    for (const l of printable.split("\n").filter((l) => l.trim()).slice(-6)) console.log(`   | ${l.slice(0, 160)}`);
    last.exit = (printable.match(/>>EXIT<<[^\n]{0,120}/) || [last.exit])[0];
  }

  if (/(^|&)tracebuf=1/.test(QUERY)) {
    const lines = await page.evaluate(() => (window.__qemulog || []).slice(-30000)).catch(() => []);
    const tracePath = path.join(ROOT, "tests", "results", `bootcheck-${DIST}-${board.id}-trace.txt`);
    fs.writeFileSync(tracePath, lines.join("\n") + "\n");
    console.log(`[${board.id}] trace: ${lines.length} lines -> ${tracePath}`);
  }

  const stalled = (Date.now() - lastProgress.t) / 1000 > STALL_S;
  const blank = last.fb < 2;
  const why = last.exit ? `firmware exit: ${last.exit.replace(/[\x00-\x1f\xfe\xff]/g, " ")}`
    : errors.length ? errors[0]
    : stalled ? `no progress for ${STALL_S}s (<${STALL_INSNS / 1e6}M insns, no fb update)`
    : blank ? "LCD never drew anything"
    : "";
  results.push({ id: board.id, pass: !why, why, fb: last.fb, insns: last.insns });

  const shot = path.join(ROOT, "tests", "results", `bootcheck-${DIST}-${board.id}.png`);
  const lcd = await page.$("#lcd");
  if (lcd) await lcd.screenshot({ path: shot }).catch(() => {});
  await page.close();
}

await browser.close();

console.log(`\n| board | ${DIST} | fb | insns | note |`);
console.log("| ----- | ------- | -- | ----- | ---- |");
for (const r of results) {
  console.log(`| ${r.id} | ${r.pass ? "PASS" : "FAIL"} | ${r.fb} | ${(r.insns / 1e6).toFixed(0)}M | ${r.why} |`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
