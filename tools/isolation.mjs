// Verifies the WASM page is cross-origin isolated (SharedArrayBuffer for the
// pthread build) the way real users hit it: loopback http AND LAN https
// (COOP/COEP are ignored on insecure origins, so serve.mjs must serve https
// for other devices). Requires web/serve.mjs running.
//   node isolation.mjs [host]
import { chromium } from "playwright-core";
import os from "node:os";

const port = process.env.PORT || 8080;
const httpsPort = process.env.HTTPS_PORT || 6808;
const lanIP =
  process.argv[2] ||
  Object.values(os.networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;

const browser = await chromium.launch({ headless: true });
const check = async (url) => {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  const r = await page.evaluate(() => ({
    isolated: crossOriginIsolated,
    sab: typeof SharedArrayBuffer,
    status: document.getElementById("status").textContent,
  }));
  await page.close();
  console.log(url, JSON.stringify(r));
  return r;
};

let ok = true;
const loop = await check(`http://127.0.0.1:${port}/`);
ok &&= loop.isolated && loop.sab === "function";
if (lanIP) {
  const wan = await check(`https://${lanIP}:${httpsPort}/`);
  ok &&= wan.isolated && wan.sab === "function";
} else {
  console.log("no LAN IP found — skipping https check");
}
await browser.close();
if (!ok) { console.error("FAIL: page not cross-origin isolated"); process.exit(1); }
console.log("OK: isolated on loopback http and LAN https");
