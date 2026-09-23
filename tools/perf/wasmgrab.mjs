// Profile the vCPU worker of a running page and save the bytes of its
// hottest TB modules, so their TurboFan x64 can be read offline:
//
//   node tools/perf/wasmgrab.mjs <devtools port> [secs 20] [modules 4] [outdir]
//
// Start the page with e.g. `videobench --devtools 9333 --hold 200`.  The
// module bytes come from Debugger.getScriptSource on the same worker the
// profile ran on, so a profile URL (wasm://wasm/<hash>) and a saved file
// are the same script by construction.  Writes <outdir>/<hash>.wasm and
// <outdir>/hot.json: per module, its share of the worker and each sampled
// function's self time.  Then, per module:
//   node --no-liftoff --no-wasm-lazy-compilation --experimental-wasm-branch-hinting \
//        --print-wasm-code -e 'new WebAssembly.Module(require("fs").readFileSync(process.argv[1]))' <hash>.wasm
// (enabling the debugger tiers the worker's wasm down afterwards: grab
// last, and do not measure on the same page after it).
import fs from "node:fs";
import WebSocket from "ws";

const port = Number(process.argv[2]);
const secs = Number(process.argv[3] || 20);
const nmod = Number(process.argv[4] || 4);
const out = process.argv[5] || "wasmgrab";
fs.mkdirSync(out, { recursive: true });

const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
let nextId = 1;
const handlers = new Map();
const attached = [];
const scripts = new Map();
const send = (method, params = {}, sessionId) => {
  const id = nextId++;
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  return Promise.race([new Promise((res) => handlers.set(id, res)),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${method}: no reply`)), 20000))]);
};
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.id !== undefined && handlers.has(m.id)) { handlers.get(m.id)(m); handlers.delete(m.id); }
  else if (m.method === "Target.attachedToTarget") attached.push(m.params);
  else if (m.method === "Debugger.scriptParsed" && m.params.url.startsWith("wasm://"))
    scripts.set(m.params.url, m.params.scriptId);
});

const gt = await send("Target.getTargets");
const pageT = gt.result.targetInfos.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
const pageSid = (await send("Target.attachToTarget", { targetId: pageT.targetId, flatten: true })).result.sessionId;
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSid);
await new Promise((r) => setTimeout(r, 1500));
const workers = attached.filter((a) => a.targetInfo.type === "worker");

for (const w of workers) {
  await send("Profiler.enable", {}, w.sessionId);
  await send("Profiler.setSamplingInterval", { interval: 100 }, w.sessionId);
  await send("Profiler.start", {}, w.sessionId);
}
console.log(`profiling ${workers.length} workers for ${secs}s`);
await new Promise((r) => setTimeout(r, secs * 1000));

// the vCPU is the worker whose samples span the most wasm scripts (two
// helper workers spin inside one wasm function and outweigh it on samples)
let best = null, bestN = 0;
for (const w of workers) {
  const { profile } = (await send("Profiler.stop", {}, w.sessionId)).result;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const mods = new Map();
  let tot = 0;
  for (let j = 0; j < profile.samples.length; j++) {
    const cf = byId.get(profile.samples[j]).callFrame;
    const dt = profile.timeDeltas[j] || 0;
    tot += dt;
    if (!cf.url.startsWith("wasm://")) continue;
    if (!mods.has(cf.url)) mods.set(cf.url, { t: 0, fns: new Map() });
    const m = mods.get(cf.url);
    m.t += dt;
    m.fns.set(cf.functionName, (m.fns.get(cf.functionName) || 0) + dt);
  }
  if (mods.size > bestN) { bestN = mods.size; best = { w, mods, tot }; }
}

// the main module is the one wasm script with thousands of named functions
const ranked = [...best.mods].sort((a, b) => b[1].t - a[1].t);
const main = ranked.reduce((a, r) => (r[1].fns.size > a[1].fns.size ? r : a), ranked[0]);
const hot = ranked.filter((r) => r !== main).slice(0, nmod);

await send("Debugger.enable", {}, best.w.sessionId);
await new Promise((r) => setTimeout(r, 1500));
const report = { worker: best.w.targetInfo.url, totalMs: best.tot / 1000,
  main: { url: main[0], share: main[1].t / best.tot }, modules: [] };
for (const [url, m] of hot) {
  const sid = scripts.get(url);
  const hash = url.slice("wasm://wasm/".length);
  if (!sid) { console.log(`no script for ${url}`); continue; }
  const src = (await send("Debugger.getScriptSource", { scriptId: sid }, best.w.sessionId)).result;
  fs.writeFileSync(`${out}/${hash}.wasm`, Buffer.from(src.bytecode, "base64"));
  const fns = [...m.fns].sort((a, b) => b[1] - a[1])
    .map(([f, t]) => [f, +(100 * t / best.tot).toFixed(3)]);
  report.modules.push({ hash, share: +(100 * m.t / best.tot).toFixed(2), fns });
  console.log(`${hash}: ${(100 * m.t / best.tot).toFixed(1)} % of the vCPU, ` +
              `top ${fns.slice(0, 5).map(([f, s]) => `${f} ${s}%`).join(", ")}`);
}
await send("Debugger.disable", {}, best.w.sessionId);
fs.writeFileSync(`${out}/hot.json`, JSON.stringify(report, null, 1));
console.log(`main module ${(100 * report.main.share).toFixed(1)} %; wrote ${out}/hot.json`);
ws.close();
