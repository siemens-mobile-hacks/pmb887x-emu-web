// One-off: run the op-suite page with QEMU_COSTACK=1 and print every
// distinct [qemu] COSTACK stack (coroutine-switch frames -> onlylist).
import { chromium } from "playwright-core";

const port = process.argv[2] || "8080";
const dist = process.argv[3] || "dist";
const timeoutMs = 180 * 1000;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("COSTACK")) console.log(t);
});
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 300)));

await page.goto(
  `http://127.0.0.1:${port}/?suite=dist/tcgisa.bin&dist=${dist}&env=${encodeURIComponent("QEMU_COSTACK=1")}`,
  { waitUntil: "networkidle", timeout: 120000 });

const t0 = Date.now();
let done = false;
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    done = await page.evaluate(() => {
      const m = window.__qemu;
      try {
        return /^# result:/m.test(new TextDecoder("latin1").decode(m.FS.readFile("/serial.log")));
      } catch (e) { return false; }
    });
  } catch (e) { console.error("page unresponsive:", String(e).slice(0, 200)); break; }
  if (done) break;
  if (Date.now() - t0 > timeoutMs) { console.error("TIMEOUT"); break; }
}
await browser.close();
// a suite that never printed its result has not listed every stack
if (!done) process.exitCode = 1;
