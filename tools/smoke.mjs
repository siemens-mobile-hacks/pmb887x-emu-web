// Headless smoke test: load the page, click Start, log console output.
//   node smoke.mjs [waitSeconds] [fullflash]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";

const waitS = Number(process.argv[2] || 25);
const flash = process.argv[3] || fullflash;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => console.log("[page]", m.type(), m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 500)));
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 120000 });
console.log("loaded; status:", await page.$eval("#status", (e) => e.textContent));
await page.setInputFiles("#fullflash", flash);
await page.click("#btn-start");
console.log("started; waiting", waitS, "s");
await new Promise((r) => setTimeout(r, waitS * 1000));
console.log("status now:", await page.$eval("#status", (e) => e.textContent));
console.log("canvas:", await page.$eval("#lcd", (c) => `${c.width}x${c.height}`));
await page.screenshot({ path: "smoke.png" });
await browser.close();
