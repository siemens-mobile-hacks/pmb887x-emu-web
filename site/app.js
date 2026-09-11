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
  Numpad0: "0", Numpad1: "1", Numpad2: "2", Numpad3: "3", Numpad4: "4",
  Numpad5: "5", Numpad6: "6", Numpad7: "7", Numpad8: "8", Numpad9: "9",
  Backquote: "star", NumpadMultiply: "star", Slash: "hash", NumpadDivide: "hash",
  Escape: "end",
};

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
const statusEl = $("status");
let qemuModule = null;   // current emscripten module instance
let rafHandle = 0;
let serialTimer = 0;
let boards = [];         // [{id, file}] parsed from boards.tar
let boardsBuf = null;
let boardsReady = null;   // loadBoards() promise — boot() awaits it
let pendingDevice = null; // device inferred from a fullflash picked before
                          // boards.tar finished loading (slow links)

function setStatus(cls, text) {
  statusEl.className = "status " + cls;
  statusEl.textContent = text;
}

/* ------------------------------------------------------------------ */
/* device list                                                          */
/* ------------------------------------------------------------------ */

async function loadBoards() {
  boardsBuf = await (await fetch("dist/boards.tar")).arrayBuffer();
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
  // A fullflash picked before boards.tar arrived (slow link) could not set
  // the device — apply the deferred inference now that the options exist.
  if (pendingDevice && boards.some((b) => b.id === pendingDevice)) {
    sel.value = pendingDevice;
    pendingDevice = null;
  }
}

// Fullflash sidecars (SIDE_CAR_RE) are documented in fullflashes.js:
// qemu derives <fullflash>.cfi-{efa,otp0,otp1} paths from the pflash
// filename (in MEMFS: /data/fullflash.bin.cfi-*).
const FULLFLASH_PATH = "/data/fullflash.bin";

// The main fullflash plus its picked .cfi-* sidecars; the largest non-sidecar
// file wins so a directory pick cannot accidentally swap main and sidecar.
function pickFiles(fileList) {
  const files = [...fileList];
  const sidecars = files.filter((f) => SIDE_CAR_RE.test(f.name));
  const mains = files.filter((f) => !SIDE_CAR_RE.test(f.name));
  const main = mains.sort((a, z) => z.size - a.size)[0] || null;
  return { main, sidecars };
}

// device id -> on-screen keyboard layout (ids from DEVICE_RULES): every LG
// phone shares the KE800 board (side keys, no joystick block), every Siemens
// phone the S75 board. English legends are the auto-picked default; Russian
// stays one dropdown click away and is kept while the board does not change.
function inferKbdLayout(dev) {
  if (dev?.startsWith("lg-")) return "ke800_en";
  if (dev?.startsWith("siemens-")) return "en";
  return null;
}

// Device + on-screen keyboard inference from a fullflash filename — shared
// by the file picker and the preset picker below.
function applyFullflashName(name) {
  const dev = inferDevice(name);
  if (dev) {
    if (boards.some((b) => b.id === dev)) $("device").value = dev;
    else if (boardsReady) pendingDevice = dev; // boards.tar still loading
  }
  const kbd = inferKbdLayout(dev);
  if (kbd && kbd in KBD_LAYOUTS
      && KBD_LAYOUTS[kbdSel.value]?.board !== KBD_LAYOUTS[kbd].board) {
    kbdSel.value = kbd;
    applyKbdLayout(kbd, bindKeypad);
    localStorage.setItem("kbd-layout", kbd);
  }
}

/* ------------------------------------------------------------------ */
/* preset fullflashes (fullflashes.js inventory, cached in the browser) */
/* ------------------------------------------------------------------ */

const presetSel = $("ff-preset");
const presetStatus = $("ff-preset-status");
const presetTrash = $("ff-preset-delete");
const fileInput = $("fullflash");
let selectedPreset = null; // PRESET_FULLFLASHES entry, or null = own file
let presetBusy = false;    // preset download in flight (during boot)

function presetById(id) {
  return PRESET_FULLFLASHES.find((p) => p.id === id) ?? null;
}

function fmtMiB(bytes) {
  const m = bytes / (1024 * 1024);
  return (m >= 10 ? Math.round(m) : m.toFixed(1)) + " MiB";
}

