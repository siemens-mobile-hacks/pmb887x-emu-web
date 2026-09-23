// Boot a board on a dist built with doc/attic/modcap-round49.diff, then save
// every batch module it compiled as <outdir>/NNNN.wasm, read from the C-side
// capture buffer through the main thread.
//   node tools/perf/modcap.mjs [dist] [secs] [fullflash] [outdir]
import { chromium } from "playwright-core";
import fs from "node:fs";

const DIST = process.argv[2] || "dist-cap";
const SECS = Number(process.argv[3] || 90);
const FILE = process.argv[4] || "s75_working20060710172101.bin";
const OUT = process.argv[5] || "/tmp/modcap";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:8080/?dist=${DIST}`, { waitUntil: "domcontentloaded" });
await page.selectOption("#startup", "ONLINE");
await page.click("#ff-mode-own");
await page.setInputFiles("#fullflash", ["/workspace/fullflashes/" + FILE]);
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, SECS * 1000));
console.log("insns", await page.evaluate(() => Number(window.__qemu._wasm_insns())));
let n = 0;
const total = await page.evaluate(() => window.__qemu._wasm_cap_len());
console.log("cap bytes", total);
let off = 0;
while (off < total) {
  const b64 = await page.evaluate(([off]) => {
    const m = window.__qemu, p = Number(m._wasm_cap_ptr()) + off;
    const H = m.HEAPU8;
    const len = H[p] | (H[p + 1] << 8) | (H[p + 2] << 16) | (H[p + 3] << 24);
    const u = H.slice(p + 4, p + 4 + len);
    let s = "";
    for (let j = 0; j < u.length; j += 0x8000) s += String.fromCharCode.apply(null, u.subarray(j, j + 0x8000));
    return btoa(s);
  }, [off]);
  const buf = Buffer.from(b64, "base64");
  fs.writeFileSync(`${OUT}/${String(n++).padStart(4, "0")}.wasm`, buf);
  off += 4 + buf.length;
}
console.log("saved", n);
await browser.close();
