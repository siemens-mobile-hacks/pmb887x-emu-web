// Does the inline per-TB-entry instruction counter still tell the truth?
//
//   PORT=8080 node tools/acctcheck.mjs [--board cx70] [--from 130] [--window 20]
//
// The wasm64 prologue prepays tb->icount into wasm_tb_stats[1] once per TB
// entry.  Two things break that: an early exit runs fewer instructions than
// it was charged for, and a loop back-edge re-runs the body without coming
// back through the prologue at all.  target/arm charges and refunds the
// difference (w64_acct_charge), and on the LG boards nothing can check the
// result, because there the same counter *is* the MIPS readout.
//
// So check it where something else knows the answer.  Under icount,
// wasm_insns() reports the icount state and ignores the inline counter
// entirely, while W64_TBSTATS=1 keeps the counter running -- two independent
// counts of the same instructions.  The arms are the mechanisms that make
// one entry stop meaning tb->icount instructions:
//
//   exact  W64_FTMAX=0 W64_LOOP=0   no early exits, no back-edges: the
//                                   control, and its ratio is the floor
//   live   defaults                 both mechanisms on
//
// The floor is not 1.0.  A TB that faults part-way (410 exceptions/Mi on
// the J2ME workload) has already been charged for instructions it never
// ran, and nothing refunds those -- the exception machinery restores
// icount, not this counter.  That bias is the same in both arms, which is
// why the verdict is the *difference* between the ratios and not either
// ratio on its own.
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = fileURLToPath(new URL(".", import.meta.url));

const BOARDS = {
  s75: { flash: "S75v40lg1.bin", sidecars: [] },
  el71: { flash: "rr_ff_el71_stock.bin", sidecars: [] },
  cx70: { flash: "CX70_FW56_clean.bin", sidecars: [] },
};
const boardId = opt("board", "cx70");
const board = BOARDS[boardId];
if (!board) { console.error("unknown --board (icount boards only)"); process.exit(2); }

const dist = opt("dist", "dist-jit");
const from = Number(opt("from", 130));
const win = Number(opt("window", 20));
const port = process.env.PORT || "8080";

const ARMS = [
  { tag: "exact", env: ["W64_TBSTATS=1", "W64_FTMAX=0", "W64_LOOP=0"] },
  { tag: "live", env: ["W64_TBSTATS=1"] },
];

const snap = (p) => p.evaluate(() => {
  const m = window.__qemu;
  return { icount: Number(m._wasm_insns()), inline: Number(m._wasm_tb_insns()),
           tbs: Number(m._wasm_tbs()), t: performance.now() };
});

const out = [];
for (const arm of ARMS) {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const envq = arm.env.map((e) => `&env=${encodeURIComponent(e)}`).join("");
  await p.goto(`http://127.0.0.1:${port}/?dist=${dist}&rt=off${envq}`,
               { waitUntil: "domcontentloaded", timeout: 120000 });
  await p.selectOption("#startup", "ONLINE");
  await p.click("#ff-mode-own");
  await p.setInputFiles("#fullflash",
    [here + "../fullflashes/" + board.flash,
     ...board.sidecars.map((f) => here + "../fullflashes/" + f)]);
  await p.click("#btn-start");
  await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });
  await new Promise((r) => setTimeout(r, from * 1000));

  const a = await snap(p);
  await new Promise((r) => setTimeout(r, win * 1000));
  const z = await snap(p);
  await b.close();

  if (!a.inline || !z.inline) {
    console.error(`${arm.tag}: the inline counter is not running -- ` +
                  `W64_TBSTATS did not reach qemu (one assignment per env=)`);
    process.exit(3);
  }
  const ic = z.icount - a.icount;
  const inl = z.inline - a.inline;
  const tbs = z.tbs - a.tbs;
  out.push({ ...arm, ic, inl, tbs, ratio: inl / ic });
  console.log(`${arm.tag.padEnd(6)} icount ${(ic / 1e6).toFixed(1)}M  ` +
    `inline ${(inl / 1e6).toFixed(1)}M  ratio ${(inl / ic).toFixed(6)}  ` +
    `(${(tbs / 1e6).toFixed(2)}M entries, ${(ic / tbs).toFixed(2)} insns/entry)`);
}

const [ex, live] = out;
const drift = (live.ratio / ex.ratio - 1) * 100;
console.log(`\nfloor (exceptions, both arms): ${((ex.ratio - 1) * 100).toFixed(3)}%`);
console.log(`live vs exact: ${drift >= 0 ? "+" : ""}${drift.toFixed(3)}%  ` +
  (Math.abs(drift) < 0.1
    ? "-- the charges and refunds hold"
    : "-- ACCOUNTING IS WRONG: the mechanisms move the counter"));
