// Dump one translated TB's complete temp module to a .wasm file, so the
// emitted code can be disassembled (wasm-dis) and its bytes counted.
//
//   W64_DUMPTB=<n> node tools/tbdump.mjs [outdir]
//
// The backend prints the Nth TB's module as hex on stderr (W64_DUMPTB in
// tcg/wasm64/tcg-target.c.inc); this captures the console line and writes
// the bytes out.  Emitted bytes are ~0.0153 % of wall per MB and the boot
// emits ~57 MB per 12 s window, so knowing where they go is worth a tool.
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import { writeFileSync } from "node:fs";

const outdir = process.argv[2] || ".";
const n = process.env.W64_DUMPTB || "20000";
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const hits = [];
p.on("console", (m) => {
  const t = m.text();
  const i = t.indexOf("W64TBDUMP");
  if (i >= 0) hits.push(t.slice(i));
});
await p.goto(`http://127.0.0.1:${process.env.PORT || 8080}/?dist=dist-jit&rt=off` +
             `&env=W64_DUMPTB%3D${n}`, { waitUntil: "domcontentloaded" });
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, 12000));
await b.close();
for (const h of hits) {
  const m = h.match(/icount=(\d+) n=(\d+) ([0-9a-f]+)/);
  if (!m) continue;
  const f = `${outdir}/tb-${n}-i${m[1]}.wasm`;
  writeFileSync(f, Buffer.from(m[3], "hex"));
  console.log(`tb #${n}: icount=${m[1]} bytes=${m[2]} -> ${f}`);
}
if (!hits.length) console.log("no dump seen (raise/lower W64_DUMPTB)");
