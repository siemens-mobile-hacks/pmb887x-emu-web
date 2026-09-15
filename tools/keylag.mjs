// Key-press response latency, per board.
//
//   PORT=8080 node tools/keylag.mjs --board el71 [--dist dist-jit] [--presses 12]
//
// uibench measures throughput while keys are pressed; nothing measured the
// thing a user actually calls lag: how long after the press the screen
// changes.  Throughput and latency are different questions here, because
// the guest is idle (halted, virtual clock warping) until the key lands and
// then has a burst of real work to do.
//
// Per press it reports:
//   paint  wall ms from the pointerdown to the first framebuffer update
//   burst  wall ms until the guest goes quiet again (the whole response)
//   vms    virtual ms the guest consumed in that burst - what the response
//          would have cost on the real phone
//   Mi     guest instructions, millions
// and the ratio vms/burst, which is the one that says where the lag is:
//   ~1.0  the guest really does need that long; the emulator kept up and
//         the only way to feel faster is for the firmware to do less
//   <1    the emulator is behind real time for the length of the burst -
//         this is emulator slowness and it is ours to fix
//
// Run it at RT=off and RT=banked: off is engine speed, banked is what the
// page ships and what the user feels.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = fileURLToPath(new URL(".", import.meta.url));

const BOARDS = {
  s75: { flash: "S75v40lg1.bin", sidecars: [], key: "center" },
  el71: { flash: "rr_ff_el71_stock.bin", sidecars: [], key: "center" },
  ke800: { flash: "KE800-v11b.bin", sidecars: ["KE800-v11b.bin.cfi-efa"], key: "left_soft" },
  cx70: { flash: "CX70_FW56_clean.bin", sidecars: [], key: "center" },
};
const boardId = opt("board", "el71");
const board = BOARDS[boardId];
if (!board) { console.error(`unknown --board ${boardId} (${Object.keys(BOARDS).join(", ")})`); process.exit(2); }

const dist = opt("dist", "dist-jit");
const presses = Number(opt("presses", 12));
const settleS = Number(opt("settle", 90));
const gapMs = Number(opt("gap", 2500));       // quiet time between presses
const quietRate = Number(opt("quietrate", 3));  // M insns/s: below = idle
const maxBurstMs = Number(opt("maxburst", 8000));
const keys = opt("keys", board.key).split(",").filter(Boolean);
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

