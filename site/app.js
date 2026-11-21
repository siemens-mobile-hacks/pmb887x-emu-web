// qemu-pmb887x web frontend.
//
// Boots the wasm-compiled qemu-system-arm (arm-softmmu + the wasm64 TCG
// backend + the `-display wasm` backend) entirely in the browser:
//   - the fullflash picked by the user is written into the emscripten MEMFS,
//   - board configs are unpacked from boards.tar,
//   - PMB887X_* env vars mirror the pmb887x-emu-mcp `load` tool options,
//   - the LCD is repainted from the wasm framebuffer on requestAnimationFrame,
//   - every on-screen keypad <button data-key> maps to the same qcodes the
//     MCP `press_key` tool uses (converted to linux keycodes, which is what
//     this qemu fork's input layer consumes).

import { KBD_KEYBOARDS, DEFAULT_KEYBOARD, pickVariant, applyKbdLayout, tapTable, forDevice, caseStep } from "./keyboards.js";
import {
  PRESET_FULLFLASHES, SIDE_CAR_RE, inferDevice, detectDevice,
  cacheAvailable, cacheChecked, entryCacheState, downloadEntry, deleteEntry, readCachedEntry,
} from "./fullflashes.js";
import {
  readIdentity, recalc, recoverEsn, cachedEsnCount, clearEsnCache, workerCount,
} from "./recalc.js";
import { loadSiemensFW } from "./siemensfw.js";
import { GprsNet } from "./gprs-net.js";
import { badgeView } from "./gsm-badge.js";
import { buildShortUA } from "./ua.js";
import { esnToOtp0, imeiToOtp1 } from "./otp.js";
import { serialMessages, parseExit, EXIT_MARK, EXIT_HEAD } from "./exit-report.js";
import {
  untar, boardText, readPanel, readBoardName, readAccessories,
  boardCpu, gsmBoardHasRadio, boardHasDisplay, boardHasSimSlot,
} from "./boards.js";

/* ------------------------------------------------------------------ */
/* phone key tables (mirrors pmb887x-emu-mcp/src/keys.ts)               */
/* ------------------------------------------------------------------ */

// phone key -> linux keycode (qemu converts lnx->qcode internally)
const KEY_TO_LINUX = {
  up: 103, down: 108, left: 105, right: 106, center: 28, // KEY_UP.. KEY_ENTER
  left_soft: 59, right_soft: 60, // KEY_F1, KEY_F2
  send: 61, end: 62,             // KEY_F3, KEY_F4
  clear: 14,                     // KEY_BACKSPACE (LG "C" key)
  music: 63, play: 64, ptt: 65, camera: 66, browser: 67, // KEY_F5..KEY_F9
  vol_up: 78, vol_down: 74,      // KEY_KPPLUS, KEY_KPMINUS
  "0": 11, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6,
  "6": 7, "7": 8, "8": 9, "9": 10,
  star: 55, hash: 98,            // KEY_KPASTERISK, KEY_KPSLASH
};

// browser KeyboardEvent.code -> phone key (physical keyboard convenience)
const CODE_TO_KEY = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Enter: "center", NumpadEnter: "center",
  F1: "left_soft", F2: "right_soft", F3: "send", F4: "end",
  // F5 is left to the browser (reload); the music key is on-screen only
  F6: "play", F7: "ptt", F8: "camera", F9: "browser",
  Backspace: "clear",
  NumpadAdd: "vol_up", NumpadSubtract: "vol_down", Equal: "vol_up", Minus: "vol_down",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
  Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  // the numpad is mapped by position, not by digit: its top row sits where
  // the phone's 1-2-3 row is, so 7-8-9 press 1-2-3 (and 1-2-3 press 7-8-9)
  // and the hand keeps the phone's layout under it
  Numpad7: "1", Numpad8: "2", Numpad9: "3",
  Numpad4: "4", Numpad5: "5", Numpad6: "6",
  Numpad1: "7", Numpad2: "8", Numpad3: "9",
  Numpad0: "0",
  NumpadMultiply: "star", Backquote: "star", NumpadDivide: "hash", Slash: "hash",
  Escape: "end",
};

// Physical-keyboard binding drawn on each key ("Show shortcuts on keys"
// checkbox in the Run panel). Derived from CODE_TO_KEY so the two cannot
// drift: the first code listed there for a key is the one shown. Digit keys
// are left out — their own legend already names the key that presses them.
const CODE_LABEL = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Enter: "Enter", Backspace: "⌫", Escape: "Esc",
  NumpadAdd: "Num +", NumpadSubtract: "Num −",
  NumpadMultiply: "Num *", NumpadDivide: "Num /",
};
const KEY_HINT = {};
for (const [code, key] of Object.entries(CODE_TO_KEY)) {
  if (/^\d$/.test(key)) continue;
  KEY_HINT[key] ??= CODE_LABEL[code] ?? code;
}

// Fullflash sidecars (SIDE_CAR_RE) + filename -> device inference now
// live in fullflashes.js.

/* ------------------------------------------------------------------ */
/* state                                                                */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
// the page's query; it never changes while the page lives
const QS = new URLSearchParams(location.search);
// Remembered settings. With site data blocked the localStorage getter itself
// throws; the page then runs on its defaults and remembers nothing.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
};
let qemuModule = null;   // current emscripten module instance
let running = false;     // a guest is live (the module object outlives it)
let gprsNet = null;      // the GSM cell's IP side (gprs-net.js) while it runs
// The module object outlives the guest, but its wasm exports do not:
// emscripten replaces them with stubs that abort ("called after runtime
// exit") once main() has returned, and the stale module of a finished run is
// still assigned while the next one boots. Everything that calls into wasm
// asks for the module here; only FS reads (the exports, the serial log) go to
// qemuModule directly, since MEMFS survives the exit.
const liveModule = () => (running ? qemuModule : null);
let rafHandle = 0;
let serialTimer = 0;
let boards = [];         // [{id, file}] parsed from boards.tar
let boardsBuf = null;
let bootCancelled = false; // Stop pressed before boot()/bootSuite() had a live guest
let startWaiting = false;  // a Start waiting for boards.tar
const BOOT_CANCELLED = Symbol("boot cancelled");
// boot() and bootSuite() call this before every step that can take a while
const checkCancel = () => { if (bootCancelled) throw BOOT_CANCELLED; };
let boardsReady = null;   // loadBoards() promise — boot() awaits it
let pendingDevice = null; // device inferred from a fullflash picked before
                          // boards.tar finished loading (slow links)

// The one place the whole UI reads its run state from:
//   idle | downloading | recovering | booting | running | paused
// (recovering: the Siemens ESN sweep before a boot)
// ("paused" has no trigger yet — qemu's wasm display backend exposes no
// vm_stop; the pill, the export buttons and the lock all handle it, so
// wiring one up is a one-liner here.)
let emuState = "idle";
let runStartedAt = 0;     // uptime origin, reset on every Start
let uptimeTimer = 0;
let dlLoaded = 0, dlTotal = 0; // the download in progress, for the pill
let dlWhat = "fullflash";      // ...and whether it is the preset's or the engine's
let esnPct = 0;                // ESN sweep progress, likewise
let errorMsg = null;      // shown in place of the pill's state text
let noEfaWarning = false; // this LG run booted without its EFA block
let startBlocked = false; // a failure Start cannot recover from (isolation)
// The exports read this run's MEMFS, which outlives the guest: once a boot
// has got that far they stay available after Stop, until the next Start
// replaces the image. ranDevice is the phone they belong to — only an LG
// one has an EFA block to hand back.
let exportsReady = false;
let ranDevice = null;
// the Accessory control's board, its profiles and the one plugged in; null
// makes renderAccessory() read them again from the board config (a run boots
// with the board's default plugged in)
let acc = null;
// The filename the image came in under, so a saved dump is named after it.
let ranFlashName = null;
// What Advanced ▸ Siemens keys did to this run's image, for Copy diagnostics.
let keyReport = null;
// The ESN sweep's AbortController while it runs — Cancel uses it, the way
// downloadAbort works for a preset download.
let esnAbort = null;
// The guest has been slower than 0.80x for three seconds. Drawn on the pill
// whether or not the HUD itself is shown.
let slow = false;
// The clock is banked for the guest's first ?bank= seconds of its own clock —
// the boot: time lost to a slow host is caught up rather than dropped, so
// v/wall below 1 is not "slow" yet. The slow warning stays quiet while
// banked (see trackSpeed).
let banked = false;
// The guest has stopped executing while the page still believes it is
// running. The vCPU is a worker thread and the state machine above never
// hears about one that dies or wedges — the run stays "Running · 0:21" with
// a dead guest behind it, which is what an Android KE800 boot looks like.
// Only the counters can tell: insns, halts and display updates frozen
// *together* is a thread that is gone, not a guest that is idle or slow.
let stalled = false;
// A Stop has waited FORCE_STOP_AFTER_MS for the guest to exit: the action
// is "Force stop" (forceStop) from then on.
let quitStuck = false, quitTimer = 0;
// the last thing qemu said before it stopped, and whatever killed a worker
let fatalMsg = null;
const logTail = [];
window.__qemutail = logTail;

// A pthread worker that throws — an abort(), a wasm trap, a failed
// allocation — surfaces on the main thread as an error event and nowhere
// else: emscripten rethrows it out of worker.onerror. Without this the
// vCPU dying is completely silent, which is why a stalled guest could not
// be told apart from a slow one.
function noteFatal(what) {
  fatalMsg ??= String(what);
  console.log("[qemu fatal]", what);
}
addEventListener("error", (e) => noteFatal(e.message || e.error || "error"));
addEventListener("unhandledrejection", (e) => noteFatal(e.reason));

const statusEl = $("status");
const statusTextEl = $("status-text");
const pillActionEl = $("pill-action");
const captionEl = $("status-caption");
// declared here, with the rest of the pill, because render() reaches the
// HUD and render() runs long before the HUD section further down
const hudEl = $("hud");
const hudMetricsEl = $("hud-metrics");
const hudEnvEl = $("hud-env");
const hudRuler = $("hud-ruler");
const hudChk = $("opt-hud");
// render() reaches the HUD, and render() runs while the HUD section further
// down is still in its temporal dead zone
let hudReady = false;
// render() hides this one while a capture runs, and render() likewise runs
// before the fullscreen section further down — so it is declared up here.
// iOS Safari has no Fullscreen API on anything but a <video>.
const fsBtn = $("btn-fullscreen");
const fsSupported = !!document.documentElement.requestFullscreen;

function fmtMiB(bytes) {
  const m = bytes / (1024 * 1024);
  return (m >= 10 ? Math.round(m) : m.toFixed(1)) + " MiB";
}

// "23 / 64 MiB" — only the total carries the unit
function fmtProgress(loaded, total) {
  const m = loaded / (1024 * 1024);
  return `${m >= 10 ? Math.round(m) : m.toFixed(1)} / ${fmtMiB(total)}`;
}

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* LCD overlay: the progress surface until the guest owns the screen    */
/* ------------------------------------------------------------------ */

const overlayEl = $("lcd-overlay");
const overlayBar = $("ov-bar");

// pct === null keeps the bar hidden (an indeterminate or instant step)
function showOverlay(msg, sub = "", pct = null) {
  overlayEl.classList.remove("hidden");
  $("ov-msg").textContent = msg;
  $("ov-sub").textContent = sub;
  overlayBar.hidden = pct == null;
  if (pct != null) overlayBar.firstElementChild.style.width = pct + "%";
}

function hideOverlay() {
  overlayEl.classList.add("hidden");
}

/* ------------------------------------------------------------------ */
/* Firmware panel: Preset | Own file                                    */
/* ------------------------------------------------------------------ */

const fwFieldset = $("firmware-panel");
// the one focusable thing in the panel a `disabled` fieldset cannot reach
const advSummary = $("advanced").querySelector("summary");
const modeBody = $("ff-mode-body");
const segButtons = [$("ff-mode-preset"), $("ff-mode-own")];
// Both mode bodies are built once and swapped in and out, so the one that
// is not showing keeps its values (and its file chips) in the detached
// subtree — and the one that is showing is the only one in the DOM.
const presetBody = $("tpl-ff-preset").content.firstElementChild;
const ownBody = $("tpl-ff-own").content.firstElementChild;

const P = {
  sel: presetBody.querySelector("#ff-preset"),
  status: presetBody.querySelector("#ff-preset-status"),
  clear: presetBody.querySelector("#ff-preset-delete"),
  bar: presetBody.querySelector("#ff-preset-bar"),
  device: presetBody.querySelector("#ff-preset-device"),
};
const O = {
  body: ownBody,
  input: ownBody.querySelector("#fullflash"),
  slot: ownBody.querySelector("#ff-bin-slot"),
  zone: ownBody.querySelector("#ff-bin-zone"),
  chip: ownBody.querySelector("#ff-bin-chip"),
  name: ownBody.querySelector("#ff-bin-name"),
  size: ownBody.querySelector("#ff-bin-size"),
  clear: ownBody.querySelector("#ff-bin-clear"),
  pick: ownBody.querySelector("#ff-bin-pick"),
  note: ownBody.querySelector("#ff-bin-note"),
  device: ownBody.querySelector("#device"),
  devNote: ownBody.querySelector("#ff-device-note"),
  efaBlock: ownBody.querySelector("#ff-efa-block"),
  efaInput: ownBody.querySelector("#ff-efa"),
  efaSlot: ownBody.querySelector("#ff-efa-slot"),
  efaZone: ownBody.querySelector("#ff-efa-zone"),
  efaChip: ownBody.querySelector("#ff-efa-chip"),
  efaName: ownBody.querySelector("#ff-efa-name"),
  efaSize: ownBody.querySelector("#ff-efa-size"),
  efaClear: ownBody.querySelector("#ff-efa-clear"),
  efaPick: ownBody.querySelector("#ff-efa-pick"),
  efaNote: ownBody.querySelector("#ff-efa-note"),
};
O.efaBlock.remove(); // non-LG by default: the block is not in the DOM at all

let ffMode = "preset";
let selectedPreset = null;  // PRESET_FULLFLASHES entry
let presetState = { complete: false, count: 0, totalSize: 0 };
let ownBin = null, ownEfa = null; // the picked File objects
let presetBusy = false;     // preset download in flight (during boot)
let downloadAbort = null;   // its AbortController while it runs — Cancel uses it
// The engine wasm prefetch (see the engine section by the ?dist block):
// engineAbort is the engine's twin of downloadAbort — set only while
// boot() itself waits the download out, Cancel uses it — and
// engineCancelled tells boot()'s catch which of the two an AbortError
// came from.
let engineAbort = null;
let engineCancelled = false;

const BIN_RE = /\.bin$/i;
const EFA_RE = /\.cfi-efa$/i;

function presetById(id) {
  return PRESET_FULLFLASHES.find((p) => p.id === id) ?? null;
}

function setNote(el, kind, text) {
  el.className = "inline-note" + (kind ? " " + kind : "");
  el.textContent = text;
  el.hidden = !text;
}

/* ------------------------------------------------------------------ */
/* Advanced ▸ Siemens keys                                              */
/* ------------------------------------------------------------------ */

// Siemens firmware checks the keys stored in the fullflash against the ESN it
// is handed, so a dump built for another phone does not boot as is. The three
// modes are pmb887x-emu's: recalculate the keys for our identity (its
// default), recover the ESN the stored keys answer to (--siemens-recover-esn),
// or hand the image over untouched (--siemens-no-recalc).
const SK = {
  block: $("siemens-keys-block"),
  grid: $("siemens-keys-block").parentElement,
  // the block goes back in front of the IMEI/ESN pair it refers to, not at
  // the end of the grid where a plain appendChild would put it
  anchor: $("imei").closest("label"),
  note: $("siemens-keys-note"),
  clear: $("esn-cache-clear"),
  radios: [...document.querySelectorAll('input[name="siemens-mode"]')],
};
SK.block.remove();  // not in the DOM until siemensKeysApply() says so
const SIEMENS_MODE_KEY = "siemens-mode";

function siemensMode() {
  return SK.radios.find((r) => r.checked)?.value ?? "recalc";
}

// Unlike the identity fields next to it this one is remembered: it is a
// choice about how the page should behave, not a value to boot with.
{
  const stored = store.get(SIEMENS_MODE_KEY);
  const match = SK.radios.find((r) => r.value === stored);
  if (match) match.checked = true;
}

// The block is Siemens-only, the way the EFA picker is LG-only: out of the
// DOM entirely for every other device. Own file only, too — every preset in
// the inventory is published already recalculated, so there is nothing for
// the modes to do there and no reason to offer them.
function siemensKeysApply() {
  return ffMode === "own" && !!currentDevice()?.startsWith("siemens-");
}

function refreshSiemensKeys() {
  const show = siemensKeysApply();
  if (show && !SK.block.isConnected) SK.grid.insertBefore(SK.block, SK.anchor);
  else if (!show && SK.block.isConnected) SK.block.remove();

  // --siemens-recover-esn reads both from the image, and pmb887x-emu refuses
  // to take them from the user at the same time. The block going away takes
  // the lock with it, or a mode picked for one flash would leave the fields
  // dead for the next.
  const recovering = show && siemensMode() === "recover-esn";
  for (const id of ["imei", "esn"]) $(id).disabled = recovering;
  SK.note.textContent = recovering
    ? "IMEI and ESN come from the fullflash in this mode."
    : "";
  if (show) {
    const cached = cachedEsnCount();
    SK.clear.hidden = cached === 0;
    SK.clear.textContent = `Clear ESN cache (${cached})`;
  }
  refreshAdvancedSummary();
}

for (const r of SK.radios) {
  r.addEventListener("change", () => {
    store.set(SIEMENS_MODE_KEY, r.value);
    refreshSiemensKeys();
  });
}

SK.clear.addEventListener("click", () => {
  clearEsnCache();
  refreshSiemensKeys();
  say("Cached ESNs cleared");
});

/* ---- what the folded Advanced summary says was changed inside ---- */

// Defaults come from the markup, so the two cannot drift. The Siemens key
// mode is deliberately not listed: it is only offered for the flash in hand,
// so naming it here would put a change on the summary that the next flash
// does not have.
const ADV_FIELDS = [["imei", "IMEI"], ["esn", "ESN"], ["sim", "SIM"],
  ["operator", "operator"], ["startup", "startup"], ["gsm", "GSM"]];
const advDefaults = new Map(
  ADV_FIELDS.map(([id]) => [id, $(id).type === "checkbox" ? $(id).checked : $(id).value]));

function refreshAdvancedSummary() {
  const changed = ADV_FIELDS
    .filter(([id]) => (($(id).type === "checkbox" ? $(id).checked : $(id).value)) !== advDefaults.get(id))
    .map(([, name]) => name);
  $("adv-summary").textContent = changed.length ? `— ${changed.join(", ")}` : "";
}

for (const [id] of ADV_FIELDS) $(id).addEventListener("input", refreshAdvancedSummary);
refreshAdvancedSummary();

function mountMode() {
  modeBody.replaceChildren(ffMode === "preset" ? presetBody : ownBody);
}

function setMode(mode, moveFocus = false) {
  ffMode = mode;
  for (const b of segButtons) {
    const on = b.dataset.mode === mode;
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
    if (on && moveFocus) b.focus();
  }
  mountMode();
  if (mode === "preset") refreshPresetUi(); else renderOwn();
  render();
}

for (const b of segButtons) {
  b.addEventListener("click", () => setMode(b.dataset.mode, true));
  // a radiogroup moves with the arrow keys, and selection follows focus
  b.addEventListener("keydown", (e) => {
    const i = segButtons.indexOf(b);
    let j = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % segButtons.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i + segButtons.length - 1) % segButtons.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = segButtons.length - 1;
    if (j == null) return;
    e.preventDefault();
    setMode(segButtons[j].dataset.mode, true);
  });
}

/* ---- preset mode ---- */

for (const entry of PRESET_FULLFLASHES) {
  const opt = document.createElement("option");
  opt.value = entry.id;
  opt.textContent = entry.label;
  P.sel.appendChild(opt);
}
// "was last used", else the first entry
const lastPreset = presetById(store.get("ff-preset") ?? "");
selectedPreset = lastPreset ?? PRESET_FULLFLASHES[0] ?? null;
if (selectedPreset) P.sel.value = selectedPreset.id;

