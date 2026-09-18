// What the wasm memory bound check costs, and whether the memory's type is
// what decides it.
//
// The `nobc` sweep arm says explicit bound checks are 26 % of this
// emulator's wall time -- the largest single cost ever measured here.  A V8
// flag cannot ship, so the only thing that matters is whether some *module*
// property removes the checks instead.  Two are candidates and each is
// something the build controls:
//
//   is64    a wasm64 memory is indexed by i64, so an engine cannot bound the
//           index with a guard region the way it does for wasm32's 4 GiB
//           address space.  emscripten's -sMEMORY64=2 compiles with i64
//           pointers but lowers the memory to wasm32 in Binaryen, and
//           qemu's configure already exposes it as
//           --wasm64-32bit-address-limit.
//   shared  a shared memory can be grown by another thread, which can
//           disqualify the trap-handler path even when the size cannot
//           actually change (ours is initial == max).
//
// So four modules, both axes crossed, identical code otherwise.  The
// production module is i64+shared; if i32+shared is much faster, the
// -sMEMORY64=2 build is worth its cost, and if only i64+unshared is fast
// then sharing is the culprit and lowering would not help.
//
// The kernel has to defeat bound-check *elimination* without defeating the
// check itself, or the probe measures nothing and says the checks are free.
// An index masked by a constant is provably in range and V8 removes the
// check outright; an index loaded from memory is not, which is also the
// shape the emulator actually has (every TLB probe and every CPUState
// access is a computed offset from a pointer V8 cannot bound).  So the base
// is re-loaded from memory every iteration, and the eight accesses hung off
// it are at constant offsets and independent, so they measure throughput
// rather than the load-to-use latency of a pointer chase.
//
// Run it in Chromium, not just node: the verdict is about the engine that
// runs the emulator, and node's V8 is a different version.
//
//   node tools/bcprobe.mjs                      # node's V8
//   node tools/bcprobe.mjs --chrome             # Chrome, the one that counts
//   node tools/bcprobe.mjs --chrome --js-flags=--no-wasm-bounds-checks
//
// The design validates itself with that last line.  If the i64 leg does not
// then fall to about the i32 leg, the kernel failed to expose a check and
// every other number here is void -- which is reported, not interpreted.

/*
 * One source string, evaluated in whichever engine is under test, so the
 * two paths cannot drift apart.  A copy in a page.evaluate and a copy here
 * would be two different kernels wearing one name.
 */
const SRC = String.raw`
const PAGES = 32768;            /* 2 GiB, the production size */
const ITERS = 20000000;
const LOADS = 8;                /* independent accesses per iteration */
const BASE = 64;                /* where the opaque base points */
const STRIDE = 64;

const uleb = (n) => {
  const out = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) { out.push(b); return out; }
    out.push(b | 0x80);
  }
};

/* i32.const and i64.const take signed LEB128: 64 encoded as the single
   byte 0x40 would decode as -64. */
const sleb = (n) => {
  const out = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    const done = (v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40));
    out.push(done ? b : b | 0x80);
    if (done) { return out; }
  }
};

const sec = (id, body) => [id, ...uleb(body.length), ...body];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const str = (s) => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];

function buildModule(is64, shared, chain) {
  const I64 = 0x7e, I32 = 0x7f;

  /* limits: bit0 has_max, bit1 shared, bit2 is64 */
  const flags = 0x01 | (shared ? 0x02 : 0) | (is64 ? 0x04 : 0);
  const memory = sec(5, vec([[flags, ...uleb(PAGES), ...uleb(PAGES)]]));

  const type = sec(1, vec([[0x60, ...uleb(0), ...vec([[I64]])]]));
  const func = sec(3, vec([[0]]));
  const exp = sec(7, vec([[...str("run"), 0x00, 0]]));

  /* address operand: i64 for a wasm64 memory, i32 for a wasm32 one.  The
     wrap is what a lowered build pays in place of the check. */
  const addr = (local) =>
    is64 ? [0x20, local] : [0x20, local, 0xa7 /* i32.wrap_i64 */];
  const constAddr = (n) =>
    is64 ? [0x42, ...sleb(n)] : [0x41, ...sleb(n)];

  const body = [];
  /* $p = load(8) -- opaque to the optimiser, so no check can be hoisted */
  body.push(...constAddr(8), 0x29, 3, 0, 0x21, 1);

  body.push(0x03, 0x40);                          /* loop */
  for (let k = 0; k < LOADS; k++) {
    body.push(...addr(1), 0x29, 3, ...uleb(STRIDE * k));
    if (chain) {
      /* dereference what was just loaded: a base the optimiser cannot
         bound, so no check can be shared with the other accesses.  This
         is the TLB probe's shape -- load a pointer, then follow it. */
      if (!is64) { body.push(0xa7); }
      body.push(0x29, 3, 0);
    }
    body.push(0x20, 2, 0x7c, 0x21, 2);            /* $acc += */
  }
  body.push(...addr(1), 0x29, 3, 0, 0x21, 1);     /* $p = load($p) */
  body.push(0x20, 0, 0x41, ...sleb(1), 0x6a, 0x22, 0);
  body.push(0x41, ...sleb(ITERS), 0x49, 0x0d, 0); /* $i <u ITERS -> loop */
  body.push(0x0b);                                /* end loop */
  body.push(0x20, 2);                             /* return $acc */

  const locals = vec([[1, I32], [2, I64]]);
  const code = sec(10, vec([[...uleb(locals.length + body.length + 1),
                             ...locals, ...body, 0x0b]]));

  /* Every slot the kernel reads holds BASE, so $p = load($p) is a fixed
     point and all LOADS contribute the same known amount to the checksum,
     while remaining values the optimiser cannot bound. */
  const word = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return [...b];
  };
  const slots = new Uint8Array(STRIDE * LOADS);
  const dv = new DataView(slots.buffer);
  for (let k = 0; k < LOADS; k++) {
    dv.setBigUint64(STRIDE * k, BigInt(BASE), true);
  }
  const seg = (at, bytes) =>
    [0x00, ...constAddr(at), 0x0b, ...uleb(bytes.length), ...bytes];
  const data = sec(11, vec([seg(8, word(BASE)), seg(BASE, [...slots])]));

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...type, ...func, ...memory, ...exp, ...code, ...data,
  ]);
}

function time(name, is64, shared, chain) {
  let inst;
  try {
    const bytes = buildModule(is64, shared, chain);
    inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  } catch (e) {
    return { name, err: String((e && e.message) || e).split("\n")[0] };
  }
  const run = inst.exports.run;
  const want = BigInt(BASE) * BigInt(ITERS) * BigInt(LOADS);
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const v = run();
    const t1 = performance.now();
    runs.push(t1 - t0);
    if (v !== want) { return { name, err: "wrong result " + v + " want " + want }; }
  }
  const ms = Math.min.apply(null, runs);
  const per = chain ? 2 * LOADS + 1 : LOADS + 1;
  return { name, chain: !!chain, ms, ns: (ms * 1e6) / (ITERS * per) };
}

function main() {
  return [
    time("i64 shared (production)", true, true, false),
    time("i32 shared (MEMORY64=2)", false, true, false),
    time("i64 unshared", true, false, false),
    time("i32 unshared", false, false, false),
    time("i64 shared (production)", true, true, true),
    time("i32 shared (MEMORY64=2)", false, true, true),
  ];
}
`;