// Reflect selectedPreset + cache state: the option texts ("— cached"
// markers), the trash button, the Browse input (disabled while a preset is
// chosen) and the status line under the dropdown.
async function refreshPresetUi() {
  for (const opt of presetSel.options) {
    const entry = presetById(opt.value);
    if (!entry) continue; // the "own file" placeholder
    const st = await entryCacheState(entry);
    opt.textContent = entry.label + (st.complete ? " — cached" : "");
  }
  if (!cacheAvailable()) {
    presetSel.disabled = presetTrash.disabled = true;
    presetStatus.textContent = "browser cache unavailable — use your own file below";
    return;
  }
  presetSel.disabled = false;
  fileInput.disabled = !!selectedPreset;
  const entry = selectedPreset;
  if (!entry) {
    presetTrash.disabled = true;
    presetStatus.textContent = "";
    return;
  }
  const st = await entryCacheState(entry);
  presetTrash.disabled = presetBusy || st.count === 0;
  presetStatus.textContent =
    st.complete ? `cached (${fmtMiB(st.totalSize)}) — boots from the local cache`
    : st.count ? `partially cached (${st.count}/${entry.files.length}) — finishes on Start`
    : "not downloaded yet — downloads when you press Start";
}

for (const entry of PRESET_FULLFLASHES) {
  const opt = document.createElement("option");
  opt.value = entry.id;
  opt.textContent = entry.label;
  presetSel.appendChild(opt);
}
refreshPresetUi();

presetSel.addEventListener("change", async () => {
  selectedPreset = presetById(presetSel.value);
  if (selectedPreset) {
    applyFullflashName(selectedPreset.files[0]);
  } else if (fileInput.files.length) {
    // back to "my own file": re-apply the inference of the picked files
    const { main } = pickFiles(fileInput.files);
    if (main) applyFullflashName(main.name);
  }
  await refreshPresetUi();
});

presetTrash.addEventListener("click", async () => {
  if (!selectedPreset || presetBusy) return;
  await deleteEntry(selectedPreset);
  await refreshPresetUi();
});

fileInput.addEventListener("change", (e) => {
  const { main } = pickFiles(e.target.files);
  if (main) applyFullflashName(main.name);
});

/* ------------------------------------------------------------------ */
/* boot / stop                                                          */
/* ------------------------------------------------------------------ */

/* ?suite=<url>: the phase-0a guest op-suite (doc/wasm-tcg-backend-plan.md) —
 * boot -M versatilepb with the raw image fetched from <url> (built by
 * tests/tcg-isa, installed to dist/tcgisa.bin) instead of a phone: the
 * suite prints TAP + value dumps on the PL011 and exits via semihosting
 * SYS_EXIT, so the run ends in the normal onExit hook. */
/* ?dist=<dir>: alternate build output (default "dist") — e.g. the
 * wasm64 TCG backend build served as dist-jit/. */
const DIST = new URLSearchParams(location.search).get("dist") || "dist";

