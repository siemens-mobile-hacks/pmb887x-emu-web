// CX70 (SGOLD / dif_v1) native boot + bench harness, modeled on tests/run.mjs.
//   node cxboot.mjs <qemu-bin> [--secs N] [--insns 2e9]
// Boots CX70_FW56_clean.bin via scripts/run-native.sh with the insncount
// plugin, polls the HMP monitor, and reports: milestones (serial first /
// LCD lit / LCD content), a MIPS bench window after the idle screen settles,
// and wall time to --insns guest instructions (fixed-guest-work metric).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT = "/workspace";
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const QEMU = argv[0];
const SECS = Number(opt("secs", 240));
const TARGET = Number(opt("insns", 2e9));

const flash = path.join(ROOT, "fullflashes/CX70_FW56_clean.bin");
const runDir = fs.mkdtempSync("/tmp/cxboot-");
const serial = path.join(runDir, "serial.log");
const mon = path.join(runDir, "monitor.sock");
const insnFile = path.join(runDir, "insns.txt");

const child = spawn(path.join(ROOT, "scripts/run-native.sh"), [flash,
  "-plugin", `file=${ROOT}/tests/insncount.so,count=${insnFile}`], {
  env: { ...process.env, BOARD: "siemens-cx70", MONITOR: `unix:${mon}`, SERIAL: serial, DISPLAY_MODE: "none", RW: "0",
         ESN: process.env.CX_ESN || "F531953B", IMEI: process.env.CX_IMEI || "353541005952557" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
child.on("exit", (c, s) => { console.log(`process exit code=${c} sig=${s}`); process.exit(1); });

for (let i = 0; i < 150; i++) { if (fs.existsSync(mon)) break; await new Promise(r => setTimeout(r, 100)); }
const conn = net.connect(mon); conn.setEncoding("latin1"); let buf = "";
conn.on("data", (d) => { buf += d; });
await new Promise((r) => conn.once("connect", r));

const hmp = async (cmd, wait = 800) => { buf = ""; conn.write(cmd + "\n"); await new Promise(r => setTimeout(r, wait)); return buf; };
const readInsns = () => {
  try {
    const m = fs.readFileSync(insnFile, "utf8").trim().match(/^(\S+) (\d+)$/m);
    if (!m) return null;
    const [s, ns] = m[1].split(".");
    return { monoNs: BigInt(s) * 1000000000n + BigInt(ns || 0), insns: BigInt(m[2]) };
  } catch { return null; }
};
const ppmStats = (f) => {
  try {
    const b = fs.readFileSync(f);
    const m = b.toString("latin1").match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
    if (!m) return null;
    const px = b.subarray(Buffer.byteLength(m[0], "latin1"));
    let nonBlack = 0, colorful = 0;
    for (let i = 0, j = 0; i < +m[1] * +m[2]; i++, j += 3) {
      const r = px[j], g = px[j + 1], bl = px[j + 2];
      if (r | g | bl) nonBlack++;
      if (Math.max(r, g, bl) - Math.min(r, g, bl) >= 40 && Math.max(r, g, bl) >= 60) colorful++;
    }
    return { nonBlack, colorful };
  } catch { return null; }
};

const t0 = Date.now();
const milestones = {};
let prevInsns = null, prevT = null, mips = null, prevSample = null;
let shot = 0;
const serialExitSeen = () => { try { return />>EXIT<</.test(fs.readFileSync(serial, "latin1")); } catch { return false; } };

while ((Date.now() - t0) / 1000 < SECS) {
  const ic = readInsns();
  const el = (Date.now() - t0) / 1000;
  const ser = fs.existsSync(serial) ? fs.statSync(serial).size : 0;
  const shotFile = path.join(runDir, `shot-${shot}.ppm`);
  await hmp(`screendump ${shotFile}`, 900);
  const st = ppmStats(shotFile);
  shot++;
  console.log(`t=${el.toFixed(0).padStart(3)}s ser=${ser}B lit=${st ? st.nonBlack : "?"}px col=${st ? st.colorful : "?"} insns=${ic ? ic.insns : "?"}`);
  if (ser > 0 && milestones.serialFirst === undefined) milestones.serialFirst = +el.toFixed(1);
  if (st) {
    if (st.nonBlack >= 5000 && milestones.lcdLit === undefined) milestones.lcdLit = +el.toFixed(1);
    if (st.colorful >= 300 && milestones.lcdContent === undefined) milestones.lcdContent = +el.toFixed(1);
  }
  if (serialExitSeen()) { console.log("FAIL: firmware >>EXIT<<"); break; }
  if (/hardware error:/.test(stderr)) { console.log("FAIL hw error:", stderr.split("\n").find(l => /hardware error:/.test(l))); break; }

  // bench: first sample once content is up; MIPS over the following window
  if (milestones.lcdContent !== undefined) {
    if (!prevSample) prevSample = ic;
    else if (ic && !mips) {
      const dI = ic.insns - prevSample.insns, dNs = Number(ic.monoNs - prevSample.monoNs);
      mips = dNs > 0 ? Number(dI) * 1e3 / Number(dNs) : 0;
      milestones.benchAt = +el.toFixed(1);
    }
  }
  if (ic && ic.insns >= BigInt(TARGET) && milestones.timeToInsns === undefined) {
    milestones.timeToInsns = +el.toFixed(1);
    milestones.insns = ic.insns.toString();
    break; // enough: boot verdict + fixed-work time + one bench sample
  }
  await new Promise(r => setTimeout(r, 3000));
}

console.log(JSON.stringify({
  qemu: QEMU, milestones, mips: mips ? Math.round(mips * 10) / 10 : null,
  serialExit: serialExitSeen(), stderrTail: stderr.split("\n").filter(Boolean).slice(-3),
}, null, 1));
await hmp("quit", 500).catch(() => {});
conn.destroy();
child.kill("SIGTERM");
