// Drives the emulator page through its UI acceptance checks: the layout,
// the controls and their states, the HUD, and a real boot. The numbers that
// start the check names (1.1, v4.3, ...) are only names now: the spec they
// were numbered from is gone, and doc/lessons.md cites some of them.
//
//   node tools/ui-acceptance.mjs [--flash id]   # everything, including a real boot
//   SKIP_BOOT=1 node tools/ui-acceptance.mjs
//
// The boot section needs a built site/dist-jit and a Siemens fullflash:
// --flash names one by its tools/lib/boards.mjs id (the gate pins one),
// else the test fullflash (tools/testflash.local.json or TESTFLASH=).
// Everything else is pure UI.
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { pageCall } from "./lib/page.mjs";
import { parseArgs } from "./lib/argv.mjs";
import { flashFiles } from "./lib/boards.mjs";

const FLASH = parseArgs(process.argv.slice(2), {
  values: ["flash"], usage: "node tools/ui-acceptance.mjs [--flash id]",
}).opt("flash", "");

const PORT = process.env.PORT || "8080";
const URL_ = `http://127.0.0.1:${PORT}/`;
// what the page's short user agent starts with on this host's desktop
// Chrome (its reduced user agent says x86_64 on every Linux)
const UA_OS = { linux: "Linux x86_64", darwin: "macOS", win32: "Windows x64" }[process.platform] ?? "[^·]+";

let fails = 0, count = 0;
function ok(name, cond, extra = "") {
  count++;
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1770, height: 1000 } });
page.on("pageerror", (e) => { fails++; console.log("PAGEERROR", String(e).slice(0, 300)); });
// a frozen page ends the run with an error instead of hanging it
const evaluate = (fn, arg) => pageCall(page.evaluate(fn, arg), "evaluate");
const $eval = (sel, fn, arg) => pageCall(page.$eval(sel, fn, arg), `$eval ${sel}`);
const $$eval = (sel, fn, arg) => pageCall(page.$$eval(sel, fn, arg), `$$eval ${sel}`);
const setViewportSize = (size) => pageCall(page.setViewportSize(size), "setViewportSize");
await page.goto(URL_, { waitUntil: "networkidle" });

