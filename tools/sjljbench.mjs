// Price one longjmp in the browser that actually runs the emulator.
//
// tests/wasm/sjljbench.c, built twice -- emscripten SjLj (a JS `throw`
// crossing the wasm boundary) and -sSUPPORT_LONGJMP=wasm (a wasm EH
// branch) -- and run in headless Chromium, because node's V8 has no
// table64 and every wasm64 module here fails to instantiate under it.
//
//   PORT=8080 node tools/sjljbench.mjs [--n 3]
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const reps = Number(opt("n", 3));
const port = process.env.PORT || "8080";

const b = await chromium.launch({ headless: true });
const out = {};
// interleaved, so a browser that gets slower halfway through does not
// land entirely on one variant
for (let r = 0; r < reps; r++) {
  for (const v of ["em", "wa"]) {
    const p = await b.newPage();
    await p.goto(`http://127.0.0.1:${port}/sjlj/${v}.html`, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => window.__lines && window.__lines.length >= 2, null, { timeout: 120000 });
    const lines = await p.evaluate(() => window.__lines);
    const ns = Number(/ns\/longjmp=([\d.]+)/.exec(lines[0])[1]);
    (out[v] ??= []).push(ns);
    console.log(`${v}: ${lines[0]}  |  ${lines[1]}`);
    await p.close();
  }
}
await b.close();
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
console.log(`SJLJ median ns/longjmp: emscripten=${med(out.em).toFixed(1)} wasm=${med(out.wa).toFixed(1)} ` +
  `ratio=${(med(out.em) / med(out.wa)).toFixed(2)}x`);
