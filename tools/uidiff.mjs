// Compare the keypad and side-key geometry of two served copies of the page.
//
//   node tools/uidiff.mjs <portA> <portB> [width] [height]
//
// Prints every on-screen phone key whose box (relative to the LCD's top-left
// corner) or size differs between the two — the redesign must leave the
// keypad and the side keys exactly where they were.
import { chromium } from "playwright-core";

const [a = "8099", b = "8080", w = "1770", h = "1000"] = process.argv.slice(2);

// Everything is measured against the LCD's own corner and normalised by the
// screen box, so the comparison is of the keypad's proportions rather than of
// how much room the window happened to leave: the layout scales with the
// column, and two builds at the same viewport need not draw it the same size
// to be drawing the same keypad.
const PROBE = `(() => {
  const lcd = document.getElementById("lcd").getBoundingClientRect();
  const out = {};
  const sel = "#keypad button[data-key], .aux-keys-left button[data-key], .aux-keys-right button[data-key]";
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    out[el.dataset.key] = [r.left - lcd.left, r.top - lcd.top, r.width, r.height]
      .map((v) => Math.round((v / lcd.width) * 1000) / 1000);
  }
  out.__lcd = [lcd.width, lcd.height].map((v) => Math.round(v * 100) / 100);
  out.__ar = Math.round((lcd.width / lcd.height) * 1000) / 1000;
  return out;
})()`;

const browser = await chromium.launch({ headless: true });
// both copies are pinned to the same keyboard: which board is *shown* by
// default follows the selected device, and the new page selects a preset
// where the old one started on "my own file"
const KBD = process.env.KBD || "s75";
async function probe(port) {
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
  await page.addInitScript((k) => {
    localStorage.setItem("kbd-keyboard", k);
    localStorage.setItem("kbd-variant", "en");
    localStorage.setItem("kbd-hints", "1");
  }, KBD);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  // after load, not only via localStorage: the new page follows the selected
  // device's keyboard on startup and would overwrite the stored one
  await page.selectOption("#kbd-keyboard", KBD);
  await page.waitForTimeout(500);
  const r = await page.evaluate(PROBE);
  await page.close();
  return r;
}

const A = await probe(a), B = await probe(b);
await browser.close();

let bad = 0;
for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
  if (k === "__lcd") continue;   // the two builds may draw at different sizes
  const x = JSON.stringify(A[k]), y = JSON.stringify(B[k]);
  if (x !== y) { console.log(`DIFF ${k}: ${x} -> ${y}`); bad++; }
}
console.log(bad ? `${bad} difference(s)`
  : `identical (${Object.keys(A).length - 2} keys, lcd ${A.__lcd} -> ${B.__lcd})`);
