// Profile the qemu wasm worker thread via CDP Profiler.
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const waitS = Number(process.argv[2] || 40);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });

const workers = page.workers();
console.log("workers at start:", workers.length);
// attach profiler sessions to all workers
const sessions = [];
for (const w of workers) {
  const s = await w.context().newCDPSession(w);
  await s.send("Profiler.enable");
  sessions.push({ s, w });
}
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, 3000));
// also catch late-spawned workers (qemu DSP worker)
for (const w of page.workers()) {
  if (!sessions.some((x) => x.w === w)) {
    try {
      const s = await w.context().newCDPSession(w);
      await s.send("Profiler.enable");
      sessions.push({ s, w });
    } catch {}
  }
}
for (const { s } of sessions) await s.send("Profiler.setSamplingInterval", { interval: 200 });
for (const { s } of sessions) await s.send("Profiler.start");
console.log("profiling", sessions.length, "sessions for", waitS, "s…");
await new Promise((r) => setTimeout(r, waitS * 1000));

let i = 0;
for (const { s } of sessions) {
  try {
    const { profile } = await s.send("Profiler.stop");
    // aggregate self time per function
    const nodes = new Map();
    for (const n of profile.nodes) nodes.set(n.id, n);
    const self = new Map();
    for (const smp of profile.samples) {
      const n = nodes.get(smp);
      if (!n) continue;
      const f = n.callFrame;
      const key = (f.functionName || "?") + " " + (f.url || "").slice(-40);
      self.set(key, (self.get(key) || 0) + 1);
    }
    const total = profile.samples.length;
    console.log(`--- worker ${i++} samples=${total}`);
    const sorted = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [k, v] of sorted) {
      console.log(`  ${(100 * v / total).toFixed(1)}% ${k}`);
    }
  } catch (e) { console.log("session err", String(e).slice(0, 80)); }
}
await browser.close();
