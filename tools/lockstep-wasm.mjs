#!/usr/bin/env node
// Lockstep driver, wasm leg (phase-1 gate):
// value-level diff of guest-state digests per executed-insn epoch between
// the native reference JIT (the lockstep.so test plugin) and the wasm64
// backend running in a headless browser (built-in fold, env-driven).
//
//   node tools/lockstep-wasm.mjs                        # 1 run
//   node tools/lockstep-wasm.mjs --runs 3 --par 3       # the gate
//   node tools/lockstep-wasm.mjs --insns 300e6          # short smoke
//   node tools/lockstep-wasm.mjs --keep                 # keep the run dirs
//
// Requires: the wasm64 dist served on --port (see serve.mjs),
// scripts/build-qemu-wasm64.sh output copied to site/dist/, and the
// native reference build from scripts/build-native.sh, up to date with the
// qemu source the dist was built from (checked through the
// qemu-source.txt the server serves for the dist; --a-bin picks another
// build dir, --no-ref-check skips the check for a deliberate cross-version
// comparison).  Both legs boot
// the same fullflash with lockstep.mjs's -accel (the deterministic
// vcpu-timers clock, one insn per TB) and the RTC pinned.
//
// Exit 0 iff every run reached the budget on both legs with the same config
// line, byte-identical serial and identical internal-SRAM digests. The
// register (E) and SDRAM digests are compared but soft: the page's fold
// samples other instructions than the plugin (doc/performance.md, "What
// lockstep-wasm compares"), so their differences are only reported.

import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Side, compareDigestLogs, FLASHES, claimRunStamp, LOCKSTEP_ACCEL, PLUGIN, quitAll, requireLogs } from "./lockstep.mjs";
import { bounded, loadOwnFlash, pageCall, PageUnresponsive } from "./lib/page.mjs";
import { NATIVE_JIT_BIN } from "./lib/build-dirs.mjs";
import { ppmFileToPng } from "./ppm2png.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, "tests", "results"), { recursive: true });
const { inferDevice } = await import(pathToFileURL(path.join(ROOT, "site", "fullflashes.js")).href);

// scripts/run-native.sh's choice: BOARD, else the page's filename rules
const nativeBoard = (flash) =>
  process.env.BOARD || inferDevice(path.basename(flash)) || "siemens-s75";

function parseArgs() {
  const a = {
    runs: 1, par: 1, flash: "s75", insns: 2.5e9, secs: 3600,
    period: 1 << 16, epoch: 1 << 20, meminsns: 1 << 23,
    // SRAM (HARD) + a 1MB SDRAM slice (SOFT): keep the 16MB full-range
    // default out — the M-digest reads were the first full-gate timeout
    mem: "800000+18000:a8000000+100000",
    port: process.env.PORT || "8080", dist: "dist",
    aBin: NATIVE_JIT_BIN,
    label: "wasm",
    env: [],
    refCheck: true,
    keep: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i], num = () => Number(argv[++i]);
    switch (t) {
      case "--runs": a.runs = num(); break;
      case "--par": a.par = num(); break;
      case "--flash": a.flash = argv[++i]; break;
      case "--insns": a.insns = num(); break;
      case "--secs": a.secs = num(); break;
      case "--period": a.period = num(); break;
      case "--epoch": a.epoch = num(); break;
      case "--meminsns": a.meminsns = num(); break;
      case "--mem": a.mem = argv[++i]; break;
      case "--port": a.port = argv[++i]; break;
      case "--dist": a.dist = argv[++i]; break;
      case "--a-bin": a.aBin = argv[++i]; break;
      case "--no-ref-check": a.refCheck = false; break;
      case "--label": a.label = argv[++i]; break;
      case "--keep": a.keep = true; break;
      case "env":
      case "--env": a.env.push(argv[++i]); break;
      default: throw new Error(`unknown arg: ${t}`);
    }
  }
  for (const k of ["runs", "par"]) {
    if (!Number.isInteger(a[k]) || a[k] < 1) {
      console.error(`--${k} must be a whole number of 1 or more, not ${process.argv[process.argv.indexOf("--" + k) + 1]}`);
      process.exit(2);
    }
  }
  return a;
}

const fmt = (n) => n.toLocaleString("en-US");

// --- the browser leg -----------------------------------------------------------
// every page leg started and not yet quit
const liveWasm = new Set();

