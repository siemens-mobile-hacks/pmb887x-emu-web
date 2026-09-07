import { chromium } from "playwright-core";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, 25000));
await browser.close();
