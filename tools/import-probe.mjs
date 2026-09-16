// What does a TB module's helper call cost, just for crossing the boundary?
//
//   PORT=8080 node tools/import-probe.mjs [--iters 20e6] [--liftoff]
//
// Every helper a TB calls -- the lookup helper, the ld/st slow paths, the
// MMIO callbacks -- is an *import* of the TB's own module, resolved at
// instantiation to `wasmTable.get(fptr)` on the main qemu module's table
// (tcg/wasm64/wasm64.c, w64_instantiate / w64_batch_instantiate).  So the
// call leaves one module instance and enters another.  Round eighteen
// timed helper_lookup_tb_ptr_lc at 102 ns a call at an 84 % inline-cache
// hit rate; that is ~300 cycles for a jump-cache probe, so either the
// helper body is slower than it looks or the boundary is.
//
// This prices the boundary and nothing else: the same trivial callee,
// reached four ways.
//
//   local        plain call inside the caller's own module   (floor)
//   import-exp   imported as instance.exports.h
//   import-tab   imported as table.get(i) -- what qemu does
//   indirect     call_indirect through a shared table
//
// Run it twice, plain and --liftoff: TB modules mostly execute in the
// baseline tier (tools/locals-probe.mjs), and a boundary the optimizing
// tier inlines through may be real there.
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ITERS = Number(opt("iters", 20e6));
const LIFTOFF = argv.includes("--liftoff");
const PORT = process.env.PORT || "8080";

const PROBE = String.raw`
const ITERS = __ITERS__;

const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sl = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7;
  if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
  o.push(b | 0x80); } };
const st = (t) => [t.length, ...t.split("").map(c => c.charCodeAt(0))];
const sect = (id, c) => [id, ...u(c.length), ...c];
const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

// callee: (i64 env, i64 a) -> i64, returns a + 1.  Deliberately trivial:
// what is being measured is the boundary, not the body.
const CALLEE_TYPE = [0x60, 2, 0x7e, 0x7e, 1, 0x7e];
const CALLEE_BODY = (() => {
  const b = [0, 0x20, 1, 0x42, 1, 0x7c, 0x0b];
  return [...u(b.length), ...b];
})();

// the host module: exports the callee both directly and through a table
function hostBytes() {
  return new Uint8Array([...MAGIC,
    ...sect(1, [1, ...CALLEE_TYPE]),
    ...sect(3, [1, 0]),
    ...sect(4, [1, 0x70, 0x00, ...u(1)]),           // table of 1 funcref
    ...sect(7, [2, ...st("h"), 0x00, 0, ...st("t"), 0x01, 0]),
    ...sect(9, [1, 0x00, 0x41, 0, 0x0b, ...u(1), ...u(0)]),
    ...sect(10, [1, ...CALLEE_BODY]),
  ]);
}

// the caller: run(n) loops n times calling the callee @kind ways, each
// call dependent on the last so the chain cannot be unrolled away.
// param 0 = $n (i64), declared local 1 = $acc (i64).
function callerBytes(kind) {
  // func index space: imported functions first, then defined ones.
  const local = kind === "local";
  const indirect = kind === "indirect";
  const calleeIdx = local ? 1 : 0;                   // defined after run, or imported
  const runIdx = local ? 0 : indirect ? 0 : 1;
  const call = indirect ? [0x41, 0, 0x11, 0, 0x00]   // call_indirect type 0, table 0
                        : [0x10, calleeIdx];
  const run = [];
  run.push(1, 1, 0x7e);                              // 1 local run: 1 x i64 ($acc)
  run.push(0x03, 0x40);                              // loop
  run.push(0x42, 0, 0x20, 1, ...call, 0x21, 1);      // acc = h(0, acc)
  run.push(0x20, 0, 0x42, 1, 0x7d, 0x22, 0,          // n = n - 1
           0x50, 0x45, 0x0d, 0);                     // br_if 0 while n != 0
  run.push(0x0b);                                    // end loop
  run.push(0x20, 1, 0x0b);                           // return acc
  const runBody = [...u(run.length), ...run];

  const imports = indirect
    ? [1, ...st("e"), ...st("t"), 0x01, 0x70, 0x00, ...u(1)]
    : local ? null : [1, ...st("e"), ...st("h"), 0x00, 0];
  const funcs = local ? [2, 1, 0] : [1, 1];          // run is type 1, callee type 0
  const bodies = local ? [runBody, CALLEE_BODY] : [runBody];
  return new Uint8Array([...MAGIC,
    ...sect(1, [2, ...CALLEE_TYPE, 0x60, 1, 0x7e, 1, 0x7e]),
    ...(imports ? sect(2, imports) : []),
    ...sect(3, funcs),
    ...sect(7, [1, ...st("run"), 0x00, ...u(runIdx)]),
    ...sect(10, [...u(bodies.length), ...bodies.flat()]),
  ]);
}

async function measure(kind) {
  const host = new WebAssembly.Instance(new WebAssembly.Module(hostBytes()), {});
  let imports = {};
  if (kind === "import-exp") imports = { e: { h: host.exports.h } };
  if (kind === "import-tab") imports = { e: { h: host.exports.t.get(0) } };
  if (kind === "indirect")   imports = { e: { t: host.exports.t } };
  const inst = new WebAssembly.Instance(
    new WebAssembly.Module(callerBytes(kind)), imports);
  const run = inst.exports.run;
  run(2000000n); run(2000000n);
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    run(BigInt(ITERS));
    const ns = (performance.now() - t) * 1e6 / ITERS;
    if (ns < best) best = ns;
  }
  return { kind, ns: best };
}

const out = [];
for (const k of ["local", "import-exp", "import-tab", "indirect"]) {
  try { out.push(await measure(k)); }
  catch (e) { out.push({ kind: k, err: String(e).slice(0, 160) }); }
}
return out;
`;

const jsFlags = LIFTOFF ? "--liftoff-only" : (process.env.JS_FLAGS || "");
const b = await chromium.launch({ headless: true, args: jsFlags ? [`--js-flags=${jsFlags}`] : [] });
const p = await b.newPage();
p.on("pageerror", (e) => console.log(`pageerror: ${String(e).slice(0, 300)}`));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
let rows;
try {
  rows = await p.evaluate(`(async () => { ${PROBE.replaceAll("__ITERS__", String(ITERS))} })()`);
} catch (e) {
  console.log(`FAILED: ${String(e).slice(0, 600)}`);
  await b.close(); process.exit(1);
}
console.log(`IMPORT iters=${ITERS}${LIFTOFF ? "  tier=liftoff-only" : jsFlags ? "  " + jsFlags : "  tier=default"}`);
const floor = rows.find((r) => r.kind === "local" && !r.err);
for (const r of rows) {
  if (r.err) { console.log(`  ${r.kind.padEnd(12)} ERR ${r.err}`); continue; }
  console.log(`  ${r.kind.padEnd(12)} ${r.ns.toFixed(2)} ns/call` +
    (floor && r !== floor ? `   boundary = ${(r.ns - floor.ns).toFixed(2)} ns` : "   (floor)"));
}
await b.close();
