// Boots ONLINE, soaks to the idle screen, then compares the live LCD canvas
// against a reference LCD dump (tools/final-lcd.png) pixel-wise.
//   PORT=8080 node compare-lcd.mjs [secs] [reference.png]
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const secs = Number(process.argv[2] || 300);
const ref = fs.readFileSync(process.argv[3] || (here + "final-lcd.png")).toString("base64");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let exitSeen = false;
page.on("console", (m) => { if (m.text().includes(">>EXIT<<")) exitSeen = true; });
await page.goto(`http://127.0.0.1:${process.env.PORT || 8080}/`, { waitUntil: "networkidle", timeout: 120000 });
await page.selectOption("#startup", "ONLINE");
await page.setInputFiles("#fullflash", fullflash);
await page.click("#btn-start");

let last = {};
for (let t = 0; t < secs; t += 30) {
  await new Promise((r) => setTimeout(r, 30000));
  last = await page.evaluate(() => {
    const m = window.__qemu;
    return {
      v: Number(m._wasm_vclock()) / 1e9,
      u: Number(m._wasm_fb_updates()),
    };
  }).catch(() => ({}));
  console.log(`t=${t + 30}s v=${last.v?.toFixed(1)} updates=${last.u}`);
}

const res = await page.evaluate(async (refB64) => {
  const c = document.getElementById("lcd");
  const live = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  const img = new Image();
  img.src = "data:image/png;base64," + refB64;
  await img.decode();
  const rc = new OffscreenCanvas(img.width, img.height);
  const rctx = rc.getContext("2d");
  rctx.drawImage(img, 0, 0);
  const ref = rctx.getImageData(0, 0, img.width, img.height);
  const W = Math.min(live.width, ref.width), H = Math.min(live.height, ref.height);
  if (Math.abs(live.width - ref.width) > 2 || Math.abs(live.height - ref.height) > 2)
    return { sizeMismatch: [live.width, live.height, ref.width, ref.height] };
  let diff = 0, blocks = [], B = 16;
  for (let by = 0; by < Math.ceil(H / B); by++) {
    let row = "";
    for (let bx = 0; bx < Math.ceil(W / B); bx++) {
      let d = 0, n = 0;
      for (let y = by * B; y < Math.min((by + 1) * B, H); y++)
        for (let x = bx * B; x < Math.min((bx + 1) * B, W); x++) {
          const i = (y * W + x) * 4;
          n++;
          if (Math.abs(live.data[i] - ref.data[i]) > 48 ||
              Math.abs(live.data[i + 1] - ref.data[i + 1]) > 48 ||
              Math.abs(live.data[i + 2] - ref.data[i + 2]) > 48) d++;
        }
      diff += d;
      row += d > n * 0.3 ? "#" : d > n * 0.08 ? "." : " ";
    }
    blocks.push(row);
  }
  return { pct: (100 * diff / (W * H)).toFixed(2), blocks };
}, ref);
console.log("LCD diff vs reference:", JSON.stringify(res.pct ?? res), "%  (# = very different, . = some diff)");
if (res.blocks) for (const b of res.blocks) console.log("|" + b + "|");
console.log("exitSeen:", exitSeen);
await page.screenshot({ path: "compare-lcd-live.png" });
await browser.close();
