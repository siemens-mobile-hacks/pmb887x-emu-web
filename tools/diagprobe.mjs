// Generic wasm_memstat probe: boot the S75 flash and dump the named
// counters every interval.  Unlike memstat.mjs the counter list is given
// on the command line, so a temporary counter added during a session can
// be read without editing a tool:
//   node tools/diagprobe.mjs <secs> <intervalSecs> name=idx,name=idx,...
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";

const secs = Number(process.argv[2] || 40);
const iv = Number(process.argv[3] || 10);
const spec = (process.argv[4] || "").split(",").filter(Boolean)
  .map((s) => { const [n, i] = s.split("="); return { n, i: Number(i) }; });
const dist = process.env.DIST || "dist-jit";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("console", (m) => { const t = m.text(); if (t.startsWith("DIAG")) console.log(t); });
await p.goto(`http://127.0.0.1:${process.env.PORT || 8080}/?dist=${dist}${process.env.EXTRA_Q ? "&" + process.env.EXTRA_Q : ""}`,
             { waitUntil: "domcontentloaded" });
await p.addScriptTag({ content: `
  window.__diag = setInterval(() => {
    const m = window.__qemu;
    if (!m || !m._wasm_memstat) return;
    const g = (i) => Number(m._wasm_memstat(i));
    const spec = ${JSON.stringify(spec)};
    console.log("DIAG t=" + (performance.now() / 1000).toFixed(1) +
      " v=" + (Number(m._wasm_vclock()) / 1e9).toFixed(2) +
      " insns=" + (Number(m._wasm_insns()) / 1e6).toFixed(0) + "M " +
      spec.map((s) => s.n + "=" + (s.n.startsWith("x") ? "0x" + g(s.i).toString(16) : g(s.i))).join(" "));
  }, ${iv * 1000});
` });
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, secs * 1000));
await b.close();
