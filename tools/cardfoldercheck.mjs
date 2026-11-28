// Memory card folder check: a folder as the card (doc/sd-card.md), with the
// folder picker answered by an origin-private folder (OPFS) the check fills.
//
//   node tools/cardfoldercheck.mjs [--dist dist] [--flash <id|image>]
//       [--boot 90] [--wait 120] [--port P (default $PORT, else 8080)]
//
// After --boot seconds a file is added to the folder, as an editor would, and
// "Sync card" is pressed: the card must hold the new file and the phone must
// read it again (state "in") within --wait seconds.
// PASS = that, no firmware exit, no abort and no page error.
import { chromium } from "playwright-core";
import fs from "node:fs";
import { parseArgs } from "./lib/argv.mjs";
import { FULLFLASHES, flashFiles, withSidecar } from "./lib/boards.mjs";
import { bootOwnFlash, pageCall } from "./lib/page.mjs";

const { opt } = parseArgs(process.argv.slice(2), {
  values: ["dist", "flash", "boot", "wait", "port"],
  usage: "node tools/cardfoldercheck.mjs [--dist d] [--flash id|image] [--boot s] [--wait s] [--port P]",
});
const DIST = opt("dist", "dist");
const PORT = opt("port", process.env.PORT || "8080");
const BOOT = Number(opt("boot", 90));
const WAIT = Number(opt("wait", 120));
const flashOpt = opt("flash", "");
const flash = flashOpt in FULLFLASHES ? flashFiles(flashOpt)
  : withSidecar(flashOpt || (await import("./testflash.mjs")).fullflash);
for (const f of flash) if (!fs.existsSync(f)) throw new Error(`fullflash not found: ${f}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("crash", () => errors.push("page crashed"));
page.on("console", (m) => {
  const t = m.text();
  if (/Aborted\(|Assertion failed|RuntimeError/.test(t)) errors.push(t.slice(0, 200));
  if (/Card sync failed/.test(t)) errors.push(t.slice(0, 200));
  if (process.env.VERBOSE || /\[card\]/.test(t)) console.log("  page:", t.slice(0, 400));
});
await page.goto(`http://127.0.0.1:${PORT}/?dist=${DIST}`, { waitUntil: "domcontentloaded" });

const call = (fn, arg, what) => pageCall(page.evaluate(fn, arg), what);
// the folder: an OPFS directory with one file, handed out by the picker
await call(async () => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("cardfolder", { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle("cardfolder", { create: true });
  const w = await (await dir.getFileHandle("before.txt", { create: true })).createWritable();
  await w.write("on the card from the start");
  await w.close();
  window.showDirectoryPicker = async () => dir;
  window.__cardFolder = dir;
}, null, "folder");
await call(() => document.getElementById("card-folder").click(), null, "pick folder");
await bootOwnFlash(page, flash);

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

// the card's files, read in the page with the page's own FAT reader
const cardFiles = () => call(async () => {
  const { readImage } = await import("/sdcard.js");
  return readImage(window.__qemu.FS.readFile("/data/card.img")).map((e) => e.path);
}, null, "card files");
const cardText = () => call(() => document.getElementById("card-state").textContent, null, "card state");

if (!errors.length) {
  console.log("card at boot:", (await cardFiles()).join(", "));
  await call(async () => {
    const w = await (await window.__cardFolder.getFileHandle("added.txt", { create: true })).createWritable();
    await w.write("added while the phone ran");
    await w.close();
  }, null, "add file");

  await call(() => document.getElementById("btn-sync-card").click(), null, "Sync card");
  const t = Date.now();
  let files = [], st = "";
  do {
    await sleep(1000);
    files = await cardFiles();
    st = await cardText();
  } while ((!files.some((p) => /^added\.txt$/i.test(p)) || !/^Card: in\b/.test(st))
           && Date.now() - t < WAIT * 1000);
  const ok = files.some((p) => /^added\.txt$/i.test(p)) && /^Card: in\b/.test(st);
  console.log(`sync: ${ok ? "ok" : "FAIL"} in ${((Date.now() - t) / 1000).toFixed(1)} s (${st}; card: ${files.join(", ")})`);
  if (!ok) errors.push("the new file did not reach the phone");
}
const s1 = await live().catch((e) => ({ exit: String(e) }));
if (s1.exit) errors.push("firmware exit: " + s1.exit);
await browser.close();
for (const e of errors) console.log("error:", e);
console.log(errors.length ? "FAIL" : "PASS");
process.exitCode = errors.length ? 1 : 0;
