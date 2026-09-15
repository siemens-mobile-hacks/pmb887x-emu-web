// A Siemens firmware EXIT, end to end: boot an image that crashes and check
// the page does what receiving a crash dump on the serial port should do —
// stop the guest, beep, kill the backlight, fade the pixels out over 30 s
// and leave the parsed dump on the screen.
//
//   node tools/exitcheck.mjs                 # fullflashes/BROKEN)S66_no_recalc.bin
//   node tools/exitcheck.mjs <flash> <board> # any image that EXITs
//   node tools/exitcheck.mjs --inject        # the recorded EL71 dump, written
//                                            # into a healthy guest's log
//
// --inject takes the same path from the page's side (the poll reads MEMFS
// either way) and costs a boot instead of a crash, so it is the check that
// runs without an image that happens to be broken.
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";

const PORT = process.env.PORT || "8080";
// SERIAL_POLL=1 takes the page's fallback path (no FS tap) through the same
// checks — the one thing about it that must keep working is this
const POLL = process.env.SERIAL_POLL === "1";
const URL_ = `http://127.0.0.1:${PORT}/` + (POLL ? "?serialpoll=1" : "");
const INJECT = process.argv.includes("--inject");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FLASH = args[0] ?? new URL("../fullflashes/BROKEN)S66_no_recalc.bin", import.meta.url).pathname;
const DEVICE = args[1] ?? "siemens-s65";
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT || 600) * 1000;

let fails = 0, count = 0;
function ok(name, cond, extra = "") {
  count++;
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
}

// The trace framing the phones print (see serialMessages() in site/app.js):
// FF FE, a big-endian length, that length with its low bit flipped, text.
function frame(msg) {
  const body = [...msg].map((c) => c.charCodeAt(0));
  const n = body.length;
  return [0xff, 0xfe, n >> 8, n & 0xff, (n ^ 1) >> 8, (n ^ 1) & 0xff, ...body];
}
const RECORDED = [
  ">>EXIT<<", "ExitType: Processor Exit", "ExitCode: 0x0206",
  "FILE: Prefetch_Abort!", "At address: 0xA068C7A8",
  "ExitString: Address: 0xA068C7A8", "CepId: 0x430F",
  "CepName: DDL_HANDLER", "CPSR: 0x20000110", "Checksum: 0x0000",
].flatMap(frame);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on("pageerror", (e) => { fails++; console.log("PAGEERROR", String(e).slice(0, 300)); });

// the beep leaves no trace in a headless run; record the oscillator instead
await page.addInitScript(() => {
  const Real = window.AudioContext;
  window.__beeps = [];
  if (!Real) return;
  window.AudioContext = class extends Real {
    createOscillator() {
      const osc = super.createOscillator();
      const start = osc.start.bind(osc), stop = osc.stop.bind(osc);
      osc.start = (t) => { window.__beeps.push({ type: osc.type, freq: osc.frequency.value, start: t }); start(t); };
      osc.stop = (t) => { const b = window.__beeps.at(-1); if (b) b.stop = t; stop(t); };
      return osc;
    }
  };
});

await page.goto(URL_, { waitUntil: "networkidle", timeout: 120000 });
const flash = INJECT ? (await import("./testflash.mjs")).fullflash : FLASH;
const device = INJECT ? null : DEVICE;
await page.click("#ff-mode-own");
await page.setInputFiles("#fullflash", flash);
if (device) await page.selectOption("#device", device);
await page.waitForFunction(() => window.__ui.ready, null, { timeout: 30000 });
console.log(`booting ${flash} as ${await page.evaluate(() => window.__ui.device)}`
  + (INJECT ? " (dump injected once it is up)" : ""));
const t0 = Date.now();
await page.click("#btn-start");

if (INJECT) {
  await page.waitForFunction(() => window.__ui.state === "running", null, { timeout: BOOT_TIMEOUT });
  // let the phone actually draw something first: a dump over a lit screen is
  // the case the fade is for (bounded — plenty of firmware crashes first)
  const lit = await page.waitForFunction(() => {
    const c = document.getElementById("lcd");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
    return n > d.length / 4 / 20;      // 5% of the panel
  }, null, { timeout: Number(process.env.LIT_WAIT || 300) * 1000 })
    .then(() => true).catch(() => false);
  console.log(lit ? "the screen is lit; injecting" : "nothing drawn yet; injecting anyway");
  // appended through the FS, which is exactly where the guest's own writes
  // land — the page's tap sees it as one more thing the phone printed
  await page.evaluate((bytes) => {
    const FS = window.__qemu.FS;
    const at = FS.stat("/serial.log").size;
    const stream = FS.open("/serial.log", "a");
    FS.write(stream, new Uint8Array(bytes), 0, bytes.length, at);
    FS.close(stream);
  }, RECORDED);
}

const seen = await page.waitForFunction(() => window.__ui.exit, null, { timeout: BOOT_TIMEOUT })
  .then(() => true).catch(() => false);
ok(`the dump is received (${Math.round((Date.now() - t0) / 1000)}s)`, seen);
if (!seen) {
  console.log("serial log so far:",
    await page.evaluate(() => document.getElementById("serial").textContent.slice(-400)));
  await browser.close();
  process.exit(1);
}

/* ---- the report ---- */
const report = await page.evaluate(() => window.__ui.exit);
console.log(JSON.stringify(report));
ok(POLL ? "the fallback read the log instead" : "the page was pushed the bytes, not polling for them",
  await page.evaluate(() => window.__ui.serialTap) === !POLL);
ok("it is parsed into fields", Object.keys(report.fields).length >= 3,
  JSON.stringify(report.fields));
// x75 names the kind of exit ("Processor Exit"), x65 only prints the code
ok("there is a headline to put on it", !!(report.type ?? report.code),
  `${report.type} ${report.code}`);

