// E2E browser test: LG KE800 fullflash + .cfi-efa sidecar (LG EEPROM block).
//   node tools/efa-web.mjs            positive: sidecar picked -> EFA loaded
//   node tools/efa-web.mjs noefa      negative: flash only     -> warning
// Requires the wasm dist to be served (./serve.mjs) at 127.0.0.1:8080.
// Boots with ?trace=flash&tracebuf=1 and greps window.__qemulog for the
// flash device's "loaded EFA" line — no need to wait for the slow wasm boot.
import { chromium } from "playwright-core";

const withSidecar = process.argv[2] !== "noefa";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:8080/?trace=flash&tracebuf=1", { waitUntil: "networkidle", timeout: 120000 });

const files = ["../fullflashes/KE800-v11b.bin"];
if (withSidecar) files.push("../fullflashes/KE800-v11b.bin.cfi-efa");
await page.setInputFiles("#fullflash", files);
const dev = await page.$eval("#device", (s) => s.value);
await page.click("#btn-start");

let s = null;
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  await new Promise((r) => setTimeout(r, 2000));
  s = await page.evaluate(() => {
    const log = (window.__qemulog || []).join("\n");
    return {
      efaLoaded: /loaded EFA from \S*fullflash\.bin\.cfi-efa/.test(log),
      hwError: /hardware error|Invalid EFA file size|EFA file was provided/.test(log),
      status: document.getElementById("status").textContent,
    };
  });
  if (s.hwError || s.efaLoaded || (s.status.includes("no EFA block") && !s.status.includes("loading"))) break;
}
await page.screenshot({ path: `efa-web-${withSidecar ? "with" : "no"}.png` }).catch(() => {});
await browser.close();

console.log("inferred device:", dev);
console.log(JSON.stringify(s));
console.log("page errors:", errors.length ? errors : "none");
const pass = withSidecar
  ? dev === "lg-ke800" && s.efaLoaded && !s.hwError && !errors.length
  : dev === "lg-ke800" && !s.efaLoaded && s.status.includes("no EFA block") && !errors.length;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
