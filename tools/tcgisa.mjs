// Run the phase-0a guest op-suite on the wasm TCI page and print the
// serial log (doc/wasm-tcg-backend-plan.md). The page is loaded with
// ?suite=dist/tcgisa.bin; the suite boots -M versatilepb, prints TAP +
// value dumps into /serial.log and then parks (the wasm pthread runtime
// cannot take the semihosting exit path — the page would die before the
// log could be collected), so this polls window.__qemu.FS until the
// trailing "# result:" verdict appears. window.__suiteReport (installed
// via exposeFunction) is kept as the exit-path bridge should that ever be
// fixed.
//
//   node tcgisa.mjs [port] [outfile]
//
// Exit code: 0 = suite green, 1 = failure/timeout (the log is still
// printed + written to outfile if given).
import { chromium } from "playwright-core";

const port = process.argv[2] || "8080";
const outFile = process.argv[3] || null;
const timeoutMs = 10 * 60 * 1000;

let bridge = null; // { text, code } from the onExit bridge, if it fires

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
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 500)));

await page.goto(`http://127.0.0.1:${port}/?suite=dist/tcgisa.bin`,
                { waitUntil: "networkidle", timeout: 120000 });

let serial = "";
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  if (bridge) { serial = bridge.text; break; }
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
  console.error(`[tcgisa] qemu stderr tail:\n  ` + qemuLog.slice(-6).join("\n  "));
}
await browser.close();

if (!result) {
  console.error("[tcgisa] no suite result line — boot/exit failure?");
  process.exit(1);
}
if (notOk > 0 || !/fail=0$/.test(result)) {
  console.error(`[tcgisa] SUITE FAILURES: ${result}, ${notOk} 'not ok' lines`);
  process.exit(1);
}
console.error(`[tcgisa] ${result} — wasm TCI leg green`);
