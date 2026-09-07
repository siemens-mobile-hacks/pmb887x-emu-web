// Long-running boot monitor: polls the wasm framebuffer from inside the page
// and reports pixel statistics + serial-log growth every N seconds.
//   node monitor.mjs [totalSeconds] [intervalSeconds]
import { chromium } from "playwright-core";

const totalS = Number(process.argv[2] || 300);
const everyS = Number(process.argv[3] || 30);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const seen = new Set();
page.on("console", (m) => {
  const t = m.text();
  const key = t.slice(0, 80);
  if (seen.has(key)) return;
  seen.add(key);
  console.log("[page]", m.type(), t.slice(0, 200));
});
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 120000 });
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
console.log("booted; monitoring for", totalS, "s");

for (let t = 0; t < totalS; t += everyS) {
  await new Promise((r) => setTimeout(r, everyS * 1000));
  const stats = await page.evaluate(() => {
    const m = window.__qemu ?? null;
    const el = document.getElementById("serial");
    return {
      status: document.getElementById("status").textContent,
      serialLen: el.textContent.length,
      serialTail: el.textContent.slice(-80).replace(/\n/g, "\\n"),
    };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  // pixel stats via canvas readback
  const px = await page.evaluate(() => {
    const c = document.getElementById("lcd");
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    }
    return { w: c.width, h: c.height, lit, total: d.length / 4 };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  console.log(`t=${t + everyS}s`, JSON.stringify(stats), JSON.stringify(px));
  await page.screenshot({ path: "monitor.png" });
}
await browser.close();
