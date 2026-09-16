// Does `new WebAssembly.Module` get slower as live modules accumulate?
//
//   PORT=8080 node tools/modgrow.mjs [--total 8000] [--bucket 250]
//                                    [--funcs 5] [--shared]
//
// The one variable tools/modfloor.mjs holds fixed.  It established that
// module *shape* explains nothing -- every realistic shape costs 21-25 us
// there, and W64_MODBENCH saw 12-31 us back-to-back inside the vCPU worker
// -- while the emulator pays ~74 us fixed per module (fit over its own two
// populations: 2.3 KB closes at 77 us, 404 KB compaction modules at
// 580 us).  But modfloor creates a handful of modules; the boot holds
// hundreds to W64_LIVE_MAX=6144 of them at once, each with its own
// NativeModule and code space.
//
// So: build realistically-shaped modules one after another, KEEP every
// instance, and print the cost per bucket as the live set grows.  Then
// drop them and re-measure, which separates "the live set is the cost"
// from "the isolate got dirty and stays dirty".
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TOTAL = Number(opt("total", 8000));
const BUCKET = Number(opt("bucket", 250));
const FUNCS = Number(opt("funcs", 5));
const SHARED = argv.includes("--shared");
const PORT = process.env.PORT || "8080";

const PROBE = String.raw`
const TOTAL = __TOTAL__, BUCKET = __BUCKET__, FUNCS = __FUNCS__;
const SHARED = __SHARED__;

const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sl = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7;
  if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
  o.push(b | 0x80); } };
const st = (t) => [t.length, ...t.split("").map(c => c.charCodeAt(0))];
const sect = (id, c) => [id, ...u(c.length), ...c];

// A TB-shaped function: 69 declared locals (32 i32 regs + $bp, 32 i64
// regs, $scr32, 3 i64 scratch), a body of ~100 arithmetic ops on them and
// a return_call_indirect tail, so size and shape match a real member.
function funcBody(seed) {
  const b = [4, 33, 0x7f, 32, 0x7e, 1, 0x7f, 3, 0x7e];
  for (let i = 0; i < 100; i++) {
    b.push(0x20, 3 + (i % 32));                    // local.get i32 reg
    b.push(0x41, ...sl(seed + i));                 // i32.const
    b.push(0x6a);                                  // i32.add
    b.push(0x21, 3 + ((i + 7) % 32));              // local.set
  }
  b.push(0x20, 0, 0x20, 1, 0x20, 2);               // (env, sp, tp)
  b.push(0x41, ...sl(seed & 8191), 0x13, 0, 0);    // return_call_indirect
  b.push(0x0b);
  return [...u(b.length), ...b];
}

function moduleBytes(seed) {
  const bodies = [];
  for (let i = 0; i < FUNCS; i++) bodies.push(funcBody(seed + i * 131));
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sect(1, [1, 0x60, 3, 0x7e, 0x7e, 0x7e, 1, 0x7f]),
    ...sect(2, [2,
      ...st("e"), ...st("m"), 0x02, (SHARED ? 0x03 : 0x01), ...u(96), ...u(96),
      ...st("e"), ...st("t"), 0x01, 0x70, 0x00, ...u(16384)]),
    ...sect(3, [...u(FUNCS), ...Array(FUNCS).fill(0)]),
    ...sect(10, [...u(FUNCS), ...bodies.flat()]),
  ]);
}

const mem = new WebAssembly.Memory(
  SHARED ? { initial: 96, maximum: 96, shared: true } : { initial: 96, maximum: 96 });
const tab = new WebAssembly.Table({ initial: 16384, element: "anyfunc" });
const imports = { e: { m: mem, t: tab } };

const live = [];
const rows = [];
let bytes = 0;
for (let base = 0; base < TOTAL; base += BUCKET) {
  const blobs = [];
  for (let i = 0; i < BUCKET; i++) blobs.push(moduleBytes(base + i));
  const t = performance.now();
  for (const b of blobs) {
    live.push(new WebAssembly.Instance(new WebAssembly.Module(b), imports));
  }
  const us = (performance.now() - t) * 1000 / BUCKET;
  bytes = blobs[0].length;
  rows.push({ liveAfter: live.length, us });
}
// drop everything and re-measure: is it the live set, or the isolate?
live.length = 0;
if (globalThis.gc) { try { globalThis.gc(); } catch (e) {} }
await new Promise((r) => setTimeout(r, 1500));
const blobs = [];
for (let i = 0; i < BUCKET; i++) blobs.push(moduleBytes(999000 + i));
const t2 = performance.now();
const after = [];
for (const b of blobs) after.push(new WebAssembly.Instance(new WebAssembly.Module(b), imports));
const dropUs = (performance.now() - t2) * 1000 / BUCKET;
return { rows, bytes, dropUs, kept: after.length };
`;

const b = await chromium.launch({ headless: true, args: process.env.JS_FLAGS ? [`--js-flags=${process.env.JS_FLAGS}`] : [] });
const p = await b.newPage();
p.on("pageerror", (e) => console.log(`pageerror: ${String(e).slice(0, 300)}`));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
let r;
try {
  r = await p.evaluate(`(async () => { ${PROBE.replaceAll("__TOTAL__", String(TOTAL))
    .replaceAll("__BUCKET__", String(BUCKET)).replaceAll("__FUNCS__", String(FUNCS))
    .replaceAll("__SHARED__", String(SHARED))} })()`);
} catch (e) {
  console.log(`FAILED: ${String(e).slice(0, 600)}`);
  await b.close(); process.exit(1);
}
console.log(`MODGROW funcs=${FUNCS}/module  ${r.bytes} B/module  bucket=${BUCKET}` +
            `${SHARED ? "  shared-memory" : ""}`);
for (const row of r.rows) {
  console.log(`  live ${String(row.liveAfter).padStart(5)}   ${row.us.toFixed(1)} us/module`);
}
console.log(`  after dropping all  ${r.dropUs.toFixed(1)} us/module`);
await b.close();
