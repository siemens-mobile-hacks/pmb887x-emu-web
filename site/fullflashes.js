// Inventory of predefined fullflashes + browser-side caching for them.
//
// The entries below live in a public flash repo (CORS-enabled, see
// FULLFLASH_REPO): picking one in the page downloads its files once and
// keeps them in the Cache API storage of this origin, so later boots (and
// later visits) read them from the local cache instead of re-downloading —
// an alternative to uploading a full flash of your own.
//
// This module is data + cache plumbing + the filename/device inference; the
// image-reading half of detection is the Siemens library for Siemens phones
// (site/siemensfw.js) and a JS scan for LG, below.

import { probeFullflash } from "./siemensfw.js";

/* ------------------------------------------------------------------ */
/* filename helpers (shared with app.js — kept next to the inventory)   */
/* ------------------------------------------------------------------ */

// Fullflash sidecars: qemu derives <fullflash>.cfi-{efa,otp0,otp1} paths
// from the pflash filename (in MEMFS: /data/fullflash.bin.cfi-*).
// The EFA block ("extra flash area") holds the LG EEPROM — without it an LG
// firmware boots, complains "EEP DOES NOT FIT TO SW-VERSION" and factory-
// resets. Siemens fullflashes only use the otp0/otp1 sidecars (optional).
export const SIDE_CAR_RE = /\.cfi-[a-z0-9]+$/i;

// filename substring -> device id (mirrors pmb887x-emu-mcp/src/instance.ts)
// LG phones: their EEPROM lives in the NOR flash EFA block, so their
// fullflashes need the .cfi-efa sidecar (see SIDE_CAR_RE above).
// Longer tokens come first wherever one contains another: EL71 before E71,
// CL61A before CL61, ME75 before M75 — the first hit wins. The M65/M75/ME75/
// SK65/SL65 rows arrived with the bsp round that added those boards
// (e79169f); C70 still has neither a board nor a sourced stand-in.
const DEVICE_RULES = [
  ["KE800", "lg-ke800"], ["KE970", "lg-ke970"],
  ["EL71", "siemens-el71"], ["E71", "siemens-e71"], ["C81", "siemens-c81"],
  ["S75", "siemens-s75"], ["S65", "siemens-s65"], ["SK65", "siemens-sk65"],
  ["CX75", "siemens-cx75"],
  ["CX70", "siemens-cx70"], ["CX65", "siemens-cx65"], ["SL75", "siemens-sl75"],
  ["SL65", "siemens-sl65"],
  ["CL61A", "siemens-cl61a"], ["CL61", "siemens-cl61"],
  ["SL98", "siemens-sl98"],
  ["C75", "siemens-c75"], ["C72", "siemens-c72"],
  ["C65", "siemens-c65"], ["S68", "siemens-s68"], ["M81", "siemens-m81"],
  ["M72", "siemens-m72"], ["ME75", "siemens-me75"], ["M75", "siemens-m75"],
  ["M65", "siemens-m65"],
  ["705P", "panasonic-705p"], ["VS7", "panasonic-vs7"],
];

// Rebadges and regional variants: the same hardware under another name, with
// no board of their own. Every row is sourced — an unsourced guess here would
// boot someone's phone as the wrong hardware, so a model we cannot place is
// left to the user instead. `exact` rows are asserted by upstream; the rest
// are stand-ins the UI says it is substituting, because even inside one
// platform family the board configs differ in their HW_DET_MOB_TYPE straps
// (S65 is 01100, C65 10010), which firmware can read.
// Deliberately absent: CL61A is *not* a CL61 (different flash part, 0x880D vs
// 0x8819); C70 has no source that puts it on the same silicon as a board we
// ship. (M75 and ME75 left this table for DEVICE_RULES when bsp e79169f gave
// them boards of their own.) See doc/architecture.md.
const MODEL_VARIANTS = [
  // upstream's own supported-hardware table (pmb887x-emu/README.md)
  ["C1F0", "siemens-el71", true],
  // ru.wikipedia.org/wiki/BenQ-Siemens_EL71 — the same phone renamed
  ["ELF1", "siemens-el71", false],
  ["ELC1", "siemens-el71", false],
  // ru.wikipedia.org/wiki/Siemens_S65: the S66 is the Americas-band S65,
  // "функционально ничем от своего европейского двойника не отличается".
  // The dump agrees: 32 MiB, BC65 bootcore, the R65 family that holds s65.
  ["S66", "siemens-s65", false],
  // en.wikipedia.org/wiki/Siemens_C65: "known in North America as the
  // Siemens C66"; CT65/CV65/CO65 are its carrier variants
  ["C66", "siemens-c65", false],
  ["CT65", "siemens-c65", false],
  ["CV65", "siemens-c65", false],
  ["CO65", "siemens-c65", false],
  // en.wikipedia.org/wiki/List_of_Siemens_phones lists CX66 as CX65 with
  // "minor changes for some countries" — the same Americas pattern
  ["CX66", "siemens-cx65", false],
];

