// What is `new WebAssembly.Module` actually charging for?
//
//   PORT=8080 node tools/modshape-probe.mjs
//
// The batch pipeline's whole cost is this one call: 3.02 s of the boot's
// 3.84 s of module time, ~84 us for a 5 KB / 4.85-function batch.  Against
// the 128-member batch (444 us total) that decomposes into ~63 us of fixed
// cost per *call* plus ~4 us/KB.  63 us is a lot of fixed cost for a call
// that compiles 5 KB, so the question is what it is made of -- and in
// particular whether it has a cheap corner:
//
//   - does cost depend on the FUNCTION COUNT beyond the bytes?  V8 farms
//     multi-function modules out to background compile tasks; a handshake
//     with a worker pool would be invisible at 128 functions and dominant
//     at 5.
//   - is there a size or count threshold where the slope changes?
//   - do imports/exports cost anything measurable?
//
// A cheap corner would be worth more than the interpreter tier and cost far
// less to build, so it is priced first.
//
// Caveat carried from round 19 (W64_MODBENCH): back-to-back compiles run
// cache-warm at 12-31 us where the emulator pays ~84 us in situ.  This probe
// is therefore about SHAPE -- how cost varies with count and size -- not
// about the absolute level.  A `--spaced` pass re-runs the sweep with
// unrelated work between compiles to check the shape survives going cold.
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const port = process.env.PORT || "8080";

