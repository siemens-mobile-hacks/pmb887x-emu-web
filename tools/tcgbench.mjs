// tcgbench — fast-iteration backend benchmark (tests/tcgbench, -M
// versatilepb): fixed hot-loop phases over the backend's per-op paths,
// timed by timestamping each phase's serial line.  The phone-firmware
// boots stay the final gates; this is the A/B loop (seconds per leg).
//
//   node tools/tcgbench.mjs                       # native-jit + dist-jit
//   LEGS=native-jit,native-tci,dist-jit,dist node tools/tcgbench.mjs
//   EXTRA_Q="env=W64_NOACCTINLINE=1" node tools/tcgbench.mjs   # wasm knob
//   SUITE=quick node tools/tcgbench.mjs           # ÷4-iteration smoke image
//     (tcgbench-quick.bin, `make -C tests/tcgbench quick install`): ~3 s per
//     wasm64 leg, TCI leg ~25 s; serial poll 40 ms (POLL_MS) so the 0.3–1.2 s
//     phases still resolve to ~5–10 %.  ns/access and MIPS are directly
//     comparable with the full image; per-phase checksums are not.
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
const icounts = (process.env.ICOUNTS || "0").split(","); // e.g. "0,1": tax matrix
const extraQ = process.env.EXTRA_Q || "";
const runs = Number(process.env.RUNS || 1);
const suite = process.env.SUITE === "quick" ? "tcgbench-quick" : "tcgbench";
// serial-poll period bounds the per-phase timestamp error on the wasm legs;
// the quick image has ~0.3–1.2 s phases on wasm64, so poll faster there
const pollMs = Number(process.env.POLL_MS || (suite === "tcgbench" ? 150 : 40));
const bins = {
  "native-jit": process.env.QEMU_JIT || `${ROOT}/build/qemu-native-build/qemu-system-arm`,
  "native-tci": process.env.QEMU_TCI || `${ROOT}/build/qemu-native-tci-build/qemu-system-arm`,
};

const stamp = () => Number(process.hrtime.bigint() / 1000000n) / 1000; // s, µs res

// run one native leg: returns { phases: [[name, ts]], serial, rc }
function runNative(bin, icount) {
  return new Promise((resolve, reject) => {
    const args = ["-M", "versatilepb",
      "-kernel", `${ROOT}/tests/tcgbench/${suite}.bin`, "-semihosting",
      ...(icount ? ["-icount", "shift=3,sleep=off"] : []),
      "-display", "none", "-monitor", "none", "-serial", "stdio"];
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
async function runWasm(dist, browser, icount) {
  const page = await browser.newPage();
  const q = new URLSearchParams({ suite: `dist/${suite}.bin`, dist });
  if (icount) q.set("icount", "1");
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
      await new Promise((r) => setTimeout(r, pollMs));
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

// per-phase memory accesses per iteration (the poll mirrors and mix):
// the runner turns phase seconds into ns/access — the device-tax metric
const ACC_PER_ITER = { rampoll: 4, mmiopoll: 4, mmiow: 2 };
const ITERS = {}; // phase -> n, parsed from the serial lines

const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (let r = 0; r < runs; r++) {
    for (const leg of legs) {
      for (const ic of icounts) {
      const icount = ic === "1";
      const t0 = stamp();
      const res = leg.startsWith("native-")
        ? await runNative(bins[leg], icount)
        : await runWasm(leg, browser, icount);
      const secs = phaseSecs(res.phases);
      const total = secs.reduce((a, [, s]) => a + s, 0);
      const cksum = (res.serial.join("\n").match(/^BENCH done cksum=(\S+)/m) || [])[1] || null;
      for (const l of res.serial) {
        const m = l.match(/^BENCH (\S+) n=(\d+)/);
        if (m) ITERS[m[1]] = Number(m[2]);
      }
      const entry = {
        leg, icount, run: r + 1, rc: res.rc, total: +total.toFixed(3),
        wasm: leg.startsWith("native-") ? undefined : path.join("site", leg, "qemu-system-arm.wasm"),
        wasmSha: leg.startsWith("native-") ? null : (() => {
          try { return createHash("sha256").update(fs.readFileSync(path.join(ROOT, "site", leg, "qemu-system-arm.wasm"))).digest("hex").slice(0, 16); } catch { return null; }
        })(),
        phases: secs.map(([n, s]) => ({
          n, s: +s.toFixed(3),
          nsPerAccess: ACC_PER_ITER[n] && ITERS[n]
            ? +((s * 1e9) / (ITERS[n] * ACC_PER_ITER[n])).toFixed(1)
            : undefined,
        })),
        insns: res.insns, tbs: res.tbs,
        mips: res.insns && total ? +(res.insns / total / 1e6).toFixed(1) : null,
        cksum,
      };
      results.push(entry);
      console.log(`== ${leg}${icount ? "+icount" : ""} run${r + 1}: total ${entry.total}s` +
        (entry.mips ? ` (${entry.mips} MIPS, ${(entry.insns / 1e6).toFixed(0)}M insns, ${(entry.tbs / 1e6).toFixed(1)}M TBs, ${(entry.insns / Math.max(1, entry.tbs)).toFixed(1)} insns/TB)` : "") +
        `  cksum=${cksum}`);
      for (const { n, s, nsPerAccess } of entry.phases) {
        console.log(`   ${n.padEnd(8)} ${s.toFixed(3)}s` +
          (nsPerAccess ? `  (${nsPerAccess} ns/access)` : ""));
      }
      }
    }
  }
} finally {
  try { await browser.close(); } catch {}
}

// summary + cross-leg checks
const byLeg = new Map();
for (const e of results) {
  const k = e.leg + (e.icount ? "+icount" : "");
  if (!byLeg.has(k)) byLeg.set(k, []);
  byLeg.get(k).push(e);
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

// device-tax summary: ns/access for the poll mirrors, per leg+icount
{
  console.log("\n=== device tax (ns per access, median) ===");
  const rows = [];
  for (const [leg, es] of byLeg) {
    const acc = {};
    for (const p of es.flatMap((e) => e.phases)) {
      if (p.nsPerAccess) (acc[p.n] ||= []).push(p.nsPerAccess);
    }
    if (Object.keys(acc).length) {
      const medOf = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
      const r = {};
      for (const n of Object.keys(acc)) r[n] = medOf(acc[n]);
      rows.push([leg, r]);
      const ram = r.rampoll, mmio = r.mmiopoll;
      const extra = ram && mmio ? `  MMIO/RAM = ${(mmio / ram).toFixed(0)}x, dispatch tax = ${(mmio - ram).toFixed(0)} ns/access` : "";
      console.log(`${leg.padEnd(12)} ram=${r.rampoll} mmio=${r.mmiopoll ?? "-"} mmiow=${r.mmiow ?? "-"}${extra}`);
    }
  }
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
  suite, legs, icounts, extraQ, runs,
  results, medians: med,
};
const file = `${ROOT}/tests/results/tcgbench-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)}.json`;
fs.writeFileSync(file, JSON.stringify(out, null, 1));
const latest = `tcgbench-${suite === "tcgbench" ? "" : "quick-"}latest.json`;
fs.writeFileSync(`${ROOT}/tests/results/${latest}`, JSON.stringify(out, null, 1));
console.log(`results: ${file} (+ ${latest})`);