class WasmSide {
  constructor(name, dir, args) {
    this.name = name;
    this.dir = dir;
    this.args = args;
    this.log = path.join(dir, "ls.log");
    this.serial = path.join(dir, "serial.log");
    this.dead = false;
    this.exitCode = null;
    this.grabbed = false;
    // set once a page call has gone unanswered: no further calls are made
    this.unresponsive = false;
    this.progress = { epoch: -1, insns: 0 };
  }

  // a page call bounded by pageCall(); one that times out marks the page
  // unresponsive, any failure gives fallback
  async call(fn, what, fallback = null, ms) {
    if (this.unresponsive) return fallback;
    try {
      return await pageCall(this.page.evaluate(fn), what, ms);
    } catch (e) {
      if (e instanceof PageUnresponsive) {
        this.unresponsive = true;
        this.errTail = (this.errTail || "") + e.message + "\n";
      }
      return fallback;
    }
  }

  async start(flashPath, port, dist) {
    fs.mkdirSync(this.dir, { recursive: true });
    liveWasm.add(this);
    const q = [
      `dist=${dist}`,
      "lockstep=1",
      // the native leg (scripts/run-native.sh) boots with no audiodev
      "sound=off",
      `ls-insns=${this.args.insns}`,
      `ls-period=${this.args.period}`,
      `ls-epoch=${this.args.epoch}`,
      `ls-meminsns=${this.args.meminsns}`,
      ...(this.args.mem ? [`ls-mem=${encodeURIComponent(this.args.mem)}`] : []),
      "qargs=" + encodeURIComponent(process.env.LS_QARGS ??
        `-accel ${LOCKSTEP_ACCEL} -rtc base=2000-01-01T00:00:00,clock=vm`),
      ...(this.args.env || []).map((e) => "env=" + encodeURIComponent(e)),
    ].join("&");
    // an unknown switch, ignored by chromium; rss() finds this leg's
    // browser by it
    this.browser = await chromium.launch({ headless: true, args: [`--lockstep-leg=${this.dir}`] });
    this.page = await this.browser.newPage({ viewport: { width: 1280, height: 900 } });
    if (process.env.LS_CONSOLE) {
      const cf = fs.openSync(path.join(this.dir, "console.log"), "w");
      this.page.on("console", (m) => fs.writeSync(cf, m.text().slice(0, 300) + "\n"));
    }
    this.page.on("pageerror", (e) => {
      this.errTail = (this.errTail || "") + String(e).slice(0, 400) + "\n";
    });
    this.browser.on("crash", () => {
      this.errTail = (this.errTail || "") + "BROWSER CRASHED (renderer OOM?)\n";
    });
    // backup log channel (the primary is page-FS grab at exited status)
    this.done = new Promise((res) => {
      this.report = res;
    });
    await this.page.exposeFunction("__lockstepReport", (serial, lslog, code) => {
      if (!this.grabbed) {
        if (serial != null) fs.writeFileSync(this.serial, serial, "latin1");
        if (lslog != null) fs.writeFileSync(this.log, lslog, "latin1");
      }
      this.exitCode = code;
      this.report();
    });
    await this.page.goto(`http://127.0.0.1:${port}/?${q}`,
      { waitUntil: "domcontentloaded", timeout: 120000 });
    // nor with the GSM cell, which the page adds by default on a board with
    // a radio; on the board run-native.sh boots
    const board = nativeBoard(flashPath);
    // with the EFA sidecar when there is one: the native leg's flash device
    // loads <fullflash>.cfi-efa by itself (cfi-flash.c), and an LG image
    // without it factory-resets its EEPROM
    const efa = flashPath + ".cfi-efa";
    const files = fs.existsSync(efa) ? [flashPath, efa] : [flashPath];
    await loadOwnFlash(this.page, files, { startup: "ONLINE", gsm: false, device: board })
      .catch((e) => {
        throw new Error(`the page did not take ${board}, the native leg's board: ${String(e.message).split("\n")[0]}`);
      });
    // the image as is: the native leg never recalculates the Siemens keys
    const asIs = await this.page.$('input[name="siemens-mode"][value="as-is"]');
    if (asIs) await asIs.check();
    await this.page.waitForFunction((d) => window.__ui.ready && window.__ui.device === d, board,
                                    { timeout: 30000 });
    await this.page.click("#btn-start");
  }

  poll() {
    let txt;
    try {
      txt = fs.readFileSync(this.log, "utf8");
    } catch {
      return;
    }
    this.absorb(txt);
  }

