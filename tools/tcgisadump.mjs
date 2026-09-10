// Capture the W64DUMP module bytes from the page and write them to a file.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const port = process.argv[2] || "8094";
const dist = process.argv[3] || "dist-jit";
const out = process.argv[4] || "/tmp/w64-mod.bin";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let dump = null;
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("W64DUMP:")) dump = t;
});
await page.goto(`http://127.0.0.1:${port}/?suite=dist/tcgisa.bin&dist=${dist}`,
                { waitUntil: "networkidle", timeout: 120000 });
const t0 = Date.now();
while (!dump && Date.now() - t0 < 240000) {
  await new Promise((r) => setTimeout(r, 1000));
}
await browser.close();
if (!dump) { console.error("no dump captured"); process.exit(1); }
const b64 = dump.slice("W64DUMP:".length, dump.indexOf(":nimp="));
writeFileSync(out, Buffer.from(b64, "base64"));
console.log(`wrote ${out} (${Buffer.from(b64, "base64").length} bytes) ${dump.slice(dump.indexOf(":nimp="))}`);
