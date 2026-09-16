// What does one TB->TB dispatch cost, and does instance locality matter?
//
//   PORT=8080 node tools/dispatch-probe.mjs [--funcs 4096] [--iters 30e6]
//                                           [--browsers chromium,firefox]
//
// Every TB entry in the wasm64 backend is a `return_call_indirect` through
// the shared chain table (tcg_out_goto_ptr / tcg_out_goto_tb), and the
// callee almost always lives in a *different* module instance: a batch
// holds W64_BATCH_N=128 TBs and the guest chains across batches freely.
// The hand-off has priced compile, MMIO, hflags and the lookup helper; the
// dispatch itself has never been priced, and at ~11 M TB entries/s (EL71
// boot: ~44 MIPS over 3.8 insns per TB) even 2 ns of it is 2 % of wall.
//
// The REJECTED table carries one hint that instance locality is real:
// turning compaction off ("merging ~1000 TB functions into one module")
// was said to buy back in execution locality what it cost in compile time.
// Nobody measured the locality half.
//
// Method: F functions of the real TB signature (i64,i64,i64)->i32, each
// decrementing a counter in memory and tail-calling the next index of a
// pseudo-random sequence, all registered in one shared table.  Variants
// differ ONLY in the final instruction and in how many module instances
// the F functions are spread over, so a difference is dispatch:
//
//   loop        one function, plain wasm loop, no dispatch    (work floor)
//   direct      return_call to a fixed neighbour, 1 module    (call floor)
//   ind-same    return_call_indirect, constant index          (predictable)
//   ind/K       return_call_indirect, random index, K funcs per module
//               -- K=128 is the shipping W64_BATCH_N, K=FUNCS is one module
import { chromium, firefox } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FUNCS = Number(opt("funcs", 4096));
const ITERS = Number(opt("iters", 30e6));
const LIVE = Number(opt("live", 0)) || FUNCS;   // hot set the sequence draws from
const STRIDE = Number(opt("stride", 576));     // bytes between TB descriptors
const SPLITS = opt("splits", "").split(",").filter(Boolean).map(Number);
const PORT = process.env.PORT || "8080";
const browsers = opt("browsers", "chromium").split(",");

