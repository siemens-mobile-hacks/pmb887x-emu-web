// Screenshot helper for the wasm emulator page.
//
//   node screenshot.mjs [url] [out.png] [boot-wait-seconds] [fullflash-path]
//
// Opens the page, selects the fullflash, presses Start, waits for the phone
// to boot, and saves a full-page screenshot. Requires the server (web/serve.mjs)
// to be running.
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fullflash } from "./testflash.mjs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const out = process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), "shot.png");
const waitS = Number(process.argv[4] || 90);
const flash =
  process.argv[5] || fullflash;

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--use-gl=swiftshader",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
page.on("console", (m) => console.log("[page]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

const input = await page.$("#fullflash");
await input.uploadFile(flash);
await page.click("#btn-start");

console.log(`booting ${waitS}s…`);
await new Promise((r) => setTimeout(r, waitS * 1000));

await page.screenshot({ path: out, fullPage: false });
console.log("saved", out);

// also dump the LCD canvas alone for a close-up
const lcd = await page.$("#lcd");
if (lcd) await lcd.screenshot({ path: out.replace(/\.png$/, "-lcd.png") });

await browser.close();
