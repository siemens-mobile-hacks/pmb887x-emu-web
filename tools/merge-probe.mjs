// What would a TB->TB hand-off cost if the two TBs lived in ONE function?
//
//   PORT=8080 node tools/merge-probe.mjs [--funcs 4096] [--iters 30e6]
//                                        [--splits 32,128,512]
//
// tools/dispatch-probe.mjs priced the hand-off we ship: a
// `return_call_indirect` through the shared funcref table, ~22 ns even when
// the callee is the caller itself.  The cost is the function hand-off, not
// locality -- so the only way to remove it is to stop handing off, i.e. to
// emit the members of a batch as ONE wasm function whose bodies are the arms
// of a `loop { block..block br_table }` and to replace a same-module exit
// with `local.set $sel; br $L`.
//
// This prices that replacement before anything is built.  Three variants,
// identical work and identical target sequence, differing only in how
// control reaches the next body:
//
//   loop        one body, plain wasm loop                      (work floor)
//   ind-in/K    return_call_indirect to a random index inside
//               the caller's own K-function module              (ship today)
//   merged/K    K bodies in one function, br_table dispatch     (proposed)
//   merged-c/K  same, but each body branches to a fixed
//               neighbour -- the predictable-target best case
//
// merged/K minus ind-in/K is the per-exit saving the merged-function
// mechanism can pay out on the 55 % of indirect exits that measurement says
// already land in the module they are leaving (W64_COLOC).
import { chromium, firefox } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FUNCS = Number(opt("funcs", 4096));
const ITERS = Number(opt("iters", 30e6));
const SPLITS = opt("splits", "32,128,512").split(",").filter(Boolean).map(Number);
// A real TB function declares ~70 locals.  Merging the bodies into one
// function makes every one of them loop-carried as far as the compiler can
// tell, so the merged variant -- and only it -- pays for whatever phis and
// spills that costs.  --xlocals declares that many extra i64 locals and has
// each body read-modify-write three of them.
const XLOCALS = Number(opt("xlocals", 0));
// --work N puts N local read-modify-writes in every body: a real TB body is
// ~400 bytes, and at 1024 of them per module the instruction footprint --
// not the call itself -- may be most of what a hand-off costs.
const WORK = Number(opt("work", 3));
const PORT = process.env.PORT || "8080";
const browsers = opt("browsers", "chromium").split(",");