  // total RSS (MB) of this leg's chromium process tree — the renderer
  // OOM metric (the wasm64 heap lives there).  playwright-core here has
  // no browser.process(), so find the chromium root among the driver's
  // own children by comm and by this leg's --lockstep-leg switch, and walk
  // its subtree.
  isMine(pid) {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
        .includes(`--lockstep-leg=${this.dir}`);
    } catch {
      return false;
    }
  }

  rss() {
    try {
      const out = execSync("ps -eo pid=,ppid=,rss=,comm=", { encoding: "ascii" });
      const kids = new Map();
      const roots = [];
      for (const line of out.trim().split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const r = { pid: +m[1], ppid: +m[2], rss: +m[3], comm: m[4] };
        if (!kids.has(r.ppid)) kids.set(r.ppid, []);
        kids.get(r.ppid).push(r);
        if (r.ppid === process.pid && /chrome|headless/.test(r.comm) &&
            this.isMine(r.pid)) {
          roots.push(r.pid);
        }
      }
      let sum = 0;
      const walk = (pid) => {
        for (const r of kids.get(pid) || []) {
          sum += r.rss;
          walk(r.pid);
        }
      };
      for (const root of roots) {
        walk(root);
      }
      return roots.length ? Math.round(sum / 1024) : null;
    } catch {
      return null;
    }
  }

  absorb(txt) {
    for (const line of txt.split("\n")) {
      if (!line.startsWith("E ")) continue;
      const f = line.split(" ");
      const epoch = Number(f[2]), insns = Number(f[3]);
      if (Number.isFinite(epoch)) this.progress = { epoch, insns };
    }
  }

  // live progress: read the E-line tail of /lockstep.log straight out of
  // the page FS while the run is going (the fold fflushes E-lines; MEMFS
  // writes from the program thread are visible on the main thread).  This
  // is what makes a wall-timeout diagnosable instead of a blind 45-min hole.
  async pollPage() {
    if (this.grabbed || !this.page || this.unresponsive) return;
    // never let a busy page stall the driver loop; waitExited() is what
    // calls a page that stays silent unresponsive
    const tail = await bounded(this.page.evaluate(() => {
      const m = window.__qemu;
      if (!m || !m.FS) return null;
      try {
        const bytes = m.FS.readFile("/lockstep.log");
        return new TextDecoder("latin1")
          .decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
      } catch { return null; }
    }), null, { ms: 5000 });
    if (tail != null) this.absorb(tail);
  }

  // grab the finished logs out of the page FS (works while the runtime
  // is torn down but the page is still up; the onExit hook is a backup)
  async grab() {
    if (this.grabbed) return;
    const rd = await this.call(() => {
      const m = window.__qemu;
      if (!m || !m.FS) return null;
      const f = (p) => {
        try { return m.FS.readFile(p, { encoding: "binary" }); }
        catch { return null; }
      };
      return { serial: f("/serial.log"), ls: f("/lockstep.log") };
    }, "the log grab");
    if (rd) {
      this.grabbed = true;
      if (rd.ls != null) fs.writeFileSync(this.log, rd.ls, "latin1");
      if (rd.serial != null) fs.writeFileSync(this.serial, rd.serial, "latin1");
    }
  }

  async waitExited() {
    for (;;) {
      const st = await this.call(() => {
        const el = document.querySelector("#status");
        return el ? { exitCode: window.__ui?.exitCode ?? null, cls: el.className || "" } : null;
      }, "the status read");
      if (!st || st.exitCode != null || /error/i.test(st.cls)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    for (let i = 0; i < 40 && !this.grabbed && !this.unresponsive; i++) {
      await this.grab();
      if (!this.grabbed) await new Promise((r) => setTimeout(r, 250));
    }
    this.poll();
    this.dead = true;
  }

  async quit() {
    if (!liveWasm.delete(this)) return;
    if (this.page && !this.unresponsive) {
      // final screenshot of the wasm leg (saved into the run dir, the
      // driver copies it to tests/results next to the JSON)
      await bounded((async () => {
        await this.page.screenshot({ path: path.join(this.dir, "final.png") });
        const lcd = await this.page.$("#lcd");
        if (lcd) await lcd.screenshot({ path: path.join(this.dir, "final-lcd.png") });
      })(), null, { ms: 10000 });
    }
    if (this.browser) {
      await bounded(this.browser.close(), null, { ms: 30000 });
    }
  }
}

class StartError extends Error {}

async function runPairWasm(args, flashPath, dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  const common = { period: args.period, epoch: args.epoch,
                   meminsns: args.meminsns, mem: args.mem };
  const a = new Side("a", args.aBin, path.join(dir, "a"),
                     { ...common, stopAt: args.insns });
  const b = new WasmSide("b", path.join(dir, "b"),
                         { ...common, insns: args.insns, env: args.env });
  await a.start(flashPath);
  try {
    await b.start(flashPath, args.port, args.dist);
  } catch (e) {
    await b.quit();
    await a.quit("page leg failed to start");
    fs.rmSync(dir, { recursive: true, force: true });
    throw new StartError(String(e.message || e).split("\n")[0]);
  }

  const t0 = Date.now();
  let stopped = false;
  let lastStatus = 0;
  let timedOut = false;
  const bExited = b.waitExited().then(() => log("   b: wasm leg exited"));
  for (;;) {
    a.poll();
    await b.pollPage();
    if (Date.now() - lastStatus > 30000) {
      lastStatus = Date.now();
      log(`   [${Math.round((Date.now() - t0) / 1000)}s] a ${fmt(a.progress.insns)} insns / b ${fmt(b.progress.insns)} insns / b-rss ${b.rss() ?? "?"}MB`);
    }
    // throttle the (faster) native side once it crosses the budget
    if (!stopped && a.progress.insns >= args.insns && a.conn) {
      a.conn.write("stop\n");
      stopped = true;
    }
    try { await Promise.race([bExited, new Promise((r) => setTimeout(r, 1000))]); } catch {}
    if (b.dead) break;
    if (Date.now() - t0 > args.secs * 1000) {
      log(`!! wall timeout ${args.secs}s (a insns=${fmt(a.progress.insns)}, b insns=${fmt(b.progress.insns)})`);
      timedOut = true;
      break;
    }
  }
  // even on timeout, salvage whatever the wasm leg produced so far
  await b.grab().catch(() => {});
  b.poll();
  await b.quit();
  await a.quit("budget");
  // the loop stops reading a's log once b exits, which can be first
  a.poll();
  // the last E-line either leg can write is the last whole epoch of the budget
  const need = Math.floor(args.insns / args.epoch) * args.epoch;
  const reasons = [
    timedOut ? `wall timeout ${args.secs}s` : null,
    b.unresponsive ? "the page stopped answering (main thread frozen?)" : null,
    ...[a, b].filter((s) => s.progress.insns < need)
      .map((s) => `${s.name} stopped at ${fmt(s.progress.insns)} insns, short of ${fmt(need)}`),
  ].filter(Boolean);
  return { a, b, reasons, wallS: (Date.now() - t0) / 1000 };
}

// --- driver --------------------------------------------------------------------
const args = parseArgs();
const log = (m) => console.log(m);
const flash = FLASHES[args.flash] ? path.join(ROOT, FLASHES[args.flash])
  : (fs.existsSync(args.flash) ? path.resolve(args.flash) : null);
if (!flash) {
  console.error(`unknown flash: ${args.flash}`);
  process.exit(2);
}
if (!fs.existsSync(args.aBin)) {
  console.error(`native reference binary missing: ${args.aBin} (scripts/build-native.sh)`);
  process.exit(2);
}
if (!fs.existsSync(PLUGIN)) {
  console.error(`plugin missing: ${PLUGIN} (scripts/build-plugins.sh builds it)`);
  process.exit(2);
}
// The reference must be built from the source the dist was built from: one
// made from other code diverges on every guest-timing change, or agrees with
// code the dist no longer has.  --no-ref-check compares regardless.
if (args.refCheck) {
  const refFail = (m) => {
    console.error(`native reference check: ${m}`);
    process.exit(2);
  };
  const stamp = (file, hint) => {
    if (!fs.existsSync(file)) refFail(`${file} missing — ${hint}`);
    return fs.readFileSync(file, "utf8").trim();
  };
  // the dist the page will run is the one the server serves, which need not
  // be this checkout's
  const servedUrl = `http://127.0.0.1:${args.port}/${args.dist}/qemu-source.txt`;
  const res = await fetch(servedUrl, { signal: AbortSignal.timeout(15000) })
    .catch((e) => refFail(`cannot read ${servedUrl}: ${e.cause?.code || e.message}`));
  if (!res.ok) refFail(`${servedUrl}: HTTP ${res.status} — redeploy the dist (scripts/ninja-fast.sh)`);
  const distSrc = (await res.text()).trim();
  const refSrc = stamp(path.join(path.dirname(args.aBin), "qemu-source.txt"),
    "rebuild the reference (scripts/build-native.sh)");
  if (refSrc !== distSrc)
    refFail(`the ${args.dist} served on ${args.port} is built from qemu ${distSrc.slice(0, 80)},` +
      ` the reference from ${refSrc} (scripts/build-native.sh builds qemu/ as checked out)`);
  log(`native reference: ${args.aBin} (qemu ${refSrc})`);
}

const stamp = claimRunStamp(args.label);
const baseDir = `/tmp/lockstep-${args.label}-${stamp}`;
const results = [];
let fail = false;

const worker = async (wi) => {
  for (let r = wi; r < args.runs; r += args.par) {
    try {
      await oneRun(r);
    } catch (e) {
      // this run failed; the others go on, and every leg still up is quit
      // at the end
      fail = true;
      const msg = String(e?.message || e).split("\n")[0];
      log(`!! run ${r + 1} failed: ${msg}`);
      results.push({ run: r + 1, error: msg, earlyExit: [msg], cmp: null, serialIdentical: null });
    }
  }
};

const oneRun = async (r) => {
  const dir = path.join(baseDir, `run${r}`);
  log(`== run ${r + 1}/${args.runs}: JIT(native) vs wasm64(browser) flash=${args.flash} budget=${fmt(args.insns)} insns`);
  let pair;
  try {
    pair = await runPairWasm(args, flash, dir, log);
  } catch (e) {
    if (!(e instanceof StartError)) throw e;
    fail = true;
    log(`!! run ${r + 1}: the page leg did not start: ${e.message}`);
    results.push({ run: r + 1, startError: e.message, earlyExit: [], cmp: null, serialIdentical: null });
    return;
  }
  const { a, b, reasons, wallS } = pair;
  // end-state screenshots -> tests/results: the wasm leg's page + LCD
  // crop, plus the native leg's screendump when it's still around at
  // quit time (the plugin's stop_at normally self-exits it first)
  const screenshots = {};
  const aPng = ppmFileToPng(path.join(a.dir, "final.ppm"));
  if (aPng) {
    const out = path.join(ROOT, "tests", "results",
      `lockstep-${args.label}-${stamp}-run${r + 1}-a.png`);
    fs.writeFileSync(out, aPng);
    screenshots.a = out;
  }
  for (const suffix of ["", "-lcd"]) {
    const f = path.join(b.dir, `final${suffix}.png`);
    if (fs.existsSync(f)) {
      const out = path.join(ROOT, "tests", "results",
        `lockstep-${args.label}-${stamp}-run${r + 1}-b${suffix}.png`);
      fs.copyFileSync(f, out);
      screenshots[suffix ? "bLcd" : "b"] = out;
    }
  }
  const runRes = {
    run: r + 1, dir, wallS, screenshots,
    a: { insns: a.progress.insns, epoch: a.progress.epoch, exit: a.exitCode },
    b: { insns: b.progress.insns, epoch: b.progress.epoch, exit: b.exitCode },
    earlyExit: reasons, cmp: null, serialIdentical: null,
  };
  try {
    runRes.serialIdentical =
      fs.readFileSync(a.serial).equals(fs.readFileSync(b.serial));
  } catch { runRes.serialIdentical = null; }
  requireLogs(a);
  if (!fs.existsSync(b.log)) {
    fail = true;
    log(`!! wasm leg produced no lockstep log — ${dir}/b (status/error?)`);
    log(`   b last progress: insns=${fmt(b.progress.insns)} epoch=${b.progress.epoch}`);
    log(`   b page errors: ${(b.errTail || "").slice(-400)}`);
    results.push(runRes);
    return;
  }
  // HARD: config, serial, internal-SRAM (range 0). SOFT (opts below):
  // register E-lines + the SDRAM slice, sampled at other instructions on
  // the wasm leg (doc/performance.md, "What lockstep-wasm compares").
  const cmp = compareDigestLogs(a.log, b.log, { soft: ["epoch", "mem-sdram"] });
  const serialFail = runRes.serialIdentical !== true;
  runRes.cmp = { commonEpochs: cmp.commonEpochs, commonSram: cmp.commonSram,
                 commonSdram: cmp.commonSdram, commonMem: cmp.commonMem,
                 truncated: cmp.truncated,
                 diverged: cmp.diverged && { ...cmp.diverged, lineA: undefined, lineB: undefined },
                 soft: (cmp.soft || []).map((s) => ({ ...s, lineA: undefined, lineB: undefined })) };
  log(`   a: ${fmt(a.progress.insns)} insns / epoch ${a.progress.epoch}` +
      `   b: ${fmt(b.progress.insns)} insns / epoch ${b.progress.epoch}` +
      `   wall ${wallS.toFixed(0)}s   serial ${runRes.serialIdentical ? "identical"
        : runRes.serialIdentical === false ? "DIFFERS" : "UNREADABLE"}`);
  if (serialFail) {
    fail = true;
    log(runRes.serialIdentical === false
      ? `!! SERIAL DIVERGENCE run ${r + 1}: the two legs' serial output differs (real bug)`
      : `!! run ${r + 1}: a leg's serial log could not be read, so serial was not compared`);
  }
  if (reasons.length) {
    fail = true;
    log(`!! run ${r + 1} did not run the whole budget: ${reasons.join("; ")}`);
  }
  if (cmp.diverged) {
    fail = true;
    log(`!! DIVERGENCE run ${r + 1}: ${cmp.diverged.kind}` +
        (cmp.diverged.kind === "mem"
          ? ` @ insns=${fmt(cmp.diverged.insnsA)} (internal SRAM digest), differing: ${(cmp.diverged.fields || []).join(", ")}`
          : cmp.diverged.kind === "epoch"
            ? ` @ epoch ${cmp.diverged.epoch}`
            : ""));
    log(`   a: ${cmp.diverged.lineA}`);
    log(`   b: ${cmp.diverged.lineB}`);
  } else if (cmp.commonSram === 0 && cmp.commonEpochs === 0) {
    fail = true;
    log(`!! no comparable digests (wasm fold output missing? dist on the server?) — ${dir}`);
    log(`   a stderr tail: ${(a.errTail || "").split("\n").slice(-5).join("\n")}`);
    log(`   b page errors: ${(b.errTail || "").slice(-400)}`);
  } else if (!serialFail && !reasons.length) {
    const softN = (cmp.soft || []).length;
    log(`   HARD ok: ${cmp.commonSram} internal-SRAM digests + serial identical` +
        (cmp.commonSdram != null ? ` ; ${cmp.commonSdram} SDRAM identical` : "")
        + (cmp.commonEpochs ? ` ; ${cmp.commonEpochs} epochs regs identical` : "")
        + (softN ? ` ; SOFT(fold count drift): ${softN} E/SDRAM diffs` : "")
        + (cmp.truncated ? " (tail truncated by stop point)" : ""));
  }
  results.push(runRes);
};

const workers = [];
try {
  for (let w = 0; w < Math.min(args.par, args.runs); w++) workers.push(worker(w));
  await Promise.all(workers);
} finally {
  await Promise.all([quitAll("driver ending"), ...[...liveWasm].map((b) => b.quit())]);
}
if (results.length < args.runs) {
  fail = true;
  log(`!! only ${results.length} of ${args.runs} runs have a result`);
}

function cleanRun(r) {
  return r.cmp && !r.cmp.diverged && r.serialIdentical === true && !r.earlyExit.length;
}

const summary = {
  label: args.label, stamp, flash: args.flash, wasmLeg: true,
  aBin: args.aBin, dist: args.dist,
  insns: args.insns, period: args.period, epoch: args.epoch,
  meminsns: args.meminsns, mem: args.mem,
  runs: results.length, clean: results.filter(cleanRun).length,
  results,
};
const resFile = path.join(ROOT, "tests", "results", `lockstep-${args.label}-${stamp}.json`);
fs.mkdirSync(path.dirname(resFile), { recursive: true });
fs.writeFileSync(resFile, JSON.stringify(summary, null, 1) + "\n");
log(`== ${results.filter(cleanRun).length}/${results.length} runs clean; results: ${resFile}`);
// the logs of a failed run are kept for the diagnosis
if (!fail && !args.keep) fs.rmSync(baseDir, { recursive: true, force: true });
else try { fs.rmdirSync(baseDir); } catch {}
if (fs.existsSync(baseDir)) log(`== run dirs under ${baseDir} (tmp — remove when done)`);

process.exit(fail ? 1 : 0);
