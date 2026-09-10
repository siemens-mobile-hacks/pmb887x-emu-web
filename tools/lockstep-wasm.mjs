#!/usr/bin/env node
// Lockstep driver, wasm leg (phase-1 gate, doc/wasm-tcg-backend-plan.md §5):
// value-level diff of guest-state digests per executed-insn epoch between
// the native reference JIT (tests/lockstep.so plugin) and the wasm64
// backend running in a headless browser (built-in fold, env-driven).
//
//   node tools/lockstep-wasm.mjs                        # 1 run
//   node tools/lockstep-wasm.mjs --runs 3 --par 3       # the gate
//   node tools/lockstep-wasm.mjs --insns 300e6          # short smoke
//
// Requires: the wasm64 dist served on --port (see scripts/serve.mjs),
// scripts/build-qemu-wasm64.sh output copied to site/dist-jit/, and the
// native reference build from scripts/build-native.sh.  Both legs boot
// the same fullflash with -accel tcg,one-insn-per-tb=on and the RTC
// pinned (determinism prerequisites from phase 0b).
//
// Exit 0 iff every run was divergence-free (E/M digests identical,
// serial byte-identical).

import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Side, compareDigestLogs, FLASHES } from "./lockstep.mjs";
import { fullflash } from "./testflash.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs() {
  const a = {
    runs: 1, par: 1, flash: "s75", insns: 2.5e9, secs: 3600,
    period: 1 << 16, epoch: 1 << 20, meminsns: 1 << 23,
    // SRAM (HARD) + a 1MB SDRAM slice (SOFT): keep the 16MB full-range
    // default out — the M-digest reads were the first full-gate timeout
    mem: "800000+18000:a8000000+100000",
    port: process.env.PORT || "8094", dist: "dist-jit",
    aBin: path.join(ROOT, "build/qemu-native-build/qemu-system-arm"),
    label: "wasm",
    env: [],
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
      case "--label": a.label = argv[++i]; break;
      case "env":
      case "--env": a.env.push(argv[++i]); break;
      default: throw new Error(`unknown arg: ${t}`);
    }
  }
  return a;
}

const fmt = (n) => n.toLocaleString("en-US");

// --- the browser leg -----------------------------------------------------------
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
    this.progress = { epoch: -1, insns: 0 };
  }

  async start(flashPath, port, dist) {
    fs.mkdirSync(this.dir, { recursive: true });
    const q = [
      `dist=${dist}`,
      "lockstep=1",
      `ls-insns=${this.args.insns}`,
      `ls-period=${this.args.period}`,
      `ls-epoch=${this.args.epoch}`,
      `ls-meminsns=${this.args.meminsns}`,
      ...(this.args.mem ? [`ls-mem=${encodeURIComponent(this.args.mem)}`] : []),
      "qargs=" + encodeURIComponent(
        "-accel tcg,one-insn-per-tb=on -rtc base=2000-01-01T00:00:00,clock=vm"),
      ...(this.args.env || []).map((e) => "env=" + encodeURIComponent(e)),
    ].join("&");
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage({ viewport: { width: 1280, height: 900 } });
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
    await this.page.selectOption("#startup", "ONLINE");
    await this.page.setInputFiles("#fullflash", flashPath);
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
  // own children by comm and walk its subtree.
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
        if (r.ppid === process.pid && /chrome|headless/.test(r.comm)) {
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
    if (this.grabbed || !this.page) return;
    try {
      const p = this.page.evaluate(() => {
        const m = window.__qemu;
        if (!m || !m.FS) return null;
        try {
          const bytes = m.FS.readFile("/lockstep.log");
          return new TextDecoder("latin1")
            .decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
        } catch { return null; }
      });
      // never let a busy page stall the driver loop
      const tail = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), 5000))]);
      if (tail != null) this.absorb(tail);
    } catch { /* page mid-teardown */ }
  }

  // grab the finished logs out of the page FS (works while the runtime
  // is torn down but the page is still up; the onExit hook is a backup)
  async grab() {
    if (this.grabbed) return;
    const rd = await this.page.evaluate(() => {
      const m = window.__qemu;
      if (!m || !m.FS) return null;
      const f = (p) => {
        try { return m.FS.readFile(p, { encoding: "binary" }); }
        catch { return null; }
      };
      return { serial: f("/serial.log"), ls: f("/lockstep.log") };
    }).catch(() => null);
    if (rd) {
      this.grabbed = true;
      if (rd.ls != null) fs.writeFileSync(this.log, rd.ls, "latin1");
      if (rd.serial != null) fs.writeFileSync(this.serial, rd.serial, "latin1");
    }
  }

  async waitExited() {
    for (;;) {
      const st = await this.page.evaluate(() => {
        const el = document.querySelector("#status");
        return el ? { text: el.textContent || "", cls: el.className || "" } : null;
      }).catch(() => null);
      if (!st || st.text.includes("exited") || /error/i.test(st.cls)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    for (let i = 0; i < 40 && !this.grabbed; i++) {
      await this.grab();
      if (!this.grabbed) await new Promise((r) => setTimeout(r, 250));
    }
    this.poll();
    this.dead = true;
  }

  async quit() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
  }
}

