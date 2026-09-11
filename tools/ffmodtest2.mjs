// Compile-cost scaling probe: same total function bytes, different module sizes; optional worker context.
import { firefox, chromium } from "playwright-core";
const which = process.argv[2] || "firefox", inWorker = process.argv[3] === "worker";
const b = await (which === "chromium" ? chromium : firefox).launch({ headless: true });
const p = await b.newPage();
p.on("console", m => console.log("  [console]", m.text().slice(0, 160)));
const body = `
  const leb = v => { const o = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
  const sec = (id, body) => [id, ...leb(body.length), ...body];
  function mk(fnPerMod) {
    const type = sec(1, [1, 0x60, 1, 0x7e, 1, 0x7e]);
    const func = sec(3, [...leb(fnPerMod), ...Array(fnPerMod).fill(0)]);
    const exp = sec(7, [...leb(1), 2, 0x66, 0x30, 0, 0]);
    const bodyExpr = []; for (let k = 0; k < 12; k++) bodyExpr.push(0x20, 0, 0x42, 5, 0x7c, 0x42, 3, 0x7e, 0x21, 0); bodyExpr.push(0x20, 0, 0x0b);
    const fb = [...leb(bodyExpr.length + 1), 0, ...bodyExpr];
    const code = sec(10, [...leb(fnPerMod), ...Array(fnPerMod).fill(fb).flat()]);
    return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...type, ...func, ...exp, ...code]);
  }
  function run(totalFns, fnPerMod, fifo, nudgeEvery, nudgeMB) {
    const bytes = mk(fnPerMod); const N = Math.floor(totalFns / fnPerMod); const kept = []; let err = null, i = 0;
    const t0 = performance.now();
    try { for (; i < N; i++) { const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}); kept.push(inst); if (kept.length > fifo) kept.shift(); if (nudgeEvery && i % nudgeEvery === 0) { const j = new ArrayBuffer(nudgeMB << 20); new Uint8Array(j)[0] = 1; } } } catch (e) { err = String(e); }
    return { fnPerMod, N, made: i, err, ms: Math.round(performance.now() - t0), modBytes: bytes.length };
  }
  const out = [];
  out.push(Object.assign(run(640000, 16, 6000, 500, 64), { label: "fifo6000 nudge64MB/500" }));
  out.push(Object.assign(run(640000, 16, 6000, 200, 16), { label: "fifo6000 nudge16MB/200" }));
  out.push(Object.assign(run(640000, 16, 6000, 1000, 4), { label: "fifo6000 nudge4MB/1000" }));
`;
const r = await p.evaluate(async ({ body, inWorker }) => {
  if (!inWorker) { return eval(body + "; out"); }
  const src = body + "; postMessage(out);";
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  return await new Promise(res => { w.onmessage = e => res(e.data); });
}, { body, inWorker });
console.log(which, inWorker ? "worker" : "main", JSON.stringify(r));
await b.close();