// The cache state of the selected preset, the one line that replaced the
// two helper paragraphs and the "— cached" option suffix.
async function refreshPresetUi() {
  const entry = selectedPreset;
  const state = entry ? await entryCacheState(entry)
    : { complete: false, count: 0, totalSize: 0 };
  // a newer selection has its own refresh under way
  if (selectedPreset !== entry) return;
  presetState = state;
  P.clear.hidden = !entry || presetState.count === 0;
  P.device.textContent = entry
    ? `Device: ${inferDevice(entry.files[0]) ?? "unknown"} (from preset)` : "";
  refreshSiemensKeys();
  const downloading = presetBusy && emuState === "downloading";
  P.bar.hidden = !downloading;
  P.status.className = "ff-status" + (!downloading && presetState.complete ? " ok" : "");
  if (!entry) P.status.textContent = "";
  else if (downloading) {
    P.status.textContent = `Downloading · ${fmtProgress(dlLoaded, dlTotal)}`;
    P.bar.firstElementChild.style.width =
      (dlTotal ? Math.min(100, (dlLoaded / dlTotal) * 100) : 0) + "%";
  } else if (presetState.complete) {
    P.status.textContent = `✓ Cached · ${fmtMiB(presetState.totalSize || entry.size)}`;
  } else if (!cacheAvailable()) {
    P.status.textContent = `Browser cache unavailable · fetches ${fmtMiB(entry.size)} on every Start`;
  } else if (presetState.count) {
    P.status.textContent = "Partly downloaded · fetches the rest on Start";
  } else {
    P.status.textContent = `Not downloaded · fetches ${fmtMiB(entry.size)} on Start`;
  }
  render();
}

P.sel.addEventListener("change", async () => {
  selectedPreset = presetById(P.sel.value);
  if (selectedPreset) {
    store.set("ff-preset", selectedPreset.id);
    syncKeyboardToDevice(inferDevice(selectedPreset.files[0]));
  }
  await refreshPresetUi();
  setAspect(); // a different phone, a different screen ratio
});

P.clear.addEventListener("click", async () => {
  if (!selectedPreset || presetBusy) return;
  await deleteEntry(selectedPreset);
  await refreshPresetUi();
});

/* ---- own-file mode ---- */

// Rendered from ownBin/ownEfa, never from the <input>: the picked File
// objects outlive the input (a mode switch detaches it) and a FileList
// cannot be written back into one.
function renderOwn() {
  O.zone.hidden = !!ownBin;
  O.chip.hidden = !ownBin;
  if (ownBin) {
    O.name.textContent = ownBin.name;
    O.name.title = ownBin.name;
    O.size.textContent = fmtMiB(ownBin.size);
  }
  const dev = O.device.value;
  const lg = dev.startsWith("lg-");
  // the EFA block exists only for LG devices — a sidecar picked
  // for one is remembered in ownEfa and comes back with the block
  if (lg && !O.efaBlock.isConnected) O.body.appendChild(O.efaBlock);
  else if (!lg && O.efaBlock.isConnected) O.efaBlock.remove();
  O.efaZone.hidden = !!ownEfa;
  O.efaChip.hidden = !ownEfa;
  if (ownEfa) {
    O.efaName.textContent = ownEfa.name;
    O.efaName.title = ownEfa.name;
    O.efaSize.textContent = fmtMiB(ownEfa.size);
  }
  if (lg) setNote(O.devNote, null, "");
  refreshSiemensKeys();
}

// One selection can carry both slots. The rules are applied in
// order; a rejected selection leaves both slots exactly as they were.
function applyPicked(list) {
  const files = [...list];
  if (!files.length) return;
  const bins = files.filter((f) => BIN_RE.test(f.name));
  const efas = files.filter((f) => EFA_RE.test(f.name));
  const others = files.filter((f) => !BIN_RE.test(f.name) && !EFA_RE.test(f.name));
  const tooMany = "Choose one .bin and, optionally, one .cfi-efa.";

  setNote(O.note, null, "");
  setNote(O.devNote, null, "");
  if (bins.length > 1 || efas.length > 1) { setNote(O.note, "err", tooMany); return; }
  if (!bins.length) {
    // only sidecars (or nothing usable): fills the sidecar slot, but only
    // on top of a fullflash that is already loaded
    if (efas.length === 1 && ownBin) ownEfa = efas[0];
    else { setNote(O.note, "err", tooMany); return; }
  } else {
    ownBin = bins[0];
    // the device and the sidecar are the new file's own: one the page cannot
    // place stays unset rather than keep the last file's, and a sidecar comes
    // only with the file it was picked with
    O.device.value = "";
    pendingDevice = null;
    ownEfa = efas.length === 1 ? efas[0] : null;
    if (!ownEfa) O.efaInput.value = "";
    // async: reading the image to name the device settles after this returns
    applyFullflashFile(ownBin).catch(() => {});
    if (others.length) setNote(O.note, null, `Ignored ${others.length} other file(s).`);
  }
  warnEfaDevice();
  renderOwn();
  render();
}

// An EFA sidecar only means something on an LG board. Re-checked after an
// async detection too, since that is what settles the device.
function warnEfaDevice() {
  if (ownEfa && O.device.value && !O.device.value.startsWith("lg-")) {
    setNote(O.devNote, "warn",
      "An EFA sidecar was provided but this device doesn't use one.");
    return true;
  }
  return false;
}

function applyEfaPicked(list) {
  const f = [...list][0];
  if (!f) return;
  if (!EFA_RE.test(f.name)) { setNote(O.efaNote, "err", "Expected a .cfi-efa file."); return; }
  ownEfa = f;
  setNote(O.efaNote, null, "");
  renderOwn();
  render();
}

O.input.addEventListener("change", (e) => applyPicked(e.target.files));
O.efaInput.addEventListener("change", (e) => applyEfaPicked(e.target.files));

O.clear.addEventListener("click", () => {
  ownBin = null;
  O.input.value = "";
  setNote(O.note, null, "");
  setNote(O.devNote, null, "");
  renderOwn();
  render();
});
O.efaClear.addEventListener("click", () => {
  ownEfa = null;
  O.efaInput.value = "";
  setNote(O.efaNote, null, "");
  renderOwn();
  render();
});

// The chip is the way back to the picker once a file is chosen — the drop zone
// that carries the <label> is hidden by then. Clearing value first so that
// re-picking the very same file still fires `change`.
O.pick.addEventListener("click", () => { O.input.value = ""; O.input.click(); });
O.efaPick.addEventListener("click", () => { O.efaInput.value = ""; O.efaInput.click(); });

// drag-and-drop onto either slot (the zone or the chip that replaced it)
function wireDrop(slot, zone, handler) {
  slot.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!fwFieldset.disabled) zone.classList.add("drag");
  });
  for (const t of ["dragleave", "dragend"]) {
    slot.addEventListener(t, () => zone.classList.remove("drag"));
  }
  slot.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    if (fwFieldset.disabled) return;
    handler(e.dataTransfer?.files ?? []);
  });
}
wireDrop(O.slot, O.zone, applyPicked);
wireDrop(O.efaSlot, O.efaZone, applyEfaPicked);
// dropping anywhere else must not navigate the page away to the file
for (const t of ["dragover", "drop"]) {
  document.addEventListener(t, (e) => e.preventDefault());
}

// counts the devices picked by hand, so a detection that was reading the
// image meanwhile can tell (applyFullflashFile)
let devicePicks = 0;
O.device.addEventListener("change", () => {
  devicePicks++;
  setNote(O.devNote, null, "");
  syncKeyboardToDevice(O.device.value);
  renderOwn();
  render();
  setAspect(); // a different phone, a different screen ratio
});

/* ------------------------------------------------------------------ */
/* run state: the pill is the only Start/Stop                          */
/* ------------------------------------------------------------------ */

function currentDevice() {
  if (ffMode === "preset") {
    return selectedPreset ? inferDevice(selectedPreset.files[0]) : null;
  }
  return O.device.value || null;
}

// Preset mode needs a preset, own-file mode a .bin and a device.
// The sidecar never gates Start.
function firmwareReady() {
  if (startBlocked) return false;
  if (ffMode === "preset") return !!selectedPreset;
  // pendingDevice counts: boot() awaits boards.tar before reading the
  // dropdown, so a device inferred while the list was still loading is as
  // good as one already in it
  return !!ownBin && !!(O.device.value || pendingDevice);
}

// What the phone-width pill says while idle: which firmware is loaded, and
// whether it is here yet. Doubles as the Firmware sheet's opener.
function firmwareLine() {
  if (ffMode === "own") return ownBin?.name ?? "No file chosen";
  if (!selectedPreset) return "No preset";
  return `${selectedPreset.short ?? selectedPreset.label}`
    + ` · ${presetState.complete ? "cached" : "not downloaded"}`;
}

function pillText() {
  if (errorMsg) return "Error";
  if (emuState === "idle" && phoneLayout.matches) return firmwareLine();
  // the background engine prefetch, so an instant Start has a visible
  // explanation — desktop widths only: on phones the idle pill is the
  // firmware line and doubles as the Firmware sheet's opener
  if (emuState === "idle" && engineSt)
    return `Prefetching emulator · ${engineSt.total
      ? Math.round((engineSt.loaded / engineSt.total) * 100) + "%"
      : fmtMiB(engineSt.loaded)}`;
  // while the recording pill is up the two have to share one row:
  // the uptime alone, no "Running · " in front of it
  const bare = !!recorder && phoneLayout.matches;
  // "· slow" is the pill's half of the slow warning: the amber colour says
  // something is wrong, the word says what
  const tail = stalled ? " · stopped" : slow ? " · slow" : "";
  switch (emuState) {
    case "downloading": return dlWhat === "engine"
      ? `Downloading emulator · ${dlTotal ? fmtProgress(dlLoaded, dlTotal) : fmtMiB(dlLoaded)}`
      : `Downloading · ${fmtProgress(dlLoaded, dlTotal)}`;
    case "recovering": return `Recovering ESN · ${esnPct}%`;
    case "booting": return "Booting" + tail;
    case "running": return (bare ? "" : "Running · ") + mmss(Date.now() - runStartedAt) + tail;
    case "paused": return (bare ? "" : "Paused · ") + mmss(Date.now() - runStartedAt) + tail;
    default: return "Idle";
  }
}

// The pill's text, with "Running · " or "Paused · " in a span of its own
// that the stylesheet drops where the pill is too narrow for it beside the
// network badge. The text as a whole (what tools read) stays the same.
const statusVerbEl = document.createElement("span");
statusVerbEl.className = "status-verb";
const statusRestEl = document.createTextNode("");
function showPillText() {
  const text = pillText();
  const verb = /^(Running|Paused) · /.exec(text)?.[0] ?? "";
  if (statusTextEl.firstChild !== statusVerbEl) statusTextEl.replaceChildren(statusVerbEl, statusRestEl);
  if (statusVerbEl.textContent !== verb) statusVerbEl.textContent = verb;
  if (statusRestEl.data !== text.slice(verb.length)) statusRestEl.data = text.slice(verb.length);
}

// exactly one of Start / Stop / Cancel is ever in the DOM
let actionKind = null;
function renderAction() {
  const kind = emuState === "idle" ? "start"
    : (emuState === "downloading" || emuState === "recovering") ? "cancel"
    : quitStuck ? "force" : "stop";
  if (kind !== actionKind) {
    actionKind = kind;
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.kind = kind;
    // the drivers in tools/ click #btn-start and #btn-stop; Cancel is the
    // stop action of the download phase and keeps that id
    b.id = kind === "start" ? "btn-start" : "btn-stop";
    b.className = "pill-btn " + (kind === "start" ? "primary" : "outline");
    if (kind !== "cancel") {
      b.innerHTML = kind === "start"
        ? '<svg class="ico" viewBox="0 0 24 24"><path d="M8.5 5.6 18 12l-9.5 6.4Z"/></svg>'
        : '<svg class="ico" viewBox="0 0 24 24"><rect x="6.8" y="6.8" width="10.4" height="10.4" rx="2"/></svg>';
    }
    b.append(kind === "start" ? "Start" : kind === "stop" ? "Stop"
      : kind === "force" ? "Force stop" : "Cancel");
    b.addEventListener("click", kind === "start" ? () => startRun() : stop);
    // the focus goes with the action, or it falls to <body>
    const focused = pillActionEl.contains(document.activeElement);
    pillActionEl.replaceChildren(b);
    if (focused) b.focus();
  }
  const btn = pillActionEl.firstElementChild;
  if (btn && kind === "start") btn.disabled = !firmwareReady();
}

function captionText() {
  if (errorMsg) return errorMsg;
  // the run ended in the firmware's own crash dump. The screen beside this
  // line carries the whole of it, and the caption's track is one nowrap
  // line wide, so here it is only the headline.
  if (exitReport) return "Firmware EXIT";
  if (noEfaWarning && emuState !== "idle") {
    return "No EFA block — the firmware may factory-reset.";
  }
  if (emuState !== "idle" || firmwareReady()) return "";
  if (ffMode === "own") return "Choose a file and device to start";
  return "Choose a firmware to start";
}

// one place every part of the UI that depends on the run state is drawn
function render() {
  const locked = emuState === "booting" || emuState === "running" || emuState === "paused";
  const live = emuState === "running" || emuState === "paused";
  // a download or ESN recovery works on the choice made at Start; the
  // pill's Cancel, outside the panel, stays live
  const panelLocked = locked || emuState === "downloading" || emuState === "recovering";

  statusEl.dataset.state = emuState;
  statusEl.className = "status"
    + (errorMsg || (stalled && locked) ? " error" : slow && locked ? " warn" : "");
  showPillText();
  renderAction();
  const cap = captionText();
  captionEl.textContent = cap;
  captionEl.hidden = !cap;

  // Nothing in the Firmware panel can be touched while it is live.
  // The fieldset alone would do it, but only as a computed state: the
  // attribute goes on every control too, and the two things a `disabled`
  // fieldset cannot reach (the disclosure, the roving segmented tabindex)
  // lose their tab stop by hand.
  fwFieldset.disabled = panelLocked;
  for (const el of fwFieldset.querySelectorAll("input, select, button")) el.disabled = panelLocked;
  // the blanket re-enable above would undo the IMEI/ESN lock that
  // "Brute-force ESN" needs (their values come from the image there)
  if (!panelLocked) refreshSiemensKeys();
  for (const b of segButtons) {
    b.tabIndex = panelLocked ? -1 : (b.getAttribute("aria-checked") === "true" ? 0 : -1);
  }
  $("ff-lock-note").hidden = !panelLocked;
  advSummary.tabIndex = panelLocked ? -1 : 0;

  // The exports need a guest image to read: live, or the one the last run
  // left behind. The EFA block only exists on LG phones, so the button for
  // it is only there for one.
  const canExport = live || exportsReady;
  const exportDev = ranDevice ?? currentDevice();
  $("btn-save-flash").disabled = !canExport;
  $("btn-save-efa").disabled = !canExport;
  $("btn-save-efa").hidden = !exportDev?.startsWith("lg-");
  $("export-caption").textContent = "Available once running";
  $("export-caption").hidden = canExport;
  renderAccessory();

  $("btn-shot").disabled = !live;
  // A capture can start as soon as there is
  // something on the screen to capture. Off the phone layout the button
  // keeps the rule it always had.
  const canRecord = (phoneLayout.matches ? emuState === "booting" || live : live)
    && !recBtn.dataset.unsupported;
  recBtn.disabled = !canRecord && !recorder;
  // while a capture runs the pill takes the button's place (phone widths),
  // and the button behind it is back to being the way to start one
  const pillRec = !!recorder && phoneLayout.matches;
  $("rec-pill").hidden = !pillRec;
  recBtn.hidden = pillRec;
  // The recording pill needs the record button's width and a little more: at
  // 320px the two pills plus four icons no longer fit the one row. So
  // fullscreen stands down while a capture runs — it is not something to
  // toggle mid-capture anyway, since it resizes the canvas under the recorder.
  if (fsSupported) fsBtn.hidden = pillRec;
  // Every board's DSP firmware renders sound now (the DSP LLE), so the
  // speaker is always offered — except during a capture, where it stands
  // down like fullscreen (the recording takes the sound whether or not the
  // speaker plays it, and the pill needs the room at 320px).
  soundBtn.hidden = pillRec;
  const finishing = !!recorder && !pillRec;
  const recFmt = recExt(recType()).slice(1);
  recBtn.title = finishing ? `Finish recording and save the .${recFmt}`
    : recBtn.dataset.unsupported ? "this browser has no MediaRecorder"
    : `Record the LCD to a .${recFmt} video`;
  recBtn.setAttribute("aria-label", finishing ? "Finish recording"
    : canRecord ? "Start recording" : "Start recording (emulator not running)");

  // the pill text opens the Firmware sheet, but only where there is one and
  // only while the panel is not locked
  $("status-open").disabled = !phoneLayout.matches || emuState !== "idle";
  syncHud();
  window.__ui = {
    state: emuState, mode: ffMode, device: currentDevice(),
    ready: firmwareReady(), error: errorMsg, exitCode, slow,
    bank: banked ? "banked" : "off",
    serialTap: serialTapped,
    get gprs() { return gprsInfo(); },
    get gsm() { return gsmInfo(); },
    exit: exitReport && {
      type: exitReport.type, code: exitReport.code,
      fields: Object.fromEntries(exitReport.rows),
    },
  };
}

const STATE_SAY = {
  idle: "Emulator stopped", downloading: "Downloading", recovering: "Recovering the ESN",
  booting: "Booting", running: "Running", paused: "Paused",
};

function setEmuState(next) {
  // every run gets its own metrics window: wall, virtual time and the slow
  // warning all start counting from the moment the guest does
  if (next === "booting" && emuState !== "booting") hudReset();
  // an EXIT report has just said that the emulator stopped
  if (next !== emuState && !(next === "idle" && exitReport)) say(STATE_SAY[next]);
  emuState = next;
  if (next === "running" || next === "paused") startUptime();
  else stopUptime();
  render();
}

function startUptime() {
  if (uptimeTimer) return;
  uptimeTimer = setInterval(() => {
    if (emuState === "running" || emuState === "paused") showPillText();
  }, 1000);
}
function stopUptime() { clearInterval(uptimeTimer); uptimeTimer = 0; }

// The pill has room for "Error" and no more; the screen is where the page
// has always said what went wrong, and it is the one surface both layouts
// give the whole width to.
function setError(msg, { block = false } = {}) {
  errorMsg = msg;
  if (block) startBlocked = true;
  showOverlay("Failed", msg);
  render();
  say(`Error: ${msg}`);
}

/* ------------------------------------------------------------------ */
/* bottom sheets                                                      */
/* ------------------------------------------------------------------ */

const scrim = $("sheet-scrim");
let openSheetEl = null, sheetOpener = null;
// the sheet whose close animation is still running, and its timer
let closingSheet = null, closeTimer = 0;

// tab stops only: the unchecked segment and a locked summary are tabindex -1
const FOCUSABLE = 'a[href], button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), ' +
  'select:not(:disabled), textarea:not(:disabled), summary:not([tabindex="-1"]), ' +
  '[tabindex]:not([tabindex="-1"])';

function openSheet(el, opener) {
  if (openSheetEl) closeSheet(true);
  // a close still animating must not hide what opens now
  clearTimeout(closeTimer);
  if (closingSheet && closingSheet !== el) closingSheet.hidden = true;
  closingSheet = null;
  openSheetEl = el;
  sheetOpener = opener ?? null;
  // aria-modal in fact: the panels are in the sheet, the page behind is out
  // of reach (the phone's physical keys are handled on window and still work)
  mainEl.inert = true;
  el.hidden = false;
  scrim.hidden = false;
  requestAnimationFrame(() => {
    el.classList.add("open");
    scrim.classList.add("open");
  });
  (el.querySelector(FOCUSABLE) ?? el).focus?.();
}

function closeSheet(immediate = false) {
  const el = openSheetEl;
  if (!el) return;
  openSheetEl = null;
  mainEl.inert = false;
  el.classList.remove("open");
  scrim.classList.remove("open");
  el.style.transform = "";
  const done = () => { el.hidden = true; scrim.hidden = true; closingSheet = null; };
  clearTimeout(closeTimer);
  if (immediate) done();
  else { closingSheet = el; closeTimer = setTimeout(done, 240); }
  sheetOpener?.focus?.();
  sheetOpener = null;
}

scrim.addEventListener("click", () => closeSheet());
for (const el of document.querySelectorAll(".sheet [data-close]")) {
  el.addEventListener("click", () => closeSheet());
}

