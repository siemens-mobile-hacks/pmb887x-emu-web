#!/usr/bin/env node
// Lockstep driver (phase 0b, doc/wasm-tcg-backend-plan.md §5): run the
// same deterministic boot on two TCG backends with the tests/lockstep.so
// plugin and value-diff the guest-state digests.
//
//   node tools/lockstep.mjs                       # 1 run, JIT vs TCI, S75
//   node tools/lockstep.mjs --runs 3 --par 3      # the phase-0b gate
//   node tools/lockstep.mjs --self                # harness self-check (A vs A)
//   node tools/lockstep.mjs --insns 300e6         # short smoke budget
//   node tools/lockstep.mjs --dense-from N --dense-to N   # manual dense window
//
// Each run boots the fullflash on both binaries (a = reference JIT,
// b = TCI) under -accel tcg,one-insn-per-tb=on (TB boundaries == insn
// boundaries: the plugin's executed-insn-keyed sampling is exact on
// every backend) and -rtc base=<fixed>,clock=vm (the pmb887x RTC seeds
// from host time — must be pinned for cross-run comparability), until
// both reach --insns executed guest instructions, then quits via the HMP
// monitor (clean plugin atexit flush).
//
// E-lines (register-vector digest per epoch) and M-lines (memory-range
// digests) are compared pairwise; on divergence the driver re-runs both
// sides with a dense per-insn dump window over the divergent epoch and
// reports the first insn with a differing register vector — the point
// where phase-0a's op-suite takes over. Exit 0 iff every run was
// divergence-free.

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUN_NATIVE = path.join(ROOT, "scripts", "run-native.sh");
const PLUGIN = path.join(ROOT, "tests", "lockstep.so");
export const RTC_ARGS = ["-rtc", "base=2000-01-01T00:00:00,clock=vm"];
export const OIPT_ARGS = ["-accel", "tcg,one-insn-per-tb=on"];

const REG_NAMES = [
  "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10",
  "r11", "r12", "sp", "lr", "pc", "cpsr",
];

export const FLASHES = {
  s75: "fullflashes/s75_working20060710172101.bin",
  el71: "fullflashes/rr_ff_el71_stock.bin",
  c81: "fullflashes/rrC81 .bin",
  ke800: "fullflashes/KE800-v11b.bin",
};

// --- args ---------------------------------------------------------------------
function parseArgs() {
  const a = {
    runs: 1, par: 1, flash: "s75", insns: 2.5e9, secs: 2700,
    period: 1 << 16, epoch: 1 << 20, meminsns: 1 << 23, mem: null,
    aBin: path.join(ROOT, "build/qemu-native-build/qemu-system-arm"),
    bBin: path.join(ROOT, "build/qemu-native-tci-build/qemu-system-arm"),
    self: false, localize: true, label: "lockstep",
    denseFrom: null, denseTo: null, corrupt: null,
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
      case "--a-bin": a.aBin = argv[++i]; break;
      case "--b-bin": a.bBin = argv[++i]; break;
      case "--self": a.self = true; break;
      case "--no-localize": a.localize = false; break;
      case "--label": a.label = argv[++i]; break;
      case "--dense-from": a.denseFrom = num(); break;
      case "--dense-to": a.denseTo = num(); break;
      case "--corrupt": a.corrupt = num(); break;
      default: throw new Error(`unknown arg: ${t}`);
    }
  }
  return a;
}

// --- one emulator side ---------------------------------------------------------
export class Side {
  constructor(name, bin, dir, args) {
    this.name = name;
    this.bin = bin;
    this.dir = dir;
    this.args = args; // {period, epoch, meminsns, mem, from, to, corrupt}
    this.log = path.join(dir, "ls.log");
    this.serial = path.join(dir, "serial.log");
    this.monitor = path.join(dir, "mon.sock");
    this.dead = false;
    this.exitCode = null;
    this.progress = { epoch: -1, insns: 0 };
  }

  pluginArgs() {
    const p = [`out=${this.log}`, `period=${this.args.period}`,
               `epoch=${this.args.epoch}`, `meminsns=${this.args.meminsns}`];
    if (this.args.mem) p.push(`mem=${this.args.mem}`);
    if (this.args.from != null) p.push(`from=${this.args.from}`);
    if (this.args.to != null) p.push(`to=${this.args.to}`);
    if (this.args.corrupt) p.push(`corrupt=${this.args.corrupt}`);
    return `file=${PLUGIN},${p.join(",")}`;
  }

