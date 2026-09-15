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
  PRESET_FULLFLASHES, SIDE_CAR_RE, inferDevice,
  cacheAvailable, entryCacheState, downloadEntry, deleteEntry, readCachedEntry,
} from "./fullflashes.js";

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
let errorMsg = null;      // shown in place of the pill's state text
let startBlocked = false; // a failure Start cannot recover from (isolation)
// The exports read this run's MEMFS, which outlives the guest: once a boot
// has got that far they stay available after Stop, until the next Start
// replaces the image. ranDevice is the phone they belong to — only an LG
// one has an EFA block to hand back.
let exportsReady = false;
let ranDevice = null;

const statusEl = $("status");
const statusTextEl = $("status-text");
const pillActionEl = $("pill-action");
const captionEl = $("status-caption");

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
    render();
    return;
  }
  presetState = entry ? await entryCacheState(entry)
    : { complete: false, count: 0, totalSize: 0 };
  P.clear.hidden = !entry || presetState.count === 0;
  P.device.textContent = entry
    ? `Device: ${inferDevice(entry.files[0]) ?? "unknown"} (from preset)` : "";
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
    applyFullflashName(ownBin.name);
    if (efas.length === 1) ownEfa = efas[0];
    else if (others.length) setNote(O.note, null, `Ignored ${others.length} other file(s).`);
  }
  if (ownEfa && O.device.value && !O.device.value.startsWith("lg-")) {
    setNote(O.devNote, "warn",
      "An EFA sidecar was provided but this device doesn't use one.");
  }
  renderOwn();
  render();
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
  switch (emuState) {
    case "downloading": return `Downloading · ${fmtProgress(dlLoaded, dlTotal)}`;
    case "booting": return "Booting";
    case "running": return (bare ? "" : "Running · ") + mmss(Date.now() - runStartedAt);
    case "paused": return (bare ? "" : "Paused · ") + mmss(Date.now() - runStartedAt);
    default: return "Idle";
  }
}

// exactly one of Start / Stop / Cancel is ever in the DOM
let actionKind = null;
function renderAction() {
  const kind = emuState === "idle" ? "start"
    : emuState === "downloading" ? "cancel" : "stop";
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
  statusEl.className = "status" + (errorMsg ? " error" : "");
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
  const finishing = !!recorder && !pillRec;
  recBtn.title = finishing ? "Finish recording and save the .webm"
    : recBtn.dataset.unsupported ? "this browser has no MediaRecorder"
    : "Record the LCD to a .webm video";
  recBtn.setAttribute("aria-label", finishing ? "Finish recording"
    : canRecord ? "Start recording" : "Start recording (emulator not running)");

  // the pill text opens the Firmware sheet, but only where there is one and
  // only while the panel is not locked
  $("status-open").disabled = !phoneLayout.matches || emuState !== "idle";
  window.__ui = {
    state: emuState, mode: ffMode, device: currentDevice(),
    ready: firmwareReady(), error: errorMsg, exitCode,
  };
}

