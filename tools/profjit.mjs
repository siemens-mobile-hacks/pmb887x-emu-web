// Distribution of JIT-guest self time over the JIT'd TB functions in a
// saved wprof2 profile: is the guest time concentrated in a few hot TBs
// (code quality matters) or spread over thousands (cold-code cost)?
//   node tools/profjit.mjs <prof.json>
import fs from "node:fs";
const profiles = JSON.parse(fs.readFileSync(process.argv[2]));
let best = null, bestN = 0;
for (const p of profiles) {
  let n = 0;
  for (const nd of p.nodes) if ((nd.callFrame.url || "").startsWith("wasm://")) n++;
  if (n > bestN) { bestN = n; best = p; }
}
const p = best;
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const fn = new Map(), mod = new Map();
let jit = 0, total = 0;
for (let j = 0; j < p.samples.length; j++) {
  const n = byId.get(p.samples[j]); if (!n) continue;
  const dt = p.timeDeltas[j] || 0; total += dt;
  const url = n.callFrame.url || "";
  if (!url.startsWith("wasm://")) continue;
  jit += dt;
  const k = url + "#" + n.callFrame.functionName;
  fn.set(k, (fn.get(k) || 0) + dt);
  mod.set(url, (mod.get(url) || 0) + dt);
}
const sorted = [...fn.values()].sort((a, b) => b - a);
console.log(`total ${(total / 1e3).toFixed(0)} ms, jit-module self ${(jit / 1e3).toFixed(0)} ms (${(100 * jit / total).toFixed(1)} %), ${fn.size} functions in ${mod.size} modules`);
let acc = 0;
const marks = [0.25, 0.5, 0.75, 0.9];
let mi = 0;
for (let i = 0; i < sorted.length; i++) {
  acc += sorted[i];
  while (mi < marks.length && acc >= marks[mi] * jit) {
    console.log(`  ${(marks[mi] * 100).toFixed(0)} % of jit time in the top ${i + 1} functions`);
    mi++;
  }
}
console.log("top functions (ms):", sorted.slice(0, 15).map((v) => (v / 1e3).toFixed(0)).join(" "));
const msorted = [...mod.values()].sort((a, b) => b - a);
console.log("top modules (ms):", msorted.slice(0, 10).map((v) => (v / 1e3).toFixed(0)).join(" "));