// A host too slow to keep up, as the page sees one: the guest's workers held
// in the debugger until the returned function lets them go. Throttling the
// page does not do it — the guest runs in pthread workers, which
// Emulation.setCPUThrottlingRate refuses — and nor does a pause/run duty
// cycle: past the banked window the cap repays up to 500 ms of every stall,
// which an idle guest warps through at once, so each run slot is a sample at
// v/wall >= 1 that resets the 3 s hysteresis. Held, the guest reads 0x; the
// stall overlay is 15 s away. One session for the whole run: a second
// auto-attach after a detach gets the workers listed but never answered.
let workerCdp = null;
const workers = new Map();
async function slowHost() {
  if (!workerCdp) {
    workerCdp = await page.context().newCDPSession(page);
    workerCdp.on("Target.attachedToTarget", (e) => {
      if (e.targetInfo.type === "worker") workers.set(e.targetInfo.targetId, e.sessionId);
    });
    workerCdp.on("Target.detachedFromTarget", (e) => workers.delete(e.targetId));
    await workerCdp.send("Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
    await page.waitForTimeout(200);
  }
  let id = 1;
  const all = (...methods) => Promise.all([...workers.values()].flatMap((sessionId) =>
    methods.map((method) => workerCdp.send("Target.sendMessageToTarget",
      { sessionId, message: JSON.stringify({ id: id++, method }) }).catch(() => {}))));
  await all("Debugger.enable", "Debugger.pause");
  return () => all("Debugger.resume", "Debugger.disable");
}

const has = (sel) => $eval("body", (b, s) => !!b.querySelector(s), sel);
const text = (sel) => $eval(sel, (e) => e.textContent.trim()).catch(() => null);
const ui = () => evaluate(() => window.__ui);

// in-page drop of synthesized files — the real DataTransfer path
async function drop(sel, names) {
  await evaluate(({ sel, names }) => {
    const dt = new DataTransfer();
    for (const n of names) dt.items.add(new File([new Uint8Array(32)], n));
    document.querySelector(sel).dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { sel, names });
}

/* ---------------- Firmware panel ---------------- */

ok("1.1 legend is Firmware", (await text("#firmware-panel legend")) === "Firmware");
ok("1.1 no Boot/Fullflash heading", await evaluate(() => {
  const head = [...document.querySelectorAll("legend, h1, h2, h3, .group-title, .sheet-title")];
  return !head.some((e) => /^(boot|fullflash)$/i.test(e.textContent.trim()));
}));

ok("1.2 radiogroup", await evaluate(() => {
  const g = document.querySelector('[role="radiogroup"]');
  return !!g && g.querySelectorAll('[role="radio"]').length === 2;
}));
ok("1.2 default is Preset", await $eval("#ff-mode-preset", (e) => e.getAttribute("aria-checked") === "true"));
ok("1.2 preset mode has no file input", !(await has('#firmware-panel input[type="file"]')));
ok("1.3 preset dropdown present", await has("#ff-preset"));

// order of the preset body
ok("1.3 render order", await evaluate(() => {
  const ids = [...document.querySelector("#ff-preset").parentElement.children].map((e) => e.id || e.className);
  return ids[0] === "ff-preset" && ids[1].includes("ff-status-row")
    && ids[2] === "ff-preset-bar" && ids[3] === "ff-preset-device";
}), await evaluate(() => [...document.querySelector("#ff-preset").parentElement.children].map((e) => e.id || e.className).join(",")));

const st0 = await text("#ff-preset-status");
ok("1.3 status line", /^(Not downloaded · fetches \d+ MiB on Start|✓ Cached · [\d.]+ MiB|Partly downloaded)/.test(st0), st0);
ok("1.3 clear cache hidden when uncached", await $eval("#ff-preset-delete", (e, cached) =>
  e.hidden === !cached, /Cached|Partly/.test(st0)));
ok("1.3 device line", /^Device: [a-z0-9-]+ \(from preset\)$/.test(await text("#ff-preset-device")),
  await text("#ff-preset-device"));
ok("1.3 no trash button", await $eval("#ff-preset-delete", (e) => e.tagName === "BUTTON" && !e.querySelector("svg")));

// selecting another preset updates both lines without a reload
await page.selectOption("#ff-preset", "ke800v11b");
await page.waitForFunction(() => document.getElementById("ff-preset-device").textContent.includes("lg-ke800"));
ok("1.3 preset switch updates device line", (await text("#ff-preset-device")).includes("lg-ke800"));
ok("1.3 preset switch updates status line", (await text("#ff-preset-status")).includes("128 MiB"),
  await text("#ff-preset-status"));
await page.selectOption("#ff-preset", "s75v40lg1");
await page.waitForFunction(() => document.getElementById("ff-preset-device").textContent.includes("siemens-s75"));

// arrow-key navigation
await page.focus("#ff-mode-preset");
await page.keyboard.press("ArrowRight");
ok("1.2 arrow key selects Own file", (await ui()).mode === "own");
ok("1.2 own mode has no preset dropdown", !(await has("#ff-preset")));
ok("1.4 own mode file input", await $eval("#fullflash", (e) => e.accept === ".bin,.cfi-efa" && e.multiple));
ok("1.4 drop zone copy", (await text("#ff-bin-zone")) === "Choose file or drop here");
ok("1.4 device placeholder", await $eval("#device", (e) =>
  e.value === "" && e.selectedOptions[0].disabled && e.selectedOptions[0].textContent === "Select a device"));
ok("1.4 no EFA block for no device", !(await has("#ff-efa-block")));
ok("2.2 Start disabled without firmware", await $eval("#btn-start", (e) => e.disabled));
ok("2.2 caption names what is missing",
  (await text("#status-caption")) === "Choose a file and device to start");

/* multi-file rules (all through the drop path) */
await drop("#ff-bin-slot", ["a.bin", "b.bin"]);
ok("1.5r3 two .bin rejected", !(await has("#ff-bin-chip:not([hidden])"))
  && (await text("#ff-bin-note")) === "Choose one .bin and, optionally, one .cfi-efa.");

await drop("#ff-bin-slot", ["only.cfi-efa"]);
ok("1.5r4 sidecar alone with no .bin rejected",
  (await text("#ff-bin-note")) === "Choose one .bin and, optionally, one .cfi-efa.");

await drop("#ff-bin-slot", ["S75-one.bin", "note.txt", "x.cfi-otp0"]);
ok("1.5r2 one .bin + others", (await $eval("#ff-bin-name", (e) => e.textContent)) === "S75-one.bin"
  && (await text("#ff-bin-note")) === "Ignored 2 other file(s).");
ok("1.4 chip replaced the drop zone", await $eval("#ff-bin-zone", (e) => e.hidden));
ok("1.4/1.5 device inferred from the name", await $eval("#device", (e) => e.value) === "siemens-s75");
ok("1.5 EFA block absent for siemens-s75", !(await has("#ff-efa-block")));

// a sidecar dropped onto a non-LG device: kept, warned about, not sent
await drop("#ff-bin-slot", ["a.cfi-efa"]);
ok("1.5r4 sidecar onto a loaded .bin is kept", (await ui()).ready);
ok("1.5r1 non-LG sidecar warning",
  (await text("#ff-device-note")) === "An EFA sidecar was provided but this device doesn't use one.");

await page.selectOption("#device", "lg-ke800");
ok("1.4.5 EFA block appears for LG", await has("#ff-efa-block"));
ok("1.4.5 remembered sidecar came back", await $eval("#ff-efa-name", (e) => e.textContent) === "a.cfi-efa");
ok("1.4.5 EFA helper text",
  (await text("#ff-efa-block .hint")) === "LG phones keep their EEPROM in the EFA block.");
await drop("#ff-efa-slot", ["wrong.bin"]);
ok("1.5 .bin into the EFA zone rejected", (await text("#ff-efa-note")) === "Expected a .cfi-efa file."
  && (await $eval("#ff-efa-name", (e) => e.textContent)) === "a.cfi-efa");
await page.selectOption("#device", "siemens-s75");
ok("1.4.5 EFA block gone again", !(await has("#ff-efa-block")));

// case-insensitive matching
await drop("#ff-bin-slot", ["KE800.BIN", "KE800.CFI-EFA"]);
ok("1.5 case-insensitive extensions",
  (await $eval("#ff-bin-name", (e) => e.textContent)) === "KE800.BIN"
  && (await $eval("#device", (e) => e.value)) === "lg-ke800");

/* values survive a mode switch */
await page.click("#ff-mode-preset");
await page.click("#ff-mode-own");
ok("1.2 own-file values survived the round trip",
  (await $eval("#ff-bin-name", (e) => e.textContent)) === "KE800.BIN"
  && (await $eval("#device", (e) => e.value)) === "lg-ke800");

/* Advanced ▸ Siemens keys — Own file + a siemens-* device only */
ok("keys block absent for LG", !(await has("#siemens-keys-block")));
await page.selectOption("#device", "siemens-s75");
ok("keys block appears for Siemens", await has("#siemens-keys-block"));
ok("keys default is recalculate",
  (await $eval('input[name="siemens-mode"]:checked', (e) => e.value)) === "recalc");
ok("keys block sits above IMEI/ESN", await $eval(".adv-grid", (g) =>
  [...g.children].map((c) => c.id || c.querySelector("input,select")?.id).join(",")
    === "sim,operator,startup,gsm,siemens-keys-block,imei,esn"));
ok("GSM network is a checkbox, ticked by default",
  await $eval("#gsm", (e) => e.type === "checkbox" && e.checked));
ok("IMEI/ESN editable in recalc mode",
  !(await $eval("#imei", (e) => e.disabled)) && !(await $eval("#esn", (e) => e.disabled)));

await page.check('input[name="siemens-mode"][value="recover-esn"]');
ok("brute-force takes over IMEI/ESN",
  (await $eval("#imei", (e) => e.disabled)) && (await $eval("#esn", (e) => e.disabled))
  && (await text("#siemens-keys-note")) === "IMEI and ESN come from the fullflash in this mode.");
ok("the other Advanced fields stay editable",
  !(await $eval("#operator", (e) => e.disabled)));
ok("the key mode is not named on the Advanced summary",
  !(await text("#adv-summary")).includes("keys"));

// presets are published already recalculated, so the modes are not offered
// there — and the IMEI/ESN lock must not follow the block out of the DOM
await page.click("#ff-mode-preset");
ok("keys block absent in Preset mode", !(await has("#siemens-keys-block")));
ok("IMEI/ESN unlocked again in Preset mode",
  !(await $eval("#imei", (e) => e.disabled)) && !(await $eval("#esn", (e) => e.disabled)));
await page.click("#ff-mode-own");
ok("the mode came back with the block",
  (await $eval('input[name="siemens-mode"]:checked', (e) => e.value)) === "recover-esn");
await page.check('input[name="siemens-mode"][value="recalc"]');

ok("1.6 no Start/Stop inside the panel",
  !(await has("#firmware-panel #btn-start")) && !(await has("#firmware-panel #btn-stop")));
ok("1.6 last child is Advanced",
  await $eval("#firmware-panel", (e) => e.lastElementChild.id === "advanced"));

/* ---------------- status pill ---------------- */
ok("2.1 the action lives in the pill", await has("#status #pill-action #btn-start"));
ok("2.1 capture buttons follow the pill", await evaluate(() => {
  const row = document.querySelector(".status-row");
  return row.children[0].id === "status" && row.children[1].id === "btn-shot"
    && row.children[2].id === "btn-record";
}));
ok("2.2 exactly one action button", await evaluate(() =>
  [...document.querySelectorAll("button")].filter((b) => /^(Start|Stop|Cancel)$/.test(b.textContent.trim())).length === 1));
ok("2.2 idle dot + text", (await text("#status-text")) === "Idle"
  && (await $eval("#status", (e) => e.dataset.state)) === "idle");
ok("2.3 screen placeholder", (await text("#ov-msg")) === "Ready to boot");

/* ---------------- Run panel ---------------- */
ok("3.1 groups", await evaluate(() =>
  [...document.querySelectorAll("#post-panel .group-title")].map((e) => e.textContent).join() === "Accessory,Keyboard,Export"));
ok("3.1 no Run legend", !(await has("#post-panel legend")));
ok("3.1 accessory group contents", await evaluate(() => {
  const g = document.querySelectorAll("#post-panel .group")[0];
  return !!g.querySelector("select#acc-select") && g.querySelectorAll("button").length === 1
    && /^(Connect|Disconnect)$/.test(g.querySelector("#btn-accessory").textContent.trim());
}));
ok("3.1 keyboard group contents", await evaluate(() => {
  const g = document.querySelectorAll("#post-panel .group")[1];
  return !!g.querySelector("#kbd-keyboard") && !!g.querySelector("#kbd-variant")
    && !!g.querySelector("#kbd-hints") && !!g.querySelector("#kbd-typing") && !!g.querySelector("#opt-hud");
}));
ok("3.1 shortcut checkbox copy",
  (await $eval("#kbd-hints", (e) => e.parentElement.textContent.trim())) === "Show shortcuts on keys");
ok("3.1 typing checkbox copy, on by default", await $eval("#kbd-typing", (e) =>
  e.parentElement.textContent.trim() === "Type letters on the phone" && e.checked));
// F5 reloads the page; F6 is still the phone's play key (taken from the browser)
ok("3.1 F5 is the browser's, F6 a phone key", await evaluate(() => {
  const taken = (code) => {
    const e = new KeyboardEvent("keydown", { code, key: code, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    document.body.dispatchEvent(new KeyboardEvent("keyup", { code, key: code, bubbles: true }));
    return e.defaultPrevented;
  };
  return !taken("F5") && taken("F6")
    && !document.querySelector('#keypad [data-key="music"] .key-hint, .aux-keys-left [data-key="music"] .key-hint, .aux-keys-right [data-key="music"] .key-hint');
}));
// multi-tap: a character is the key it is on, pressed as often as the
// firmware cycles to it; on a Russian table each script counts from its own
// input language
ok("3.1 multi-tap tables", await evaluate(async () => {
  const { tapTable } = await import("./keyboards.js");
  const at = (kbd, v, ch) => { const t = tapTable(kbd, v).chars.get(ch); return t && `${t.key}x${t.count}`; };
  return at("s75", "en", "s") === "7x4" && at("s75", "en", " ") === "1x1" && at("s75", "en", "?") === "0x3"
    && at("siemens", "ru", "a") === "2x1" && at("siemens", "ru", "в") === "2x3" && at("siemens", "ru", "ё") === "3x3"
    && at("ke800", "en", " ") === "0x1" && at("ke800", "en", ".") === "1x1"
    && at("ke970", "ru", "z") === "9x4" && tapTable("ke970", "ru").chars.get("я") === undefined;
}));
// a character on no cycle goes through the * picker: Siemens walks its
// circular grid from the "*" it opens on, LG turns pages and presses the
// symbol's key; LG also wakes a phone that has been quiet
ok("3.1 symbol pickers", await evaluate(async () => {
  const { tapTable } = await import("./keyboards.js");
  const keys = (kbd, ch) => tapTable(kbd, "en").chars.get(ch)?.keys?.join();
  return keys("siemens", "$") === "star,right,right,right,right,right,right,center"
    && keys("siemens", "Ω") === "star," + Array(15).fill("left").join() + ",center"
    && keys("s75", "`") === undefined && keys("s75", "§") === "star," + Array(24).fill("right").join() + ",center"
    && keys("ke800", "~") === "star,down,down,7,left_soft"
    && keys("ke800", "}") === "star,up,1,left_soft"
    && tapTable("ke800", "en").wake?.key === "vol_up" && tapTable("s75", "en").wake === undefined;
}));
// capitals: Siemens keeps the case it left the phone in, LG switches back
// after every capital; Backspace is the model's erase key
ok("3.1 capitals and erase", await evaluate(async () => {
  const { tapTable } = await import("./keyboards.js");
  const s75 = tapTable("s75", "en"), ke = tapTable("ke800", "en"), gen = tapTable("siemens", "en");
  return s75.upper.capital.lower.join() === "hash" && s75.upper.small.caps.join() === "hash"
    && ke.upper.before.join() === "hash" && ke.upper.after.join() === "hash,hash,hash"
    && tapTable("ke970", "en").upper.after.length === 7
    && s75.erase === "right_soft" && ke.erase === "clear"
    && gen.erase.pmb8875 === "left_soft" && gen.erase.default === "right_soft";
}));
// tap speed is the phone's own: the generic Siemens keyboard goes by the
// board's chip (PMB8875 quicker than PMB8876, and an unknown one gets the
// slower times)
ok("3.1 tap timing per phone", await evaluate(async () => {
  const { tapTable, forDevice } = await import("./keyboards.js");
  const t = (kbd, dev, cpu) => { const x = forDevice(tapTable(kbd, "en").timing, dev, cpu); return `${x.hold}/${x.gap}/${x.pause}`; };
  return t("siemens", "siemens-sl65", "pmb8875") === "30/30/900" && t("siemens", "siemens-el71", "pmb8876") === "60/40/1100"
    && t("siemens", "siemens-x", null) === "60/40/1100" && t("s75", "siemens-s75", "pmb8876") === "60/40/1100"
    && t("ke800", "lg-ke800") === "30/30/1100" && t("ke970", "lg-ke970") === "30/30/800"
    && forDevice(tapTable("siemens", "en").erase, "siemens-cx70", "pmb8875") === "left_soft";
}));
// ... the chip as the board configs give it, through an include (C75) and
// an extends (S66, on the S65's)
ok("3.1 typing goes by the board's chip", await evaluate(() =>
  ["siemens-c75", "siemens-cx75", "siemens-s66", "siemens-sk65"].every((d) => window.__boardCpu(d) === "pmb8875")
  && ["siemens-s75", "siemens-e71", "siemens-m81"].every((d) => window.__boardCpu(d) === "pmb8876")));
ok("3.1 HUD label has no parenthetical, tooltip instead", await $eval("#opt-hud", (e) =>
  e.parentElement.textContent.trim() === "Performance HUD" && !!e.parentElement.title));
ok("3.1 export buttons", await evaluate(() =>
  [...document.querySelectorAll(".export-row .btn")].map((b) => b.textContent.trim()).join() === "Flash,EFA"
  && document.querySelectorAll(".export-row .btn svg").length === 2));
ok("3.2 exports disabled before any run", await evaluate(() =>
  document.getElementById("btn-save-flash").disabled && document.getElementById("btn-save-efa").disabled
  && !document.getElementById("export-caption").hidden
  && document.getElementById("export-caption").textContent === "Available once running"));
ok("EFA export is only offered for an LG phone", await evaluate(async () => {
  document.getElementById("ff-mode-preset").click(); // the dropdown only
  const sel = document.getElementById("ff-preset");  // exists in preset mode
  const efa = document.getElementById("btn-save-efa");
  const set = async (v) => {
    sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  };
  await set("s75v40lg1");
  const siemensHidden = efa.hidden;
  await set("ke800v11b");
  const lgShown = !efa.hidden;
  await set("s75v40lg1");
  return siemensHidden && lgShown && efa.hidden;
}));

/* every disabled control states its reason within 8px */
ok("6.1 caption sits within 8px of the pill", await evaluate(() => {
  const pill = document.querySelector(".status-row").getBoundingClientRect();
  const cap = document.getElementById("status-caption");
  if (cap.hidden) return true;
  const r = cap.getBoundingClientRect();
  // off the phone layout it is beside the row, not under it
  return r.top - pill.bottom <= 8 && r.left - pill.right <= 8;
}));
// the reason comes and goes with the mode; on desktop it must cost the page
// above the screen nothing at all
ok("6.1 switching modes moves nothing above the screen", await evaluate(async () => {
  const snap = () => {
    const p = document.getElementById("status").getBoundingClientRect();
    return [Math.round(p.left), Math.round(p.top),
      Math.round(document.querySelector(".screen-row").getBoundingClientRect().top)];
  };
  const click = async (id) => {
    document.getElementById(id).click();
    await new Promise((r) => setTimeout(r, 200));
  };
  await click("ff-mode-own");
  await click("ff-bin-clear");        // back to "no file chosen"
  await click("ff-mode-preset");
  const withoutCaption = snap();
  await click("ff-mode-own");
  const withCaption = snap();
  return document.getElementById("status-caption").textContent === "Choose a file and device to start"
    && String(withoutCaption) === String(withCaption);
}));
ok("6.1 export caption within 8px", await evaluate(() => {
  const row = document.querySelector(".export-row").getBoundingClientRect();
  return document.getElementById("export-caption").getBoundingClientRect().top - row.bottom <= 8;
}));
ok("6.2 exactly one filled primary button", await evaluate(() =>
  document.querySelectorAll(".pill-btn.primary").length === 1));

/* ---------------- the performance HUD ---------------- */
ok("v4.1 nothing above the panels carries performance text", await evaluate(() => {
  for (let n = document.querySelector("main").previousElementSibling; n; n = n.previousElementSibling) {
    if (/MIPS|fps|halt|isolated|Mozilla|GB/i.test(n.textContent)) return false;
  }
  return !document.querySelector("body > pre");
}));
// one place at every width: an overlay on the screen box, so turning it on
// costs the column no height and cannot move the keypad
ok("v4.5 the strip is an overlay on the screen box", await evaluate(() => {
  const h = document.getElementById("hud");
  return h.parentElement === document.querySelector(".lcd-wrap")
    && getComputedStyle(h).position === "absolute";
}));
ok("v4.5 hidden until the toggle is on", await $eval("#hud", (e) => e.hidden));
ok("v4.G the strip is aria-hidden", await $eval("#hud", (e) => e.getAttribute("aria-hidden") === "true"));
ok("v4.2 Copy diagnostics is in the Keyboard/Export panel", await evaluate(() =>
  document.querySelector("#post-panel #btn-diag")?.textContent.trim() === "Copy diagnostics"));
ok("v4.2 short user agent: " + await evaluate(() => window.__hud.shortUserAgent()),
  new RegExp(`^${UA_OS} · Chrome \\d+$`).test(await evaluate(() => window.__hud.shortUserAgent())));
ok("v4.2 nothing missing shows up as undefined",
  !/undefined/.test(await evaluate(() => window.__hud.shortUserAgent())));
ok("v4.2 it is built once per page load", await evaluate(() =>
  window.__hud.shortUserAgent() === window.__hud.shortUserAgent()));
ok("v4.2 diagnostics keeps the full user agent and the 10 s averages", await evaluate(() => {
  const d = window.__hud.diagnostics();
  return d.ua === navigator.userAgent && d.uaShort === window.__hud.shortUserAgent()
    && !!d.avg10s && "mips" in d.avg10s && "vratio" in d.avg10s && Array.isArray(d.samples);
}));

const panelTops = () => evaluate(() => [
  Math.round(document.getElementById("pre-panel").getBoundingClientRect().top),
  Math.round(document.getElementById("post-panel").getBoundingClientRect().top)]);
const tops0 = await panelTops();
await page.check("#opt-hud");
await page.waitForTimeout(250);
// the strip waits for a guest to sample — it sits on the screen, and there is
// nothing to put on an idle one — so render it by hand for the shape checks
// that need no guest
await evaluate(() => {
  document.getElementById("hud").hidden = false;
  window.__hud.drawHud();
});
ok("v4.3 exactly two lines, and they are the whole strip", await evaluate(() => {
  const h = document.getElementById("hud");
  const lines = [...h.children].filter((e) => e.classList.contains("hud-line"));
  return lines.length === 2
    && h.getBoundingClientRect().height <= 3 * lines[0].getBoundingClientRect().height;
}));
ok("v4.3 monospace, tabular figures, never wrapped", await evaluate(() =>
  [...document.querySelectorAll(".hud-line")].every((e) => {
    const s = getComputedStyle(e);
    return /mono/i.test(s.fontFamily) && s.fontVariantNumeric.includes("tabular-nums")
      && (s.whiteSpace === "pre" || s.whiteSpace === "nowrap") && s.overflow === "hidden";
  })));
ok("v4.3 line 2 is the environment: " + await text("#hud-env"),
  new RegExp(`^${UA_OS} · Chrome \\d+ · \\d+c( · \\d+ GB)?( · isolated)?$`).test(await text("#hud-env")));
ok("v4.3 no 10 s averages in the strip", !/10s|avg/i.test(await text("#hud")));
ok("v4.5 legible over the screen, muted line 2", await evaluate(() => {
  const bg = getComputedStyle(document.getElementById("hud")).backgroundColor;
  const l1 = getComputedStyle(document.getElementById("hud-metrics")).color;
  const l2 = getComputedStyle(document.getElementById("hud-env")).color;
  return bg === "rgba(0, 0, 0, 0.6)" && l1 !== l2;
}));
ok("v4.5 turning it on does not move the side panels",
  JSON.stringify(await panelTops()) === JSON.stringify(tops0), JSON.stringify([tops0, await panelTops()]));
await page.uncheck("#opt-hud");
await page.waitForTimeout(200);
ok("v4.5 turning it off hides it again", await $eval("#hud", (e) => e.hidden));

/* ---------------- desktop layout ---------------- */
// the tracks stretch: the phone column is the height of the window, and a
// panel taller than that scrolls inside itself rather than growing the row
ok("4 three columns", await evaluate(() => {
  const cs = getComputedStyle(document.querySelector("main"));
  const cols = cs.gridTemplateColumns.split(" ").map(parseFloat);
  return cols.length === 3 && Math.round(cols[0]) === 420 && Math.round(cols[2]) === 420
    && cs.alignItems === "stretch";
}), await evaluate(() => getComputedStyle(document.querySelector("main")).gridTemplateColumns));
ok("4 panels top-align with the pill", await evaluate(() => {
  const t = (s) => Math.round(document.querySelector(s).getBoundingClientRect().top);
  return t("#pre-panel") === t(".status-row") && t("#post-panel") === t(".status-row");
}));
ok("4 the phone column fills the window height", await evaluate(() => {
  const main = document.querySelector("main");
  const cs = getComputedStyle(main);
  const inner = main.getBoundingClientRect().height
    - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const p = document.querySelector(".phone-panel").getBoundingClientRect();
  const kp = document.getElementById("keypad").getBoundingClientRect();
  return Math.abs(p.height - inner) < 1 && Math.abs(kp.bottom - p.bottom) < 1
    && p.bottom <= window.innerHeight + 1;
}), await evaluate(() =>
  `panel ${Math.round(document.querySelector(".phone-panel").getBoundingClientRect().height)}`));
// no zoom, no transform: what is on screen is what was laid out, so a resize
// is a reflow and the browser's own zoom is left to the user
ok("4 nothing in the phone column is scaled after layout", await evaluate(() =>
  [document.querySelector(".phone-panel"), document.getElementById("keypad"),
    document.querySelector(".lcd-wrap")].every((e) => {
    const s = getComputedStyle(e);
    return (s.zoom === "1" || s.zoom === "" || s.zoom === "normal")
      && (s.transform === "none" || s.transform === "");
  })));
ok("4 phone column centred", await evaluate(() => {
  const main = document.querySelector("main").getBoundingClientRect();
  const lcd = document.getElementById("lcd").getBoundingClientRect();
  return Math.abs((lcd.left + lcd.right) / 2 - (main.left + main.right) / 2) < 2;
}));

/* ---------------- phone layout ---------------- */
// back to the default firmware (the S75 preset): the screen-box numbers
// below are for the board the page opens on
await page.click("#ff-mode-preset");
await page.selectOption("#ff-preset", "s75v40lg1");
await setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
ok("5.1 no page scroll", await evaluate(() =>
  document.documentElement.scrollHeight <= window.innerHeight + 1
  && getComputedStyle(document.body).overflow === "hidden"));
ok("5.2 order: row, screen, keypad", await evaluate(() => {
  const t = (s) => document.querySelector(s).getBoundingClientRect().top;
  return t(".status-row") < t(".screen-row") && t(".screen-row") < t("#keypad");
}));
ok("5.2 title bar and panels are out of the view", await evaluate(() =>
  getComputedStyle(document.querySelector("header")).display === "none"
  && document.getElementById("pre-panel").closest(".sheet") !== null
  && document.getElementById("post-panel").closest(".sheet") !== null));

/* ---------------- one control row, 32px (56 on desktop) ---------------- */
ok("v2.1 exactly one row above the screen", await evaluate(() => {
  const top = document.querySelector(".screen-row").getBoundingClientRect().top;
  // every element box that sits entirely above the screen and is not an
  // ancestor of it must belong to the single control row
  const row = document.querySelector(".status-row");
  return [...document.querySelectorAll("main *")].every((e) => {
    const r = e.getBoundingClientRect();
    if (!r.height || r.bottom > top) return true;
    return row.contains(e) || e.contains(row);
  });
}));
// the network badge is drawn at 3/4 here (27.75px), inside the pill
ok("v2.1 row is 32px tall", await $eval(".status-row", (e) =>
  Math.round(e.getBoundingClientRect().height) === 32));
ok("v2.1 pill + five 28px buttons", await evaluate(() => {
  const row = document.querySelector(".status-row");
  const ids = [...row.children].map((e) => e.id);
  const sq = (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return Math.round(r.width) === 28 && Math.round(r.height) === 28;
  };
  // rec-pill sits in the record button's place and is hidden until a
  // capture runs; the speaker and fullscreen
  // follow the recorder
  return ids.join() === "status,btn-shot,btn-record,rec-pill,btn-sound,btn-fullscreen,btn-settings"
    && document.getElementById("rec-pill").hidden
    && !document.getElementById("btn-sound").hidden
    && sq("btn-shot") && sq("btn-record") && sq("btn-sound") && sq("btn-fullscreen") && sq("btn-settings")
    && document.getElementById("btn-settings").getAttribute("aria-label") === "Settings";
}), await evaluate(() => [...document.querySelector(".status-row").children].map((e) => e.id).join()));

/* ---------------- recording, idle ---------------- */
ok("v3.1 camcorder icon, no red circle", await evaluate(() => {
  const b = document.getElementById("btn-record");
  return getComputedStyle(b.querySelector(".rec-cam")).display === "block"
    && getComputedStyle(b.querySelector(".rec-dot")).display === "none";
}));
ok("v3.1 disabled while idle, with the reason in its name", await evaluate(() => {
  const b = document.getElementById("btn-record");
  return b.disabled && b.getAttribute("aria-label") === "Start recording (emulator not running)";
}));
ok("v3.1 nothing in the row is danger-coloured while idle", await evaluate(() => {
  const bad = getComputedStyle(document.documentElement).getPropertyValue("--bad").trim();
  const rgb = (c) => { const d = document.createElement("div"); d.style.color = c; return d.style.color; };
  const target = rgb(bad);
  return [...document.querySelectorAll(".status-row, .status-row *")].every((e) => {
    const cs = getComputedStyle(e);
    if (e.hidden || cs.display === "none") return true;
    return cs.color !== target && cs.borderTopColor !== target
      && !cs.backgroundColor.includes("74, 20, 20");
  });
}));
ok("v2.1 6px dot", await $eval(".status-dot", (e) =>
  Math.round(e.getBoundingClientRect().width) === 6));
// the phone's GPRS indicator lives in the pill and shows only while a run
// has the GSM network
ok("gprs: the indicator is in the pill, hidden with no run", await evaluate(() => {
  const g = document.getElementById("gprs");
  return g?.parentElement?.id === "status" && g.hidden && g.getAttribute("role") === "img"
    && g.getAttribute("aria-label") === "Network off" && window.__ui.gprs.state === "off"
    && window.__ui.gprs.badge === "off" && window.__ui.gsm.known === false;
}));
ok("v2.1 action button is 24px tall and right-aligned in the pill",
  await evaluate(() => {
    const b = document.querySelector("#pill-action button").getBoundingClientRect();
    const pill = document.getElementById("status").getBoundingClientRect();
    return Math.round(b.height) === 24 && pill.right - b.right < 8;
  }));
ok("v2.1 idle pill names the firmware and opens the sheet", await evaluate(() => {
  const t = document.getElementById("status-text").textContent;
  const open = document.getElementById("status-open");
  const cs = getComputedStyle(document.getElementById("status-text"));
  return /(cached|not downloaded|\.bin|No file chosen)/i.test(t) && !open.disabled
    && cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap"
    && getComputedStyle(document.querySelector(".status-chev")).display !== "none";
}), await text("#status-text"));
ok("v2.1 no locked-summary row left", !(await has("#ff-summary")) && !(await has("#phone-bar")));

/* ---------------- thin edge keys ---------------- */
// The tabs are 40px tall with an 8px gap; their width is whatever the
// ratio-locked screen box cannot use, between a 14px floor and a 44px ceiling.
ok("v2.2 edge tabs are 40 tall, 14-44 wide, with an 8px gap", await evaluate(() => {
  const b = [...document.querySelectorAll(".aux-keys-left button")].map((e) => e.getBoundingClientRect());
  const r = [...document.querySelectorAll(".aux-keys-right button")].map((e) => e.getBoundingClientRect());
  if (b.length < 2) return false;
  const w = Math.round(b[0].width);
  return b.every((x) => Math.round(x.height) === 40 && Math.round(x.width) === w)
    && r.every((x) => Math.round(x.width) === w)   // both columns match
    && w >= 14 && w <= 44
    && Math.round(b[1].top - b[0].bottom) === 8;
}), await $eval(".aux-keys-left button", (e) =>
  Math.round(e.getBoundingClientRect().width) + "px wide"));
ok("v2.2 outer-rounded corners", await evaluate(() => {
  const l = getComputedStyle(document.querySelector(".aux-keys-left button"));
  const r = getComputedStyle(document.querySelector(".aux-keys-right button"));
  return l.borderTopLeftRadius === "4px" && l.borderTopRightRadius === "0px"
    && r.borderTopRightRadius === "4px" && r.borderTopLeftRadius === "0px";
}));
ok("v2.2 column 34px below the top of the screen box", await evaluate(() => {
  const k = document.querySelector(".aux-keys-left button").getBoundingClientRect();
  const box = document.querySelector(".lcd-wrap").getBoundingClientRect();
  return Math.round(k.top - box.top) === 34;
}));
// The row is used up: 8px page padding each side, then the box and the tabs
// between them share the rest, so nothing is left blank beside the screen
// unless the tabs have already reached their 44px ceiling.
ok("v2.2 the row's width is spent on the box and the tabs", await evaluate(() => {
  const row = document.querySelector(".screen-row").getBoundingClientRect();
  const box = document.querySelector(".lcd-wrap").getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(document.querySelector("main")).paddingLeft);
  const gap = parseFloat(getComputedStyle(document.querySelector(".screen-row")).columnGap);
  const cols = [...document.querySelectorAll(".aux-keys-left, .aux-keys-right")]
    .filter((c) => c.children.length);
  const tabs = cols.reduce((n, c) => n + c.getBoundingClientRect().width, 0);
  const spare = row.width - box.width - tabs - 2 * gap;
  const tabW = cols.length ? Math.round(cols[0].getBoundingClientRect().width) : 14;
  return pad === 8 && box.width <= row.width - tabs - 2 * gap + 0.5
    && spare >= -0.5 && (spare <= 2.5 || tabW === 44);
}), await evaluate(() => {
  const w = (s) => Math.round(document.querySelector(s).getBoundingClientRect().width);
  return `row ${w(".screen-row")} box ${w(".lcd-wrap")} tab ${w(".aux-keys-left")}`;
}));
ok("v2.2 a tap 20px outside the screen edge hits the key", await evaluate(() => {
  const box = document.querySelector(".lcd-wrap").getBoundingClientRect();
  const key = document.querySelector('.aux-keys-left button[data-key]');
  const el = document.elementFromPoint(Math.max(1, box.left - 20),
    key.getBoundingClientRect().top + 20);
  return el === key || key.contains(el);
}));
ok("v2.2 no shortcut labels on the edge keys", await evaluate(() =>
  [...document.querySelectorAll(".aux-keys-left .key-hint, .aux-keys-right .key-hint")]
    .every((e) => getComputedStyle(e).display === "none")));

/* ---------------- screen box at the device ratio ---------------- */
ok("v2.3 no object-fit letterboxing", await $eval("#lcd", (e) =>
  getComputedStyle(e).objectFit !== "contain"));
// 844 − 12 page padding − 32 control row − 2×6 gaps − the keypad's
// 7×--key-h + 6×6 leaves the row 456 tall, and 3:4 of that is the box
ok("v2.3 box is 342x456 at 390x844", await evaluate(() => {
  const r = document.querySelector(".lcd-wrap").getBoundingClientRect();
  return Math.round(r.width) === 342 && Math.round(r.height) === 456;
}), await evaluate(() => {
  const r = document.querySelector(".lcd-wrap").getBoundingClientRect();
  return `${Math.round(r.width)}x${Math.round(r.height)}`;
}));
ok("v2.3 box takes whichever limit is tighter", await evaluate(() => {
  const box = document.querySelector(".lcd-wrap").getBoundingClientRect();
  const cell = document.querySelector(".screen-cell").getBoundingClientRect();
  const fits = box.width <= cell.width + 0.5 && box.height <= cell.height + 0.5;
  const maxed = Math.abs(box.width - cell.width) < 1.5 || Math.abs(box.height - cell.height) < 1.5;
  return fits && maxed;
}));
ok("v2.3 ratio follows the device", await evaluate(async () => {
  const ar = () => {
    const r = document.querySelector(".lcd-wrap").getBoundingClientRect();
    return r.width / r.height;
  };
  const before = ar();                       // siemens-s75: 132x176
  const sel = document.getElementById("ff-preset");
  sel.value = "ke800v11b";                   // lg-ke800: 240x320 -> same 3:4
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const lg = ar();
  sel.value = "s75v40lg1";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  return Math.abs(before - 0.75) < 0.01 && Math.abs(lg - 0.75) < 0.01
    && Math.abs(ar() - 0.75) < 0.01;
}));
ok("v2.3 canvas fills the box", await evaluate(() => {
  const b = document.querySelector(".lcd-wrap").getBoundingClientRect();
  const c = document.getElementById("lcd").getBoundingClientRect();
  return Math.abs(b.width - c.width) < 1 && Math.abs(b.height - c.height) < 1;
}));

// sheets
await page.click("#status-open");
await page.waitForTimeout(300);
ok("5.4 firmware sheet opens", await $eval("#sheet-firmware", (e) => !e.hidden && e.classList.contains("open")));
ok("5.4 sheet covers at most 90% of the viewport", await evaluate(() =>
  document.getElementById("sheet-firmware").getBoundingClientRect().height <= window.innerHeight * 0.9 + 1));
ok("5.4 handle, title, body, Done", await evaluate(() => {
  const s = document.getElementById("sheet-firmware");
  return !!s.querySelector(".sheet-handle") && s.querySelector(".sheet-title").textContent === "Firmware"
    && getComputedStyle(s.querySelector(".sheet-body")).overflowY === "auto"
    && s.querySelector(".sheet-done").textContent === "Done";
}));
ok("5.4 focus moved into the sheet", await evaluate(() =>
  document.getElementById("sheet-firmware").contains(document.activeElement)));
ok("5.4 no Start/Stop in the sheet", await evaluate(() =>
  !document.getElementById("sheet-firmware").querySelector("#btn-start, #btn-stop")));
// change the preset in the sheet and confirm the summary follows
await page.click("#ff-mode-preset");
await page.selectOption("#ff-preset", "el71v41lg91");
await page.click("#sheet-firmware .sheet-done");
await page.waitForTimeout(300);
ok("5.4 Done closes the sheet", await $eval("#sheet-firmware", (e) => e.hidden));
// the pill names the preset by its short label (fullflashes.js `short`,
// what fits one ellipsised line) and then its cache state, not the file
ok("5.4 pill follows the sheet", (await text("#status-text")).startsWith("EL71v41"),
  await text("#status-text"));
await page.click("#btn-settings");
await page.waitForTimeout(300);
ok("5.4 settings sheet body", await evaluate(() =>
  [...document.querySelectorAll("#sheet-settings .group-title")].map((e) => e.textContent).join() === "Accessory,Keyboard,Export"));
// The toggle once had no effect on a phone and was hidden there; both
// layouts honour it now, so the sheet is where a phone reaches it
ok("v4.4 the HUD toggle is in the mobile settings sheet", await evaluate(() => {
  const c = document.querySelector("#sheet-settings #opt-hud");
  return !!c && getComputedStyle(c.closest("label")).display !== "none";
}));
ok("v4.2 Copy diagnostics is in the mobile settings sheet", await evaluate(() => {
  const b = document.querySelector("#sheet-settings #btn-diag");
  return !!b && getComputedStyle(b).display !== "none";
}));
ok("v4.4 the toggle cannot show it while there is no guest", await evaluate(async () => {
  const c = document.getElementById("opt-hud");
  c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  const still = document.getElementById("hud").hidden;
  c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true }));
  return still;
}));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
ok("5.4 Escape closes", await $eval("#sheet-settings", (e) => e.hidden));