function setEmuState(next) {
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
  } else {
    closeSheet(true);
    mainEl.insertBefore($("pre-panel"), phonePanel);
    mainEl.appendChild($("post-panel"));
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
  sel.replaceChildren(placeholder, ...boards
    .slice()
    .sort((a, z) => a.id.localeCompare(z.id))
    .map((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.id;
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
  if (dev) {
    if (boards.some((b) => b.id === dev)) O.device.value = dev;
    else if (boardsReady) pendingDevice = dev; // boards.tar still loading
  }
  syncKeyboardToDevice(dev);
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
    startSerialPoll();
    running = true;
    runStartedAt = Date.now();
    setEmuState("running");
  } catch (e) {
    console.error(e);
    setEmuState("idle");
    setError(String(e));
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
  const imei = $("imei").value.trim();
  const esn = $("esn").value.trim();
  const sim = $("sim").value;
  const operator = $("operator").value.trim();
  const startup = $("startup").value;

  if (!/^\d{15}$/.test(imei)) { setError("IMEI must be 15 digits"); return; }
  if (!/^[0-9A-Fa-f]{8}$/.test(esn)) { setError("ESN must be 8 hex chars"); return; }

  const qsp = new URLSearchParams(location.search);
  const debug = qsp.get("debug") === "1";

  const otp0 = esnToOtp0(esn);
  const otp1 = imeiToOtp1(imei);

  errorMsg = null;
  exitCode = null;
  exportsReady = false;   // this run is about to replace the MEMFS image
  ranDevice = device;
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
        // ?rt=off|banked|strict: real-time cap on the icount clock (the
        // vCPU sleeps instead of running its clocks ahead of wall time;
        // default banked — a slow boot is never slowed further; the
        // benchmarks pass rt=off to measure engine speed)
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
  startSerialPoll();
  startHud();
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
  setEmuState("idle");
  showOverlay("Ready to boot", `Exited (${code})`);
}

function stop() {
  // before the guest exists, the action is "cancel the fullflash download"
  if (downloadAbort) {
    downloadAbort.abort();
    return; // boot()'s catch reports it and re-arms Start
  }
  // a capture in flight is finished and saved first — the frames stop
  // arriving the moment the guest goes away
  finishRecording(() => {
    if (qemuModule && qemuModule._wasm_quit) qemuModule._wasm_quit();
    showOverlay("Stopping…");
  });
}

$("boot-form").addEventListener("submit", (e) => { e.preventDefault(); boot(); });

$("btn-save-flash").addEventListener("click", () => {
  downloadMemfs(FULLFLASH_PATH, "fullflash-modified.bin");
});

// EFA blocks are written lazily (only once the firmware actually programs
// the EFA), so there is nothing to hand out until it appears.
$("btn-save-efa").addEventListener("click", () => {
  if (!downloadMemfs(FULLFLASH_PATH + ".cfi-efa", "fullflash-modified.bin.cfi-efa")) {
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
/* serial log tools                                                     */
/* ------------------------------------------------------------------ */

// The <pre> only ever holds the last 16 KiB (see startSerialPoll); Download
// goes back to MEMFS for the whole thing.
function serialBytes() {
  try { return qemuModule?.FS?.readFile("/serial.log", { encoding: "binary" }) ?? null; }
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
    const m = qemuModule;
    if (!m || !m._wasm_fb_ptr) return;
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
  clearInterval(hudTimer);
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
    return;
  }
  const cell = screenCell.getBoundingClientRect();
  if (!cell.width || !cell.height) return;
  const ar = screenAspect();
  let w = cell.width, h = w / ar;
  if (h > cell.height) { h = cell.height; w = h * ar; } // height is tighter
  lcdWrap.style.width = Math.floor(w) + "px";
  lcdWrap.style.height = Math.floor(h) + "px";
}

let fitPending = 0;
function scheduleFit() {
  cancelAnimationFrame(fitPending);
  fitPending = requestAnimationFrame(() => { fitPhone(); fitScreen(); });
}
window.addEventListener("resize", scheduleFit);
// the URL bar sliding in and out changes dvh without a window resize event
window.visualViewport?.addEventListener("resize", scheduleFit);
for (const mq of [sideBySide, landscapeFit, phoneLayout]) mq.addEventListener("change", scheduleFit);
// whatever moves the row's height (keypad board, HUD band, sheets) ends up
// here, so the box never has to be re-fitted by hand
new ResizeObserver(() => fitScreen()).observe(screenCell);
document.fonts?.ready.then(scheduleFit);

/* ------------------------------------------------------------------ */
/* Stats HUD ("Performance HUD"): what "realtime" is on this device     */
/* ------------------------------------------------------------------ */

// Per-second guest rates, on the page itself so a phone can report them
// without a debugger: MIPS (guest insns/s; 125 = real time under the stock
// icount shift=3), v/wall (virtual seconds per wall second while the guest
// is busy — 1.0 = real time), lag (wall − virtual since start: what the
// real-time cap still owes), fps, halts/s and the page's own paint cost.
// Tap the HUD to copy the last 60 s of samples as JSON.
let hudTimer = 0;
let hudHeight = 0;
let paintMs = 0;
const HUD_HALT_INDEX = 29;   // WASM_DIAG_HALT in include/qemu/wasm-diag.h
function startHud() {
  clearInterval(hudTimer);
  if (!$("opt-hud").checked) return;
  const el = $("hud");
  el.hidden = false;
  // a rate needs two samples, so there is always a gap before the first
  // line — say which kind of wait it is
  el.textContent = running ? "Loading…" : "waiting for a run…";
  scheduleFit(); // the band takes height off the phone's budget
  const t0 = performance.now();
  const samples = [];
  let last = null;
  // virtual time already on the clock when the HUD was switched on: `lag` is
  // wall minus virtual *since then*, which is the only thing this window can
  // measure. Without it, enabling the HUD mid-run reports a negative lag,
  // because it would be subtracting the whole run's virtual time from a wall
  // clock that only just started.
  let v0 = null;
  el.onclick = () => navigator.clipboard?.writeText(JSON.stringify({ ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null,
    isolated: crossOriginIsolated, samples }));
  hudTimer = setInterval(() => {
    const m = qemuModule;
    if (!m?._wasm_insns) return;
    const s = { t: performance.now(), v: Number(m._wasm_vclock()), insns: Number(m._wasm_insns()),
      fb: Number(m._wasm_fb_updates()), halts: Number(m._wasm_memstat(HUD_HALT_INDEX)), paint: paintMs };
    v0 ??= s.v;
    if (last) {
      const dt = (s.t - last.t) / 1000;
      const r = { wall: +((s.t - t0) / 1000).toFixed(1), mips: +((s.insns - last.insns) / 1e6 / dt).toFixed(1),
        vratio: +((s.v - last.v) / 1e9 / dt).toFixed(3), fps: +((s.fb - last.fb) / dt).toFixed(1),
        halts: Math.round((s.halts - last.halts) / dt), paintMsPerS: +((s.paint - last.paint) / dt).toFixed(1),
        insns: s.insns, v: +(s.v / 1e9).toFixed(2) };
      samples.push(r);
      if (samples.length > 60) samples.shift();
      const win = samples.slice(-10);
      const avg = (k) => (win.reduce((a, x) => a + x[k], 0) / win.length).toFixed(k === "vratio" ? 2 : 1);
      const lag = ((s.t - t0) / 1000 - (s.v - v0) / 1e9).toFixed(1);
      el.textContent =
        `MIPS ${r.mips} (10s ${avg("mips")})  v/wall ${r.vratio.toFixed(2)} (10s ${avg("vratio")})  ` +
        `fps ${r.fps}  halts/s ${r.halts}  paint ${r.paintMsPerS} ms/s\n` +
        `insns ${(s.insns / 1e9).toFixed(2)} G  v ${(s.v / 1e9).toFixed(1)} s  wall ${r.wall} s  lag ${lag} s  ` +
        `cores ${navigator.hardwareConcurrency}  mem ${navigator.deviceMemory ?? "?"} GB  isolated ${crossOriginIsolated}\n` +
        navigator.userAgent;
      // the band grows from one line to three (and rewraps with the window),
      // which is height the phone can no longer have
      if (el.offsetHeight !== hudHeight) {
        hudHeight = el.offsetHeight;
        scheduleFit();
      }
    }
    last = s;
  }, 1000);
}

function stopHud() {
  clearInterval(hudTimer);
  hudTimer = 0;
  $("hud").hidden = true;
  scheduleFit();
}

// the toggle takes effect immediately, mid-run or before one
const hudChk = $("opt-hud");
hudChk.checked = localStorage.getItem("opt-hud") === "1";
hudChk.addEventListener("change", () => {
  localStorage.setItem("opt-hud", hudChk.checked ? "1" : "0");
  if (hudChk.checked) startHud();
  else stopHud();
});
if (hudChk.checked) startHud();

function startSerialPoll() {
  clearInterval(serialTimer);
  // a fresh run starts with an empty log: drop the previous one and fold the
  // box away again until this guest prints its first line
  $("serial").textContent = "";
  $("serial-box").hidden = true;
  serialTimer = setInterval(() => {
    const m = qemuModule;
    if (!m?.FS) return;
    try {
      if (!m.FS.analyzePath("/serial.log").exists) return;
      const data = m.FS.readFile("/serial.log", { encoding: "binary" });
      const el = $("serial");
      const tail = data.length > 16384 ? data.subarray(data.length - 16384) : data;
      const text = new TextDecoder("latin1").decode(tail);
      if (el.textContent !== text) {
        el.textContent = text;
        if (serTail.checked) el.scrollTop = el.scrollHeight;
      }
      if (text) $("serial-box").hidden = false;
    } catch { /* not there yet */ }
  }, 1000);
}

/* ------------------------------------------------------------------ */
/* keypad: one <button> per phone key                                   */
/* ------------------------------------------------------------------ */

function sendKey(phoneKey, down) {
  const m = qemuModule;
  if (!m || !m._wasm_send_key) return;
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
      if (ev.pointerType === "touch") navigator.vibrate?.(10);
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

/* ------------------------------------------------------------------ */
/* Advanced fieldset: say on the folded summary what was changed inside  */
/* ------------------------------------------------------------------ */

// Defaults come from the markup, so the two cannot drift.
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
