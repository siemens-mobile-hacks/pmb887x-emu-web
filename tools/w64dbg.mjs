// Capture W64* console output from the page (diagnostics for the wasm64
// backend), reassemble W64DUMPC chunks, dump the failing module to
// /tmp/w64mod-fail.bin, exit as soon as a full dump appears.
import { chromium } from "playwright-core";
import fs from "fs";

const port = process.argv[2] || "8094";
const dist = process.argv[3] || "dist-jit";
const secs = parseInt(process.argv[4] || "240", 10);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const lines = [];
const dumpChunks = {};
let dumped = false;
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("W64DUMPC")) {
    const m2 = t.match(/^W64DUMPC(\d+):(.*)$/);
    if (m2) dumpChunks[+m2[1]] = m2[2];
  } else if (/W64/.test(t) || t.includes("Error")) {
    lines.push(t.slice(0, 300));
  }
  if (t.startsWith("W64DUMPE")) {
    dumped = true;
    const b64 = Object.keys(dumpChunks).sort((a, b) => a - b)
      .map((k) => dumpChunks[k]).join("");
    fs.writeFileSync("/tmp/w64mod-fail.bin", Buffer.from(b64, "base64"));
    lines.push("[w64dbg] module (" + b64.length + " b64 chars) -> /tmp/w64mod-fail.bin");
  }
});
page.on("pageerror", (e) => lines.push("[pageerror] " + String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?suite=dist/tcgisa.bin&dist=${dist}&w64debug=1`,
                { waitUntil: "networkidle", timeout: 120000 });
const t0 = Date.now();
while (Date.now() - t0 < secs * 1000 && !dumped && lines.length < 40) {
  await new Promise((r) => setTimeout(r, 1000));
}
await browser.close();
console.log(lines.join("\n") || "(no diagnostics)");
