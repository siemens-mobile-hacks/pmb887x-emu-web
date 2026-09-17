// Siemens fullflash key handling for the page: the three modes the
// "Siemens keys" radio offers, on top of the browser build of pmb887x-emu's
// siemensfw library (dist/siemens-recalc.{js,wasm}, loaded by
// site/siemensfw.js).
//
// Siemens firmware binds itself to the NOR flash ESN: the keys stored in the
// bootcore and EEPROM must match the ESN the phone is given, or it refuses to
// boot. Either side can be moved — rewrite the keys for the ESN we hand it
// (recalc), or find the ESN the keys already answer to (recover).

import { loadSiemensFW } from "./siemensfw.js";

const load = loadSiemensFW;

// PapuaUtils' service key. Only internal consistency matters to an emulated
// phone, so pmb887x-emu pins it and so do we — see its main.cpp.
const SKEY = 12345678;

// The library's batched MD5 works on MD5_BATCH_SIZE consecutive candidates
// per md5Batch() call, and sr_scan's start/stride are multiples of it (see
// site-src/recalc/recalc_wasm.cpp).
const BATCH = 8;

/* ---- the flat SrIdentity struct from site-src/recalc/recalc_wasm.cpp ---- */
const ID_SIZE = 4 * 4 + 16 + 16 + 16;

function unpackIdentity(M, ptr) {
  // HEAPU8 is re-read on every access: an allocation can have grown the heap
  // and replaced the view since the last one.
  const u32 = new Uint32Array(M.HEAPU8.buffer, ptr, 4);
  const raw = M.HEAPU8.subarray(ptr, ptr + ID_SIZE);
  return {
    ok: !!u32[0],
    skey: u32[1] >>> 0,
    useBootKey: !!u32[2],
    // 15 digits, NUL padded — and all NUL when nothing was read
    imei: new TextDecoder().decode(raw.subarray(16, 31)).replace(/\0+$/, ""),
    // .slice(): a copy, so it survives the next heap growth
    key: raw.slice(u32[2] ? 32 : 48, u32[2] ? 48 : 64),
  };
}

const toHex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const esnHex = (esn) => (esn >>> 0).toString(16).padStart(8, "0");

/* ------------------------------------------------------------------ */
/* the two flash operations                                             */
/* ------------------------------------------------------------------ */

// Stages the image in the module's own heap. Both operations work on it
// there, so a 64 MiB fullflash crosses the boundary once.
async function stage(flashBytes) {
  const M = await load();
  const ptr = M._sr_flash_alloc(flashBytes.length);
  M.HEAPU8.set(flashBytes, ptr);
  return M;
}

export async function readIdentity(flashBytes) {
  const M = await stage(flashBytes);
  const ptr = M._malloc(ID_SIZE);
  try {
    M._sr_read_identity(ptr);
    return unpackIdentity(M, ptr);
  } finally {
    M._free(ptr);
    M._sr_flash_free();
  }
}

// Rewrites the keys in place for imei/esn. Returns how many items changed
// (0 when the image already matched), or throws when the layout is not a
// Siemens fullflash. `flashBytes` is updated in place.
export async function recalc(flashBytes, imei, esn) {
  const M = await stage(flashBytes);
  const LOG_CAP = 4096;
  const imeiPtr = M._malloc(16);
  const logPtr = M._malloc(LOG_CAP);
  const completePtr = M._malloc(4);
  try {
    M.stringToUTF8(imei, imeiPtr, 16);
    const replaced = M._sr_recalc(imeiPtr, esn >>> 0, SKEY, completePtr, logPtr, LOG_CAP);
    const log = M.UTF8ToString(logPtr);
    if (replaced < 0) {
      const e = new Error("Not a recognizable Siemens fullflash layout");
      e.recalcLog = log;
      throw e;
    }
    const complete = new Int32Array(M.HEAPU8.buffer, completePtr, 1)[0] === 1;
    if (replaced > 0) flashBytes.set(M.HEAPU8.subarray(M._sr_flash_ptr(),
      M._sr_flash_ptr() + flashBytes.length));
    return { replaced, complete, log };
  } finally {
    M._free(imeiPtr);
    M._free(logPtr);
    M._free(completePtr);
    M._sr_flash_free();
  }
}

