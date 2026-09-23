// A key event that arrives before the machine exists must not take the
// module down.
//
//   PORT=8080 node tools/earlykey.mjs [--dist dist-jit] [--board cx70]
//
// wasm_send_key() is exported the moment the module instantiates, which is
// long before wasm_display_init() creates the bottom half it schedules --
// and the page's keypad is live from its first render, so a pointer resting
// where a key lands, or a touch during the boot, delivers one.  That used to
// trap the whole module with "memory access out of bounds": with a NULL bh,
// qemu_bh_schedule()'s atomic on bh->flags succeeds (offset 40 is a valid
// wasm address), bh->ctx then reads address 0, and the list insert at
// ctx+184 goes out of bounds.
//
// It was not a theoretical race.  It is what a stationary Playwright pointer
// does when the keypad re-renders under it after Start, and it failed every
// board of tools/bootcheck.mjs on every dist for an afternoon while looking
// exactly like host memory pressure.
//
// Exit 0 iff the guest survives a key event fired at the earliest instant
// the export exists, and a normal press afterwards still reaches the guest.
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const here = fileURLToPath(new URL(".", import.meta.url));

const BOARDS = {
  s75: "S75v40lg1.bin", el71: "rr_ff_el71_stock.bin",
  ke800: "KE800-v11b.bin", ke970: "KE970v10d.bin", cx70: "CX70_FW56_clean.bin",
};
const boardId = opt("board", "cx70");
const flash = BOARDS[boardId];
if (!flash) { console.error(`unknown --board ${boardId}`); process.exit(2); }
const dist = opt("dist", "dist-jit");
const port = process.env.PORT || "8080";

const b = await chromium.launch({ headless: true });
// wide enough for the three-column layout: below 900px the Firmware and
// Run panels are bottom sheets, and a driver would have to open one to
// reach the controls it sets here
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
p.on("console", (m) => { const t = m.text(); if (/RuntimeError|Aborted\(/.test(t)) errs.push(t.slice(0, 200)); });

const extraQ = process.env.EXTRA_Q ? "&" + process.env.EXTRA_Q : "";
await p.goto(`http://127.0.0.1:${port}/?dist=${dist}${extraQ}`, { waitUntil: "domcontentloaded", timeout: 120000 });
await p.selectOption("#startup", "ONLINE");
await p.click("#ff-mode-own");
await p.setInputFiles("#fullflash", [here + "../fullflashes/" + flash]);
await p.click("#btn-start");

// Fire as close to instantiation as the event loop allows.  A key-up is the
// shape a spurious pointerleave sends: a release for a key never pressed.
const firedAt = await p.evaluate(async () => {
  for (let i = 0; i < 200000; i++) {
    const m = window.__qemu;
    if (m && m._wasm_send_key) {
      const insns = m._wasm_insns ? Number(m._wasm_insns()) : -1;
      m._wasm_send_key(28, 0);
      return insns;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  return -2;
}).catch((e) => { errs.push("evaluate: " + String(e).slice(0, 200)); return -3; });

// ...and the guest must still be alive and taking keys afterwards.
await new Promise((r) => setTimeout(r, 20000));
const after = await p.evaluate(() => {
  const m = window.__qemu;
  const i0 = Number(m._wasm_insns());
  m._wasm_send_key(28, 1);
  m._wasm_send_key(28, 0);
  return i0;
}).catch((e) => { errs.push("post-press: " + String(e).slice(0, 200)); return -1; });
await new Promise((r) => setTimeout(r, 5000));
const end = await p.evaluate(() => Number(window.__qemu._wasm_insns())).catch(() => -1);
await b.close();

const ok = errs.length === 0 && firedAt >= 0 && end > after && after >= 0;
console.log(`EARLYKEY ${boardId} ${dist} ${ok ? "PASS" : "FAIL"} ` +
  `firedAt=${firedAt} insns=${(after / 1e6).toFixed(0)}M->${(end / 1e6).toFixed(0)}M ` +
  `errors=${errs.length}${errs.length ? " :: " + errs[0] : ""}`);
process.exit(ok ? 0 : 1);