/* ---- the run is over ---- */
const stopped = await page.waitForFunction(() => window.__ui.state === "idle", null, { timeout: 120000 })
  .then(() => true).catch(() => false);
ok("the emulator stopped itself", stopped, await page.evaluate(() => window.__ui.state));

/* ---- the beep ---- */
const beeps = await page.evaluate(() => window.__beeps);
ok("one short beep", beeps.length === 1 && beeps[0].stop - beeps[0].start < 0.2,
  JSON.stringify(beeps));

/* ---- the screen ---- */
const screen = await page.evaluate(() => {
  const c = document.getElementById("lcd");
  return {
    filter: c.style.filter, transition: c.style.transition,
    computed: getComputedStyle(c).filter,
    overlay: !document.getElementById("lcd-overlay").classList.contains("hidden"),
  };
});
ok("the fade runs for 30 s", /filter 30000ms/.test(screen.transition), screen.transition);
ok("it ends at black", screen.filter === "brightness(0)", screen.filter);
const brightness = () => page.evaluate(() =>
  Number((getComputedStyle(document.getElementById("lcd")).filter
    .match(/brightness\(([\d.]+)\)/) ?? [])[1]));
const now = Number((screen.computed.match(/brightness\(([\d.]+)\)/) ?? [])[1]);
ok("the backlight is already off", now > 0 && now <= 0.45, screen.computed);
ok("the 'Ready to boot' overlay does not take the screen", !screen.overlay);

// the transition is running, not just declared: 6 s of a 30 s linear fade
// from 0.45 is 0.09 of it
{
  const before = await brightness();
  await page.waitForTimeout(6000);
  const after = await brightness();
  ok("the pixels are fading while we watch", after < before && Math.abs((before - after) - 0.09) < 0.03,
    `${before} -> ${after}`);
}

/* ---- the panel ---- */
const panel = await page.evaluate(() => {
  const el = document.getElementById("exit-overlay");
  const card = el.querySelector(".exit-card").getBoundingClientRect();
  const wrap = document.querySelector(".lcd-wrap").getBoundingClientRect();
  return {
    hidden: el.hidden,
    badge: el.querySelector(".exit-badge").textContent,
    type: document.getElementById("exit-type").textContent,
    rows: document.querySelectorAll("#exit-fields dt").length,
    text: el.innerText,
    inside: card.top >= wrap.top && card.bottom <= wrap.bottom + 0.5
      && card.left >= wrap.left && card.right <= wrap.right + 0.5,
    leavesScreen: (wrap.bottom - card.bottom) / wrap.height,
  };
});
ok("the dump is on the screen", !panel.hidden && panel.badge === "EXIT" && panel.inside);
ok("a row per field", panel.rows === Object.keys(report.fields).length - 1, // the type is the headline
  `${panel.rows} rows, ${Object.keys(report.fields).length} fields`);
ok("and the dying screen is still visible under it", panel.leavesScreen > 0.2,
  `${Math.round(panel.leavesScreen * 100)}% of the box left`);
ok("the caption says so away from the screen, in its one nowrap line",
  await page.evaluate(() => {
    const el = document.getElementById("status-caption");
    return el.textContent === "Firmware EXIT" && !el.hidden
      && el.scrollWidth <= el.clientWidth + 1;
  }), await page.$eval("#status-caption", (e) => e.textContent));
// x75 opens the dump with ">>EXIT<<", x65 with "EXIT: <code>"
ok("the raw dump is still in the serial log", await page.evaluate((code) => {
  const log = document.getElementById("serial").textContent;
  return /(>>EXIT<<|EXIT: )/.test(log) && (!code || log.includes(code));
}, report.code), await page.evaluate(() => document.getElementById("serial").textContent.slice(-120)));
console.log(panel.text.split("\n").map((l) => "    " + l).join("\n"));

await page.screenshot({ path: "exitcheck.png" });
await page.locator(".lcd-wrap").screenshot({ path: "exitcheck-lcd.png" });

/* ---- and the same thing on the phone layout ---- */
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
ok("it fits the phone layout's screen box too", await page.evaluate(() => {
  const el = document.querySelector(".exit-card");
  const card = el.getBoundingClientRect();
  const wrap = document.querySelector(".lcd-wrap").getBoundingClientRect();
  return card.top >= wrap.top && card.bottom <= wrap.bottom + 0.5
    && card.left >= wrap.left && card.right <= wrap.right + 0.5
    && getComputedStyle(el).fontSize === "11px"
    && el.scrollHeight <= el.clientHeight + 1        // nothing scrolled out of it
    && card.height < wrap.height * 0.75;             // and the screen still shows
}), await page.evaluate(() => {
  const el = document.querySelector(".exit-card");
  const w = document.querySelector(".lcd-wrap").getBoundingClientRect();
  return `card ${Math.round(el.getBoundingClientRect().height)}px of ${Math.round(w.height)}px`
    + `, scroll ${el.scrollHeight}/${el.clientHeight}`;
}));
await page.locator(".lcd-wrap").screenshot({ path: "exitcheck-lcd-phone.png" });
await page.setViewportSize({ width: 1400, height: 950 });
await page.waitForTimeout(300);

/* ---- and a new run clears it ---- */
await page.click("#btn-start");
await page.waitForFunction(() => window.__ui.state !== "idle", null, { timeout: 30000 });
ok("Start clears the dump and lights the screen again", await page.evaluate(() =>
  window.__ui.exit === null && document.getElementById("exit-overlay").hidden
  && !document.getElementById("lcd").style.filter));

console.log(`\n${count - fails}/${count} checks passed`);
await browser.close();
process.exit(fails ? 1 : 0);
