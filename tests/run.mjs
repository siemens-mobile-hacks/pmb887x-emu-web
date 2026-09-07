// Test suite + benchmark for the pmb887x emulator (native build).
//
// Boots every "currently working" fullflash (s75, el71, c81) in parallel
// with scripts/run-native.sh's boot recipe (same -icount, OTP env, etc),
// drives the HMP monitor for progress signals, and checks:
//
//   1. boot-init    board config parses, no hw_error, guest executes
//                   (>10M insns in the first 15 s), process alive
//   2. boot-progress  LCD lights up and shows content (or serial talks),
//                   no firmware ">>EXIT<<" — within --timeout seconds
//   3. benchmark    executed guest instructions over a fixed wall-time
//                   window (--bench-secs, TCG insncount plugin) => MIPS,
//                   plus time-to-milestone for serial/LCD/activity
//
// Usage:
//   node tests/run.mjs [--label NAME] [--timeout SECS] [--bench-secs SECS]
//                      [--parallel N] [--out FILE] [--flash id[,id...]]
//                      [--keep]   (keep run dirs under /tmp)
//
// Env: QEMU_BIN + BOARDS_DIR are forwarded to run-native.sh (defaults:
// build/qemu-native-build + build/bsp of this workspace).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";

// --- CLI -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes("--" + name);

const LABEL = opt("label", "run");
const TIMEOUT = Number(opt("timeout", 180));
const BENCH_SECS = Number(opt("bench-secs", 45));
const POLL_MS = Number(opt("poll-ms", 3000));
const INIT_SECS = 15;
const INIT_MIN_INSNS = 10e6;
const ONLY = opt("flash", "").split(",").filter(Boolean);
const KEEP = has("keep");
const OUT = opt("out", "");

// --- flash inventory --------------------------------------------------------
// The fullflashes that currently work (README: s75, el71, c81).
const FLASHES = [
  { id: "s75", board: "siemens-s75", file: "s75_working20060710172101.bin" },
  { id: "el71", board: "siemens-el71", file: "rr_ff_el71_stock.bin" },
  { id: "c81", board: "siemens-c81", file: "rrC81 .bin" },
].filter((f) => (ONLY.length ? ONLY.includes(f.id) : true));

for (const f of FLASHES) {
  f.path = path.join(ROOT, "fullflashes", f.file);
  if (!fs.existsSync(f.path)) {
    console.error(`fullflash not found: ${f.path}`);
    process.exit(2);
  }
}

// --- helpers ----------------------------------------------------------------
const fmt = (n) => {
  const x = typeof n === "bigint" ? Number(n) : n;
  return x >= 1e9 ? (x / 1e9).toFixed(2) + "G" : x >= 1e6 ? (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? (x / 1e3).toFixed(0) + "k" : String(x);
};

const ppmStats = (file) => {
  try {
    const b = fs.readFileSync(file);
    const m = b.toString("latin1").match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
    if (!m) return null;
    const w = +m[1], h = +m[2];
    if (+m[3] !== 255) return null;
    const px = b.subarray(Buffer.byteLength(m[0], "latin1"));
    let nonBlack = 0, colorful = 0;
    const n = w * h;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const r = px[j], g = px[j + 1], bch = px[j + 2];
      if (r | g | bch) nonBlack++;
      const mx = Math.max(r, g, bch), mn = Math.min(r, g, bch);
      if (mx - mn >= 40 && mx >= 60) colorful++; // saturated, not gray/white/black
    }
    return { nonBlack, colorful };
  } catch {
    return null;
  }
};

const procCpuSecs = (pid) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const parts = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return (Number(parts[11]) + Number(parts[12])) / 100; // utime+stime, all threads
  } catch {
    return -1;
  }
};

const readInsnFile = (file) => {
  try {
    const m = fs.readFileSync(file, "utf8").trim().match(/^(\S+) (\d+)$/m);
    if (!m) return null;
    const [sec, nsec] = m[1].split(".");
    return { monoNs: BigInt(sec) * 1000000000n + BigInt(nsec || 0), insns: BigInt(m[2]) };
  } catch {
    return null;
  }
};

// --- one emulator instance ---------------------------------------------------
class Instance {
  constructor(flash, runDir) {
    this.flash = flash;
    this.dir = runDir;
    this.serial = path.join(runDir, "serial.log");
    this.monitor = path.join(runDir, "monitor.sock");
    this.insnFile = path.join(runDir, "insns.txt");
    this.events = []; // {t, ev, value}
    this.stderrTail = "";
    this.verdicts = {};
    this.dead = false;
    this.mark("start");
  }

  mark(ev, value = null) {
    this.events.push({ t: Number(process.uptime()), ev, value });
  }

  since(ev) {
    const e = this.events.find((x) => x.ev === ev);
    return e ? e.t - this.events[0].t : null;
  }