/* ---------------- the keypad always fits ---------------- */
for (const [w, h] of [[320, 568], [320, 490], [360, 640], [360, 560], [390, 844],
  [390, 750], [430, 932], [430, 830]]) {
  await setViewportSize({ width: w, height: h });
  await page.waitForTimeout(250);
  const r = await evaluate(() => {
    const kp = document.getElementById("keypad").getBoundingClientRect();
    const keys = [...document.querySelectorAll("#keypad button[data-key]")]
      .map((e) => e.getBoundingClientRect());
    const box = document.querySelector(".lcd-wrap").getBoundingClientRect();
    const row = document.querySelector(".status-row").getBoundingClientRect();
    return {
      scroll: document.documentElement.scrollHeight, inner: window.innerHeight,
      kpBottom: kp.bottom, kpTop: kp.top,
      clipped: keys.some((k) => k.bottom > window.innerHeight + 0.5 || k.top < row.bottom
        || k.right > window.innerWidth + 0.5 || k.left < -0.5),
      box: [Math.round(box.width), Math.round(box.height)],
      ar: Math.round((box.width / box.height) * 1000) / 1000,
      rowH: Math.round(row.height),
    };
  });
  ok(`v2.4 ${w}x${h}: no scroll, keypad whole, box ${r.box} (${r.ar})`,
    r.scroll <= r.inner + 1 && r.kpBottom <= r.inner + 1 && r.kpTop > 0 && !r.clipped
    && r.box[1] >= 120 && Math.abs(r.ar - 0.75) < 0.01 && r.rowH === 32,
    `scroll=${r.scroll}/${r.inner} kpBottom=${r.kpBottom} clipped=${r.clipped}`);
}

