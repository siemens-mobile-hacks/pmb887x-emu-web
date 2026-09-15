// Screenshot the emulator page in a given viewport, without booting.
//
//   node tools/uishot.mjs <out.png> [width] [height] [script]
//
// `script` is optional JS evaluated in the page after load (e.g. to open a
// sheet or switch modes) before the shot is taken. Used while working on
// site/index.html + style.css; the booted-state shots come from
// tools/screenshot.mjs.
import { chromium } from "playwright-core";

const [out = "ui.png", w = "1770", h = "1000", script = ""] = process.argv.slice(2);
const PORT = process.env.PORT || "8080";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: Number(w), height: Number(h) },
  deviceScaleFactor: 2,
  hasTouch: Number(w) < 600,
});
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 400)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("console.error:", m.text().slice(0, 300));
});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
if (script) await page.evaluate(script);
await page.waitForTimeout(400);
await page.screenshot({ path: out });
console.log("saved", out);
await browser.close();
