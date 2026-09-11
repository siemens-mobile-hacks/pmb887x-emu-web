// tcgbench — fast-iteration backend benchmark (tests/tcgbench, -M
// versatilepb): fixed hot-loop phases over the backend's per-op paths,
// timed by timestamping each phase's serial line.  The phone-firmware
// boots stay the final gates; this is the A/B loop (seconds per leg).
//
//   node tools/tcgbench.mjs                       # native-jit + dist-jit
//   LEGS=native-jit,native-tci,dist-jit,dist node tools/tcgbench.mjs
//   EXTRA_Q="env=W64_NOACCTINLINE=1" node tools/tcgbench.mjs   # wasm knob
//
// Legs: native-jit / native-tci (spawned with -serial stdio, lines
// timestamped as they stream) and <dist-name> (wasm page legs via
// ?suite=dist/tcgbench.bin&dist=<name>, /serial.log polled, lines
// timestamped on appearance; guest insns/tbs read at DONE for MIPS).
// Results -> tests/results/tcgbench-<ts>.json (+ tcgbench-latest.json).
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const here = new URL(".", import.meta.url).pathname;
const ROOT = path.resolve(here, "..");
const port = process.env.PORT || "8094";
const legs = (process.env.LEGS || "native-jit,dist-jit").split(",");
const extraQ = process.env.EXTRA_Q || "";
const runs = Number(process.env.RUNS || 1);
const bins = {
  "native-jit": process.env.QEMU_JIT || `${ROOT}/build/qemu-native-build/qemu-system-arm`,
  "native-tci": process.env.QEMU_TCI || `${ROOT}/build/qemu-native-tci-build/qemu-system-arm`,
};

const stamp = () => Number(process.hrtime.bigint() / 1000000n) / 1000; // s, µs res

// run one native leg: returns { phases: [[name, ts]], serial, rc }
function runNative(bin) {
  return new Promise((resolve, reject) => {
    const args = ["-M", "versatilepb",
      "-kernel", `${ROOT}/tests/tcgbench/tcgbench.bin`,
      "-semihosting", "-display", "none", "-monitor", "none", "-serial", "stdio"];
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    const phases = [];
    const serial = [];
    p.stdout.on("data", (d) => {
      const t = stamp();
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        serial.push(line);
        const m = line.match(/^BENCH (\S+)/);
        if (m && m[1] !== "done" && m[1] !== "DONE") phases.push([m[1], t]);
      }
    });
    p.on("close", (rc) => resolve({ phases, serial, rc }));
    p.on("error", reject);
    // native TCI legs on this workload take minutes — env-tunable
    const killer = setTimeout(() => { try { p.kill(); } catch {} }, Number(process.env.NATIVE_TIMEOUT_MS || 900000));
    killer.unref();
  });
}