/* ------ the column is correct by construction, not by arithmetic ------ */
// `.screen-row` is `flex: 1; min-height: 0`, so the status row and the keypad
// take their natural heights and the row gets exactly what is left: the box is
// fitted *inside* that and can never push the keypad past the bottom. What
// this pins is that the box stays within its row and the row sits the panel's
// own 6px above the keypad — the failure mode when fitScreen() sizes the box
// from anything other than the flex-resolved row.
for (const [w, h] of [[360, 640], [390, 750], [320, 900]]) {
  await setViewportSize({ width: w, height: h });
  await page.waitForTimeout(300);
  const r = await evaluate(() => {
    const R = (s) => document.querySelector(s).getBoundingClientRect();
    const st = R(".status-block"), row = R(".screen-row"), kp = R("#keypad");
    return {
      gap: Math.round(kp.top - row.bottom),
      above: Math.round(row.top - st.bottom),
      rowH: Math.round(row.height), boxH: Math.round(R(".lcd-wrap").height),
      kpBottom: Math.round(kp.bottom), inner: window.innerHeight,
      tail: Math.round(window.innerHeight - kp.bottom),
    };
  });
  ok(`v5.1 ${w}x${h}: box within its row, 6px to the keypad (tail ${r.tail})`,
    r.gap === 6 && r.above === 6 && r.boxH <= r.rowH && r.kpBottom <= r.inner + 1,
    `gap=${r.gap} above=${r.above} row=${r.rowH} box=${r.boxH} kpBottom=${r.kpBottom}/${r.inner}`);
  // The base rule floors body at `min-height: 100vh`, and min-height beats
  // height. Headless resolves 100vh to innerHeight so the floor is harmless
  // here, but Chrome for Android keeps 100vh at the URL-bar-retracted height:
  // left unreset it floors the column ~80px taller than the viewport and the
  // keypad's last row goes off the bottom. This is the cheap half of that —
  // that nothing floors body above the viewport at all.
  ok(`v5.1 ${w}x${h}: body is not floored above the viewport`, await evaluate(() =>
    (parseFloat(getComputedStyle(document.body).minHeight) || 0) <= window.innerHeight),
    await $eval("body", (e) => "min-height " + getComputedStyle(e).minHeight));
}

