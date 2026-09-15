// Audit configs/meson/asyncify-only.txt against observed coroutine-switch
// stacks.
//
// Asyncify instrumentation is not free — round fourteen measured ~9 % of
// the vCPU for seven hot functions — so the onlylist wants to be the
// smallest set that still covers every frame that can be on the stack at
// a qemu_coroutine_switch().  QEMU_COSTACK=1 logs those stacks; this
// resolves their wasm function indices through the .symbols sidecar and
// reports both directions:
//
//   MISSING   observed but not covered — a real bug, the switch will
//             derail (or, on the vCPU thread, hit the abort in
//             util/coroutine-wasm.c)
//   UNUSED    listed but never observed — a trim candidate, but only
//             with an argument for why it *cannot* appear, not just
//             "it did not this run"
//
// Capture a log first, e.g.
//   EXTRA_Q="env=QEMU_COSTACK=1" DIST=dist-jit MATCH=COSTACK \
//     node tools/conlog.mjs 120 > costack.txt
// then
//   node tools/asyncify-audit.mjs costack.txt <dist>
//
// @dist is mandatory and must be the build the log was captured from -
// the log holds wasm function *indices*, and any relink renumbers them.
// Resolving against a later build silently maps every frame to the wrong
// name and invents MISSING entries.  Snapshot the dist before capturing.
import { readFileSync } from "fs";

const log = process.argv[2];
const dist = process.argv[3];
if (!log || !dist) {
  console.error("usage: asyncify-audit.mjs <costack.txt> <dist>");
  console.error("  <dist> must be the snapshot the log was captured from");
  process.exit(2);
}

const sym = new Map();
for (const line of readFileSync(`/workspace/site/${dist}/qemu-system-arm.js.symbols`, "utf8").split("\n")) {
  const i = line.indexOf(":");
  if (i > 0) sym.set(Number(line.slice(0, i)), line.slice(i + 1).trim());
}

const pats = readFileSync("/workspace/qemu/configs/meson/asyncify-only.txt", "utf8")
  .split("\n").map(s => s.trim()).filter(Boolean);
const rx = pats.map(p => ({
  pat: p,
  re: new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&")
                        .replace(/\*/g, ".*").replace(/\?/g, ".") + "$"),
  hit: false,
}));

const seen = new Set();
for (const line of readFileSync(log, "utf8").split("\n")) {
  for (const m of line.matchAll(/wasm-function\[(\d+)\]/g)) {
    const n = sym.get(Number(m[1]));
    if (n) seen.add(n);
  }
}

const missing = [];
for (const n of [...seen].sort()) {
  const hits = rx.filter(r => r.re.test(n));
  if (!hits.length) missing.push(n);
  for (const h of hits) h.hit = true;
}

console.log(`observed frames: ${seen.size}   onlylist entries: ${pats.length}`);
console.log(`MISSING (observed, not covered): ${missing.length}`);
for (const n of missing) console.log("   " + n);
const unused = rx.filter(r => !r.hit).map(r => r.pat);
console.log(`UNUSED (listed, not observed this run): ${unused.length}`);
for (const p of unused) console.log("   " + p);
