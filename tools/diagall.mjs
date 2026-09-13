// Full wasm_memstat counter dump — every WASM_DIAG_* counter by name,
// sampled over a boot.  memstat.mjs prints a hand-picked subset (the
// memory path); this prints all of them, which is what you want when
// you are deciding WHERE the time goes rather than confirming a known
// path.  Names mirror qemu/include/qemu/wasm-diag.h in index order —
// the numeric indices are the wasm_memstat() ABI, so keep them aligned.
//
//   PORT=8080 node tools/diagall.mjs [secs] [intervalSecs] [--dist dist-jit]
//   EXTRA_Q=... node tools/diagall.mjs 60 20      # page query knobs
//
// Prints one block per sample: v/insns plus every non-zero counter, and
// a final DELTA block (last sample minus first) so a rate is readable
// without arithmetic.
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const secs = Number(argv.find((a) => /^\d+$/.test(a)) || 60);
const iv = Number(argv.filter((a) => /^\d+$/.test(a))[1] || secs);
const dist = opt("dist", "dist-jit");
const port = process.env.PORT || "8080";
const extraQ = process.env.EXTRA_Q || "";
// Default rt=off like idlebench's milestones: counters are read against the
// engine's own speed, not against the real-time cap's pacing.
const rt = process.env.RT || "off";

// index -> name, in wasm-diag.h order
const NAMES = [
  "ldHelper", "stHelper", "ioLd", "ioSt", "tlbFill", "txnFailed", "txnNoexit",
  "tbGen", "tbFlush", "ioRewind", "romdFlip", "topoCommit", "topoReused",
  "lookup", "lookupJc", "lookupQht", "jcFlush", "tbGenCounted",
  "tlbFlush", "tlbFlushRange", "fillFetch", "fillProbe", "fillSamepage",
  "fillInvalid", "fillLarge", "fillIdx", "fillEvict", "tlbSize0", "tlbUsed0",
  "halt", "physCall", "physScan", "physDrop",
  "modBytes", "modCount", "tbBytes",
  "warpNs", "warpB0", "warpB1", "warpB2", "warpB3", "warpB4", "warpB5", "warpB6",
  "modSrc", "closeBytes", "compactBytes", "ensureBytes",
  "closeN", "compactN", "ensureN",
];

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const samples = [];
p.on("console", (m) => {
  const t = m.text();
  if (!t.startsWith("DIAG ")) return;
  const o = JSON.parse(t.slice(5));
  samples.push(o);
  const parts = [`t=${o.t.toFixed(1)}s v=${o.v.toFixed(2)} insns=${(o.insns / 1e6).toFixed(0)}M`];
  for (let i = 0; i < NAMES.length; i++) if (o.c[i]) parts.push(`${NAMES[i]}=${o.c[i]}`);
  console.log(parts.join(" "));
});
const url = `http://127.0.0.1:${port}/?dist=${dist}&rt=${rt}${extraQ ? "&" + extraQ : ""}`;
await p.goto(url, { waitUntil: "domcontentloaded" });
await p.addScriptTag({ content: `
  window.__t0 = performance.now();
  window.__diag = setInterval(() => {
    const m = window.__qemu;
    if (!m || !m._wasm_memstat) return;
    const c = [];
    for (let i = 0; i < ${NAMES.length}; i++) c.push(Number(m._wasm_memstat(i)));
    console.log("DIAG " + JSON.stringify({
      t: (performance.now() - window.__t0) / 1000,
      v: Number(m._wasm_vclock()) / 1e9,
      insns: Number(m._wasm_insns()),
      c,
    }));
  }, ${iv * 1000});
` });
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, secs * 1000));
await b.close();

if (samples.length >= 2) {
  const a = samples[0], z = samples[samples.length - 1];
  console.log(`\n=== DELTA over ${(z.t - a.t).toFixed(1)}s (${((z.insns - a.insns) / 1e6).toFixed(0)}M insns) ===`);
  for (let i = 0; i < NAMES.length; i++) {
    const d = z.c[i] - a.c[i];
    if (d) console.log(`  ${NAMES[i].padEnd(16)} ${String(d).padStart(14)}  (${(d / (z.t - a.t)).toFixed(0)}/s)`);
  }
}
if (samples.length) {
  const z = samples[samples.length - 1];
  console.log(`\n=== TOTALS at t=${z.t.toFixed(1)}s ===`);
  for (let i = 0; i < NAMES.length; i++) if (z.c[i]) console.log(`  ${NAMES[i].padEnd(16)} ${String(z.c[i]).padStart(14)}`);
}
