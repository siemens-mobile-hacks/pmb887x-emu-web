// Fixed-guest-work A/B bench (native): wall time between instruction
// milestones, interpolated from the insncount plugin's (mono_ns, count)
// flushes. Same stretch of guest work on both binaries => pure host-speed
// comparison (the workbench.mjs argument, native edition).
//
//   node tools/perf/bench.mjs <qemu-bin> <board> [--from Gi --to Gi --warm Gi]
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT = "/workspace";
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const QEMU = argv[0];
const BOARD = argv[1];
const FROM = Number(opt("from", 6)) * 1e9;
const TO = Number(opt("to", 30)) * 1e9;

const BOARDS = {
  cx70: { flash: "CX70_FW56_clean.bin", esn: "F531953B", imei: "353541005952557" },
  s75: { flash: "s75_working20060710172101.bin" },
  el71: { flash: "rr_ff_el71_stock.bin" },
  c81: { flash: "rrC81 .bin" },
};
const board = BOARDS[BOARD];
if (!board) { console.error("board?", Object.keys(BOARDS)); process.exit(2); }

const runDir = fs.mkdtempSync("/tmp/bench-");
const serial = path.join(runDir, "serial.log");
const mon = path.join(runDir, "monitor.sock");
const insnFile = path.join(runDir, "insns.txt");

const env = {
  ...process.env, BOARD: `siemens-${BOARD}`, MONITOR: `unix:${mon}`, SERIAL: serial,
  DISPLAY_MODE: "none", RW: "0",
  ...(board.esn ? { ESN: board.esn, IMEI: board.imei } : {}),
};
const child = spawn(path.join(ROOT, "scripts/run-native.sh"),
  [path.join(ROOT, "fullflashes", board.flash),
   ...(process.env.RTC_ARGS ? process.env.RTC_ARGS.split(" ") : []),
   "-plugin", `file=${ROOT}/tests/insncount.so,count=${insnFile}`],
  { env, stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 100000) stderr = stderr.slice(-50000); });

for (let i = 0; i < (process.env.MON_WAIT_LOOPS ? +process.env.MON_WAIT_LOOPS : 150); i++) { if (fs.existsSync(mon)) break; await new Promise(r => setTimeout(r, 100)); }
if (!fs.existsSync(mon)) { console.error(`monitor socket never appeared${stderr ? ":\n" + stderr.slice(-2000) : ""}`); process.exit(1); }
const conn = net.connect(mon); conn.setEncoding("latin1");
conn.on("data", () => {});
conn.on("error", () => {});
await new Promise((r) => conn.once("connect", r));

const readInsns = () => {
  try {
    const m = fs.readFileSync(insnFile, "utf8").trim().match(/^(\S+) (\d+)$/m);
    if (!m) return null;
    const [s, ns] = m[1].split(".");
    return { monoNs: BigInt(s) * 1000000000n + BigInt(ns || 0), insns: BigInt(m[2]) };
  } catch { return null; }
};

// sample the flush file densely; each line is an exact (t, count) pair
const samples = [];
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < +(process.env.MAX_WAIT_S || 900)) {
  const ic = readInsns();
  if (ic) {
    const last = samples.at(-1);
    if (!last || last.insns !== ic.insns) samples.push(ic);
  }
  if (samples.at(-1) && samples.at(-1).insns >= TO) break;
  if (child.exitCode !== null) break;
  await new Promise(r => setTimeout(r, 20));
}

const crossing = (target) => {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].insns >= target && samples[i - 1].insns < target) {
      const a = samples[i - 1], b = samples[i];
      const frac = Number(target - a.insns) / Number(b.insns - a.insns);
      return Number(a.monoNs) + frac * (Number(b.monoNs) - Number(a.monoNs));
    }
  }
  return null;
};

const tFrom = crossing(BigInt(FROM)), tTo = crossing(BigInt(TO));
const mips = tFrom && tTo ? (TO - FROM) / (tTo - tFrom) * 1e3 : null;
// per-4G segment rates to see drift within the run
const segs = [];
for (let g = Math.ceil(FROM / 4e9) * 4e9; g < TO; g += 4e9) {
  const a = crossing(BigInt(g)), b = crossing(BigInt(Math.min(g + 4e9, TO)));
  if (a && b) segs.push(Math.round((Math.min(g + 4e9, TO) - g) / (b - a) * 1e3));
}
const exitSeen = (() => { try { return />>EXIT<</.test(fs.readFileSync(serial, "latin1")); } catch { return false; } })();
console.log(JSON.stringify({
  board: BOARD, qemu: QEMU, fromG: FROM / 1e9, toG: TO / 1e9,
  wallS: tFrom && tTo ? ((tTo - tFrom) / 1e9).toFixed(2) : null,
  mips: mips ? Math.round(mips * 10) / 10 : null,
  segMips: segs, samples: samples.length,
  serialExit: exitSeen,
  stderrTail: child.exitCode !== null ? stderr.slice(-1500) : undefined,
  hwError: /hardware error:/.test(stderr) ? stderr.split("\n").find(l => /hardware error:/.test(l)) : false,
}));
conn.write("quit\n");
// give the emulator (e.g. under valgrind) time to shut down and flush
// side artifacts before escalating
let exitedFlag = false;
child.once("exit", () => { exitedFlag = true; });
await Promise.race([
  new Promise(r => child.once("exit", r)),
  new Promise(r => setTimeout(r, +(process.env.QUIT_WAIT_MS || 5000))),
]);
conn.destroy();
if (!exitedFlag) { child.kill("SIGTERM"); await new Promise(r => setTimeout(r, 1000)); child.kill("SIGKILL"); }
