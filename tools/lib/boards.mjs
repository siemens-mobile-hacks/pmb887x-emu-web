// The test fullflashes under fullflashes/, one entry per image, keyed by the
// short ids the tools take on their command lines. efa: the LG EEPROM
// sidecar that goes in next to the image.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FULLFLASH_DIR = path.join(ROOT, "fullflashes");

export const FULLFLASHES = {
  s75: { file: "s75_working20060710172101.bin" },
  "s75-v40": { file: "S75v40lg1.bin" },
  el71: { file: "rr_ff_el71_stock.bin" },
  c81: { file: "rrC81 .bin" },
  ke800: { file: "KE800-v11b.bin", efa: "KE800-v11b.bin.cfi-efa" },
  ke970: { file: "KE970v10d.bin", efa: "KE970v10d.bin.cfi-efa" },
  cx70: { file: "CX70_FW56_clean.bin" },
  "s66-broken": { file: "BROKEN)S66_no_recalc.bin" },
};

function entry(id) {
  const e = FULLFLASHES[id];
  if (!e) throw new Error(`unknown fullflash id: ${id} (known: ${Object.keys(FULLFLASHES).join(", ")})`);
  return e;
}

// the image's absolute path
export const flashPath = (id) => path.join(FULLFLASH_DIR, entry(id).file);

// The board the page's own tables (site/fullflashes.js) give a fullflash's
// real name: DEVICE_RULES, as the page applies them to a picked file's name,
// else the stand-in for a model token in it (S66 -> siemens-s65). null when
// the name names no model.
export async function expectedBoard(name) {
  const { inferDevice, variantFor } = await import(path.join(ROOT, "site/fullflashes.js"));
  const base = path.basename(name);
  const byRule = inferDevice(base);
  if (byRule) return byRule;
  for (const token of base.toUpperCase().split(/[^A-Z0-9]+/)) {
    const v = token && variantFor(token);
    if (v) return v.device;
  }
  return null;
}

// the image and its sidecar, as the page's file picker takes them
export function flashFiles(id) {
  const e = entry(id);
  return [e.file, ...(e.efa ? [e.efa] : [])].map((f) => path.join(FULLFLASH_DIR, f));
}
