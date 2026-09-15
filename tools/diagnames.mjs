// Counter names, parsed from qemu/include/qemu/wasm-diag.h at run time.
//
// The numeric indices are the wasm_memstat() ABI, so a hand-maintained list in
// each tool drifts silently: a stale "specRet" left over from a rejected
// experiment shifted hflagsCalls and lookupConfl by one and both tools
// misreported them for a round.  A zero or a wrong number from a counter is
// indistinguishable from a real result -- so derive, never transcribe.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const hdr = readFileSync(
  fileURLToPath(new URL("../qemu/include/qemu/wasm-diag.h", import.meta.url)), "utf8");
const body = hdr.slice(hdr.indexOf("enum {"), hdr.indexOf("WASM_DIAG_N"));

// Enum members only: a leading-whitespace declaration, not a mention in a
// comment (several comments name other counters).
const camel = (s) => s.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
export const NAMES = [...body.matchAll(/^\s+WASM_DIAG_([A-Z0-9_]+)\s*(?:=|,)/gm)]
  .map((m) => camel(m[1]));

if (NAMES.length < 80) {
  throw new Error(`diagnames: parsed only ${NAMES.length} counters from wasm-diag.h`);
}
