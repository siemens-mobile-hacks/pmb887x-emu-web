// Boots with ?trace=...&tracebuf=1, then extracts buffered qemu log from the page.
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const q = process.argv[2] || "trace=scu,dsp,dsp_interrupt";
const waitS = Number(process.argv[3] || 60);
const pat = process.argv[4] || "DSP_INT|COM_SET|COM_STATUS|MCU0";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.goto("http://127.0.0.1:8080/?" + q + "&tracebuf=1", { waitUntil: "networkidle", timeout: 120000 });
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, waitS * 1000));
const { total, hits } = await page.evaluate((pat) => {
  const log = window.__qemulog ?? [];
  const re = new RegExp(pat);
  const h = log.filter((l) => re.test(l));
  return { total: log.length, hits: h.slice(-120) };
}, pat);
console.log("total lines:", total, " matching:", hits.length);
console.log(hits.join("\n"));
await browser.close();
