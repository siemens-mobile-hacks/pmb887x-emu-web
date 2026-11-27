// Memory card check: boot a phone on a wasm dist with a card image chosen in
// the page and change the card under the running phone (doc/sd-card.md).
//
//   node tools/cardcheck.mjs [--card <image>] [--dist dist] [--flash <id|image>]
//       [--boot 90] [--wait 60] [--costack <file>] [--query q]
//       [--port P (default $PORT, else 8080)]
//
// The fullflash is the usual test one (TESTFLASH or
// tools/testflash.local.json) unless --flash names one (an id of
// tools/lib/boards.mjs or a path); its board must have an sd-slot. Without
// --card the card is a blank 64 MB one: the firmware identifies it and reads
// its MBR, which is all the states below need. After --boot seconds the card goes through what the page does
// with it (wasm_card_* in qemu/ui/wasm.c, the card assist behind them):
//   out      eject: the firmware must see the removal (state "out")
//   in       insert: the firmware must read the card again (state "in")
//   out+in   eject and insert at once: the insert is held until the firmware
//            has seen the removal, then read
//   unmount  the clean unmount (the phone's own "Eject card"): sent, or not
//            possible on this firmware; then out+in brings the card back
// each within --wait seconds of the step.
// --costack logs every coroutine-switch stack to <file> (QEMU_COSTACK=1) for
// tools/asyncify-audit.mjs; card I/O on the vCPU thread is where a missing
// onlylist entry would show.
// VERBOSE=1 prints the whole console.
// PASS = every step reached its state, no firmware EXIT (window.__ui.exit),
// no abort and no page error.
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "./lib/argv.mjs";
import { FULLFLASHES, flashPath } from "./lib/boards.mjs";
import { bootOwnFlash, pageCall } from "./lib/page.mjs";

const { opt } = parseArgs(process.argv.slice(2), {
  values: ["dist", "flash", "card", "boot", "wait", "costack", "query", "port"],
  usage: "node tools/cardcheck.mjs [--card image] [--dist d] [--flash id|image] [--boot s] [--wait s]"
    + " [--costack file] [--query q] [--port P]",
});
const DIST = opt("dist", "dist");
const PORT = opt("port", process.env.PORT || "8080");
const BOOT = Number(opt("boot", 90));
const WAIT = Number(opt("wait", 60));
const COSTACK = opt("costack", "");
let CARD = opt("card", "");
if (!CARD) {
  CARD = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cardcheck-")), "blank.img");
  fs.writeFileSync(CARD, Buffer.alloc(64 << 20));
}
if (!fs.existsSync(CARD)) throw new Error(`--card: card image not found: ${CARD}`);
const flashOpt = opt("flash", "");
const flash = flashOpt in FULLFLASHES ? flashPath(flashOpt)
  : flashOpt || (await import("./testflash.mjs")).fullflash;
if (!fs.existsSync(flash)) throw new Error(`fullflash not found: ${flash}`);
const QUERY = [opt("query", ""), process.env.EXTRA_Q || "",
  COSTACK ? "env=" + encodeURIComponent("QEMU_COSTACK=1") : ""].filter(Boolean).join("&");

const STATES = ["in", "out", "going out", "reading", "not seen"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const costack = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("crash", () => errors.push("page crashed"));
page.on("console", (m) => {
  const t = m.text();
  if (/Aborted\(|Assertion failed|RuntimeError/.test(t)) errors.push(t.slice(0, 200));
  if (t.includes("COSTACK")) costack.push(t);
  if (process.env.VERBOSE || /card-assist|\[card\]/.test(t)) console.log("  page:", t.slice(0, 400));
});

await page.goto(`http://127.0.0.1:${PORT}/?dist=${DIST}${QUERY ? "&" + QUERY : ""}`,
                { waitUntil: "domcontentloaded" });
await page.setInputFiles("#card-image-file", CARD);
await bootOwnFlash(page, [flash, flash + ".cfi-efa"].filter((f) => fs.existsSync(f)));

const call = (fn, arg, what) => pageCall(page.evaluate(fn, arg), what);
const live = () => call(() => ({
  running: window.__ui?.state === "running",
  exit: window.__ui?.exit ? [window.__ui.exit.type, window.__ui.exit.code].join(" ") : "",
  card: !!window.__qemu?._wasm_card_state,
}), null, "run state");

const t0 = Date.now();
while (Date.now() - t0 < BOOT * 1000) {
  await sleep(2000);
  const s = await live();
  if (s.exit) { errors.push("firmware exit: " + s.exit); break; }
}
const s0 = await live();
if (!s0.running || !s0.card) errors.push(`not running with a card (${JSON.stringify(s0)})`);

// window.__qemu's card exports, as site/app.js drives them
const card = (op) => call((op) => {
  const m = window.__qemu;
  const done = m._wasm_card_done();
  if (op === "eject" || op === "swap") m._wasm_card_eject();
  if (op === "insert" || op === "swap") {
    const path = window.__card.path;
    const at = Number(m._wasm_card_buf());
    for (let i = 0; i < path.length; i++) m.HEAPU8[at + i] = path.charCodeAt(i);
    m.HEAPU8[at + path.length] = 0;
    m._wasm_card_insert();
  }
  if (op === "unmount") m._wasm_card_unmount();
  return done;
}, op, `card ${op}`);
const read = () => call(() => {
  const m = window.__qemu;
  return { done: m._wasm_card_done(), state: m._wasm_card_state() & 0xF,
           unmount: m._wasm_card_unmount_state(), writes: m._wasm_card_writes() };
}, null, "card state");

async function step(name, op, until) {
  const done0 = await card(op);
  const t = Date.now();
  let r;
  do {
    await sleep(500);
    r = await read();
    if (until(r, done0)) {
      console.log(`${name}: ok in ${((Date.now() - t) / 1000).toFixed(1)} s (card ${STATES[r.state]},`
                  + ` ${r.writes} write commands)`);
      return true;
    }
  } while (Date.now() - t < WAIT * 1000);
  console.log(`${name}: FAIL, after ${WAIT} s ${JSON.stringify({ ...r, state: STATES[r.state] })}`);
  errors.push(`${name} did not finish`);
  return false;
}

if (!errors.length) {
  await step("out", "eject", (r, d) => r.done >= d + 1 && r.state === 1);
  await step("in", "insert", (r, d) => r.done >= d + 1 && r.state === 0);
  await step("out+in", "swap", (r, d) => r.done >= d + 2 && r.state === 0);
  let unmounted = false;
  await step("unmount", "unmount", (r) => {
    unmounted = r.unmount === 2;
    return r.unmount >= 2;
  });
  console.log(`unmount: ${unmounted ? "sent to the firmware" : "not possible on this firmware"}`);
  await step("remount", "swap", (r, d) => r.done >= d + 2 && r.state === 0);
}
const s1 = await live().catch((e) => ({ exit: String(e) }));
if (s1.exit) errors.push("firmware exit: " + s1.exit);
await browser.close();
if (!opt("card", "")) fs.rmSync(path.dirname(CARD), { recursive: true, force: true });

if (COSTACK) fs.writeFileSync(COSTACK, costack.join("\n") + "\n");
for (const e of errors) console.log("error:", e);
console.log(errors.length ? "FAIL" : "PASS");
process.exitCode = errors.length ? 1 : 0;