await setViewportSize({ width: 1770, height: 1000 });
await page.waitForTimeout(200);
ok("5 panels come back to the columns on desktop", await evaluate(() =>
  document.getElementById("pre-panel").parentElement.tagName === "MAIN"));

/* ---------------- device names, the chip, content detection ---------------- */
await page.click("#ff-mode-own");
await page.waitForTimeout(300);
const devOpts = await $$eval("#device option",
  (o) => o.filter((e) => e.value).map((e) => [e.value, e.textContent]));
const labelOf = (id) => (devOpts.find((o) => o[0] === id) ?? [])[1];
ok("v5.2 device options read as names, values unchanged",
  labelOf("siemens-s75") === "Siemens S75" && labelOf("lg-ke800") === "LG KE800",
  `${labelOf("siemens-s75")} / ${labelOf("lg-ke800")}`);
// upstream's siemens-el71.toml says model = "E71", the same as siemens-e71
ok("v5.2 EL71 and E71 do not collide",
  labelOf("siemens-el71") === "BenQ-Siemens EL71"
  && labelOf("siemens-e71") === "BenQ-Siemens E71",
  `${labelOf("siemens-el71")} vs ${labelOf("siemens-e71")}`);
ok("v5.2 sorted by what is shown",
  devOpts.map((o) => o[1]).every((v, i, a) => i === 0 || a[i - 1].localeCompare(v) <= 0));

// a name that says nothing sends the picker to the image itself; a 32-byte
// stub has nothing to read, so it must come back with no device and no throw
await evaluate(() => { document.getElementById("device").value = ""; });
await drop("#ff-bin-slot", ["dump.bin"]);
await page.waitForTimeout(500);
ok("v5.3 a too-small file is not a detection", await evaluate(() =>
  document.getElementById("device").value === ""),
  await $eval("#device", (e) => e.value));

const fc = page.waitForEvent("filechooser", { timeout: 5000 }).then(() => true, () => false);
await page.click("#ff-bin-pick");
ok("v5.4 the chosen file's name reopens the picker", await fc);

