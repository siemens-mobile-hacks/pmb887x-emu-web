// Boot a dist and capture qemu console lines matching a prefix.
//   PORT=8080 DIST=dist-jit MATCH=RRIDLE node conlog.mjs <secs>
import { chromium } from "playwright-core";
import { fullflash } from "/workspace/tools/testflash.mjs";
const port = process.env.PORT || "8080";
const secs = Number(process.argv[2] || 50);
const match = process.env.MATCH || "";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const t0 = Date.now();
p.on("console", m => {
  const t = m.text();
  if (t.startsWith("[qemu") && (!match || t.includes(match)))
    console.log(((Date.now() - t0) / 1000).toFixed(1) + "s " + t);
});
await p.goto(`http://127.0.0.1:${port}/?dist=${process.env.DIST || "dist"}${process.env.EXTRA_Q ? "&" + process.env.EXTRA_Q : ""}`, { waitUntil: "domcontentloaded" });
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await p.addScriptTag({ content: `
    setInterval(() => {
      const m = window.__qemu; if (!m) return;
      console.log("[qemu] WATCH v=" + (Number(m._wasm_vclock())/1e9).toFixed(2) + " insns=" + (m._wasm_insns?Number(m._wasm_insns()):0));
    }, 5000);
` });
await new Promise(r => setTimeout(r, secs * 1000));
for (const f of (process.env.SAVE_FS || "").split(",").filter(Boolean)) {
  try { const d = await p.evaluate((f) => Array.from(window.__qemu.FS.readFile(f)), f); (await import("node:fs")).writeFileSync("/tmp/" + f.replace(/\//g, "_"), Buffer.from(d)); console.log("saved /tmp/" + f.replace(/\//g, "_") + " " + d.length); } catch (e) { console.log("save " + f + " failed: " + e); }
}
await b.close();