document.addEventListener("keydown", (e) => {
  if (!openSheetEl) return;
  if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
  if (e.key !== "Tab") return;
  const items = [...openSheetEl.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// swipe the sheet down to close it (the handle and the title are the grip;
// the body scrolls instead)
for (const sheet of document.querySelectorAll(".sheet")) {
  // dy is the last move's: a pointercancel carries no position of its own
  let y0 = null, dy = 0;
  const grip = (e) => e.target.closest(".sheet-handle, .sheet-title") || e.target === sheet;
  sheet.addEventListener("pointerdown", (e) => {
    if (!grip(e)) return;
    y0 = e.clientY;
    dy = 0;
    sheet.style.transition = "none";
  });
  sheet.addEventListener("pointermove", (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) {
    sheet.addEventListener(t, () => {
      if (y0 == null) return;
      y0 = null;
      sheet.style.transition = "";
      sheet.style.transform = "";
      if (dy > 80) closeSheet();
    });
  }
}

$("status-open").addEventListener("click", (e) => openSheet($("sheet-firmware"), e.currentTarget));
$("btn-settings").addEventListener("click", (e) => openSheet($("sheet-settings"), e.currentTarget));

/* ------------------------------------------------------------------ */
/* layout: the two panels flank the phone, or live in the sheets        */
/* ------------------------------------------------------------------ */

// The phone column is the same view at every size (style.css); what changes
// is only where the two control panels live. Below the three-column
// breakpoint — and on any window too short to put them beside the phone —
// they are bottom sheets, which is a different place in the DOM and so the
// one layout decision that cannot be a stylesheet rule. It must agree with
// the `width >= 900px` block in style.css; range syntax, so that a fractional
// viewport (browser zoom) falls on one side of each breakpoint.
const phoneLayout = matchMedia("(width < 900px), (height < 621px)");
const mainEl = document.querySelector("main");
const phonePanel = document.querySelector(".phone-panel");

function applyLayout() {
  if (phoneLayout.matches) {
    $("sheet-firmware-body").appendChild($("pre-panel"));
    $("sheet-settings-body").appendChild($("post-panel"));
  } else {
    closeSheet(true);
    mainEl.insertBefore($("pre-panel"), phonePanel);
    mainEl.appendChild($("post-panel"));
  }
  render(); // the pill says different things in the two layouts
}
phoneLayout.addEventListener("change", applyLayout);

/* ------------------------------------------------------------------ */
/* device list                                                          */
/* ------------------------------------------------------------------ */

// board id -> its LCD0 panel size, read out of the board configs (they are
// the device profile: `[peripheral.LCD0] width/height`, possibly on the
// include the board `extends`). The phone layout sizes the screen box to
// this ratio, so the canvas fills it without letterboxing.
const panelCache = new Map();

function panelFor(dev) {
  if (!dev) return null;
  if (!panelCache.has(dev)) panelCache.set(dev, readPanel(dev + ".toml"));
  return panelCache.get(dev);
}

// Upstream siemens-el71.toml declares model = "E71", the same as
// siemens-e71.toml, so the two boards would render under one name.
const BOARD_NAME_FIXUPS = { "siemens-el71": "BenQ-Siemens EL71" };

function boardLabel(dev) {
  return BOARD_NAME_FIXUPS[dev] ?? readBoardName(dev + ".toml") ?? dev;
}

window.__boardCpu = boardCpu;   // tools/ui-acceptance.mjs

/* ---- GSM network ---- */

// Does a run of this board get the GSM network, qemu's built-in cell
// (gsm-bts)? Advanced ▸ GSM network, on unless unticked, and only a board
// whose config has a transceiver: on the others the option does nothing.
function gsmFor(device) {
  return $("gsm").checked && !!device && gsmBoardHasRadio(device);
}

// What a run boots with: the board's own default accessory, the data cable.
// Every phone board has a transceiver since bsp 191612c, and with anything
// else plugged in at boot the firmware goes into a deep sleep the SCCU model
// does not bring it back from: an EL71 with the music cable, GSM or not,
// stops answering keys at its first wizard (doc/gsm-network.md). Sound plays
// with the data cable too, and the Accessory control plugs anything else in.
function bootAccessory(conf) {
  return conf?.default ?? null;
}

async function loadBoards() {
  const res = await fetch("dist/boards.tar");
  if (!res.ok) throw new Error(`dist/boards.tar: HTTP ${res.status}`);
  boardsBuf = await res.arrayBuffer();
  const files = [];
  untar(boardsBuf, (name, data) => files.push({ name, data }));
  const dec = new TextDecoder();
  for (const f of files) {
    if (f.name.endsWith(".toml")) boardText.set(f.name, dec.decode(f.data));
  }
  // only what the page can run: a board without a display stops at start-up
  boards = files
    .filter((f) => /^[^/]+\.toml$/.test(f.name))
    .map((f) => ({ id: f.name.replace(/\.toml$/, ""), file: f }))
    .filter((b) => boardHasDisplay(b.id));
  const sel = O.device;
  // the placeholder stays selected — no device is picked for the user
  const placeholder = sel.querySelector('option[value=""]');
  // the value stays the board id (every tool and test keys off it); only what
  // the user reads changes, and the order follows what they read
  sel.replaceChildren(placeholder, ...boards
    .slice()
    .map((b) => ({ id: b.id, label: boardLabel(b.id) }))
    .sort((a, z) => a.label.localeCompare(z.label))
    .map((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.label;
      return opt;
    }));
  // A fullflash picked before boards.tar arrived (slow link) could not set
  // the device — apply the deferred inference now that the options exist.
  if (pendingDevice) {
    const dev = pendingDevice;
    pendingDevice = null;
    applyDevice(dev);
    renderOwn();
  }
  acc = null; // drawn before the configs were here
  render();
  setAspect(); // the panel size (and so the screen box) is known now
}

// Fullflash sidecars (SIDE_CAR_RE) are documented in fullflashes.js:
// qemu derives <fullflash>.cfi-{efa,otp0,otp1} paths from the pflash
// filename (in MEMFS: /data/fullflash.bin.cfi-*).
const FULLFLASH_PATH = "/data/fullflash.bin";

// device id -> on-screen keyboard (ids from DEVICE_RULES): phones with a
// keypad of their own get it, the rest fall back to the family board — the
// KE800 one for LG (side keys, no joystick block), the generic Siemens one
// for everything Siemens. Only the keyboard is inferred — the letter variant
// is the user's own choice and rides along unchanged.
function inferKeyboard(dev) {
  if (dev === "siemens-s75") return "s75";
  if (dev === "lg-ke970") return "ke970";
  if (dev?.startsWith("lg-")) return "ke800";
  if (dev?.startsWith("siemens-")) return "siemens";
  return null;
}

// follow the device: picking one in the dropdown (or having it inferred from
// a fullflash) switches the on-screen keypad to that phone's
function syncKeyboardToDevice(dev) {
  const kbd = inferKeyboard(dev);
  if (kbd && kbd in KBD_KEYBOARDS && kbd !== kbdSel.value) {
    kbdSel.value = kbd;
    selectKeyboard();
  }
}

// Device + on-screen keyboard inference from a fullflash filename (the user
// can still change the dropdown).
function applyFullflashName(name) {
  const dev = inferDevice(name, { whole: true });
  applyDevice(dev);
  return !!dev;
}

// false when the device is a board the page cannot run
function applyDevice(dev) {
  if (dev) {
    if (boards.some((b) => b.id === dev)) O.device.value = dev;
    else if (boardText.has(dev + ".toml")) {
      O.device.value = "";
      setNote(O.devNote, "warn",
        `${boardLabel(dev)} has no display in its board config, so it cannot run here.`);
      refreshSiemensKeys();
      return false;
    } else if (boardsReady) pendingDevice = dev; // boards.tar still loading
  }
  syncKeyboardToDevice(dev);
  refreshSiemensKeys();
  setAspect(); // a different phone, a different screen ratio
  return true;
}

// The filename is the cheap answer; when it gives nothing away (dump.bin,
// backup_2006.bin) the image itself says which phone it came off. Its answer
// is dropped when the user picks a device by hand while the image is read,
// and when a Start came first: the device and keyboard never change under a
// boot or a live guest.
async function applyFullflashFile(file) {
  if (applyFullflashName(file.name)) return;
  setNote(O.devNote, null, "Detecting device…");
  const picks = devicePicks;
  // the library's board is taken whenever boards.tar has it
  if (boardsReady) await boardsReady;
  const hit = await detectDevice(file, (dev) => boardText.has(dev + ".toml"));
  if (ownBin !== file) return;   // the user moved on while we were reading
  if (devicePicks !== picks) return; // the pick cleared the note already
  if (emuState !== "idle") { setNote(O.devNote, null, ""); return; }
  if (!hit) {
    setNote(O.devNote, null, "Couldn't detect the device — please choose it below.");
    return;
  }
  if (!hit.device) {
    setNote(O.devNote, "warn",
      `Detected ${hit.model}, which has no board yet — please choose the closest device below.`);
    return;
  }
  if (!applyDevice(hit.device)) { render(); return; }
  // the sidecar warning outranks a detection note: it is about a mistake
  if (!warnEfaDevice()) {
    setNote(O.devNote, hit.exact ? null : "warn",
      hit.exact ? "" : `Detected ${hit.model} — running it as ${boardLabel(hit.device)}.`);
  }
  renderOwn();
  render();
}

/* ------------------------------------------------------------------ */
/* boot / stop                                                          */
/* ------------------------------------------------------------------ */

/* ?suite=<url>: the guest op-suite (tests/tcg-isa) —
 * boot -M versatilepb with the raw image fetched from <url> (built by
 * tests/tcg-isa, installed to dist/tcgisa.bin) instead of a phone: the
 * suite prints TAP + value dumps on the PL011 and then parks, since a
 * semihosting exit from the vCPU thread would tear the page down first;
 * tools/tcgisa.mjs reads the serial log up to its "# result:" line. */
/* ?dist=<dir>: which build output to run (default dist/; tools point
 * this at side-by-side builds).  boards.tar is always served from dist/.
 * Only a directory name under site/ is taken, anything else blocks Start;
 * the wasm fetch and the loader import both resolve against ENGINE_DIR,
 * since fetch() and import() resolve a free-form value differently. */
const DIST_DEFAULT = "dist";
const DIST = QS.get("dist") || null;
const DIST_OK = !DIST || (/^[\w.-]+$/.test(DIST) && !/^\.\.?$/.test(DIST));
const ENGINE_DIR = new URL(`${DIST_OK && DIST || DIST_DEFAULT}/`, import.meta.url);
const engineUrl = (file) => new URL(file, ENGINE_DIR).href;
// ?suite= likewise takes only a file under the site, the way the tools name
// it (dist/tcgisa.bin): the page boots it at load, with no click
const SUITE = QS.get("suite") || null;
const SUITE_URL = (() => {
  if (!SUITE || SUITE.split(/[/\\]/).includes("..")) return null;
  try {
    const u = new URL(SUITE, import.meta.url);
    return u.origin === location.origin
      && u.pathname.startsWith(new URL(".", import.meta.url).pathname) ? u.href : null;
  } catch { return null; }
})();

/* ---- engine prefetch ------------------------------------------------ */
/* The qemu wasm (~12 MB, ~4 on the wire) is the long pole of a first
 * Start, so it is fetched and compiled in the background once the page
 * itself is up (kick-off lives in the startup section at the bottom). A
 * Start that lands before the download is over rides the very same
 * in-flight fetch out — Cancel aborts it — and a prefetch that fails
 * outright costs nothing: boot falls back to the emscripten loader
 * fetching for itself, the pre-prefetch behaviour. The compiled module is
 * handed to the factory through Module.instantiateWasm, so a ready
 * prefetch means instantiation only at Start — and emscripten posts the
 * module to the pthread workers exactly as it would its own. */
let engineSt = null;    // the in-flight prefetch: { ctl, promise, loaded, total }
let engineMod = null;   // the compiled WebAssembly.Module, once it is in

function startEngine() {
  if (engineMod || engineSt) return engineSt; // single-flight
  const ctl = new AbortController();
  const st = { ctl, loaded: 0, total: 0 };
  st.promise = (async () => {
    const url = engineUrl("qemu-system-arm.wasm");
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    // a gzipped body (serve.mjs' sidecar) decodes to more bytes than
    // content-length says, so a total — and with it a percent — only
    // exists when the response is uncompressed; otherwise the byte
    // counter runs without one
    st.total = res.headers.get("content-encoding") ? 0
      : Number(res.headers.get("content-length")) || 0;
    // the response itself compiles while the body streams in, so Chrome
    // can cache the compiled code under its URL (a new Response() has none
    // and every load would start in the baseline tier); a clone only
    // counts bytes for the pill and the overlay
    const forCount = res.clone().body;
    const count = (async () => {
      const rd = forCount.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) return;
        st.loaded += value.byteLength;
        engineTick();
      }
    })();
    count.catch(() => {}); // a failed fetch errors the response and its clone
    try {
      return await WebAssembly.compileStreaming(res);
    } finally {
      // the compile is what failed: stop draining the counter branch (on
      // success this is a no-op on an exhausted stream)
      forCount.cancel().catch(() => {});
    }
  })()
    .then((m) => {
      engineMod = m;
      // clear before render(): the pill must not read a finished
      // prefetch as a live one (the .finally only runs after this, and
      // nothing re-renders between the two)
      if (engineSt === st) engineSt = null;
      try { render(); } catch (e) { console.error("[engine] render:", e); }
      return m;
    })
    .finally(() => { if (engineSt === st) engineSt = null; });
  st.promise.catch(() => {}); // the background kick starts this unawaited
  engineSt = st;
  return st;
}

// Live prefetch state for drivers/debugging (null: not started, "ready":
// compiled and cached, otherwise the in-flight byte counters).
window.__engine = () => engineSt
  ? { loaded: engineSt.loaded, total: engineSt.total }
  : engineMod ? "ready" : null;

// Progress surfaces: the pill, and while boot() waits the download out,
// the overlay bar too. Direct text writes, not render() — this fires once
// per received chunk.
function engineTick() {
  const st = engineSt;
  if (!st) return;
  if (dlWhat === "engine") {
    dlLoaded = st.loaded;
    dlTotal = st.total;
    showPillText();
    const pct = st.total ? Math.round((st.loaded / st.total) * 100) : null;
    $("ov-sub").textContent = st.total ? fmtProgress(st.loaded, st.total)
      : fmtMiB(st.loaded);
    overlayBar.hidden = pct == null;
    if (pct != null) overlayBar.firstElementChild.style.width = pct + "%";
  } else if (emuState === "idle" && !phoneLayout.matches) {
    showPillText();
  }
}

// What boot() calls before importing the loader: the prefetched module,
// or the rest of the in-flight download with pill, overlay and Cancel on
// it. Returns null after a non-abort failure (boot falls back to the
// loader's own fetch); rethrows AbortError for boot()'s cancelled path.
async function ensureEngine() {
  if (engineMod) return engineMod;
  const st = startEngine();
  engineAbort = st.ctl;
  dlWhat = "engine";
  dlLoaded = st.loaded;
  dlTotal = st.total;
  setEmuState("downloading");
  showOverlay("Downloading emulator", fmtMiB(st.loaded));
  engineTick();
  try {
    return await st.promise;
  } catch (e) {
    // an aborted compileStreaming rejects with a TypeError ("network
    // error"), not an AbortError — the signal is the authoritative check
    if (st.ctl.signal.aborted || e?.name === "AbortError") {
      engineCancelled = true;
      throw e;
    }
    console.warn("[engine] prefetch failed — fetching at boot instead:", e);
    return null;
  } finally {
    engineAbort = null;
    dlWhat = "fullflash";
    setEmuState("booting");
  }
}

// Module.instantiateWasm for a factory call: hand it the prefetched,
// already-compiled module. The success callback takes (instance, module)
// — the module is what emscripten keeps and posts to the pthread workers.
// The loader gives instantiateWasm no way to fail, so a failure goes to
// fail(), which startQemu() turns into a rejection.
const engineInstantiate = (mod, fail) => mod ? {
  instantiateWasm: (imports, receive) => {
    // instantiate(Module, imports) resolves to the Instance itself (the
    // {module, instance} shape is the bytes overload)
    WebAssembly.instantiate(mod, imports)
      .then((instance) => receive(instance, mod), fail);
  },
} : {};

// The loader parks the page thread's pthread mailbox in an Atomics.waitAsync
// on the engine heap that nothing notifies once the guest has exited, and a
// pending wait keeps its Module and the 2 GiB heap reachable for the life of
// the page. The latest wait on each heap is recorded so that releaseHeap()
// can settle it at exit; the woken loader re-arms at once, so a released
// heap gets an inert wait instead of a real one.
const heapWaits = new WeakMap();      // heap SharedArrayBuffer -> [view, index]
const releasedHeaps = new WeakSet();
if (typeof Atomics.waitAsync === "function") {
  const waitAsync = Atomics.waitAsync;
  Atomics.waitAsync = function (view, index) {
    if (releasedHeaps.has(view.buffer)) return { async: true, value: new Promise(() => {}) };
    const w = Reflect.apply(waitAsync, Atomics, arguments);
    if (w.async) heapWaits.set(view.buffer, [view, index]);
    return w;
  };
}

function releaseHeap(mod) {
  const heap = mod?.HEAPU8?.buffer;
  if (!heap) return;
  releasedHeaps.add(heap);
  const w = heapWaits.get(heap);
  heapWaits.delete(heap);
  if (w) Atomics.notify(w[0], w[1]);
}

// Starts qemu for both boot paths: factory and engine are the build's
// module factory and its prefetched module, opts more Module settings,
// setup(mod) fills MEMFS and the environment before main(), and
// report(read, code) hands logs out on exit — read(path) gives a MEMFS file
// or null — before the page's own exit handling. A prefetched module that
// does not instantiate (one fetched before a deploy no longer fits the
// loader) is dropped, and the factory is called once more without it, so
// the loader fetches the engine itself.
class EngineInstantiateError extends Error {}

async function launch(spec) {
  if (!spec.engine) return startQemu(spec);
  try {
    return await startQemu(spec);
  } catch (e) {
    if (!(e instanceof EngineInstantiateError)) throw e;
    console.warn("[engine] the prefetched engine did not instantiate — fetching it at boot instead:", e.cause);
    if (engineMod === spec.engine) engineMod = null;
    checkCancel();
    return startQemu({ ...spec, engine: null });
  }
}

// The engine's pthread workers, per factory call: the loader starts its pool
// (new Worker, four times) before its first await, and adds more whenever
// the guest creates a thread beyond it. A call that never starts its guest
// would leave them running, holding its Module and heap, for the life of the
// page, and a guest whose threads have died can only be ended by
// terminating them (forceStop).
let enginePool = null;   // the list of the factory call under way or live
const engineWorkers = new WeakMap();   // Module -> its workers
{
  const Worker = window.Worker;
  window.Worker = new Proxy(Worker, {
    construct(target, args) {
      const w = Reflect.construct(target, args);
      if (enginePool && /qemu-system-arm/.test(String(args[0]))) enginePool.push(w);
      return w;
    },
  });
}
// modules ended by forceStop(): an onExit that still comes is not news
const forcedModules = new WeakSet();

function startQemu({ factory, engine, args, opts, setup, report }) {
  let modRef = null; // FS access in onExit (qemuModule not yet assigned)
  let fail = null;
  const failed = new Promise((_, reject) => {
    fail = (e) => reject(new EngineInstantiateError(String(e), { cause: e }));
  });
  const pool = enginePool = [];
  const started = factory({
    arguments: args,
    ...engineInstantiate(engine, fail),
    ...opts,
    onExit: (code) => {
      if (forcedModules.has(modRef)) return;
      // before the runtime tears the page down
      if (modRef) {
        const read = (p) => {
          try { return new TextDecoder("latin1").decode(modRef.FS.readFile(p)); }
          catch { return null; }
        };
        try { report(read, code); } catch (e) { /* page going down anyway */ }
      }
      onGuestExit(code);
      releaseHeap(modRef);
    },
    preRun: (mod) => {
      modRef = mod;
      engineWorkers.set(mod, pool);
      tapSerial(mod);   // every byte the guest prints, as it prints it
      setup(mod);
      // ?env=NAME=VAL (repeatable): extra environment — e.g.
      // env=QEMU_COSTACK=1 logs the stacks a coroutine switch unwinds
      for (const kv of QS.getAll("env")) {
        const i = kv.indexOf("=");
        if (i > 0) mod.ENV[kv.slice(0, i)] = kv.slice(i + 1);
      }
    },
  });
  // a failed start (its factory promise rejects, or the prefetched engine
  // did not instantiate and the call never settles) ends its pool before
  // launch() retries or reports it
  return (engine ? Promise.race([started, failed]) : started).catch((e) => {
    for (const w of pool.splice(0)) w.terminate();
    throw e;
  });
}

let exitCode = null;

// The catch of boot() and bootSuite(): true when e is a Stop or Cancel
// before the guest was live, which it reports.
function startCancelled(e) {
  if (e === BOOT_CANCELLED) {
    showOverlay("Ready to boot", "Start cancelled");
  } else if (e?.name === "AbortError" || engineCancelled) {
    // a cancelled preset keeps whatever files finished; the engine's
    // partial fetch leaves nothing behind
    showOverlay("Ready to boot", engineCancelled
      ? "Download cancelled"
      : "Download cancelled — whatever finished stays cached");
    engineCancelled = false;
  } else {
    return false;
  }
  return true;
}

async function bootSuite(url) {
  errorMsg = null;
  exitCode = null;
  clearExit();
  serialTapped = false;
  ranDevice = null;       // not a phone: nothing here can EXIT
  ranFlashName = null;
  bootCancelled = false;
  setEmuState("booting");
  showOverlay("Loading suite…");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    checkCancel();
    const engineWasmMod = await ensureEngine();
    checkCancel();
    const factory = (await import(engineUrl("qemu-system-arm.js"))).default;
    checkCancel();
    /* ?icount=1: the icount timing model — measures the icount
     * tax on the tcgbench workload (TB icount-capping + accounting +
     * virtual-timer runs) against the same run without it */
    const icount = QS.get("icount") === "1";
    // the last run's module must not hold its heap while the loader allocates
    // this one's
    qemuModule = null;
    window.__qemu = null;
    qemuModule = await launch({
      factory,
      engine: engineWasmMod,
      args: [
        "-display", "wasm",
        "-M", "versatilepb",
        "-kernel", "/data/tcgisa.bin",
        "-semihosting",
        ...(icount ? ["-icount", "shift=3,sleep=off"] : []),
        "-serial", "file:/serial.log",
        "-monitor", "none",
        "-parallel", "none",
      ],
      opts: { printErr: (t) => console.log("[qemu]", t) },
      // the headless runner installs window.__suiteReport
      report: (read, code) => {
        const ser = read("/serial.log");
        if (ser != null) window.__suiteReport?.(ser, code);
      },
      setup: (mod) => {
        mod.FS.mkdirTree("/data");
        mod.FS.writeFile("/data/tcgisa.bin", bytes);
      },
    });
    hideOverlay();
    window.__qemu = qemuModule; // debugging hook (same as the phone boot)
    startSerial();
    running = true;
    runStartedAt = Date.now();
    setEmuState("running");
    refreshTyping();
  } catch (e) {
    setEmuState("idle");
    if (!startCancelled(e)) {
      console.error(e);
      setError(String(e));
    }
    return;
  }
  // Stop came while the factory was starting the guest: stop it the usual way
  if (bootCancelled) stop();
}

// The 2^32 ESN sweep, with the progress and Cancel a minutes-long wait needs.
// Returns null when it was cancelled or the space held no answer (the caller
// has already been told why).
async function runEsnRecovery(identity, device) {
  esnAbort = new AbortController();
  setEmuState("recovering");
  esnPct = 0;
  const cores = workerCount();
  showOverlay("Recovering ESN…",
    `${cores} core${cores > 1 ? "s" : ""} · up to 4.3 billion candidates`, 0);
  try {
    const found = await recoverEsn(identity, {
      signal: esnAbort.signal,
      onProgress: (frac) => {
        esnPct = Math.round(frac * 100);
        showPillText();
        showOverlay("Recovering ESN…", `${esnPct}% of the ESN space searched`, esnPct);
      },
    });
    if (esnAbort.signal.aborted) {
      setEmuState("idle");
      showOverlay("Ready to boot", "ESN recovery cancelled");
      return null;
    }
    if (!found) {
      setEmuState("idle");
      setError("No ESN produces the keys stored in this fullflash — the whole " +
        "space was searched. Pick “Automatically recalculate keys” instead.");
      return null;
    }
    setEmuState("booting");
    return found;
  } finally {
    esnAbort = null;
  }
}

async function boot() {
  if (!DIST_OK) return;   // the overlay already says why
  // guest op-suite mode: no fullflash, no boards.tar needed
  if (SUITE) {
    if (SUITE_URL) await bootSuite(SUITE_URL);
    return;   // otherwise the overlay already says why
  }

  if (!firmwareReady()) { render(); return; }

  // boards.tar populates the device list and feeds preRun's untar — never
  // start a boot that could race it (device inference would be lost and
  // qemu would get an empty board dir).
  // the state is still idle here, so Start is still there to click again
  if (boardsReady) {
    if (startWaiting) return;
    startWaiting = true;
    try { await boardsReady; } finally { startWaiting = false; }
  }
  if (!boardsBuf) {
    setError("boards.tar failed to load — reload the page", { block: true });
    return;
  }
  // the wait can have changed that: the file cleared, or the device the
  // name gave turned out to be a board without a display
  if (!firmwareReady()) { render(); return; }

  const device = currentDevice();
  const preset = selectedPreset;
  // "as-is" wherever the radio is not offered: a non-Siemens board (only
  // Siemens firmware binds itself to the flash ESN) or a preset, which the
  // inventory publishes already recalculated
  const keyMode = siemensKeysApply() ? siemensMode() : "as-is";
  // the identity is the image's own in recover-esn mode, so the two fields
  // are disabled there and only read in the modes that use them
  let imei = $("imei").value.trim();
  let esn = $("esn").value.trim();
  const sim = $("sim").value;
  const operator = $("operator").value.trim();
  const startup = $("startup").value;

  if (keyMode !== "recover-esn") {
    if (!/^\d{15}$/.test(imei)) { setError("IMEI must be 15 digits"); return; }
    if (!/^[0-9A-Fa-f]{8}$/.test(esn)) { setError("ESN must be 8 hex chars"); return; }
  }
  if (sim === "virtual" && !/^\d{5,6}$/.test(operator)) {
    setError("Operator must be 5 or 6 digits (MCC + MNC)"); return;
  }

  const debug = QS.get("debug") === "1";

  errorMsg = null;
  exitCode = null;
  clearExit();            // a new run, a screen that is lit again
  serialTapped = false;   // until this run's preRun says otherwise
  // The last run's exports stay until this run replaces its image (launch
  // below): a Start that fails or is cancelled before that leaves them be.
  const flashName = ffMode === "own"
    ? ownBin?.name ?? null
    : preset?.files[0] ?? null;
  let report = null;
  bootCancelled = false;
  setEmuState("booting");
  showOverlay("Loading…");

  // [[".cfi-efa", bytes], ...] — filled below, checked again after the boot
  let sidecarBytes = [];
  let gsm = false;

  try {
    // Boot source: the preset read back from the browser cache, or the
    // picked local files. Both yield { name, arrayBuffer() } objects (the
    // preset one wraps the cached bytes).
    let file, sidecars;
    if (ffMode === "preset") {
      // First Start with this preset: download it into the browser cache
      // (live progress; later boots come straight from the cache).
      const st = await entryCacheState(preset);
      checkCancel();
      // the files from memory when the browser would not cache them
      let fetched = null;
      if (!st.complete) {
        presetBusy = true;
        // a 64 MiB fullflash is a long wait — Cancel stops it (the catch
        // below turns the AbortError into a plain "cancelled")
        downloadAbort = new AbortController();
        dlLoaded = 0;
        dlTotal = preset.size;
        dlWhat = "fullflash";
        setEmuState("downloading");
        await refreshPresetUi(); // say so on the preset line before byte one
        let doneBytes = 0, curFile = null, curTotal = 0;
        try {
          fetched = await downloadEntry(preset, (name, loaded, total) => {
            if (name !== curFile) { doneBytes += curTotal; curFile = name; }
            curTotal = total;
            dlLoaded = doneBytes + loaded;
            dlTotal = preset.size || (doneBytes + total);
            const pct = dlTotal ? Math.round((dlLoaded / dlTotal) * 100) : null;
            // straight to the three elements that move: this fires once per
            // stream chunk, far too often for a cache-state refresh
            showPillText();
            P.status.className = "ff-status";
            P.status.textContent = `Downloading · ${fmtProgress(dlLoaded, dlTotal)}`;
            P.bar.hidden = false;
            P.bar.firstElementChild.style.width = (pct ?? 0) + "%";
            showOverlay("Downloading fullflash",
              `${name}\n${fmtProgress(dlLoaded, dlTotal)}`, pct);
          }, downloadAbort.signal);
        } finally {
          presetBusy = false;
          downloadAbort = null;
        }
        setEmuState("booting");
        await refreshPresetUi();
        checkCancel();
      }
      if (fetched) {
        say(`${preset.files[0]} is not cached: the browser would not store it`);
        console.warn("[preset] not cached, booting from memory:", preset.id);
      }
      showOverlay("Reading fullflash…");
      const cached = fetched ?? await readCachedEntry(preset); // main .bin first
      const shim = (f) => ({ name: f.name, arrayBuffer: async () => f.bytes.buffer });
      file = shim(cached[0]);
      sidecars = cached.slice(1).map(shim);
    } else {
      file = ownBin;
      // a sidecar picked for a non-LG device is kept in the UI but
      // never handed to the emulator
      sidecars = ownEfa && device.startsWith("lg-") ? [ownEfa] : [];
    }

    // The engine wasm is normally prefetched and compiled by now (the
    // background download starts once the page is up); a Start that beat
    // it waits the rest of the download out inside ensureEngine.
    checkCancel();
    const engineWasmMod = await ensureEngine();
    checkCancel();
    // Compile the factory fresh per boot (the emscripten ES6 factory is
    // single-use once main() has run through exit()).
    showOverlay("Loading emulator…");
    const factory = (await import(engineUrl("qemu-system-arm.js"))).default;
    checkCancel();
    showOverlay("Booting…", device);

    let flashBytes = new Uint8Array(await file.arrayBuffer());
    checkCancel();

    // Advanced ▸ Siemens keys. The image only ever lives in this run's
    // MEMFS, so "recalculate" changes this copy and the one Export ▸ Flash
    // hands back — never the preset cache or the file on disk.
    if (keyMode === "recalc") {
      showOverlay("Recalculating keys…", device);
      const r = await recalc(flashBytes, imei, parseInt(esn, 16));
      report = { mode: keyMode, changed: r.changed, complete: r.complete };
      if (!r.complete) {
        say("Some EEPROM key blocks were not found — booting anyway");
        console.warn("[recalc]", r.log);
      }
      if (r.changed) say(`Recalculated the keys for ESN ${esn}`);
    } else if (keyMode === "recover-esn") {
      showOverlay("Reading fullflash keys…", device);
      const identity = await readIdentity(flashBytes);
      if (!identity.ok) {
        setEmuState("idle");   // no guest was ever started
        setError("This fullflash carries no intact keys to recover an ESN from — " +
          "pick “Automatically recalculate keys” instead.");
        return;
      }
      checkCancel();
      const found = await runEsnRecovery(identity, device);
      if (!found) return;   // cancelled, or the whole space held no answer
      imei = identity.imei;
      esn = (found.esn >>> 0).toString(16).padStart(8, "0");
      $("imei").value = imei;   // show what the image actually boots with
      $("esn").value = esn;
      report = { mode: keyMode, esn, cached: found.cached, seconds: found.seconds };
      say(`ESN ${esn}${found.cached ? " (remembered)" : ""}`);
      refreshSiemensKeys();
      showOverlay("Booting…", device);
    }
    checkCancel();

    const otp0 = esnToOtp0(esn);
    const otp1 = imeiToOtp1(imei);

    for (const sc of sidecars) {
      const suffix = sc.name.match(SIDE_CAR_RE)[0].toLowerCase();
      if (sidecarBytes.some(([s]) => s === suffix)) continue; // first one wins
      sidecarBytes.push([suffix, new Uint8Array(await sc.arrayBuffer())]);
    }
    checkCancel();

    // qemu stderr -> browser console, deduped (madvise/mprotect spam otherwise).
    // ?tracebuf=1 keeps the raw last lines in window.__qemulog instead (no CDP flood).
    const seenMsg = new Map();
    const tracebuf = QS.get("tracebuf") === "1";
    const logBuf = tracebuf ? [] : null;
    window.__qemulog = logBuf;
    const printErr = (t) => {
      // Kept whether or not ?tracebuf=1 is on: when the guest stops dead
      // these are the only account of why, and a phone has no console to
      // read them back from (the stall report). qemu ends most messages with
      // a newline of their own, so blank lines would be most of the window.
      if (t.trim()) {
        logTail.push(t);
        if (logTail.length > 40) logTail.shift();
      }
      if (tracebuf) {
        logBuf.push(t);
        if (logBuf.length > 30000) logBuf.splice(0, 10000);
        return;
      }
      if (debug) { console.log("[qemu]", t); return; }
      const n = (seenMsg.get(t) ?? 0) + 1;
      // with ?trace= every line is distinct
      if (n === 1 && seenMsg.size >= 4096) seenMsg.clear();
      seenMsg.set(t, n);
      if (n === 1 || n % 500 === 0) console.log(`[qemu${n > 1 ? " x" + n : ""}]`, t);
    };

    // Timing model: TCG vcpu-timers — the virtual clock counts guest CPU
    // cycles at the CGU's CPU clock and virtual timers run on the vCPU
    // thread, paced to wall time like the real phone. A slow host slows the
    // clock rather than starving firmware timing budgets.
    // ?bank=<s>: for the guest's first <s> seconds (default 30, the boot)
    // time lost to the host is caught up instead of dropped; 0 = never.
    // ?idlelead=<us>: while the guest waits for an interrupt its timers run
    // in batches up to <us> (default 2000) ahead of wall time, one host sleep per batch
    // instead of one per timer; 0 = follow wall time exactly.
    // ?icount=<spec> selects the instruction-counting model instead (the
    // lockstep tools need its determinism); ?icount=none runs neither.
    // cross-page-links=on chains TBs across guest pages (unlinked on every
    // TLB flush): EL71 boot window -5.8 %, steady state neutral to +1 %.
    // A ?qargs= with its own -accel replaces the default one.
    const icount = QS.get("icount");
    const bank = QS.get("bank") ?? "30";
    const idleLead = QS.get("idlelead") ?? "2000";
    const trace = QS.get("trace");
    const extraArgs = (QS.get("qargs") ?? "").split(/\s+/).filter(Boolean);
    const timingArgs = icount
      ? (icount === "none" ? [] : ["-icount", icount])
      : extraArgs.includes("-accel") ? []
      : ["-accel", `tcg,thread=multi,vcpu-timers=on,vcpu-timers-bank=${bank},vcpu-timers-idle-lead=${idleLead},cross-page-links=on`];
    // The guest's mixer resamples straight to the output device's own rate,
    // so the worklet copies frames instead of interpolating them. ?sound=off
    // leaves the machine without an audiodev at all: lockstep-wasm uses it,
    // because the native run it is compared with has none. The benchmarks
    // keep sound on.
    const audioArgs = QS.get("sound") === "off"
      ? []
      : ["-audio", `wasm,out.frequency=${audioRate()},out.channels=2`];
    // the card is a device of its own, plugged into the board's empty
    // "iso7816-slot"; a board without one runs with no SIM
    const simSlot = boardHasSimSlot(device);
    const simArgs = simSlot && sim === "virtual"
      ? ["-device", `gsm-sim,operator=${operator}`]
      : [];
    // GSM network (doc/gsm-network.md): on a board that has a radio, qemu
    // gets its built-in cell. Without the option, and on any other board,
    // the machine has no network object at all. The cell's IP side is a hub
    // whose other port is the page (gprs-net.js).
    gsm = gsmFor(device);
    const gsmArgs = gsm
      ? ["-netdev", "hubport,id=net0,hubid=0", "-object", "gsm-bts,id=gsm0,netdev=net0"]
      : [];
    // what the Accessory control shows, chosen there or not
    const accConf = readAccessories(device + ".toml");
    const bootAcc = acc?.dev === device && acc.gsm === gsm
      ? acc.plugged : bootAccessory(accConf);
    const accArgs = accConf && bootAcc && bootAcc !== accConf.default
      ? ["-global", `accessory-connector.accessory=${bootAcc}`]
      : [];
    const args = [
      "-display", "wasm",
      ...audioArgs,
      ...timingArgs,
      "-machine", gsm ? "pmb887x,gsm-network=gsm0" : "pmb887x",
      ...gsmArgs,
      // always writable: the image lives in MEMFS, so the firmware's writes
      // only ever touch this run's copy — and "Export flash" hands that
      // copy back
      "-drive", `if=pflash,format=raw,file=${FULLFLASH_PATH}`,
      "-serial", "file:/serial.log",
      "-monitor", "none",
      // otherwise qemu backs a default parallel port with a hidden text
      // console, which a cursor timer redraws every 250 ms under the BQL
      "-parallel", "none",
      ...simArgs,
      ...accArgs,
      // ?trace=dsp,scu: device log lines and register accesses
      ...(trace ? ["-debug-channels", `log=${trace},io=${trace}`] : []),
      ...extraArgs,
    ];

    // the point of no return: this run's image replaces the last one's
    exportsReady = false;
    keyReport = report;
    ranDevice = device;
    ranFlashName = flashName;
    // the last run's module must not hold its heap while the loader allocates
    // this one's
    qemuModule = null;
    window.__qemu = null;
    qemuModule = await launch({
      factory,
      // the prefetched module, when there is one: instantiation only —
      // no download, no re-compile
      engine: engineWasmMod,
      args,
      opts: {
        printErr,
        onAbort: noteFatal,
        log: debug ? (t) => console.log("[log]", t) : undefined,
      },
      // the lockstep driver installs window.__lockstepReport
      report: (read, code) =>
        window.__lockstepReport?.(read("/serial.log"), read("/lockstep.log"), code),
      setup: (mod) => {
        mod.FS.mkdirTree("/boards");
        untar(boardsBuf, (name, data) => {
          const path = "/boards/" + name;
          mod.FS.mkdirTree(path.split("/").slice(0, -1).join("/"));
          mod.FS.writeFile(path, data);
        });
        mod.FS.mkdirTree("/data");
        // canOwn: MEMFS takes these buffers as they are instead of a copy
        mod.FS.writeFile(FULLFLASH_PATH, flashBytes, { canOwn: true });
        for (const [suffix, bytes] of sidecarBytes)
          mod.FS.writeFile(FULLFLASH_PATH + suffix, bytes, { canOwn: true });
        mod.ENV.PMB887X_BOARD = `/boards/${device}.toml`;
        mod.ENV.PMB887X_STARTUP = startup;
        mod.ENV.PMB887X_FLASH0_OTP0 = otp0;
        mod.ENV.PMB887X_FLASH0_OTP1 = otp1;
        // ?lockstep=1: built-in guest-state fold (wasm64 backend; read by
        // tools/lockstep-wasm.mjs) — env-driven twin of the
        // tests/lockstep.c plugin. Extra ls-* params map to
        // W64_LOCKSTEP_* (insns, period, epoch, meminsns, mem, from, to).
        if (QS.get("lockstep")) {
          mod.ENV.W64_LOCKSTEP = "1";
          for (const k of ["insns", "period", "epoch", "meminsns", "mem", "from", "to"]) {
            const v = QS.get("ls-" + k);
            if (v != null) mod.ENV["W64_LOCKSTEP_" + k.toUpperCase()] = v;
          }
        }
      },
    });
    // the module's onExit keeps setup() and with it this scope alive for the
    // whole run: MEMFS has the image now, so the page lets go of it (not in
    // setup, which launch() may run a second time)
    flashBytes = null;
  } catch (e) {
    setEmuState("idle");
    if (!startCancelled(e)) {
      console.error(e);
      setError(String(e));
    }
    refreshPresetUi(); // a failed preset download changed the cache state
    return;
  }

  // LG firmware without the EFA block factory-resets its EEPROM; warn but boot.
  const noEfa = device.startsWith("lg-") && !sidecarBytes.some(([s]) => s === ".cfi-efa");
  sidecarBytes = null;
  hideOverlay();
  window.__qemu = qemuModule; // debugging hook
  startPainting();
  startSerial();
  running = true;
  exportsReady = true;
  runStartedAt = Date.now();
  noEfaWarning = noEfa;
  setEmuState("running");
  refreshTyping();
  attachAudio();   // needs liveModule(); the worklet loads on its own time
  // a dist built before the export existed runs without the phone's Internet
  if (gsm && qemuModule._wasm_net_attach) {
    gprsNet = new GprsNet(qemuModule, { onChange: onGprsChange });
    window.__gprsNet = gprsNet; // debugging and tools/gprscheck.mjs --web
    gprsNet.start();
    renderGprs();
  }
  // Stop came while the factory was starting the guest: stop it the usual way
  if (bootCancelled) stop();
}

// only trouble is shown: an online phone needs no caption, and a redial
// keeps it up until the link is back
function showGprsStatus() {
  const g = gprsNet;
  const down = g?.reason && (g.state === "offline" || g.state === "connecting");
  const cap = $("gsm-caption");
  cap.textContent = down ? `No GPRS Internet: ${g.reason}` : "";
  cap.hidden = !cap.textContent;
}

/* ---- network badge ---- */
// The pill's network badge (#gprs: an antenna over a bearer tag, what each
// shows is gsm-badge.js's) renders gprs-net.js: the phone's registration
// and GPRS attach as the cell sees them (read there once a second, from the
// relay's own poll) and the relay's link to the gateway. It is written on a
// change of either, from the relay's traffic notices (at most four a
// second) and by a 1 Hz countdown while a redial waits; nothing here runs
// per frame, per key or per paint.
const gprsEl = $("gprs");
const gprsWaitEl = $("gprs-wait");
const gprsLettersEl = gprsEl.querySelector(".gsm-tag-letters");
const gsmStatusEl = $("gsm-status");
const gsmDataEl = $("gsm-data");
const gsmSentEl = $("gsm-sent");
const gsmReceivedEl = $("gsm-received");
const GPRS_LIT_MS = 400;      // how long an arrow stays lit after a notice
const gprsLit = { tx: false, rx: false };
const gprsSeen = { in: 0, out: 0 };
let gprsLitTimer = 0, gprsWaitTimer = 0;
let gprsSaid = "";            // the last announcement, so a redial loop says it once

function onGprsChange(what) {
  if (what === "traffic") gprsTraffic();
  else { showGprsStatus(); renderGprs(); }
}

// what the chip shows: a close that will not be dialled again is "refused"
function gprsShown() {
  const g = gprsNet;
  if (!g || g.state === "off") return "off";
  if (g.state === "offline" && g.retryAt === Infinity) return "refused";
  if (g.state === "online" && (gprsLit.tx || gprsLit.rx)) return "active";
  return g.state;
}

const gprsRetryIn = (g) => g?.state === "offline" && Number.isFinite(g.retryAt)
  ? Math.max(0, Math.ceil((g.retryAt - Date.now()) / 1000)) : 0;

// What the badge stands for (its name, data-state, __ui.gprs.badge): the
// link when there is one or was one (connecting, online, offline,
// refused), else what the cell says of the phone (no network, registered,
// GPRS attached); "idle" on a dist without _wasm_gsm_state, which cannot
// tell those apart. Its antenna follows the cell throughout (gsm-badge.js).
function gprsBadge() {
  const g = gprsNet;
  const link = gprsShown();
  if (link === "active") return "online";
  if (link !== "idle") return link;
  if (g.ms === null) return "idle";
  return g.gprsAttached ? "attached" : g.registered ? "registered" : "nonet";
}

const gsmLine = (g) => g.ms === null ? ""
  : !g.registered && !g.gprsAttached ? "No network"
  : `Registered${g.gprsAttached ? ", GPRS attached" : ", GPRS not attached"}`
    + (g.pdpActive ? ", data context active" : "");

function renderGprs() {
  const g = gprsNet;
  const badge = gprsBadge();
  const label = {
    off: "Network off", idle: "GPRS not used yet", nonet: "No network",
    registered: "Registered on the network, GPRS not attached",
    attached: g?.pdpActive ? "GPRS attached, data context active" : "GPRS attached",
    connecting: "GPRS connecting", online: "GPRS connected",
    offline: `GPRS offline: ${g?.reason}`, refused: `GPRS refused: ${g?.reason}`,
  }[badge];
  if (gprsEl.hidden !== (badge === "off")) gprsEl.hidden = badge === "off";
  if (gprsEl.dataset.state !== badge) gprsEl.dataset.state = badge;
  if (gprsEl.getAttribute("aria-label") !== label) gprsEl.setAttribute("aria-label", label);
  if (badge !== "online") {
    gprsLight(false, false);
    clearTimeout(gprsLitTimer);
    gprsLitTimer = 0;
  }
  const wait = gprsRetryIn(g) > 0;
  if (wait && !gprsWaitTimer) gprsWaitTimer = setInterval(gprsWait, 1000);
  gprsWait();
  if (badge === "off") {
    gprsSaid = "";
    gprsSeen.in = gprsSeen.out = 0;
    return;
  }
  // once per change: a redial loop that fails the same way says it once,
  // traffic says nothing, and the "no network" a run starts with is not news
  const news = {
    registered: "Registered on the network", attached: "GPRS attached", online: "GPRS connected",
    offline: `GPRS offline: ${g.reason}`, refused: `GPRS refused: ${g.reason}`,
    nonet: gprsSaid && "No network",
  }[badge];
  if (news && news !== gprsSaid) say(gprsSaid = news);
}

// What gsm-badge.js says the badge shows: the antenna and the tag, the
// bearer's letters (#gprs's data-bearer), the desktop status line and
// whether the amounts show. Also from the countdown, which the line carries.
function gprsLook(badge = gprsBadge()) {
  const off = badge === "off";
  const v = off ? { status: "", tone: "", amounts: false }
    : badgeView(badge, gprsNet, { retryIn: gprsRetryIn(gprsNet), bearer: gprsEl.dataset.bearer });
  if (!off) {
    if (gprsEl.dataset.net !== v.net) gprsEl.dataset.net = v.net;
    if (gprsEl.dataset.gprs !== v.gprs) gprsEl.dataset.gprs = v.gprs;
    const letters = `#gsm-bearer-${v.bearer}`;
    if (gprsLettersEl.getAttribute("href") !== letters) gprsLettersEl.setAttribute("href", letters);
  }
  if (gsmStatusEl.textContent !== v.status) gsmStatusEl.textContent = v.status;
  if ((gsmStatusEl.dataset.tone ?? "") !== v.tone) gsmStatusEl.dataset.tone = v.tone;
  if (gsmDataEl.hidden !== !v.amounts) gsmDataEl.hidden = !v.amounts;
  gprsAmounts();
}

function gprsAmounts() {
  if (gsmDataEl.hidden) return;
  const sent = kb(gprsNet.bytes.out), received = kb(gprsNet.bytes.in);
  if (gsmSentEl.textContent !== sent) gsmSentEl.textContent = sent;
  if (gsmReceivedEl.textContent !== received) gsmReceivedEl.textContent = received;
}

// the redial countdown, and the status line and title that carry it
function gprsWait() {
  const s = gprsRetryIn(gprsNet);
  const text = s > 0 ? `${s}s` : "";
  if (gprsWaitEl.textContent !== text) gprsWaitEl.textContent = text;
  if (!s && gprsWaitTimer) { clearInterval(gprsWaitTimer); gprsWaitTimer = 0; }
  gprsLook();
  gprsTitle();
}

// each arrow is lit when frames went that way since the last notice
function gprsTraffic() {
  const g = gprsNet;
  if (!g) return;
  const tx = g.frames.out !== gprsSeen.out, rx = g.frames.in !== gprsSeen.in;
  gprsSeen.out = g.frames.out;
  gprsSeen.in = g.frames.in;
  gprsLight(tx, rx);
  clearTimeout(gprsLitTimer);
  gprsLitTimer = setTimeout(() => gprsLight(false, false), GPRS_LIT_MS);
  gprsAmounts();
  gprsTitle();
}

// on the pill: the arrows are beside the badge, not in it
function gprsLight(tx, rx) {
  if (tx !== gprsLit.tx) statusEl.toggleAttribute("data-gsm-tx", gprsLit.tx = tx);
  if (rx !== gprsLit.rx) statusEl.toggleAttribute("data-gsm-rx", gprsLit.rx = rx);
}

const kb = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function gprsTitle() {
  const g = gprsNet;
  const shown = gprsShown();
  if (shown === "off") {
    for (const e of [gprsEl, gsmStatusEl, gsmDataEl]) if (e.title) e.title = "";
    return;
  }
  const s = gprsRetryIn(g);
  // a phone that registers and never attaches, or attaches and never sends,
  // is at rest, not waiting: nothing here says "yet" once the cell is known
  const head = {
    idle: g.ms === null ? "GPRS: not used yet. The gateway is dialled when the phone first sends."
      : "GPRS: no link to the gateway.",
    connecting: g.reason ? `GPRS: connecting again. ${g.reason}.` : "GPRS: connecting",
    online: "GPRS: connected", active: "GPRS: connected",
    offline: `GPRS: offline. ${g.reason}. Dialled again when the phone sends`
      + (s > 0 ? `, in ${s} s.` : "."),
    refused: `GPRS: refused. ${g.reason}. Not dialled again in this run.`,
  }[shown];
  const net = gsmLine(g);
  const title = `${net ? `Network: ${net}\n` : ""}${head}\nSent ${kb(g.bytes.out)}, received ${kb(g.bytes.in)}`;
  // the status line and the amounts are ellipsised or dropped where the
  // pill is short of room: the same title has them in full
  for (const e of [gprsEl, gsmStatusEl, gsmDataEl]) if (e.title !== title) e.title = title;
}

// window.__ui.gprs and window.__ui.gsm, for tools/: badge is what #gprs
// shows, state the relay's link ("active" while an arrow is lit)
function gprsInfo() {
  const g = gprsNet;
  return {
    state: gprsShown(), badge: gprsBadge(), reason: g?.reason ?? "", code: g?.code ?? 0,
    retryIn: gprsRetryIn(g), txFrames: g?.frames.out ?? 0, rxFrames: g?.frames.in ?? 0,
    txBytes: g?.bytes.out ?? 0, rxBytes: g?.bytes.in ?? 0,
  };
}

function gsmInfo() {
  const g = gprsNet;
  return {
    known: g ? g.ms !== null : false, registered: !!g?.registered,
    gprsAttached: !!g?.gprsAttached, pdpActive: !!g?.pdpActive,
  };
}

function onGuestExit(code) {
  running = false;
  acc = null;
  gprsNet?.stop();
  gprsNet = null;
  window.__gprsNet = null;
  lastRelease = null;       // names this run's module, which must not outlive it
  caseState = { m: null, state: "lower" };   // likewise
  clearTimeout(quitTimer);
  quitStuck = false;
  showGprsStatus();
  renderGprs();
  exitCode = code;
  refreshTyping();
  stopGuestOutput();
  stopRecording();          // flushes whatever was captured
  endAudio();               // closed once that capture is saved
  finalExitCheck();         // a crash dump it printed on its way out
  setEmuState("idle");
  // the EXIT panel is the screen's own report; it replaces this one
  // a failed exit, such as a start-up error, says why as its last line
  const why = code && logTail.length ? `: ${logTail.at(-1).replace(/^this\.program: /, "")}` : "";
  if (!exitReport) showOverlay("Ready to boot", `Exited (${code})${why}`);
}

function stop() {
  // before the guest exists, the action is "cancel the fullflash download"
  if (downloadAbort) {
    downloadAbort.abort();
    return; // boot()'s catch reports it and re-arms Start
  }
  // ...or "cancel the engine download" a too-soon Start is riding out
  // (the very download the background prefetch began)
  if (engineAbort) {
    engineAbort.abort();
    return; // ensureEngine() rethrows it to boot()'s catch
  }
  // ...or "cancel the ESN sweep", the other pre-guest wait worth stopping
  if (esnAbort) {
    esnAbort.abort();
    return; // runEsnRecovery() puts the page back to idle
  }
  // a capture in flight is finished and saved first — the frames stop
  // arriving the moment the guest goes away
  finishRecording(() => {
    // a Start still on its way to a live guest: checkCancel() turns this
    // into "Start cancelled" before the next step
    if (emuState === "booting" && !running) {
      bootCancelled = true;
      showOverlay("Stopping…");
      return;
    }
    // flushing the capture takes a moment, in which the guest can exit on its
    // own — then there is nothing left to stop, and onGuestExit already
    // put the page back to idle
    const m = liveModule();
    if (!m?._wasm_quit) return;
    // a guest whose threads are gone cannot act on a quit request
    if (stalled || quitStuck) { forceStop(m); return; }
    m._wasm_quit();
    showOverlay("Stopping…");
    clearTimeout(quitTimer);
    quitTimer = setTimeout(() => {
      if (liveModule() === m) { quitStuck = true; render(); }
    }, FORCE_STOP_AFTER_MS);
  });
}

// Stop's last resort, for a guest that does not act on _wasm_quit(): its
// workers are terminated and the page does the exit handling itself. MEMFS
// lives on the page's thread, so the exports still work afterwards. Not the
// first thing Stop does: qemu's own shutdown is what writes back the flash.
const FORCE_STOP_AFTER_MS = 5000;

function forceStop(m) {
  forcedModules.add(m);
  for (const w of engineWorkers.get(m) ?? []) w.terminate();
  onGuestExit(-1);
  releaseHeap(m);
  if (!exitReport) showOverlay("Ready to boot", "Stopped by force — the guest was not answering");
}

$("boot-form").addEventListener("submit", (e) => { e.preventDefault(); startRun(); });

// Start is the user gesture the browser's autoplay rules ask for, so each
// run's AudioContext is created here, before boot() awaits anything. A Start
// that ends without a live guest (an error, a cancel, a second click while
// the first waits) closes it again once no other Start is under way.
let startsPending = 0;
async function startRun() {
  if (QS.get("sound") !== "off" && !QS.get("suite")) audioContext();
  startsPending++;
  try {
    await boot();
  } finally {
    if (--startsPending === 0 && !running) endAudio();
  }
}

// "S75v40lg1.bin" -> "S75v40lg1 modified.bin": the suffix goes on the name, not
// after the extension, so the file still opens as a .bin
function modifiedName(orig) {
  const i = orig.lastIndexOf(".");
  return i > 0 ? orig.slice(0, i) + " modified" + orig.slice(i) : orig + " modified";
}

// the name of the flash this run was booted from — read at boot, so changing
// the selection after stopping cannot rename a dump that is already out
function savedFlashName() {
  return modifiedName(ranFlashName ?? "fullflash.bin");
}

$("btn-save-flash").addEventListener("click", () => {
  downloadMemfs(FULLFLASH_PATH, savedFlashName());
});

// EFA blocks are written lazily (only once the firmware actually programs
// the EFA), so there is nothing to hand out until it appears.
$("btn-save-efa").addEventListener("click", () => {
  // derived from the base name, not by running modifiedName() on the sidecar —
  // that would land the suffix before .cfi-efa instead of after the .bin
  if (!downloadMemfs(FULLFLASH_PATH + ".cfi-efa", savedFlashName() + ".cfi-efa")) {
    const cap = $("export-caption");
    cap.textContent = "The firmware has not written an EFA block yet.";
    cap.hidden = false;
  }
});

/* ------------------------------------------------------------------ */
/* accessory: what is plugged into the phone's system connector         */
/* ------------------------------------------------------------------ */

// board config profile name -> what the dropdown says; a profile missing
// here shows its config name
const ACCESSORY_LABELS = {
  "data-cable": "Data cable", "usb-cable": "USB cable", "usb-cable-nc": "USB cable (NC)",
  "boot-box": "Boot box", "desktop-charger": "Desktop charger",
  "tty": "TTY", "tty-x55": "TTY (x55)",
  "music-set": "Music set", "music-cable": "Music cable",
  "headset-mono": "Headset (mono)", "headset-stereo": "Headset (stereo)",
  "atc-device": "ATC device", "a2i-device": "A2I device",
};

// The list is the board's (readAccessories), not the emulator's: it is the
// same boards.tar qemu boots from. The button disconnects when the selected
// accessory is the one plugged in, and connects it otherwise — which, with
// another one plugged in, swaps them (the connector inserts the unplug).
// Before a run it only chooses what the phone starts with.
function renderAccessory() {
  const sel = $("acc-select"), btn = $("btn-accessory"), cap = $("acc-caption");
  const dev = running ? ranDevice : currentDevice();
  const gsm = running ? acc?.gsm : gsmFor(dev);
  if (acc?.dev !== dev || acc.gsm !== gsm) {
    const conf = dev ? readAccessories(dev + ".toml") : null;
    const names = conf?.names.filter((n) => n !== conf.unplugged) ?? [];
    acc = { dev, gsm, unplugged: conf?.unplugged ?? null, names, plugged: bootAccessory(conf) };
    sel.replaceChildren(...(names.length ? names : [""]).map((n) => {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n ? ACCESSORY_LABELS[n] ?? n : "None";
      return opt;
    }));
    if (names.includes(acc.plugged)) sel.value = acc.plugged;
  }
  const live = emuState === "running" || emuState === "paused";
  // a dist built before the export existed boots fine, it just cannot plug
  const canPlug = !!liveModule()?._wasm_accessory_plug;
  const usable = acc.names.length > 0 && (live ? canPlug : emuState !== "booting");
  sel.disabled = !usable;
  btn.disabled = !usable;
  btn.textContent = sel.value && sel.value === acc.plugged ? "Disconnect" : "Connect";
  const text = !dev ? ""
    : !acc.names.length ? "This phone has no accessory connector"
    : live && !canPlug ? "This emulator build cannot plug accessories"
    : "";
  cap.textContent = text;
  cap.hidden = !text;
}

$("acc-select").addEventListener("change", renderAccessory);
// the GSM option changes what a run boots with
$("gsm").addEventListener("change", renderAccessory);

$("btn-accessory").addEventListener("click", () => {
  if (!acc) return;
  const sel = $("acc-select").value;
  const name = sel === acc.plugged ? acc.unplugged : sel;
  if (!name || name.length >= 64) return;
  if (!running) {
    acc.plugged = name;
    renderAccessory();
    return;
  }
  const m = liveModule();
  if (!m?._wasm_accessory_plug) return;
  // the name goes into the export's 64-byte buffer, NUL-terminated; profile
  // names are ASCII, and TextEncoder cannot write into the shared heap
  const at = Number(m._wasm_accessory_buf());
  for (let i = 0; i < name.length; i++) m.HEAPU8[at + i] = name.charCodeAt(i);
  m.HEAPU8[at + name.length] = 0;
  m._wasm_accessory_plug();
  acc.plugged = name;
  renderAccessory();
});

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  const url = a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  // a revoke in the same tick has cancelled large downloads in Safari; once
  // the download has begun the blob is not needed, and a flash is 32-128 MiB
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function downloadMemfs(path, name) {
  const m = qemuModule;
  if (!m?.FS?.analyzePath(path)?.exists) return false;
  downloadBlob(new Blob([m.FS.readFile(path)], { type: "application/octet-stream" }), name);
  return true;
}

/* ------------------------------------------------------------------ */
/* LCD capture: a PNG of the screen, or a .mp4/.webm of it            */
/* ------------------------------------------------------------------ */

// "pmb887x-siemens-s75-20260915-023000" — the run this file came from
function captureName() {
  const t = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `pmb887x-${currentDevice() ?? "phone"}-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`
    + `-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
}

$("btn-shot").addEventListener("click", () => {
  canvas.toBlob((b) => b && downloadBlob(b, captureName() + ".png"), "image/png");
});

// MediaRecorder over canvas.captureStream: the same frames the guest paints,
// at a fixed 30 fps so a still screen still produces a playable file.
// "Finish" is the only verb for ending a capture — "Stop" belongs to the
// emulator, and on a phone the two controls sit side by side.
const REC_TYPES = [
  "video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4",
  "video/webm;codecs=h264",
  "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm",
];
// The same order with the phone's sound: AAC beside H.264, Opus in webm.
const REC_AV_TYPES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4",
  "video/webm;codecs=h264,opus",
  "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm",
];
// H.264 first: where the browser can record it the file plays anywhere,
// and the mp4 container is the one Safari writes. VP9/VP8 webm remain
// the fallback, so the extension follows whatever isTypeSupported picks.
const recType = (sound = true) => typeof MediaRecorder === "undefined" ? undefined
  : (sound ? REC_AV_TYPES : REC_TYPES).find((t) => MediaRecorder.isTypeSupported(t));
const recExt = (t) => t?.startsWith("video/mp4") ? ".mp4" : ".webm";
let recorder = null;
let recDone = [];     // run after the file has been handed over
const recBtn = $("btn-record");
if (typeof MediaRecorder === "undefined") recBtn.dataset.unsupported = "1";

function say(msg) { $("live-region").textContent = msg; }

// after = what to do once the capture has been saved (Stop finishes the
// recording before it takes the guest down). A Finish while the file is
// still being written must not drop a Stop that is waiting for it.
function finishRecording(after = null) {
  if (!recorder) { after?.(); return; }
  if (after) recDone.push(after);
  if (recorder.state !== "inactive") recorder.stop();
}
// the guest going away mid-capture: flush whatever was recorded
const stopRecording = () => finishRecording();

function startRecording() {
  if (recorder || recBtn.dataset.unsupported) return;
  const video = canvas.captureStream(30);
  const sound = recordSound();
  let stream = new MediaStream([...video.getVideoTracks(), ...(sound?.getAudioTracks() ?? [])]);
  let mimeType = recType(!!sound);
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    // a browser that cannot mux the sound in still records the screen
    endRecordSound();
    stream = video;
    mimeType = recType(false);
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  }
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    for (const t of stream.getTracks()) t.stop();
    endRecordSound();
    recorder = null;
    setRecordLabel(false);
    if (chunks.length) downloadBlob(new Blob(chunks, { type: mimeType || "video/webm" }),
      captureName() + recExt(mimeType));
    say("Recording saved");
    for (const after of recDone.splice(0)) after();
  };
  try {
    recorder.start();
  } catch (e) {
    // a recorder that never started never fires onstop either
    for (const t of stream.getTracks()) t.stop();
    endRecordSound();
    recorder = null;
    console.warn("[record]", e);
    say("Recording could not start");
    return;
  }
  setRecordLabel(true);
  say("Recording started");
}

recBtn.addEventListener("click", () => {
  if (recorder) finishRecording(); else startRecording();
});
$("btn-rec-finish").addEventListener("click", () => finishRecording());

// Off the phone layout the button itself becomes the capture pill (icon
// dot -> square, plus a running m:ss); at phone widths .rec-pill takes its
// place instead. render() carries the labels for both.
let recTimer = 0;
function setRecordLabel(on) {
  recBtn.classList.toggle("recording", on);
  clearInterval(recTimer);
  if (!on) {
    $("rec-time").textContent = "";
    $("rec-pill-time").textContent = "0:00";
    render();
    return;
  }
  const startedAt = performance.now();
  const tick = () => {
    const s = Math.floor((performance.now() - startedAt) / 1000);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    $("rec-time").textContent = t;
    $("rec-pill-time").textContent = t;
  };
  tick();
  recTimer = setInterval(tick, 1000);
  render();
}

/* ------------------------------------------------------------------ */
/* the guest's serial port                                              */
/* ------------------------------------------------------------------ */

// qemu writes the phone's serial port to a file in the emscripten FS
// (-serial file:), and that FS is plain JS on the page's own thread: with
// pthreads every FS syscall a worker makes is proxied here, so MEMFS's own
// write() is where the guest's bytes surface. Wrapping the log's node ops
// turns that into a callback — the page is handed each line as the phone
// prints it, and nothing has to watch the file.

const SERIAL_PATH = "/serial.log";
const SERIAL_KEEP = 16384;   // the tail the <pre> holds; Download has it all

let serialTapped = false;    // the callback is in place for this run
let serialText = "";         // that tail, exactly as the guest printed it
let serialWork = 0, serialDraw = 0;
let serialPolled = 0;        // the log's size at the last poll (no tap)
let exitScanned = 0;         // serialText up to here holds no EXIT marker

function tapSerial(mod) {
  try {
    // ?serialpoll=1 exercises the fallback deliberately
    if (QS.get("serialpoll") === "1") {
      return (serialTapped = false);
    }
    const FS = mod.FS;
    FS.writeFile(SERIAL_PATH, new Uint8Array(0));  // exist before qemu opens it
    const node = FS.lookupPath(SERIAL_PATH).node;
    const base = node.stream_ops;
    const dec = new TextDecoder("latin1");
    // preRun is where this run's log starts: a phone that crashes before
    // the factory's promise resolves has already printed by then
    resetSerial();
    // FS.open copies the node's ops into the stream, so qemu's own handle
    // (opened later, from main()) picks this up
    node.stream_ops = Object.assign(Object.create(base), {
      write(stream, buffer, offset, length, position, canOwn) {
        const n = base.write(stream, buffer, offset, length, position, canOwn);
        // The guest's thread is blocked in this syscall and nothing here may
        // throw into it: take a copy of the bytes (slice(), because the heap
        // these arrive on is a SharedArrayBuffer and TextDecoder will not
        // read one) and leave the rest of the work to a timeout.
        try {
          if (n > 0) {
            serialText += dec.decode(buffer.slice(offset, offset + n));
            if (!serialWork) serialWork = setTimeout(onSerial, 0);
          }
        } catch (e) {
          console.error("serial tap:", e);
        }
        return n;
      },
    });
    return (serialTapped = true);
  } catch (e) {
    console.warn("serial tap unavailable, falling back to polling:", e);
    return (serialTapped = false);
  }
}

// Off the syscall, once per batch of writes.
function onSerial() {
  serialWork = 0;
  if (serialText.length > SERIAL_KEEP * 2) {
    exitScanned = Math.max(0, exitScanned - (serialText.length - SERIAL_KEEP));
    serialText = serialText.slice(-SERIAL_KEEP);
  }
  if (!serialDraw) serialDraw = setTimeout(drawSerial, 200);  // the DOM, at 5 Hz
  watchForExit();
}

function drawSerial() {
  serialDraw = 0;
  const el = $("serial");
  const text = serialText.length > SERIAL_KEEP ? serialText.slice(-SERIAL_KEEP) : serialText;
  if (el.textContent !== text) {
    el.textContent = text;
    if (serTail.checked) el.scrollTop = el.scrollHeight;
  }
  if (text) $("serial-box").hidden = false;
}

// a fresh run starts with an empty log: drop the previous one and fold the
// box away again until this guest prints its first line
function resetSerial() {
  clearInterval(serialTimer);
  clearTimeout(serialDraw);
  serialWork = serialDraw = serialPolled = exitScanned = 0;
  serialText = "";
  $("serial").textContent = "";
  $("serial-box").hidden = true;
}

// Once the module is up. With the tap in place the bytes have been arriving
// since preRun and there is nothing to start; a build whose FS internals
// have moved under it falls back to reading the log on a timer, the way the
// page used to.
function startSerial() {
  if (serialTapped) return;
  resetSerial();
  serialTimer = setInterval(pollSerial, 1000);
}

function pollSerial() {
  const m = qemuModule;
  if (!m?.FS) return;
  try {
    if (!m.FS.analyzePath(SERIAL_PATH).exists) return;
    // only the tail the <pre> holds, and only once the log has grown
    const size = m.FS.stat(SERIAL_PATH).size;
    if (size === serialPolled) return;
    serialPolled = size;
    const data = new Uint8Array(Math.min(size, SERIAL_KEEP));
    const fd = m.FS.open(SERIAL_PATH, "r");
    try { m.FS.read(fd, data, 0, data.length, size - data.length); }
    finally { m.FS.close(fd); }
    serialText = new TextDecoder("latin1").decode(data);
    exitScanned = 0;
    drawSerial();
    watchForExit();
  } catch { /* not there yet */ }
}

// Copy and Download hand out the whole log, not the tail the <pre> holds.
function serialBytes() {
  try { return qemuModule?.FS?.readFile(SERIAL_PATH, { encoding: "binary" }) ?? null; }
  catch { return null; }
}

$("ser-copy").addEventListener("click", async (e) => {
  const bytes = serialBytes();
  const text = bytes ? new TextDecoder("latin1").decode(bytes) : $("serial").textContent;
  try {
    await navigator.clipboard.writeText(text);
    const btn = e.currentTarget;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 1200);
  } catch { /* clipboard denied — nothing useful to say */ }
});

$("ser-save").addEventListener("click", () => {
  const bytes = serialBytes();
  downloadBlob(new Blob([bytes ?? $("serial").textContent], { type: "text/plain" }),
    captureName() + "-serial.log");
});

// wrap: long lines fold instead of scrolling sideways.
// follow: stick to the newest line; off lets you read back while it grows.
const serWrap = $("ser-wrap"), serTail = $("ser-tail");
for (const [chk, key, apply] of [
  [serWrap, "ser-wrap", () => $("serial").classList.toggle("nowrap", !serWrap.checked)],
  [serTail, "ser-tail", () => { if (serTail.checked) $("serial").scrollTop = $("serial").scrollHeight; }],
]) {
  const stored = store.get(key);
  if (stored != null) chk.checked = stored === "1";
  apply();
  chk.addEventListener("change", () => {
    store.set(key, chk.checked ? "1" : "0");
    apply();
  });
}

/* ------------------------------------------------------------------ */
/* Sound                                                                */
/* ------------------------------------------------------------------ */

// qemu's emscripten audio backend (qemu/audio/wasmaudio.c) publishes S16
// frames into a ring that lives in the wasm heap; audio-worklet.js drains it
// on the audio render thread, reading the same SharedArrayBuffer. Nothing is
// copied through here per buffer — this side only sizes the guest's mixer to
// the output device, hands the worklet the ring's address, and owns the one
// word the backend reads to decide whether anybody is listening.
//
// Muted is not the same as "no audiodev": the backend keeps consuming at the
// nominal rate when nobody listens, so the guest's PCM pipeline drains either
// way and a mute never changes what the firmware is timing against.
const RING_WORDS = 16, RING_ACTIVE = 6, RING_UNDERRUNS = 8;
const SOUND_KEY = "opt-sound";
let audioCtx = null;      // one per run: startRun() creates it, endAudio() closes it
let audioNode = null;
let speaker = null;       // gain between the worklet and the device: the mute
let recSound = null;      // MediaStreamAudioDestinationNode while a capture records
let audioHdr = null;      // Int32Array over the ring header while attached
let workletReady = null;  // addModule() promise, resolved once
let soundOn = store.get(SOUND_KEY) !== "0";

function audioContext() {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext ?? window.webkitAudioContext;
  if (!AC) return null;
  try {
    audioCtx = new AC({ latencyHint: "interactive" });
  } catch {
    return null;
  }
  // A backgrounded tab suspends the context: stop claiming a listener, or the
  // ring fills and back-pressure stalls the guest's audio pipeline.
  audioCtx.onstatechange = updateListening;
  return audioCtx;
}

// The end of a run closes its context. A context kept for the page kept its
// AudioWorklet's isolate too, and that isolate held every finished run's
// 2 GiB heap (the ring's buffer) until it happened to collect (PA-1). The
// next Start makes a new one; speaker and worklet belong to the old one. A
// capture still saving its file keeps the context until it has.
function endAudio() {
  const ac = audioCtx;
  if (!ac) return;
  audioCtx = null;
  speaker = null;
  workletReady = null;
  ac.onstatechange = null;
  const close = () => ac.close().catch(() => {});
  if (recorder) recDone.push(close); else close();
}

// What the guest's mixer resamples to. Matching the device's own rate leaves
// the worklet copying frames instead of interpolating them.
function audioRate() {
  return audioContext()?.sampleRate ?? 48000;
}

function setRingActive(on) {
  if (audioHdr) Atomics.store(audioHdr, RING_ACTIVE, on ? 1 : 0);
}

// The ring is drained while the speaker plays or a capture records; a mute
// during a capture only closes the speaker's gain.
function updateListening() {
  setRingActive((soundOn || !!recSound) && audioCtx?.state === "running");
  if (speaker) speaker.gain.value = soundOn ? 1 : 0;
}

// The phone's sound for a capture (null without one), whether or not the
// speaker is muted. Called from the record click, so the context may resume.
function recordSound() {
  const ac = audioContext();
  if (!ac?.createMediaStreamDestination) return null;
  recSound = ac.createMediaStreamDestination();
  audioNode?.connect(recSound);
  ac.resume().catch(() => {}).then(updateListening);
  updateListening();
  return recSound.stream;
}

function endRecordSound() {
  if (!recSound) return;
  try { audioNode?.disconnect(recSound); } catch { /* the guest went away first */ }
  recSound = null;
  updateListening();
}

async function attachAudio() {
  const m = liveModule();
  const ac = audioContext();
  if (!m?._wasm_audio_ring_ptr || !ac) return;
  const ptr = Number(m._wasm_audio_ring_ptr());
  if (!ptr) return;
  try {
    workletReady ??= ac.audioWorklet.addModule(new URL("./audio-worklet.js", import.meta.url));
    await workletReady;
    // the guest this was for may have exited (and detachAudio run) meanwhile
    if (liveModule() !== m) return;
    const node = new AudioWorkletNode(ac, "qemu-audio", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    if (!speaker) {
      speaker = ac.createGain();
      speaker.connect(ac.destination);
    }
    node.connect(speaker);
    if (recSound) node.connect(recSound);
    node.port.postMessage({ type: "ring", buffer: m.HEAPU8.buffer, ptr });
    audioNode = node;
    audioHdr = new Int32Array(m.HEAPU8.buffer, ptr, RING_WORDS);
    if (soundOn || recSound) await ac.resume();
    if (liveModule() !== m) return;
    updateListening();
  } catch (e) {
    workletReady = null;   // a failed addModule must not poison the next boot
    console.log("[audio]", e);
  }
}

function detachAudio() {
  setRingActive(false);
  audioHdr = null;
  if (audioNode) {
    audioNode.port.postMessage({ type: "stop" });
    audioNode.disconnect();
    audioNode = null;
  }
}

const soundBtn = $("btn-sound");
function renderSound() {
  soundBtn.setAttribute("aria-pressed", soundOn ? "false" : "true");
  soundBtn.setAttribute("aria-label", soundOn ? "Mute sound" : "Unmute sound");
  soundBtn.title = soundOn ? "Mute the phone's speaker" : "Unmute the phone's speaker";
}
soundBtn.addEventListener("click", async () => {
  soundOn = !soundOn;
  store.set(SOUND_KEY, soundOn ? "1" : "0");
  renderSound();
  // the run's context; between runs there is none, and the next Start makes it
  const ac = audioCtx;
  if (!ac) return;
  if (soundOn) {
    try { await ac.resume(); } catch { /* no gesture yet: the next Start has one */ }
  }
  updateListening();
});
renderSound();

// Everything above is module-scoped, so a harness driving the page has no
// other way to ask whether the context actually started (tools/audioprobe.mjs).
window.__audio = () => ({
  state: audioCtx?.state ?? null,
  rate: audioCtx?.sampleRate ?? 0,
  on: soundOn,
  attached: !!audioHdr,
});

/* ------------------------------------------------------------------ */
/* LCD painting                                                         */
/* ------------------------------------------------------------------ */

const canvas = $("lcd");
const ctx = canvas.getContext("2d");

function startPainting() {
  cancelAnimationFrame(rafHandle);
  // one ImageData for every frame of a size: this runs at the display's
  // rate on the main thread, next to the canvas upload it feeds
  let img = null, dst = null;
  const step = () => {
    rafHandle = requestAnimationFrame(step);
    const m = liveModule();
    if (!m?._wasm_fb_ptr) return;
    if (!m._wasm_fb_take_dirty()) return;
    const w = m._wasm_fb_width(), h = m._wasm_fb_height(), stride = m._wasm_fb_stride();
    if (w <= 0 || h <= 0) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      // the guest's panel ratio is the real one, for this board's later boots too
      if (ranDevice) panelCache.set(ranDevice, { w, h });
      setAspect();
    }
    const tPaint = performance.now();
    if (img?.width !== w || img.height !== h) {
      img = ctx.createImageData(w, h);
      dst = new Uint32Array(img.data.buffer);
    }
    // staging is XRGB8888 words on the shared heap, rows stride bytes apart
    const rowWords = stride >> 2;
    const src = new Uint32Array(m.HEAPU8.buffer, Number(m._wasm_fb_ptr()), rowWords * h);
    for (let y = 0, i = 0; y < h; y++) {
      for (let o = y * rowWords, end = o + w; o < end; o++) {
        const px = src[o];
        // XRGB8888 (LE u32 0x00RRGGBB) -> canvas RGBA (LE u32 0xffBBGGRR):
        // swap R and B, then set alpha.
        dst[i++] = 0xff000000 | ((px & 0x000000ff) << 16)
                 | (px & 0x0000ff00) | ((px >>> 16) & 0x000000ff);
      }
    }
    ctx.putImageData(img, 0, 0);
    paintMs += performance.now() - tPaint;
  };
  rafHandle = requestAnimationFrame(step);
}

// Everything that feeds off a live guest: the paint loop, the serial poll,
// the HUD sampler and the audio.
function stopGuestOutput() {
  cancelAnimationFrame(rafHandle);
  clearInterval(serialTimer);
  stopHudTimer();
  detachAudio();
}

/* ------------------------------------------------------------------ */
/* Siemens EXIT: the firmware's own crash dump, off the serial port      */
/* ------------------------------------------------------------------ */

// A Siemens phone that panics prints a crash dump on the trace USART and
// then stops being a phone. Two generations, two shapes of the same dump —
// the labels are the firmware's own, lifted from the images in fullflashes/:
//
//   x75/x85 (S75, EL71, C81)      x65 (S65, S66, C65)
//   >>EXIT<<                      EXIT: 000E:F7FB     <- the marker is the code
//   ExitType: Processor Exit      FILE:               <- the value follows as
//   ExitCode: 0x0206              ddsphw                 its own message
//   FILE: Prefetch_Abort!         CPSR: 60000130
//   At address: 0xA068C7A8        CepId: FFFF
//   ExitString: Address: 0x…      ExitString:
//   CepId: 0x430F                 0801
//   CepName: DDL_HANDLER
//   CPSR: 0x20000110
//   Checksum: 0x0000
//
// Receiving one ends the run — there is nothing left to run — and the page
// says so the way the phone itself would have: a short beep, the backlight
// off, the pixels fading out over half a minute, and the dump left on top.

const EXIT_SETTLE_MS = 250;  // quiet on the port = the dump is all here
const EXIT_MAX_MS = 2000;    // …and a phone that will not stop talking
const EXIT_DIM = 0.45;       // the step the backlight going off is
const EXIT_FADE_MS = 30000;  // and how long the pixels take to follow it

let exitReport = null;    // the dump this run ended on, once it is complete
let exitPending = null;   // { at, timer } while one is still being printed

// Called whenever the phone has printed something (and once more when the
// guest goes away). A dump takes several writes, so it is presented once the
// port has gone quiet — never later than EXIT_MAX_MS after its first byte,
// in case the firmware carries on talking.
function watchForExit() {
  if (exitReport || !ranDevice?.startsWith("siemens-")) return;
  if (!exitPending) {
    // only what is new can hold a marker, so the whole tail is parsed only
    // once one has arrived (backed off so one split across writes is seen)
    const from = Math.max(0, exitScanned - EXIT_MARK.length + 1);
    if (serialText.indexOf(EXIT_MARK, from) < 0 && serialText.indexOf(EXIT_HEAD, from) < 0) {
      exitScanned = serialText.length;
      return;
    }
    if (!parseExit(serialMessages(serialText))) return;
    exitPending = { at: performance.now(), timer: 0 };
  }
  clearTimeout(exitPending.timer);
  exitPending.timer = setTimeout(() => presentPendingExit(), Math.min(EXIT_SETTLE_MS,
    Math.max(0, exitPending.at + EXIT_MAX_MS - performance.now())));
}

function presentPendingExit(quit = true) {
  clearTimeout(exitPending?.timer);
  const report = parseExit(serialMessages(serialText));
  if (report) presentExit(report, quit);
  else exitPending = null;
}

// The guest has gone: whatever it printed on its way out is all there is.
// (Its log outlives it — MEMFS does — so a run whose tap never installed is
// read back from the file here.)
function finalExitCheck() {
  if (exitReport || !ranDevice?.startsWith("siemens-")) return;
  // without the tap serialText is the last poll's, up to a second old
  if (!serialText || !serialTapped) {
    const bytes = serialBytes();
    if (bytes) serialText = new TextDecoder("latin1").decode(bytes);
  }
  presentPendingExit(false);
}

function presentExit(report, quit) {
  if (exitReport) return;
  exitReport = report;
  exitPending = null;
  stopGuestOutput();       // the last frame the phone drew stays on the canvas
  hideOverlay();
  beep();
  fadeScreen();
  drawExitPanel(report);
  if (quit) liveModule()?._wasm_quit?.();
  render();
  say(`Firmware EXIT — ${[report.type, report.code].filter(Boolean).join(" ") || "no details"}`
    + ". The emulator has stopped.");
}

function clearExit() {
  clearTimeout(exitPending?.timer);
  exitReport = null;
  exitPending = null;
  $("exit-overlay").hidden = true;
  canvas.style.transition = "";
  canvas.style.filter = "";
}

function drawExitPanel(report) {
  // x75 names the kind of exit and x65 does not, so the headline is that
  // name where there is one and the code where there is not
  const head = report.type ? "Type" : "Code";
  $("exit-type").textContent = report.type ?? report.code ?? "";
  const cells = [];
  // whatever became the headline is not a row as well
  for (const [label, value] of report.rows.filter(([n]) => n !== head)) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value || "—";
    cells.push(dt, dd);
  }
  if (!cells.length) {
    const dd = document.createElement("dd");
    dd.textContent = "No fields — see the serial log.";
    dd.style.gridColumn = "1 / -1";
    cells.push(dd);
  }
  $("exit-fields").replaceChildren(...cells);
  $("exit-overlay").hidden = false;
}

// The backlight going off, then the pixels going with it. A CSS filter, so
// none of it reaches a screenshot or a capture: those still hand back what
// the phone last drew.
function fadeScreen() {
  canvas.style.transition = "none";
  canvas.style.filter = `brightness(${EXIT_DIM})`;
  canvas.getBoundingClientRect();   // commit the step before the fade starts
  canvas.style.transition = `filter ${EXIT_FADE_MS}ms linear`;
  canvas.style.filter = "brightness(0)";
}

// ~80 ms: long enough to notice, short enough not to be an alarm. Start was
// a user gesture, so the context is allowed to make a sound; a browser that
// refuses anyway leaves the rest of the report exactly as it is.
function beep() {
  try {
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    ac.resume?.();
    const t = ac.currentTime;
    const osc = ac.createOscillator(), gain = ac.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    // ramps at both ends: a square wave switched on at full gain clicks
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.16, t + 0.008);
    gain.gain.setValueAtTime(0.16, t + 0.055);
    gain.gain.linearRampToValueAtTime(0, t + 0.08);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.085);
    osc.onended = () => ac.close();
  } catch { /* no audio: nothing to say about it */ }
}

/* ------------------------------------------------------------------ */
/* the one thing the layout needs from here: the screen's aspect ratio   */
/* ------------------------------------------------------------------ */

// The phone column sizes itself — control row, screen box, edge tabs and
// keypad all come out of `.phone-panel`'s own box in style.css, with no
// measure-and-apply pass here and nothing scaled after layout. A window
// resize is therefore one reflow, and browser zoom is just a bigger page.
//
// The single thing CSS cannot know is how tall and wide the guest's panel
// is, because that is board data: publish it as `--ar` and the stylesheet
// does the rest.
const lcdWrap = document.querySelector(".lcd-wrap");

function screenAspect() {
  // a live guest's framebuffer beats the board config
  if (running && canvas.width > 0 && canvas.height > 0) return canvas.width / canvas.height;
  const p = panelFor(currentDevice());
  return p ? p.w / p.h : 132 / 176;
}

function setAspect() {
  phonePanel.style.setProperty("--ar", String(+screenAspect().toFixed(6)));
}

// The strip drops whole tokens to fit the box it sits on, which is the one
// piece of text fitting CSS cannot do; everything else about it is style.
// The box resizes for every reason the layout can change — window, rotation,
// URL bar, fullscreen, a board with a different panel — so this is also
// where the height probe below gets its cue.
new ResizeObserver(() => { refitHud(); drawVpProbe(); }).observe(lcdWrap);
function refitHud() { if (!hudEl.hidden) drawHud(); }
document.fonts?.ready.then(refitHud);

/* ------------------------------------------------------------------ */
/* Performance HUD: two lines, and never a third                        */
/* ------------------------------------------------------------------ */

// Per-second guest rates, on the page itself so a phone can report them
// without a debugger. Line 1: speed (virtual seconds per wall second — 1.0
// is real time), MIPS (guest insns/s), fps, the page's own paint cost, lag
// (wall − virtual since the run started: time the guest lost to a slow
// host, or under ?icount= what the real-time cap still owes) and halts/s. Line 2: the
// machine they were measured on. Whatever the width, it is exactly two
// lines: tokens are dropped off the line, never wrapped or shrunk.
let paintMs = 0;
let hudTimer = 0;
const HUD_MS = 500;          // 2 Hz — a readable number, not a per-frame one
const HUD_KEEP = 120;        // 60 s of samples for "Copy diagnostics"
const HUD_AVG = 20;          // the 10 s averages it still carries

let hudSamples = [];
let hudLast = null, hudNow = null, hudT0 = 0, hudV0 = null;
// lag has its own origin because the real-time cap forgives its debt when
// it switches from banked to its paced phase (strict, or budget: down to
// the 500 ms cap): measured from hudT0 it would freeze at the switch and
// show a debt that no longer exists, for the rest of the run.
let lagT0 = 0, lagV0 = null;
let slowSince = 0, fastSince = 0;

/* ---- shortUserAgent(): "Android 8 · Chrome 147 · SM-G955U" ---- */

let uaShort = null;   // built once per page load

function shortUserAgent() { return uaShort ??= buildShortUA(null); }

// the model and the platform version only come asynchronously: take the
// synchronous answer now and refine it the moment they land
navigator.userAgentData?.getHighEntropyValues?.(["platformVersion", "model"])
  .then((hi) => {
    uaShort = buildShortUA(hi);
    hudEnvCache = null;
    if (!hudEl.hidden) drawHud();
  })
  .catch(() => {});

/* ---- the two lines ---- */

const HUD_SEP = " · ";
const hudPad = (s, n) => String(s).padStart(n);

// Every token is padded to a fixed width, so a line does not jitter as its
// numbers move. `drop` is the order they leave in when the line will not
// fit, lowest first: paint goes before halts because the two narrow cases
// pin it that way (272px keeps speed, MIPS, fps and lag; 312px keeps
// halt/s too).
function metricTokens(r) {
  if (!r) return [];
  const lag = Math.max(0, r.lag);
  return [
    { t: `${r.vratio.toFixed(2)}×`, drop: 6,
      cls: "hud-speed " + (r.vratio >= 0.95 ? "good" : r.vratio >= 0.8 ? "warn" : "bad") },
    { t: `${hudPad(r.mips.toFixed(1), 4)} MIPS`, drop: 5 },
    { t: `${hudPad(Math.round(r.fps), 2)} fps`, drop: 4 },
    { t: `${hudPad(Math.round(r.paint), 3)} ms`, drop: 1 },
    { t: `lag ${hudPad(lag.toFixed(1), 3)}s`, drop: 3,
      cls: lag >= 3 ? "hud-lag bad" : lag >= 1 ? "hud-lag warn" : "" },
    { t: `${hudPad(Math.round(r.halts), 3)} halt/s`, drop: 2 },
  ];
}

let hudEnvCache = null;
function envTokens() {
  if (hudEnvCache) return hudEnvCache;
  const t = [{ t: shortUserAgent(), drop: 4 }];
  if (navigator.hardwareConcurrency) t.push({ t: `${navigator.hardwareConcurrency}c`, drop: 3 });
  if (navigator.deviceMemory) t.push({ t: `${navigator.deviceMemory} GB`, drop: 2 });
  if (crossOriginIsolated) t.push({ t: "isolated", drop: 1 });
  return (hudEnvCache = t);
}

// The budget in characters: how many glyphs of the lines' own monospace font
// fit the container, less two. Measured from a hidden "0" — once per font,
// which is what changes when the strip moves between the two layouts.
let hudCharW = 0, hudCharFont = "";
function hudCharWidth() {
  // not the `font` shorthand: Chrome serializes it to "" as soon as
  // font-variant-numeric is set, which would make every font look the same
  const s = getComputedStyle(hudRuler);
  const font = `${s.fontSize} ${s.fontWeight} ${s.fontFamily}`;
  if (font !== hudCharFont) {
    hudRuler.textContent = "0".repeat(20);   // 20 of them: sub-pixel advances
    const w = hudRuler.getBoundingClientRect().width / 20;
    hudRuler.textContent = "0";
    if (w > 0) { hudCharW = w; hudCharFont = font; }
  }
  return hudCharW;
}

function hudBudget() {
  const w = hudEl.getBoundingClientRect().width;
  const cw = hudCharWidth();
  return cw > 0 && w > 0 ? Math.floor(w / cw) - 2 : Infinity;
}

function drawLine(el, tokens, budget) {
  const keep = tokens.slice();
  const width = () => keep.reduce((n, k) => n + k.t.length, 0)
    + Math.max(0, keep.length - 1) * HUD_SEP.length;
  while (keep.length > 1 && width() > budget) {
    let worst = 0;
    for (let i = 1; i < keep.length; i++) if (keep[i].drop < keep[worst].drop) worst = i;
    keep.splice(worst, 1);
  }
  const out = [];
  for (const k of keep) {
    if (out.length) out.push(document.createTextNode(HUD_SEP));
    const s = document.createElement("span");
    if (k.cls) s.className = k.cls;
    s.textContent = k.t;
    out.push(s);
  }
  el.replaceChildren(...out);
}

function drawHud() {
  const budget = hudBudget();
  drawLine(hudMetricsEl, metricTokens(hudNow), budget);
  drawLine(hudEnvEl, envTokens(), budget);
}

/* ---- sampling ---- */

function hudTick() {
  const m = liveModule();
  if (!m?._wasm_insns) return;
  const s = { t: performance.now(), v: Number(m._wasm_vclock()), insns: Number(m._wasm_insns()),
    fb: Number(m._wasm_fb_updates()), halts: m._wasm_halts ? Number(m._wasm_halts()) : 0, paint: paintMs };
  // virtual time already on the clock when this window opened: lag is wall
  // minus virtual *since then*, the only thing this window can measure
  hudV0 ??= s.v;
  lagV0 ??= s.v;
  // old dists have no such export — treat them as "off"
  const b = !!(m._wasm_clock_banked && m._wasm_clock_banked());
  if (b !== banked) {
    // lag left at the end of the bank is written off, so it restarts here
    if (banked) { lagT0 = s.t; lagV0 = s.v; }
    banked = b;
    render();     // __ui is rebuilt there, not per tick
  }
  if (hudLast) {
    const dt = (s.t - hudLast.t) / 1000;
    hudNow = {
      wall: (s.t - hudT0) / 1000,
      mips: (s.insns - hudLast.insns) / 1e6 / dt,
      vratio: (s.v - hudLast.v) / 1e9 / dt,
      fps: (s.fb - hudLast.fb) / dt,
      halts: (s.halts - hudLast.halts) / dt,
      paint: (s.paint - hudLast.paint) / dt,      // ms of page paint per second
      lag: (s.t - lagT0) / 1000 - (s.v - lagV0) / 1e9,
    };
    hudSamples.push({
      wall: +hudNow.wall.toFixed(1), mips: +hudNow.mips.toFixed(1),
      vratio: +hudNow.vratio.toFixed(3), fps: +hudNow.fps.toFixed(1),
      halts: Math.round(hudNow.halts), paintMsPerS: +hudNow.paint.toFixed(1),
      lag: +hudNow.lag.toFixed(1), insns: s.insns, v: +(s.v / 1e9).toFixed(2),
    });
    if (hudSamples.length > HUD_KEEP) hudSamples.shift();
    trackSpeed(hudNow.vratio, s.t);
    if (!hudEl.hidden) drawHud();
  }
  trackStall(s);
  hudLast = s;
}

// The stall detector. Fifteen seconds is past any legitimate gap — a GC
// pause, a compile burst, a phone that is merely slow — so a boot in slow
// motion is never called dead, and it still lands while the user is looking
// at the splash.
// All three counters must be still: a guest asleep in WFI stops retiring
// instructions, but the halt count moves every time it wakes, and the
// display keeps being read.
// The time is counted per sample, at most two sampling periods each, so a
// tab or machine suspended for longer than STALL_MS is not a stall.
const STALL_MS = 15000;
let stallMark = null, stallMs = 0;

function trackStall(s) {
  if (!stallMark || s.insns !== stallMark.insns || s.halts !== stallMark.halts
      || s.fb !== stallMark.fb) {
    stallMark = s;
    stallMs = 0;
    if (stalled) { stalled = false; hideOverlay(); render(); }
    return;
  }
  stallMs += Math.min(s.t - (hudLast?.t ?? s.t), 2 * HUD_MS);
  if (stalled || stallMs < STALL_MS) return;
  stalled = true;
  showOverlay("Guest stopped", stallReason());
  render();
}

// The guest is gone and the page is the only witness: say what the last
// thing qemu managed to say was, so a report from a phone carries it.
function stallReason() {
  const secs = Math.round(stallMs / 1000);
  const why = fatalMsg ? `Failed with: ${fatalMsg}`
    : logTail.length ? `Last log: ${logTail.at(-1)}`
    : "Nothing was logged.";
  return `No guest instructions for ${secs}s. ${why} — Copy diagnostics has the rest.`;
}

// The slow warning: three consecutive seconds under 0.80x turn the pill
// amber, three back over it turn it green again. The hysteresis is the
// point — one slow sample (a GC pause, a tab coming back) must not flicker
// the pill.
function trackSpeed(vratio, now) {
  // While the clock is still banked (the boot) v/wall below 1 is a guest
  // that is behind and will catch up, not a slow one. Clearing both timers
  // means the first paced sample starts a clean three seconds rather than
  // inheriting the boot's.
  if (banked) {
    slowSince = 0; fastSince = 0;
    if (slow) { slow = false; render(); }
    return;
  }
  if (vratio < 0.8) {
    fastSince = 0;
    slowSince ||= now;
    if (!slow && now - slowSince > 3000) { slow = true; render(); }
  } else {
    slowSince = 0;
    fastSince ||= now;
    if (slow && now - fastSince >= 3000) { slow = false; render(); }
  }
}

// every run gets its own window: wall, virtual time and the slow warning all
// start counting when the guest does
function hudReset() {
  hudSamples = [];
  hudLast = null; hudNow = null; hudV0 = null; hudT0 = performance.now();
  lagV0 = null; lagT0 = hudT0;
  slowSince = 0; fastSince = 0; slow = false; banked = false;
  stalled = false; stallMark = null; stallMs = 0; fatalMsg = null;
  logTail.length = 0;
  if (!hudEl.hidden) drawHud();
}

// A firmware EXIT ends the run before qemu has finished going away, and the
// strip shares the top of the screen box with the dump: the guest is dead,
// so there is nothing left to sample either way.
const hudLive = () => !exitReport
  && (emuState === "booting" || emuState === "running" || emuState === "paused");

// The strip is an overlay on the screen box, so it waits for a guest rather
// than sitting on the idle "Ready to boot" panel. The sampler follows
// the guest, not the strip: it runs for any live guest either way — the
// pill's slow warning does not wait for the strip — and stops the moment the
// guest goes, since there is nothing left to sample and calling the exports
// past the runtime's exit aborts it. A strip left on keeps the last
// window's numbers.
function syncHud() {
  if (!hudReady) return;
  const show = hudChk.checked && hudLive();
  hudEl.hidden = !show;
  if (hudLive()) { if (!hudTimer) hudTimer = setInterval(hudTick, HUD_MS); }
  else stopHudTimer();
  if (show) drawHud();
}

function stopHudTimer() { clearInterval(hudTimer); hudTimer = 0; }

// the toggle takes effect immediately, mid-run or before one; it starts off
// — the strip is an instrument, and it covers the top of the screen box,
// which is the one thing the page is there to show
hudChk.checked = store.get("opt-hud") === "1";
hudChk.addEventListener("change", () => {
  store.set("opt-hud", hudChk.checked ? "1" : "0");
  syncHud();
});

/* ---- Fullscreen: the browser and navigation bars are the phone layout's
   biggest competitor for height, and the only way to get them back is to ask
   for the whole screen. Requires a user gesture, which the tick is. ---- */

// no button where the API is missing, rather than one that does nothing
if (fsSupported) fsBtn.hidden = false;

fsBtn.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch { /* refused (no gesture, or the browser says no): syncFsBtn stands */ }
  syncFsBtn();
});

function syncFsBtn() {
  const on = !!document.fullscreenElement;
  fsBtn.setAttribute("aria-pressed", String(on));
  fsBtn.setAttribute("aria-label", on ? "Leave fullscreen" : "Enter fullscreen");
  document.body.classList.toggle("is-fullscreen", on);
}

// leaving fullscreen by swipe, Back or Esc never goes through the button
document.addEventListener("fullscreenchange", syncFsBtn);

/* ?vp=1 — the height budget drawn on the page, because "the keypad does not
 * fit" is reported with a screenshot and the numbers have to be in it. It is
 * what found the `min-height: 100vh` floor: the viewport figures all agreed,
 * and the tell was a `flex: 1` row measuring taller than its flex share,
 * which can only mean an ancestor is taller than the viewport. */
let vpEl = null;
const vpForced = QS.get("vp") === "1";

function vpProbeEl() {
  if (vpEl) return vpEl;
  vpEl = document.createElement("pre");
  vpEl.id = "vp-probe";
  vpEl.style.cssText = "position:fixed;left:0;top:0;z-index:9999;margin:0;"
    + "padding:3px 5px;background:rgba(0,0,0,.82);color:#7ef2a0;font:10px/1.35 "
    + "ui-monospace,monospace;pointer-events:none;white-space:pre;max-width:100%";
  document.body.appendChild(vpEl);
  return vpEl;
}

function drawVpProbe() {
  const v = viewportReport();
  // self-shows on a real overflow, so a regression is visible without knowing
  // to ask for it; ?vp=1 pins it on when nothing is wrong yet
  if (!vpForced && v.fits) { if (vpEl) vpEl.hidden = true; return; }
  vpEl = vpProbeEl();
  vpEl.hidden = false;
  vpEl.textContent =
    `inner ${v.inner}  visual ${v.visual}  client ${v.client}  dpr ${v.dpr}\n`
    + `bodyH ${v.bodyH}  bodyMin ${v.bodyMin}  safeBottom ${v.safeAreaBottom}`
    + `  fs ${v.fullscreen ? 1 : 0}\n`
    + `status ${v.status}  screen ${v.screen}  keypad ${v.keypad}\n`
    + `used ${v.used}  budget ${v.budget}  fits ${v.fits ? "YES" : "NO"}`;
}

// What the column had to divide up, so a "the keypad does not fit" report
// carries the numbers instead of a description. The stylesheet derives the
// screen box from exactly these constants, so a mismatch here is the bug.
function viewportReport() {
  const px = (v) => Math.round(parseFloat(v) || 0);
  const cs = getComputedStyle(document.querySelector("main"));
  const rect = (s) => document.querySelector(s)?.getBoundingClientRect();
  const R = (s) => Math.round(rect(s)?.height ?? 0);
  // measured, not added up, so it holds for the landscape arrangement too:
  // how far past the top of the column the lowest piece of the phone reaches,
  // against the height the column was given
  const panel = rect(".phone-panel");
  const used = Math.round(
    Math.max(rect("#keypad")?.bottom ?? 0, rect(".screen-row")?.bottom ?? 0) - panel.top);
  const budget = Math.round(panel.height);
  return {
    inner: window.innerHeight,
    visual: Math.round(window.visualViewport?.height ?? 0),
    client: document.documentElement.clientHeight,
    // 100dvh as the browser resolved it, which is what the column is sized
    // from; if it exceeds `inner` the column cannot fit the viewport
    bodyH: Math.round(document.body.getBoundingClientRect().height),
    // min-height outranks the height we set: if this exceeds `inner`, the
    // column is floored taller than the viewport and nothing below fits
    bodyMin: px(getComputedStyle(document.body).minHeight),
    safeAreaBottom: px(cs.paddingBottom) - 6,
    dpr: +devicePixelRatio.toFixed(2),
    fullscreen: !!document.fullscreenElement,
    status: R(".status-block"), screen: R(".screen-row"), keypad: R("#keypad"),
    used, budget,
    fits: used <= budget + 1,
  };
}

/* ---- Copy diagnostics ---- */

// Everything the HUD drops to fit, plus what it never had room for: the
// averages, the full unmodified user agent and the last 60 s of samples.
function diagnostics() {
  const win = hudSamples.slice(-HUD_AVG);
  const avg = (k) => (win.length
    ? +(win.reduce((a, x) => a + x[k], 0) / win.length).toFixed(2) : null);
  return {
    ua: navigator.userAgent, uaShort: shortUserAgent(),
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    isolated: crossOriginIsolated,
    // bank makes vratio readable: 0.6x is a slow host once the bank is
    // over, but a guest still catching up while banked
    device: currentDevice(), state: emuState, slow, exitCode,
    // a run that says "running" with a dead guest behind it, and the
    // last thing qemu said — the whole report a stalled phone can give
    stalled, fatal: fatalMsg, log: logTail.slice(),
    // the phone column's height budget, for "the keypad does not fit"
    // reports: the viewport runs behind the system bars, so `inner` can
    // exceed what is actually on screen by `safeArea` (Android's gesture bar)
    viewport: viewportReport(),
    // what Advanced ▸ Siemens keys was set to, and what it did to this image
    siemensMode: currentDevice()?.startsWith("siemens-") ? siemensMode() : null,
    siemensKeys: keyReport,
    bank: banked ? "banked" : "off",
    // the firmware's own crash dump, if this run ended in one
    exit: exitReport && Object.fromEntries(exitReport.rows),
    avg10s: {
      mips: avg("mips"), vratio: avg("vratio"), fps: avg("fps"),
      halts: avg("halts"), paintMsPerS: avg("paintMsPerS"),
    },
    samples: hudSamples,
  };
}

let diagFlash = 0;
$("btn-diag").addEventListener("click", async () => {
  const label = $("btn-diag-text");
  let word = "Copied";
  try {
    await navigator.clipboard.writeText(JSON.stringify(diagnostics(), null, 1));
    say("Diagnostics copied to the clipboard");
  } catch {
    word = "Clipboard blocked";
    say("Could not reach the clipboard");
  }
  clearTimeout(diagFlash);
  label.textContent = word;
  diagFlash = setTimeout(() => { label.textContent = "Copy diagnostics"; }, 1600);
});

// drawHud so a driver can render the strip without a guest to sample: it is
// an overlay on the screen box now, so it never shows on its own until one
// is running
window.__hud = { shortUserAgent, diagnostics, drawHud };

hudReady = true;
syncHud();   // applies the remembered toggle, and nothing above could

/* ------------------------------------------------------------------ */
/* keypad: one <button> per phone key                                   */
/* ------------------------------------------------------------------ */

// the key the phone last saw let go, and when (guest ns): a typed character
// on that same key has to wait out the multi-tap window first (see typing)
let lastRelease = null;

// A phone key edge: now, or with `after` (ms) once that much guest time has
// passed since the edge queued before it reached the phone. Typing's taps
// go that way, so the phone sees their holds and gaps however fast it runs
// against the page; keysTaken() dates the release when it is in.
function sendKey(phoneKey, down, after) {
  const m = liveModule();
  if (!m?._wasm_send_key) return;
  const lnx = KEY_TO_LINUX[phoneKey];
  if (lnx == null) return;
  if (after == null) m._wasm_send_key(lnx, down ? 1 : 0);
  else m._wasm_send_key_after(lnx, down ? 1 : 0, Math.round(after * 1000));
  if (!down) lastRelease = { m, key: phoneKey, at: Number(m._wasm_vclock()), queued: after != null };
}

const KEY_SELECTOR =
  "#keypad button[data-key], .aux-keys-left button[data-key], .aux-keys-right button[data-key]";

// press-and-hold wiring for every on-screen key; re-run after each keyboard
// render since the buttons are rebuilt per layout
function bindKeypad() {
  for (const btn of document.querySelectorAll(KEY_SELECTOR)) {
    const key = btn.dataset.key;
    const press = (ev) => {
      ev.preventDefault();
      // a touch has no travel and no click to feel — give it one
      if (ev.pointerType === "touch") navigator.vibrate?.(20);
      btn.classList.add("pressed");
      sendKey(key, true);
    };
    const release = () => {
      // pointerleave fires on a button the pointer merely moved over — and
      // on one that simply rendered under a stationary pointer, which is
      // what a layout change after Start does.  Only a key we actually
      // pressed has a release to send; otherwise the phone gets a key-up
      // for a key that was never down.
      if (!btn.classList.contains("pressed")) return;
      btn.classList.remove("pressed");
      sendKey(key, false);
    };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
    // a click no pointer made (detail 0): Enter or Space on a focused key, or
    // an assistive technology's "activate"; a pointer's own click is ignored,
    // its press and release went out above
    btn.addEventListener("click", (ev) => { if (ev.detail === 0) tapKey(key); });
  }
}

// one press of a phone key, held as long as the phone takes a tap
function tapKey(key) {
  const m = liveModule();
  if (!m) return;
  if (typeBusy) { typeQueue.push({ key, down: true }, { key, down: false }); return; }
  const hold = tapTiming()?.hold ?? 100;
  if (canQueueKeys(m)) {
    sendKey(key, true, 0);
    sendKey(key, false, hold);
  } else {
    sendKey(key, true);
    setTimeout(() => { if (liveModule() === m) sendKey(key, false); }, hold);
  }
}

// Holding a key must not turn into a gesture on the page. These are
// delegated on the containers, which keyboards.js only ever replaceChildren()
// on, so a layout switch cannot leave a rebuilt key uncovered.
for (const id of ["keypad", "aux-keys-left", "aux-keys-right"]) {
  const box = $(id);
  for (const type of ["contextmenu", "selectstart", "dragstart"]) {
    box.addEventListener(type, (e) => { if (e.target.closest("button")) e.preventDefault(); });
  }
}

// label each key with the physical key that presses it; the labels stay in
// the DOM and the "Show shortcuts on keys" checkbox only toggles a body class
function renderKeyHints() {
  for (const btn of document.querySelectorAll(KEY_SELECTOR)) {
    const hint = KEY_HINT[btn.dataset.key];
    if (!hint) continue;
    const el = document.createElement("span");
    el.className = "key-hint";
    el.textContent = hint;
    btn.appendChild(el);
  }
}

// both halves of a keypad re-render (keyboards.js rebuilds the buttons)
function renderKeypad() {
  bindKeypad();
  renderKeyHints();
}

/* ------------------------------------------------------------------ */
/* on-screen keyboard pickers (definitions live in keyboards.js): which     */
/* phone's keypad, and which letter variant is printed on it               */
/* ------------------------------------------------------------------ */

const kbdSel = $("kbd-keyboard");
const varSel = $("kbd-variant");

function fillSelect(sel, entries, value) {
  sel.replaceChildren(...entries.map(([id, { name }]) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    return opt;
  }));
  sel.value = value;
}

// "Type letters on the phone": the multi-tap table of the keyboard on screen
// (keyboards.js tapTable()). A keyboard without one has nothing to type with,
// so the option is greyed out there rather than silently doing nothing.
// On wherever there is a table, unless it was turned off.
const typeChk = $("kbd-typing");
let typing = { chars: new Map() };
typeChk.checked = store.get("kbd-typing") !== "0";
typeChk.addEventListener("change", () => {
  store.set("kbd-typing", typeChk.checked ? "1" : "0");
});

// typing paces its taps through the guest-timed key queue, which a ?dist=
// built before qemu 8fb9035755 does not export; the greyed checkbox is what
// keeps keydown away from it, so every guest that goes live refreshes it
const canQueueKeys = (m) => !!(m?._wasm_send_key_after && m._wasm_keys_queued && m._wasm_key_last_at);

function refreshTyping() {
  const none = typing.chars.size === 0;
  const m = liveModule();
  const noQueue = !!m && !canQueueKeys(m);
  typeChk.disabled = none || noQueue;
  typeChk.parentElement.title = none
    ? "This keyboard has no multi-tap table"
    : noQueue ? "This emulator build cannot pace typed keys"
    : "Letters, space and punctuation press the digit key they are on, as many times as the phone needs";
}

// apply the pickers and remember them; keeps the chosen variant across a
// keyboard switch whenever the new keyboard also has it (see pickVariant).
// What is remembered is the letter set the user *asked for*, not the one
// that ended up on screen: hopping through a keyboard that has only English
// (the KE970) would otherwise drop a Russian choice for good.
let wantedVariant = "en";
function selectKeyboard(wanted = wantedVariant) {
  wantedVariant = wanted;
  const kbd = KBD_KEYBOARDS[kbdSel.value];
  const variant = pickVariant(kbdSel.value, wanted);
  fillSelect(varSel, Object.entries(kbd.variants), variant);
  applyKbdLayout(kbdSel.value, variant, renderKeypad);
  typing = tapTable(kbdSel.value, variant);
  refreshTyping();
  store.set("kbd-keyboard", kbdSel.value);
  store.set("kbd-variant", wanted);
}

fillSelect(kbdSel, Object.entries(KBD_KEYBOARDS), DEFAULT_KEYBOARD);
// the pre-split picker remembered one id per keyboard+variant ("ke800_ru")
const legacy = store.get("kbd-layout") ?? "";
kbdSel.value = store.get("kbd-keyboard")
  ?? (legacy.startsWith("ke800") ? "ke800" : DEFAULT_KEYBOARD);
if (!(kbdSel.value in KBD_KEYBOARDS)) kbdSel.value = DEFAULT_KEYBOARD;
selectKeyboard(store.get("kbd-variant")
  ?? (legacy.endsWith("ru") ? "ru" : "en"));

kbdSel.addEventListener("change", () => selectKeyboard());
varSel.addEventListener("change", () => selectKeyboard(varSel.value));

// key-binding hints: on by default on a desktop (a pointer that hovers and
// can point precisely => a real keyboard is attached, and a window wide
// enough to be one), off on phone-sized screens; the remembered choice wins
// over that default
const hintsChk = $("kbd-hints");
const storedHints = store.get("kbd-hints");
hintsChk.checked = storedHints == null
  ? matchMedia("(hover: hover) and (pointer: fine) and (min-width: 640px)").matches
  : storedHints === "1";
const showKeyHints = () =>
  document.body.classList.toggle("show-key-hints", hintsChk.checked);
showKeyHints();
hintsChk.addEventListener("change", () => {
  showKeyHints();
  store.set("kbd-hints", hintsChk.checked ? "1" : "0");
});

/* ---- typing: a character becomes its digit key, pressed N times ---- */

// Each tap is held and then let go for as long as the phone needs
// (keyboards.js *_TIMING), and a character on the key just used first waits
// out its multi-tap timeout. All of it is guest time: the firmware times its
// multi-tap window on the guest clock, which falls behind the wall clock on
// a slow host.
const typingSetting = (setting) => {
  const dev = ranDevice ?? currentDevice();
  return forDevice(setting, dev, dev && boardCpu(dev));
};
const tapTiming = () => typingSetting(typing.timing);

// Typed characters and the physical keys pressed among them, in order:
// { key, count } is a character's taps, { keys, settle, after } a character's
// way through the symbol picker (one press each), { key, down } one edge of a phone
// key. While anything is queued every physical key goes through here too,
// or an Enter typed after a word would reach the phone before the word.
const typeQueue = [];
let typeBusy = false;

// resolves false if the guest went away (or was replaced) meanwhile
async function guestWait(m, ms, from = Number(m._wasm_vclock())) {
  while (liveModule() === m) {
    if (Number(m._wasm_vclock()) - from >= ms * 1e6) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

// resolves once the phone has every queued key edge (false as guestWait)
async function keysTaken(m) {
  while (liveModule() === m) {
    if (!m._wasm_keys_queued()) {
      if (lastRelease?.m === m && lastRelease.queued) {
        lastRelease = { ...lastRelease, at: Number(m._wasm_key_last_at()), queued: false };
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

// The case the phone's letters come out in, as far as typing has left it
// (keyboards.js *_UPPER): "lower", "one" (a capital for one letter just
// went by) or "caps". Per guest; it takes the phone to start in lower case.
let caseState = { m: null, state: "lower" };

// The case presses round a typed character (keyboards.js caseStep), with
// the state kept per guest. caseStep's own result is handed on, so a
// character costs one object, as before the split.
function casePresses(a, m) {
  const up = typing.upper;
  if (up?.capital && caseState.m !== m) caseState = { m, state: "lower" };
  const step = caseStep(up, caseState.state, a);
  if (up?.capital) caseState.state = step.state;
  return step;
}

async function pumpTyping() {
  if (typeBusy) return;
  typeBusy = true;
  const m = liveModule();
  const { hold, gap, pause } = tapTiming();
  try {
    while (m && typeQueue.length) {
      const a = typeQueue.shift();
      if ("down" in a) {
        sendKey(a.key, a.down, a.down ? gap : hold);
        if (!(await keysTaken(m))) break;
        continue;
      }
      const { before, after } = casePresses(a, m);
      // A letter still pending on the key just used would take these taps as
      // its own. Before a # that is any pending letter: a Siemens # does not
      // commit it, but changes its case and the mode (S75: "ABc" came out
      // "ACC").
      const pending = before.length ? /^\d$/.test(lastRelease?.key) : lastRelease?.key === a.key;
      if ((a.count || before.length) && pending && lastRelease.m === m
          && !(await guestWait(m, pause, lastRelease.at))) break;
      // a phone that swallows the first key after a quiet spell (keyboards.js
      // LG_WAKE) gets a harmless one first
      const quiet = typing.wake && !(lastRelease?.m === m
        && Number(m._wasm_vclock()) - lastRelease.at < typing.wake.idle * 1e6);
      // the presses after a letter wait for it to be taken, for the same reason
      const own = a.keys ?? Array(a.count).fill(a.key);
      const keys = [...(quiet ? [typing.wake.key] : []), ...before, ...own, ...after];
      const opener = quiet ? 1 : 0;   // a picker's settle follows the press that opened it
      const taken = keys.length - after.length - 1;
      const settle = (i) => i === opener ? a.settle ?? 0
        : i === keys.length - 1 ? a.after ?? 0
        : i === taken && after.length ? pause : 0;
      // the phone gets the character's edges with their spacing in its own time
      for (let i = 0; i < keys.length; i++) {
        sendKey(keys[i], true, i ? gap + settle(i - 1) : 0);
        sendKey(keys[i], false, hold);
      }
      if (!(await keysTaken(m))
          || !(await guestWait(m, gap + settle(keys.length - 1), lastRelease.at))) break;
    }
  } finally {
    typeQueue.length = 0;   // what a stopped guest left undone is dropped
    typeBusy = false;
  }
}

function pressPhysical(key, down) {
  if (!typeBusy) { sendKey(key, down); return; }
  typeQueue.push({ key, down });
}

// Shortcuts that sit on character keys only for want of better ones (volume
// on - and =, # on /, * on `). While typing is on these keys type their
// characters, and volume, # and * are left to the numpad.
const TYPING_TAKES = new Set(["Minus", "Equal", "Slash", "Backquote"]);

// The presses for the character a keydown types, or null when it is not one
// to type. A key that is a phone key of its own (CODE_TO_KEY) stays that key;
// with Shift it types the character printed on it instead (Shift+1 is "!",
// Shift+Enter a new line). Ctrl/Alt/Meta shortcuts are left to the browser,
// but AltGr — which reports Ctrl+Alt on Windows — is how many layouts type
// their letters.
function typedTaps(e) {
  if (!typeChk.checked || typeChk.disabled || !liveModule()) return null;
  if ((e.ctrlKey || e.altKey || e.metaKey) && !e.getModifierState("AltGraph")) return null;
  if (CODE_TO_KEY[e.code] && !e.shiftKey && !TYPING_TAKES.has(e.code)) return null;
  const ch = e.key === "Enter" ? "\n" : e.key;
  if ([...ch].length !== 1) return null;
  const lower = ch.toLowerCase();
  const taps = typing.chars.get(lower);
  // a letter: its lower case's taps, which the keyboard's case presses
  // (casePresses) turn into the case it was typed in
  if (taps?.count && lower !== ch.toUpperCase()) return { ...taps, upper: lower !== ch, letter: true };
  return taps ?? typing.chars.get(ch) ?? null;
}

// a keydown typing has taken from its shortcut, whether or not this phone
// can type the character: a phone with no new line (LG) must not take
// Shift+Enter as the joystick press, which sends the message
const typingOwns = (e) => typeChk.checked && !typeChk.disabled && !!liveModule()
  && (TYPING_TAKES.has(e.code) || (e.key === "Enter" && e.shiftKey))
  && !(e.ctrlKey || e.altKey || e.metaKey);

// The key Backspace presses while typing: the keyboard's erase key, which on
// the generic Siemens keyboard depends on the device (keyboards.js).
function eraseKey(e) {
  if (e.code !== "Backspace" || e.ctrlKey || e.altKey || e.metaKey) return null;
  if (!typeChk.checked || typeChk.disabled || !liveModule()) return null;
  return typingSetting(typing.erase) ?? null;
}

// Fields that take text keep their keys. A checkbox does not take any, and
// it is what holds the focus right after ticking "Type letters on the phone".
const takesText = (el) => el.isContentEditable || el.tagName === "TEXTAREA"
  || el.tagName === "SELECT" || (el.tagName === "INPUT" && el.type !== "checkbox");

// The control that the keyboard last focused: Enter and Space are its own (on
// a phone key they press that key, tapKey). One focused by a click is left
// out, or a mouse user typing into the phone after muting it would toggle the
// sound with each space. :focus-visible tells the two apart only at focus time, since any
// keydown makes the focused element match it.
let keyboardFocus = null;
document.addEventListener("focusin", (e) => {
  const t = e.target;
  keyboardFocus = t.matches?.("button, summary, a[href]")
    && t.matches(":focus-visible") ? t : null;
});

// physical keyboard -> phone keys
const heldKeys = new Set();
window.addEventListener("keydown", (e) => {
  // no guest, no phone: the keys stay the browser's
  if (!running) return;
  if (takesText(e.target)) return;
  // a key a handler has already taken, such as the Escape that closes a sheet
  if (e.defaultPrevented) return;
  // Ctrl/Alt/Meta combinations are the browser's (zoom, history); AltGr,
  // which reports Ctrl+Alt on Windows, types letters (typedTaps)
  if ((e.ctrlKey || e.altKey || e.metaKey) && !e.getModifierState("AltGraph")) return;
  if (e.target === keyboardFocus && (e.key === "Enter" || e.key === " ")) return;
  const erase = eraseKey(e);
  if (erase) {
    e.preventDefault();
    // a held Backspace erases at the phone's pace and stops when let go
    if (e.repeat && (typeBusy || typeQueue.length)) return;
    typeQueue.push({ keys: [erase] });
    pumpTyping();
    return;
  }
  const taps = typedTaps(e);
  if (taps) {
    // Space would otherwise scroll the page or press the focused button
    e.preventDefault();
    if (e.repeat) return;
    typeQueue.push(taps);
    pumpTyping();
    return;
  }
  if (typingOwns(e)) { e.preventDefault(); return; }
  const key = CODE_TO_KEY[e.code];
  if (!key) return;
  // prevent on repeats too: otherwise holding an arrow key scrolls the page
  e.preventDefault();
  if (heldKeys.has(e.code)) return;
  heldKeys.add(e.code);
  pressPhysical(key, true);
});
window.addEventListener("keyup", (e) => {
  if (!heldKeys.delete(e.code)) return;
  const key = CODE_TO_KEY[e.code];
  if (key) pressPhysical(key, false);
});
// a key let go while the window has no focus never sends its keyup
function releaseHeldKeys() {
  for (const code of heldKeys) pressPhysical(CODE_TO_KEY[code], false);
  heldKeys.clear();
}
window.addEventListener("blur", releaseHeldKeys);
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseHeldKeys(); });

