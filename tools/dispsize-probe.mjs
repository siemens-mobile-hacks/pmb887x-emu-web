// What makes a `return_call_indirect` dispatch cost 8 ns -- branch
// misprediction, or the cache miss on the table entry and the target code?
//
//   PORT=8080 node tools/dispsize-probe.mjs [--iters 20e6] [--sizes 8,64,...]
//
// Round twenty-three priced the TB->TB transition at ~7.7 ns on an EL71 boot
// (9.1 % of wall), and tools/callref-probe.mjs reproduced exactly that, 8.04
// ns, with a *fully random* walk over 4096 functions.  That match is the
// puzzle: the emulator's targets are highly predictable (83.9 % inline-cache
// hit rate, and goto_tb targets are static), so if the cost were branch
// misprediction the emulator should be well under the random-walk figure.
//
// The two candidate costs scale differently with how many distinct functions
// the walk touches:
//
//   misprediction   flat in F -- an indirect predictor loses at any F above
//                   a handful, so 8 functions cost the same as 65536
//   cache           rises with F -- V8's dispatch reads the table entry
//                   (signature, target, instance) and then jumps into the
//                   target's code, so a large F misses in L2/L3 on both
//
// Same walk, same code, only F changes.  `rand` is the pseudo-random walk;
// `seq` reads its next index from the same array (identical instruction
// stream) but the array holds a linear sweep, so the *stream of targets* is
// predictable while every memory access stays the same.
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SIZES = opt("sizes", "8,64,512,4096,32768,131072").split(",").map(Number);
const ITERS = Number(opt("iters", 20e6));
const REPS = Number(opt("reps", 3));
const PORT = process.env.PORT || "8080";

const PROBE = String.raw`
const SIZES = __SIZES__, ITERS = __ITERS__, REPS = __REPS__;
const SEQBITS = 13, SEQN = 1 << SEQBITS;
const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sl = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7;
  if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
  o.push(b | 0x80); } };
const st = (t) => [t.length, ...t.split("").map(c => c.charCodeAt(0))];
const sect = (id, c) => [id, ...u(c.length), ...c];

// n = load_i64(0) - 1; store it back.  locals 3=$n(i64) 4=$idx(i32)
const DEC = [0x41, 0, 0x41, 0, 0x29, 3, 0, 0x42, 1, 0x7d, 0x22, 3, 0x37, 3, 0];
// idx = i32_load(64 + ((n & SEQMASK) << 2))
const SEQ = [0x20, 3, 0x42, ...sl(SEQN - 1), 0x83, 0xa7, 0x41, 2, 0x74,
             0x28, 2, ...u(64), 0x21, 4];

function moduleBytes(F) {
  const body = [];
  body.push(2, 1, 0x7e, 1, 0x7f);
  body.push(...DEC);
  body.push(0x20, 3, 0x50, 0x04, 0x40, 0x41, 0, 0x0f, 0x0b);
  body.push(...SEQ);
  body.push(0x20, 0, 0x20, 1, 0x20, 2);
  body.push(0x20, 4, 0x13, 0, 0);              // return_call_indirect $0, table 0
  body.push(0x0b);
  const one = [...u(body.length), ...body];

  const types = sect(1, [1, 0x60, 3, 0x7e, 0x7e, 0x7e, 1, 0x7f]);
  const funcs = sect(3, [...u(F), ...Array(F).fill(0)]);
  const table = sect(4, [1, 0x70, 1, ...u(F), ...u(F)]);
  const mem = sect(5, [1, 0x00, 1]);
  const exp = sect(7, [2, ...st("run"), 0, 0, ...st("mem"), 2, 0]);
  const elems = sect(9, [1, 0x02, 0, 0x41, 0, 0x0b, 0x00, ...u(F),
                         ...Array.from({ length: F }, (_, i) => u(i)).flat()]);
  const code = sect(10, [...u(F), ...Array.from({ length: F }, () => one).flat()]);
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
                         ...types, ...funcs, ...table, ...mem, ...exp, ...elems, ...code]);
}

const out = [];
for (const F of SIZES) {
  const row = { F };
  let inst, buildMs;
  try {
    const t0 = performance.now();
    inst = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes(F)));
    buildMs = performance.now() - t0;
  } catch (e) { row.err = String(e).slice(0, 100); out.push(row); continue; }
  row.buildMs = buildMs;
  const bufm = inst.exports.mem.buffer;
  const dv = new DataView(bufm), u32 = new Uint32Array(bufm);
  for (const walk of ["rand", "seq"]) {
    let x = 12345;
    for (let i = 0; i < SEQN; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      u32[16 + i] = walk === "rand" ? x % F : i % F;
    }
    let best = Infinity;
    for (let r = 0; r < REPS; r++) {
      dv.setBigUint64(0, BigInt(Math.round(ITERS / 20)), true);
      inst.exports.run(0n, 0n, 0n);
      dv.setBigUint64(0, BigInt(ITERS), true);
      const t0 = performance.now();
      inst.exports.run(0n, 0n, 0n);
      best = Math.min(best, (performance.now() - t0) * 1e6 / ITERS);
    }
    row[walk] = best;
  }
  out.push(row);
}
return out;
`;

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
const rows = await p.evaluate(`(() => { ${PROBE.replace("__SIZES__", JSON.stringify(SIZES))
  .replace("__ITERS__", String(ITERS)).replace("__REPS__", String(REPS))} })()`);
console.log(`${ITERS} dispatches per point, ns each`);
console.log("   funcs      rand       seq   build");
for (const r of rows) {
  if (r.err) { console.log(`${String(r.F).padStart(8)}  ${r.err}`); continue; }
  console.log(`${String(r.F).padStart(8)}  ${r.rand.toFixed(3).padStart(8)}  ` +
              `${r.seq.toFixed(3).padStart(8)}  ${r.buildMs.toFixed(0)}ms`);
}
await b.close();
