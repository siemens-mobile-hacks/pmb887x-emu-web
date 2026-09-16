// How many calls does a wasm function need before it leaves the baseline
// tier, and does that number depend on its size?
//
//   PORT=8080 node tools/tierup-probe.mjs [--sizes 20,80,320,1280]
//                                         [--chunk 5000] [--chunks 120]
//
// ~3.6 % of this emulator's TB entries execute baseline-tier code at ~2x
// the optimizing tier's cost (doc/lessons.md, round twenty-one), and
// nothing page-side can set a V8 flag.  The one idea with a mechanism
// behind it is merging a batch's members into a single br_table-dispatched
// function: if V8's tiering budget drains by function *size* on every
// call, then merging N members multiplies both the size and the call count
// and the function tiers up ~N^2 sooner.  If instead the budget drains by
// 1 per call, merging buys only N, and the br_table costs more than that.
//
// So measure the rule before building anything on it.  One continuous run
// per body size in a fresh instance, timed in chunks; the chunk where
// ns/call falls off is the tier-up point, and `x size` at the end of each
// row is the product that would be constant if the budget drained by size.
//
// Two ways to get this wrong, both paid for once: a warm-then-measure
// ladder cannot work, because the measuring calls drain the budget too, so
// measurement is what causes the transition; and the body must be *live* --
// a dead one is removed by the optimizing tier's DCE and every trial then
// reads as already-tiered, while a straight dependent add/xor chain
// compiles the same in both tiers and reads as never-tiered.
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SIZES = opt("sizes", "60,240,960,3840").split(",").map(Number);
const CHUNK = Number(opt("chunk", 5000));
const CHUNKS = Number(opt("chunks", 120));
const PORT = process.env.PORT || "8080";

const PROBE = String.raw`
const SIZES = __SIZES__;
const CHUNK = __CHUNK__, CHUNKS = __CHUNKS__;

const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sl = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7;
  if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
  o.push(b | 0x80); } };
const st = (t) => [t.length, ...t.split("").map(c => c.charCodeAt(0))];
const sect = (id, c) => [id, ...u(c.length), ...c];

// f(i64 n) -> i64, shaped like a TB: the backend's own 69 declared locals
// (33 i32 + 32 i64 + $scr32 + 3 i64 scratch) and @ops operations rotating
// across all 32 i64 register locals, so the baseline tier spills where the
// optimizing tier allocates -- and pays the entry zeroing the optimizing
// tier drops.  A straight dependent add/xor chain does NOT work here: both
// tiers emit the same machine ops for it and the probe reads a flat line.
// @salt makes every module's bytes distinct so V8 cannot reuse a compiled
// NativeModule between trials.
const R64 = (i) => 34 + (i % 32);                 // i64 register locals
function moduleBytes(ops, salt) {
  const b = [4, 33, 0x7f, 32, 0x7e, 1, 0x7f, 3, 0x7e];
  b.push(0x20, 0, 0x21, 34);                      // reg0 = param
  for (let i = 0; i < ops; i++) {
    const r = R64(i + 1);
    b.push(0x20, 34, 0x20, r, 0x7c, 0x21, 34);    // reg0 += reg_r
    b.push(0x20, r, 0x42, ...sl((salt + i) & 0x3f), 0x7c, 0x21, r);
  }
  b.push(0x20, 34, 0x0b);                         // return reg0
  const body = [...u(b.length), ...b];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sect(1, [1, 0x60, 1, 0x7e, 1, 0x7e]),
    ...sect(3, [1, 0]),
    ...sect(7, [1, ...st("f"), 0x00, 0]),
    ...sect(10, [1, ...body]),
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let salt = 1;

// One continuous run in a fresh instance, timed in chunks: the budget is
// per (instance, function) and the measurement calls drain it too, so a
// warm-then-measure ladder cannot see the transition -- measuring is what
// causes it.  Chunk index x CHUNK locates the tier-up to +-CHUNK calls.
async function trial(ops) {
  const bytes = moduleBytes(ops, salt++);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const f = inst.exports.f;
  const pts = [];
  let acc = 1n;
  for (let c = 0; c < CHUNKS; c++) {
    const t = performance.now();
    for (let i = 0; i < CHUNK; i++) acc = f(acc);
    pts.push((performance.now() - t) * 1e6 / CHUNK);
  }
  return { bytes: bytes.length, pts, acc: Number(acc & 1n) };
}

const out = [];
for (const ops of SIZES) {
  const r = await trial(ops);
  out.push({ ops, bytes: r.bytes, pts: r.pts });
  await sleep(50);
}
return out;
`;

const b = await chromium.launch({ headless: true, args: process.env.JS_FLAGS ? [`--js-flags=${process.env.JS_FLAGS}`] : [] });
const p = await b.newPage();
p.on("pageerror", (e) => console.log(`pageerror: ${String(e).slice(0, 300)}`));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
let rows;
try {
  rows = await p.evaluate(`(async () => { ${PROBE.replaceAll("__SIZES__", JSON.stringify(SIZES))
    .replaceAll("__CHUNK__", String(CHUNK)).replaceAll("__CHUNKS__", String(CHUNKS))} })()`);
} catch (e) {
  console.log(`FAILED: ${String(e).slice(0, 600)}`);
  await b.close(); process.exit(1);
}
console.log(`TIERUP  chunk=${CHUNK} calls x ${CHUNKS}` +
            `${process.env.JS_FLAGS ? "  " + process.env.JS_FLAGS : ""}`);
for (const r of rows) {
  const slow = Math.min(...r.pts.slice(0, 3));
  const fast = Math.min(...r.pts);
  const i = r.pts.findIndex((q) => q < slow * 0.8);
  console.log(`  body ${String(r.bytes).padStart(6)} B   ` +
    `${slow.toFixed(1)} -> ${fast.toFixed(1)} ns/call   ` +
    (i < 0 ? "no transition"
           : `tier-up at ~${((i + 1) * CHUNK).toExponential(2)} calls` +
             `   (x size = ${(((i + 1) * CHUNK) * r.bytes).toExponential(2)})`));
}
await b.close();
