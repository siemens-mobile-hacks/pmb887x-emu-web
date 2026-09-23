// Add a metadata.code.branch_hint section to a captured batch module:
// every `if` right after an `i64.eq` (the inline TLB probe's hit test) is
// hinted likely-true, so its else arm (the *_mmu helper call) is cold.
//   node bhint.mjs in.wasm out.wasm
import fs from "node:fs";

const b = fs.readFileSync(process.argv[2]);
let p = 8;
const uleb = () => { let r = 0n, s = 0n, x; do { x = b[p++]; r |= BigInt(x & 0x7f) << s; s += 7n; } while (x & 0x80); return Number(r); };
const sleb = () => { let x; do { x = b[p++]; } while (x & 0x80); };

const sections = [];
while (p < b.length) {
  const hdr = p; const id = b[p++]; const len = uleb(); sections.push({ id, hdr, start: p, end: p + len }); p += len;
}
const imp = sections.find((s) => s.id === 2);
let nimpfn = 0;
if (imp) {
  p = imp.start; const n = uleb();
  for (let i = 0; i < n; i++) {
    const ml = uleb(); p += ml; const nl = uleb(); p += nl; const k = b[p++];
    if (k === 0) { uleb(); nimpfn++; }
    else if (k === 1) { p++; const f = b[p++]; uleb(); if (f & 1) uleb(); }
    else if (k === 2) { const f = b[p++]; uleb(); if (f & 1) uleb(); }
    else if (k === 3) { p += 2; }
  }
}
const code = sections.find((s) => s.id === 10);
p = code.start;
const nfn = uleb();
const hints = [];
let nh = 0;
const memarg = () => { const a = uleb(); if (a & 0x40) uleb(); uleb(); };
for (let f = 0; f < nfn; f++) {
  const sz = uleb(); const bodyStart = p; const end = p + sz;
  const nloc = uleb(); for (let i = 0; i < nloc; i++) { uleb(); p++; }
  const fh = [];
  let prev = -1;
  while (p < end) {
    const at = p - bodyStart; const op = b[p++];
    if (op === 0x04 && prev === 0x51) fh.push(at);
    if (op === 0x02 || op === 0x03 || op === 0x04) { if (b[p] === 0x40 || b[p] >= 0x6f) p++; else sleb(); }
    else if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12 || (op >= 0x20 && op <= 0x24) || op === 0xd2) uleb();
    else if (op === 0x0e) { const n = uleb(); for (let i = 0; i <= n; i++) uleb(); }
    else if (op === 0x11 || op === 0x13) { uleb(); uleb(); }
    else if (op >= 0x28 && op <= 0x3e) memarg();
    else if (op === 0x3f || op === 0x40) p++;
    else if (op === 0x41 || op === 0x42) sleb();
    else if (op === 0x43) p += 4;
    else if (op === 0x44) p += 8;
    else if (op === 0x1c) { const n = uleb(); p += n; }
    else if (op === 0xd0) p++;
    else if (op === 0xfc) { const s = uleb(); if (s === 8) { uleb(); p++; } else if (s === 9 || s === 13 || (s >= 15 && s <= 17)) uleb(); else if (s === 10) p += 2; else if (s === 11) p++; else if (s === 12 || s === 14) { uleb(); uleb(); } }
    else if (op === 0xfe) { const s = uleb(); if (s === 3) p++; else memarg(); }
    else if (op === 0xfd) { const s = uleb(); if (s <= 11 || s === 92 || s === 93) memarg(); else if (s === 12 || s === 13) p += 16; else if (s >= 21 && s <= 34) p++; else if (s >= 84 && s <= 91) { memarg(); p++; } }
    prev = op;
  }
  if (p !== end) throw new Error(`fn ${f}: decoder desync at ${p} vs ${end}`);
  if (fh.length) hints.push([nimpfn + f, fh]);
  nh += fh.length;
}
const enc = (n) => { const o = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; o.push(x); } while (n); return o; };
const name = Buffer.from("metadata.code.branch_hint");
const body = [...enc(name.length), ...name, ...enc(hints.length)];
for (const [fi, fh] of hints) {
  body.push(...enc(fi), ...enc(fh.length));
  for (const off of fh) body.push(...enc(off), 1, 1);
}
const sec = Buffer.from([0, ...enc(body.length), ...body]);
const cut = sections.find((s) => s.id === 10);
const secStart = cut.hdr;
const out = Buffer.concat([b.subarray(0, secStart), sec, b.subarray(secStart)]);
fs.writeFileSync(process.argv[3], out);
console.error(`functions ${nfn}, hinted ifs ${nh}`);