async function bootSuite(url) {
  setStatus("booting", "loading suite…");
  $("btn-start").disabled = true;
  try {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const factory = (await import(`./${DIST}/qemu-system-arm.js`)).default;
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
        setStatus("idle", `exited (${code})`);
        stopPainting();
        $("btn-start").disabled = false;
        $("btn-stop").disabled = true;
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
    $("lcd-overlay").classList.add("hidden");
    window.__qemu = qemuModule; // debugging hook (same as the phone boot)
    startSerialPoll();
    setStatus("running", "running — tcg-isa op-suite");
  } catch (e) {
    console.error(e);
    setStatus("error", String(e));
    $("btn-start").disabled = false;
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

  if (!selectedPreset && !fileInput.files.length) {
    alert("pick a preset fullflash or your own .bin first");
    return;
  }
  if (selectedPreset && !cacheAvailable()) {
    alert("the browser cache is unavailable — presets cannot be stored; use your own file");
    return;
  }

  // boards.tar populates the device list and feeds preRun's untar — never
  // start a boot that could race it (device inference would be lost and
  // qemu would get an empty board dir).
  if (boardsReady) await boardsReady;
  if (!boardsBuf) {
    setStatus("error", "boards.tar failed to load — reload the page");
    return;
  }


  // Own-file boots are resolved up front; preset boots resolve inside the
  // try below, after a possible first-use download into the browser cache.
  let picked = null;
  if (!selectedPreset) {
    picked = pickFiles(fileInput.files);
    if (!picked.main) { alert("no fullflash .bin among the picked files"); return; }
  }
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

  // [[".cfi-efa", bytes], ...] — filled below, checked again after the boot
  let sidecarBytes = [];

  try {
    // Boot source: the preset read back from the browser cache, or the
    // picked local files. Both yield { name, arrayBuffer() } objects (the
    // preset one wraps the cached bytes).
    let file, sidecars;
    if (selectedPreset) {
      // First Start with this preset: download it into the browser cache
      // (live progress; later boots come straight from the cache).
      const st = await entryCacheState(selectedPreset);
      if (!st.complete) {
        presetBusy = true;
        try {
          await downloadEntry(selectedPreset, (name, loaded, total) => {
            const pct = total ? Math.round((loaded / total) * 100) : null;
            setStatus("booting", "downloading fullflash" + (pct != null ? ` — ${pct}%` : "…"));
            presetStatus.textContent = `downloading ${name}: ${fmtMiB(loaded)}`
              + (total ? ` of ${fmtMiB(total)}` : "") + (pct != null ? ` — ${pct}%` : "");
          });
        } finally {
          presetBusy = false;
        }
        await refreshPresetUi();
      }
      const cached = await readCachedEntry(selectedPreset); // main .bin first
      const shim = (f) => ({ name: f.name, arrayBuffer: async () => f.bytes.buffer });
      file = shim(cached[0]);
      sidecars = cached.slice(1).map(shim);
    } else {
      file = picked.main;
      sidecars = picked.sidecars;
    }

    // Compile the factory fresh per boot (the emscripten ES6 factory is
    // single-use once main() has run through exit()).
    const factory = (await import(`./${DIST}/qemu-system-arm.js`)).default;

    const flashBytes = new Uint8Array(await file.arrayBuffer());
    for (const sc of sidecars) {
      const suffix = sc.name.match(SIDE_CAR_RE)[0].toLowerCase();
      if (sidecarBytes.some(([s]) => s === suffix)) {
        alert(`duplicate ${suffix} sidecar picked — keeping the first`);
        continue;
      }
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
      "-drive", `if=pflash,format=raw,file=${FULLFLASH_PATH}${rw ? "" : ",readonly=on"}`,
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
        setStatus("idle", `exited (${code})`);
        stopPainting();
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
        $("btn-start").disabled = false;
        $("btn-stop").disabled = true;
        $("btn-save-flash").disabled = true;
        $("btn-save-efa").disabled = true;
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
    console.error(e);
    setStatus("error", String(e));
    $("btn-start").disabled = false;
    refreshPresetUi(); // a failed preset download changed the cache state
    return;
  }

  $("btn-stop").disabled = false;
  $("btn-save-flash").disabled = !rw;
  $("btn-save-efa").disabled = true;
  // LG firmware without the EFA block factory-resets its EEPROM; warn but boot.
  const noEfa = device.startsWith("lg-") && !sidecarBytes.some(([s]) => s === ".cfi-efa");
  $("lcd-overlay").classList.add("hidden");
  window.__qemu = qemuModule; // debugging hook
  startPainting();
  startSerialPoll();
  setStatus("running", `running — ${device}` + (noEfa ? " (no EFA block — firmware may factory-reset)" : ""));
}

function stop() {
  if (qemuModule && qemuModule._wasm_quit) qemuModule._wasm_quit();
  setStatus("idle", "stopping…");
}

$("boot-form").addEventListener("submit", (e) => { e.preventDefault(); boot(); });

// ?suite= runs headlessly (phase-0a runner): submit the boot form once
// the document is complete — same path as pressing Start
if (new URLSearchParams(location.search).get("suite")) {
  const go = () => document.getElementById("boot-form")?.requestSubmit();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", go);
  } else {
    go();
  }
}
$("btn-stop").addEventListener("click", stop);
$("btn-save-flash").addEventListener("click", () => {
  downloadMemfs(FULLFLASH_PATH, "fullflash-modified.bin");
});

// EFA blocks are written lazily (only once the firmware actually programs
// the EFA), so the button is enabled by the poller when the file appears.
$("btn-save-efa").addEventListener("click", () => {
  downloadMemfs(FULLFLASH_PATH + ".cfi-efa", "fullflash-modified.bin.cfi-efa");
});

function downloadMemfs(path, name) {
  const m = qemuModule;
  if (!m?.FS?.analyzePath(path)?.exists) return;
  const data = m.FS.readFile(path);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
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
    // firmware writes the EFA lazily — offer the download once it exists
    try {
      $("btn-save-efa").disabled = !m.FS.analyzePath(FULLFLASH_PATH + ".cfi-efa").exists;
    } catch { /* not there yet */ }
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
  setStatus("error", "page not cross-origin isolated — SharedArrayBuffer unavailable: " + why.join("; "));
  $("btn-start").disabled = true;
}

if (!crossOriginIsolated) diagnoseIsolation();
boardsReady = loadBoards().catch((e) => {
  setStatus("error", "boards.tar: " + e);
  return null; // resolved-with-null: boot() re-checks boardsBuf below
});