  async start(flash) {
    fs.mkdirSync(this.dir, { recursive: true });
    this.child = spawn(RUN_NATIVE, [
      flash, ...RTC_ARGS, ...OIPT_ARGS, "-plugin", this.pluginArgs(),
    ], {
      env: {
        ...process.env,
        QEMU_BIN: this.bin,
        SERIAL: this.serial,
        MONITOR: `unix:${this.monitor}`,
        DISPLAY_MODE: "none",
        RW: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.errTail = "";
    this.child.stderr.on("data", (d) => {
      this.errTail = (this.errTail + d).slice(-8000);
    });
    this.child.stdout.on("data", (d) => {
      this.errTail = (this.errTail + d).slice(-8000);
    });
    this.child.on("exit", (code, signal) => {
      this.dead = true;
      this.exitCode = code ?? signal;
    });
    // monitor socket
    for (let i = 0; i < 300 && !this.dead; i++) {
      if (fs.existsSync(this.monitor)) break;
      await sleep(100);
    }
    if (!this.dead) {
      this.conn = net.connect(this.monitor);
      this.conn.on("error", () => {});
      await new Promise((res) => {
        this.conn.once("connect", res);
        this.conn.once("error", res);
        setTimeout(res, 3000);
      });
    }
  }

  // parse flushed E lines for progress
  poll() {
    let txt;
    try {
      txt = fs.readFileSync(this.log, "utf8");
    } catch {
      return;
    }
    for (const line of txt.split("\n")) {
      if (!line.startsWith("E ")) continue;
      const f = line.split(" ");
      // E vcpu epoch insn_total regs_hash
      const epoch = Number(f[2]), insns = Number(f[3]);
      if (Number.isFinite(epoch)) {
        this.progress = { epoch, insns };
      }
    }
  }

  async quit(reason) {
    this.quitReason = reason;
    if (this.conn && !this.dead) {
      this.conn.write("quit\n");
      await waitDead(this, 20000);
    }
    if (!this.dead) {
      this.child.kill("SIGTERM");
      await waitDead(this, 5000);
    }
    if (!this.dead) this.child.kill("SIGKILL");
    await waitDead(this, 5000);
    if (this.conn) this.conn.destroy();
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitDead(side, ms) {
  const t0 = Date.now();
  while (!side.dead && Date.now() - t0 < ms) await sleep(100);
  return side.dead;
}

export async function runPair(args, flash, dir, stopAtInsns, log) {
  fs.mkdirSync(dir, { recursive: true });
  const common = { period: args.period, epoch: args.epoch,
                   meminsns: args.meminsns, mem: args.mem,
                   from: args.denseFrom, to: args.denseTo };
  const a = new Side("a", args.aBin, path.join(dir, "a"), common);
  const b = new Side("b", args.self ? args.aBin : args.bBin,
                     path.join(dir, "b"), { ...common, corrupt: args.corrupt });
  await a.start(flash);
  await b.start(flash);

  const t0 = Date.now();
  let warned = false;
  const throttled = { a: false, b: false };
  for (;;) {
    a.poll(); b.poll();
    if (a.dead || b.dead) break;
    if (!warned && Date.now() - t0 > 20000 &&
        (a.progress.epoch < 0 || b.progress.epoch < 0)) {
      log(`!! no plugin output after 20 s — plugin loaded? run dir: ${dir}`);
      warned = true;
    }
    // throttle a side that already crossed the budget while the other
    // catches up (HMP stop; the TB sequence is unaffected by stopping)
    for (const [s, o] of [[a, b], [b, a]]) {
      if (!throttled[s.name] && s.progress.insns >= stopAtInsns &&
          o.progress.insns < stopAtInsns && s.conn) {
        s.conn.write("stop\n");
        throttled[s.name] = true;
      }
    }
    if (a.progress.insns >= stopAtInsns && b.progress.insns >= stopAtInsns) break;
    if (Date.now() - t0 > args.secs * 1000) {
      log(`!! wall timeout ${args.secs}s (a insns=${a.progress.insns}, b insns=${b.progress.insns})`);
      break;
    }
    await sleep(500);
  }
  const reasons = [a.dead ? `a exited(${a.exitCode})` : null,
                   b.dead ? `b exited(${b.exitCode})` : null].filter(Boolean);
  await a.quit("budget");
  await b.quit("budget");
  return { a, b, reasons, wallS: (Date.now() - t0) / 1000 };
}

// --- log comparison ------------------------------------------------------------
function readLogLines(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length);
}

export function compareDigestLogs(aFile, bFile) {
  const A = readLogLines(aFile), B = readLogLines(bFile);
  const linesOf = (ls, p) => ls.filter((l) => l.startsWith(p));
  const res = { commonEpochs: 0, commonMem: 0, diverged: null, truncated: false };
  if (A[0] !== B[0]) {
    res.diverged = { kind: "config", lineA: A[0], lineB: B[0] };
    return res;
  }
  // E-lines: register digests per epoch
  const EA = linesOf(A, "E "), EB = linesOf(B, "E ");
  const n = Math.min(EA.length, EB.length);
  for (let i = 0; i < n; i++) {
    if (EA[i] !== EB[i]) {
      const f = EA[i].split(" "), g = EB[i].split(" ");
      res.diverged = {
        kind: "epoch", epoch: Number(f[2]),
        insnsA: Number(f[3]), insnsB: Number(g[3]),
        fields: fieldDiff(f, g), lineA: EA[i], lineB: EB[i],
      };
      return res;
    }
    res.commonEpochs++;
  }
  // M-lines: memory digests
  const MA = linesOf(A, "M "), MB = linesOf(B, "M ");
  const m = Math.min(MA.length, MB.length);
  for (let i = 0; i < m; i++) {
    if (MA[i] !== MB[i]) {
      const f = MA[i].split(" "), g = MB[i].split(" ");
      res.diverged = {
        kind: "mem", insnsA: Number(f[2]), insnsB: Number(g[2]),
        fields: fieldDiff(f, g), lineA: MA[i], lineB: MB[i],
      };
      return res;
    }
    res.commonMem++;
  }
  if (EA.length !== EB.length || MA.length !== MB.length) res.truncated = true;
  return res;
}

// which columns differ; names aligned per log-line grammar
function fieldDiff(f, g) {
  const out = [];
  for (let i = 0; i < Math.max(f.length, g.length); i++) {
    if (f[i] !== g[i]) out.push(`col${i}(${f[i]}!=${g[i]})`);
  }
  return out;
}

function compareDenseLogs(aFile, bFile) {
  const A = readLogLines(aFile).filter((l) => l.startsWith("T "));
  const B = readLogLines(bFile).filter((l) => l.startsWith("T "));
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] !== B[i]) {
      return { insn: Number(A[i].split(" ")[2]), lineA: A[i], lineB: B[i],
               commonInsns: i };
    }
  }
  return null;
}

function reportDenseTb(div) {
  const fa = div.lineA.split(" "), fb = div.lineB.split(" ");
  const rows = [];
  // T vcpu insn r0..cpsr
  rows.push(["insn", fa[2], fb[2]]);
  for (let i = 0; i < REG_NAMES.length; i++) {
    const va = fa[3 + i] ?? "-", vb = fb[3 + i] ?? "-";
    rows.push([REG_NAMES[i], va, vb]);
  }
  return rows
    .filter((r) => r[1] !== r[2])
    .map((r) => `    ${r[0].padEnd(5)} a=${r[1]} b=${r[2]}`)
    .join("\n");
}

// --- localization rerun --------------------------------------------------------
async function localize(args, flash, baseDir, div, log) {
  const epoch = args.epoch;
  const from = Math.max(1, (div.epoch - 1) * epoch + 1);
  const to = div.epoch * epoch + 1;
  const stopAt = Math.min(args.insns, div.epoch * epoch + epoch);
  log(`== localizing: dense insn window [${from}, ${to}) (~${(to - from) / 1e6}M insns), budget ${fmt(stopAt)}`);
  const denseArgs = { ...args, denseFrom: from, denseTo: to };
  const dir = path.join(baseDir, "dense");
  const { a, b } = await runPair(denseArgs, flash, dir, stopAt, log);
  const d = compareDenseLogs(path.join(dir, "a", "ls.log"), path.join(dir, "b", "ls.log"));
  if (!d) {
    log("!! dense rerun found no differing T line (epoch digest diverged but every sampled insn matches — divergence below sampling granularity or rerun flaked)");
    return null;
  }
  log(`== first divergent insn #${d.insn} (after ${d.commonInsns} matching insns in window):`);
  log(reportDenseTb(d));
  const pcIdx = 15; // r15 == pc within the reg columns
  const fa = d.lineA.split(" "), fb = d.lineB.split(" ");
  log(`   guest pc around divergence: a=${fa[3 + pcIdx]} b=${fb[3 + pcIdx]}` +
      ` — bisect by op with the phase-0a suite (tests/tcg-isa)`);
  return d;
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  return String(n);
}

// --- main ----------------------------------------------------------------------
export async function main() {
  const args = parseArgs();
  const log = (m) => console.log(m);
  const flash = FLASHES[args.flash] ? path.join(ROOT, FLASHES[args.flash])
    : (fs.existsSync(args.flash) ? path.resolve(args.flash) : null);
  if (!flash) {
    console.error(`unknown flash: ${args.flash} (known: ${Object.keys(FLASHES).join(", ")})`);
    process.exit(2);
  }
  for (const [n, b] of [["a", args.aBin], ["b", args.self ? args.aBin : args.bBin]]) {
    if (!fs.existsSync(b)) {
      console.error(`${n} binary missing: ${b}`);
      process.exit(2);
    }
  }
  if (!fs.existsSync(PLUGIN)) {
    console.error(`plugin missing: ${PLUGIN} (scripts/run-lockstep.sh builds it)`);
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseDir = `/tmp/lockstep-${args.label}-${stamp}`;
  const results = [];
  let fail = false;

  const worker = async (wi) => {
    for (let r = wi; r < args.runs; r += args.par) {
      const dir = path.join(baseDir, `run${r}`);
      log(`== run ${r + 1}/${args.runs}: ${args.self ? "self-check (a vs a)" : "JIT vs TCI"} flash=${args.flash} budget=${fmt(args.insns)} insns`);
      const { a, b, reasons, wallS } = await runPair(args, flash, dir, args.insns, log);
      const runRes = {
        run: r + 1, dir, wallS,
        a: { insns: a.progress.insns, epoch: a.progress.epoch, exit: a.exitCode },
        b: { insns: b.progress.insns, epoch: b.progress.epoch, exit: b.exitCode },
        earlyExit: reasons, cmp: null, dense: null, serialIdentical: null,
      };
      try {
        runRes.serialIdentical = fs.readFileSync(a.serial).equals(fs.readFileSync(b.serial));
      } catch { runRes.serialIdentical = null; }
      const cmp = compareDigestLogs(a.log, b.log);
      runRes.cmp = { commonEpochs: cmp.commonEpochs, commonMem: cmp.commonMem,
                     truncated: cmp.truncated,
                     diverged: cmp.diverged && { ...cmp.diverged, lineA: undefined, lineB: undefined } };
      log(`   a: ${fmt(a.progress.insns)} insns / epoch ${a.progress.epoch}` +
          `   b: ${fmt(b.progress.insns)} insns / epoch ${b.progress.epoch}` +
          `   wall ${wallS.toFixed(0)}s   serial ${runRes.serialIdentical ? "identical" : "DIFFERS"}`);
      if (cmp.diverged) {
        fail = true;
        log(`!! DIVERGENCE run ${r + 1}: ${cmp.diverged.kind}` +
            (cmp.diverged.kind === "epoch"
              ? ` @ epoch ${cmp.diverged.epoch} (a insns=${fmt(cmp.diverged.insnsA)}, b insns=${fmt(cmp.diverged.insnsB)}), differing: ${(cmp.diverged.fields || []).join(", ")}`
              : cmp.diverged.kind === "mem"
                ? ` @ insns=${fmt(cmp.diverged.insnsA)} (memory digest), differing: ${(cmp.diverged.fields || []).join(", ")}`
                : ""));
        log(`   a: ${cmp.diverged.lineA}`);
        log(`   b: ${cmp.diverged.lineB}`);
        if (cmp.diverged.kind === "epoch" && args.localize) {
          runRes.dense = await localize(args, flash, dir, cmp.diverged, log);
        }
      } else if (cmp.commonEpochs === 0) {
        fail = true;
        log(`!! no comparable epochs (plugin output missing?) — ${dir}`);
        log(`   a stderr tail: ${(a.errTail || "").split("\n").slice(-5).join("\n")}`);
        log(`   b stderr tail: ${(b.errTail || "").split("\n").slice(-5).join("\n")}`);
      } else {
        log(`   clean: ${cmp.commonEpochs} epochs + ${cmp.commonMem} mem digests identical` +
            `${cmp.truncated ? " (tail truncated by stop point)" : ""}`);
      }
      results.push(runRes);
    }
  };

  const workers = [];
  for (let w = 0; w < Math.min(args.par, args.runs); w++) workers.push(worker(w));
  await Promise.all(workers);

  const summary = {
    label: args.label, stamp, flash: args.flash,
    aBin: args.aBin, bBin: args.self ? args.aBin : args.bBin,
    insns: args.insns, period: args.period, epoch: args.epoch,
    meminsns: args.meminsns, mem: args.mem,
    runs: results.length, clean: results.filter((r) => !r.cmp.diverged).length,
    results,
  };
  const resFile = path.join(ROOT, "tests", "results", `lockstep-${args.label}-${stamp}.json`);
  fs.mkdirSync(path.dirname(resFile), { recursive: true });
  fs.writeFileSync(resFile, JSON.stringify(summary, null, 1) + "\n");
  log(`== ${results.filter((r) => !r.cmp.diverged).length}/${results.length} runs clean; results: ${resFile}`);
  log(`== run dirs under ${baseDir} (tmp — remove when done)`);

  return fail ? 1 : 0;

}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const rc = await main();
  process.exit(rc ?? 0);
}
