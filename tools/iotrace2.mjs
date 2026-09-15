// Boot any board with PMB887X_TRACE_IO=<spec> and summarise the trace by
// register: which MMIO registers the firmware touches, and how often.
//
//   PORT=8080 TRACE=scu,dif,ssc node tools/iotrace2.mjs --board cx70 [--secs 60]
//
// iotrace.mjs dumps the raw lines for one fixed fullflash; this takes a
// --board and prints a ranked table instead, which is what you want when the
// question is "what is this firmware spinning on" rather than "what did that
// one access do".
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = fileURLToPath(new URL(".", import.meta.url));

const BOARDS = {
  s75: { flash: "S75v40lg1.bin", sidecars: [] },
  el71: { flash: "rr_ff_el71_stock.bin", sidecars: [] },
  ke800: { flash: "KE800-v11b.bin", sidecars: ["KE800-v11b.bin.cfi-efa"] },
  cx70: { flash: "CX70_FW56_clean.bin", sidecars: [] },
};
const board = BOARDS[opt("board", "cx70")];
if (!board) { console.error("unknown --board"); process.exit(2); }

const secs = Number(opt("secs", 60));
const from = Number(opt("from", 30));   // ignore the boot: count only after this
const spec = process.env.TRACE || "scu,dif,ssc,dmac,gptu,tpu,vic";
const dist = opt("dist", "dist-jit");
const port = process.env.PORT || "8080";

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
// ?tracebuf=1 keeps the raw lines in window.__qemulog (the console path
// de-duplicates, which loses the rate -- and the rate is the question).
await p.goto(`http://127.0.0.1:${port}/?trace=${spec}&tracebuf=1&dist=${dist}&rt=off`,
             { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash",
  [here + "../fullflashes/" + board.flash,
   ...board.sidecars.map((f) => here + "../fullflashes/" + f)]);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, from * 1000));

// Sample a short window: the buffer self-trims at 30k lines, so a long one
// would silently drop the beginning and make every rate wrong.
const win = Number(opt("window", 2));
const r = await p.evaluate(async (ms) => {
  window.__qemulog.length = 0;
  const t0 = performance.now();
  await new Promise((res) => setTimeout(res, ms));
  return { lines: window.__qemulog.slice(), wall: (performance.now() - t0) / 1000 };
}, win * 1000);
await b.close();

if (r.lines.length >= 29000) {
  console.log(`IOTRACE WARN buffer hit its cap (${r.lines.length} lines in ` +
    `${r.wall.toFixed(2)}s) -- rates are a lower bound; use --window 1`);
}
const counts = new Map();
for (const t of r.lines) {
  const k = t.trim().split(/\s+/).slice(0, 3).join(" ").slice(0, 70);
  counts.set(k, (counts.get(k) || 0) + 1);
}
const rows = [...counts.entries()].sort((a, c) => c[1] - a[1]).slice(0, 30);
const total = r.lines.length;
console.log(`IOTRACE ${opt("board", "cx70")} ${dist} trace=${spec} ` +
  `${total} lines over ${r.wall.toFixed(2)}s (${Math.round(total / r.wall)}/s)`);
for (const [k, c] of rows) {
  console.log(`  ${String(Math.round(c / r.wall)).padStart(7)}/s  ${(c / total * 100).toFixed(1).padStart(5)}%  ${k}`);
}
