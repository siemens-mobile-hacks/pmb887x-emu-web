import fs from "node:fs";
import { chromium } from "playwright-core";
const tag = process.argv[2] || "run";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
const q = new URLSearchParams({ qargs: "-d exec -D /trace.log" });
await page.goto("http://127.0.0.1:8080/?" + q.toString(), { waitUntil: "networkidle", timeout: 120000 });
await page.selectOption("#startup", "ONLINE");
await page.setInputFiles("#fullflash", "/workspace/s75_working20060710172101.bin");
await page.click("#btn-start");
let sawExit = false;
for (let i = 0; i < 14 && !sawExit; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  try {
    const s = await page.evaluate(() => {
      const m = window.__qemu;
      let ser = "", log = "";
      try { ser = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")); } catch (e) {}
      try { log = new TextDecoder("latin1").decode(m.FS.readFile("/trace.log")); } catch (e) {}
      return { ser, log };
    });
    fs.writeFileSync(`/tmp/exec-${tag}.log`, s.log || "");
    console.log(`t=${(i + 1) * 10}s serial:`, JSON.stringify((s.ser || "").replace(/[^\x20-\x7e]+/g, " ").slice(-160)), "traceLen:", (s.log || "").length);
    if (/EXIT/.test(s.ser || "")) sawExit = true;
  } catch (e) { console.log("eval err:", String(e).slice(0, 150)); break; }
}
await browser.close();
