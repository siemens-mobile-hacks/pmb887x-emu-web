// What does `new WebAssembly.Module` cost, and what does that cost depend
// on?  The batcher's close modules measure 83 us each on an EL71 boot and
// the number does not move when the module grows 1.5x, so the cost is
// per-call.  This asks the browser directly: synthesize modules of a few
// shapes and time the constructor on each.
//
// A real close module is ~2.6 KB holding ~5 TB functions, and every TB
// function declares 69 locals (32 i32 registers + $bp, 32 i64 registers,
// $scr32 and three i64 scratch) before its first instruction.  The sweep
// varies size, function count, local declarations and control-flow density
// with everything else held fixed; BUSY=1 boots a board first so the same
// measurement runs against the machine load the vCPU worker sees.
//
// Answer, for the record: every shape of that size costs 21-25 us here,
// busy or idle, so nothing about the module explains the emulator's 83 us.
// W64_MODBENCH (tcg/wasm64/wasm64.c) then showed the same bytes cost
// 12-31 us compiled back-to-back inside the vCPU worker itself -- the
// difference is cold cache, not the module and not the isolate.
//
//   PORT=8080 [BUSY=1 TESTFLASH=...] node tools/modfloor.mjs
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";

// BUSY=1 boots a board first, so the synthetic runs against the same
// machine load the vCPU worker's own compiles see.
const port = process.env.PORT || "8080";
const busy = process.env.BUSY === "1";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/?dist=dist-jit&rt=off`, { waitUntil: "domcontentloaded" });
if (busy) {
  await p.click("#ff-mode-own");
  await p.setInputFiles("#fullflash", fullflash);
  await p.click("#btn-start");
  await new Promise((r) => setTimeout(r, 8000));
}

const out = await p.evaluate(() => {
  const uleb = (n) => { const o = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; o.push(x); } while (n); return o; };
  const sec = (id, body) => [id, ...uleb(body.length), ...body];
  const vec = (items) => [...uleb(items.length), ...items.flat()];
  const str = (s) => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];

  // locals: 0 = none, 1 = the real four runs (33 i32, 32 i64, 1 i32, 3 i64)
  // body: "i32" = i32.const/drop pairs, "i64" = i64 local.get/local.set
  // pairs touching the declared locals, which is closer to real TB code.
  function build(nfn, pad, seed, locals, kind) {
    const type = sec(1, vec([[0x60, 0x00, 0x00]]));
    const imp = sec(2, vec([[...str("e"), ...str("f0"), 0x00, 0x00],
                            [...str("e"), ...str("f1"), 0x00, 0x00]]));
    const fn = sec(3, vec(Array.from({ length: nfn }, () => [0x00])));
    const exp = sec(7, vec([[...str("run"), 0x00, ...uleb(2)]]));
    const decl = locals
      ? [0x04, ...uleb(33), 0x7f, ...uleb(32), 0x7e, 0x01, 0x7f, 0x03, 0x7e]
      : [0x00];
    const body = [];
    for (let i = 0; i < pad; i++) {
      if (kind === "br" && locals) {
        // local.get <i32 reg>; if; local.get<i64>; local.set<i64>; else;
        // local.get<i64>; local.set<i64>; end  -- one merge point per unit,
        // which is the shape the inline TLB probe emits per memop
        body.push(0x20, (seed + i) % 32, 0x04, 0x40,
                  0x20, 33 + ((seed + i) % 32), 0x21, 33 + ((seed + i * 3) % 32),
                  0x05,
                  0x20, 33 + ((seed + i * 5) % 32), 0x21, 33 + ((seed + i * 7) % 32),
                  0x0b);
      } else if (kind === "i64" && locals) {
        // local.get <i64 reg>; local.set <i64 reg>  (indices 33..64)
        body.push(0x20, 33 + ((seed + i) % 32), 0x21, 33 + ((seed + i * 7) % 32));
      } else {
        body.push(0x41, (seed + i) & 0x7f, 0x1a);
      }
    }
    body.push(0x0b);
    const one = [...uleb(decl.length + body.length), ...decl, ...body];
    const code = sec(10, vec(Array.from({ length: nfn }, () => one)));
    return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
                           ...type, ...imp, ...fn, ...exp, ...code]);
  }

  function time(label, nfn, pad, locals, kind) {
    const iters = 400;
    const mods = Array.from({ length: iters }, (_, i) => build(nfn, pad, i, locals, kind));
    new WebAssembly.Module(mods[0]);
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) new WebAssembly.Module(mods[i]);
    const us = ((performance.now() - t0) * 1000) / iters;
    return `${label.padEnd(34)} bytes=${String(mods[0].length).padStart(6)}  ${us.toFixed(1)} us`;
  }

  return [
    time("5fn x 170 i32, no locals", 5, 170, 0, "i32"),
    time("5fn x 170 i32, 69 locals", 5, 170, 1, "i32"),
    time("5fn x 128 i64 locals, 69 locals", 5, 128, 1, "i64"),
    time("5fn x 400 i32, no locals", 5, 400, 0, "i32"),
    time("5fn x 400 i32, 69 locals", 5, 400, 1, "i32"),
    time("1fn x 170 i32, 69 locals", 1, 170, 1, "i32"),
    time("20fn x 170 i32, 69 locals", 20, 170, 1, "i32"),
    time("5fn x 8 if/else, 69 locals", 5, 8, 1, "br"),
    time("5fn x 32 if/else, 69 locals", 5, 32, 1, "br"),
    time("5fn x 64 if/else, 69 locals", 5, 64, 1, "br"),
  ].join("\n");
});
console.log(out);
await b.close();
