// Dump guest memory ranges after a boot delay and disassemble them.
//   PORT=8080 node peekcode.mjs <dist> <waitSecs> <addr:nwords>[,<addr:nwords>...] [thumb]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import fs from "node:fs";
import { execSync } from "node:child_process";
const dist = process.argv[2] || "dist-jit", wait = Number(process.argv[3] || 25);
const ranges = (process.argv[4] || "").split(",").filter(Boolean).map(s => { const [a, n] = s.split(":"); return { a: Number(a), n: Number(n || 16) }; });
const mode = process.argv[5] === "thumb" ? "-Mforce-thumb" : "";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${process.env.PORT || 8080}/?dist=${dist}`, { waitUntil: "domcontentloaded" });
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise(r => setTimeout(r, wait * 1000));
for (const r of ranges) {
  const words = await p.evaluate(({ a, n }) => { const m = window.__qemu; const out = []; for (let i = 0; i < n; i++) out.push(m._wasm_peek(a + i * 4)); return out; }, r);
  const buf = Buffer.alloc(words.length * 4); words.forEach((w, i) => buf.writeUInt32LE(w >>> 0, i * 4));
  const f = `/tmp/peek-${r.a.toString(16)}.bin`; fs.writeFileSync(f, buf);
  console.log(`== ${r.a.toString(16)}`);
  try { console.log(execSync(`arm-none-eabi-objdump -D -b binary -marm ${mode} --adjust-vma=0x${r.a.toString(16)} ${f} | tail -n +8`).toString()); } catch (e) { console.log(String(e)); }
}
await b.close();
