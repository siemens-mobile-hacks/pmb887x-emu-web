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

import { KBD_LAYOUTS, applyKbdLayout } from "./keyboards.js";

/* ------------------------------------------------------------------ */
/* phone key tables (mirrors pmb887x-emu-mcp/src/keys.ts + otp.ts)      */
/* ------------------------------------------------------------------ */

// phone key -> linux keycode (qemu converts lnx->qcode internally)
const KEY_TO_LINUX = {
  up: 103, down: 108, left: 105, right: 106, center: 28, // KEY_UP.. KEY_ENTER
  left_soft: 59, right_soft: 60, // KEY_F1, KEY_F2
  send: 61, end: 62,             // KEY_F3, KEY_F4
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
  NumpadAdd: "vol_up", NumpadSubtract: "vol_down", Equal: "vol_up", Minus: "vol_down",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
  Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  Numpad0: "0", Numpad1: "1", Numpad2: "2", Numpad3: "3", Numpad4: "4",
  Numpad5: "5", Numpad6: "6", Numpad7: "7", Numpad8: "8", Numpad9: "9",
  Backquote: "star", NumpadMultiply: "star", Slash: "hash", NumpadDivide: "hash",
  Escape: "end",
};

// filename substring -> device id (mirrors pmb887x-emu-mcp/src/instance.ts)
const DEVICE_RULES = [
  ["EL71", "siemens-el71"], ["E71", "siemens-e71"], ["C81", "siemens-c81"],
  ["S75", "siemens-s75"], ["S65", "siemens-s65"], ["CX75", "siemens-cx75"],
  ["CX70", "siemens-cx70"], ["CX65", "siemens-cx65"], ["SL75", "siemens-sl75"],
  ["CL61", "siemens-cl61"], ["C75", "siemens-c75"], ["C72", "siemens-c72"],
  ["C65", "siemens-c65"], ["S68", "siemens-s68"], ["M81", "siemens-m81"],
  ["M72", "siemens-m72"],
];

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
const statusEl = $("status");
let qemuModule = null;   // current emscripten module instance
let rafHandle = 0;
let serialTimer = 0;
let boards = [];         // [{id, file}] parsed from boards.tar
let boardsBuf = null;

function setStatus(cls, text) {
  statusEl.className = "status " + cls;
  statusEl.textContent = text;
}

/* ------------------------------------------------------------------ */
/* device list                                                          */
/* ------------------------------------------------------------------ */

async function loadBoards() {
  boardsBuf = await (await fetch("boards.tar")).arrayBuffer();
  const files = [];
  untar(boardsBuf, (name, data) => files.push({ name, data }));
  boards = files
    .filter((f) => /^[^/]+\.toml$/.test(f.name))
    .map((f) => ({ id: f.name.replace(/\.toml$/, ""), file: f }));
  const sel = $("device");
  sel.innerHTML = "";
  for (const b of boards
    .slice()
    .sort((a, z) => a.id.localeCompare(z.id))) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.id;
    sel.appendChild(opt);
  }
}

function inferDevice(filename) {
  const up = filename.toUpperCase();
  for (const [pat, dev] of DEVICE_RULES) if (up.includes(pat)) return dev;
  return null;
}

$("fullflash").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const dev = inferDevice(f.name);
  if (dev && boards.some((b) => b.id === dev)) {
    $("device").value = dev;
  }
});

/* ------------------------------------------------------------------ */
/* boot / stop                                                          */
/* ------------------------------------------------------------------ */

