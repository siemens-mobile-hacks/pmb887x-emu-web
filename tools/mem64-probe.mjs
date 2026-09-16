// What does a memory64 access cost against a memory32 one, and does the
// shape of the index change it?
//
//   PORT=8080 node tools/mem64-probe.mjs [--pages 32768] [--iters 20e6]
//
// The whole port is built -sMEMORY64=1 with a 2 GB shared memory, so every
// load and store the backend emits -- the inline TLB probe, the guest
// memop, the register spills, the diag counters -- is a memory64 access.
// V8 can elide a bounds check entirely when it owns a guard region past
// the memory (that is what makes memory32 accesses free); whether it can
// do the same for a 64-bit index, and whether an index it can prove fits
// in 32 bits is treated differently, has never been measured here.  At
// ~24 M guest memops a second plus the probe's own loads, one cycle either
// way is ~1 % of wall.
//
// Three variants, identical work, differing only in the index:
//   m32   memory32, i32 index                (the bounds-check floor)
//   m64   memory64, i64 index
//   m64x  memory64, i64.extend_i32_u of an i32 index -- provably < 4 GB,
//         which is the form the backend could emit if it helps
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PAGES = Number(opt("pages", 32768));     // 2 GB, as the app links it
const ITERS = Number(opt("iters", 20e6));
const REPS = Number(opt("reps", 3));
const PORT = process.env.PORT || "8080";

const PROBE = String.raw`
const PAGES = __PAGES__, ITERS = __ITERS__, REPS = __REPS__;
const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sl = (n) => { const o = []; for (;;) { const b = Number(BigInt.asIntN(8, BigInt(n) & 0x7fn)) & 0x7f; n = (n - (b & 0x40 ? b - 128 : b)) / 128;
  if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
  o.push(b | 0x80); } };
const st = (t) => [t.length, ...t.split("").map(c => c.charCodeAt(0))];
const sect = (id, c) => [id, ...u(c.length), ...c];

// (i64 n) -> i64 sum.  locals: 0=$n(i64 param), 1=$sum(i64), 2=$i(i64), 3=$j(i32)
function moduleBytes(kind) {
  const is64 = kind !== "m32";
  const idx32 = kind === "m64x" || kind === "m32";
  const b = [];
  b.push(2, 2, 0x7e, 1, 0x7f);              // locals: 2x i64, 1x i32
  b.push(0x03, 0x40);                       // loop void
  for (let k = 0; k < 8; k++) {
    b.push(0x20, 1);                        // sum
    if (idx32) {
      b.push(0x20, 3);                      // $j (i32)
      if (is64) b.push(0xad);               // i64.extend_i32_u
    } else {
      b.push(0x20, 2);                      // $i (i64)
    }
    b.push(0x29, 3, ...u(k * 64));          // i64.load align=8 offset=k*64
    b.push(0x7c, 0x21, 1);                  // i64.add; local.set $sum
  }
  // advance the index by 512, wrapped into a 1 MB window
  if (idx32) {
    b.push(0x20, 3, 0x41, ...sl(512), 0x6a, 0x41, ...sl(0xfffff), 0x71, 0x21, 3);
  } else {
    b.push(0x20, 2, 0x42, ...sl(512), 0x7c, 0x42, ...sl(0xfffff), 0x83, 0x21, 2);
  }
  b.push(0x20, 0, 0x42, 1, 0x7d, 0x22, 0,   // n = n - 1
         0x50, 0x45, 0x0d, 0);              // br_if 0 while n != 0
  b.push(0x0b);                             // end loop
  b.push(0x20, 1, 0x0b);                    // return sum

  const types = sect(1, [1, 0x60, 1, 0x7e, 1, 0x7e]);
  // limits: bit0 max, bit1 shared, bit2 is64
  const mem = sect(5, [1, is64 ? 0x07 : 0x03, ...u(PAGES), ...u(PAGES)]);
  const funcs = sect(3, [1, 0]);
  const exp = sect(7, [1, ...st("run"), 0, 0]);
  const code = sect(10, [1, ...u(b.length), ...b]);
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
                         ...types, ...funcs, ...mem, ...exp, ...code]);
}

const out = {};
for (const kind of ["m32", "m64", "m64x"]) {
  let best = Infinity;
  for (let r = 0; r < REPS; r++) {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes(kind)));
    inst.exports.run(BigInt(Math.round(ITERS / 20)));   // warm + tier up
    const t0 = performance.now();
    inst.exports.run(BigInt(ITERS));
    const dt = performance.now() - t0;
    best = Math.min(best, dt * 1e6 / (ITERS * 8));      // ns per load
  }
  out[kind] = best;
}
return out;
`;

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
const src = PROBE.replace("__PAGES__", String(PAGES))
                 .replace("__ITERS__", String(ITERS))
                 .replace("__REPS__", String(REPS));
const r = await p.evaluate(`(() => { ${src} })()`);
console.log(`pages=${PAGES} (${(PAGES / 16).toFixed(0)} MB), ${ITERS} iters x 8 loads`);
for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(5)} ${v.toFixed(3)} ns/load`);
const base = r.m32;
for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(5)} ${(v / base).toFixed(3)}x m32`);
await b.close();
