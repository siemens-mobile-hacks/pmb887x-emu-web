// count io_recompile frequency + unique PCs from -d exec log
import { chromium } from "playwright-core";
const waitS = Number(process.argv[2] || 30);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => { const t = m.text(); if (t.startsWith("WATCH")) console.log("[page]", t.slice(0, 120)); });
await page.goto("http://127.0.0.1:8080/?qargs=-d exec -D /exec.log", { waitUntil: "networkidle" });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
await new Promise((r) => setTimeout(r, waitS * 1000));
const log = await page.evaluate(() => {
  const m = window.__qemu;
  return new TextDecoder("latin1").decode(m.FS.readFile("/exec.log"));
});
const lines = log.split("\n");
const recs = lines.filter((l) => l.includes("io_recompile"));
const pcs = new Map();
for (const l of recs) {
  const pc = l.split("TB to ")[1];
  pcs.set(pc, (pcs.get(pc) || 0) + 1);
}
console.log("total lines:", lines.length, "io_recompile:", recs.length);
console.log("unique rewound PCs:", pcs.size);
console.log("top:", [...pcs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
await browser.close();
