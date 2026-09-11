import { chromium } from "playwright-core";
import { fullflash } from "/workspace/tools/testflash.mjs";
import fs from "node:fs";
const dist = process.argv[2] || "dist-jit", wait = Number(process.argv[3] || 20), extra = process.argv[4] || "";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:8080/?dist=${dist}${extra ? "&" + extra : ""}`, { waitUntil: "domcontentloaded" });
await p.selectOption("#startup", "ONLINE");
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise(r => setTimeout(r, wait * 1000));
for (let k = 0; k < 4; k++) {
  const r = await p.evaluate(() => { const m = window.__qemu; return { v: Number(m._wasm_vclock())/1e9, pc: Number(m._wasm_pc()).toString(16), cpsr: Number(m._wasm_reg(25)).toString(16), irq: m._wasm_irq_pending(), r0: Number(m._wasm_reg(0)).toString(16), r4: Number(m._wasm_reg(4)).toString(16), lr: Number(m._wasm_reg(14)).toString(16), sp: Number(m._wasm_reg(13)).toString(16) }; });
  console.log(JSON.stringify(r));
  await new Promise(r => setTimeout(r, 500));
}
const words = await p.evaluate(() => { const m = window.__qemu; const out = []; for (let a = 0x8e000; a < 0x8e200; a += 4) out.push(m._wasm_peek(a)); return out; });
const buf = Buffer.alloc(words.length * 4); words.forEach((w, i) => buf.writeUInt32LE(w >>> 0, i * 4)); fs.writeFileSync("/tmp/sram.bin", buf);
const st = await p.evaluate(() => { const m = window.__qemu; const r4 = Number(m._wasm_reg(4)); const out = []; for (let a = 0; a < 0x20; a += 4) out.push(m._wasm_peek(r4 + a).toString(16)); return out; });
console.log("struct@r4:", st.join(" "));
await b.close();
