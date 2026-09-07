import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8080/?trace=dsp,scu&tracebuf=1", { waitUntil: "networkidle" });
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
// dump the first 40 non-noise lines quickly, before the buffer splices
await new Promise((r) => setTimeout(r, 20000));
const dump = await page.evaluate(() => {
  const log = (window.__qemulog ?? []).filter((l) => !/^warning:/.test(l));
  return log.slice(0, 45);
});
console.log(dump.join("\n"));
await browser.close();
