// How many times does a translated TB actually run?  (W64_TBHIST=1)
//
//   PORT=8080 node tools/tbhist.mjs [secs] [--dist dist-jit]
//
// This is the measurement the interpreter tier is gated on.  The trade it
// proposes is: do not build a wasm module for a TB the first time it is
// missed -- interpret it -- and compile it only once it has proved hot.
//
//   saved per never-promoted TB   a module costs ~83 us and holds ~4.9 TBs,
//                                 so ~17 us of module per TB
//   paid per interpreted entry    (interpreted - compiled) cost of one entry
//
// A compiled entry of a 4.16-guest-insn TB is ~85 ns of body plus ~7.7 ns of
// dispatch.  If interpretation is ~10x that, the marginal cost is ~0.8 us an
// entry and the break-even promotion threshold is ~20 entries.  So the whole
// question is the SHAPE of the distribution below ~2^5: if most TBs run
// thousands of times, there is nothing to interpret and open item 1 is dead;
// if most run a handful, the prize is most of the ~10 % pipeline.
//
// The counter is one i32 load/add/store at a translation-time-constant
// address in the TB prologue, so per-TB counts are exact.  Wall time under
// the knob is not comparable to a shipping build.
//
// tidx is recycled at tb_flush, which would merge unrelated TBs' counts:
// the run prints tbFlush and the numbers are void if it is non-zero.
import { chromium } from "playwright-core";
import { fullflash } from "./testflash.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const secs = Number(argv.find((a) => /^\d+$/.test(a)) || 60);
const dist = opt("dist", "dist-jit");
const port = process.env.PORT || "8080";
const rt = process.env.RT || "off";
const B = 24;                                  // W64_TBHIST_BUCKETS

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
p.on("console", (m) => { if (/^(TBH |PANIC|abort)/.test(m.text())) console.log(m.text()); });
const q = `env=W64_TBHIST%3D1`;
await p.goto(`http://127.0.0.1:${port}/?dist=${dist}&rt=${rt}&${q}`, { waitUntil: "domcontentloaded" });
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", fullflash);
await p.click("#btn-start");
await new Promise((r) => setTimeout(r, secs * 1000));

const r = await p.evaluate((B) => {
  const m = window.__qemu;
  if (!m || !m._wasm_tbhist) return null;
  const tbs = [], ent = [];
  for (let i = 0; i < B; i++) tbs.push(Number(m._wasm_tbhist(i)));
  for (let i = 0; i < B; i++) ent.push(Number(m._wasm_tbhist(B + i)));
  return {
    tbs, ent,
    never: Number(m._wasm_tbhist(2 * B)),
    insns: Number(m._wasm_insns()),
    tbGen: Number(m._wasm_memstat(7)),
    tbFlush: Number(m._wasm_memstat(8)),
    mods: Number(m._wasm_memstat(34)),
  };
}, B);
await b.close();

if (!r) { console.log("no _wasm_tbhist export — is this a W64_TBHIST build?"); process.exit(1); }

const nTB = r.tbs.reduce((a, c) => a + c, 0);
const nEnt = r.ent.reduce((a, c) => a + c, 0);
console.log(`\ninsns=${(r.insns / 1e6).toFixed(0)}M tbGen=${r.tbGen} mods=${r.mods} tbFlush=${r.tbFlush}` +
            (r.tbFlush ? "   *** tidx recycled: counts are merged, results void ***" : ""));
console.log(`entered TBs=${nTB}  never entered=${r.never}  total entries=${nEnt}\n`);
console.log("  entries/TB          TBs     %TBs        entries   %entries");
let cTB = 0, cEnt = 0;
for (let i = 0; i < B; i++) {
  if (!r.tbs[i] && !r.ent[i]) continue;
  cTB += r.tbs[i]; cEnt += r.ent[i];
  const lo = 2 ** i, hi = 2 ** (i + 1) - 1;
  console.log(`  ${(i === B - 1 ? `${lo}+` : `${lo}-${hi}`).padStart(12)} ` +
    `${String(r.tbs[i]).padStart(10)} ${(100 * r.tbs[i] / nTB).toFixed(1).padStart(7)} ` +
    `${String(r.ent[i]).padStart(14)} ${(100 * r.ent[i] / nEnt).toFixed(2).padStart(10)}` +
    `    cum ${(100 * cTB / nTB).toFixed(1)}% / ${(100 * cEnt / nEnt).toFixed(2)}%`);
}

// The decision curve: promote a TB to its own module after T entries.
// Modules avoided ~ the fraction of TBs that never reach T (they stay
// interpreted); interpreted entries ~ sum of min(count, T) over all TBs,
// bounded here by the buckets below T plus T per TB above it.
console.log("\n  threshold T   TBs never promoted   interpreted entries (>=)   modules avoided");
for (let k = 1; k <= 12; k++) {
  const T = 2 ** k;
  let below = 0, belowEnt = 0;
  for (let i = 0; i < k; i++) { below += r.tbs[i]; belowEnt += r.ent[i]; }
  const above = nTB - below;
  console.log(`  ${String(T).padStart(11)}   ${String(below).padStart(18)} ` +
    `${(100 * below / nTB).toFixed(1).padStart(6)}%   ${String(belowEnt + above * T).padStart(12)} ` +
    `${(100 * (belowEnt + above * T) / nEnt).toFixed(2).padStart(7)}% of entries   ` +
    `${(100 * below / nTB).toFixed(1)}%`);
}
