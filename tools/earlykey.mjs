// A key event that arrives before the machine exists must not take the
// module down.
//
//   node tools/earlykey.mjs [--dist dist] [--board cx70] [--port P (default $PORT, else 8080)]
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
// the export exists: no page error or wasm abort, and 20 s later the export
// still takes a normal press and the guest is still executing 5 s after it.
// Whether the firmware acted on that press is not checked.
import { chromium } from "playwright-core";
import fs from "node:fs";
import { parseArgs } from "./lib/argv.mjs";
import { flashFiles } from "./lib/boards.mjs";
import { bootOwnFlash, bounded, pageCall } from "./lib/page.mjs";

const { opt } = parseArgs(process.argv.slice(2), {
  values: ["board", "dist", "port"],
  usage: "node tools/earlykey.mjs [--dist dist] [--board s75|el71|ke800|ke970|cx70] [--port P]",
});

// --board -> tools/lib/boards.mjs id (this check boots the other S75 image)
const BOARDS = { s75: "s75-v40", el71: "el71", ke800: "ke800", ke970: "ke970", cx70: "cx70" };
const boardId = opt("board", "cx70");
const flash = BOARDS[boardId];
if (!flash) { console.error(`unknown --board ${boardId}`); process.exit(2); }
const files = flashFiles(flash);
const missing = files.filter((f) => !fs.existsSync(f));
if (missing.length) { console.error(`fullflash not found: ${missing.join(", ")}`); process.exit(2); }
const dist = opt("dist", "dist");
const port = opt("port", process.env.PORT || "8080");

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
// an LG flash goes in with its EFA block, as the page's user loads it
await bootOwnFlash(p, files, { startup: "ONLINE" });

// Fire as close to instantiation as the event loop allows.  A key-up is the
// shape a spurious pointerleave sends: a release for a key never pressed.
// The module may take a while to arrive on a loaded host, hence the long
// limit for this one call.
const firedAt = await pageCall(p.evaluate(async () => {
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
}), "the early key", 120000).catch((e) => { errs.push("evaluate: " + String(e).slice(0, 200)); return -3; });

// ...and the guest must still be alive and taking keys afterwards.
await new Promise((r) => setTimeout(r, 20000));
const after = await pageCall(p.evaluate(() => {
  const m = window.__qemu;
  const i0 = Number(m._wasm_insns());
  m._wasm_send_key(28, 1);
  m._wasm_send_key(28, 0);
  return i0;
}), "the press").catch((e) => { errs.push("post-press: " + String(e).slice(0, 200)); return -1; });
await new Promise((r) => setTimeout(r, 5000));
const end = await pageCall(p.evaluate(() => Number(window.__qemu._wasm_insns())), "the insns read")
  .catch((e) => { errs.push("after the press: " + String(e).slice(0, 200)); return -1; });
await bounded(b.close(), null);

const ok = errs.length === 0 && firedAt >= 0 && end > after && after >= 0;
console.log(`EARLYKEY ${boardId} ${dist} ${ok ? "PASS" : "FAIL"} ` +
  `firedAt=${firedAt} insns=${(after / 1e6).toFixed(0)}M->${(end / 1e6).toFixed(0)}M ` +
  `errors=${errs.length}${errs.length ? " :: " + errs[0] : ""}`);
process.exit(ok ? 0 : 1);