  async start() {
    const runNative = path.join(ROOT, "scripts", "run-native.sh");
    this.child = spawn(runNative, [
      this.flash.path,
      "-plugin", `file=${ROOT}/tests/insncount.so,count=${this.insnFile}`,
    ], {
      env: {
        ...process.env,
        BOARD: this.flash.board,
        MONITOR: `unix:${this.monitor}`,
        SERIAL: this.serial,
        DISPLAY_MODE: "none",
        RW: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.t0Cpu = procCpuSecs(this.child.pid);
    let err = "";
    this.child.stdout.on("data", (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); this.stdoutTail = err; });
    let serr = "";
    this.child.stderr.on("data", (d) => {
      serr += d;
      if (serr.length > 400000) serr = serr.slice(-200000);
      this.stderrTail = serr;
    });
    this.child.on("exit", (code, signal) => {
      this.dead = true;
      this.exitCode = code;
      this.exitSignal = signal;
      this.mark("processExit");
    });
    // wait for monitor socket
    for (let i = 0; i < 150 && !this.dead; i++) {
      if (fs.existsSync(this.monitor)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.dead) {
      this.conn = net.connect(this.monitor);
      this.conn.setEncoding("latin1");
      this.buf = "";
      this.conn.on("data", (d) => { this.buf += d; });
      await new Promise((res, rej) => { this.conn.once("connect", res); this.conn.once("error", rej); }).catch(() => {});
      this.conn.on("error", () => {});
    }
  }

  async hmp(cmd, waitMs = 1200) {
    if (!this.conn || this.dead) return "";
    this.buf = "";
    this.conn.write(cmd + "\n");
    await new Promise((r) => setTimeout(r, waitMs));
    return this.buf;
  }

  async poll(shotFile) {
    const out = { serialBytes: 0, serialTail: "", stats: null, pc: null };
    try { out.serialBytes = fs.statSync(this.serial).size; } catch {}
    if (out.serialBytes) {
      const fd = fs.openSync(this.serial, "r");
      const len = Math.min(out.serialBytes, 4096);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, out.serialBytes - len);
      fs.closeSync(fd);
      out.serialTail = buf.toString("latin1");
    }
    try {
      await this.hmp(`screendump ${shotFile}`, 800);
      out.stats = ppmStats(shotFile);
    } catch {}
    const regs = await this.hmp("info registers", 600);
    out.pc = (regs.match(/R15=([0-9A-Fa-f]{8})/) || [])[1] || null;
    out.cpuSecs = procCpuSecs(this.child.pid);
    const ic = readInsnFile(this.insnFile);
    if (ic) out.insns = ic.insns;
    return out;
  }

  async quit() {
    await this.hmp("quit", 800).catch(() => {});
    if (this.conn) this.conn.destroy();
    if (this.child && !this.dead) {
      this.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      if (!this.dead) this.child.kill("SIGKILL");
    }
  }
}

// --- per-instance test logic ---------------------------------------------------
async function runInstance(flash, runDir, log) {
  const inst = new Instance(flash, runDir);
  await inst.start();

  const fail = (test, why) => {
    if (!(test in inst.verdicts)) inst.verdicts[test] = { status: "FAIL", why };
  };
  const pass = (test, why = "") => {
    if (!(test in inst.verdicts)) inst.verdicts[test] = { status: "PASS", why };
  };

  let prev = null;
  let benchDone = false, initDone = false, stableGrace = 0;
  const t0 = Date.now();
  let pollN = 0;

  while (true) {
    const elapsed = (Date.now() - t0) / 1000;
    if (inst.dead) { inst.mark("pollDead"); break; }
    if (elapsed > TIMEOUT) { inst.mark("pollTimeout"); break; }

    const shot = path.join(runDir, `shot-${pollN}.ppm`);
    const s = await inst.poll(shot);
    pollN++;
    try { fs.unlinkSync(shot); } catch {}

    // failure detection (highest priority)
    if (/>>EXIT<</.test(s.serialTail)) {
      inst.mark("guestExit", (s.serialTail.match(/>>EXIT<<[\s\S]{0,120}/) || [""])[0].replace(/[\r\n]+/g, " "));
      fail("boot-init", "guest exited during init");
      fail("boot-progress", `firmware abort: ${inst.events.at(-1).value}`);
      fail("no-exit", `firmware abort @${elapsed.toFixed(0)}s`);
      break;
    }
    if (/hardware error:|Invalid board config/.test(inst.stderrTail)) {
      const line = inst.stderrTail.split("\n").find((l) => /hardware error:|Invalid board config/.test(l)) || "";
      inst.mark("hwError", line.trim());
      fail("boot-init", line.trim());
      fail("boot-progress", line.trim());
      fail("no-exit", line.trim());
      break;
    }

    // milestones
    if (s.serialBytes > 0 && inst.since("serialFirst") === null) inst.mark("serialFirst", s.serialBytes);
    if (s.stats) {
      if (s.stats.nonBlack >= 5000 && inst.since("lcdLit") === null) inst.mark("lcdLit", s.stats.nonBlack);
      if (s.stats.colorful >= 300 && inst.since("lcdContent") === null) inst.mark("lcdContent", s.stats.colorful);
    }
    if (prev?.stats && s.stats && Math.abs(s.stats.nonBlack - prev.stats.nonBlack) > 500 && inst.since("lcdActivity") === null)
      inst.mark("lcdActivity", `${prev.stats.nonBlack}->${s.stats.nonBlack}`);

    // boot-init verdict at INIT_SECS
    if (!initDone && elapsed >= INIT_SECS) {
      initDone = true;
      const insns = s.insns ?? 0n;
      inst.mark("initSample", { insns: insns.toString(), cpu: s.cpuSecs });
      if (insns >= BigInt(INIT_MIN_INSNS) && s.pc !== null) pass("boot-init", `${fmt(insns)} insns @${INIT_SECS}s, pc=${s.pc}`);
      else if (inst.dead) fail("boot-init", "process exited during init");
      else fail("boot-init", `only ${fmt(insns)} insns @${INIT_SECS}s (need ${fmt(INIT_MIN_INSNS)})`);
    }

    // boot-progress verdict: as soon as we have LCD content or serial + lit LCD
    if (!("boot-progress" in inst.verdicts)) {
      if (inst.since("lcdContent") !== null) pass("boot-progress", `LCD content (${fmt(inst.events.find((e) => e.ev === "lcdContent").value)} colored px) @${inst.since("lcdContent").toFixed(0)}s`);
      else if (inst.since("serialFirst") !== null && inst.since("lcdLit") !== null)
        pass("boot-progress", `serial ${inst.events.find((e) => e.ev === "serialFirst").value}B + LCD lit @${inst.since("serialFirst").toFixed(0)}s`);
    }

    // benchmark at BENCH_SECS (window over the plugin counter)
    if (!benchDone && elapsed >= BENCH_SECS) {
      benchDone = true;
      const ic = readInsnFile(inst.insnFile);
      const t0ic = inst.firstInsnSample;
      if (ic && t0ic) {
        const dInsns = ic.insns - t0ic.insns;
        const dNs = Number(ic.monoNs - t0ic.monoNs);
        const mips = dNs > 0 ? Number(dInsns) * 1e3 / Number(dNs) : 0; // insns/ns == MIPS
        inst.bench = { mips: Math.round(mips * 10) / 10, insns: dInsns.toString(), windowS: dNs / 1e9, cpuSecs: s.cpuSecs };
      }
    } else if (!inst.firstInsnSample) {
      const ic = readInsnFile(inst.insnFile);
      if (ic) inst.firstInsnSample = ic;
    }

    // fast path: everything measured — stop 10 s after the bench window
    if (benchDone && initDone && "boot-progress" in inst.verdicts && elapsed >= BENCH_SECS + 10) {
      stableGrace++;
      if (stableGrace >= 2) { inst.mark("doneEarly"); break; }
    }

    log(`t=${elapsed.toFixed(0).padStart(3)}s pc=${s.pc ?? "?"} ser=${fmt(s.serialBytes)}B lit=${s.stats ? fmt(s.stats.nonBlack) : "?"}px col=${s.stats ? s.stats.colorful : "?"} insns=${s.insns !== undefined ? fmt(s.insns) : "?"} cpu=${s.cpuSecs?.toFixed(0) ?? "?"}s`);
    prev = s;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // final verdicts
  if (!("boot-init" in inst.verdicts)) {
    const ic = readInsnFile(inst.insnFile);
    if ((ic?.insns ?? 0n) >= BigInt(INIT_MIN_INSNS)) pass("boot-init", "late sample");
    else fail("boot-init", "no insn sample");
  }
  if (!("boot-progress" in inst.verdicts)) {
    if (inst.since("guestExit") !== null || inst.since("hwError") !== null) {
      /* already failed above */
    } else if (inst.dead && inst.since("processExit") !== null && inst.since("processExit") < TIMEOUT - 2) {
      fail("boot-progress", `emulator died at ${(inst.since("processExit") ?? 0).toFixed(0)}s (exit=${inst.exitCode}${inst.exitSignal ? " sig=" + inst.exitSignal : ""})`);
    } else {
      fail("boot-progress", `timeout after ${TIMEOUT}s: no LCD content / serial (lit=${inst.since("lcdLit") !== null}, serial=${inst.since("serialFirst") !== null})`);
    }
  }

  if (!("no-exit" in inst.verdicts)) {
    if (inst.since("guestExit") !== null || inst.since("hwError") !== null) {
      fail("no-exit", "firmware aborted");
    } else if (inst.dead && (inst.since("processExit") ?? 1e9) < TIMEOUT - 2 && inst.since("pollTimeout") === null && inst.since("doneEarly") === null) {
      fail("no-exit", `emulator died at ${(inst.since("processExit") ?? 0).toFixed(0)}s (exit=${inst.exitCode}${inst.exitSignal ? " sig=" + inst.exitSignal : ""})`);
    } else {
      pass("no-exit", `alive ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  await inst.quit();

  return {
    flash: flash.id,
    board: flash.board,
    verdicts: inst.verdicts,
    milestones: Object.fromEntries(
      ["serialFirst", "lcdLit", "lcdContent", "lcdActivity", "guestExit", "hwError", "processExit"]
        .filter((e) => inst.since(e) !== null)
        .map((e) => [e, Number(inst.since(e).toFixed(1))])
    ),
    exitText: inst.events.find((e) => e.ev === "guestExit")?.value || null,
    bench: inst.bench ?? null,
    stderrTail: inst.stderrTail.split("\n").filter((l) => l && !/unknown reg access|Unknown cpu GPIO/.test(l)).slice(-4),
  };
}

// --- main ------------------------------------------------------------------
const QEMU_BIN = process.env.QEMU_BIN || path.join(ROOT, "build/qemu-native-build/qemu-system-arm");
if (!fs.existsSync(QEMU_BIN)) {
  console.error(`qemu not found: ${QEMU_BIN} (build it: scripts/build-native.sh)`);
  process.exit(2);
}

const resultsDir = path.join(ROOT, "tests", "results");
fs.mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pmb887x-tests-${LABEL}-`));

console.log(`suite: label=${LABEL} qemu=${QEMU_BIN}`);
console.log(`  timeout=${TIMEOUT}s bench-window=${BENCH_SECS}s flashes=${FLASHES.map((f) => f.id).join(",")}`);
console.log(`  run dirs: ${runsRoot}${KEEP ? "" : " (removed unless --keep)"}`);
console.log("");

const t0 = Date.now();
const results = await Promise.all(
  FLASHES.map((f) => {
    const runDir = path.join(runsRoot, f.id);
    fs.mkdirSync(runDir, { recursive: true });
    const lines = [];
    const log = (l) => {
      lines.push(l);
      process.stdout.write(`[${f.id.padEnd(4)}] ${l}\n`);
    };
    return runInstance(f, runDir, log).catch((e) => ({
      flash: f.id, board: f.board,
      verdicts: { "boot-init": { status: "FAIL", why: "harness error: " + String(e).slice(0, 200) } },
      milestones: {}, bench: null, stderrTail: [],
    }));
  })
);

// --- report -----------------------------------------------------------------
console.log("");
let allPass = true;
const rows = [];
for (const r of results) {
  const init = r.verdicts["boot-init"]?.status === "PASS";
  const prog = r.verdicts["boot-progress"]?.status === "PASS";
  const noexit = r.verdicts["no-exit"]?.status === "PASS";
  allPass &&= init && prog && noexit;
  rows.push({
    flash: r.flash, board: r.board,
    "boot-init": init ? "PASS" : "FAIL",
    "boot-progress": prog ? "PASS" : "FAIL",
    "no-exit": noexit ? "PASS" : "FAIL",
    "serial(s)": r.milestones.serialFirst ?? "—",
    "lcd-lit(s)": r.milestones.lcdLit ?? "—",
    "lcd-content(s)": r.milestones.lcdContent ?? "—",
    "MIPS": r.bench ? r.bench.mips : "—",
    "insns@window": r.bench ? fmt(BigInt(r.bench.insns)) : "—",
  });
}
const cols = Object.keys(rows[0]);
const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
const line = (cells) => "| " + cells.map((c, i) => String(c).padEnd(widths[i])).join(" | ") + " |";
console.log(line(cols));
console.log(line(widths.map((w) => "-".repeat(w))));
for (const r of rows) console.log(line(cols.map((c) => r[c])));

for (const r of results) {
  for (const [test, v] of Object.entries(r.verdicts)) {
    if (v.status === "FAIL") console.log(`FAIL ${r.flash}/${test}: ${v.why}`);
  }
}

const report = {
  label: LABEL, stamp: new Date().toISOString(),
  qemu: QEMU_BIN, timeoutS: TIMEOUT, benchS: BENCH_SECS,
  wallS: Number(((Date.now() - t0) / 1000).toFixed(1)),
  results,
};
const outFile = OUT || path.join(resultsDir, `${LABEL}-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\nresults: ${outFile}   (${report.wallS}s wall)`);
if (!KEEP) fs.rmSync(runsRoot, { recursive: true, force: true });

process.exit(allPass ? 0 : 1);