await p.goto(`http://127.0.0.1:${port}/?dist=${dist}&rt=${rt}${extraQ ? "&" + extraQ : ""}`,
             { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", [FLASH, ...SIDECARS]);
const t0 = Date.now();
await p.click("#btn-start");
await p.waitForFunction(() => !!window.__qemu, null, { timeout: 240000 });

while ((Date.now() - t0) / 1000 < settleS) {
  await sleep(1000);
  if (serialExit || pageErr) {
    console.log(`KEYLAG FAIL ${boardId} boot: ${pageErr || "guest EXIT"}`);
    await b.close(); process.exit(1);
  }
}
console.log(`[keylag] ${boardId} ${dist} rt=${rt}: settled at ${settleS}s, ${presses} presses`);

// The whole press-and-watch cycle runs inside the page: a CDP round trip per
// poll would be a large part of the number being measured.
const rows = [];
for (let i = 0; i < presses; i++) {
  const r = await p.evaluate(async ({ key, quietRate, maxBurstMs }) => {
    const m = window.__qemu;
    const now = () => performance.now();
    const insns = () => Number(m._wasm_insns());
    const vclock = () => Number(m._wasm_vclock());
    const fb = () => Number(m._wasm_fb_updates());
    // wasm-diag indices: 7 = tb_gen_code, 34 = WebAssembly.Module created.
    // A press that reaches code never translated before pays a synchronous
    // wasm compile per module, which is not the same problem as being slow.
    const tbGen = () => Number(m._wasm_memstat(7));
    const mods = () => Number(m._wasm_memstat(34));
    // 8 = tb_flush (code buffer full: every translation thrown away), 50 =
    // modules re-created after the live-module cap evicted them.  Either one
    // recurring per press would mean the press is paying for translation the
    // emulator already did, which is a different fix from being slow.
    const tbFlush = () => Number(m._wasm_memstat(8));
    const ensureN = () => Number(m._wasm_memstat(50));
    const tick = () => new Promise((r) => setTimeout(r, 2));

    const btn = document.querySelector(`[data-key="${key}"]`);
    if (!btn) return { err: "no such key button: " + key };

    const fb0 = fb(), v0 = vclock(), i0 = insns();
    const g0 = tbGen(), m0 = mods(), f0 = tbFlush(), e0 = ensureN();
    const t0 = now();
    const ev = (type) => btn.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));
    ev("pointerdown");

    let paint = null, up = false;
    let lastT = t0, lastI = i0, quiet = 0;
    while (now() - t0 < maxBurstMs) {
      await tick();
      if (!up && now() - t0 >= 60) { ev("pointerup"); up = true; }
      if (paint === null && fb() > fb0) paint = now() - t0;
      const t = now(), ins = insns();
      const rate = (ins - lastI) / ((t - lastT) / 1000);
      lastT = t; lastI = ins;
      // the guest is done when it has been under the idle rate for 150 ms,
      // and only after it actually started doing something
      if (paint !== null || ins - i0 > 200000) {
        quiet = rate < quietRate * 1e6 ? quiet + 1 : 0;
        if (quiet >= 6) break;
      }
    }
    if (!up) ev("pointerup");
    const burst = now() - t0;
    return { paint, burst, vms: (vclock() - v0) / 1e6, mi: (insns() - i0) / 1e6,
             tbs: tbGen() - g0, mods: mods() - m0,
             flush: tbFlush() - f0, ens: ensureN() - e0 };
  }, { key: keys[i % keys.length], quietRate, maxBurstMs });

  if (r.err) { console.log("KEYLAG FAIL " + r.err); await b.close(); process.exit(1); }
  rows.push(r);
  console.log(`  press ${String(i + 1).padStart(2)}  paint=${r.paint === null ? "  none" : r.paint.toFixed(0).padStart(5) + "ms"}` +
    `  burst=${r.burst.toFixed(0).padStart(5)}ms  vms=${r.vms.toFixed(0).padStart(5)}` +
    `  Mi=${r.mi.toFixed(1).padStart(6)}  v/wall=${(r.vms / r.burst).toFixed(2)}` +
    `  tbs=${String(r.tbs).padStart(5)} mods=${String(r.mods).padStart(4)}` +
    `  tbFlush=${r.flush} reMod=${r.ens}`);
  await sleep(gapMs);
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
// the first press wakes paths nothing else has touched (translation, menus);
// report it, but let the steady-state median come from the rest
const st = rows.slice(1);
const paints = st.map((r) => r.paint).filter((x) => x !== null);
const load = readFileSync("/proc/loadavg", "ascii").split(" ").slice(0, 3).join(" ");
console.log(`KEYLAG ${boardId} ${dist} rt=${rt} n=${st.length} ` +
  `paintMed=${med(paints).toFixed(0)}ms burstMed=${med(st.map((r) => r.burst)).toFixed(0)}ms ` +
  `vmsMed=${med(st.map((r) => r.vms)).toFixed(0)}ms MiMed=${med(st.map((r) => r.mi)).toFixed(1)} ` +
  `vwallMed=${med(st.map((r) => r.vms / r.burst)).toFixed(2)} ` +
  `tbsMed=${med(st.map((r) => r.tbs))} modsMed=${med(st.map((r) => r.mods))} ` +
  `tbFlush=${st.reduce((s, r) => s + r.flush, 0)} reMod=${st.reduce((s, r) => s + r.ens, 0)} ` +
  `first=${rows[0].burst.toFixed(0)}ms/${rows[0].tbs}tbs load=${load}`);
await b.close();