// run one wasm page leg: poll /serial.log, timestamp new lines
async function runWasm(dist, browser) {
  const page = await browser.newPage();
  const q = new URLSearchParams({ suite: "dist/tcgbench.bin", dist });
  for (const kv of extraQ.split("&").filter(Boolean)) {
    const i = kv.indexOf("=");
    q.append(i > 0 ? kv.slice(0, i) : kv, i > 0 ? kv.slice(i + 1) : "");
  }
  const phases = [];
  const serial = [];
  let insns = null, tbs = null;
  const t0 = stamp();
  try {
    await page.goto(`http://127.0.0.1:${port}/?${q}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    let seen = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 150));
      const s = await page.evaluate(() => {
        const m = window.__qemu;
        try {
          return new TextDecoder("latin1").decode(m.FS.readFile("/serial.log"));
        } catch {
          return "";
        }
      }).catch(() => null);
      if (s == null) break; // page died
      const t = stamp();
      const lines = s.split("\n");
      while (seen < lines.length - 1) {
        const line = lines[seen++];
        serial.push(line);
        const m = line.match(/^BENCH (\S+)/);
        if (m && m[1] !== "done" && m[1] !== "DONE") phases.push([m[1], t]);
      }
      if (/^BENCH DONE$/m.test(s)) {
        try {
          insns = await page.evaluate(() => Number(window.__qemu._wasm_insns()));
          tbs = await page.evaluate(() => Number(window.__qemu._wasm_tbs()));
        } catch {}
        break;
      }
      if (t - t0 > 600) break; // 10 min cap
    }
  } finally {
    try { await page.close(); } catch {}
  }
  return { phases, serial, rc: 0, insns, tbs };
}

// phases -> per-phase seconds (a phase's line lands when it completes)
function phaseSecs(phases) {
  const out = [];
  for (let i = 1; i < phases.length; i++) {
    out.push([phases[i][0], phases[i][1] - phases[i - 1][1]]);
  }
  return out;
}

const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (let r = 0; r < runs; r++) {
    for (const leg of legs) {
      const t0 = stamp();
      const res = leg.startsWith("native-")
        ? await runNative(bins[leg])
        : await runWasm(leg, browser);
      const secs = phaseSecs(res.phases);
      const total = secs.reduce((a, [, s]) => a + s, 0);
      const cksum = (res.serial.join("\n").match(/^BENCH done cksum=(\S+)/m) || [])[1] || null;
      const entry = {
        leg, run: r + 1, rc: res.rc, total: +total.toFixed(3),
        wasm: leg.startsWith("native-") ? undefined : path.join("site", leg, "qemu-system-arm.wasm"),
        wasmSha: leg.startsWith("native-") ? null : (() => {
          try { return createHash("sha256").update(fs.readFileSync(path.join(ROOT, "site", leg, "qemu-system-arm.wasm"))).digest("hex").slice(0, 16); } catch { return null; }
        })(),
        phases: secs.map(([n, s]) => ({ n, s: +s.toFixed(3) })),
        insns: res.insns, tbs: res.tbs,
        mips: res.insns && total ? +(res.insns / total / 1e6).toFixed(1) : null,
        cksum,
      };
      results.push(entry);
      console.log(`== ${leg} run${r + 1}: total ${entry.total}s` +
        (entry.mips ? ` (${entry.mips} MIPS, ${(entry.insns / 1e6).toFixed(0)}M insns, ${(entry.tbs / 1e6).toFixed(1)}M TBs, ${(entry.insns / Math.max(1, entry.tbs)).toFixed(1)} insns/TB)` : "") +
        `  cksum=${cksum}`);
      for (const { n, s } of entry.phases) {
        console.log(`   ${n.padEnd(8)} ${s.toFixed(3)}s`);
      }
    }
  }
} finally {
  try { await browser.close(); } catch {}
}

// summary + cross-leg checks
const byLeg = new Map();
for (const e of results) {
  if (!byLeg.has(e.leg)) byLeg.set(e.leg, []);
  byLeg.get(e.leg).push(e);
}
console.log("\n=== medians ===");
const med = {};
for (const [leg, es] of byLeg) {
  const t = es.map((e) => e.total).sort((a, b) => a - b);
  med[leg] = t[Math.floor(t.length / 2)];
  const ph = {};
  for (const { n, s } of es.flatMap((e) => e.phases)) (ph[n] ||= []).push(s);
  console.log(`${leg.padEnd(12)} total ${med[leg].toFixed(3)}s  ` +
    Object.entries(ph).map(([n, v]) => `${n}=${v.sort((a, b) => a - b)[Math.floor(v.length / 2)].toFixed(2)}`).join(" "));
}
const ref = med["native-jit"];
if (ref) {
  console.log("\n=== vs native-jit ===");
  for (const [leg, t] of Object.entries(med)) {
    if (leg !== "native-jit") console.log(`${leg.padEnd(12)} ${(ref / t).toFixed(2)}x`);
  }
}
const cksums = new Set(results.map((e) => e.cksum));
console.log(cksums.size === 1 && !cksums.has(null)
  ? `checksums identical across legs (${[...cksums][0]})`
  : `!! CHECKSUM MISMATCH: ${[...cksums].join(" ")}`);

const out = {
  ts: new Date().toISOString(),
  legs, extraQ, runs,
  results, medians: med,
};
const file = `${ROOT}/tests/results/tcgbench-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)}.json`;
fs.writeFileSync(file, JSON.stringify(out, null, 1));
fs.writeFileSync(`${ROOT}/tests/results/tcgbench-latest.json`, JSON.stringify(out, null, 1));
console.log(`results: ${file} (+ tcgbench-latest.json)`);
