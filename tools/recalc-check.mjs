// Self-test for site/dist/siemens-recalc.wasm — the module the page's
// "Siemens keys" radio drives (built by scripts/build-recalc-wasm.sh from
// pmb887x-emu's src/siemens_recalc.cpp).
//
//   node tools/recalc-check.mjs [fullflash.bin]
//
// Defaults to the flash tools/testflash.local.json points at. Exercises the
// whole surface against a real image, without a browser:
//   identity   the IMEI/SKEY/keys the image carries are readable
//   verify     the identity's own ESN passes, a neighbour does not
//   scan       a bounded sweep finds that ESN and reports the rate
//   recalc     rewriting for a different ESN changes the stored keys, and
//              rewriting back for the original restores them byte for byte
// Exit 0 iff every check passed.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fullflash } from "./testflash.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, "..");
const flashPath = process.argv[2] || fullflash;

let fails = 0, count = 0;
function ok(name, cond, extra = "") {
  count++;
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  — " + extra : ""}`);
}

const createSiemensRecalc =
  (await import(resolve(root, "site/dist/siemens-recalc.js"))).default;
const M = await createSiemensRecalc();

const bytes = new Uint8Array(await readFile(flashPath));
console.log(`fullflash: ${flashPath} (${(bytes.length / (1 << 20)).toFixed(0)} MiB)`);

/* ---- the flat SrIdentity struct, mirroring site-src/recalc/recalc_wasm.cpp ---- */
const ID_SIZE = 4 * 4 + 16 + 16 + 16;
function readIdentity(ptr) {
  const u32 = new Uint32Array(M.HEAPU8.buffer, ptr, 4);
  const raw = M.HEAPU8.subarray(ptr, ptr + ID_SIZE);
  const imei = new TextDecoder().decode(raw.subarray(16, 31));
  return {
    ok: !!u32[0], skey: u32[1] >>> 0, useBootKey: !!u32[2], imei,
    bootKey: raw.slice(32, 48), hash: raw.slice(48, 64),
  };
}
const hex = (a) => [...a].map((b) => b.toString(16).padStart(2, "0")).join("");

function stageFlash() {
  const ptr = M._sr_flash_alloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);   // re-read HEAPU8: the alloc may have grown memory
  return ptr;
}

/* ---- identity ---- */
stageFlash();
const idPtr = M._malloc(ID_SIZE);
M._sr_read_identity(idPtr);
const id = readIdentity(idPtr);
ok("identity readable", id.ok, `IMEI ${id.imei} SKEY ${id.skey}`);
ok("IMEI is 15 digits", /^\d{15}$/.test(id.imei), id.imei);
console.log(`     target: ${id.useBootKey ? "BootKey" : "bootcore HASH"} ` +
  `${hex(id.useBootKey ? id.bootKey : id.hash)}`);

if (!id.ok) {
  console.log("\nthis image carries no intact keys — nothing further to check");
  process.exit(1);
}

/* ---- verify: find the ESN the image was built for ---- */
const target = M._malloc(16);
M.HEAPU8.set(id.useBootKey ? id.bootKey : id.hash, target);
const useBK = id.useBootKey ? 1 : 0;

// The page's own default, and what a recalculated image carries.
const DEFAULT_ESN = 0x12345678;
const esnOut = M._malloc(4);
let trueEsn = null;
if (M._sr_verify(DEFAULT_ESN, id.skey, target, useBK)) {
  trueEsn = DEFAULT_ESN;
} else {
  // not a recalculated image: sweep for it (this is the slow path)
  const t0 = Date.now();
  if (M._sr_scan(id.skey, target, useBK, 0, 1, 0xffffffff, esnOut)) {
    trueEsn = new Uint32Array(M.HEAPU8.buffer, esnOut, 1)[0] >>> 0;
  }
  console.log(`     full sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
ok("an ESN matches the stored key", trueEsn != null,
  trueEsn == null ? "" : trueEsn.toString(16).padStart(8, "0"));
if (trueEsn == null) process.exit(1);

ok("verify accepts it", !!M._sr_verify(trueEsn, id.skey, target, useBK));
ok("verify rejects its neighbour",
  !M._sr_verify((trueEsn + 1) >>> 0, id.skey, target, useBK));

/* ---- scan: a bounded window around the answer, one worker's worth ---- */
{
  const WORKERS = 4, WINDOW = 1 << 22;
  const base = Math.max(0, trueEsn - WINDOW);
  let found = null;
  const t0 = Date.now();
  let scanned = 0;
  for (let w = 0; w < WORKERS; w++) {
    const n = Math.ceil((2 * WINDOW) / WORKERS);
    scanned += n;
    if (M._sr_scan(id.skey, target, useBK, base + w, WORKERS, n, esnOut)) {
      found = new Uint32Array(M.HEAPU8.buffer, esnOut, 1)[0] >>> 0;
      break;
    }
  }
  const secs = (Date.now() - t0) / 1000;
  ok("strided scan finds it", found === trueEsn,
    `${(scanned / secs / 1e6).toFixed(1)} M candidates/s per core ` +
    `→ ~${(0x100000000 / (scanned / secs) / 60).toFixed(1)} min for 2^32 on one core`);
}

/* ---- recalc ---- */
{
  const logCap = 4096;
  const logBuf = M._malloc(logCap);
  const completeOut = M._malloc(4);
  const rd = (p) => new Int32Array(M.HEAPU8.buffer, p, 1)[0];

  const imeiBuf = M._malloc(16);
  const writeImei = (s) => M.stringToUTF8(s, imeiBuf, 16);

  // (a) recalculating for the identity it already has must be a no-op
  stageFlash();
  writeImei(id.imei);
  let replaced = M._sr_recalc(imeiBuf, trueEsn, id.skey, completeOut, logBuf, logCap);
  ok("recalc for the image's own identity is a no-op", replaced === 0,
    `replaced=${replaced} complete=${rd(completeOut)}`);
  ok("recalc found every mandatory block", rd(completeOut) === 1);

  // (b) recalculating for a different ESN must rewrite the keys, and the
  //     image must then answer to that ESN instead
  const OTHER = 0xdeadbeef;
  replaced = M._sr_recalc(imeiBuf, OTHER, id.skey, completeOut, logBuf, logCap);
  ok("recalc for another ESN rewrites keys", replaced > 0, `replaced=${replaced}`);

  M._sr_read_identity(idPtr);
  const id2 = readIdentity(idPtr);
  M.HEAPU8.set(id2.useBootKey ? id2.bootKey : id2.hash, target);
  ok("the rewritten image answers to the new ESN",
    !!M._sr_verify(OTHER, id2.skey, target, id2.useBootKey ? 1 : 0));
  ok("and no longer to the old one",
    !M._sr_verify(trueEsn, id2.skey, target, id2.useBootKey ? 1 : 0));

  // (c) back to the original: byte-identical to the file we started from
  replaced = M._sr_recalc(imeiBuf, trueEsn, id.skey, completeOut, logBuf, logCap);
  const ptr = M._sr_flash_ptr();
  const round = M.HEAPU8.subarray(ptr, ptr + bytes.length);
  let diff = 0;
  for (let i = 0; i < bytes.length; i++) if (round[i] !== bytes[i]) diff++;
  ok("recalculating back restores the original bytes", diff === 0,
    diff ? `${diff} bytes differ` : `replaced=${replaced}`);
}

M._sr_flash_free();
console.log(`\n${count - fails}/${count} checks passed`);
process.exit(fails ? 1 : 0);
