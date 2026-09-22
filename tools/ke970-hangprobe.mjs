// Boot ke970 and probe a hang: poll wasm_insns; when it stands still
// for --still s, snapshot every diag counter twice --gap s apart and
// dump the deltas (what still ticks in a hung emulator?), plus vclock.
import { chromium } from "playwright-core";
import { NAMES } from "./diagnames.mjs";

const secs = Number(process.argv[2] || 300);
const still = 10, gap = 8;
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const t0 = Date.now();
p.on("console", m => {
  const t = m.text();
  if (t.startsWith("[qemu")) console.log(((Date.now() - t0) / 1000).toFixed(1) + "s " + t.slice(0, 160));
});
await p.goto("http://127.0.0.1:8080/?dist=dist-jit", { waitUntil: "domcontentloaded" });
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", [
  "/workspace/fullflashes/KE970v10d.bin",
  "/workspace/fullflashes/KE970v10d.bin.cfi-efa",
]);
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });
console.log("module up " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

const boot = await p.evaluate(() => new Promise((resolve) => {
  let last = -1, same = 0;
  const iv = setInterval(() => {
    const m = window.__qemu; if (!m) return;
    const i = Number(m._wasm_insns());
    if (i === last) { same += 2; } else { same = 0; last = i; }
    if (same * 2 >= 10 && last > 0) { clearInterval(iv); resolve(last); }
  }, 2000);
}));
console.log(`HUNG at ${boot / 1e6}M insns, t=${((Date.now() - t0) / 1000).toFixed(0)}s`);

const dump = () => p.evaluate(() => {
  const m = window.__qemu, o = {};
  for (let i = 0; i < 200; i++) { const v = Number(m._wasm_memstat(i)); if (v) o[i] = v; }
  o.vclock = Number(m._wasm_vclock ? m._wasm_vclock() : 0);
  o.insns = Number(m._wasm_insns());
  return o;
});
const a = await dump();
await new Promise(r => setTimeout(r, gap * 1000));
const c = await dump();
const rows = [];
for (const k of new Set([...Object.keys(a), ...Object.keys(c)])) {
  const d = (c[k] ?? 0) - (a[k] ?? 0);
  if (d) rows.push([NAMES[k] ?? k, d, a[k] ?? 0]);
}
rows.sort((x, y) => y[1] - x[1]);
console.log(`deltas over ${gap}s (vclock a=${(a.vclock / 1e9).toFixed(2)}s c=${(c.vclock / 1e9).toFixed(2)}s):`);
for (const [n, d, v0] of rows.slice(0, 25)) console.log(`  ${n} +${d} (from ${v0})`);
console.log(rows.length ? "" : "  NOTHING ticks.");
await b.close();