function report(engine, out) {
  console.log(`engine: ${engine}\n`);

  const KERNEL = [
    [false, "one opaque base, 8 constant offsets -- the shape of CPUState " +
            "register traffic.\n  An engine may legally check this once and " +
            "share it across all 8."],
    [true,  "load a pointer, then follow it -- the shape of the inline TLB " +
            "probe.\n  Each base is a loaded value, so no check can be " +
            "shared with another."],
  ];

  for (const [chain, what] of KERNEL) {
    const legs = out.filter((r) => !!r.chain === chain);
    if (!legs.length) { continue; }
    console.log(`kernel: ${what}`);
    for (const r of legs) {
      console.log("  " + (r.err
        ? `${r.name.padEnd(25)} FAILED: ${r.err}`
        : `${r.name.padEnd(25)} ${r.ms.toFixed(1).padStart(7)} ms  ` +
          `${r.ns.toFixed(3)} ns/access`));
    }
    const ok = legs.filter((r) => !r.err);
    const g = (n) => ok.find((r) => r.name === n);
    const p = g("i64 shared (production)"), q = g("i32 shared (MEMORY64=2)");
    const u = g("i64 unshared");
    if (p && q) {
      const d = (1 - q.ns / p.ns) * 100;
      console.log(`  -> i32 vs i64, both shared: ${d >= 0 ? "-" : "+"}` +
                  `${Math.abs(d).toFixed(1)}% per access ` +
                  `(${(p.ns - q.ns).toFixed(3)} ns)`);
    }
    if (p && u) {
      const d = (1 - u.ns / p.ns) * 100;
      console.log(`  -> unshared vs shared, both i64: ${d >= 0 ? "-" : "+"}` +
                  `${Math.abs(d).toFixed(1)}% per access -- ` +
                  `${Math.abs(d) < 3 ? "sharing is not the discriminator"
                                     : "sharing matters on its own"}`);
    }
    console.log("");
  }

  console.log("Control: re-run with --js-flags=--no-wasm-bounds-checks.\n" +
              "Each i64 leg must fall to about its i32 leg; where it does\n" +
              "not, that kernel exposed no check and its delta is void.");
}

const argv = process.argv.slice(2);
const jsFlags = argv.find((a) => a.startsWith("--js-flags="));

if (!argv.includes("--chrome")) {
  if (jsFlags) {
    console.log("--js-flags only applies with --chrome; for node use " +
                "`node --no-wasm-bounds-checks tools/bcprobe.mjs`\n");
  }
  const out = (0, eval)(SRC + "\nmain()");
  report(`node ${process.version} / v8 ${process.versions.v8}`, out);
} else {
  /* A shared memory needs SharedArrayBuffer, which needs cross-origin
     isolation -- about:blank has none, so the two production legs would
     fail there.  serve.mjs sets COOP/COEP, so run the page on it. */
  const url = (argv.find((a) => a.startsWith("--url=")) || "").slice(6) ||
              "http://127.0.0.1:8080/";
  const { chromium } = await import("playwright-core");
  const b = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", ...(jsFlags ? [jsFlags] : [])],
  });
  const page = await b.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
  } catch (e) {
    console.log(`could not load ${url} (${String(e.message).split("\n")[0]})`);
    console.log("start it with `node serve.mjs &` -- without cross-origin " +
                "isolation the shared legs cannot run.\n");
  }
  const env = await page.evaluate(
    () => ({ ua: navigator.userAgent, iso: !!globalThis.crossOriginIsolated }));
  if (!env.iso) {
    console.log("WARNING: page is not cross-origin isolated; " +
                "shared-memory legs will fail.\n");
  }
  const out = await page.evaluate(SRC + "\nmain()");
  await b.close();
  const ver = (env.ua.match(/Chrome\/[\d.]+/) || ["chromium"])[0];
  report(`${ver}${jsFlags ? ` ${jsFlags}` : ""}` +
         `${env.iso ? "" : " (NOT cross-origin isolated)"}`, out);
}
