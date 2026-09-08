// Parallel wasm boot matrix: boot several pages with different query
// params / fullflashes in one headless browser and report per-page
// progress (virtual time, insns, fb updates, serial, >>EXIT<<).
//
// Complements tools/session.mjs (single persistent session for
// interactive iteration): this one answers "which config boots?" by
// running everything at once.
//
// Usage:
//   node tools/bootmatrix.mjs --secs 900 [--poll 20] SPEC [SPEC ...]
//     SPEC = label[|query[|fullflash[|sidecar]]]
//            query   e.g. "icount=shift=3" (& not needed; single param)
//            files default to tools/testflash.mjs's flash
//   Examples:
//     node tools/bootmatrix.mjs 600 'shift3|icount=shift=3' 'none||fullflashes/KE800-v11b.bin|fullflashes/KE800-v11b.bin.cfi-efa'
//
// Output: one line per poll per page (label v=… insns=… …), a final
// JSON verdict per page (last v/insns/fb, exit text, screenshots under
// tools/matrix-<label>-*.png).

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fullflash as defaultFlash } from "./testflash.mjs";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, "..");
const PORT = process.env.PORT || "8080";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const secs = Number(opt("secs", 600));
const poll = Number(opt("poll", 20));
const specs = argv.filter((a, i) => a.startsWith("--") ? false : (isNaN(Number(a)) || i === 0 ? true : !argv[i - 1].startsWith("--")));
// simpler: re-parse specs as args not preceded by an --option name
const specArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { i++; continue; }
  specArgs.push(argv[i]);
}

const runs = specArgs.map((s) => {
  const [label, query = "", flash = "", sidecar = ""] = s.split("|");
  const files = [flash ? path.resolve(ROOT, flash) : defaultFlash];
  if (sidecar) files.push(path.resolve(ROOT, sidecar));
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
  return { label, query, files };
});
if (!runs.length) {
  console.error("usage: node tools/bootmatrix.mjs [--secs N] [--poll N] label[|query[|flash[|sidecar]]] ...");
  process.exit(2);
}

console.log(`bootmatrix: ${runs.length} pages, ${secs}s, poll ${poll}s -> http://127.0.0.1:${PORT}/`);
const browser = await chromium.launch({ headless: true });

const WATCH = `
  window.__mx = { v: 0, insns: 0, fb: 0, ser: 0, exit: "", status: "" };
  setInterval(() => {
    const m = window.__qemu; if (!m) return;
    try { window.__mx.ser = m.FS.readFile("/serial.log").length; } catch {}
    try {
      const s = new TextDecoder("latin1").decode(m.FS.readFile("/serial.log"));
      const x = s.match(/>>EXIT<<[^\\x00]{0,90}/); if (x) window.__mx.exit = x[0];
    } catch {}
    try {
      window.__mx.v = Number(m._wasm_vclock()) / 1e9;
      window.__mx.insns = Number(m._wasm_insns());
      window.__mx.fb = Number(m._wasm_fb_updates());
      window.__mx.status = document.querySelector("#status")?.textContent || "";
    } catch {}
  }, 3000);
`;

const pages = [];
for (const r of runs) {
  const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
  page.on("pageerror", (e) => console.log(`[${r.label}] pageerror: ${String(e).slice(0, 200)}`));
  await page.goto(`http://127.0.0.1:${PORT}/${r.query ? "?" + r.query : ""}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.addScriptTag({ content: WATCH });
  await page.selectOption("#startup", "ONLINE");
  await page.setInputFiles("#fullflash", r.files);
  await page.click("#btn-start");
  pages.push({ ...r, page });
  await new Promise((res) => setTimeout(res, 1500)); // stagger page starts
}

const t0 = Date.now();
const results = new Map(runs.map((r) => [r.label, null]));
while ((Date.now() - t0) / 1000 < secs) {
  await new Promise((res) => setTimeout(res, poll * 1000));
  const t = ((Date.now() - t0) / 1000).toFixed(0);
  for (const p of pages) {
    const mx = await p.page.evaluate(() => window.__mx).catch(() => null);
    if (!mx) continue;
    results.set(p.label, mx);
    const flag = mx.exit ? " *** EXIT ***" : "";
    console.log(`[${p.label}] t=${t}s v=${mx.v.toFixed(1)}s insns=${(mx.insns / 1e6).toFixed(0)}M fb=${mx.fb} ser=${mx.ser} status="${mx.status.slice(0, 40)}"${flag}`);
  }
}

for (const p of pages) {
  const shot = path.join(TOOLS, `matrix-${p.label}.png`);
  await p.page.screenshot({ path: shot }).catch(() => {});
  const lcd = await p.page.$("#lcd");
  if (lcd) await lcd.screenshot({ path: path.join(TOOLS, `matrix-${p.label}-lcd.png`) }).catch(() => {});
}
const out = {};
for (const [label, mx] of results) out[label] = mx;
console.log("BOOTMATRIX " + JSON.stringify(out));
await browser.close();
