// What do the wasm64 backend's 70 declared locals cost?
//
//   PORT=8080 node tools/locals-probe.mjs [--funcs 4096] [--iters 20e6]
//                                         [--sweep 0,8,16,32,64,69]
//                                         [--liftoff]  (pin the baseline tier)
//
// Every TB function declares TCG_TARGET_NB_REGS i32 locals + the same
// number of i64 locals + $bp + four scratch = ~70 (tcg/wasm64/
// tcg-target.c.inc, W64_L32/W64_L64).  A TB of 3-4 guest insns touches a
// handful of them, but wasm requires locals to be zero at entry and the
// baseline tier has no liveness analysis, so it zeroes every declared
// local on every call -- at ~11 M TB entries/s.  It also has to *emit*
// that zeroing, 128 times per batch module, against a compile budget the
// hand-off prices at 83 us per module.
//
// So: per-call cost and per-module compile cost as a function of the
// declared-local count, on functions shaped like a real TB (same
// signature, same return_call_indirect dispatch, W64_BATCH_N per module).
// Run it twice -- once plain, once --liftoff -- because the optimizing
// tier drops unused locals in SSA and the baseline tier cannot.
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FUNCS = Number(opt("funcs", 4096));
const ITERS = Number(opt("iters", 20e6));
const SPLIT = Number(opt("split", 128));        // W64_BATCH_N
const SWEEP = opt("sweep", "0,8,16,32,64,69").split(",").map(Number);
const LIFTOFF = argv.includes("--liftoff");
const PORT = process.env.PORT || "8080";

const PROBE = String.raw`
const FUNCS = __FUNCS__, ITERS = __ITERS__, SPLIT = __SPLIT__;
const SWEEP = __SWEEP__;
const SEQMASK = 8191;

const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sl = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7;
  if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
  o.push(b | 0x80); } };
const st = (t) => [t.length, ...t.split("").map(c => c.charCodeAt(0))];
const sect = (id, c) => [id, ...u(c.length), ...c];

// params 0=env 1=sp 2=tp (i64); declared 3=$n (i64), 4=$idx (i32),
// then @extra unused locals split evenly between i32 and i64 the way the
// backend splits them.
const DEC = [0x41, 0, 0x41, 0, 0x29, 3, 0, 0x42, 1, 0x7d, 0x22, 3, 0x37, 3, 0];
const SEQ = [0x20, 3, 0x42, ...sl(SEQMASK), 0x83, 0xa7, 0x41, 2, 0x74,
             0x28, 2, ...u(64), 0x21, 4];

function moduleBytes(base, n, extra) {
  const e32 = extra >> 1, e64 = extra - e32;
  const runs = [1, 0x7e, 1, 0x7f];
  if (e32) runs.push(e32, 0x7f);
  if (e64) runs.push(e64, 0x7e);
  const nruns = 2 + (e32 ? 1 : 0) + (e64 ? 1 : 0);
  const body = () => {
    const b = [nruns, ...runs];
    b.push(...DEC);
    b.push(0x20, 3, 0x50, 0x04, 0x40, 0x41, 0, 0x0f, 0x0b);   // if (!n) return 0
    b.push(...SEQ);
    b.push(0x20, 0, 0x20, 1, 0x20, 2, 0x20, 4, 0x13, 0, 0);   // return_call_indirect
    b.push(0x0b);
    return [...u(b.length), ...b];
  };
  const bodies = [];
  for (let i = 0; i < n; i++) bodies.push(body());
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sect(1, [1, 0x60, 3, 0x7e, 0x7e, 0x7e, 1, 0x7f]),
    ...sect(2, [2,
      ...st("e"), ...st("m"), 0x02, 0x00, ...u(96),
      ...st("e"), ...st("t"), 0x01, 0x70, 0x00, ...u(FUNCS)]),
    ...sect(3, [...u(n), ...Array(n).fill(0)]),
    ...sect(9, [1, 0x00, 0x41, ...sl(base), 0x0b, ...u(n),
                ...Array.from({ length: n }, (_, i) => u(i)).flat()]),
    ...sect(10, [...u(n), ...bodies.flat()]),
  ]);
}

async function measure(extra) {
  const mem = new WebAssembly.Memory({ initial: 96 });
  const tab = new WebAssembly.Table({ initial: FUNCS, element: "anyfunc" });
  const imports = { e: { m: mem, t: tab } };
  const blobs = [];
  for (let base = 0; base < FUNCS; base += SPLIT) {
    blobs.push(moduleBytes(base, Math.min(SPLIT, FUNCS - base), extra));
  }
  // compile: best-of-3 over the whole set, charged per module
  let compileNs = Infinity;
  let mods = [];
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    mods = blobs.map((b) => new WebAssembly.Module(b));
    const ns = (performance.now() - t) * 1e6 / blobs.length;
    if (ns < compileNs) compileNs = ns;
  }
  const insts = mods.map((m) => new WebAssembly.Instance(m, imports));
  const seq = new Int32Array(mem.buffer, 64, SEQMASK + 1);
  let x = 123456789;
  for (let i = 0; i <= SEQMASK; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    seq[i] = x % FUNCS;
  }
  const ctr = new BigInt64Array(mem.buffer, 0, 1);
  const entry = tab.get(0);
  const run = (n) => { ctr[0] = BigInt(n); entry(0n, 0n, 0n); };
  run(2e6); run(2e6);
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    run(ITERS);
    const ns = (performance.now() - t) * 1e6 / ITERS;
    if (ns < best) best = ns;
  }
  const kb = blobs.reduce((a, b) => a + b.length, 0) / 1024;
  return { extra, ns: best, compileUs: compileNs / 1000, kb: Math.round(kb),
           insts: insts.length };
}

const out = [];
for (const e of SWEEP) out.push(await measure(e));
return out;
`;

const jsFlags = LIFTOFF ? "--liftoff-only" : (process.env.JS_FLAGS || "");
const args = jsFlags ? [`--js-flags=${jsFlags}`] : [];
const b = await chromium.launch({ headless: true, args });
const p = await b.newPage();
p.on("pageerror", (e) => console.log(`pageerror: ${String(e).slice(0, 300)}`));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
const body = PROBE.replaceAll("__FUNCS__", String(FUNCS))
                  .replaceAll("__ITERS__", String(ITERS))
                  .replaceAll("__SPLIT__", String(SPLIT))
                  .replaceAll("__SWEEP__", JSON.stringify(SWEEP));
let rows;
try {
  rows = await p.evaluate(`(async () => { ${body} })()`);
} catch (e) {
  console.log(`FAILED: ${String(e).slice(0, 500)}`);
  await b.close(); process.exit(1);
}
console.log(`LOCALS funcs=${FUNCS} split=${SPLIT} iters=${ITERS}` +
            `${LIFTOFF ? "  tier=liftoff-only" : "  tier=default"}`);
const base = rows[0];
for (const r of rows) {
  console.log(`  +${String(r.extra).padStart(3)} locals   ` +
    `${r.ns.toFixed(2)} ns/call (${(r.ns - base.ns >= 0 ? "+" : "")}` +
    `${(r.ns - base.ns).toFixed(2)})   ` +
    `compile ${r.compileUs.toFixed(1)} us/module   ${r.kb} KB`);
}
await b.close();