const probe = () => {
  // --- a minimal wasm encoder: N functions of P body ops each -------------
  // Everything appends into a plain array through put(); spreading a
  // multi-megabyte section as call arguments overflows the stack.
  const put = (dst, src) => { for (let i = 0; i < src.length; i++) dst.push(src[i]); };
  const uleb = (n, dst) => {
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; dst.push(b); } while (n);
    return dst;
  };
  const str = (s, dst) => { uleb(s.length, dst); for (const c of s) dst.push(c.charCodeAt(0)); };
  const section = (m, id, payload) => { m.push(id); uleb(payload.length, m); put(m, payload); };

  // body: (local i32) then P x [local.get 0; i32.const 1; i32.add; local.set 0]
  const body = (P, dst) => {
    const b = [1, 1, 0x7f];                                    // 1 local group, 1 x i32
    for (let i = 0; i < P; i++) put(b, [0x20, 0, 0x41, 1, 0x6a, 0x21, 0]);
    b.push(0x0b);
    uleb(b.length, dst); put(dst, b);
  };

  const build = (N, P, { imports = 0, exports = true } = {}) => {
    const m = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    section(m, 1, [1, 0x60, 0x00, 0x00]);                      // type: () -> ()
    if (imports) {
      const s = uleb(imports, []);
      for (let i = 0; i < imports; i++) { str("e", s); str(String(i), s); s.push(0x00, 0x00); }
      section(m, 2, s);
    }
    const fs = uleb(N, []);
    for (let i = 0; i < N; i++) fs.push(0x00);
    section(m, 3, fs);
    if (exports) {
      const s = uleb(N, []);
      for (let i = 0; i < N; i++) { str(String(i), s); s.push(0x00); uleb(imports + i, s); }
      section(m, 7, s);
    }
    const cs = uleb(N, []);
    for (let i = 0; i < N; i++) body(P, cs);
    section(m, 10, cs);
    return new Uint8Array(m);
  };

  const burn = (ms) => {                 // unrelated work, to go cache-cold
    const t = performance.now();
    let x = 1;
    while (performance.now() - t < ms) { for (let i = 0; i < 5000; i++) x = (x * 1103515245 + 12345) >>> 0; }
    return x;
  };

  // `vary` perturbs one immediate byte per rep.  Compiling the SAME wire
  // bytes over and over may be served from V8's compiled-module cache, in
  // which case every repeat-the-same measurement -- this probe's and round
  // 19's W64_MODBENCH -- prices a cache hit rather than a compile.  The
  // emulator never compiles the same bytes twice.
  const time = (bytes, reps, spaceMs, vary) => {
    const mods = [];
    const at = bytes.length - 5;                  // the last i32.const immediate
    for (let i = 0; i < 3; i++) mods.push(new WebAssembly.Module(bytes));   // warm
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) {
      if (vary) bytes[at] = (i % 100) + 1;
      mods.push(new WebAssembly.Module(bytes));
      if (spaceMs) burn(spaceMs);
    }
    const t1 = performance.now();
    return ((t1 - t0) * 1e6 / reps) - (spaceMs ? spaceMs * 1e6 : 0);        // ns
  };

  const out = { ua: navigator.userAgent, rows: [] };
  const row = (tag, N, P, bytes, ns) =>
    out.rows.push({ tag, N, P, bytes: bytes.length, nsPerCall: ns,
                    nsPerKB: ns / (bytes.length / 1024) });

  // A: function count at ~constant total size (P shrinks as N grows)
  for (const [N, P] of [[1, 640], [2, 320], [4, 160], [8, 80], [16, 40],
                        [32, 20], [64, 10], [128, 5]]) {
    const b = build(N, P);
    row("A:count@~4.5KB", N, P, b, time(b, 300, 0));
  }
  // B: total size at constant function count (the emulator's 4.85)
  for (const P of [1, 5, 20, 80, 320, 1280, 5120]) {
    const b = build(5, P);
    row("B:size@5fn", 5, P, b, time(b, 200, 0));
  }
  // C: function count at constant per-function size (what a bigger batch is)
  for (const N of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    const b = build(N, 130);              // ~1 KB/fn, like a real TB
    row("C:count@1KB/fn", N, 130, b, time(b, 120, 0));
  }
  // D: does the floor move at all?  empty and near-empty modules
  for (const [N, P] of [[0, 0], [1, 0], [1, 1]]) {
    const b = build(N, P);
    row("D:floor", N, P, b, time(b, 500, 0));
  }
  // E: imports and exports, at the emulator's shape
  for (const [im, ex] of [[0, false], [0, true], [8, true], [64, true]]) {
    const b = build(5, 130, { imports: im, exports: ex });
    row(`E:im=${im},ex=${ex}`, 5, 130, b, time(b, 200, 0));
  }
  // F: the same count sweep, gone cold between calls
  for (const N of [1, 5, 32, 128]) {
    const b = build(N, 130);
    row("F:cold@1KB/fn", N, 130, b, time(b, 30, 2, false));
  }
  // G: identical bytes vs a fresh module every call -- is A-F a cache hit?
  for (const N of [1, 5, 32, 128]) {
    const b = build(N, 130);
    row("G:same@1KB/fn", N, 130, b, time(b, 100, 0, false));
    row("G:distinct", N, 130, b, time(b, 100, 0, true));
    row("G:distinct+cold", N, 130, b, time(b, 30, 2, true));
  }
  return out;
};

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
const r = await p.evaluate(probe);
await b.close();

console.log(r.ua + "\n");
let tag = "";
for (const x of r.rows) {
  if (x.tag.split(":")[0] !== tag.split(":")[0]) {
    console.log(`\n  ${"case".padEnd(18)} ${"fns".padStart(4)} ${"bytes".padStart(8)} ` +
                `${"us/call".padStart(9)} ${"us/KB".padStart(8)} ${"us/fn".padStart(8)}`);
  }
  tag = x.tag;
  console.log(`  ${x.tag.padEnd(18)} ${String(x.N).padStart(4)} ${String(x.bytes).padStart(8)} ` +
              `${(x.nsPerCall / 1000).toFixed(2).padStart(9)} ${(x.nsPerKB / 1000).toFixed(2).padStart(8)} ` +
              `${(x.N ? x.nsPerCall / x.N / 1000 : 0).toFixed(2).padStart(8)}`);
}