async function boot() {
  const fileInput = $("fullflash");
  if (!fileInput.files.length) { alert("pick a fullflash .bin first"); return; }

  const file = fileInput.files[0];
  const device = $("device").value;
  const imei = $("imei").value.trim();
  const esn = $("esn").value.trim();
  const sim = $("sim").value;
  const operator = $("operator").value.trim();
  const startup = $("startup").value;
  const rw = $("rw").checked;

  if (!/^\d{15}$/.test(imei)) { alert("IMEI must be 15 digits"); return; }
  if (!/^[0-9A-Fa-f]{8}$/.test(esn)) { alert("ESN must be 8 hex chars"); return; }

  const otp0 = esnToOtp0(esn);
  const otp1 = imeiToOtp1(imei);

  const qsp = new URLSearchParams(location.search);
  const debug = qsp.get("debug") === "1";

  setStatus("booting", "loading…");
  $("btn-start").disabled = true;

  try {
    // Compile the factory fresh per boot (the emscripten ES6 factory is
    // single-use once main() has run through exit()).
    const factory = (await import("./qemu-system-arm.js")).default;

    const flashBytes = new Uint8Array(await file.arrayBuffer());

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

    const icount = qsp.get("icount") ?? "precise-clocks=on";
    const trace = qsp.get("trace");
    const extraArgs = (qsp.get("qargs") ?? "").split(/\s+/).filter(Boolean);
    const args = [
      "-display", "wasm",
      ...(icount === "none" ? [] : ["-icount", icount]),
      "-machine", "pmb887x",
      "-drive", `if=pflash,format=raw,file=/data/fullflash.bin${rw ? "" : ",readonly=on"}`,
      "-serial", "file:/serial.log",
      "-monitor", "none",
      ...extraArgs,
    ];

    qemuModule = await factory({
      arguments: args,
      printErr,
      log: debug ? (t) => console.log("[log]", t) : undefined,
      onExit: (code) => {
        setStatus("idle", `exited (${code})`);
        stopPainting();
        $("btn-start").disabled = false;
        $("btn-stop").disabled = true;
        $("btn-save-flash").disabled = true;
      },
      preRun: (mod) => {
        mod.FS.mkdirTree("/boards");
        untar(boardsBuf, (name, data) => {
          const path = "/boards/" + name;
          mod.FS.mkdirTree(path.split("/").slice(0, -1).join("/"));
          mod.FS.writeFile(path, data);
        });
        mod.FS.mkdirTree("/data");
        mod.FS.writeFile("/data/fullflash.bin", flashBytes);
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
        // ?icount2freq=<hz>: fixed virtual-clock frequency override
        // (default: the real phone CPU clock, 104 MHz — see web/doc/).
        const icount2freq = qsp.get("icount2freq");
        if (icount2freq) mod.ENV.QEMU_ICOUNT2_FREQUENCY = icount2freq;
      },
    });
  } catch (e) {
    console.error(e);
    setStatus("error", String(e));
    $("btn-start").disabled = false;
    return;
  }

  $("btn-stop").disabled = false;
  $("btn-save-flash").disabled = !rw;
  $("lcd-overlay").classList.add("hidden");
  window.__qemu = qemuModule; // debugging hook
  startPainting();
  startSerialPoll();
  setStatus("running", `running — ${device}`);
}

function stop() {
  if (qemuModule && qemuModule._wasm_quit) qemuModule._wasm_quit();
  setStatus("idle", "stopping…");
}

$("boot-form").addEventListener("submit", (e) => { e.preventDefault(); boot(); });
$("btn-stop").addEventListener("click", stop);
$("btn-save-flash").addEventListener("click", () => {
  if (!qemuModule?.FS?.analyzePath("/data/fullflash.bin")?.exists) return;
  const data = qemuModule.FS.readFile("/data/fullflash.bin");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
  a.download = "fullflash-modified.bin";
  a.click();
  URL.revokeObjectURL(a.href);
});

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
    }
    const addr = m._wasm_fb_ptr();
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
  };
  rafHandle = requestAnimationFrame(step);
}

function stopPainting() {
  cancelAnimationFrame(rafHandle);
  clearInterval(serialTimer);
}

function startSerialPoll() {
  clearInterval(serialTimer);
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
        el.scrollTop = el.scrollHeight;
      }
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

// press-and-hold wiring for every on-screen key; re-run after each keyboard
// render since the buttons are rebuilt per layout
function bindKeypad() {
  for (const btn of document.querySelectorAll("#keypad button[data-key], #aux-keys button[data-key]")) {
    const key = btn.dataset.key;
    const press = (ev) => {
      ev.preventDefault();
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
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}

/* ------------------------------------------------------------------ */
/* on-screen keyboard layout picker (definitions live in keyboards.js)   */
/* ------------------------------------------------------------------ */

const kbdSel = $("kbd-layout");
for (const [id, layout] of Object.entries(KBD_LAYOUTS)) {
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = layout.name;
  kbdSel.appendChild(opt);
}
kbdSel.value = localStorage.getItem("kbd-layout");
if (!(kbdSel.value in KBD_LAYOUTS)) kbdSel.value = "en";
applyKbdLayout(kbdSel.value, bindKeypad);
kbdSel.addEventListener("change", () => {
  applyKbdLayout(kbdSel.value, bindKeypad);
  localStorage.setItem("kbd-layout", kbdSel.value);
});

// physical keyboard -> phone keys
const heldKeys = new Set();
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const key = CODE_TO_KEY[e.code];
  if (!key || heldKeys.has(e.code)) return;
  heldKeys.add(e.code);
  sendKey(key, true);
  e.preventDefault();
});
window.addEventListener("keyup", (e) => {
  if (!heldKeys.delete(e.code)) return;
  const key = CODE_TO_KEY[e.code];
  if (key) sendKey(key, false);
});

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
      why.push(`no COOP/COEP headers (got COOP=${h?.coop} COEP=${h?.coep}) — serve dist/ via ./serve.mjs`);
    else if (window.top !== window.self) why.push('embedded in a frame without allow="cross-origin-isolated"');
    else why.push("browser ignored COOP/COEP — in-app browser/WebView? open in Chrome/Firefox/Safari");
  }
  if (/\bwv\b/.test(navigator.userAgent)) why.push("Android WebView cannot isolate — open in Chrome");
  setStatus("error", "page not cross-origin isolated — SharedArrayBuffer unavailable: " + why.join("; "));
  $("btn-start").disabled = true;
}

if (!crossOriginIsolated) diagnoseIsolation();
loadBoards().catch((e) => setStatus("error", "boards.tar: " + e));
