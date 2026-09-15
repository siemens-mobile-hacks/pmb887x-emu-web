// qemu-pmb887x web frontend.
//
// Boots the wasm-compiled qemu-system-arm (arm-softmmu + TCI + the
// `-display wasm` backend) entirely in the browser:
//   - the fullflash picked by the user is written into the emscripten MEMFS,
//   - board configs are unpacked from boards.tar,
//   - PMB887X_* env vars mirror the pmb887x-emu-mcp `load` tool options,
//   - the LCD is repainted from the wasm framebuffer on requestAnimationFrame,
//   - every on-screen keypad <button data-key> maps to the same qcodes the
//     MCP `press_key` tool uses (converted to linux keycodes, which is what
//     this qemu fork's input layer consumes).

import { KBD_KEYBOARDS, DEFAULT_KEYBOARD, pickVariant, applyKbdLayout } from "./keyboards.js";
import {
  PRESET_FULLFLASHES, SIDE_CAR_RE, inferDevice, detectDevice,
  cacheAvailable, entryCacheState, downloadEntry, deleteEntry, readCachedEntry,
} from "./fullflashes.js";
import {
  readIdentity, recalc, recoverEsn, cachedEsnCount, clearEsnCache, workerCount,
} from "./recalc.js";

/* ------------------------------------------------------------------ */
/* phone key tables (mirrors pmb887x-emu-mcp/src/keys.ts + otp.ts)      */
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
  F5: "music", F6: "play", F7: "ptt", F8: "camera", F9: "browser",
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

// NOR flash OTP derivation (ported from pmb887x-emu-mcp/src/otp.ts)
const ESN_KEY = [0x32, 0xe5, 0xf7, 0x03];
const HEX = "0123456789ABCDEF";
function esnToOtp0(esn) {
  if (!/^[0-9A-Fa-f]{8}$/.test(esn)) throw new Error("ESN must be 8 hex chars");
  let out = "";
  for (let i = 0; i < 4; i++) {
    const byte = parseInt(esn.slice((3 - i) * 2, (3 - i) * 2 + 2), 16) ^ ESN_KEY[i];
    out += HEX[byte >> 4] + HEX[byte & 0xf];
  }
  return "0200" + out + "00000000";
}
function imeiToOtp1(imei) {
  if (!/^\d{15}$/.test(imei)) throw new Error("IMEI must be 15 digits");
  let out = "";
  for (let i = 0; i < 14; i += 2) out += imei[i + 1] + imei[i];
  return "0000" + out + "FF";
}

/* ------------------------------------------------------------------ */
/* tiny ustar reader for boards.tar                                     */
/* ------------------------------------------------------------------ */

