// Boot ke970 with pmb887x device tracing via ?env=, capture [qemu] lines.
import { chromium } from "playwright-core";
const secs = Number(process.argv[2] || 240);
const extra = process.env.EXTRA_Q || "";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const t0 = Date.now();
let n = 0;
p.on("console", m => {
  const t = m.text();
  if (t.startsWith("[qemu")) { n++; console.log(((Date.now() - t0) / 1000).toFixed(1) + "s " + t.slice(0, 200)); }
});
await p.goto(`http://127.0.0.1:8080/?dist=dist-jit${extra ? "&" + extra : ""}`, { waitUntil: "domcontentloaded" });
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", [
  "/workspace/fullflashes/KE970v10d.bin",
  "/workspace/fullflashes/KE970v10d.bin.cfi-efa",
]);
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });
console.log("module up, insns ticker on");
await p.addScriptTag({ content: `
    setInterval(() => {
      const m = window.__qemu; if (!m) return;
      console.log("[qemu] TICK insns=" + (Number(m._wasm_insns())/1e6).toFixed(0) + "M");
    }, 5000);
` });
await new Promise(r => setTimeout(r, secs * 1000));
console.log("captured " + n + " lines");
await b.close();
