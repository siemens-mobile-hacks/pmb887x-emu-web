// The browser build of pmb887x-emu's Siemens fullflash library —
// src/siemens ("siemensfw", namespace SiemensFW) + the page's glue
// (site-src/recalc/recalc_wasm.cpp), compiled by scripts/build-recalc-wasm.sh
// into dist/siemens-recalc.{js,wasm}.
//
// This module owns the wasm: everything the page does with Siemens
// fullflashes goes through it — the key recalculation and ESN recovery the
// "Siemens keys" radio drives (site/recalc.js), and the device detection
// that asks the library which phone an image came off (site/fullflashes.js,
// probeFullflash here).
//
// The module is fetched from dist/ whatever ?dist= selects, the same rule
// boards.tar follows. It is single-threaded (wasm32, no SharedArrayBuffer):
// the page spreads the ESN sweep over its own Web Workers with one module
// instance each.

const MODULE_URL = "./dist/siemens-recalc.js";

let modPromise = null;

export function loadSiemensFW() {
  if (!modPromise) {
    modPromise = import(MODULE_URL).then((m) => m.default());
  }
  return modPromise;
}

/* ---- the flat SrProbe struct from site-src/recalc/recalc_wasm.cpp ---- */
const PROBE_SIZE = 4 + 24 + 24 + 40;

const field = (bytes) =>
  new TextDecoder("latin1").decode(bytes).replace(/\0+$/, "");

/**
 * Ask the library which Siemens phone a fullflash came off
 * (SiemensFW::probeFullflash — upstream's own device detection, the same
 * thing pmb887x-emu runs when -d is not given): vendor and model from the
 * image's records, board name as "siemens-" + lowercase model.
 *
 * `headBytes` is the start of the image — the farthest record the library
 * looks at is the vendor at 0x8FC80 (+16), which PROBE_HEAD in
 * site/fullflashes.js covers.
 *
 * Returns { vendor, model, device }, or null when the image carries no
 * Siemens record (LG and the rest are not this function's business).
 */
export async function probeFullflash(headBytes) {
  const M = await loadSiemensFW();
  const headPtr = M._malloc(headBytes.length);
  const outPtr = M._malloc(PROBE_SIZE);
  try {
    M.HEAPU8.set(headBytes, headPtr);
    if (!M._sr_probe(headPtr, headBytes.length, outPtr)) return null;
    const raw = M.HEAPU8.subarray(outPtr, outPtr + PROBE_SIZE);
    return {
      vendor: field(raw.subarray(4, 28)),
      model: field(raw.subarray(28, 52)),
      device: field(raw.subarray(52, 92)),
    };
  } finally {
    M._free(headPtr);
    M._free(outPtr);
  }
}