function untar(buf, writeFn) {
  const dv = new DataView(buf);
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= buf.byteLength) {
    let name = dec.decode(new Uint8Array(buf, off, 100)).replace(/\0.*$/, "");
    const size = parseInt(dec.decode(new Uint8Array(buf, off + 124, 12)).replace(/[\0 ].*$/, ""), 8) || 0;
    const type = String.fromCharCode(dv.getUint8(off + 156));
    if (!name) break;
    if (name.startsWith("./")) name = name.slice(2);
    // ustar prefix field
    const prefix = dec.decode(new Uint8Array(buf, off + 345, 155)).replace(/\0.*$/, "");
    if (prefix) name = prefix.replace(/\/$/, "") + "/" + name;
    if (type === "0" || type === "\0") {
      writeFn(name, new Uint8Array(buf, off + 512, size));
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

/* ------------------------------------------------------------------ */
/* state                                                                */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
let qemuModule = null;   // current emscripten module instance
let running = false;     // a guest is live (the module object outlives it)
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
let boardsReady = null;   // loadBoards() promise — boot() awaits it
let pendingDevice = null; // device inferred from a fullflash picked before
                          // boards.tar finished loading (slow links)

// The one place the whole UI reads its run state from:
//   idle | downloading | booting | running | paused
// ("paused" has no trigger yet — qemu's wasm display backend exposes no
// vm_stop; the pill, the export buttons and the lock all handle it, so
// wiring one up is a one-liner here.)
let emuState = "idle";
let runStartedAt = 0;     // uptime origin, reset on every Start
let uptimeTimer = 0;
let dlLoaded = 0, dlTotal = 0; // preset download progress, for the pill
let esnPct = 0;                // ESN sweep progress, likewise
let errorMsg = null;      // shown in place of the pill's state text
let startBlocked = false; // a failure Start cannot recover from (isolation)
// The exports read this run's MEMFS, which outlives the guest: once a boot
// has got that far they stay available after Stop, until the next Start
// replaces the image. ranDevice is the phone they belong to — only an LG
// one has an EFA block to hand back.
let exportsReady = false;
let ranDevice = null;
// The filename the image came in under, so a saved dump is named after it.
let ranFlashName = null;
// What Advanced ▸ Siemens keys did to this run's image, for Copy diagnostics.
let keyReport = null;
// The ESN sweep's AbortController while it runs — Cancel uses it, the way
// downloadAbort works for a preset download.
let esnAbort = null;
// §6 of the HUD criteria: the guest has been slower than 0.80x for three
// seconds. Drawn on the pill whether or not the HUD itself is shown.
let slow = false;
// icount_rtcap_mode(): 0 off, 1 banked, 2 strict. The cap ships banked for
// the guest's first 30 s of its own clock — the boot — and strict after, and
// §6 stays quiet while banked (see trackSpeed).
let rtcapMode = 0;

const statusEl = $("status");
const statusTextEl = $("status-text");
const pillActionEl = $("pill-action");
const captionEl = $("status-caption");
const statusBlock = document.querySelector(".status-block");
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
  const stored = localStorage.getItem(SIEMENS_MODE_KEY);
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
    localStorage.setItem(SIEMENS_MODE_KEY, r.value);
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
  ["operator", "operator"], ["startup", "startup"]];
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
// "was last used", else the first entry (§1.2)
const lastPreset = presetById(localStorage.getItem("ff-preset") ?? "");
selectedPreset = lastPreset ?? PRESET_FULLFLASHES[0] ?? null;
if (selectedPreset) P.sel.value = selectedPreset.id;

// The cache state of the selected preset, the one line that replaced the
// two helper paragraphs and the "— cached" option suffix.
async function refreshPresetUi() {
  const entry = selectedPreset;
  if (!cacheAvailable()) {
    P.sel.disabled = true;
    presetState = { complete: false, count: 0, totalSize: 0 };
    P.status.className = "ff-status";
    P.status.textContent = "Browser cache unavailable — pick Own file";
    P.clear.hidden = true;
    P.device.textContent = "";
    refreshSiemensKeys();
    render();
    return;
  }
  presetState = entry ? await entryCacheState(entry)
    : { complete: false, count: 0, totalSize: 0 };
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
    localStorage.setItem("ff-preset", selectedPreset.id);
    syncKeyboardToDevice(inferDevice(selectedPreset.files[0]));
  }
  await refreshPresetUi();
  scheduleFit(); // a different phone, a different screen ratio
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
  // §1.4.5: the EFA block exists only for LG devices — a sidecar picked
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

// §1.5 — one selection can carry both slots. The rules are applied in
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
    // async: reading the image to name the device settles after this returns
    applyFullflashFile(ownBin).catch(() => {});
    if (efas.length === 1) ownEfa = efas[0];
    else if (others.length) setNote(O.note, null, `Ignored ${others.length} other file(s).`);
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

O.device.addEventListener("change", () => {
  setNote(O.devNote, null, "");
  syncKeyboardToDevice(O.device.value);
  renderOwn();
  render();
  scheduleFit(); // a different phone, a different screen ratio
});

/* ------------------------------------------------------------------ */
/* run state: the pill is the only Start/Stop (§2)                      */
/* ------------------------------------------------------------------ */

function currentDevice() {
  if (ffMode === "preset") {
    return selectedPreset ? inferDevice(selectedPreset.files[0]) : null;
  }
  return O.device.value || null;
}

// §2.2: preset mode needs a preset, own-file mode a .bin and a device.
// The sidecar never gates Start.
function firmwareReady() {
  if (startBlocked) return false;
  if (ffMode === "preset") return !!selectedPreset && cacheAvailable();
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
  // while the recording pill is up the two have to share one 32px row:
  // the uptime alone, no "Running · " in front of it
  const bare = !!recorder && phoneLayout.matches;
  // "· slow" is the pill's half of §6: the amber colour says something is
  // wrong, the word says what
  const tail = slow ? " · slow" : "";
  switch (emuState) {
    case "downloading": return `Downloading · ${fmtProgress(dlLoaded, dlTotal)}`;
    case "recovering": return `Recovering ESN · ${esnPct}%`;
    case "booting": return "Booting" + tail;
    case "running": return (bare ? "" : "Running · ") + mmss(Date.now() - runStartedAt) + tail;
    case "paused": return (bare ? "" : "Paused · ") + mmss(Date.now() - runStartedAt) + tail;
    default: return "Idle";
  }
}

// exactly one of Start / Stop / Cancel is ever in the DOM
let actionKind = null;
function renderAction() {
  const kind = emuState === "idle" ? "start"
    : (emuState === "downloading" || emuState === "recovering") ? "cancel" : "stop";
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
    b.append(kind === "start" ? "Start" : kind === "stop" ? "Stop" : "Cancel");
    b.addEventListener("click", kind === "start" ? () => boot() : stop);
    pillActionEl.replaceChildren(b);
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
  if (emuState !== "idle" || firmwareReady()) return "";
  if (ffMode === "own") return "Choose a file and device to start";
  return cacheAvailable() ? "Choose a firmware to start"
    : "Browser cache unavailable — switch to Own file";
}

// one place every part of the UI that depends on the run state is drawn
function render() {
  const locked = emuState === "booting" || emuState === "running" || emuState === "paused";
  const live = emuState === "running" || emuState === "paused";

  statusEl.dataset.state = emuState;
  statusEl.className = "status" + (errorMsg ? " error" : slow && locked ? " warn" : "");
  statusTextEl.textContent = pillText();
  renderAction();
  const cap = captionText();
  captionEl.textContent = cap;
  captionEl.hidden = !cap;

  // §1.7 — nothing in the Firmware panel can be touched while it is live.
  // The fieldset alone would do it, but only as a computed state: the
  // attribute goes on every control too, and the two things a `disabled`
  // fieldset cannot reach (the disclosure, the roving segmented tabindex)
  // lose their tab stop by hand.
  fwFieldset.disabled = locked;
  for (const el of fwFieldset.querySelectorAll("input, select, button")) el.disabled = locked;
  // the blanket re-enable above would undo the IMEI/ESN lock that
  // "Brute-force ESN" needs (their values come from the image there)
  if (!locked) refreshSiemensKeys();
  if (!cacheAvailable()) P.sel.disabled = true;
  for (const b of segButtons) {
    b.tabIndex = locked ? -1 : (b.getAttribute("aria-checked") === "true" ? 0 : -1);
  }
  $("ff-lock-note").hidden = !locked;
  advSummary.tabIndex = locked ? -1 : 0;

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

  $("btn-shot").disabled = !live;
  // §1 of the recording criteria: a capture can start as soon as there is
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
  // 320px the two pills plus four icons no longer fit the one 32px row. So
  // fullscreen stands down while a capture runs — it is not something to
  // toggle mid-capture anyway, since it resizes the canvas under the recorder.
  if (fsSupported) fsBtn.hidden = pillRec;
  const finishing = !!recorder && !pillRec;
  recBtn.title = finishing ? "Finish recording and save the .webm"
    : recBtn.dataset.unsupported ? "this browser has no MediaRecorder"
    : "Record the LCD to a .webm video";
  recBtn.setAttribute("aria-label", finishing ? "Finish recording"
    : canRecord ? "Start recording" : "Start recording (emulator not running)");

  // the pill text opens the Firmware sheet, but only where there is one and
  // only while the panel is not locked
  $("status-open").disabled = !phoneLayout.matches || emuState !== "idle";
  syncHud();
  window.__ui = {
    state: emuState, mode: ffMode, device: currentDevice(),
    ready: firmwareReady(), error: errorMsg, exitCode, slow,
    rtcap: ["off", "banked", "strict"][rtcapMode],
    serialTap: serialTapped,
    exit: exitReport && {
      type: exitReport.type, code: exitReport.code,
      fields: Object.fromEntries(exitReport.rows),
    },
  };
}

function setEmuState(next) {
  // every run gets its own metrics window: wall, virtual time and the slow
  // warning all start counting from the moment the guest does
  if (next === "booting" && emuState !== "booting") hudReset();
  emuState = next;
  if (next === "running" || next === "paused") startUptime();
  else stopUptime();
  render();
}

function startUptime() {
  if (uptimeTimer) return;
  uptimeTimer = setInterval(() => {
    if (emuState === "running" || emuState === "paused") statusTextEl.textContent = pillText();
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
}

/* ------------------------------------------------------------------ */
/* bottom sheets (§5.4)                                                 */
/* ------------------------------------------------------------------ */

const scrim = $("sheet-scrim");
let openSheetEl = null, sheetOpener = null;

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), ' +
  'select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

function openSheet(el, opener) {
  if (openSheetEl) closeSheet(true);
  openSheetEl = el;
  sheetOpener = opener ?? null;
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
  el.classList.remove("open");
  scrim.classList.remove("open");
  el.style.transform = "";
  const done = () => { el.hidden = true; scrim.hidden = true; };
  if (immediate) done(); else setTimeout(done, 240);
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
  let y0 = null;
  const grip = (e) => e.target.closest(".sheet-handle, .sheet-title") || e.target === sheet;
  sheet.addEventListener("pointerdown", (e) => {
    if (!grip(e)) return;
    y0 = e.clientY;
    sheet.style.transition = "none";
  });
  sheet.addEventListener("pointermove", (e) => {
    if (y0 == null) return;
    const dy = Math.max(0, e.clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) {
    sheet.addEventListener(t, (e) => {
      if (y0 == null) return;
      const dy = Math.max(0, e.clientY - y0);
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

const phoneLayout = matchMedia("(max-width: 599px)");
const mainEl = document.querySelector("main");
const phonePanel = document.querySelector(".phone-panel");

function applyLayout() {
  if (phoneLayout.matches) {
    $("sheet-firmware-body").appendChild($("pre-panel"));
    $("sheet-settings-body").appendChild($("post-panel"));
    // §4 — an overlay on the top edge of the screen box, so the strip costs
    // the column no height and the keypad keeps every pixel it had
    document.querySelector(".lcd-wrap").appendChild(hudEl);
  } else {
    closeSheet(true);
    mainEl.insertBefore($("pre-panel"), phonePanel);
    mainEl.appendChild($("post-panel"));
    statusBlock.appendChild(hudEl);   // §5 — two lines under the pill
  }
  render(); // the pill says different things in the two layouts
  scheduleFit();
}
phoneLayout.addEventListener("change", applyLayout);

/* ------------------------------------------------------------------ */
/* device list                                                          */
/* ------------------------------------------------------------------ */

// board id -> its LCD0 panel size, read out of the board configs (they are
// the device profile: `[peripheral.LCD0] width/height`, possibly on the
// include the board `extends`). The phone layout sizes the screen box to
// this ratio, so the canvas fills it without letterboxing.
const boardText = new Map();   // "siemens-s75.toml" -> file contents
const panelCache = new Map();

function readPanel(file, depth = 0) {
  const txt = boardText.get(file);
  if (!txt || depth > 4) return null;
  const sec = txt.match(/\[peripheral\.LCD0\]([\s\S]*?)(?=\n\[|$)/);
  if (sec) {
    const w = sec[1].match(/^[ \t]*width[ \t]*=[ \t]*(\d+)/m);
    const h = sec[1].match(/^[ \t]*height[ \t]*=[ \t]*(\d+)/m);
    if (w && h) return { w: +w[1], h: +h[1] };
  }
  const ext = txt.match(/^[ \t]*extends[ \t]*=[ \t]*"([^"]+)"/m);
  return ext ? readPanel(ext[1], depth + 1) : null;
}

function panelFor(dev) {
  if (!dev) return null;
  if (!panelCache.has(dev)) panelCache.set(dev, readPanel(dev + ".toml"));
  return panelCache.get(dev);
}

// Upstream siemens-el71.toml declares model = "E71", the same as
// siemens-e71.toml, so the two boards would render under one name.
const BOARD_NAME_FIXUPS = { "siemens-el71": "BenQ-Siemens EL71" };

// The same configs carry the device's real name in `[board] vendor/model`,
// which is what qemu itself prints at boot ("Board: Siemens S75").
function readBoardName(file, depth = 0) {
  const txt = boardText.get(file);
  if (!txt || depth > 4) return null;
  const sec = txt.match(/\[board\]([\s\S]*?)(?=\n\[|$)/);
  if (sec) {
    const v = sec[1].match(/^[ \t]*vendor[ \t]*=[ \t]*"([^"]+)"/m);
    const m = sec[1].match(/^[ \t]*model[ \t]*=[ \t]*"([^"]+)"/m);
    if (v && m) return `${v[1]} ${m[1]}`;
  }
  const ext = txt.match(/^[ \t]*extends[ \t]*=[ \t]*"([^"]+)"/m);
  return ext ? readBoardName(ext[1], depth + 1) : null;
}

function boardLabel(dev) {
  return BOARD_NAME_FIXUPS[dev] ?? readBoardName(dev + ".toml") ?? dev;
}

async function loadBoards() {
  boardsBuf = await (await fetch("dist/boards.tar")).arrayBuffer();
  const files = [];
  untar(boardsBuf, (name, data) => files.push({ name, data }));
  const dec = new TextDecoder();
  for (const f of files) {
    if (f.name.endsWith(".toml")) boardText.set(f.name, dec.decode(f.data));
  }
  boards = files
    .filter((f) => /^[^/]+\.toml$/.test(f.name))
    .map((f) => ({ id: f.name.replace(/\.toml$/, ""), file: f }));
  const sel = O.device;
  // §1.4.4: the placeholder stays selected — no device is picked for the user
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
  if (pendingDevice && boards.some((b) => b.id === pendingDevice)) {
    sel.value = pendingDevice;
    pendingDevice = null;
    renderOwn();
  }
  render();
  scheduleFit(); // the panel size (and so the screen box) is known now
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

// Device + on-screen keyboard inference from a fullflash filename (§1.4.4
// allows it; the user can still change the dropdown).
function applyFullflashName(name) {
  const dev = inferDevice(name);
  applyDevice(dev);
  return !!dev;
}

function applyDevice(dev) {
  if (dev) {
    if (boards.some((b) => b.id === dev)) O.device.value = dev;
    else if (boardsReady) pendingDevice = dev; // boards.tar still loading
  }
  syncKeyboardToDevice(dev);
  refreshSiemensKeys();
}

// The filename is the cheap answer; when it gives nothing away (dump.bin,
// backup_2006.bin) the image itself says which phone it came off. Only ever
// fills the picker in — it never overrides a device already chosen by hand.
async function applyFullflashFile(file) {
  if (applyFullflashName(file.name)) return;
  setNote(O.devNote, null, "Detecting device…");
  const hit = await detectDevice(file);
  if (ownBin !== file) return;   // the user moved on while we were reading
  if (!hit) {
    setNote(O.devNote, null, "Couldn't detect the device — please choose it below.");
    return;
  }
  if (!hit.device) {
    setNote(O.devNote, "warn",
      `Detected ${hit.model}, which has no board yet — please choose the closest device below.`);
    return;
  }
  applyDevice(hit.device);
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

/* ?suite=<url>: the phase-0a guest op-suite (doc/wasm-tcg-backend-plan.md) —
 * boot -M versatilepb with the raw image fetched from <url> (built by
 * tests/tcg-isa, installed to dist/tcgisa.bin) instead of a phone: the
 * suite prints TAP + value dumps on the PL011 and exits via semihosting
 * SYS_EXIT, so the run ends in the normal onExit hook. */
/* ?dist=<dir>: which build output to run.  The default is the wasm64 TCG
 * backend build (dist-jit/): it is ~1.6x faster to the idle screen and
 * about half the download of the TCG-interpreter build, which stays
 * available as ?dist=dist (and is still what boards.tar is served from). */
const DIST = new URLSearchParams(location.search).get("dist") ||
             (new URLSearchParams(location.search).has("dist") ? "dist" : null);
const DIST_DEFAULT = "dist-jit";

let exitCode = null;

async function bootSuite(url) {
  errorMsg = null;
  exitCode = null;
  clearExit();
  serialTapped = false;
  ranDevice = null;       // not a phone: nothing here can EXIT
  ranFlashName = null;
  setEmuState("booting");
  showOverlay("Loading suite…");
  try {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const factory = (await import(`./${DIST || DIST_DEFAULT}/qemu-system-arm.js`)).default;
    let modRef = null; // FS access in onExit (qemuModule not yet assigned)
    /* ?icount=1: the phones' stock timing model — measures the icount
     * tax on the tcgbench workload (TB icount-capping + accounting +
     * virtual-timer runs) against the same run without it */
    const icount = new URLSearchParams(location.search).get("icount") === "1";
    qemuModule = await factory({
      arguments: [
        "-display", "wasm",
        "-M", "versatilepb",
        "-kernel", "/data/tcgisa.bin",
        "-semihosting",
        ...(icount ? ["-icount", "shift=3,sleep=off"] : []),
        "-serial", "file:/serial.log",
        "-monitor", "none",
      ],
      printErr: (t) => console.log("[qemu]", t),
      onExit: (code) => {
        // hand the finished serial log out before the runtime tears the
        // page down (the headless runner installs window.__suiteReport)
        try {
          const ser = new TextDecoder("latin1")
            .decode(modRef.FS.readFile("/serial.log"));
          window.__suiteReport?.(ser, code);
        } catch (e) { /* page going down anyway */ }
        onGuestExit(code);
      },
      preRun: (mod) => {
        modRef = mod;
        tapSerial(mod);
        for (const kv of new URLSearchParams(location.search).getAll("env")) {
          const i = kv.indexOf("=");
          if (i > 0) mod.ENV[kv.slice(0, i)] = kv.slice(i + 1);
        }
        if (new URLSearchParams(location.search).get("w64debug") === "1") {
          mod.ENV.W64_DEBUG = "1";
        }
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
  } catch (e) {
    console.error(e);
    setEmuState("idle");
    setError(String(e));
  }
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
        statusTextEl.textContent = pillText();
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
  // guest op-suite mode (phase 0a): no fullflash, no boards.tar needed
  {
    const qsp0 = new URLSearchParams(location.search);
    const suiteUrl = qsp0.get("suite");
    if (suiteUrl) {
      await bootSuite(suiteUrl);
      return;
    }
  }

  if (!firmwareReady()) { render(); return; }

  // boards.tar populates the device list and feeds preRun's untar — never
  // start a boot that could race it (device inference would be lost and
  // qemu would get an empty board dir).
  if (boardsReady) await boardsReady;
  if (!boardsBuf) {
    setError("boards.tar failed to load — reload the page", { block: true });
    return;
  }

  const device = currentDevice();
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

  const qsp = new URLSearchParams(location.search);
  const debug = qsp.get("debug") === "1";

  errorMsg = null;
  exitCode = null;
  clearExit();            // a new run, a screen that is lit again
  serialTapped = false;   // until this run's preRun says otherwise
  exportsReady = false;   // this run is about to replace the MEMFS image
  keyReport = null;
  ranDevice = device;
  ranFlashName = ffMode === "own"
    ? ownBin?.name ?? null
    : selectedPreset?.files[0] ?? null;
  setEmuState("booting");
  showOverlay("Loading…");
  scrollToPhone();

  // [[".cfi-efa", bytes], ...] — filled below, checked again after the boot
  let sidecarBytes = [];

  try {
    // Boot source: the preset read back from the browser cache, or the
    // picked local files. Both yield { name, arrayBuffer() } objects (the
    // preset one wraps the cached bytes).
    let file, sidecars;
    if (ffMode === "preset") {
      // First Start with this preset: download it into the browser cache
      // (live progress; later boots come straight from the cache).
      const st = await entryCacheState(selectedPreset);
      if (!st.complete) {
        presetBusy = true;
        // a 64 MiB fullflash is a long wait — Cancel stops it (the catch
        // below turns the AbortError into a plain "cancelled")
        downloadAbort = new AbortController();
        dlLoaded = 0;
        dlTotal = selectedPreset.size;
        setEmuState("downloading");
        await refreshPresetUi(); // say so on the preset line before byte one
        let doneBytes = 0, curFile = null, curTotal = 0;
        try {
          await downloadEntry(selectedPreset, (name, loaded, total) => {
            if (name !== curFile) { doneBytes += curTotal; curFile = name; }
            curTotal = total;
            dlLoaded = doneBytes + loaded;
            dlTotal = selectedPreset.size || (doneBytes + total);
            const pct = dlTotal ? Math.round((dlLoaded / dlTotal) * 100) : null;
            // straight to the three elements that move: this fires once per
            // stream chunk, far too often for a cache-state refresh
            statusTextEl.textContent = pillText();
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
      }
      showOverlay("Reading fullflash…");
      const cached = await readCachedEntry(selectedPreset); // main .bin first
      const shim = (f) => ({ name: f.name, arrayBuffer: async () => f.bytes.buffer });
      file = shim(cached[0]);
      sidecars = cached.slice(1).map(shim);
    } else {
      file = ownBin;
      // §1.5: a sidecar picked for a non-LG device is kept in the UI but
      // never handed to the emulator
      sidecars = ownEfa && device.startsWith("lg-") ? [ownEfa] : [];
    }

    // Compile the factory fresh per boot (the emscripten ES6 factory is
    // single-use once main() has run through exit()).
    showOverlay("Loading emulator…");
    const factory = (await import(`./${DIST || DIST_DEFAULT}/qemu-system-arm.js`)).default;
    showOverlay("Booting…", device);

    const flashBytes = new Uint8Array(await file.arrayBuffer());

    // Advanced ▸ Siemens keys. The image only ever lives in this run's
    // MEMFS, so "recalculate" changes this copy and the one Export ▸ Flash
    // hands back — never the preset cache or the file on disk.
    if (keyMode === "recalc") {
      showOverlay("Recalculating keys…", device);
      const r = await recalc(flashBytes, imei, parseInt(esn, 16));
      keyReport = { mode: keyMode, replaced: r.replaced, complete: r.complete };
      if (!r.complete) {
        say("Some EEPROM key blocks were not found — booting anyway");
        console.warn("[recalc]", r.log);
      }
      if (r.replaced) say(`Recalculated ${r.replaced} key items for ESN ${esn}`);
    } else if (keyMode === "recover-esn") {
      showOverlay("Reading fullflash keys…", device);
      const identity = await readIdentity(flashBytes);
      if (!identity.ok) {
        setEmuState("idle");   // no guest was ever started
        setError("This fullflash carries no intact keys to recover an ESN from — " +
          "pick “Automatically recalculate keys” instead.");
        return;
      }
      const found = await runEsnRecovery(identity, device);
      if (!found) return;   // cancelled, or the whole space held no answer
      imei = identity.imei;
      esn = (found.esn >>> 0).toString(16).padStart(8, "0");
      $("imei").value = imei;   // show what the image actually boots with
      $("esn").value = esn;
      keyReport = { mode: keyMode, esn, cached: found.cached, seconds: found.seconds };
      say(`ESN ${esn}${found.cached ? " (remembered)" : ""}`);
      refreshSiemensKeys();
      showOverlay("Booting…", device);
    }

    const otp0 = esnToOtp0(esn);
    const otp1 = imeiToOtp1(imei);

    for (const sc of sidecars) {
      const suffix = sc.name.match(SIDE_CAR_RE)[0].toLowerCase();
      if (sidecarBytes.some(([s]) => s === suffix)) continue; // first one wins
      sidecarBytes.push([suffix, new Uint8Array(await sc.arrayBuffer())]);
    }

    // qemu stderr -> browser console, deduped (madvise/mprotect spam otherwise).
    // ?tracebuf=1 keeps the raw last lines in window.__qemulog instead (no CDP flood).
    const seenMsg = new Map();
    const tracebuf = qsp.get("tracebuf") === "1";
    const logBuf = tracebuf ? [] : null;
    window.__qemulog = logBuf;
    const printErr = (t) => {
      if (tracebuf) {
        logBuf.push(t);
        if (logBuf.length > 30000) logBuf.splice(0, 10000);
        return;
      }
      if (debug) { console.log("[qemu]", t); return; }
      const n = (seenMsg.get(t) ?? 0) + 1;
      seenMsg.set(t, n);
      if (n === 1 || n % 500 === 0) console.log(`[qemu${n > 1 ? " x" + n : ""}]`, t);
    };

    // Timing model: stock icount with a fixed shift and sleep=off — virtual
    // time is strictly instruction-proportional (plus deterministic jumps to
    // the next timer deadline while the guest sleeps), so every firmware
    // timing budget carries a full instruction budget regardless of how slow
    // the wasm interpreter is (the phone merely boots in slow motion; see
    // doc/livelock-postmortem.md §4). LG firmware has no such budgets — it
    // boots fine on the plain realtime clock, so icount is off for it.
    // ?icount= overrides (e.g. precise-clocks=on, shift=4, none).
    const icount =
      qsp.get("icount") ??
      (device.startsWith("lg-") ? "none" : "shift=3,sleep=off");
    const trace = qsp.get("trace");
    const extraArgs = (qsp.get("qargs") ?? "").split(/\s+/).filter(Boolean);
    const args = [
      "-display", "wasm",
      ...(icount === "none" ? [] : ["-icount", icount]),
      "-machine", "pmb887x",
      // always writable: the image lives in MEMFS, so the firmware's writes
      // only ever touch this run's copy — and "Export flash" hands that
      // copy back
      "-drive", `if=pflash,format=raw,file=${FULLFLASH_PATH}`,
      "-serial", "file:/serial.log",
      "-monitor", "none",
      ...extraArgs,
    ];

    let modRef = null; // FS access in onExit (qemuModule not yet assigned)
    qemuModule = await factory({
      arguments: args,
      printErr,
      log: debug ? (t) => console.log("[log]", t) : undefined,
      onExit: (code) => {
        // hand the finished logs out before the runtime tears the page
        // down (the lockstep driver installs window.__lockstepReport)
        if (window.__lockstepReport && modRef) {
          try {
            const rd = (p) => {
              try { return new TextDecoder("latin1").decode(modRef.FS.readFile(p)); }
              catch { return null; }
            };
            window.__lockstepReport(rd("/serial.log"), rd("/lockstep.log"), code);
          } catch (e) { /* page going down anyway */ }
        }
        onGuestExit(code);
      },
      preRun: (mod) => {
        modRef = mod;
        tapSerial(mod);   // every byte the phone prints, as it prints it
        mod.FS.mkdirTree("/boards");
        untar(boardsBuf, (name, data) => {
          const path = "/boards/" + name;
          mod.FS.mkdirTree(path.split("/").slice(0, -1).join("/"));
          mod.FS.writeFile(path, data);
        });
        mod.FS.mkdirTree("/data");
        mod.FS.writeFile(FULLFLASH_PATH, flashBytes);
        for (const [suffix, bytes] of sidecarBytes)
          mod.FS.writeFile(FULLFLASH_PATH + suffix, bytes);
        mod.ENV.PMB887X_BOARD = `/boards/${device}.toml`;
        mod.ENV.PMB887X_STARTUP = startup;
        mod.ENV.PMB887X_SIM = sim;
        mod.ENV.PMB887X_SIM_OPERATOR = operator;
        mod.ENV.PMB887X_FLASH0_OTP0 = otp0;
        mod.ENV.PMB887X_FLASH0_OTP1 = otp1;
        if (trace) {
          mod.ENV.PMB887X_TRACE_LOG = trace;
          mod.ENV.PMB887X_TRACE_IO = trace;
        }
        if (qsp.get("icount2debug") === "1") {
          mod.ENV.QEMU_ICOUNT2_DEBUG = "1";
        }
        // ?rt=off|banked|banked:<n>|strict: real-time cap on the icount clock
        // (the vCPU sleeps instead of running its clocks ahead of wall time).
        // Default banked:30 — banked for the guest's first 30 s of its own
        // clock, so the boot is never slowed further, then strict, so a later
        // stall is not repaid by sprinting the phone's clock. Plain banked and
        // strict are pinned; the benchmarks pass rt=off to measure engine speed
        const rt = qsp.get("rt");
        if (rt) mod.ENV.QEMU_ICOUNT_RTCAP = rt;
        // ?lockstep=1: built-in guest-state fold (wasm64 backend,
        // doc/wasm-tcg-backend-plan.md §5) — env-driven twin of the
        // tests/lockstep.c plugin. Extra ls-* params map to
        // W64_LOCKSTEP_* (insns, period, epoch, meminsns, mem, from, to).
        if (qsp.get("lockstep")) {
          mod.ENV.W64_LOCKSTEP = "1";
          for (const k of ["insns", "period", "epoch", "meminsns", "mem", "from", "to"]) {
            const v = qsp.get("ls-" + k);
            if (v != null) mod.ENV["W64_LOCKSTEP_" + k.toUpperCase()] = v;
          }
        }
        // ?env=NAME=VAL (repeatable): extra environment — e.g.
        // env=W64_BATCH_N=8 shrinks the TB batch modules for testing
        // (wasm64 backend, phase 2)
        for (const kv of qsp.getAll("env")) {
          const i = kv.indexOf("=");
          if (i > 0) mod.ENV[kv.slice(0, i)] = kv.slice(i + 1);
        }
        // ?iorewind=1: force the stock io-recompile everywhere
        // (A/B against the wasm io accounting; see patches/0004)
        if (qsp.get("iorewind") === "1") {
          mod.ENV.QEMU_IO_REWIND = "1";
        }
      },
    });
  } catch (e) {
    setEmuState("idle");
    if (e?.name === "AbortError") {
      showOverlay("Ready to boot",
        "Download cancelled — whatever finished stays cached");
    } else {
      console.error(e);
      setError(String(e));
    }
    refreshPresetUi(); // a failed preset download changed the cache state
    return;
  }

  // LG firmware without the EFA block factory-resets its EEPROM; warn but boot.
  const noEfa = device.startsWith("lg-") && !sidecarBytes.some(([s]) => s === ".cfi-efa");
  hideOverlay();
  window.__qemu = qemuModule; // debugging hook
  startPainting();
  startSerial();
  running = true;
  exportsReady = true;
  runStartedAt = Date.now();
  setEmuState("running");
  if (noEfa) {
    captionEl.textContent = "No EFA block — the firmware may factory-reset.";
    captionEl.hidden = false;
  }
}

function onGuestExit(code) {
  running = false;
  exitCode = code;
  stopPainting();
  stopRecording();          // flushes whatever was captured
  finalExitCheck();         // a crash dump it printed on its way out
  setEmuState("idle");
  // the EXIT panel is the screen's own report; it replaces this one
  if (!exitReport) showOverlay("Ready to boot", `Exited (${code})`);
}

function stop() {
  // before the guest exists, the action is "cancel the fullflash download"
  if (downloadAbort) {
    downloadAbort.abort();
    return; // boot()'s catch reports it and re-arms Start
  }
  // ...or "cancel the ESN sweep", the other pre-guest wait worth stopping
  if (esnAbort) {
    esnAbort.abort();
    return; // runEsnRecovery() puts the page back to idle
  }
  // a capture in flight is finished and saved first — the frames stop
  // arriving the moment the guest goes away
  finishRecording(() => {
    // flushing the capture takes a moment, in which the guest can exit on its
    // own — then there is nothing left to stop, and onGuestExit already
    // put the page back to idle
    const m = liveModule();
    if (!m?._wasm_quit) return;
    m._wasm_quit();
    showOverlay("Stopping…");
  });
}

$("boot-form").addEventListener("submit", (e) => { e.preventDefault(); boot(); });

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

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadMemfs(path, name) {
  const m = qemuModule;
  if (!m?.FS?.analyzePath(path)?.exists) return false;
  downloadBlob(new Blob([m.FS.readFile(path)], { type: "application/octet-stream" }), name);
  return true;
}

/* ------------------------------------------------------------------ */
/* LCD capture: a PNG of the screen, or a .webm of it                   */
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
const REC_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
let recorder = null;
let recDone = null;   // ran after the file has been handed over
const recBtn = $("btn-record");
if (typeof MediaRecorder === "undefined") recBtn.dataset.unsupported = "1";

function say(msg) { $("live-region").textContent = msg; }

// after = what to do once the capture has been saved (Stop finishes the
// recording before it takes the guest down)
function finishRecording(after = null) {
  if (!recorder) { after?.(); return; }
  recDone = after;
  if (recorder.state !== "inactive") recorder.stop();
}
// the guest going away mid-capture: flush whatever was recorded
const stopRecording = () => finishRecording();

function startRecording() {
  if (recorder || recBtn.dataset.unsupported) return;
  const mimeType = REC_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  const stream = canvas.captureStream(30);
  const chunks = [];
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    for (const t of stream.getTracks()) t.stop();
    recorder = null;
    setRecordLabel(false);
    if (chunks.length) downloadBlob(new Blob(chunks, { type: mimeType || "video/webm" }),
      captureName() + ".webm");
    say("Recording saved");
    const after = recDone;
    recDone = null;
    after?.();
  };
  recorder.start();
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

function tapSerial(mod) {
  try {
    // ?serialpoll=1 exercises the fallback deliberately
    if (new URLSearchParams(location.search).get("serialpoll") === "1") {
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
  if (serialText.length > SERIAL_KEEP * 2) serialText = serialText.slice(-SERIAL_KEEP);
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
  serialWork = serialDraw = 0;
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
    const data = m.FS.readFile(SERIAL_PATH, { encoding: "binary" });
    const text = new TextDecoder("latin1").decode(
      data.length > SERIAL_KEEP ? data.subarray(data.length - SERIAL_KEEP) : data);
    if (text === serialText) return;
    serialText = text;
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
  const stored = localStorage.getItem(key);
  if (stored != null) chk.checked = stored === "1";
  apply();
  chk.addEventListener("change", () => {
    localStorage.setItem(key, chk.checked ? "1" : "0");
    apply();
  });
}

/* ------------------------------------------------------------------ */
/* LCD painting                                                         */
/* ------------------------------------------------------------------ */

const canvas = $("lcd");
const ctx = canvas.getContext("2d");

function startPainting() {
  cancelAnimationFrame(rafHandle);
  const step = () => {
    rafHandle = requestAnimationFrame(step);
    const m = liveModule();
    if (!m?._wasm_fb_ptr) return;
    if (!m._wasm_fb_take_dirty()) return;
    const w = m._wasm_fb_width(), h = m._wasm_fb_height(), stride = m._wasm_fb_stride();
    if (w <= 0 || h <= 0) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      scheduleFit(); // the guest's panel ratio is the real one
    }
    const addr = m._wasm_fb_ptr();
    const tPaint = performance.now();
    // staging is XRGB8888; wasm64 HEAPU8 offsets can exceed 32 bits, so go
    // through BigUint64Array addressing via DataView on the shared heap.
    const img = ctx.createImageData(w, h);
    const dst = new Uint32Array(img.data.buffer);
    const srcBytes = m.HEAPU8;
    const dv = new DataView(srcBytes.buffer);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = dv.getUint32(Number(addr) + y * stride + x * 4, true);
        // XRGB8888 (LE u32 0x00RRGGBB) -> canvas RGBA (LE u32 0xffBBGGRR):
        // swap R and B, then set alpha.
        dst[y * w + x] = 0xff000000 | ((px & 0x000000ff) << 16)
                       | (px & 0x0000ff00) | ((px >>> 16) & 0x000000ff);
      }
    }
    ctx.putImageData(img, 0, 0);
    paintMs += performance.now() - tPaint;
  };
  rafHandle = requestAnimationFrame(step);
}

function stopPainting() {
  cancelAnimationFrame(rafHandle);
  clearInterval(serialTimer);
  stopHudTimer();
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

const EXIT_MARK = ">>EXIT<<";        // x75/x85 opens with this
const EXIT_HEAD = "EXIT: ";          // x65 opens with the code instead
// what the firmware prints -> the row this page draws for it
const EXIT_FIELDS = [
  [EXIT_HEAD, "Code"],
  ["ExitType: ", "Type"],
  ["ExitCode: ", "Code"],
  ["FILE: ", "File"],
  ["At address: ", "Address"],
  ["ExitString: ", "String"],
  ["CepId: ", "CepId"],
  ["CepName: ", "CepName"],
  ["CPSR: ", "CPSR"],
  ["Checksum: ", "Checksum"],
  ["recursive Exit detected: ", "Recursive"],
  ["2nd Exit: ", "2nd exit"],
];

const EXIT_SETTLE_MS = 250;  // quiet on the port = the dump is all here
const EXIT_MAX_MS = 2000;    // …and a phone that will not stop talking
const EXIT_DIM = 0.45;       // the step the backlight going off is
const EXIT_FADE_MS = 30000;  // and how long the pixels take to follow it

let exitReport = null;    // the dump this run ended on, once it is complete
let exitPending = null;   // { at, timer } while one is still being printed

// Every trace message is framed: FF FE, a big-endian 16-bit length, that
// length with its low bit flipped, then that many bytes of text. Bytes that
// are not a frame (a half-written tail, a firmware that frames differently)
// are cut on their non-printable runs instead, which lands in the same
// places — the payloads themselves are plain ASCII.
function serialMessages(text) {
  const msgs = [];
  const at = (i) => text.charCodeAt(i);
  let i = 0, plainFrom = 0, end = text.length;
  const flushPlain = (to) => {
    for (const s of text.slice(plainFrom, to).split(/[^\x20-\x7e]+/))
      if (s.trim()) msgs.push(s);
  };
  while (i + 1 < end) {
    if (at(i) !== 0xff || at(i + 1) !== 0xfe) { i++; continue; }
    if (i + 6 > end) { end = i; break; }              // header still arriving
    const len = (at(i + 2) << 8) | at(i + 3);
    if (((at(i + 4) << 8) | at(i + 5)) !== (len ^ 1)) { i++; continue; }
    if (i + 6 + len > end) { end = i; break; }        // payload still arriving
    flushPlain(i);
    msgs.push(text.slice(i + 6, i + 6 + len));
    i = plainFrom = i + 6 + len;
  }
  flushPlain(end);
  return msgs;
}

// The newest dump in the log, or null. A dump is contiguous, so it ends at
// the first message that is not one of its fields.
function parseExit(msgs) {
  let at = -1;
  for (let i = msgs.length - 1; i >= 0 && at < 0; i--) {
    if (msgs[i] === EXIT_MARK || msgs[i].startsWith(EXIT_HEAD)) at = i;
  }
  if (at < 0) return null;
  const rows = [];
  for (let i = msgs[at] === EXIT_MARK ? at + 1 : at; i < msgs.length; i++) {
    const f = EXIT_FIELDS.find(([label]) => msgs[i].startsWith(label));
    if (!f) break;
    // x65 prints a label and its value as two messages ("FILE: ", "ddsphw")
    let value = msgs[i].slice(f[0].length).trim();
    if (!value && i + 1 < msgs.length
        && !EXIT_FIELDS.some(([label]) => msgs[i + 1].startsWith(label))) {
      value = msgs[++i].trim();
    }
    rows.push([f[1], value]);
  }
  const field = (name) => rows.find(([n]) => n === name)?.[1] ?? null;
  return { rows, type: field("Type"), code: field("Code") };
}

// Called whenever the phone has printed something (and once more when the
// guest goes away). A dump takes several writes, so it is presented once the
// port has gone quiet — never later than EXIT_MAX_MS after its first byte,
// in case the firmware carries on talking.
function watchForExit() {
  if (exitReport || !ranDevice?.startsWith("siemens-")) return;
  if (!exitPending) {
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
  if (!serialText) {
    const bytes = serialBytes();
    if (bytes) serialText = new TextDecoder("latin1").decode(bytes);
  }
  presentPendingExit(false);
}

function presentExit(report, quit) {
  if (exitReport) return;
  exitReport = report;
  exitPending = null;
  stopPainting();          // the last frame the phone drew stays on the canvas
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
/* fit the phone to the window height                                   */
/* ------------------------------------------------------------------ */

// At the browser's own zoom level the phone column is scaled (CSS `zoom`,
// so it takes real layout space and the grid keeps centring it) to exactly
// fill the window height: no scrollbar, no wasted height. It only ever
// takes the room the side panels leave — width is as much a cap as height,
// or a window barely past the three-column breakpoint would scale the phone
// to the height it has and slide it over the panels beside it.
//
// Browser zoom is left alone. The devicePixelRatio this page loaded at is
// the baseline; while it differs the user is zoomed, so we stop refitting
// and Ctrl+ simply makes everything bigger and the page scroll, as it
// should. Ctrl+0 comes back to the baseline and the fit resumes.
const SCALE_MIN = 0.55, SCALE_MAX = 2.5;
const baseDpr = window.devicePixelRatio;
// Two layouts are fitted: the three-column one, where the phone must share
// the window with the panels beside it, and the compact landscape one (LCD
// left, keypad right), where height is the scarce dimension. The stacked
// and phone layouts are left alone (the phone layout sizes the screen with
// flexbox instead).
const sideBySide = matchMedia("(min-width: 900px)");
const landscapeFit =
  matchMedia("(min-width: 600px) and (max-width: 899px) and (orientation: landscape)");

function fitPhone() {
  // the user is zoomed: keep the scale they were fitted at, so their zoom
  // multiplies on top of it instead of being cancelled out by a refit
  if (Math.abs(window.devicePixelRatio - baseDpr) > 0.01) return;
  if (!(sideBySide.matches || landscapeFit.matches)) {
    phonePanel.style.removeProperty("--ui-scale");
    return;
  }
  phonePanel.style.setProperty("--ui-scale", "1"); // measure it unscaled
  const nat = phonePanel.getBoundingClientRect();
  if (!nat.height) return;

  const cs = getComputedStyle(mainEl);
  const px = (v) => parseFloat(v) || 0;
  const padY = px(cs.paddingTop) + px(cs.paddingBottom);
  const inner = mainEl.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  let availH, availW;
  if (sideBySide.matches) {
    availH = window.innerHeight - mainEl.getBoundingClientRect().top - padY;
    // whatever the side panels do not use is the phone's to grow into
    const sides = [...mainEl.children]
      .filter((el) => el !== phonePanel)
      .reduce((w, el) => w + el.getBoundingClientRect().width + px(cs.columnGap), 0);
    availW = inner - sides;
  } else {
    // stacked: the phone gets a whole screenful once it is scrolled to
    availH = window.innerHeight - padY;
    availW = inner;
  }

  const scale = Math.min((availH - 2) / nat.height, availW / nat.width);
  // floored, never rounded up: rounding up is what puts a scrollbar back
  const set = (s) => {
    const v = Math.floor(Math.max(SCALE_MIN, Math.min(SCALE_MAX, s)) * 1000) / 1000;
    phonePanel.style.setProperty("--ui-scale", String(v));
    return v;
  };
  const applied = set(scale);
  // `zoom` rounds each box it scales, and over a keypad's worth of nested
  // boxes that rounding adds up to a few pixels — correct against the real
  // height rather than trusting the multiplication
  const got = phonePanel.getBoundingClientRect().height;
  if (got > availH - 2) set(applied * (availH - 2) / got);
}

// On the stacked layout the Firmware panel sits above the phone, so pressing
// Start would leave the screen — and the download progress drawn on it —
// below the fold. Three columns need no scrolling at all, and the phone
// layout has none to do.
function scrollToPhone() {
  if (sideBySide.matches || phoneLayout.matches) return;
  phonePanel.scrollIntoView({
    block: "start",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

/* ---- the phone layout's screen box ---- */
// The box is the device's own panel ratio, as large as fits in what the row
// leaves once the control row and the keypad have taken their height — so
// the canvas fills it exactly, with no letterbox inside and no bars around.
const lcdWrap = document.querySelector(".lcd-wrap");
const screenCell = document.querySelector(".screen-cell");
const screenRow = document.querySelector(".screen-row");
const auxCols = [...document.querySelectorAll(".aux-keys-left, .aux-keys-right")];
// the edge tabs when the screen box is width-limited and there is nothing
// spare, and the widest they are worth growing to (a full touch target)
const TAB_MIN = 14, TAB_MAX = 44;

function screenAspect() {
  // a live guest's framebuffer beats the board config
  if (running && canvas.width > 0 && canvas.height > 0) return canvas.width / canvas.height;
  const p = panelFor(currentDevice());
  return p ? p.w / p.h : 132 / 176;
}

function fitScreen() {
  if (!phoneLayout.matches) {
    lcdWrap.style.removeProperty("width");
    lcdWrap.style.removeProperty("height");
    screenRow.style.removeProperty("--tab-w");
    return;
  }
  // The row is `flex: 1; min-height: 0`, so its height is exactly what the
  // column has left once the status row and the keypad have taken their
  // natural heights — the browser has already done the constraint solving.
  // Fitting the box inside it is the whole job; there is no budget to compute
  // and nothing here can make the column taller than the viewport.
  const row = screenRow.getBoundingClientRect();
  const cellH = screenCell.getBoundingClientRect().height;
  if (!row.width || !cellH) return;
  // Width is measured from the row, not the cell, and against the tabs at
  // their *minimum*: the tabs are widened below out of whatever the box then
  // leaves, and deriving the box from a width the tabs have already taken
  // would feed that back in on the next fit.
  const gaps = (parseFloat(getComputedStyle(screenRow).columnGap) || 0) * 2;
  const cols = auxCols.filter((c) => c.children.length).length;
  const ar = screenAspect();
  let w = row.width - gaps - cols * TAB_MIN, h = w / ar;
  if (h > cellH) { h = cellH; w = h * ar; }   // height is tighter
  const wPx = Math.floor(w) + "px", hPx = Math.floor(h) + "px";
  if (lcdWrap.style.width !== wPx) lcdWrap.style.width = wPx;
  if (lcdWrap.style.height !== hPx) lcdWrap.style.height = hPx;
  // A ratio-locked box usually cannot use the full width; rather than leave
  // that blank either side of it, the edge tabs take it.
  const tabW = cols
    ? Math.max(TAB_MIN, Math.min(TAB_MAX, Math.floor((row.width - gaps - w) / cols)))
    : TAB_MIN;
  const tabPx = tabW + "px";
  if (screenRow.style.getPropertyValue("--tab-w") !== tabPx) {
    screenRow.style.setProperty("--tab-w", tabPx);
  }
}

// 100dvh is not the visible area on Chrome for Android while the URL bar is
// showing — the bottom of the column ends up under the browser chrome.
function syncAppHeight() {
  const vv = window.visualViewport;
  if (!vv?.height) return;
  // a pinch-zoom shrinks the visual viewport too, and rebuilding the layout
  // around it would fight the user's zoom — keep the last unzoomed height
  if (vv.scale > 1.01) return;
  document.documentElement.style.setProperty("--app-h", Math.round(vv.height) + "px");
}

let fitPending = 0;
function scheduleFit() {
  cancelAnimationFrame(fitPending);
  fitPending = requestAnimationFrame(() => {
    syncAppHeight(); fitPhone(); fitScreen(); refitHud(); drawVpProbe();
  });
}
window.addEventListener("resize", scheduleFit);
// the URL bar sliding in and out changes dvh without a window resize event
window.visualViewport?.addEventListener("resize", scheduleFit);
// ...and on Android it retracts on scroll, which fires neither resize event
window.visualViewport?.addEventListener("scroll", scheduleFit);
for (const mq of [sideBySide, landscapeFit, phoneLayout]) mq.addEventListener("change", scheduleFit);
// Whatever moves the row's height — a keypad with more rows, a sheet, the
// control row rewrapping — reaches the box through the cell, because flex has
// already resized the cell by the time this fires. Watching the cell alone is
// therefore enough. The HUD is as wide as the box it sits on, so it follows.
new ResizeObserver(() => { fitScreen(); refitHud(); }).observe(screenCell);
// the token budget follows the container width, wherever that came from
function refitHud() { if (!hudEl.hidden) drawHud(); }
document.fonts?.ready.then(scheduleFit);

/* ------------------------------------------------------------------ */
/* Performance HUD: two lines, and never a third                        */
/* ------------------------------------------------------------------ */

// Per-second guest rates, on the page itself so a phone can report them
// without a debugger. Line 1: speed (virtual seconds per wall second — 1.0
// is real time), MIPS (guest insns/s; 125 = real time under the stock icount
// shift=3), fps, the page's own paint cost, lag (wall − virtual since the
// run started: what the real-time cap still owes) and halts/s. Line 2: the
// machine they were measured on. Whatever the width, it is exactly two
// lines: tokens are dropped off the line, never wrapped or shrunk.
let paintMs = 0;
let hudTimer = 0;
const HUD_HALT_INDEX = 29;   // WASM_DIAG_HALT in include/qemu/wasm-diag.h
const HUD_MS = 500;          // 2 Hz — a readable number, not a per-frame one
const HUD_KEEP = 120;        // 60 s of samples for "Copy diagnostics"
const HUD_AVG = 20;          // the 10 s averages it still carries

let hudSamples = [];
let hudLast = null, hudNow = null, hudT0 = 0, hudV0 = null;
// lag has its own origin because the real-time cap forgives its debt when it
// switches from banked to strict: measured from hudT0 it would freeze at the
// switch and show a debt that no longer exists, for the rest of the run.
let lagT0 = 0, lagV0 = null;
let slowSince = 0, fastSince = 0;

/* ---- shortUserAgent(): "Android 8 · Chrome 147 · SM-G955U" ---- */

let uaShort = null;   // built once per page load

function uaOS(platform, platformVersion) {
  const ua = navigator.userAgent;
  if (platform) {
    const major = platformVersion ? String(platformVersion).split(".")[0] : null;
    // only the platforms whose release number anyone quotes carry one
    return major && (platform === "Android" || platform === "iOS")
      ? `${platform} ${major}` : platform;
  }
  let m;
  if ((m = ua.match(/Android (\d+)/))) return `Android ${m[1]}`;
  if ((m = ua.match(/(?:iPhone|CPU) OS (\d+)/))) return `iOS ${m[1]}`;
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

// Chromium shuffles navigator.userAgentData.brands on purpose (the "Not"
// entry is there to break naive parsers), so "the first one" is whichever it
// felt like this morning: take the specific brand over the generic engine
// one, and give it the name people call it by.
const UA_BRAND = {
  "Google Chrome": "Chrome", HeadlessChrome: "Chrome", Chromium: "Chrome",
  "Microsoft Edge": "Edge", Edg: "Edge", OPR: "Opera",
};
function uaBrowser() {
  const brands = navigator.userAgentData?.brands?.filter((b) => !/not/i.test(b.brand)) ?? [];
  const pick = brands.find((b) => b.brand !== "Chromium") ?? brands[0];
  if (pick) return `${UA_BRAND[pick.brand] ?? pick.brand} ${String(pick.version).split(".")[0]}`;
  const m = navigator.userAgent.match(/(Edg|OPR|Chrome|Firefox|Safari)\/(\d+)/);
  return m ? `${UA_BRAND[m[1]] ?? m[1]} ${m[2]}` : null;
}

function uaModel(mobile, hiModel) {
  if (!mobile) return null;
  // the reduced user agent calls every phone "K"; only UA-CH has the real one
  const fromUa = navigator.userAgent.match(/Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/|\))/)?.[1];
  const model = (hiModel || fromUa || "").trim();
  return model && model !== "K" ? model : null;
}

function buildShortUA(hi) {
  const d = navigator.userAgentData;
  const mobile = d?.mobile ?? /Mobi|Android/.test(navigator.userAgent);
  let os = uaOS(d?.platform, hi?.platformVersion);
  if (!mobile) {
    // §2's desktop line is "Linux x86_64 · Chrome 147": with no model to
    // name, the architecture rides with the OS rather than being a token
    const m = navigator.userAgent.match(/\b(x86_64|aarch64|arm64|Win64|WOW64)\b/);
    const arch = m && (m[1] === "Win64" || m[1] === "WOW64" ? "x64" : m[1]);
    if (arch && !(os ?? "").includes(arch)) os = os ? `${os} ${arch}` : arch;
  }
  // anything this browser will not say is left out, never printed as
  // "undefined"
  return [os, uaBrowser(), uaModel(mobile, hi?.model)].filter(Boolean).join(" · ");
}

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
// fit, lowest first: paint goes before halts because §3's two narrow cases
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
    fb: Number(m._wasm_fb_updates()), halts: Number(m._wasm_memstat(HUD_HALT_INDEX)), paint: paintMs };
  // virtual time already on the clock when this window opened: lag is wall
  // minus virtual *since then*, the only thing this window can measure
  hudV0 ??= s.v;
  lagV0 ??= s.v;
  // old dists have no such export — treat them as "off", i.e. exactly today
  const rt = m._wasm_rtcap ? m._wasm_rtcap() : 0;
  if (rt !== rtcapMode) {
    // the bank is written off at the switch, so lag restarts from here
    if (rtcapMode === 1) { lagT0 = s.t; lagV0 = s.v; }
    rtcapMode = rt;
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
  hudLast = s;
}

// §6: three consecutive seconds under 0.80x turn the pill amber, three back
// over it turn it green again. The hysteresis is the point — one slow sample
// (a GC pause, a tab coming back) must not flicker the pill.
function trackSpeed(vratio, now) {
  // While the cap is still banking (the guest's first 30 s of its own clock:
  // the boot) v/wall is below 1 by construction — the guest is behind and
  // allowed to catch up, not slow. Clearing both timers means the first
  // strict sample starts a clean three seconds rather than inheriting the
  // boot's.
  if (rtcapMode === 1) {
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
  slowSince = 0; fastSince = 0; slow = false; rtcapMode = 0;
  if (!hudEl.hidden) drawHud();
}

// A firmware EXIT ends the run before qemu has finished going away, and the
// strip shares the top of the screen box with the dump: the guest is dead,
// so there is nothing left to sample either way.
const hudLive = () => !exitReport
  && (emuState === "booting" || emuState === "running" || emuState === "paused");

// Both layouts follow the toggle; at phone widths the strip is an overlay on
// the screen box, so it waits for a guest rather than sitting on the idle
// "Ready to boot" panel (§4). The sampler follows the guest,
// not the strip: it runs for any live guest either way — the pill's slow
// warning does not wait for the strip — and stops the moment the guest goes,
// since there is nothing left to sample and calling the exports past the
// runtime's exit aborts it. A strip left on keeps the last window's numbers.
function syncHud() {
  if (!hudReady) return;
  const show = hudChk.checked && (!phoneLayout.matches || hudLive());
  const changed = hudEl.hidden === show;   // it was the other way a moment ago
  hudEl.hidden = !show;
  if (hudLive()) { if (!hudTimer) hudTimer = setInterval(hudTick, HUD_MS); }
  else stopHudTimer();
  if (show) drawHud();
  // off the phone layout the two lines are real height in the phone column
  if (changed && !phoneLayout.matches) scheduleFit();
}

function stopHudTimer() { clearInterval(hudTimer); hudTimer = 0; }

// the toggle takes effect immediately, mid-run or before one; with no choice
// stored it starts on at phone widths, which is where the strip is the only
// way to read the numbers without a debugger
const storedHud = localStorage.getItem("opt-hud");
hudChk.checked = storedHud == null ? phoneLayout.matches : storedHud === "1";
hudChk.addEventListener("change", () => {
  localStorage.setItem("opt-hud", hudChk.checked ? "1" : "0");
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
document.addEventListener("fullscreenchange", () => {
  syncFsBtn();
  scheduleFit();   // the visible viewport just changed by the height of two bars
});

/* ?vp=1 — the height budget drawn on the page, because "the keypad does not
 * fit" is reported with a screenshot and the numbers have to be in it. It is
 * what found the `min-height: 100vh` floor: the viewport figures all agreed,
 * and the tell was a `flex: 1` row measuring taller than its flex share,
 * which can only mean an ancestor is taller than the viewport. */
let vpEl = null;
const vpForced = new URLSearchParams(location.search).get("vp") === "1";

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
  if (!phoneLayout.matches) { if (vpEl) vpEl.hidden = true; return; }
  const v = viewportReport();
  // self-shows on a real overflow, so a regression is visible without knowing
  // to ask for it; ?vp=1 pins it on when nothing is wrong yet
  if (!vpForced && v.fits) { if (vpEl) vpEl.hidden = true; return; }
  vpEl = vpProbeEl();
  vpEl.hidden = false;
  vpEl.textContent =
    `inner ${v.inner}  visual ${v.visual}  client ${v.client}  dpr ${v.dpr}\n`
    + `appH ${v.appH}  bodyMin ${v.bodyMin}  safeBottom ${v.safeAreaBottom}`
    + `  fs ${v.fullscreen ? 1 : 0}\n`
    + `status ${v.status}  screen ${v.screen}  keypad ${v.keypad}\n`
    + `used ${v.used}  budget ${v.budget}  fits ${v.fits ? "YES" : "NO"}`;
}

// What the column had to divide up, so a "the keypad does not fit" report
// carries the numbers instead of a description.
function viewportReport() {
  const px = (v) => Math.round(parseFloat(v) || 0);
  const cs = getComputedStyle(document.querySelector("main"));
  const R = (s) => Math.round(document.querySelector(s)?.getBoundingClientRect().height ?? 0);
  const gap = px(getComputedStyle(phonePanel).rowGap);
  const used = R(".status-block") + R(".screen-row") + R("#keypad") + gap * 2;
  const budget = window.innerHeight - px(cs.paddingTop) - px(cs.paddingBottom);
  return {
    inner: window.innerHeight,
    visual: Math.round(window.visualViewport?.height ?? 0),
    client: document.documentElement.clientHeight,
    appH: px(getComputedStyle(document.documentElement).getPropertyValue("--app-h")),
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
    // rtcap makes vratio readable: 0.6x is a slow host under strict, but a
    // guest still catching up under banked
    device: currentDevice(), state: emuState, slow, exitCode,
    // the phone layout's height budget, for "the keypad does not fit" reports:
    // the viewport runs behind the system bars, so `inner` can exceed what is
    // actually on screen by `safeArea` (Android's gesture bar)
    viewport: phoneLayout.matches ? viewportReport() : null,
    // what Advanced ▸ Siemens keys was set to, and what it did to this image
    siemensMode: currentDevice()?.startsWith("siemens-") ? siemensMode() : null,
    siemensKeys: keyReport,
    rtcap: ["off", "banked", "strict"][rtcapMode],
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

window.__hud = { shortUserAgent, diagnostics };

hudReady = true;
syncHud();   // applies the remembered toggle, and nothing above could

/* ------------------------------------------------------------------ */
/* keypad: one <button> per phone key                                   */
/* ------------------------------------------------------------------ */

function sendKey(phoneKey, down) {
  const m = liveModule();
  if (!m?._wasm_send_key) return;
  const lnx = KEY_TO_LINUX[phoneKey];
  if (lnx == null) return;
  m._wasm_send_key(lnx, down ? 1 : 0);
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
      btn.classList.remove("pressed");
      sendKey(key, false);
    };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
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

// apply the pickers and remember them; keeps the chosen variant across a
// keyboard switch whenever the new keyboard also has it (see pickVariant)
function selectKeyboard(wanted = varSel.value) {
  const kbd = KBD_KEYBOARDS[kbdSel.value];
  const variant = pickVariant(kbdSel.value, wanted);
  fillSelect(varSel, Object.entries(kbd.variants), variant);
  applyKbdLayout(kbdSel.value, variant, renderKeypad);
  scheduleFit(); // boards differ in keypad height
  localStorage.setItem("kbd-keyboard", kbdSel.value);
  localStorage.setItem("kbd-variant", variant);
}

fillSelect(kbdSel, Object.entries(KBD_KEYBOARDS), DEFAULT_KEYBOARD);
// the pre-split picker remembered one id per keyboard+variant ("ke800_ru")
const legacy = localStorage.getItem("kbd-layout") ?? "";
kbdSel.value = localStorage.getItem("kbd-keyboard")
  ?? (legacy.startsWith("ke800") ? "ke800" : DEFAULT_KEYBOARD);
if (!(kbdSel.value in KBD_KEYBOARDS)) kbdSel.value = DEFAULT_KEYBOARD;
selectKeyboard(localStorage.getItem("kbd-variant")
  ?? (legacy.endsWith("ru") ? "ru" : "en"));

for (const sel of [kbdSel, varSel]) sel.addEventListener("change", () => selectKeyboard());

// key-binding hints: on by default on a desktop (a pointer that hovers and
// can point precisely => a real keyboard is attached, and a window wide
// enough to be one), off on phone-sized screens; the remembered choice wins
// over that default
const hintsChk = $("kbd-hints");
const storedHints = localStorage.getItem("kbd-hints");
hintsChk.checked = storedHints == null
  ? matchMedia("(hover: hover) and (pointer: fine) and (min-width: 640px)").matches
  : storedHints === "1";
const showKeyHints = () =>
  document.body.classList.toggle("show-key-hints", hintsChk.checked);
showKeyHints();
hintsChk.addEventListener("change", () => {
  showKeyHints();
  localStorage.setItem("kbd-hints", hintsChk.checked ? "1" : "0");
});

// physical keyboard -> phone keys
const heldKeys = new Set();
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const key = CODE_TO_KEY[e.code];
  if (!key) return;
  // prevent on repeats too: otherwise holding an arrow key scrolls the page
  e.preventDefault();
  if (heldKeys.has(e.code)) return;
  heldKeys.add(e.code);
  sendKey(key, true);
});
window.addEventListener("keyup", (e) => {
  if (!heldKeys.delete(e.code)) return;
  const key = CODE_TO_KEY[e.code];
  if (key) sendKey(key, false);
});

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

setMode("preset");   // §1.2 — Preset, with the last-used entry selected
applyLayout();
if (selectedPreset) syncKeyboardToDevice(inferDevice(selectedPreset.files[0]));
scheduleFit();

if (!crossOriginIsolated) diagnoseIsolation();
boardsReady = loadBoards().catch((e) => {
  setError("boards.tar: " + e, { block: true });
  return null; // resolved-with-null: boot() re-checks boardsBuf below
});

// ?suite= runs headlessly (phase-0a runner): submit the boot form — the same
// path as pressing Start. Last, so the whole UI is wired before it fires.
if (new URLSearchParams(location.search).get("suite")) {
  $("boot-form").requestSubmit();
}