// The tools/ drivers set these fields straight from Playwright, whose
// actionability checks fail on anything a folded <details> keeps hidden.
if (navigator.webdriver) $("advanced").open = true;

/* ------------------------------------------------------------------ */
/* start-up                                                             */
/* ------------------------------------------------------------------ */

// Cross-origin isolation is required for SharedArrayBuffer (pthread build).
// "not isolated" has several distinct causes — say which one this is.
async function diagnoseIsolation() {
  const why = [];
  if (!window.isSecureContext) {
    if (location.protocol === "https:") why.push("https certificate not accepted");
    else if (!["localhost", "127.0.0.1", "::1"].includes(location.hostname))
      why.push(`insecure origin (${location.host}) — COOP/COEP are ignored on plain http; serve.mjs redirects LAN clients to its https port`);
    else why.push("insecure origin");
  } else {
    const h = await fetch(location.href, { method: "HEAD", cache: "no-store" })
      .then((r) => ({
        coop: r.headers.get("cross-origin-opener-policy"),
        coep: r.headers.get("cross-origin-embedder-policy"),
      }))
      .catch(() => null);
    if (!h || !h.coop || !h.coep)
      why.push(`no COOP/COEP headers (got COOP=${h?.coop} COEP=${h?.coep}) — serve site/ via ./serve.mjs`);
    else if (window.top !== window.self) why.push('embedded in a frame without allow="cross-origin-isolated"');
    else why.push("browser ignored COOP/COEP — in-app browser/WebView? open in Chrome/Firefox/Safari");
  }
  if (/\bwv\b/.test(navigator.userAgent)) why.push("Android WebView cannot isolate — open in Chrome");
  setError("Page not cross-origin isolated — SharedArrayBuffer unavailable: " + why.join("; "),
    { block: true });
}