/* ---------------- boot ---------------- */
if (!process.env.SKIP_BOOT) {
  const fullflash = FLASH ? flashFiles(FLASH) : (await import("./testflash.mjs")).files;
  await page.click("#ff-mode-own");
  await page.setInputFiles("#fullflash", fullflash);
  await page.waitForFunction(() => window.__ui.ready);
  ok("2.2 Start enabled once firmware is ready", await $eval("#btn-start", (e) => !e.disabled));
  ok("2.2 no caption when Start is live", await $eval("#status-caption", (e) => e.hidden));
  // every badge the run shows, with the frames the phone had sent by then:
  // the boot must not reach a link state (connected, or dialling at all)
  // unless the phone's own GPRS traffic went out first
  // (counted where the relay takes them from qemu: the frame that dials
  // the link is dropped, so txFrames misses it; a phone sends nothing
  // before it registers, seconds after the counter is in place)
  await evaluate(() => {
    window.__badges = [];
    window.__phoneFrames = 0;
    window.__badgeTimer = setInterval(() => {
      const m = window.__qemu;
      if (m?._wasm_net_take && !m.__counted) {
        const take = m._wasm_net_take;
        m._wasm_net_take = () => { const n = take(); if (n > 0) window.__phoneFrames++; return n; };
        m.__counted = true;
      }
      const g = window.__ui?.gprs;
      // the states the badge checks below set by hand are not the run's
      if (g && !window.__badgeStaged && g.badge !== window.__badges.at(-1)?.badge)
        window.__badges.push({ badge: g.badge, phoneFrames: window.__phoneFrames });
    }, 100);
  });
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__ui.state === "running", null, { timeout: 180000 });

  /* no slow warning while the clock is still banked. It has to run
     here — the guest is seconds into its own clock, so the clock is
     certainly still banked, which it may not be by the time the slow-warning
     section runs. */
  {
    // the phase is published by the 2 Hz HUD sampler, so it reads "off" for
    // up to one tick after the module starts — wait for the first sample
    // rather than racing it
    const banked = await page.waitForFunction(() => window.__ui.bank === "banked",
      null, { timeout: 10000 }).then(() => true).catch(() => false);
    // only a page asked for no bank (bank=0, or a fixed ?icount=) boots
    // unbanked; this tool never asks, so anything else is the regression
    const unbankedAsked = /[?&](bank=0|icount=)/.test(page.url());
    if (!banked && unbankedAsked) {
      console.log(`skip v4.6 banked-phase checks — bank is "${(await ui()).bank}"`
        + " (bank=0, or ?icount=)");
    } else if (!banked) {
      ok("v4.6 the clock is banked during the boot", false, `bank is "${(await ui()).bank}"`);
    } else {
      const recover = await slowHost();
      const under = await page.waitForFunction(
        () => window.__hud.diagnostics().avg10s.vratio < 0.8, null, { timeout: 30000 })
        .then(() => true).catch(() => false);
      await page.waitForTimeout(4000);      // longer than the 3 s hysteresis
      ok("v4.6 no slow warning while the clock is still banked",
        under && await evaluate(() =>
          window.__ui.bank === "banked" && !window.__ui.slow
          && !document.getElementById("status").classList.contains("warn")
          && !/slow/.test(document.getElementById("status-text").textContent)),
        `v/wall ${await evaluate(() => window.__hud.diagnostics().avg10s.vratio)}, `
        + `pill "${await text("#status-text")}"`);
      await recover();
    }
  }

  // the "· slow" suffix rides on the same text whenever the guest has
  // been under 0.80x for three seconds
  ok("2.2 running pill", /^Running · \d+:\d\d( · slow)?$/.test(await text("#status-text")), await text("#status-text"));
  ok("2.2 Stop replaced Start", !(await has("#btn-start")) && (await has("#btn-stop")));
  // the phone has not used GPRS, so no link was dialled: the badge shows
  // what the cell says of the phone (no network, registered or attached),
  // in the dot's place: the antenna for the cell over the bearer tag
  ok("gprs: a GSM run shows the network badge in the dot's place", await evaluate(() => {
    const g = document.getElementById("gprs");
    const r = g.getBoundingClientRect();
    const label = { nonet: "No network", registered: "Registered on the network, GPRS not attached" };
    const gsm = window.__ui.gsm;
    return !g.hidden && ["nonet", "registered", "attached"].includes(g.dataset.state)
      && (g.dataset.state === "attached" || g.getAttribute("aria-label") === label[g.dataset.state])
      && window.__ui.gprs.state === "idle" && window.__ui.gprs.badge === g.dataset.state
      && gsm.known && !window.__gprsNet.ws
      && g.dataset.net === (gsm.registered || gsm.gprsAttached ? "registered" : "nonet")
      && g.dataset.gprs === (g.dataset.state === "attached" ? "attached" : "none")
      && getComputedStyle(document.querySelector(".status-dot")).display === "none"
      && g.nextElementSibling.classList.contains("gsm-slot")
      && Math.round(r.width) === 32 && Math.round(r.height) === 37
      && document.getElementById("gsm-data").hidden;
  }), await evaluate(() => JSON.stringify([window.__ui.gprs, window.__ui.gsm])));

  // The badge through every state of the owner's mockups, set on the run's
  // own GprsNet (the cell's bits through _wasm_gsm_state, the link's fields
  // as the relay keeps them) and drawn by its onChange, as the relay would.
  // Restored afterwards; __badges above does not record these.
  const STAGES = [
    ["nonet", 0, "idle"], ["registered", 1, "idle"], ["attached", 3, "idle"], ["context", 7, "idle"],
    ["connecting", 7, "connecting"], ["reconnecting", 7, "connecting", 1006],
    ["connected", 7, "online"], ["sending", 7, "online", 0, 0, "t"], ["receiving", 7, "online", 0, 0, "r"],
    ["both", 7, "online", 0, 0, "tr"], ["offline", 7, "offline", 1006, 9], ["offline 4029", 7, "offline", 4029, 59],
    ["offline, over", 7, "offline", 1006, 0], ["refused 4003", 7, "offline", 4003, -1],
    ["refused 4004", 7, "offline", 4004, -1], ["refused 4009", 7, "offline", 4009, -1],
    ["connected, cell lost", 0, "online"],
  ];
  await evaluate(() => {
    const g = window.__gprsNet, m = window.__qemu;
    window.__badgeStaged = {
      fields: { ms: g.ms, state: g.state, reason: g.reason, code: g.code, retryAt: g.retryAt,
        bytes: { ...g.bytes }, frames: { ...g.frames } },
      read: m._wasm_gsm_state,
    };
    window.__stagedMs = g.ms;
    m._wasm_gsm_state = () => window.__stagedMs;
    window.__stage = ([, ms, state, code = 0, retry = 0, lit = ""]) => {
      const g = window.__gprsNet;
      window.__stagedMs = g.ms = ms;
      g.code = code;
      g.reason = code ? `reason ${code}` : "";
      g.retryAt = retry < 0 ? Infinity : retry > 0 ? Date.now() + retry * 1000 - 200 : 0;
      g.bytes.out = state === "idle" ? 0 : 3174;
      g.bytes.in = state === "idle" ? 0 : 12698;
      g.state = state;
      g.onChange("gsm");
      if (lit) {
        if (lit.includes("t")) g.frames.out++;
        if (lit.includes("r")) g.frames.in++;
        g.noticed = g.frames.in + g.frames.out;
        g.noticedAt = Date.now();
        g.onChange("traffic");
      }
    };
  });
  // where the uptime starts, and whether anything in the pill spills out
  // of it or over its neighbour
  const pillNow = () => evaluate(() => {
    const t = document.getElementById("status-text").getBoundingClientRect();
    const pill = document.getElementById("status").getBoundingClientRect();
    const parts = [...document.querySelectorAll("#status > *")].filter((e) => e.getBoundingClientRect().width)
      .map((e) => e.getBoundingClientRect());
    const inside = parts.every((r) => r.left >= pill.left && r.right <= pill.right && r.top >= pill.top && r.bottom <= pill.bottom);
    const apart = parts.every((r, i) => i === 0 || r.left >= parts[i - 1].right - 0.5);
    return { x: Math.round(t.left * 10) / 10, y: Math.round(t.top * 10) / 10, inside, apart,
      state: document.getElementById("gprs").dataset.state, net: document.getElementById("gprs").dataset.net,
      gprs: document.getElementById("gprs").dataset.gprs, status: document.getElementById("gsm-status").textContent };
  });
  const uptimeAt = {};
  for (const size of [{ width: 1770, height: 1000 }, { width: 390, height: 844 }]) {
    await setViewportSize(size);
    await page.waitForTimeout(300);
    const seen = [];
    for (const stage of STAGES) {
      await evaluate((st) => window.__stage(st), stage);
      seen.push({ stage: stage[0], ...(await pillNow()) });
    }
    const name = `${size.width}x${size.height}`;
    uptimeAt[name] = seen[0];
    ok(`gprs: ${name}: the uptime does not move in any badge state`,
      seen.every((p) => p.x === seen[0].x && p.y === seen[0].y),
      JSON.stringify(seen.map((p) => `${p.stage} ${p.x},${p.y}`)));
    ok(`gprs: ${name}: the pill's parts stay inside it, side by side`, seen.every((p) => p.inside && p.apart),
      JSON.stringify(seen.filter((p) => !p.inside || !p.apart).map((p) => p.stage)));
    if (size.width === 1770) {
      ok("gprs: the status line names each state", JSON.stringify(seen.map((p) => p.status)) === JSON.stringify([
        "No network", "Registered", "GPRS attached", "GPRS attached · context active", "GPRS connecting…",
        "GPRS reconnecting…", "GPRS Connected", "GPRS Connected", "GPRS Connected", "GPRS Connected",
        "GPRS offline · unreachable · retry 9s", "GPRS offline · too many connections · retry 59s",
        "GPRS offline · waiting for data", "GPRS refused · address banned",
        "GPRS refused · daily traffic used up", "GPRS refused · page not allowed",
        "GPRS Connected · no network"]), JSON.stringify(seen.map((p) => p.status)));
      ok("gprs: the antenna follows the cell, the tag the link", seen.map((p) => `${p.net}/${p.gprs}`).join() === [
        "nonet/none", "registered/none", "registered/attached", "registered/attached",
        "registered/connecting", "registered/connecting", "registered/online", "registered/online",
        "registered/online", "registered/online", "registered/offline", "registered/offline",
        "registered/offline", "registered/refused", "registered/refused", "registered/refused",
        "nonet/online"].join(), seen.map((p) => `${p.net}/${p.gprs}`).join());
    } else {
      // the 32px pill holds the badge at 3/4 inside its border, and the
      // slot's arrows (10x8) at 3/4 too
      await evaluate((st) => window.__stage(st), STAGES.find((s) => s[0] === "connected"));
      const z = await evaluate(() => {
        const box = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height, r.bottom]; };
        const [, pt, , ph, pb] = box(document.getElementById("status"));
        const [, bt, bw, bh, bb] = box(document.getElementById("gprs"));
        const [, , aw, ah] = box(document.querySelector(".gsm-slot .gsm-up"));
        return { pill: ph, badge: [bw, bh], arrow: [aw, ah], inside: bt >= pt + 1 && bb <= pb - 1 };
      });
      ok(`gprs: ${name}: badge 24x27.75 and arrows 7.5x6 inside the 32px pill`,
        z.pill === 32 && z.badge.join() === "24,27.75" && z.arrow.join() === "7.5,6" && z.inside, JSON.stringify(z));
    }
  }
  await setViewportSize({ width: 1770, height: 1000 });
  await page.waitForTimeout(300);
  // the tag's word is drawn, never typeset: system fonts differ
  ok("gprs: the tag's letters are paths, no text and no font", await evaluate(() => {
    const g = document.getElementById("gprs");
    const use = g.querySelector(".gsm-tag-letters");
    const sym = document.querySelector(use.getAttribute("href"));
    const symbols = [...document.querySelectorAll('symbol[id^="gsm-bearer-"]')];
    return g.querySelectorAll("text, tspan, foreignObject").length === 0 && g.textContent.trim() === ""
      && use.tagName === "use" && sym?.tagName === "symbol" && symbols.length >= 2
      && symbols.every((s) => s.children.length === 4 && [...s.children].every((c) => c.tagName === "path")
        && s.textContent.trim() === "");
  }));
  // EDGE in data-bearer: the tag spells it and the status line says it;
  // nothing else changes, not a box nor a name nor a title
  const bearerDiff = await evaluate(() => {
    const g = document.getElementById("gprs");
    const snap = () => ({
      // the letters' own box is their ink, which is the word: the tag's is not
      boxes: [...document.querySelectorAll("#status, #status *:not(.gsm-tag-letters)")].map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10).join();
      }),
      attrs: [g.dataset.state, g.dataset.net, g.dataset.gprs, g.getAttribute("aria-label"), g.title, g.hidden,
        document.getElementById("gsm-status").dataset.tone, document.getElementById("gsm-data").hidden,
        document.getElementById("live-region").textContent],
      status: document.getElementById("gsm-status").textContent,
      letters: g.querySelector(".gsm-tag-letters").getAttribute("href"),
    });
    const results = [];
    for (const stage of [["attached", 3, "idle"], ["connected", 7, "online"], ["offline", 7, "offline", 4002, 30],
      ["refused", 7, "offline", 4003, -1]]) {
      g.dataset.bearer = "GPRS";
      window.__stage(stage);
      const a = snap();
      g.dataset.bearer = "EDGE";
      window.__gprsNet.onChange("gsm");
      const b = snap();
      const diff = [];
      if (a.letters !== "#gsm-bearer-GPRS" || b.letters !== "#gsm-bearer-EDGE") diff.push(`letters ${a.letters} ${b.letters}`);
      if (!a.status.startsWith("GPRS ") || b.status !== a.status.replace(/^GPRS/, "EDGE")) diff.push(`status ${a.status} / ${b.status}`);
      a.boxes.forEach((box, i) => { if (box !== b.boxes[i]) diff.push(`box ${i}: ${box} / ${b.boxes[i]}`); });
      a.attrs.forEach((v, i) => { if (v !== b.attrs[i]) diff.push(`attr ${i}: ${v} / ${b.attrs[i]}`); });
      if (diff.length) results.push(`${stage[0]}: ${diff.join("; ")}`);
    }
    g.dataset.bearer = "GPRS";
    window.__gprsNet.onChange("gsm");
    return results;
  });
  ok("gprs: the bearer EDGE changes only the tag and the wording", bearerDiff.length === 0, bearerDiff.join(" | "));
  // the run's own state back, as the relay and the cell had it
  await evaluate(() => {
    const g = window.__gprsNet, st = window.__badgeStaged;
    window.__qemu._wasm_gsm_state = st.read;
    Object.assign(g, { ...st.fields, bytes: st.fields.bytes, frames: st.fields.frames });
    g.onChange("gsm");
    window.__badgeStaged = null;
  });
  ok("gprs: the badge is back to the run's own state", await evaluate(() =>
    window.__ui.gprs.state === "idle" && ["nonet", "registered", "attached"].includes(window.__ui.gprs.badge)
    && document.getElementById("gsm-data").hidden && !document.getElementById("status").hasAttribute("data-gsm-tx")));
  ok("2.2 exactly one action button", await evaluate(() =>
    [...document.querySelectorAll("button")].filter((b) => /^(Start|Stop|Cancel)$/.test(b.textContent.trim())).length === 1));
  ok("1.7 every firmware control is disabled", await evaluate(() => {
    const all = [...document.querySelectorAll(
      "#firmware-panel input, #firmware-panel select, #firmware-panel button")];
    return all.length > 5 && all.every((e) => e.disabled && e.matches(":disabled"));
  }));
  ok("1.7 nothing in the panel is focusable", await evaluate(() => {
    const f = document.querySelectorAll(
      '#firmware-panel input:not(:disabled), #firmware-panel select:not(:disabled), ' +
      '#firmware-panel button:not(:disabled), #firmware-panel summary:not([tabindex="-1"]), ' +
      '#firmware-panel [tabindex]:not([tabindex="-1"])');
    return f.length === 0;
  }));
  ok("1.7 lock note above Advanced", await evaluate(() => {
    const n = document.getElementById("ff-lock-note");
    return !n.hidden && n.nextElementSibling.id === "advanced"
      && n.textContent.trim() === "Locked while running. Stop to change firmware."
      && !!n.querySelector("svg");
  }), await text("#ff-lock-note"));
  ok("3.2 exports enabled while running", await evaluate(() =>
    !document.getElementById("btn-save-flash").disabled
    && !document.getElementById("btn-save-efa").disabled
    && document.getElementById("export-caption").hidden));

  const t1 = await text("#status-text");
  await page.waitForTimeout(2200);
  ok("2.2 uptime ticks", (await text("#status-text")) !== t1, `${t1} -> ${await text("#status-text")}`);

  /* ---------------- the strip with a live guest ------------- */
  await page.check("#opt-hud");
  await page.waitForTimeout(1600);   // 2 Hz — two samples make the first rate
  ok("v4.3 line 1: speed, MIPS, fps, paint, lag, halts", await evaluate(() =>
    /^\d+\.\d\d× · +\d+\.\d MIPS · +\d+ fps · +\d+ ms · lag +\d+\.\ds · +\d+ halt\/s$/
      .test(document.getElementById("hud-metrics").textContent)), await text("#hud-metrics"));
  ok("v4.3 the speed token is coloured by its value", await evaluate(() => {
    const s = document.querySelector(".hud-speed");
    const v = parseFloat(s.textContent);
    return s.classList.contains(v >= 0.95 ? "good" : v >= 0.8 ? "warn" : "bad");
  }), await text(".hud-speed"));
  ok("v4.3 it updates at 2 Hz, not per frame", await evaluate(async () => {
    let n = 0;
    const o = new MutationObserver(() => n++);
    o.observe(document.getElementById("hud-metrics"), { childList: true, subtree: true, characterData: true });
    await new Promise((r) => setTimeout(r, 3000));
    o.disconnect();
    return n > 0 && n < 3000 / 100;   // ~6 redraws in 3 s, nowhere near 180
  }));
  ok("v4.3 neither line is clipped mid-token", await evaluate(() =>
    [...document.querySelectorAll(".hud-line")]
      .every((e) => e.scrollWidth <= e.clientWidth + 1)));

  /* ---------------- the phone overlay ---------------- */
  await setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  ok("v4.4 the toggle governs the overlay too", await evaluate(async () => {
    const c = document.getElementById("opt-hud");
    const set = async (v) => {
      c.checked = v; c.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return document.getElementById("hud").hidden;
    };
    // left on for the phone overlay below
    const off = await set(false), on = await set(true);
    return off && !on;
  }));
  ok("v4.4 an overlay on the top edge of the screen box", await evaluate(() => {
    const h = document.getElementById("hud"), wrap = document.querySelector(".lcd-wrap");
    const s = getComputedStyle(h);
    const a = h.getBoundingClientRect(), b = wrap.getBoundingClientRect();
    return h.parentElement === wrap && s.position === "absolute"
      && s.pointerEvents === "none" && s.backgroundColor === "rgba(0, 0, 0, 0.6)"
      && s.padding === "3px 6px"
      && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5;
  }), await evaluate(() => {
    const s = getComputedStyle(document.getElementById("hud"));
    return `${s.position} ${s.backgroundColor} ${s.padding} ${s.pointerEvents}`;
  }));
  ok("v4.4 it costs the column no height", await evaluate(() => {
    const h = document.getElementById("hud");
    const geom = () => {
      const b = document.querySelector(".lcd-wrap").getBoundingClientRect();
      const k = document.getElementById("keypad").getBoundingClientRect();
      return [Math.round(b.width), Math.round(b.height), Math.round(k.top), Math.round(k.height)];
    };
    const withStrip = geom();
    h.style.display = "none";           // the same page with it taken out
    const without = geom();
    h.style.display = "";
    return String(withStrip) === String(without) && withStrip[1] > 100;
  }));

  // the strip's fitting rule, at the three widths it is quoted for
  for (const [w, want] of [[390, 6], [360, 5], [320, 4]]) {
    await setViewportSize({ width: w, height: 844 });
    await page.waitForTimeout(700);
    const r = await evaluate(() => {
      const m = document.getElementById("hud-metrics"), e = document.getElementById("hud-env");
      return {
        n: m.textContent.split(" · ").length, t: m.textContent, env: e.textContent,
        box: Math.round(document.querySelector(".lcd-wrap").getBoundingClientRect().width),
        fits: m.scrollWidth <= m.clientWidth + 1 && e.scrollWidth <= e.clientWidth + 1,
        lines: [m, e].map((x) => Math.round(x.getBoundingClientRect().height)),
      };
    });
    ok(`v4.3 ${w}px (box ${r.box}px) keeps ${want} of 6 tokens`,
      r.n === want && r.fits && r.lines[0] === r.lines[1], `${r.n}: "${r.t}"`);
  }
  ok("v4.3 the narrowest line is speed, MIPS, fps, lag", await evaluate(() =>
    /^\d+\.\d\d× · +\d+\.\d MIPS · +\d+ fps · lag +\d+\.\ds$/
      .test(document.getElementById("hud-metrics").textContent)), await text("#hud-metrics"));

  await setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  {
    const wait = page.waitForEvent("download", { timeout: 20000 });
    await page.click("#btn-shot");
    const png = await readFile(await (await wait).path());
    const got = [png.readUInt32BE(16), png.readUInt32BE(20)];
    const want = await evaluate(() => {
      const c = document.getElementById("lcd");
      return [c.width, c.height];
    });
    ok("v4.4 a canvas screenshot has none of the strip in it",
      got[0] === want[0] && got[1] === want[1], `${got} vs ${want}`);
  }

  /* ---------------- the slow warning ---------------- */
  {
    const speed = () => evaluate(() => window.__hud.diagnostics().avg10s.vratio);

    // the warning itself, which only applies once the bank is over
    // (the boot section covers the banked half). Waiting on the
    // phase rather than a timeout is what makes this deterministic — under an
    // explicit ?bank=0 it resolves at once.
    await page.waitForFunction(() => window.__ui.bank !== "banked", null,
      { timeout: 180000 });
    const recover = await slowHost();
    const slow = await page.waitForFunction(() => window.__ui.slow, null, { timeout: 30000 })
      .then(() => true).catch(() => false);
    ok("v4.6 under 0.80x for 3 s turns the pill amber", slow && await evaluate(() =>
      document.getElementById("status").classList.contains("warn")
      && / · slow$/.test(document.getElementById("status-text").textContent)),
      `v/wall ${await speed()}, pill "${await text("#status-text")}"`);
    await recover();
    const back = await page.waitForFunction(() => !window.__ui.slow, null, { timeout: 40000 })
      .then(() => true).catch(() => false);
    ok("v4.6 and back to green once it recovers", back && await evaluate(() =>
      !document.getElementById("status").classList.contains("warn")
      && !/slow/.test(document.getElementById("status-text").textContent)),
      `v/wall ${await speed()}, pill "${await text("#status-text")}"`);
  }
  await setViewportSize({ width: 1770, height: 1000 });
  await page.waitForTimeout(400);

  /* ---------------- recording, on the phone row ---------- */
  await setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const geom = () => evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return {
      row: Math.round(r(".status-row").height),
      box: [Math.round(r(".lcd-wrap").width), Math.round(r(".lcd-wrap").height)],
      keypad: Math.round(r("#keypad").top),
    };
  });
  const before = await geom();
  ok("v3.1 enabled while running", await evaluate(() => {
    const b = document.getElementById("btn-record");
    return !b.disabled && b.getAttribute("aria-label") === "Start recording";
  }));
  await page.click("#btn-record");
  await page.waitForTimeout(1500);

  ok("v3.2 the pill took the button's place", await evaluate(() => {
    const row = [...document.querySelector(".status-row").children]
      .filter((e) => !e.hidden).map((e) => e.id);
    return row.join() === "status,btn-shot,rec-pill,btn-settings"
      && getComputedStyle(document.getElementById("rec-pill")).flexGrow === "0";
  }), await evaluate(() => [...document.querySelector(".status-row").children].filter((e) => !e.hidden).map((e) => e.id).join()));
  ok("v3.2 elapsed counter and a Finish button", await evaluate(() => {
    const f = document.getElementById("btn-rec-finish");
    return /^\d+:\d\d$/.test(document.getElementById("rec-pill-time").textContent)
      && f.textContent.trim() === "Finish"
      && f.getAttribute("aria-label") === "Finish recording"
      && Math.round(f.getBoundingClientRect().height) === 24;
  }));
  ok("v3.2 two pills, different colours", await evaluate(() => {
    const s = getComputedStyle(document.getElementById("status")).backgroundColor;
    const r = getComputedStyle(document.getElementById("rec-pill")).backgroundColor;
    return s !== r && s.includes("20, 83, 45") && r.includes("74, 20, 20");
  }));
  ok("v3.5 exactly one Stop and one Finish in the visible row", await evaluate(() => {
    const words = [];
    for (const e of document.querySelectorAll(".status-row button")) {
      if (e.hidden || e.closest("[hidden]")) continue;
      const s = `${e.textContent} ${e.getAttribute("aria-label") ?? ""} ${e.title ?? ""}`;
      if (/\bstop\b/i.test(s)) words.push("stop");
      if (/\bfinish\b/i.test(s)) words.push("finish");
    }
    return words.filter((w) => w === "stop").length === 1
      && words.filter((w) => w === "finish").length === 1;
  }));
  ok("v3.3 status pill drops the Running prefix",
    /^\d+:\d\d( · slow)?$/.test(await text("#status-text")), await text("#status-text"));
  ok("v3.3 Stop is still there and still says Stop",
    (await $eval("#btn-stop", (e) => e.textContent.trim())) === "Stop");
  ok("v3.5 start was announced", (await text("#live-region")) === "Recording started");
  const during = await geom();
  ok("v3.4 no layout shift while recording",
    during.row === 32 && before.row === 32
    && during.box[0] === before.box[0] && during.box[1] === before.box[1]
    && during.keypad === before.keypad,
    JSON.stringify({ before, during }));
  ok("v3.4 screenshot stays enabled", await $eval("#btn-shot", (e) => !e.disabled));

  // verify: both pills plus the two icon buttons on one row at 320px
  await setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(400);
  ok("v3.3 everything fits one row at 320px", await evaluate(() => {
    const row = document.querySelector(".status-row").getBoundingClientRect();
    const kids = [...document.querySelector(".status-row").children].filter((e) => !e.hidden);
    return Math.round(row.height) === 32
      && kids.every((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= row.top - 0.5 && r.bottom <= row.bottom + 0.5
          && r.left >= row.left - 0.5 && r.right <= row.right + 0.5;
      })
      // the uptime is still legible: not ellipsised away
      && document.getElementById("status-text").scrollWidth
         <= document.getElementById("status-text").clientWidth + 1;
  }), await evaluate(() => {
    const t = document.getElementById("status-text");
    return `text ${Math.round(t.getBoundingClientRect().width)}px "${t.textContent}"`;
  }));
  await setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);

  await page.click("#btn-rec-finish");
  await page.waitForTimeout(1200);
  ok("v3.2 idle button restored in the same place", await evaluate(() => {
    const row = [...document.querySelector(".status-row").children]
      .filter((e) => !e.hidden).map((e) => e.id);
    const b = document.getElementById("btn-record");
    // the speaker and fullscreen are back too: they stand down only while
    // a capture runs
    return row.join() === "status,btn-shot,btn-record,btn-sound,btn-fullscreen,btn-settings"
      && b.getAttribute("aria-label") === "Start recording"
      && Math.round(b.getBoundingClientRect().width) === 28;
  }));
  ok("v3.5 save was announced", (await text("#live-region")) === "Recording saved");
  ok("v3.3 the Running prefix comes back",
    /^Running · \d+:\d\d( · slow)?$/.test(await text("#status-text")), await text("#status-text"));
  await setViewportSize({ width: 1770, height: 1000 });
  await page.waitForTimeout(300);

  await page.click("#btn-stop");
  await page.waitForFunction(() => window.__ui.state === "idle", null, { timeout: 60000 });
  ok("1.7 controls come back with their values", await evaluate(() =>
    !document.getElementById("firmware-panel").disabled
    && document.getElementById("ff-lock-note").hidden
    && !!document.getElementById("ff-bin-name").textContent));
  ok("2.2 Start is back", await has("#btn-start"));
  // the image the run left behind is still readable, so the exports stay
  ok("exports stay available after Stop", await evaluate(() =>
    !document.getElementById("btn-save-flash").disabled
    && document.getElementById("export-caption").hidden));
  ok("the stopped run's flash is still readable", await evaluate(() =>
    !!window.__qemu?.FS?.analyzePath("/data/fullflash.bin")?.exists));
  ok("EFA export stays hidden for the siemens run", await $eval("#btn-save-efa", (e) => e.hidden));
  ok("gprs: hidden again after Stop", await evaluate(() =>
    document.getElementById("gprs").hidden && window.__ui.gprs.state === "off"));
  // the boot regression: the badge went to "connected" during boot with no
  // GPRS frame from the phone (doc/gsm-network.md, "The badge")
  ok("gprs: the run reached no link state without the phone's GPRS traffic", await evaluate(() => {
    clearInterval(window.__badgeTimer);
    return window.__badges.length > 1 && window.__badges.every(({ badge, phoneFrames }) =>
      ["off", "nonet", "registered", "attached", "idle"].includes(badge) || phoneFrames > 0);
  }), await evaluate(() => JSON.stringify(window.__badges)));

  // the same image with the GSM network unticked: no indicator, the dot back
  await evaluate(() => {
    document.getElementById("advanced").open = true;
    document.getElementById("gsm").checked = false;
  });
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__ui.state === "running", null, { timeout: 180000 });
  ok("gprs: a run without the GSM network shows no indicator", await evaluate(() =>
    document.getElementById("gprs").hidden && window.__ui.gprs.state === "off" && !window.__gprsNet
    && getComputedStyle(document.querySelector(".status-dot")).display !== "none"));
  // the dot keeps the badge's place, so the uptime starts where it does
  // with the badge, in both layouts
  for (const size of [{ width: 1770, height: 1000 }, { width: 390, height: 844 }]) {
    await setViewportSize(size);
    await page.waitForTimeout(300);
    const name = `${size.width}x${size.height}`;
    const x = await evaluate(() => Math.round(document.getElementById("status-text").getBoundingClientRect().left * 10) / 10);
    ok(`gprs: ${name}: without the badge the uptime starts where it does with it`, x === uptimeAt[name].x,
      `${x} vs ${uptimeAt[name].x}`);
  }
  await setViewportSize({ width: 1770, height: 1000 });
  await page.waitForTimeout(300);
  await page.click("#btn-stop");
  await page.waitForFunction(() => window.__ui.state === "idle", null, { timeout: 60000 });
  await evaluate(() => { document.getElementById("gsm").checked = true; });
}

console.log(`\n${count - fails}/${count} checks passed`);
await browser.close();
process.exit(fails ? 1 : 0);