const PROBE = String.raw`
const FUNCS = __FUNCS__, ITERS = __ITERS__, XLOCALS = __XLOCALS__, WORK = __WORK__;
const SPLITS = __SPLITS__;
const SEQMASK = 8191;

const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sl = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7;
  if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; }
  o.push(b | 0x80); } };
const st = (t) => [t.length, ...t.split("").map(c => c.charCodeAt(0))];
const sect = (id, c) => [id, ...u(c.length), ...c];

// locals: params 0=env 1=sp 2=tp (i64); declared 3=$n (i64), 4=$idx, 5=$sel,
// then XLOCALS i64 at 6..
const LOCALS = XLOCALS ? [3, 1, 0x7e, 2, 0x7f, ...u(XLOCALS), 0x7e]
                       : [2, 1, 0x7e, 2, 0x7f];
// A TB body's shape, because both halves of the comparison turn on it: it
// loads the guest registers it needs out of env, computes, and stores back.
// So the work is live (a local no one reads compiles to nothing, and the
// probe would then measure modules that are large in bytes and empty in
// machine code), and every local is written before it is read -- nothing is
// carried from one body to the next.  Chaining the locals instead would make
// all ~70 of them loop-carried in the merged function and only there, which
// is a property of the probe, not of the backend.
const ENVBASE = 65536;
const touch = (k) => {
  if (!XLOCALS) return [];
  const L = (j) => 6 + (j % XLOCALS);
  const o = [];
  for (let j = 0; j < WORK; j++) {
    o.push(0x41, ...u(ENVBASE + 8 * ((k + j) % 32)), 0x29, 3, 0, 0x21, ...u(L(j)));
  }
  for (let j = 1; j < WORK; j++) {
    o.push(0x20, ...u(L(0)), 0x20, ...u(L(j)), 0x7c, 0x21, ...u(L(0)));
  }
  o.push(0x41, ...u(ENVBASE + 8 * (k % 32)), 0x20, ...u(L(0)), 0x37, 3, 0);
  return o;
};
const DEC = [0x41, 0, 0x41, 0, 0x29, 3, 0, 0x42, 1, 0x7d, 0x22, 3, 0x37, 3, 0];
const RET0 = [0x20, 3, 0x50, 0x04, 0x40, 0x41, 0, 0x0f, 0x0b];
const SEQ = [0x20, 3, 0x42, ...sl(SEQMASK), 0x83, 0xa7, 0x41, 2, 0x74,
             0x28, 2, ...u(64), 0x21, 4];

function header(nfuncs) {
  return [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sect(1, [1, 0x60, 3, 0x7e, 0x7e, 0x7e, 1, 0x7f]),
    ...sect(2, [2,
      ...st("e"), ...st("m"), 0x02, 0x00, ...u(96),
      ...st("e"), ...st("t"), 0x01, 0x70, 0x00, ...u(FUNCS)]),
    ...sect(3, [...u(nfuncs), ...Array(nfuncs).fill(0)]),
  ];
}

// K separate functions, each tail-calling another function of its own module:
// a random index of it ("ind-in"), a fixed neighbour through the table
// ("ind-in-c") or a fixed neighbour by function index ("direct-c").
function splitModule(base, n, kind) {
  const body = (i) => {
    const b = [...LOCALS, ...DEC, ...RET0, ...touch(i), ...SEQ,
               0x20, 0, 0x20, 1, 0x20, 2];
    if (kind === "direct-c") {
      b.push(0x12, ...u((i + 1) % n));
    } else if (kind === "ind-in-c") {
      b.push(0x41, ...sl(base + ((i + 1) % n)), 0x13, 0, 0);
    } else {
      b.push(0x20, 4, 0x41, ...sl(base), 0x6a, 0x13, 0, 0);
    }
    b.push(0x0b);
    return [...u(b.length), ...b];
  };
  const bodies = [];
  for (let i = 0; i < n; i++) bodies.push(body(i));
  return new Uint8Array([
    ...header(n),
    ...sect(9, [1, 0x00, 0x41, ...sl(base), 0x0b, ...u(n),
                ...Array.from({ length: n }, (_, i) => u(i)).flat()]),
    ...sect(10, [...u(n), ...bodies.flat()]),
  ]);
}

// ONE function holding n bodies:
//   loop $L { block*n { br_table } end body_0 end body_1 ... end body_{n-1} }
// body_k reaches $L at depth n-1-k.
function mergedModule(base, n, konst) {
  const b = [...LOCALS, 0x03, 0x40];
  for (let i = 0; i < n; i++) b.push(0x02, 0x40);
  b.push(0x20, 5, 0x0e, ...u(n));
  for (let i = 0; i < n; i++) b.push(...u(i));
  b.push(...u(n - 1));                         // default
  for (let k = 0; k < n; k++) {
    b.push(0x0b);                              // end block B_k
    b.push(...DEC, ...RET0, ...touch(k));
    if (konst) {
      b.push(0x41, ...sl((k + 1) % n), 0x21, 5);
    } else {
      b.push(...SEQ, 0x20, 4, 0x21, 5);
    }
    b.push(0x0c, ...u(n - 1 - k));             // br $L
  }
  b.push(0x0b, 0x41, 0, 0x0b);                 // end loop; i32.const 0; end
  const bodies = [...u(b.length), ...b];
  return new Uint8Array([
    ...header(1),
    ...sect(9, [1, 0x00, 0x41, ...sl(base), 0x0b, 1, 0]),
    ...sect(10, [1, ...bodies]),
  ]);
}

async function measure(kind, split) {
  const mem = new WebAssembly.Memory({ initial: 96 });
  const tab = new WebAssembly.Table({ initial: FUNCS, element: "anyfunc" });
  const imports = { e: { m: mem, t: tab } };
  let bytes = 0, funcs = 0;
  const insts = [];
  {
    const b = kind.startsWith("merged") ? mergedModule(0, split, kind === "merged-c")
            : kind === "loop"           ? mergedModule(0, 1, false)
            : splitModule(0, split, kind);
    bytes += b.length;
    funcs += kind.startsWith("merged") || kind === "loop" ? 1 : split;
    insts.push(new WebAssembly.Instance(new WebAssembly.Module(b), imports));
  }
  const seq = new Int32Array(mem.buffer, 64, SEQMASK + 1);
  let x = 123456789;
  for (let i = 0; i <= SEQMASK; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    seq[i] = x % split;
  }
  const ctr = new BigInt64Array(mem.buffer, 0, 1);
  const entry = tab.get(0);
  const run = (n) => { ctr[0] = BigInt(n); entry(0n, 0n, 0n); };
  /* every one of the split variants' functions has to reach the optimizing
   * tier on its own budget, or the comparison is Liftoff against TurboFan */
  for (let w = 0; w < 6; w++) run(Math.max(4e6, split * 20000));
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    run(ITERS);
    const ns = (performance.now() - t) * 1e6 / ITERS;
    if (ns < best) best = ns;
  }
  return { kind, split, mods: insts.length, funcs, kb: Math.round(bytes / 1024), ns: best };
}

const out = [];
out.push(await measure("loop", 1));
for (const k of ["direct-c", "ind-in-c", "ind-in", "merged-c", "merged"]) {
  for (const sp of SPLITS) out.push(await measure(k, sp));
}
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
                    .replaceAll("__XLOCALS__", String(XLOCALS))
                    .replaceAll("__WORK__", String(WORK))
                    .replaceAll("__SPLITS__", JSON.stringify(SPLITS));
  let rows;
  try {
    rows = await p.evaluate(`(async () => { ${body} })()`);
  } catch (e) {
    console.log(`[${name}] FAILED: ${String(e).slice(0, 500)}`);
    await b.close(); continue;
  }
  const loop = rows.find((r) => r.kind === "loop").ns;
  console.log(`MERGE ${name}  funcs=${FUNCS} iters=${ITERS} xlocals=${XLOCALS} work=${WORK}`);
  for (const r of rows) {
    const tag = r.kind === "loop" ? "loop" : `${r.kind}/${r.split} (${r.funcs} fn, ${r.kb} KB)`;
    console.log(`  ${tag.padEnd(32)} ${r.ns.toFixed(2)} ns/iter` +
      (r.kind === "loop" ? "   (work floor)"
        : `   handoff = ${(r.ns - loop).toFixed(2)} ns`));
  }
  await b.close();
}
