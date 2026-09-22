// Why is this board awake?
//
//   PORT=8080 node tools/haltprobe.mjs --board cx70 [--dist dist-jit]
//
// A board that halts costs almost nothing when idle: the vCPU sleeps, the
// virtual clock warps to the next deadline, and v/wall runs to 50+.  The
// S75 halts ~27k times a second at its idle screen.  The CX70 halts ~64
// times a second and burns ~116 MIPS to hold 1.07x real time.
//
// There are two ways that happens and they need opposite fixes:
//   - the firmware really is busy (network search, an animated screen), in
//     which case the only lever is making the emulator faster; or
//   - something holds an interrupt line asserted, so arm_cpu_has_work() is
//     always true and HELPER(wfi) returns without halting.  Note it tests
//     cs->interrupt_request alone - a line the guest has masked in CPSR or
//     in the VIC still counts as work here.  That would be an emulation
//     bug worth more than any amount of tuning.
//
// So sample cs->interrupt_request (wasm_irq_pending) densely and report
// how much of the time each bit is set, alongside the halt rate.  A bit
// that is set ~100 % of the time on an idle phone is the answer.
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
  ke970: { flash: "KE970v10d.bin", sidecars: ["KE970v10d.bin.cfi-efa"] },
  cx70: { flash: "CX70_FW56_clean.bin", sidecars: [] },
};
const boardId = opt("board", "cx70");
const board = BOARDS[boardId];
if (!board) { console.error(`unknown --board ${boardId}`); process.exit(2); }

const dist = opt("dist", "dist-jit");
const settleS = Number(opt("settle", 120));
const sampleS = Number(opt("sample", 15));
const port = process.env.PORT || "8080";
const rt = process.env.RT || "off";

// include/exec/cpu-interrupt.h, plus target/arm/cpu.h for the TGT_* aliases
const BITS = [
  [0x0002, "HARD(irq)"], [0x0004, "EXITTB"], [0x0010, "FIQ"],
  [0x0020, "HALT"], [0x0040, "VIRQ"], [0x0080, "DEBUG"],
  [0x0100, "VSERR"], [0x0200, "VFIQ"],
];

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
let pageErr = null;
p.on("pageerror", (e) => { pageErr = String(e).slice(0, 200); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await p.goto(`http://127.0.0.1:${port}/?dist=${dist}&rt=${rt}`,
             { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash",
  [here + "../fullflashes/" + board.flash,
   ...board.sidecars.map((f) => here + "../fullflashes/" + f)]);
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });
await sleep(settleS * 1000);
if (pageErr) { console.log(`HALTPROBE FAIL ${boardId} ${pageErr}`); await b.close(); process.exit(1); }

const r = await p.evaluate(async (sampleMs) => {
  const m = window.__qemu;
  const t0 = performance.now();
  const counts = new Map();
  let n = 0;
  const halt0 = Number(m._wasm_memstat(29));
  const i0 = Number(m._wasm_insns());
  const v0 = Number(m._wasm_vclock());
  while (performance.now() - t0 < sampleMs) {
    // a tight burst between yields: one sample per macrotask would be far
    // too coarse for a line that is asserted and cleared thousands of
    // times a second
    for (let k = 0; k < 400; k++) {
      const q = Number(m._wasm_irq_pending()) >>> 0;
      counts.set(q, (counts.get(q) || 0) + 1);
      n++;
    }
    await new Promise((res) => setTimeout(res, 0));
  }
  const wall = (performance.now() - t0) / 1000;
  return {
    n, wall, rows: [...counts.entries()].sort((a, c) => c[1] - a[1]).slice(0, 8),
    halts: Number(m._wasm_memstat(29)) - halt0,
    mi: (Number(m._wasm_insns()) - i0) / 1e6,
    vms: (Number(m._wasm_vclock()) - v0) / 1e6,
  };
}, sampleS * 1000);

const load = readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" ");
console.log(`HALTPROBE ${boardId} ${dist} samples=${r.n} over ${r.wall.toFixed(1)}s ` +
  `halts/s=${Math.round(r.halts / r.wall)} MIPS=${(r.mi / r.wall).toFixed(1)} ` +
  `v/wall=${(r.vms / 1000 / r.wall).toFixed(2)} load=${load}`);
for (const [val, c] of r.rows) {
  const names = BITS.filter(([m]) => val & m).map(([, s]) => s).join("|") || "(none)";
  console.log(`  interrupt_request=0x${val.toString(16).padStart(4, "0")} ` +
    `${(c / r.n * 100).toFixed(1).padStart(5)}%  ${names}`);
}
await b.close();
