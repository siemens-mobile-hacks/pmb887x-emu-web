// Drives the emulator page through mocks/emulator-ui-acceptance-criteria.md.
//
//   node tools/ui-acceptance.mjs            # everything, including a real boot
//   SKIP_BOOT=1 node tools/ui-acceptance.mjs
//
// The boot section needs a fullflash (tools/testflash.local.json or
// TESTFLASH=) and a built site/dist-jit; everything else is pure UI.
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";

const PORT = process.env.PORT || "8080";
const URL_ = `http://127.0.0.1:${PORT}/`;

let fails = 0, count = 0;
function ok(name, cond, extra = "") {
  count++;
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1770, height: 1000 } });
page.on("pageerror", (e) => { fails++; console.log("PAGEERROR", String(e).slice(0, 300)); });
await page.goto(URL_, { waitUntil: "networkidle" });

const has = (sel) => page.$eval("body", (b, s) => !!b.querySelector(s), sel);
const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
const ui = () => page.evaluate(() => window.__ui);

// in-page drop of synthesized files — the real DataTransfer path
async function drop(sel, names) {
  await page.evaluate(({ sel, names }) => {
    const dt = new DataTransfer();
    for (const n of names) dt.items.add(new File([new Uint8Array(32)], n));
    document.querySelector(sel).dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { sel, names });
}

/* ---------------- §1 Firmware panel ---------------- */

ok("1.1 legend is Firmware", (await text("#firmware-panel legend")) === "Firmware");
ok("1.1 no Boot/Fullflash heading", await page.evaluate(() => {
  const head = [...document.querySelectorAll("legend, h1, h2, h3, .group-title, .sheet-title")];
  return !head.some((e) => /^(boot|fullflash)$/i.test(e.textContent.trim()));
}));

ok("1.2 radiogroup", await page.evaluate(() => {
  const g = document.querySelector('[role="radiogroup"]');
  return !!g && g.querySelectorAll('[role="radio"]').length === 2;
}));
ok("1.2 default is Preset", await page.$eval("#ff-mode-preset", (e) => e.getAttribute("aria-checked") === "true"));
ok("1.2 preset mode has no file input", !(await has('#firmware-panel input[type="file"]')));
ok("1.3 preset dropdown present", await has("#ff-preset"));

// order of the preset body (§1.3)
ok("1.3 render order", await page.evaluate(() => {
  const ids = [...document.querySelector("#ff-preset").parentElement.children].map((e) => e.id || e.className);
  return ids[0] === "ff-preset" && ids[1].includes("ff-status-row")
    && ids[2] === "ff-preset-bar" && ids[3] === "ff-preset-device";
}), await page.evaluate(() => [...document.querySelector("#ff-preset").parentElement.children].map((e) => e.id || e.className).join(",")));

const st0 = await text("#ff-preset-status");
ok("1.3 status line", /^(Not downloaded · fetches \d+ MiB on Start|✓ Cached · [\d.]+ MiB|Partly downloaded)/.test(st0), st0);
ok("1.3 clear cache hidden when uncached", await page.$eval("#ff-preset-delete", (e, cached) =>
  e.hidden === !cached, /Cached|Partly/.test(st0)));
ok("1.3 device line", /^Device: [a-z0-9-]+ \(from preset\)$/.test(await text("#ff-preset-device")),
  await text("#ff-preset-device"));
ok("1.3 no trash button", await page.$eval("#ff-preset-delete", (e) => e.tagName === "BUTTON" && !e.querySelector("svg")));

// selecting another preset updates both lines without a reload
await page.selectOption("#ff-preset", "ke800v11b");
await page.waitForFunction(() => document.getElementById("ff-preset-device").textContent.includes("lg-ke800"));
ok("1.3 preset switch updates device line", (await text("#ff-preset-device")).includes("lg-ke800"));
ok("1.3 preset switch updates status line", (await text("#ff-preset-status")).includes("128 MiB"),
  await text("#ff-preset-status"));
await page.selectOption("#ff-preset", "s75v40lg1");
await page.waitForFunction(() => document.getElementById("ff-preset-device").textContent.includes("siemens-s75"));

// §1.2 arrow-key navigation
await page.focus("#ff-mode-preset");
await page.keyboard.press("ArrowRight");
ok("1.2 arrow key selects Own file", (await ui()).mode === "own");
ok("1.2 own mode has no preset dropdown", !(await has("#ff-preset")));
ok("1.4 own mode file input", await page.$eval("#fullflash", (e) => e.accept === ".bin,.cfi-efa" && e.multiple));
ok("1.4 drop zone copy", (await text("#ff-bin-zone")) === "Choose file or drop here");
ok("1.4 device placeholder", await page.$eval("#device", (e) =>
  e.value === "" && e.selectedOptions[0].disabled && e.selectedOptions[0].textContent === "Select a device"));
ok("1.4 no EFA block for no device", !(await has("#ff-efa-block")));
ok("2.2 Start disabled without firmware", await page.$eval("#btn-start", (e) => e.disabled));
ok("2.2 caption names what is missing",
  (await text("#status-caption")) === "Choose a file and device to start");

/* §1.5 multi-file rules (all through the drop path) */
await drop("#ff-bin-slot", ["a.bin", "b.bin"]);
ok("1.5r3 two .bin rejected", !(await has("#ff-bin-chip:not([hidden])"))
  && (await text("#ff-bin-note")) === "Choose one .bin and, optionally, one .cfi-efa.");

await drop("#ff-bin-slot", ["only.cfi-efa"]);
ok("1.5r4 sidecar alone with no .bin rejected",
  (await text("#ff-bin-note")) === "Choose one .bin and, optionally, one .cfi-efa.");

await drop("#ff-bin-slot", ["S75-one.bin", "note.txt", "x.cfi-otp0"]);
ok("1.5r2 one .bin + others", (await page.$eval("#ff-bin-name", (e) => e.textContent)) === "S75-one.bin"
  && (await text("#ff-bin-note")) === "Ignored 2 other file(s).");
ok("1.4 chip replaced the drop zone", await page.$eval("#ff-bin-zone", (e) => e.hidden));
ok("1.4/1.5 device inferred from the name", await page.$eval("#device", (e) => e.value) === "siemens-s75");
ok("1.5 EFA block absent for siemens-s75", !(await has("#ff-efa-block")));

// a sidecar dropped onto a non-LG device: kept, warned about, not sent
await drop("#ff-bin-slot", ["a.cfi-efa"]);
ok("1.5r4 sidecar onto a loaded .bin is kept", (await ui()).ready);
ok("1.5r1 non-LG sidecar warning",
  (await text("#ff-device-note")) === "An EFA sidecar was provided but this device doesn't use one.");

await page.selectOption("#device", "lg-ke800");
ok("1.4.5 EFA block appears for LG", await has("#ff-efa-block"));
ok("1.4.5 remembered sidecar came back", await page.$eval("#ff-efa-name", (e) => e.textContent) === "a.cfi-efa");
ok("1.4.5 EFA helper text",
  (await text("#ff-efa-block .hint")) === "LG phones keep their EEPROM in the EFA block.");
await drop("#ff-efa-slot", ["wrong.bin"]);
ok("1.5 .bin into the EFA zone rejected", (await text("#ff-efa-note")) === "Expected a .cfi-efa file."
  && (await page.$eval("#ff-efa-name", (e) => e.textContent)) === "a.cfi-efa");
await page.selectOption("#device", "siemens-s75");
ok("1.4.5 EFA block gone again", !(await has("#ff-efa-block")));

// case-insensitive matching
await drop("#ff-bin-slot", ["KE800.BIN", "KE800.CFI-EFA"]);
ok("1.5 case-insensitive extensions",
  (await page.$eval("#ff-bin-name", (e) => e.textContent)) === "KE800.BIN"
  && (await page.$eval("#device", (e) => e.value)) === "lg-ke800");

/* §1.2 values survive a mode switch */
await page.click("#ff-mode-preset");
await page.click("#ff-mode-own");
ok("1.2 own-file values survived the round trip",
  (await page.$eval("#ff-bin-name", (e) => e.textContent)) === "KE800.BIN"
  && (await page.$eval("#device", (e) => e.value)) === "lg-ke800");

/* Advanced ▸ Siemens keys — Own file + a siemens-* device only */
ok("keys block absent for LG", !(await has("#siemens-keys-block")));
await page.selectOption("#device", "siemens-s75");
ok("keys block appears for Siemens", await has("#siemens-keys-block"));
ok("keys default is recalculate",
  (await page.$eval('input[name="siemens-mode"]:checked', (e) => e.value)) === "recalc");
ok("keys block sits above IMEI/ESN", await page.$eval(".adv-grid", (g) =>
  [...g.children].map((c) => c.id || c.querySelector("input,select")?.id).join(",")
    === "sim,operator,startup,siemens-keys-block,imei,esn"));
ok("IMEI/ESN editable in recalc mode",
  !(await page.$eval("#imei", (e) => e.disabled)) && !(await page.$eval("#esn", (e) => e.disabled)));

await page.check('input[name="siemens-mode"][value="recover-esn"]');
ok("brute-force takes over IMEI/ESN",
  (await page.$eval("#imei", (e) => e.disabled)) && (await page.$eval("#esn", (e) => e.disabled))
  && (await text("#siemens-keys-note")) === "IMEI and ESN come from the fullflash in this mode.");
ok("the other Advanced fields stay editable",
  !(await page.$eval("#operator", (e) => e.disabled)));
ok("the key mode is not named on the Advanced summary",
  !(await text("#adv-summary")).includes("keys"));

// presets are published already recalculated, so the modes are not offered
// there — and the IMEI/ESN lock must not follow the block out of the DOM
await page.click("#ff-mode-preset");
ok("keys block absent in Preset mode", !(await has("#siemens-keys-block")));
ok("IMEI/ESN unlocked again in Preset mode",
  !(await page.$eval("#imei", (e) => e.disabled)) && !(await page.$eval("#esn", (e) => e.disabled)));
await page.click("#ff-mode-own");
ok("the mode came back with the block",
  (await page.$eval('input[name="siemens-mode"]:checked', (e) => e.value)) === "recover-esn");
await page.check('input[name="siemens-mode"][value="recalc"]');

/* §1.6 */
ok("1.6 no Start/Stop inside the panel",
  !(await has("#firmware-panel #btn-start")) && !(await has("#firmware-panel #btn-stop")));
ok("1.6 last child is Advanced",
  await page.$eval("#firmware-panel", (e) => e.lastElementChild.id === "advanced"));

/* ---------------- §2 status pill ---------------- */
ok("2.1 the action lives in the pill", await has("#status #pill-action #btn-start"));
ok("2.1 capture buttons follow the pill", await page.evaluate(() => {
  const row = document.querySelector(".status-row");
  return row.children[0].id === "status" && row.children[1].id === "btn-shot"
    && row.children[2].id === "btn-record";
}));
ok("2.2 exactly one action button", await page.evaluate(() =>
  [...document.querySelectorAll("button")].filter((b) => /^(Start|Stop|Cancel)$/.test(b.textContent.trim())).length === 1));
ok("2.2 idle dot + text", (await text("#status-text")) === "Idle"
  && (await page.$eval("#status", (e) => e.dataset.state)) === "idle");
ok("2.3 screen placeholder", (await text("#ov-msg")) === "Ready to boot");

/* ---------------- §3 Run panel ---------------- */
ok("3.1 groups", await page.evaluate(() =>
  [...document.querySelectorAll("#post-panel .group-title")].map((e) => e.textContent).join() === "Keyboard,Export"));
ok("3.1 no Run legend", !(await has("#post-panel legend")));
ok("3.1 keyboard group contents", await page.evaluate(() => {
  const g = document.querySelectorAll("#post-panel .group")[0];
  return !!g.querySelector("#kbd-keyboard") && !!g.querySelector("#kbd-variant")
    && !!g.querySelector("#kbd-hints") && !!g.querySelector("#opt-hud");
}));
ok("3.1 shortcut checkbox copy",
  (await page.$eval("#kbd-hints", (e) => e.parentElement.textContent.trim())) === "Show shortcuts on keys");
ok("3.1 HUD label has no parenthetical, tooltip instead", await page.$eval("#opt-hud", (e) =>
  e.parentElement.textContent.trim() === "Performance HUD" && !!e.parentElement.title));
ok("3.1 export buttons", await page.evaluate(() =>
  [...document.querySelectorAll(".export-row .btn")].map((b) => b.textContent.trim()).join() === "Flash,EFA"
  && document.querySelectorAll(".export-row .btn svg").length === 2));
ok("3.2 exports disabled before any run", await page.evaluate(() =>
  document.getElementById("btn-save-flash").disabled && document.getElementById("btn-save-efa").disabled
  && !document.getElementById("export-caption").hidden
  && document.getElementById("export-caption").textContent === "Available once running"));
ok("EFA export is only offered for an LG phone", await page.evaluate(async () => {
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

/* §6.1 every disabled control states its reason within 8px */
ok("6.1 caption sits within 8px of the pill", await page.evaluate(() => {
  const pill = document.querySelector(".status-row").getBoundingClientRect();
  const cap = document.getElementById("status-caption");
  if (cap.hidden) return true;
  const r = cap.getBoundingClientRect();
  // off the phone layout it is beside the row, not under it
  return r.top - pill.bottom <= 8 && r.left - pill.right <= 8;
}));
// the reason comes and goes with the mode; on desktop it must cost the page
// above the screen nothing at all
ok("6.1 switching modes moves nothing above the screen", await page.evaluate(async () => {
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
ok("6.1 export caption within 8px", await page.evaluate(() => {
  const row = document.querySelector(".export-row").getBoundingClientRect();
  return document.getElementById("export-caption").getBoundingClientRect().top - row.bottom <= 8;
}));
ok("6.2 exactly one filled primary button", await page.evaluate(() =>
  document.querySelectorAll(".pill-btn.primary").length === 1));

/* ---------------- v4 §1/§2/§3/§5: the performance HUD ---------------- */
ok("v4.1 nothing above the panels carries performance text", await page.evaluate(() => {
  for (let n = document.querySelector("main").previousElementSibling; n; n = n.previousElementSibling) {
    if (/MIPS|fps|halt|isolated|Mozilla|GB/i.test(n.textContent)) return false;
  }
  return !document.querySelector("body > pre");
}));
ok("v4.5 the strip sits under the pill, above the screen", await page.evaluate(() => {
  const h = document.getElementById("hud");
  return h.parentElement === document.querySelector(".status-block")
    && h.previousElementSibling.id === "status-caption"
    && (h.compareDocumentPosition(document.querySelector(".screen-row"))
        & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}));
ok("v4.5 hidden until the toggle is on", await page.$eval("#hud", (e) => e.hidden));
ok("v4.G the strip is aria-hidden", await page.$eval("#hud", (e) => e.getAttribute("aria-hidden") === "true"));
ok("v4.2 Copy diagnostics is in the Keyboard/Export panel", await page.evaluate(() =>
  document.querySelector("#post-panel #btn-diag")?.textContent.trim() === "Copy diagnostics"));
ok("v4.2 short user agent: " + await page.evaluate(() => window.__hud.shortUserAgent()),
  /^Linux x86_64 · Chrome \d+$/.test(await page.evaluate(() => window.__hud.shortUserAgent())));
ok("v4.2 nothing missing shows up as undefined",
  !/undefined/.test(await page.evaluate(() => window.__hud.shortUserAgent())));
ok("v4.2 it is built once per page load", await page.evaluate(() =>
  window.__hud.shortUserAgent() === window.__hud.shortUserAgent()));
ok("v4.2 diagnostics keeps the full user agent and the 10 s averages", await page.evaluate(() => {
  const d = window.__hud.diagnostics();
  return d.ua === navigator.userAgent && d.uaShort === window.__hud.shortUserAgent()
    && !!d.avg10s && "mips" in d.avg10s && "vratio" in d.avg10s && Array.isArray(d.samples);
}));

const panelTops = () => page.evaluate(() => [
  Math.round(document.getElementById("pre-panel").getBoundingClientRect().top),
  Math.round(document.getElementById("post-panel").getBoundingClientRect().top)]);
const tops0 = await panelTops();
await page.check("#opt-hud");
await page.waitForTimeout(250);
ok("v4.3 exactly two lines, and they are the whole strip", await page.evaluate(() => {
  const h = document.getElementById("hud");
  const lines = [...h.children].filter((e) => e.classList.contains("hud-line"));
  return lines.length === 2 && !h.hidden
    && h.getBoundingClientRect().height <= 3 * lines[0].getBoundingClientRect().height;
}));
ok("v4.3 monospace, tabular figures, never wrapped", await page.evaluate(() =>
  [...document.querySelectorAll(".hud-line")].every((e) => {
    const s = getComputedStyle(e);
    return /mono/i.test(s.fontFamily) && s.fontVariantNumeric.includes("tabular-nums")
      && (s.whiteSpace === "pre" || s.whiteSpace === "nowrap") && s.overflow === "hidden";
  })));
ok("v4.3 line 2 is the environment: " + await text("#hud-env"),
  /^Linux x86_64 · Chrome \d+ · \d+c( · \d+ GB)?( · isolated)?$/.test(await text("#hud-env")));
ok("v4.3 no 10 s averages in the strip", !/10s|avg/i.test(await text("#hud")));
ok("v4.5 no background, muted line 2", await page.evaluate(() => {
  const bg = getComputedStyle(document.getElementById("hud")).backgroundColor;
  const l1 = getComputedStyle(document.getElementById("hud-metrics")).color;
  const l2 = getComputedStyle(document.getElementById("hud-env")).color;
  return /rgba\(0, 0, 0, 0\)|transparent/.test(bg) && l1 !== l2;
}));
ok("v4.5 turning it on does not move the side panels",
  JSON.stringify(await panelTops()) === JSON.stringify(tops0), JSON.stringify([tops0, await panelTops()]));
await page.uncheck("#opt-hud");
await page.waitForTimeout(200);
ok("v4.5 turning it off hides it again", await page.$eval("#hud", (e) => e.hidden));

/* ---------------- §4 desktop layout ---------------- */
ok("4 three columns", await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector("main"));
  const cols = cs.gridTemplateColumns.split(" ").map(parseFloat);
  return cols.length === 3 && Math.round(cols[0]) === 420 && Math.round(cols[2]) === 420
    && cs.alignItems === "start";
}), await page.evaluate(() => getComputedStyle(document.querySelector("main")).gridTemplateColumns));
ok("4 panels top-align with the pill", await page.evaluate(() => {
  const t = (s) => Math.round(document.querySelector(s).getBoundingClientRect().top);
  return t("#pre-panel") === t(".status-row") && t("#post-panel") === t(".status-row");
}));
ok("4 phone column centred", await page.evaluate(() => {
  const main = document.querySelector("main").getBoundingClientRect();
  const lcd = document.getElementById("lcd").getBoundingClientRect();
  return Math.abs((lcd.left + lcd.right) / 2 - (main.left + main.right) / 2) < 2;
}));

/* ---------------- §5 phone layout ---------------- */
// back to the default firmware (the S75 preset): the numbers in v2 §3 are
// quoted for the board the page opens on
await page.click("#ff-mode-preset");
await page.selectOption("#ff-preset", "s75v40lg1");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
ok("5.1 no page scroll", await page.evaluate(() =>
  document.documentElement.scrollHeight <= window.innerHeight + 1
  && getComputedStyle(document.body).overflow === "hidden"));
ok("5.2 order: row, screen, keypad", await page.evaluate(() => {
  const t = (s) => document.querySelector(s).getBoundingClientRect().top;
  return t(".status-row") < t(".screen-row") && t(".screen-row") < t("#keypad");
}));
ok("5.2 title bar and panels are out of the view", await page.evaluate(() =>
  getComputedStyle(document.querySelector("header")).display === "none"
  && document.getElementById("pre-panel").closest(".sheet") !== null
  && document.getElementById("post-panel").closest(".sheet") !== null));

/* ---------------- v2 §1: one 32px control row ---------------- */
ok("v2.1 exactly one row above the screen", await page.evaluate(() => {
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
ok("v2.1 row is 32px tall", await page.$eval(".status-row", (e) =>
  Math.round(e.getBoundingClientRect().height) === 32));
ok("v2.1 pill + four 28px buttons", await page.evaluate(() => {
  const row = document.querySelector(".status-row");
  const ids = [...row.children].map((e) => e.id);
  const sq = (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return Math.round(r.width) === 28 && Math.round(r.height) === 28;
  };
  // rec-pill sits in the record button's place and is hidden until a
  // capture runs (recording criteria §2); fullscreen follows the recorder
  return ids.join() === "status,btn-shot,btn-record,rec-pill,btn-fullscreen,btn-settings"
    && document.getElementById("rec-pill").hidden
    && sq("btn-shot") && sq("btn-record") && sq("btn-fullscreen") && sq("btn-settings")
    && document.getElementById("btn-settings").getAttribute("aria-label") === "Settings";
}), await page.evaluate(() => [...document.querySelector(".status-row").children].map((e) => e.id).join()));

/* ---------------- recording criteria §1 (idle) ---------------- */
ok("v3.1 camcorder icon, no red circle", await page.evaluate(() => {
  const b = document.getElementById("btn-record");
  return getComputedStyle(b.querySelector(".rec-cam")).display === "block"
    && getComputedStyle(b.querySelector(".rec-dot")).display === "none";
}));
ok("v3.1 disabled while idle, with the reason in its name", await page.evaluate(() => {
  const b = document.getElementById("btn-record");
  return b.disabled && b.getAttribute("aria-label") === "Start recording (emulator not running)";
}));
ok("v3.1 nothing in the row is danger-coloured while idle", await page.evaluate(() => {
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
ok("v2.1 6px dot", await page.$eval(".status-dot", (e) =>
  Math.round(e.getBoundingClientRect().width) === 6));
ok("v2.1 action button is 24px tall and right-aligned in the pill",
  await page.evaluate(() => {
    const b = document.querySelector("#pill-action button").getBoundingClientRect();
    const pill = document.getElementById("status").getBoundingClientRect();
    return Math.round(b.height) === 24 && pill.right - b.right < 8;
  }));
ok("v2.1 idle pill names the firmware and opens the sheet", await page.evaluate(() => {
  const t = document.getElementById("status-text").textContent;
  const open = document.getElementById("status-open");
  const cs = getComputedStyle(document.getElementById("status-text"));
  return /(cached|not downloaded|\.bin|No file chosen)/i.test(t) && !open.disabled
    && cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap"
    && getComputedStyle(document.querySelector(".status-chev")).display !== "none";
}), await text("#status-text"));
ok("v2.1 no locked-summary row left", !(await has("#ff-summary")) && !(await has("#phone-bar")));

/* ---------------- v2 §2: thin edge keys ---------------- */
ok("v2.2 edge tabs are 14x40 with an 8px gap", await page.evaluate(() => {
  const col = document.querySelector(".aux-keys-left");
  const b = [...col.querySelectorAll("button")].map((e) => e.getBoundingClientRect());
  if (b.length < 2) return false;
  return b.every((r) => Math.round(r.width) === 14 && Math.round(r.height) === 40)
    && Math.round(b[1].top - b[0].bottom) === 8;
}));
ok("v2.2 outer-rounded corners", await page.evaluate(() => {
  const l = getComputedStyle(document.querySelector(".aux-keys-left button"));
  const r = getComputedStyle(document.querySelector(".aux-keys-right button"));
  return l.borderTopLeftRadius === "4px" && l.borderTopRightRadius === "0px"
    && r.borderTopRightRadius === "4px" && r.borderTopLeftRadius === "0px";
}));
ok("v2.2 column 34px below the top of the screen box", await page.evaluate(() => {
  const k = document.querySelector(".aux-keys-left button").getBoundingClientRect();
  const box = document.querySelector(".lcd-wrap").getBoundingClientRect();
  return Math.round(k.top - box.top) === 34;
}));
ok("v2.2 non-screen width is 48px", await page.evaluate(() => {
  const row = document.querySelector(".screen-row").getBoundingClientRect();
  const box = document.querySelector(".lcd-wrap").getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(document.querySelector("main")).paddingLeft);
  // 2x8 page padding + 2x14 tabs + 2x2 gaps
  return pad === 8 && Math.round(row.width + 2 * pad - (row.width - 2 * (14 + 2))) === 48
    && box.width <= row.width - 2 * (14 + 2) + 0.5;
}));
ok("v2.2 a tap 20px outside the screen edge hits the key", await page.evaluate(() => {
  const box = document.querySelector(".lcd-wrap").getBoundingClientRect();
  const key = document.querySelector('.aux-keys-left button[data-key]');
  const el = document.elementFromPoint(Math.max(1, box.left - 20),
    key.getBoundingClientRect().top + 20);
  return el === key || key.contains(el);
}));
ok("v2.2 no shortcut labels on the edge keys", await page.evaluate(() =>
  [...document.querySelectorAll(".aux-keys-left .key-hint, .aux-keys-right .key-hint")]
    .every((e) => getComputedStyle(e).display === "none")));

/* ---------------- v2 §3: screen box at the device ratio ---------------- */
ok("v2.3 no object-fit letterboxing", await page.$eval("#lcd", (e) =>
  getComputedStyle(e).objectFit !== "contain"));
ok("v2.3 box is 342x456 at 390x844", await page.evaluate(() => {
  const r = document.querySelector(".lcd-wrap").getBoundingClientRect();
  return Math.round(r.width) === 342 && Math.round(r.height) === 456;
}), await page.evaluate(() => {
  const r = document.querySelector(".lcd-wrap").getBoundingClientRect();
  return `${Math.round(r.width)}x${Math.round(r.height)}`;
}));
ok("v2.3 box takes whichever limit is tighter", await page.evaluate(() => {
  const box = document.querySelector(".lcd-wrap").getBoundingClientRect();
  const cell = document.querySelector(".screen-cell").getBoundingClientRect();
  const fits = box.width <= cell.width + 0.5 && box.height <= cell.height + 0.5;
  const maxed = Math.abs(box.width - cell.width) < 1.5 || Math.abs(box.height - cell.height) < 1.5;
  return fits && maxed;
}));
ok("v2.3 ratio follows the device", await page.evaluate(async () => {
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
ok("v2.3 canvas fills the box", await page.evaluate(() => {
  const b = document.querySelector(".lcd-wrap").getBoundingClientRect();
  const c = document.getElementById("lcd").getBoundingClientRect();
  return Math.abs(b.width - c.width) < 1 && Math.abs(b.height - c.height) < 1;
}));

// §5.4 sheets
await page.click("#status-open");
await page.waitForTimeout(300);
ok("5.4 firmware sheet opens", await page.$eval("#sheet-firmware", (e) => !e.hidden && e.classList.contains("open")));
ok("5.4 sheet covers at most 90% of the viewport", await page.evaluate(() =>
  document.getElementById("sheet-firmware").getBoundingClientRect().height <= window.innerHeight * 0.9 + 1));
ok("5.4 handle, title, body, Done", await page.evaluate(() => {
  const s = document.getElementById("sheet-firmware");
  return !!s.querySelector(".sheet-handle") && s.querySelector(".sheet-title").textContent === "Firmware"
    && getComputedStyle(s.querySelector(".sheet-body")).overflowY === "auto"
    && s.querySelector(".sheet-done").textContent === "Done";
}));
ok("5.4 focus moved into the sheet", await page.evaluate(() =>
  document.getElementById("sheet-firmware").contains(document.activeElement)));
ok("5.4 no Start/Stop in the sheet", await page.evaluate(() =>
  !document.getElementById("sheet-firmware").querySelector("#btn-start, #btn-stop")));
// change the preset in the sheet and confirm the summary follows
await page.click("#ff-mode-preset");
await page.selectOption("#ff-preset", "el71v41lg91");
await page.click("#sheet-firmware .sheet-done");
await page.waitForTimeout(300);
ok("5.4 Done closes the sheet", await page.$eval("#sheet-firmware", (e) => e.hidden));
ok("5.4 pill follows the sheet", (await text("#status-text")).startsWith("EL71 v41 lg91"),
  await text("#status-text"));
await page.click("#btn-settings");
await page.waitForTimeout(300);
ok("5.4 settings sheet body", await page.evaluate(() =>
  [...document.querySelectorAll("#sheet-settings .group-title")].map((e) => e.textContent).join() === "Keyboard,Export"));
// v4 §4 said the toggle had no effect on a phone and hid it there; both
// layouts honour it now, so the sheet is where a phone reaches it
ok("v4.4 the HUD toggle is in the mobile settings sheet", await page.evaluate(() => {
  const c = document.querySelector("#sheet-settings #opt-hud");
  return !!c && getComputedStyle(c.closest("label")).display !== "none";
}));
ok("v4.2 Copy diagnostics is in the mobile settings sheet", await page.evaluate(() => {
  const b = document.querySelector("#sheet-settings #btn-diag");
  return !!b && getComputedStyle(b).display !== "none";
}));
ok("v4.4 the toggle cannot show it while there is no guest", await page.evaluate(async () => {
  const c = document.getElementById("opt-hud");
  c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  const still = document.getElementById("hud").hidden;
  c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true }));
  return still;
}));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
ok("5.4 Escape closes", await page.$eval("#sheet-settings", (e) => e.hidden));

/* ---------------- v2 §4: the keypad always fits ---------------- */
for (const [w, h] of [[320, 568], [320, 490], [360, 640], [360, 560], [390, 844],
  [390, 750], [430, 932], [430, 830]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
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
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
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
  ok(`v5.1 ${w}x${h}: body is not floored above the viewport`, await page.evaluate(() =>
    (parseFloat(getComputedStyle(document.body).minHeight) || 0) <= window.innerHeight),
    await page.$eval("body", (e) => "min-height " + getComputedStyle(e).minHeight));
}

await page.setViewportSize({ width: 1770, height: 1000 });
await page.waitForTimeout(200);
ok("5 panels come back to the columns on desktop", await page.evaluate(() =>
  document.getElementById("pre-panel").parentElement.tagName === "MAIN"));

/* ---------------- device names, the chip, content detection ---------------- */
await page.click("#ff-mode-own");
await page.waitForTimeout(300);
const devOpts = await page.$$eval("#device option",
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
await page.evaluate(() => { document.getElementById("device").value = ""; });
await drop("#ff-bin-slot", ["dump.bin"]);
await page.waitForTimeout(500);
ok("v5.3 a too-small file is not a detection", await page.evaluate(() =>
  document.getElementById("device").value === ""),
  await page.$eval("#device", (e) => e.value));

const fc = page.waitForEvent("filechooser", { timeout: 5000 }).then(() => true, () => false);
await page.click("#ff-bin-pick");
ok("v5.4 the chosen file's name reopens the picker", await fc);

/* ---------------- boot: §1.7, §2.2 running, §3.2 ---------------- */
if (!process.env.SKIP_BOOT) {
  const { fullflash } = await import("./testflash.mjs");
  await page.click("#ff-mode-own");
  await page.setInputFiles("#fullflash", fullflash);
  await page.waitForFunction(() => window.__ui.ready);
  ok("2.2 Start enabled once firmware is ready", await page.$eval("#btn-start", (e) => !e.disabled));
  ok("2.2 no caption when Start is live", await page.$eval("#status-caption", (e) => e.hidden));
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__ui.state === "running", null, { timeout: 180000 });

  /* v4 §6a: no slow warning while the real-time cap is still banking. It has
     to run here — the guest is seconds into its own clock, so the cap is
     certainly still banked, which it may not be by the time §6b runs. */
  {
    // the phase is published by the 2 Hz HUD sampler, so it reads "off" for
    // up to one tick after the module starts — wait for the first sample
    // rather than racing it
    const banked = await page.waitForFunction(() => window.__ui.rtcap === "banked",
      null, { timeout: 10000 }).then(() => true).catch(() => false);
    if (!banked) {
      console.log(`skip v4.6 banked-phase checks — cap is "${(await ui()).rtcap}"`
        + " (rt=off, or a board that runs without icount)");
    } else {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
      const under = await page.waitForFunction(
        () => window.__hud.diagnostics().avg10s.vratio < 0.8, null, { timeout: 30000 })
        .then(() => true).catch(() => false);
      await page.waitForTimeout(4000);      // longer than the 3 s hysteresis
      ok("v4.6 no slow warning while the cap is still banking",
        under && await page.evaluate(() =>
          window.__ui.rtcap === "banked" && !window.__ui.slow
          && !document.getElementById("status").classList.contains("warn")
          && !/slow/.test(document.getElementById("status-text").textContent)),
        `v/wall ${await page.evaluate(() => window.__hud.diagnostics().avg10s.vratio)}, `
        + `pill "${await text("#status-text")}"`);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach();
    }
  }

  // the v4 §6 "· slow" suffix rides on the same text whenever the guest has
  // been under 0.80x for three seconds
  ok("2.2 running pill", /^Running · \d+:\d\d( · slow)?$/.test(await text("#status-text")), await text("#status-text"));
  ok("2.2 Stop replaced Start", !(await has("#btn-start")) && (await has("#btn-stop")));
  ok("2.2 exactly one action button", await page.evaluate(() =>
    [...document.querySelectorAll("button")].filter((b) => /^(Start|Stop|Cancel)$/.test(b.textContent.trim())).length === 1));
  ok("1.7 every firmware control is disabled", await page.evaluate(() => {
    const all = [...document.querySelectorAll(
      "#firmware-panel input, #firmware-panel select, #firmware-panel button")];
    return all.length > 5 && all.every((e) => e.disabled && e.matches(":disabled"));
  }));
  ok("1.7 nothing in the panel is focusable", await page.evaluate(() => {
    const f = document.querySelectorAll(
      '#firmware-panel input:not(:disabled), #firmware-panel select:not(:disabled), ' +
      '#firmware-panel button:not(:disabled), #firmware-panel summary:not([tabindex="-1"]), ' +
      '#firmware-panel [tabindex]:not([tabindex="-1"])');
    return f.length === 0;
  }));
  ok("1.7 lock note above Advanced", await page.evaluate(() => {
    const n = document.getElementById("ff-lock-note");
    return !n.hidden && n.nextElementSibling.id === "advanced"
      && n.textContent.trim() === "Locked while running. Stop to change firmware."
      && !!n.querySelector("svg");
  }), await text("#ff-lock-note"));
  ok("3.2 exports enabled while running", await page.evaluate(() =>
    !document.getElementById("btn-save-flash").disabled
    && !document.getElementById("btn-save-efa").disabled
    && document.getElementById("export-caption").hidden));

  const t1 = await text("#status-text");
  await page.waitForTimeout(2200);
  ok("2.2 uptime ticks", (await text("#status-text")) !== t1, `${t1} -> ${await text("#status-text")}`);

  /* ---------------- v4 §3/§5: the strip with a live guest ------------- */
  await page.check("#opt-hud");
  await page.waitForTimeout(1600);   // 2 Hz — two samples make the first rate
  ok("v4.3 line 1: speed, MIPS, fps, paint, lag, halts", await page.evaluate(() =>
    /^\d+\.\d\d× · +\d+\.\d MIPS · +\d+ fps · +\d+ ms · lag +\d+\.\ds · +\d+ halt\/s$/
      .test(document.getElementById("hud-metrics").textContent)), await text("#hud-metrics"));
  ok("v4.3 the speed token is coloured by its value", await page.evaluate(() => {
    const s = document.querySelector(".hud-speed");
    const v = parseFloat(s.textContent);
    return s.classList.contains(v >= 0.95 ? "good" : v >= 0.8 ? "warn" : "bad");
  }), await text(".hud-speed"));
  ok("v4.3 it updates at 2 Hz, not per frame", await page.evaluate(async () => {
    let n = 0;
    const o = new MutationObserver(() => n++);
    o.observe(document.getElementById("hud-metrics"), { childList: true, subtree: true, characterData: true });
    await new Promise((r) => setTimeout(r, 3000));
    o.disconnect();
    return n > 0 && n < 3000 / 100;   // ~6 redraws in 3 s, nowhere near 180
  }));
  ok("v4.3 neither line is clipped mid-token", await page.evaluate(() =>
    [...document.querySelectorAll(".hud-line")]
      .every((e) => e.scrollWidth <= e.clientWidth + 1)));

  /* ---------------- v4 §4: the phone overlay ---------------- */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  ok("v4.4 the toggle governs the overlay too", await page.evaluate(async () => {
    const c = document.getElementById("opt-hud");
    const set = async (v) => {
      c.checked = v; c.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return document.getElementById("hud").hidden;
    };
    const off = await set(false), on = await set(true);   // left on for §4 below
    return off && !on;
  }));
  ok("v4.4 an overlay on the top edge of the screen box", await page.evaluate(() => {
    const h = document.getElementById("hud"), wrap = document.querySelector(".lcd-wrap");
    const s = getComputedStyle(h);
    const a = h.getBoundingClientRect(), b = wrap.getBoundingClientRect();
    return h.parentElement === wrap && s.position === "absolute"
      && s.pointerEvents === "none" && s.backgroundColor === "rgba(0, 0, 0, 0.6)"
      && s.padding === "3px 6px"
      && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5;
  }), await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("hud"));
    return `${s.position} ${s.backgroundColor} ${s.padding} ${s.pointerEvents}`;
  }));
  ok("v4.4 it costs the column no height", await page.evaluate(() => {
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

  // §3's fitting rule, at the three widths it is quoted for
  for (const [w, want] of [[390, 6], [360, 5], [320, 4]]) {
    await page.setViewportSize({ width: w, height: 844 });
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
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
  ok("v4.3 the narrowest line is speed, MIPS, fps, lag", await page.evaluate(() =>
    /^\d+\.\d\d× · +\d+\.\d MIPS · +\d+ fps · lag +\d+\.\ds$/
      .test(document.getElementById("hud-metrics").textContent)), await text("#hud-metrics"));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  {
    const wait = page.waitForEvent("download", { timeout: 20000 });
    await page.click("#btn-shot");
    const png = await readFile(await (await wait).path());
    const got = [png.readUInt32BE(16), png.readUInt32BE(20)];
    const want = await page.evaluate(() => {
      const c = document.getElementById("lcd");
      return [c.width, c.height];
    });
    ok("v4.4 a canvas screenshot has none of the strip in it",
      got[0] === want[0] && got[1] === want[1], `${got} vs ${want}`);
  }

  /* ---------------- v4 §6: the slow warning ---------------- */
  {
    const cdp = await page.context().newCDPSession(page);
    const speed = () => page.evaluate(() => window.__hud.diagnostics().avg10s.vratio);

    // §6b the warning itself, which only applies once the cap has switched to
    // strict (§6a, in the boot section, covers the banked half). Waiting on the
    // phase rather than a timeout is what makes this deterministic — under an
    // explicit ?rt=strict or ?rt=off it resolves at once.
    await page.waitForFunction(() => window.__ui.rtcap !== "banked", null,
      { timeout: 180000 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 });
    const slow = await page.waitForFunction(() => window.__ui.slow, null, { timeout: 30000 })
      .then(() => true).catch(() => false);
    ok("v4.6 under 0.80x for 3 s turns the pill amber", slow && await page.evaluate(() =>
      document.getElementById("status").classList.contains("warn")
      && / · slow$/.test(document.getElementById("status-text").textContent)),
      `v/wall ${await speed()}, pill "${await text("#status-text")}"`);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const back = await page.waitForFunction(() => !window.__ui.slow, null, { timeout: 40000 })
      .then(() => true).catch(() => false);
    ok("v4.6 and back to green once it recovers", back && await page.evaluate(() =>
      !document.getElementById("status").classList.contains("warn")
      && !/slow/.test(document.getElementById("status-text").textContent)),
      `v/wall ${await speed()}, pill "${await text("#status-text")}"`);
  }
  await page.setViewportSize({ width: 1770, height: 1000 });
  await page.waitForTimeout(400);

  /* ---------------- recording criteria §2-§5, on the phone row ---------- */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const geom = () => page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return {
      row: Math.round(r(".status-row").height),
      box: [Math.round(r(".lcd-wrap").width), Math.round(r(".lcd-wrap").height)],
      keypad: Math.round(r("#keypad").top),
    };
  });
  const before = await geom();
  ok("v3.1 enabled while running", await page.evaluate(() => {
    const b = document.getElementById("btn-record");
    return !b.disabled && b.getAttribute("aria-label") === "Start recording";
  }));
  await page.click("#btn-record");
  await page.waitForTimeout(1500);

  ok("v3.2 the pill took the button's place", await page.evaluate(() => {
    const row = [...document.querySelector(".status-row").children]
      .filter((e) => !e.hidden).map((e) => e.id);
    return row.join() === "status,btn-shot,rec-pill,btn-settings"
      && getComputedStyle(document.getElementById("rec-pill")).flexGrow === "0";
  }), await page.evaluate(() => [...document.querySelector(".status-row").children].filter((e) => !e.hidden).map((e) => e.id).join()));
  ok("v3.2 elapsed counter and a Finish button", await page.evaluate(() => {
    const f = document.getElementById("btn-rec-finish");
    return /^\d+:\d\d$/.test(document.getElementById("rec-pill-time").textContent)
      && f.textContent.trim() === "Finish"
      && f.getAttribute("aria-label") === "Finish recording"
      && Math.round(f.getBoundingClientRect().height) === 24;
  }));
  ok("v3.2 two pills, different colours", await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("status")).backgroundColor;
    const r = getComputedStyle(document.getElementById("rec-pill")).backgroundColor;
    return s !== r && s.includes("20, 83, 45") && r.includes("74, 20, 20");
  }));
  ok("v3.5 exactly one Stop and one Finish in the visible row", await page.evaluate(() => {
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
    (await page.$eval("#btn-stop", (e) => e.textContent.trim())) === "Stop");
  ok("v3.5 start was announced", (await text("#live-region")) === "Recording started");
  const during = await geom();
  ok("v3.4 no layout shift while recording",
    during.row === 32 && before.row === 32
    && during.box[0] === before.box[0] && during.box[1] === before.box[1]
    && during.keypad === before.keypad,
    JSON.stringify({ before, during }));
  ok("v3.4 screenshot stays enabled", await page.$eval("#btn-shot", (e) => !e.disabled));

  // §3 verify: both pills plus the two icon buttons on one 32px row at 320px
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(400);
  ok("v3.3 everything fits one row at 320px", await page.evaluate(() => {
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
  }), await page.evaluate(() => {
    const t = document.getElementById("status-text");
    return `text ${Math.round(t.getBoundingClientRect().width)}px "${t.textContent}"`;
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);

  await page.click("#btn-rec-finish");
  await page.waitForTimeout(1200);
  ok("v3.2 idle button restored in the same place", await page.evaluate(() => {
    const row = [...document.querySelector(".status-row").children]
      .filter((e) => !e.hidden).map((e) => e.id);
    const b = document.getElementById("btn-record");
    // fullscreen is back too: it stands down only while a capture runs
    return row.join() === "status,btn-shot,btn-record,btn-fullscreen,btn-settings"
      && b.getAttribute("aria-label") === "Start recording"
      && Math.round(b.getBoundingClientRect().width) === 28;
  }));
  ok("v3.5 save was announced", (await text("#live-region")) === "Recording saved");
  ok("v3.3 the Running prefix comes back",
    /^Running · \d+:\d\d( · slow)?$/.test(await text("#status-text")), await text("#status-text"));
  await page.setViewportSize({ width: 1770, height: 1000 });
  await page.waitForTimeout(300);

  await page.click("#btn-stop");
  await page.waitForFunction(() => window.__ui.state === "idle", null, { timeout: 60000 });
  ok("1.7 controls come back with their values", await page.evaluate(() =>
    !document.getElementById("firmware-panel").disabled
    && document.getElementById("ff-lock-note").hidden
    && !!document.getElementById("ff-bin-name").textContent));
  ok("2.2 Start is back", await has("#btn-start"));
  // the image the run left behind is still readable, so the exports stay
  ok("exports stay available after Stop", await page.evaluate(() =>
    !document.getElementById("btn-save-flash").disabled
    && document.getElementById("export-caption").hidden));
  ok("the stopped run's flash is still readable", await page.evaluate(() =>
    !!window.__qemu?.FS?.analyzePath("/data/fullflash.bin")?.exists));
  ok("EFA export stays hidden for the siemens run", await page.$eval("#btn-save-efa", (e) => e.hidden));
}

console.log(`\n${count - fails}/${count} checks passed`);
await browser.close();
process.exit(fails ? 1 : 0);
