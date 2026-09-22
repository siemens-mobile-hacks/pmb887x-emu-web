// Every unconditional wasm_memstat counter for one board, as a rate.
//
//   PORT=8080 node tools/counters.mjs --board cx70 [--from 130] [--window 20]
//
// diagall.mjs does this for the one fixed testflash; this takes a --board and
// reports the *delta rate* over a settled window, which is what finds a device
// storm (round fifteen's DIF/DMAC win was three orders of magnitude on one
// counter).  These are guest-event counters: under icount they are a function
// of the instruction count, so they stay meaningful at any host load -- unlike
// a profile, whose per-function attribution in this build has been shown to be
// wrong by a factor of 100 (see doc/lessons.md).
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = fileURLToPath(new URL(".", import.meta.url));

const BOARDS = {
  s75: { flash: "S75v40lg1.bin", sidecars: [] },
  el71: { flash: "rr_ff_el71_stock.bin", sidecars: [] },
  ke800: { flash: "KE800-v11b.bin", sidecars: ["KE800-v11b.bin.cfi-efa"] },
  ke970: { flash: "KE970v10d.bin", sidecars: ["KE970v10d.bin.cfi-efa"] },
  cx70: { flash: "CX70_FW56_clean.bin", sidecars: [] },
};
const boardId = opt("board", "cx70");
const board = BOARDS[boardId];
if (!board) { console.error("unknown --board"); process.exit(2); }

import { NAMES } from "./diagnames.mjs";
// Gauges, not counters: a delta on these is meaningless.
const GAUGES = new Set(["tlbSize0", "tlbUsed0", "modSrc"]);

const dist = opt("dist", "dist-jit");
const from = Number(opt("from", 130));
const win = Number(opt("window", 20));
const port = process.env.PORT || "8080";

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const envq = (process.env.WENV || "").split(",").filter(Boolean)
  .map((e) => `&env=${encodeURIComponent(e)}`).join("");
await p.goto(`http://127.0.0.1:${port}/?dist=${dist}&rt=${process.env.RT || "off"}${envq}`,
             { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash",
  [here + "../fullflashes/" + board.flash,
   ...board.sidecars.map((f) => here + "../fullflashes/" + f)]);
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });
await new Promise((r) => setTimeout(r, from * 1000));

const snap = () => p.evaluate((n) => {
  const m = window.__qemu;
  const c = [];
  for (let i = 0; i < n; i++) c.push(Number(m._wasm_memstat(i)));
  return { c, insns: Number(m._wasm_insns()), v: Number(m._wasm_vclock()),
           t: performance.now() };
}, NAMES.length);

const a = await snap();
await new Promise((r) => setTimeout(r, win * 1000));
const z = await snap();
await b.close();

const wall = (z.t - a.t) / 1000;
const mi = (z.insns - a.insns) / 1e6;
const vs = (z.v - a.v) / 1e9;
console.log(`COUNTERS ${boardId} ${dist} over ${wall.toFixed(1)}s wall, ` +
  `${vs.toFixed(1)}s virtual, ${mi.toFixed(0)}M insns (v/wall=${(vs / wall).toFixed(2)})`);
const rows = NAMES.map((n, i) => [n, z.c[i] - a.c[i], z.c[i]])
  .filter(([n, d]) => d !== 0 && !GAUGES.has(n))
  .sort((x, y) => y[1] - x[1]);
for (const [n, d, tot] of rows) {
  console.log(`  ${n.padEnd(16)} ${String(Math.round(d / wall)).padStart(12)}/s wall  ` +
    `${String(Math.round(d / vs)).padStart(12)}/s guest  (per Mi: ${(d / mi).toFixed(2)})`);
}
