import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const port = process.env.PORT || "8082";
const secs = Number(process.argv[2] || 15);
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 100)));
p.on("console", (m) => { const t = m.text(); if (t.startsWith("RS ")) console.log(t.slice(0, 110)); });
await p.goto(`http://127.0.0.1:${port}/?icount=none`, { waitUntil: "domcontentloaded" });
await p.addScriptTag({ content: `
  window.__t0 = Date.now(); window.__last = 0;
  window.__rs = setInterval(() => {
    const m = window.__qemu; if (!m) return; try { Number(m._wasm_insns()); } catch { return; }
    const i = Number(m._wasm_insns());
    const t = (Date.now() - window.__t0) / 1000;
    console.log("RS t=" + t.toFixed(1) + " insns=" + i + " rate=" + ((i - window.__last) / Math.max(0.1, t - window.__lt)).toFixed(0));
    window.__last = i; window.__lt = t;
  }, 3000);
  window.__lt = 0;
`});
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, secs * 1000));
await b.close();
