// Boots with ?trace=...&tracebuf=1, then extracts buffered qemu log from the page.
import { chromium } from "playwright-core";
import { files as fullflashFiles } from "./testflash.mjs";
import { QEMULOG_COUNT } from "./lib/page.mjs";
const q = process.argv[2] || "trace=scu,dsp,dsp.*";
const waitS = Number(process.argv[3] || 60);
const pat = process.argv[4] || "DSP_INT|COM_SET|COM_STATUS|MCU0";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.addInitScript(QEMULOG_COUNT);
await page.goto(`http://127.0.0.1:${process.env.PORT || 8080}/?` + q + "&tracebuf=1", { waitUntil: "networkidle", timeout: 120000 });
await page.click("#ff-mode-own");
await page.setInputFiles("#fullflash", fullflashFiles);
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, waitS * 1000));
const { total, kept, matching, hits } = await page.evaluate((pat) => {
  const log = window.__qemulog ?? [];
  const re = new RegExp(pat);
  const h = log.filter((l) => re.test(l));
  return { total: log.total ?? log.length, kept: log.length, matching: h.length, hits: h.slice(-120) };
}, pat);
// the page keeps only the newest 20000-30000 lines
console.log(`lines: ${total} logged, the last ${kept} kept; matching /${pat}/ in those: ${matching}` +
  (matching > hits.length ? ` (the last ${hits.length} shown)` : ""));
console.log(hits.join("\n"));
await browser.close();