async function runPairWasm(args, flashPath, dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  const common = { period: args.period, epoch: args.epoch,
                   meminsns: args.meminsns, mem: args.mem };
  const a = new Side("a", args.aBin, path.join(dir, "a"),
                     { ...common, stopAt: args.insns });
  const b = new WasmSide("b", path.join(dir, "b"), { ...common, insns: args.insns });
  await a.start(flashPath);
  await b.start(flashPath, args.port, args.dist);

  const t0 = Date.now();
  let stopped = false;
  let lastStatus = 0;
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
      break;
    }
  }
  // even on timeout, salvage whatever the wasm leg produced so far
  await b.grab().catch(() => {});
  b.poll();
  await b.quit();
  const reasons = [`a insns=${a.progress.insns}`, `b insns=${b.progress.insns}`];
  await a.quit("budget");
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

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const baseDir = `/tmp/lockstep-${args.label}-${stamp}`;
const results = [];
let fail = false;

const worker = async (wi) => {
  for (let r = wi; r < args.runs; r += args.par) {
    const dir = path.join(baseDir, `run${r}`);
    log(`== run ${r + 1}/${args.runs}: JIT(native) vs wasm64(browser) flash=${args.flash} budget=${fmt(args.insns)} insns`);
    const { a, b, wallS } = await runPairWasm(args, flash, dir, log);
    const runRes = {
      run: r + 1, dir, wallS,
      a: { insns: a.progress.insns, epoch: a.progress.epoch, exit: a.exitCode },
      b: { insns: b.progress.insns, epoch: b.progress.epoch, exit: b.exitCode },
      cmp: null, serialIdentical: null,
    };
    try {
      runRes.serialIdentical =
        fs.readFileSync(a.serial).equals(fs.readFileSync(b.serial));
    } catch { runRes.serialIdentical = null; }
    if (!fs.existsSync(b.log)) {
      fail = true;
      log(`!! wasm leg produced no lockstep log — ${dir}/b (status/error?)`);
      log(`   b last progress: insns=${fmt(b.progress.insns)} epoch=${b.progress.epoch}`);
      log(`   b page errors: ${(b.errTail || "").slice(-400)}`);
      results.push(runRes);
      continue;
    }
    // HARD: config, serial, internal-SRAM (range 0). SOFT (opts below):
    // register E-lines + the SDRAM slice — the emscripten threading race.
    const cmp = compareDigestLogs(a.log, b.log, { soft: ["epoch", "mem-sdram"] });
    const serialFail = runRes.serialIdentical === false;
    runRes.cmp = { commonEpochs: cmp.commonEpochs, commonSram: cmp.commonSram,
                   commonSdram: cmp.commonSdram, commonMem: cmp.commonMem,
                   truncated: cmp.truncated,
                   diverged: cmp.diverged && { ...cmp.diverged, lineA: undefined, lineB: undefined },
                   soft: (cmp.soft || []).map((s) => ({ ...s, lineA: undefined, lineB: undefined })) };
    log(`   a: ${fmt(a.progress.insns)} insns / epoch ${a.progress.epoch}` +
        `   b: ${fmt(b.progress.insns)} insns / epoch ${b.progress.epoch}` +
        `   wall ${wallS.toFixed(0)}s   serial ${runRes.serialIdentical ? "identical" : "DIFFERS"}`);
    if (serialFail) {
      fail = true;
      log(`!! SERIAL DIVERGENCE run ${r + 1}: the two legs' serial output differs (real bug)`);
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
    } else {
      const softN = (cmp.soft || []).length;
      log(`   HARD ok: ${cmp.commonSram} internal-SRAM digests + serial identical` +
          (cmp.commonSdram != null ? ` ; ${cmp.commonSdram} SDRAM identical` : "")
          + (cmp.commonEpochs ? ` ; ${cmp.commonEpochs} epochs regs identical` : "")
          + (softN ? ` ; SOFT(timing-race): ${softN} E/SDRAM diffs` : "")
          + (cmp.truncated ? " (tail truncated by stop point)" : ""));
    }
    results.push(runRes);
  }
};

const workers = [];
for (let w = 0; w < Math.min(args.par, args.runs); w++) workers.push(worker(w));
await Promise.all(workers);

const summary = {
  label: args.label, stamp, flash: args.flash, wasmLeg: true,
  aBin: args.aBin, dist: args.dist,
  insns: args.insns, period: args.period, epoch: args.epoch,
  meminsns: args.meminsns, mem: args.mem,
  runs: results.length, clean: results.filter((r) => r.cmp && !r.cmp.diverged && r.serialIdentical).length,
  results,
};
const resFile = path.join(ROOT, "tests", "results", `lockstep-${args.label}-${stamp}.json`);
fs.mkdirSync(path.dirname(resFile), { recursive: true });
fs.writeFileSync(resFile, JSON.stringify(summary, null, 1) + "\n");
log(`== ${results.filter((r) => r.cmp && !r.cmp.diverged && r.serialIdentical).length}/${results.length} runs clean; results: ${resFile}`);
log(`== run dirs under ${baseDir} (tmp — remove when done)`);

process.exit(fail ? 1 : 0);
