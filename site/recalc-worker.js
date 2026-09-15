// One core's share of the ESN sweep (site/recalc.js drives a pool of these).
//
// The worker owns its own instance of dist/siemens-recalc.wasm and walks
// candidates start, start+stride, start+2*stride, ... in slices, posting a
// progress message between them. Cancelling is the pool terminating the
// worker, which is why the slice is bounded: the loop has to come back to the
// event loop often enough for that to land promptly.

import createSiemensRecalc from "./dist/siemens-recalc.js";

// onmessage is installed before the module is awaited, and the job is held
// until it is ready: a dedicated worker's port is enabled once the script has
// *started*, so a message that arrives while a top-level await is still
// pending is delivered to no handler and lost.
let mod = null;
let pending = null;

self.onmessage = ({ data }) => {
  if (mod) sweep(data);
  else pending = data;
};

function sweep({ skey, key, useBootKey, start, stride, slice }) {
  const keyPtr = mod._malloc(16);
  const esnPtr = mod._malloc(4);
  mod.HEAPU8.set(key, keyPtr);
  const useBK = useBootKey ? 1 : 0;

  let base = start >>> 0;
  const step = stride * slice;

  const run = () => {
    if (mod._sr_scan(skey, keyPtr, useBK, base, stride, slice, esnPtr)) {
      const esn = new Uint32Array(mod.HEAPU8.buffer, esnPtr, 1)[0] >>> 0;
      self.postMessage({ type: "found", esn });
      return;
    }
    base += step;
    self.postMessage({ type: "progress" });
    if (base >= 0x100000000) {
      self.postMessage({ type: "exhausted" });
      return;
    }
    // back through the event loop, so a terminate() can take effect
    setTimeout(run, 0);
  };
  run();
}

mod = await createSiemensRecalc();
if (pending) {
  const job = pending;
  pending = null;
  sweep(job);
}
