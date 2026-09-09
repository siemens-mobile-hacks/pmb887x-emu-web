import { chromium } from "playwright-core";
import { fullflash } from "/workspace/tools/testflash.mjs";
const secs = Number(process.argv[2] || 110);
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("console", (m) => { const t = m.text(); if (t.startsWith("STATS")) console.log(t); });
await p.goto("http://127.0.0.1:8080/", { waitUntil: "domcontentloaded" });
await p.addScriptTag({ content: `
  window.__stats = setInterval(() => {
    const m = window.__qemu;
    if (!m || !m._wasm_memstat) return;
    const g = (i) => Number(m._wasm_memstat(i));
    const f = (n) => (n / 1e6).toFixed(2) + "M";
    console.log("STATS v=" + (Number(m._wasm_vclock()) / 1e9).toFixed(2) +
      " insns=" + f(Number(m._wasm_insns())) +
      " ioLd=" + f(g(2)) + " ioSt=" + f(g(3)) +
      " flip=" + f(g(10)) + " topC=" + f(g(11)) + " reuse=" + f(g(12)));
  }, 2000);
` });
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, secs * 1000));
await b.close();
