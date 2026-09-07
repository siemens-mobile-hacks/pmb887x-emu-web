import { chromium } from "playwright-core";
const q = process.argv[2], waitS = Number(process.argv[3]), pat = process.argv[4];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8080/?" + q + "&tracebuf=1", { waitUntil: "networkidle", timeout: 120000 });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, waitS * 1000));
const { total, hits } = await page.evaluate((pat) => {
  const log = window.__qemulog ?? [];
  const re = new RegExp(pat);
  return { total: log.length, hits: pat === "__skipnoise__" ? log.filter(l => !/^warning:/.test(l)).slice(60, 130) : pat === "__first40__" ? log.slice(0, 45) : log.filter((l) => re.test(l)).slice(-60) };
}, pat);
console.log("total:", total, "hits:", hits.length);
console.log(hits.join("\n"));
await browser.close();
