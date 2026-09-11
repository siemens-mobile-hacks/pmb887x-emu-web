// Micro-benchmark: synchronous WebAssembly.Module compile cost of saved batch modules.
//   node modbench.mjs /tmp/_w64sample3002.wasm /tmp/_w64sample3000.wasm /tmp/_w64sample3001.wasm
import { chromium } from "playwright-core";
import fs from "node:fs";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto("http://127.0.0.1:" + (process.env.PORT || 8080) + "/", { waitUntil: "domcontentloaded" });
for (const f of process.argv.slice(2)) {
  const bytes = Array.from(fs.readFileSync(f));
  const r = await p.evaluate(async (bytes) => {
    const base = new Uint8Array(bytes);
    // unique custom section per iteration: defeats V8's native-module cache (keyed by wire bytes)
    const variants = []; const N = 400;
    for (let i = 0; i < N; i++) { const u = new Uint8Array(base.length + 8); u.set(base); u.set([0, 6, 1, 0x78, (i & 255), (i >> 8) & 255, 0, 0], base.length); variants.push(u); }
    const u8 = variants[0];
    const t0 = performance.now();
    for (let i = 0; i < N; i++) new WebAssembly.Module(variants[i]);
    const t1 = performance.now();
    const t2 = performance.now();
    const mods = [];
    for (let i = 0; i < N; i++) mods.push(new WebAssembly.Module(u8));
    const t3 = performance.now();
    // worker-side measurement (same as the vCPU pthread situation)
    const src = `onmessage = (e) => { const base = new Uint8Array(e.data); const N = 400; const vs = []; for (let i = 0; i < N; i++) { const u = new Uint8Array(base.length + 8); u.set(base); u.set([0, 6, 1, 0x79, (i & 255), (i >> 8) & 255, 0, 0], base.length); vs.push(u); } const t0 = performance.now(); for (let i = 0; i < N; i++) new WebAssembly.Module(vs[i]); postMessage((performance.now() - t0) / N); };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    const wres = await new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage(bytes); });
    return { bytes: u8.length, usPerCompile: (t1 - t0) * 1000 / N, usPerCompileKept: (t3 - t2) * 1000 / N, usWorker: wres * 1000 };
  }, bytes);
  console.log(f, JSON.stringify(r));
}
await b.close();
