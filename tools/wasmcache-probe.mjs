// AOT-cache probe, part 2: Chromium's wasm code cache via compileStreaming.
//
//   PORT=8080 node tools/wasmcache-probe.mjs [--count 200] [--browsers chromium,firefox]
//
// Part 1 (wasmclone-probe.mjs) established: neither V8 nor SpiderMonkey
// stores a WebAssembly.Module in IndexedDB, and persisting *bytes* costs
// more than the recompile it avoids.  The one untested variant is the
// HTTP wasm code cache: V8 keeps compiled code for .wasm resources that
// go through the HTTP cache and are compiled with compileStreaming.  A
// Cache API response *might* ride the same machinery.
//
// Method: put N synthetic Responses (same module bytes) at versioned
// same-origin URLs, compileStreaming them (generation 1 = cold fill),
// reload the page, compileStreaming them again (generation 2 = would-be
// code-cache hit) and compare against new WebAssembly.Module(bytes) in
// the same isolate.  If gen2 does not beat fresh compile, the code cache
// does not apply to Cache API responses and the AOT branch is closed.
import { chromium, firefox } from "playwright-core";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COUNT = Number(opt("count", 200));
const PORT = process.env.PORT || "8080";
const browsers = opt("browsers", "chromium,firefox").split(",");
const url = `http://127.0.0.1:${PORT}/`;

const BODY = String.raw`
async function run(count, phase, tag) {
  const out = {};
  const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const s = (str) => [str.length, ...str.split("").map(c => c.charCodeAt(0))];
  const F = 6, LOCALS = 69, OPS = 480;
  const body = i => { const b = [1, ...u(LOCALS), 0x7f]; b.push(0x41, ...u(i + 1));
    for (let k = 0; k < OPS; k++) { if (k % 12 === 11) b.push(0x41, ...u(1 + (k & 0x1f)), 0x20, 0, 0x10, (k >> 4) & 1, 0x1a); else b.push(0x41, ...u(1 + ((k * 37 + i * 11) & 0x3f)), 0x6a + (k % 5)); }
    b.push(0x0b); return [...u(b.length), ...b]; };
  const sect = (id, c) => [id, ...u(c.length), ...c];
  const bytes = new Uint8Array([0,97,115,109,1,0,0,0, ...sect(1, [1,0x60,2,0x7f,0x7f,1,0x7f]), ...sect(2, [2,...s("e"),...s("a"),0,0,...s("e"),...s("b"),0,0]), ...sect(3, [F, ...Array(F).fill(0)]), ...sect(7, (()=>{const c=[F];for(let i=0;i<F;i++)c.push(...s("f"+i),0,...u(2+i));return c;})()), ...sect(10, (()=>{const c=[F];for(let i=0;i<F;i++)c.push(...body(i));return c;})())]);
  out.moduleBytes = bytes.length;
  const urls = i => new URL("/wasmcache-probe/" + tag + "/" + i + ".wasm", location.href).href;
  const cache = await caches.open("wasmcache-probe-" + tag);
  if (phase === "first") {
    for (let i = 0; i < count; i++) await cache.put(urls(i), new Response(bytes, { headers: { "content-type": "application/wasm" } }));
  }
  // gen compile via compileStreaming fed from cache.match (the Cache API
  // is storage, not an interceptor: fetch() would go to the network)
  let t = performance.now();
  for (let i = 0; i < count; i++) await WebAssembly.compileStreaming(cache.match(urls(i)));
  out.streamUs = (performance.now() - t) * 1e3 / count;
  // fresh baseline in this same isolate
  for (let i = 0; i < 20; i++) new WebAssembly.Module(bytes);
  t = performance.now();
  for (let i = 0; i < count; i++) new WebAssembly.Module(bytes);
  out.freshUs = (performance.now() - t) * 1e3 / count;
  out.phase = phase;
  return out;
}
`;
const src = (phase, tag, count) => `(async () => {\n${BODY}\nreturn run(${count}, ${JSON.stringify(phase)}, ${JSON.stringify(tag)});\n})()`;

for (const name of browsers) {
  const B = name === "firefox" ? firefox : chromium;
  let browser;
  try { browser = await B.launch({ headless: true }); }
  catch (e) { console.log(`WASMCACHE ${name}: cannot launch — skipped`); continue; }
  try {
    const p = await browser.newPage();
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const tag = Date.now().toString(36);
    const g1 = await p.evaluate(src("first", tag, COUNT));
    await p.reload({ waitUntil: "domcontentloaded" });
    const g2 = await p.evaluate(src("second", tag, COUNT));
    await p.evaluate(async (t) => { for (const k of await caches.keys()) if (k.includes(t)) await caches.delete(k); }, tag).catch(() => {});
    const fmt = (us) => us.toFixed(1) + " us";
    console.log(`WASMCACHE ${name} module=${(g1.moduleBytes / 1024).toFixed(2)}KB count=${COUNT} (Cache API + compileStreaming)`);
    console.log(`  gen1 (fill) : stream ${fmt(g1.streamUs)}/mod  fresh-beside ${fmt(g1.freshUs)}/mod`);
    console.log(`  gen2 (hit?) : stream ${fmt(g2.streamUs)}/mod  fresh-beside ${fmt(g2.freshUs)}/mod`);
    console.log(`  verdict     : gen2 stream vs gen2 fresh = ${(g2.freshUs / g2.streamUs).toFixed(2)}x ${g2.streamUs < g2.freshUs * 0.5 ? "-> code cache ACTIVE" : "-> no code-cache benefit"}`);
  } catch (e) {
    console.log(`WASMCACHE ${name}: FAIL ${String(e).slice(0, 250)}`);
  }
  await browser.close();
}
