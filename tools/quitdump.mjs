// Boots, waits, then quits qemu cleanly so the fork's exit diagnostics
// ("sorry died at PC LR ...") land in the console log.
//   node quitdump.mjs [waitSeconds]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const waitS = Number(process.argv[2] || 120);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const lines = [];
page.on("console", (m) => lines.push(m.text()));
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 120000 });
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, waitS * 1000));
console.log("=== quitting qemu for exit dump ===");
await page.evaluate(() => window.__qemu?._wasm_quit?.());
await new Promise((r) => setTimeout(r, 8000));
const interesting = lines.filter((l) => /died|regs|PC|LR|exit|abort/i.test(l)).slice(-40);
console.log(interesting.join("\n"));
await browser.close();