export function inferDevice(filename) {
  const up = filename.toUpperCase();
  for (const [pat, dev] of DEVICE_RULES) if (up.includes(pat)) return dev;
  return null;
}

// A model string that is not a board of its own, mapped onto the board that
// emulates it. Returns { device, exact } or null.
export function variantFor(model) {
  const up = String(model).toUpperCase();
  for (const [pat, dev, exact] of MODEL_VARIANTS) {
    if (up === pat) return { device: dev, exact };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* detecting the device from the image, when the filename cannot         */
/* ------------------------------------------------------------------ */

// Siemens phones are the library's business: probeFullflash() in
// pmb887x-emu's siemensfw (site/siemensfw.js loads its browser build) reads
// the vendor/model records straight out of the image and derives the board
// name — the same code path the emulator itself takes when --device is not
// given, so what the page detects and what boots agree by construction.
// It also knows more than the JS ever did: both vendors (SIEMENS and
// BENQ-SIEMENS), records at four fixed offsets rather than one, and the
// exact NUL-padded field format.
//
// Everything else — LG firmware, which carries none of the Siemens
// structures and names itself in a J2ME user agent ~4.2 MiB in — stays a JS
// scan: the upstream code has nothing to say about it. There is no longer
// any reading of bootcore blocks here: when the library cannot place an
// image, the records it did not find are not going to appear by walking the
// boot area in JS.

// Every pmb887x NOR dump carries this, LG included (bsp boot/fakesign.py):
// the cheap gate that says "this is a phone dump at all" before the library
// is fetched for it.
const CJKT_OFF = 0x3c;
// The head probeFullflash() needs: its farthest record is the vendor at
// 0x8FC80, 16 bytes long.
const PROBE_HEAD = 0x90000;
// LG's model is in the J2ME user agent, ~4.2 MiB into a KE800 dump.
const LG_RE = /LG-(KE\d{3}) MIC\//;
const LG_SCAN_BYTES = 8 << 20;
const LG_CHUNK = 1 << 20;

async function readAt(file, start, end) {
  if (start >= file.size) return null;
  const buf = await file.slice(start, Math.min(end, file.size)).arrayBuffer();
  return new Uint8Array(buf);
}

// a NUL-padded ASCII field, or "" if it is not printable ASCII
function field(bytes, off, len = 16) {
  if (!bytes || off + len > bytes.length) return "";
  let s = "";
  for (let i = off; i < off + len; i++) {
    const c = bytes[i];
    if (c === 0) break;
    if (c < 0x20 || c > 0x7e) return "";
    s += String.fromCharCode(c);
  }
  return s;
}

const latin1 = new TextDecoder("latin1");

/**
 * Work out which phone a fullflash came from by reading it, for the files
 * whose name gives nothing away. Never reads the whole image: the Siemens
 * half is the library's own probe over the head, the LG half a scan for the
 * user agent. Returns { device, model, exact } — `device` is null when the
 * model is readable but has no board — or null when nothing could be read
 * at all.
 */
export async function detectDevice(file) {
  try {
    const head = await readAt(file, 0, PROBE_HEAD);
    // not a pmb887x dump at all — worth saying differently from "no idea"
    if (field(head, CJKT_OFF, 4) !== "CJKT") return null;

    // Siemens: the library is the source of truth (probeFullflash). Its
    // board name is used as-is when the model is a board of its own — which
    // is when the page's own rules, kept for the filename path below, agree
    // with it; a model that is not (S66, C66, ELF1…) goes through the
    // stand-in table, and the filename rules are the last resort, the way
    // they were the only resort before the library took over. A module that
    // fails to load is "not a Siemens image" here, not the end of
    // detection: the LG scan below needs no module.
    let probed = null;
    try {
      probed = await probeFullflash(head.subarray(0, Math.min(PROBE_HEAD, head.length)));
    } catch { /* the fallbacks below are still worth their chance */ }
    if (probed) {
      const { model, device } = probed;
      if (device && inferDevice(model) === device)
        return { device, model, exact: true };
      const v = variantFor(model);
      if (v) return { device: v.device, model, exact: v.exact };
      const byRules = inferDevice(model);
      if (byRules) return { device: byRules, model, exact: false };
      return { device: null, model, exact: false };
    }

    // Not a Siemens image the library recognizes — LG's J2ME user agent is
    // the one structure left worth a scan.
    const model = await scanLg(file);
    if (!model) return null;
    const device = inferDevice(model);
    if (device) return { device, model, exact: true };
    const v = variantFor(model);
    if (v) return { device: v.device, model, exact: v.exact };
    return { device: null, model, exact: false };
  } catch {
    return null; // an unreadable file is not a detection result
  }
}

async function scanLg(file) {
  const end = Math.min(file.size, LG_SCAN_BYTES);
  const overlap = 64; // so a match straddling a chunk edge is not lost
  for (let off = 0; off < end; off += LG_CHUNK - overlap) {
    const bytes = await readAt(file, off, Math.min(off + LG_CHUNK, end));
    if (!bytes || !bytes.length) break;
    const m = LG_RE.exec(latin1.decode(bytes));
    if (m) return m[1];
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* the inventory                                                        */
/* ------------------------------------------------------------------ */

// Raw-file endpoint of the fullflash repo (sends CORS headers and
// content-length, so browser fetches work with progress under COEP).
const FULLFLASH_REPO =
  "https://git.siepatch.dev/api/v1/repos/siepatch/fullflashes/raw/";

// One entry per bootable fullflash. files[0] is the main .bin; any further
// files are its .cfi-* sidecars (see SIDE_CAR_RE) and are downloaded and
// cached together with it. `size` is the sum of the files' bytes — the page
// says up front what a first Start will fetch, before anything is cached.
// `short` is the name for the phone-width status pill, where the label plus
// its cache state has to fit on one ellipsised line.
// Extend this list as the repo grows.
export const PRESET_FULLFLASHES = [
  { id: "s75v40lg1", label: "Siemens S75v40", short: "S75v40",
    files: ["S75v40lg1.bin"], size: 67108864 },
  { id: "el71v41lg91", label: "Siemens EL71v41", short: "EL71v41",
    files: ["EL71v41lg91.bin"], size: 67108864 },
{ id: "cx70v56lg3", label: "Siemens CX70v56", short: "CX70v56",
    files: ["CX70v56lg3.bin"], size: 33554432 },
  { id: "ke800v11b", label: "LG KE800v11b", short: "KE800v11b",
    files: ["KE800v11b.bin", "KE800v11b.bin.cfi-efa"], size: 134250496 },
];

function fileUrl(file) {
  return file.includes("://") ? file : FULLFLASH_REPO + file;
}

/* ------------------------------------------------------------------ */
/* Cache API plumbing                                                   */
/* ------------------------------------------------------------------ */

const CACHE_NAME = "fullflashes-v1";
// custom header we stamp on cached responses so the cached size is readable
// without pulling the whole body out of the cache
const SIZE_HEADER = "x-fullflash-size";

export function cacheAvailable() {
  return typeof caches !== "undefined";
}

// Which of the entry's files are already cached. Returned state:
//   { complete, count, totalSize } — totalSize sums the stored sizes (0 if
//   a file was cached by an older revision without the size header).
export async function entryCacheState(entry) {
  if (!cacheAvailable()) return { complete: false, count: 0, totalSize: 0 };
  const cache = await caches.open(CACHE_NAME);
  let count = 0, totalSize = 0, complete = true;
  for (const file of entry.files) {
    const res = await cache.match(fileUrl(file));
    if (!res) { complete = false; continue; }
    count++;
    totalSize += Number(res.headers.get(SIZE_HEADER)) || 0;
  }
  return { complete, count, totalSize };
}

// fetch -> Response, reporting (file, loadedBytes, totalBytes) while the
// body streams in. Returns a Response built from the collected chunks
// (cache.put stores constructed responses fine; it only rejects opaque ones).
// An aborted signal rejects the pending read with AbortError.
async function fetchWithProgress(file, onProgress, signal) {
  const url = fileUrl(file);
  const res = await fetch(url, { mode: "cors", signal });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) { // no streaming support: nothing to report, put as-is
    onProgress?.(file, total, total);
    return res;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(file, loaded, total);
  }
  return new Response(new Blob(chunks), {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
      [SIZE_HEADER]: String(loaded),
    },
  });
}

// Download every not-yet-cached file of the entry (already-cached files are
// skipped, so a retry after a partial failure only fetches what's missing —
// cache.put is atomic per file, a cached file is always complete). Aborting
// the optional signal throws AbortError; whatever finished stays cached, so
// pressing Start again resumes at the next file.
export async function downloadEntry(entry, onProgress, signal) {
  const cache = await caches.open(CACHE_NAME);
  for (const file of entry.files) {
    signal?.throwIfAborted();
    const url = fileUrl(file);
    if (await cache.match(url)) continue;
    await cache.put(url, await fetchWithProgress(file, onProgress, signal));
  }
}

export async function deleteEntry(entry) {
  const cache = await caches.open(CACHE_NAME);
  for (const file of entry.files) await cache.delete(fileUrl(file));
}

// Read the entry back from the cache, in entry.files order (main .bin
// first, sidecars after). Throws if any file is missing.
export async function readCachedEntry(entry) {
  const cache = await caches.open(CACHE_NAME);
  const out = [];
  for (const file of entry.files) {
    const res = await cache.match(fileUrl(file));
    if (!res) throw new Error(`${file} is not cached — download it again`);
    out.push({ name: file, bytes: new Uint8Array(await res.arrayBuffer()) });
  }
  return out;
}