setMode("preset");   // Preset, with the last-used entry selected
applyLayout();
if (selectedPreset) syncKeyboardToDevice(inferDevice(selectedPreset.files[0]));
setAspect();

if (!crossOriginIsolated) diagnoseIsolation();
if (!DIST_OK) {
  setError(`?dist= must name a build directory under the site, such as ${DIST_DEFAULT} — not “${DIST}”`,
    { block: true });
}
// a cache that turns out to refuse has its own preset line
cacheChecked.then(() => { if (!cacheAvailable() && ffMode === "preset") refreshPresetUi(); });
boardsReady = loadBoards().catch((e) => {
  setError("boards.tar: " + e, { block: true });
  return null; // resolved-with-null: boot() re-checks boardsBuf below
});

// The engine prefetch: once the page itself is up — an idle callback
// where there is one, a short timeout where there is not; either way the
// fetch is async and page load never waits for it — pull the qemu wasm
// and the small Siemens keys tool in the background, so Start finds them
// ready instead of downloading them then. ensureEngine() (what boot()
// calls) shares the very same in-flight download when Start beats it.
{
  const kick = () => {
    // Start is blocked on a page that is not cross-origin isolated; device
    // detection still uses the Siemens module there
    if (crossOriginIsolated && DIST_OK) startEngine();
    loadSiemensFW().catch(() => {});
  };
  const idle = "requestIdleCallback" in window
    ? (f) => requestIdleCallback(f, { timeout: 4000 })
    : (f) => setTimeout(f, 800);
  if (document.readyState === "complete") idle(kick);
  else addEventListener("load", () => idle(kick), { once: true });
}

// ?suite= runs headlessly (tools/tcgisa.mjs): submit the boot form — the
// same path as pressing Start. Last, so the whole UI is wired before it fires.
if (SUITE_URL) {
  $("boot-form").requestSubmit();
} else if (SUITE) {
  setError(`?suite= must name a file under the site, such as dist/tcgisa.bin — not “${SUITE}”`,
    { block: true });
}
