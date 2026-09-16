// Is there a cheaper TB->TB dispatch than `return_call_indirect` on a
// funcref table?
//
//   PORT=8080 node tools/callref-probe.mjs [--funcs 4096] [--iters 20e6]
//
// Round twenty-three measured the transition itself: ~11.8 M TB entries a
// second on an EL71 boot, ~7.7 ns each, 9.1 % of wall (the profile credits
// it to tcg_qemu_tb_exec, whose own body is 32 ns a call at 98 k calls/s --
// see the round log).  Removing transitions is capped at ~3 % by the exit
// mix, so the other question is whether the transition can be made cheaper.
//
// `return_call_indirect` on a `funcref` table pays a bounds check and a
// run-time signature comparison.  The function-references proposal (V8
// since Chrome 119) allows a table typed `(ref null $tbsig)`, whose
// elements need no signature check at all: `table.get` + `return_call_ref`
// is then a checkless tail call.  This prices the three forms against each
// other on the same pseudo-random walk over the same functions.
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FUNCS = Number(opt("funcs", 4096));
const ITERS = Number(opt("iters", 20e6));
const REPS = Number(opt("reps", 3));
const PORT = process.env.PORT || "8080";

const PROBE = String.raw`
const FUNCS = __FUNCS__, ITERS = __ITERS__, REPS = __REPS__;
const SEQMASK = 8191;
const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sl = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7;
  if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
  o.push(b | 0x80); } };
const st = (t) => [t.length, ...t.split("").map(c => c.charCodeAt(0))];
const sect = (id, c) => [id, ...u(c.length), ...c];

// locals: params 0,1,2 = i64; declared 3 = $n (i64), 4 = $idx (i32)
const DEC = [0x41, 0, 0x41, 0, 0x29, 3, 0, 0x42, 1, 0x7d, 0x22, 3, 0x37, 3, 0];
const SEQ = [0x20, 3, 0x42, ...sl(SEQMASK), 0x83, 0xa7, 0x41, 2, 0x74,
             0x28, 2, ...u(64), 0x21, 4];

function moduleBytes(kind) {
  const typed = kind !== "ind";                 // table of (ref null $0)
  const body = [];
  body.push(2, 1, 0x7e, 1, 0x7f);
  body.push(...DEC);
  body.push(0x20, 3, 0x50, 0x04, 0x40, 0x41, 0, 0x0f, 0x0b);   // if (!n) return 0
  body.push(...SEQ);
  body.push(0x20, 0, 0x20, 1, 0x20, 2);
  if (kind === "callref") {
    body.push(0x20, 4, 0x25, 0);                // local.get $idx; table.get 0
    body.push(0x15, 0);                         // return_call_ref $0
  } else {
    body.push(0x20, 4, 0x13, 0, 0);             // return_call_indirect $0, table 0
  }
  body.push(0x0b);
  const one = [...u(body.length), ...body];

  const types = sect(1, [1, 0x60, 3, 0x7e, 0x7e, 0x7e, 1, 0x7f]);
  const funcs = sect(3, [...u(FUNCS), ...Array(FUNCS).fill(0)]);
  // reftype: funcref (0x70) or (ref null $0) = 0x63 0x00
  const et = typed ? [0x63, 0x00] : [0x70];
  const table = sect(4, [1, ...et, 1, ...u(FUNCS), ...u(FUNCS)]);
  const mem = sect(5, [1, 0x00, 1]);
  const exp = sect(7, [2, ...st("run"), 0, 0, ...st("mem"), 2, 0]);
  const elems = typed
    // 0x06: active, tableidx, offset expr, reftype, vec(expr)
    ? sect(9, [1, 0x06, 0, 0x41, 0, 0x0b, ...et, ...u(FUNCS),
               ...Array.from({ length: FUNCS }, (_, i) => [0xd2, ...u(i), 0x0b]).flat()])
    // 0x02: active, tableidx, offset expr, elemkind, vec(funcidx)
    : sect(9, [1, 0x02, 0, 0x41, 0, 0x0b, 0x00, ...u(FUNCS),
               ...Array.from({ length: FUNCS }, (_, i) => u(i)).flat()]);
  const code = sect(10, [...u(FUNCS), ...Array.from({ length: FUNCS }, () => one).flat()]);
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
                         ...types, ...funcs, ...table, ...mem, ...exp, ...elems, ...code]);
}

const out = {};
for (const kind of ["ind", "ind-typed", "callref"]) {
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes(kind)));
    const buf = inst.exports.mem.buffer;
    const dv = new DataView(buf), u32 = new Uint32Array(buf);
    let x = 12345;
    for (let i = 0; i <= SEQMASK; i++) { x = (x * 1103515245 + 12345) >>> 0; u32[16 + i] = x % FUNCS; }
    let best = Infinity;
    for (let r = 0; r < REPS; r++) {
      dv.setBigUint64(0, BigInt(Math.round(ITERS / 20)), true);
      inst.exports.run(0n, 0n, 0n);
      dv.setBigUint64(0, BigInt(ITERS), true);
      const t0 = performance.now();
      inst.exports.run(0n, 0n, 0n);
      const dt = performance.now() - t0;
      best = Math.min(best, dt * 1e6 / ITERS);
    }
    out[kind] = best;
  } catch (e) { out[kind] = String(e).slice(0, 120); }
}
return out;
`;

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
const r = await p.evaluate(`(() => { ${PROBE.replace("__FUNCS__", String(FUNCS))
  .replace("__ITERS__", String(ITERS)).replace("__REPS__", String(REPS))} })()`);
console.log(`funcs=${FUNCS}, ${ITERS} dispatches, random walk`);
for (const [k, v] of Object.entries(r)) {
  console.log(`  ${k.padEnd(10)} ${typeof v === "number" ? v.toFixed(3) + " ns/dispatch" : v}`);
}
await b.close();