const PROBE = String.raw`
const FUNCS = __FUNCS__, ITERS = __ITERS__, LIVE = __LIVE__;
const SPLITS = __SPLITS__.length ? __SPLITS__ : [1, 8, 32, 128, 512, FUNCS];
const SEQMASK = 8191;                       // 8192-entry index sequence
const DESCBASE = 65536;                     // sparse descriptor array base
const STRIDE = __STRIDE__;

const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sl = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7;
  if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
  o.push(b | 0x80); } };
const st = (t) => [t.length, ...t.split("").map(c => c.charCodeAt(0))];
const sect = (id, c) => [id, ...u(c.length), ...c];

// locals: params 0=env 1=sp 2=tp (i64); declared 3=$n (i64), 4=$idx (i32)
const DEC = [0x41, 0, 0x41, 0, 0x29, 3, 0, 0x42, 1, 0x7d, 0x22, 3, 0x37, 3, 0];
const SEQ = [0x20, 3, 0x42, ...sl(SEQMASK), 0x83, 0xa7, 0x41, 2, 0x74,
             0x28, 2, ...u(64), 0x21, 4];
// the real dispatch reads its table index out of the TARGET TB's descriptor,
// one 20-byte header per ~576-byte module staging area: a second dependent
// load, one cold cache line per TB.  STRIDE=0 keeps the dense form.
const DESC = (stride) => stride
  ? [0x20, 4, 0x41, ...sl(stride), 0x6c, 0x28, 2, ...u(DESCBASE), 0x21, 4]
  : [];

// One module holding global functions [base, base+n), registered into the
// shared table at those same indices by an active element segment.
function moduleBytes(base, n, kind, stride) {
  const body = (i) => {
    const b = [2, 1, 0x7e, 1, 0x7f];        // 2 local runs: 1x i64, 1x i32
    if (kind === "loop") {
      b.push(0x03, 0x40, ...DEC, ...SEQ, ...DESC(stride),
             0x20, 3, 0x50, 0x45, 0x0d, 0,  // br_if 0 while n != 0
             0x0b, 0x41, 0, 0x0b);
      return [...u(b.length), ...b];
    }
    b.push(...DEC);
    b.push(0x20, 3, 0x50, 0x04, 0x40, 0x41, 0, 0x0f, 0x0b);  // if (!n) return 0
    b.push(...SEQ, ...DESC(stride));
    b.push(0x20, 0, 0x20, 1, 0x20, 2);      // (env, sp, tp)
    if (kind === "direct") {
      b.push(0x12, ...u((i + 1) % n));      // return_call, fixed neighbour
    } else if (kind === "ind-same") {
      b.push(0x41, ...sl(base), 0x13, 0, 0);
    } else {
      b.push(0x20, 4, 0x13, 0, 0);          // return_call_indirect seq[..]
    }
    b.push(0x0b);
    return [...u(b.length), ...b];
  };
  const bodies = [];
  for (let i = 0; i < n; i++) bodies.push(body(i));
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

async function measure(kind, split, stride) {
  const mem = new WebAssembly.Memory({ initial: 96 });
  const tab = new WebAssembly.Table({ initial: FUNCS, element: "anyfunc" });
  const imports = { e: { m: mem, t: tab } };
  let bytes = 0;
  const insts = [];
  for (let base = 0; base < FUNCS; base += split) {
    const b = moduleBytes(base, Math.min(split, FUNCS - base), kind, stride);
    bytes += b.length;
    insts.push(new WebAssembly.Instance(new WebAssembly.Module(b), imports));
  }
  const seq = new Int32Array(mem.buffer, 64, SEQMASK + 1);
  let x = 123456789;
  for (let i = 0; i <= SEQMASK; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    seq[i] = x % LIVE;
  }
  if (stride) {   // desc[i] at DESCBASE + i*stride holds i itself
    const d = new DataView(mem.buffer);
    for (let i = 0; i < FUNCS; i++) d.setInt32(DESCBASE + i * stride, i, true);
  }
  const ctr = new BigInt64Array(mem.buffer, 0, 1);
  const entry = tab.get(0);
  const run = (n) => { ctr[0] = BigInt(n); entry(0n, 0n, 0n); };
  run(2e6); run(2e6);                       // warm / tier up
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    run(ITERS);
    const ns = (performance.now() - t) * 1e6 / ITERS;
    if (ns < best) best = ns;
  }
  return { kind, split, stride, mods: insts.length, kb: Math.round(bytes / 1024), ns: best };
}

const out = [];
out.push(await measure("loop", FUNCS, 0));
out.push(await measure("ind-same", FUNCS, 0));
for (const sp of SPLITS) out.push(await measure("ind", sp, 0));
for (const sp of SPLITS) out.push(await measure("ind", sp, STRIDE));
return out;
`;

for (const name of browsers) {
  const type = name === "firefox" ? firefox : chromium;
  let b;
  try { b = await type.launch({ headless: true }); }
  catch (e) { console.log(`${name}: launch failed: ${String(e).slice(0, 120)}`); continue; }
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log(`[${name}] pageerror: ${String(e).slice(0, 300)}`));
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const body = PROBE.replaceAll("__FUNCS__", String(FUNCS))
                    .replaceAll("__ITERS__", String(ITERS))
                    .replaceAll("__LIVE__", String(LIVE))
                    .replaceAll("__STRIDE__", String(STRIDE))
                    .replaceAll("__SPLITS__", JSON.stringify(SPLITS));
  let rows;
  try {
    rows = await p.evaluate(`(async () => { ${body} })()`);
  } catch (e) {
    console.log(`[${name}] FAILED: ${String(e).slice(0, 500)}`);
    await b.close(); continue;
  }
  const loop = rows.find((r) => r.kind === "loop").ns;
  console.log(`DISPATCH ${name}  funcs=${FUNCS} live=${LIVE} stride=${STRIDE} iters=${ITERS}`);
  for (const r of rows) {
    const tag = r.kind === "ind" ? `ind/${r.split} ${r.stride ? "+desc@" + r.stride : "dense    "} (${r.mods} mods)` : r.kind;
    console.log(`  ${tag.padEnd(30)} ${r.ns.toFixed(2)} ns/iter` +
      (r.kind === "loop" ? "   (work floor)"
        : `   dispatch = ${(r.ns - loop).toFixed(2)} ns`));
  }
  await b.close();
}
