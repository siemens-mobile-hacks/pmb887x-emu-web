// Inventory of predefined fullflashes + browser-side caching for them.
//
// The entries below live in a public flash repo (CORS-enabled, see
// FULLFLASH_REPO): picking one in the page downloads its files once and
// keeps them in the Cache API storage of this origin, so later boots (and
// later visits) read them from the local cache instead of re-downloading —
// an alternative to uploading a full flash of your own.
//
// This module is data + cache plumbing only; the UI wiring lives in app.js.

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
const DEVICE_RULES = [
  ["KE800", "lg-ke800"], ["KE970", "lg-ke970"],
  ["EL71", "siemens-el71"], ["E71", "siemens-e71"], ["C81", "siemens-c81"],
  ["S75", "siemens-s75"], ["S65", "siemens-s65"], ["CX75", "siemens-cx75"],
  ["CX70", "siemens-cx70"], ["CX65", "siemens-cx65"], ["SL75", "siemens-sl75"],
  ["CL61", "siemens-cl61"], ["C75", "siemens-c75"], ["C72", "siemens-c72"],
  ["C65", "siemens-c65"], ["S68", "siemens-s68"], ["M81", "siemens-m81"],
  ["M72", "siemens-m72"],
];

export function inferDevice(filename) {
  const up = filename.toUpperCase();
  for (const [pat, dev] of DEVICE_RULES) if (up.includes(pat)) return dev;
  return null;
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
// cached together with it. Extend this list as the repo grows.
export const PRESET_FULLFLASHES = [
  { id: "s75v40lg1", label: "Siemens S75 — v40 lg1",
    files: ["S75v40lg1.bin"] },
  { id: "el71v41lg91", label: "Siemens EL71 — v41 lg91",
    files: ["EL71v41lg91.bin"] },
  { id: "ke800v11b", label: "LG KE800 — v11b + EFA block",
    files: ["KE800v11b.bin", "KE800v11b.bin.cfi-efa"] },
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
async function fetchWithProgress(file, onProgress) {
  const url = fileUrl(file);
  const res = await fetch(url, { mode: "cors" });
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
// cache.put is atomic per file, a cached file is always complete).
export async function downloadEntry(entry, onProgress) {
  const cache = await caches.open(CACHE_NAME);
  for (const file of entry.files) {
    const url = fileUrl(file);
    if (await cache.match(url)) continue;
    await cache.put(url, await fetchWithProgress(file, onProgress));
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