// One forward derivation: does this ESN produce the key the image stores?
export async function verify(identity, esn) {
  const M = await load();
  const ptr = M._malloc(16);
  try {
    M.HEAPU8.set(identity.key, ptr);
    return !!M._sr_verify(esn >>> 0, identity.skey, ptr, identity.useBootKey ? 1 : 0);
  } finally {
    M._free(ptr);
  }
}

/* ------------------------------------------------------------------ */
/* the ESN cache                                                        */
/* ------------------------------------------------------------------ */

// pmb887x-emu writes a <fullflash>.esn file next to the image, keyed on the
// IMEI and the stored key. The browser has no such file, so keep the keying
// and drop the file: an identity key follows the same image through a rename,
// through Preset and Own file alike, and misses by itself once the keys in
// the image change. Every hit is re-verified before it is used, so a stale or
// hand-edited entry cannot quietly boot the wrong ESN.
const CACHE_KEY = "siemens-esn-v1";
const CACHE_MAX = 20;

const identityKey = (id) => `${id.imei}:${toHex(id.key)}`;

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCache(map) {
  try {
    const keys = Object.keys(map);
    // insertion order is the eviction order: JSON.parse preserves it
    for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete map[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch { /* private window, or the quota is full — the sweep still works */ }
}

export const cachedEsnCount = () => Object.keys(readCache()).length;

export function clearEsnCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* nothing to clear */ }
}

function cacheGet(id) {
  const hit = readCache()[identityKey(id)];
  return typeof hit === "string" && /^[0-9a-f]{8}$/.test(hit) ? parseInt(hit, 16) : null;
}

function cachePut(id, esn) {
  const map = readCache();
  delete map[identityKey(id)];          // re-insert so it counts as newest
  map[identityKey(id)] = esnHex(esn);
  writeCache(map);
}

/* ------------------------------------------------------------------ */
/* the sweep                                                            */
/* ------------------------------------------------------------------ */

// 2^32 candidates at one batched MD5 compression per MD5_BATCH_SIZE of them
// (two batches when the image has no BootKey and the bootcore HASH is the
// target). One browser core manages ~25M/s, so the whole space is a couple
// of minutes of work — hence the workers, the progress and the cache. Slices
// are bounded per worker so a cancel lands between them.
const SLICE = 1 << 24;

export function workerCount() {
  return Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
}

/*
 * Recovers the ESN the image's keys were built from.
 *
 * Returns { esn, cached, seconds }, or null when the sweep was cancelled or
 * the space held no answer. onProgress(fraction) is called as slices land.
 */
export async function recoverEsn(identity, { signal, onProgress } = {}) {
  const hit = cacheGet(identity);
  if (hit != null && await verify(identity, hit)) {
    return { esn: hit, cached: true, seconds: 0 };
  }

  const n = workerCount();
  const started = Date.now();
  const workers = [];
  let done = 0;   // slices finished, for the progress fraction
  let onAbort = null;

  try {
    const esn = await new Promise((resolve, reject) => {
      if (signal?.aborted) return resolve(null);
      let live = n;

      const finish = (value) => { resolve(value); };
      onAbort = () => finish(null);
      signal?.addEventListener("abort", onAbort, { once: true });

      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL("./recalc-worker.js", import.meta.url), { type: "module" });
        workers.push(w);
        w.onerror = (e) => reject(new Error(`ESN worker failed: ${e.message || e.type}`));
        w.onmessage = ({ data }) => {
          if (data.type === "progress") {
            // every worker's slice covers SLICE candidates, so the slices
            // finished across all of them cover done * SLICE of the space
            done++;
            onProgress?.(Math.min(1, (done * SLICE) / 0x100000000));
          } else if (data.type === "found") {
            finish(data.esn >>> 0);
          } else if (data.type === "exhausted") {
            if (--live === 0) finish(null);
          }
        };
        // worker i of n takes the batches at i*BATCH, i*BATCH + n*BATCH, … —
        // together the workers partition the space exactly
        w.postMessage({
          skey: identity.skey,
          key: identity.key,
          useBootKey: identity.useBootKey,
          start: i * BATCH,
          stride: n * BATCH,
          slice: SLICE,
        });
      }
    });

    if (esn == null) return null;
    // sr_scan compares MD5 state words; run the plain derivation once over
    // the answer before anything boots with it — the same confirmation
    // the library's recoverEsn() does after its own parallel loop
    if (!await verify(identity, esn)) return null;
    cachePut(identity, esn);
    return { esn, cached: false, seconds: (Date.now() - started) / 1000 };
  } finally {
    for (const w of workers) w.terminate();
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
