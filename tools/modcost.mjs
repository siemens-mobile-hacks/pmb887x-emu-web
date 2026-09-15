// What fraction of wall time goes into building our wasm modules?
//
//   PORT=8080 node tools/modcost.mjs --board el71 [--from 0] [--window 45]
//
// This is the ceiling probe for tiering: tiering can only win back the share
// of wall time that translation + module construction costs, so measure that
// share before building it.
//
// Both timers are read through _wasm_memstat from the page, NOT from the
// worker: w64_batch_instantiate's own __w64t* globals live in the vCPU
// worker, and that worker runs the guest without yielding, so a worker-side
// evaluate() never gets scheduled and hangs the tool.  Charge the time in C
// instead, where it lands in wasm_diag_stat like every other counter.
//
//   modNs    always on (~1k modules/s at boot: two clock reads are noise)
//   tbGenNs  only in a WASM_DIAG_TIME_PHASES build -- see
//            qemu/accel/tcg/translate-all.c.  Reads 0 otherwise.
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { NAMES } from "./diagnames.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = fileURLToPath(new URL(".", import.meta.url));

const BOARDS = {
  s75: { flash: "S75v40lg1.bin", sidecars: [] },
  el71: { flash: "rr_ff_el71_stock.bin", sidecars: [] },
  ke800: { flash: "KE800-v11b.bin", sidecars: ["KE800-v11b.bin.cfi-efa"] },
  cx70: { flash: "CX70_FW56_clean.bin", sidecars: [] },
};
const boardId = opt("board", "el71");
const board = BOARDS[boardId];
if (!board) { console.error("unknown --board"); process.exit(2); }

const dist = opt("dist", "dist-jit");
const from = Number(opt("from", 0));
const win = Number(opt("window", 45));
const port = process.env.PORT || "8080";

const ix = (n) => {
  const i = NAMES.indexOf(n);
  if (i < 0) { throw new Error(`modcost: no counter named ${n}`); }
  return i;
};
const IDX = {
  mods: ix("modCount"), bytes: ix("modBytes"), modNs: ix("modNs"),
  genNs: ix("tbGenNs"), tbGen: ix("tbGen"),
  closeN: ix("closeN"), miss: ix("specMiss"), halt: ix("halt"),
};

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

const snap = () => p.evaluate((idx) => {
  const m = window.__qemu;
  const o = { insns: Number(m._wasm_insns()), t: performance.now() };
  for (const k of Object.keys(idx)) o[k] = Number(m._wasm_memstat(idx[k]));
  return o;
}, IDX);

if (from) await new Promise((r) => setTimeout(r, from * 1000));
const a = await snap();
await new Promise((r) => setTimeout(r, win * 1000));
const z = await snap();
await b.close();

const d = (k) => z[k] - a[k];
const wallMs = z.t - a.t;
const modMs = d("modNs") / 1e6, genMs = d("genNs") / 1e6;
const mods = d("mods"), bytes = d("bytes"), tbs = d("tbGen");
const pct = (x) => ((x / wallMs) * 100).toFixed(2) + "%";

console.log(`MODCOST ${boardId} ${dist} over ${(wallMs / 1000).toFixed(1)}s wall, ` +
  `${(d("insns") / 1e6).toFixed(0)}M insns, ${mods} modules, ${tbs} TBs ` +
  `(${(bytes / 1048576).toFixed(1)} MB, ${mods ? (bytes / mods).toFixed(0) : 0} B/mod, ` +
  `${mods ? (tbs / mods).toFixed(1) : 0} TB/mod)`);
console.log(`  compile  ${modMs.toFixed(0).padStart(7)} ms  ${pct(modMs).padStart(7)}` +
  `   ${mods ? (modMs / mods).toFixed(3) : 0} ms/module`);
console.log(`  translate${genMs.toFixed(0).padStart(7)} ms  ${pct(genMs).padStart(7)}` +
  `   ${tbs ? (genMs / tbs).toFixed(4) : 0} ms/TB` +
  `${genMs ? "" : "   (0 = not a WASM_DIAG_TIME_PHASES build)"}`);
console.log(`  PIPELINE ${(modMs + genMs).toFixed(0).padStart(7)} ms  ` +
  `${pct(modMs + genMs).padStart(7)}   <- the whole prize for tiering`);
console.log(`  closeN=${d("closeN")} specMiss=${d("miss")} halts=${d("halt")}`);
