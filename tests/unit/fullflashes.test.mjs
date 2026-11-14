import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { inferDevice, variantFor, detectDevice } from "../../site/fullflashes.js";

const BOARD_DIR = new URL("../../bsp/lib/data/board/", import.meta.url);

test("inferDevice: substring rules, longer tokens first", () => {
  assert.equal(inferDevice("KE800-v11b.bin"), "lg-ke800");
  assert.equal(inferDevice("rr_ff_el71_stock.bin"), "siemens-el71");
  assert.equal(inferDevice("E71_v45.bin"), "siemens-e71");
  assert.equal(inferDevice("cl61a.bin"), "siemens-cl61a");
  assert.equal(inferDevice("CL61.bin"), "siemens-cl61");
  assert.equal(inferDevice("ME75.bin"), "siemens-me75");
  assert.equal(inferDevice("s75_working20060710172101.bin"), "siemens-s75");
  assert.equal(inferDevice("CX70_FW56_clean.bin"), "siemens-cx70");
  assert.equal(inferDevice("BROKEN)S66_no_recalc.bin"), null, "S66 runs as the S65, flagged");
  assert.equal(inferDevice("CF75v23.bin"), "siemens-cf75");
  assert.equal(inferDevice("unknown.bin"), null);
});

test("variantFor: exact model names only, rebadges flagged inexact", () => {
  assert.deepEqual(variantFor("C1F0"), { device: "siemens-el71", exact: true });
  assert.deepEqual(variantFor("c66"), { device: "siemens-c65", exact: false });
  assert.deepEqual(variantFor("s66"), { device: "siemens-s65", exact: false });
  assert.equal(variantFor("S665"), null);
  assert.equal(variantFor("CL61A"), null);
});

// Every bsp board with a model of its own has a filename rule, unless
// MODEL_VARIANTS runs that model on another board (S66 on the S65's, the
// owner's choice): a board the rules miss is found by the image only. The
// bare chip boards name no phone, and upstream's EL71 config calls itself
// E71 (BOARD_NAME_FIXUPS in app.js).
test("DEVICE_RULES: one rule per bsp phone board", { skip: !existsSync(BOARD_DIR) && "no bsp checkout" }, () => {
  const missed = [];
  for (const f of readdirSync(BOARD_DIR).filter((f) => f.endsWith(".toml"))) {
    const id = f.slice(0, -5);
    if (/^(apoxi|generic)-|^siemens-pmb887[56]$/.test(id) || id === "siemens-el71") continue;
    const model = readFileSync(new URL(f, BOARD_DIR), "utf8").match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    if (variantFor(model ?? "")) continue;
    if (inferDevice(model ?? "") !== id) missed.push(`${id} (model ${model})`);
  }
  assert.deepEqual(missed, []);
});

// a head the library's probe accepts: the CJKT mark and the vendor/model
// records at the four offsets siemensfw reads
function siemensHead(model) {
  const h = new Uint8Array(0x90000);
  const put = (s, off) => h.set(new TextEncoder().encode(s), off);
  put("CJKT", 0x3c);
  for (const v of [0x8fc80, 0x220, 0x880, 0xc80]) { put("SIEMENS", v); put(model, v - 16); }
  return new Blob([h]);
}

test("detectDevice: the stand-in table, else the library's board wherever it exists", async () => {
  const has = (...ids) => (dev) => ids.includes(dev);
  assert.deepEqual(await detectDevice(siemensHead("CF75"), has("siemens-cf75")),
    { device: "siemens-cf75", model: "CF75", exact: true });
  // S66 has a board, and still runs as the S65
  assert.deepEqual(await detectDevice(siemensHead("S66"), has("siemens-s66", "siemens-s65")),
    { device: "siemens-s65", model: "S66", exact: false });
  // a board no rule knows yet is still taken when it exists
  assert.deepEqual(await detectDevice(siemensHead("ZX99"), has("siemens-zx99")),
    { device: "siemens-zx99", model: "ZX99", exact: true });
  assert.deepEqual(await detectDevice(siemensHead("ZX99"), has()),
    { device: null, model: "ZX99", exact: false });
  // no board of its own: the stand-in, flagged
  assert.deepEqual(await detectDevice(siemensHead("C66"), has("siemens-c65")),
    { device: "siemens-c65", model: "C66", exact: false });
  assert.equal(await detectDevice(new Blob([new Uint8Array(0x1000)])), null);
});
