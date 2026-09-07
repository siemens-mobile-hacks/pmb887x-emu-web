import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text().slice(0, 120)));
await page.goto("http://127.0.0.1:8080/?qargs=" + encodeURIComponent("-d exec -D /exec.log"), { waitUntil: "networkidle" });
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, 30000));
const d = await page.evaluate(() => {
  const m = window.__qemu;
  try {
    const len = m.FS.stat("/exec.log").size;
    const data = new TextDecoder("latin1").decode(m.FS.readFile("/exec.log"));
    return { len, head: data.slice(0, 600), tail: data.slice(-1500) };
  } catch (e) { return { err: String(e) }; }
});
console.log(JSON.stringify(d, null, 1).slice(0, 3000));
await browser.close();
