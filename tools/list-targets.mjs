import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: true,
  executablePath: "/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 4000));
for (const t of await browser.targets()) console.log(t.type(), "|", t.url().slice(0, 80));
await browser.close();
