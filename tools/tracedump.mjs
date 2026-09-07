// Boots with ?trace=...&debug=1 and prints the qemu log lines.
//   node tracedump.mjs <query> <waitSeconds> <maxLines>
import { chromium } from "playwright-core";
const q = process.argv[2] || "trace=dsp,dsp_interrupt&debug=1";
const waitS = Number(process.argv[3] || 60);
const maxLines = Number(process.argv[4] || 400);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const lines = [];
page.on("console", (m) => { if (m.type() === "log") lines.push(m.text()); });
await page.goto("http://127.0.0.1:8080/?" + q, { waitUntil: "networkidle", timeout: 120000 });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, waitS * 1000));
const out = lines.filter((l) => l.startsWith("[qemu]") || l.startsWith("[log]"));
console.log(`total log lines: ${out.length}; last ${maxLines}:`);
console.log(out.slice(-maxLines).join("\n"));
await browser.close();
