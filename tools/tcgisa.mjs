// Run the phase-0a guest op-suite on a wasm page and print the serial log.
//
//   node tcgisa.mjs [port] [dist] [outfile] [ENV=VAL ...]
//
// The suite *image* always comes from site/dist/tcgisa.bin; the *engine*
// is whichever dist the page is pointed at, so `dist-jit` runs it on the
// wasm64 backend and `dist` on the TCI interpreter.  Both legs of
// scripts/run-tcg-isa.sh use this one driver.
//
// The suite boots -M versatilepb, prints TAP + value dumps into
// /serial.log and then parks: the wasm pthread runtime cannot take the
// semihosting exit path (the page would die before the log could be
// collected), so this polls window.__qemu.FS until the trailing
// "# result:" verdict appears.  window.__suiteReport (installed via
// exposeFunction) is kept as the exit-path bridge should that ever be
// fixed.
//
// Trailing ENV=VAL arguments become ?env= page knobs, and EXTRA_Q appends
// raw page query (e.g. EXTRA_Q=icount=1 — the suite boots without icount
// by default, which is a different wasm64 prologue path).
//
// Exit code: 0 = suite green, 1 = failure/timeout (the log is still
// printed + written to outfile if given).
import { chromium } from "playwright-core";

const port = process.argv[2] || "8080";
const dist = process.argv[3] || "dist-jit";
const outFile = process.argv[4] || null;
const envs = process.argv.slice(5);
// The suite runs in well under a minute per backend; a longer wait only
// means a hang, and a gate that waits ten minutes for one gets skipped.
const timeoutMs = Number(process.env.TCGISA_TIMEOUT || 180) * 1000;

let bridge = null; // { text, code } from the onExit bridge, if it fires

const envQ = envs.map((e) => `&env=${encodeURIComponent(e)}`).join("");
const extraQ = process.env.EXTRA_Q ? "&" + process.env.EXTRA_Q : "";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.exposeFunction("__suiteReport", (text, code) => {
  bridge = { text, code };
});
const qemuLog = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("[qemu]")) qemuLog.push(t);
});
// A RuntimeError or an emscripten abort means no result line is ever
// coming; waiting out the timeout for one only makes a gate slow enough
// to get skipped.
let fatal = null;
page.on("pageerror", (e) => {
  const s = String(e);
  console.error("[pageerror]", s.slice(0, 800));
  if (/RuntimeError|Aborted\(|out of memory/i.test(s)) fatal ??= s.slice(0, 200);
});

await page.goto(`http://127.0.0.1:${port}/?suite=dist/tcgisa.bin&dist=${dist}${envQ}${extraQ}`,
                { waitUntil: "networkidle", timeout: 120000 });

let serial = "";
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  if (bridge) { serial = bridge.text; break; }
  if (fatal) { console.error(`[tcgisa] ${dist}: page died: ${fatal}`); break; }
  try {
    const s = await page.evaluate(() => {
      const m = window.__qemu;
      try {
        return new TextDecoder("latin1").decode(m.FS.readFile("/serial.log"));
      } catch (e) {
        return "";
      }
    });
    serial = s;
    if (/^# result:/m.test(serial)) break; // verdict printed — done
  } catch (e) {
    // page closed mid-run without the bridge: keep whatever we have
    break;
  }
  if (Date.now() - t0 > timeoutMs) {
    console.error(`TIMEOUT after ${timeoutMs / 1000}s`);
    break;
  }
}

process.stdout.write(serial);
if (outFile) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outFile, serial);
}

const result = (serial.match(/^# result: pass=(\d+) fail=(\d+)/m) || [])[0] || null;
const notOk = (serial.match(/^not ok /gm) || []).length;
if (qemuLog.length) {
  console.error(`[tcgisa] qemu stderr tail:\n  ` + qemuLog.slice(-(Number(process.env.TCGISA_TAIL) || 6)).join("\n  "));
}
await browser.close();

if (!result) {
  console.error(`[tcgisa] ${dist}: no suite result line — boot/exit failure?`);
  process.exit(1);
}
if (notOk > 0 || !/fail=0$/.test(result)) {
  console.error(`[tcgisa] ${dist}: SUITE FAILURES: ${result}, ${notOk} 'not ok' lines`);
  process.exit(1);
}
console.error(`[tcgisa] ${dist}: ${result} — green`);
