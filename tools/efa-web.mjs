// E2E browser test: LG KE800 fullflash + .cfi-efa sidecar (LG EEPROM block).
//   node tools/efa-web.mjs            positive: sidecar picked -> EFA loaded
//   node tools/efa-web.mjs noefa      negative: flash only     -> warning
// Requires the wasm build to be served (./serve.mjs) at 127.0.0.1:$PORT (8080).
// Boots with ?trace=flash and greps the page console for the flash device's
// "loaded EFA" line — no need to wait for the slow wasm boot. (Not
// ?tracebuf=1: the flash trace fills that ring buffer, and the line the test
// is looking for is printed before the first poll could read it.)
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

const withSidecar = process.argv[2] !== "noefa";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const log = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => { log.push(m.text()); if (log.length > 20000) log.splice(0, 5000); });
await page.goto(`http://127.0.0.1:${process.env.PORT || "8080"}/?trace=flash`, { waitUntil: "networkidle", timeout: 120000 });

const ff = fileURLToPath(new URL("../fullflashes/", import.meta.url));
const files = [ff + "KE800-v11b.bin"];
if (withSidecar) files.push(ff + "KE800-v11b.bin.cfi-efa");
await page.click("#ff-mode-own");
await page.setInputFiles("#fullflash", files);
const dev = await page.$eval("#device", (s) => s.value);
await page.click("#btn-start");

let s = null;
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  await new Promise((r) => setTimeout(r, 1000));
  const page_ = await page.evaluate(() => ({
    // the missing-EFA warning is a caption under the status pill now
    status: document.getElementById("status-caption").textContent,
    state: window.__ui?.state || "",
  }));
  const text = log.join("\n");
  s = {
    efaLoaded: /loaded EFA from \S*fullflash\.bin\.cfi-efa/.test(text),
    hwError: /hardware error|Invalid EFA file size|EFA file was provided/.test(text),
    ...page_,
  };
  if (s.hwError || s.efaLoaded || (s.status.includes("EFA block") && s.state === "running")) break;
}
await page.screenshot({ path: `efa-web-${withSidecar ? "with" : "no"}.png` }).catch(() => {});
await browser.close();

console.log("inferred device:", dev);
console.log(JSON.stringify(s));
console.log("page errors:", errors.length ? errors : "none");
const pass = withSidecar
  ? dev === "lg-ke800" && s.efaLoaded && !s.hwError && !errors.length
  : dev === "lg-ke800" && !s.efaLoaded && s.status.includes("No EFA block") && !errors.length;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
