// Plugin-free A/B benchmark for native TCI builds (plugins are disabled
// with --enable-tcg-interpreter by configure, so tests/run.mjs's insncount
// MIPS is unavailable).  Instead: boot is deterministic in guest work
// under `-icount shift=3,sleep=off`, so the WALL TIME to reach an LCD
// milestone measures interpreter throughput on identical guest work.
//
//   node tools/tcibench.mjs [secs]      (default 420)
//   QEMU_BIN=... MONITOR_INTERVAL=2 ... env knobs
//
// Milestones (same pixel rules as tests/run.mjs):
//   lcdLit     first screendump with >= 10 colored pixels
//   lcdContent first screendump with >= 300 saturated pixels (splash)
// Prints one JSON line: TCIENCH {...}
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const QEMU = process.env.QEMU_BIN || path.join(ROOT, "build/qemu-native-tci-build/qemu-system-arm");
const flash = process.argv[2] || path.join(ROOT, "fullflashes/s75_working20060710172101.bin");
const secs = Number(process.env.SECS || 420);
const pollMs = Number(process.env.POLL_MS || 2000);

if (!fs.existsSync(QEMU)) { console.error("no qemu:", QEMU); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcibench-"));
const sock = path.join(dir, "mon.sock");
const serial = path.join(dir, "serial.log");

function ppmStats(file) {
  let b;
  try { b = fs.readFileSync(file); } catch { return null; }
  const m = b.toString("latin1").match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!m) return null;
  const off = m[0].length, w = +m[1], h = +m[2];
  if (b.length < off + w * h * 3) return null;
  let colorful = 0;
  for (let i = off; i < off + w * h * 3; i += 3) {
    const r = b[i], g = b[i + 1], bl = b[i + 2];
    const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
    if (mx - mn >= 40 && mx >= 60) colorful++;
  }
  return { colorful };
}

// HMP over the unix monitor socket: connect, wait for the banner,
// send the command, give it a moment to run (screendump is sync).
function hmp(cmd) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = "";
    const fail = (e) => { c.destroy(); reject(e); };
    c.setTimeout(4000, () => fail(new Error("mon timeout")));
    c.on("error", fail);
    c.on("connect", () => {
      setTimeout(() => c.write(cmd + "\n"), 150);
    });
    c.on("data", (d) => { buf += d.toString(); });
    setTimeout(() => { c.destroy(); resolve(buf); }, 900);
  });
}

const t0 = Date.now();
const child = spawn("bash", [
  path.join(ROOT, "scripts/run-native.sh"), flash,
], {
  env: { ...process.env, QEMU_BIN: QEMU, SERIAL: serial, MONITOR: `unix:${sock}` },
  stdio: ["ignore", "pipe", "pipe"],
});
const errOut = [];
child.stderr.on("data", (d) => errOut.push(d));
let dead = false;
child.on("exit", () => { dead = true; });

let lcdLit = null, lcdContent = null, n = 0;
const t = setInterval(async () => {
  n++;
  if (dead || Date.now() - t0 > secs * 1000) { finish(); return; }
  const shot = path.join(dir, `shot-${n}.ppm`);
  try {
    await hmp(`screendump ${shot}`);
    const s = ppmStats(shot);
    fs.rmSync(shot, { force: true });
    if (s) {
      if (lcdLit === null && s.colorful >= 10) lcdLit = (Date.now() - t0) / 1000;
      if (lcdContent === null && s.colorful >= 300) lcdContent = (Date.now() - t0) / 1000;
    }
  } catch {}
  if (lcdContent !== null) finish();
}, pollMs);

let done = false;
function finish() {
  if (done) return;
  done = true;
  clearInterval(t);
  try { hmp("quit"); } catch {}
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000);
  console.log("TCIBENCH " + JSON.stringify({
    qemu: path.basename(QEMU),
    lcdLit: lcdLit !== null ? +lcdLit.toFixed(1) : null,
    lcdContent: lcdContent !== null ? +lcdContent.toFixed(1) : null,
    wallS: +((Date.now() - t0) / 1000).toFixed(1),
    exit: dead,
    stderrTail: errOut.join("").split("\n").filter(Boolean).slice(-2),
  }));
  process.exit(0);
}
