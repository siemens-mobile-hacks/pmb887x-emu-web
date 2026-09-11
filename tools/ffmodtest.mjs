// Firefox executable-memory probe: compile N small wasm modules, keep or drop refs.
import { firefox } from "playwright-core";
const keep = process.argv[2] === "keep", N = Number(process.argv[3] || 40000), fnPerMod = Number(process.argv[4] || 16), fifo = Number(process.argv[5] || 0), nudge = Number(process.argv[6] || 0);
const b = await firefox.launch({ headless: true });
const p = await b.newPage();
p.on("console", m => console.log("  [console]", m.text().slice(0, 160)));
const r = await p.evaluate(async ({ keep, N, fnPerMod, fifo, nudge }) => {
  // build a module with fnPerMod functions of ~60 bytes each (i64 arithmetic), exported
  const leb = v => { const o = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
  const sec = (id, body) => [id, ...leb(body.length), ...body];
  const type = sec(1, [1, 0x60, 1, 0x7e, 1, 0x7e]);
  const func = sec(3, [...leb(fnPerMod), ...Array(fnPerMod).fill(0)]);
  const exp = sec(7, [...leb(fnPerMod), ...Array.from({ length: fnPerMod }, (_, i) => { const n = [...new TextEncoder().encode("f" + i)]; return [...leb(n.length), ...n, 0, ...leb(i)]; }).flat()]);
  const bodyExpr = []; for (let k = 0; k < 12; k++) bodyExpr.push(0x20, 0, 0x42, 5, 0x7c, 0x42, 3, 0x7e, 0x21, 0); bodyExpr.push(0x20, 0, 0x0b);
  const body = [0, ...bodyExpr]; const fb = [...leb(body.length), ...body];
  const code = sec(10, [...leb(fnPerMod), ...Array(fnPerMod).fill(fb).flat()]);
  const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...func, ...exp, ...code]);
  const kept = []; let i = 0, err = null; const t0 = performance.now();
  try {
    for (; i < N; i++) {
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
      if (keep) kept.push(inst); else inst.exports.f0(1n);
      if (fifo && kept.length > fifo) kept.shift();
      if (nudge && (i % nudge) === 0) { const junk = new ArrayBuffer(64 << 20); new Uint8Array(junk)[0] = 1; }
    }
  } catch (e) { err = String(e); }
  return { made: i, err, ms: Math.round(performance.now() - t0), bytes: bytes.length };
}, { keep, N, fnPerMod, fifo, nudge });
console.log(`${keep ? "KEEP" : "DROP"} N=${N} fn/mod=${fnPerMod} fifo=${fifo} nudge=${nudge}:`, JSON.stringify(r));
await b.close();
