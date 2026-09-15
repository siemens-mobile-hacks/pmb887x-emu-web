// Fixed-guest-work A/B meter: wall time to execute the same guest
// instructions.
//
//   PORT=8080 node tools/workbench.mjs --board cx70 --dist dist-jit [--to 12000]
//
// uibench measures a steady state, which assumes the board has one.  The
// SGOLD boards do not: their idle screen animates and the GSM stack cycles
// through network-search phases, so idle MIPS swings ~15 % between runs of
// the same build and cannot resolve a patch.
//
// Under icount the guest is a deterministic function of its instruction
// count - that is what makes the wasm-vs-native lockstep gate possible - so
// the stretch of guest work between two instruction milestones is identical
// in every run of every build that does not change guest-visible behaviour.
// Wall time across that stretch is then pure host speed, with none of the
// guest's own variability in it.  The tool checks that assumption rather
// than trusting it: it prints the virtual time at each milestone, and those
// must agree across runs (vSpread) or the comparison is void.
//
// --from skips the early boot, where module compilation and TB generation
// dominate and are not what is being measured.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
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
const boardId = opt("board", "cx70");
const board = BOARDS[boardId];
if (!board) { console.error(`unknown --board ${boardId} (${Object.keys(BOARDS).join(", ")})`); process.exit(2); }

const dist = opt("dist", "dist-jit");
const fromMi = Number(opt("from", 2000));    // millions of guest instructions
const toMi = Number(opt("to", 12000));
const maxS = Number(opt("max", 400));
const port = process.env.PORT || "8080";
const rt = process.env.RT || "off";
const extraQ = process.env.EXTRA_Q || "";

const FLASH = here + "../fullflashes/" + board.flash;
const SIDECARS = board.sidecars.map((f) => here + "../fullflashes/" + f);

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
let pageErr = null, serialExit = false;
p.on("pageerror", (e) => { pageErr = String(e).slice(0, 200); });
p.on("console", (m) => { if (m.text().includes(">>EXIT<<")) serialExit = true; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Counter indices follow qemu/include/qemu/wasm-diag.h (see tools/diagall.mjs).
// These are all unconditional counters, and they count *guest* events, which
// under icount are a deterministic function of the instruction count -- so
// unlike MIPS they are load-independent, and a change that removes work shows
// up in them even when the host is too busy to time anything.
const snap = () => p.evaluate(() => {
  const m = window.__qemu, g = (i) => Number(m._wasm_memstat(i));
  return {
    t: performance.now(),
    insns: Number(m._wasm_insns()),
    v: Number(m._wasm_vclock()),
    lookup: g(13), lookupJc: g(14), lookupQht: g(15), jcFlush: g(16),
    tlbFlush: g(18), tlbFlushRange: g(19), fill: g(4), tbGen: g(7),
  };
});

await p.goto(`http://127.0.0.1:${port}/?dist=${dist}&rt=${rt}${extraQ ? "&" + extraQ : ""}`,
             { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", [FLASH, ...SIDECARS]);
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });

const t0 = Date.now();
let a = null, c = null;
while ((Date.now() - t0) / 1000 < maxS) {
  await sleep(200);
  if (serialExit || pageErr) {
    console.log(`WORKBENCH FAIL ${boardId} ${dist} ${pageErr || "guest EXIT"}`);
    await b.close(); process.exit(1);
  }
  const s = await snap();
  if (!a && s.insns >= fromMi * 1e6) a = s;
  if (a && s.insns >= toMi * 1e6) { c = s; break; }
}
if (!c) {
  const s = await snap();
  console.log(`WORKBENCH FAIL ${boardId} ${dist} never reached ${toMi}M insns in ${maxS}s ` +
    `(got ${(s.insns / 1e6).toFixed(0)}M)`);
  await b.close(); process.exit(1);
}

// The screen at a given instruction count is deterministic too, so this shot
// is directly comparable across builds -- which is the correctness check for
// anything touching the display path.  It is taken after the milestone, so
// the guest has run a little further by then; --shotquiet settles it.
const shot = opt("shot", null);
if (shot) {
  // Settle by guest instructions, not wall time: a wall-time wait lets the
  // guest reach a different point under a different host load, which shows
  // up as a spurious screenshot difference.
  const until = (toMi + Number(opt("shotadvance", 100))) * 1e6;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && (await snap()).insns < until) await sleep(100);
  const lcd = await p.$("#lcd");
  if (lcd) await lcd.screenshot({ path: shot });
}

const wall = (c.t - a.t) / 1000;
const mi = (c.insns - a.insns) / 1e6;
const load = readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" ");
// vAt/insnsAt are the determinism check: across runs of any build these must
// match, because the same guest instructions were executed.
const d = (k) => c[k] - a[k];
console.log(`WORKBENCH ${boardId} ${dist} MIPS=${(mi / wall).toFixed(1)} wall=${wall.toFixed(2)}s ` +
  `Mi=${mi.toFixed(0)} insnsAt=${(a.insns / 1e6).toFixed(0)}M/${(c.insns / 1e6).toFixed(0)}M ` +
  `vAt=${(a.v / 1e9).toFixed(3)}/${(c.v / 1e9).toFixed(3)}s ` +
  `lookup=${d("lookup")} jc=${d("lookupJc")} qht=${d("lookupQht")} ` +
  `jcFlush=${d("jcFlush")} tlbFlush=${d("tlbFlush")} tlbFlushRange=${d("tlbFlushRange")} ` +
  `fill=${d("fill")} tbGen=${d("tbGen")} load=${load}`);
await b.close();
