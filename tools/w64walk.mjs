#!/usr/bin/env node
// Minimal structural walker for a wasm module: parse sections, then walk
// the single function body tracking the control-flow stack, and report
// where an imbalance or bad opcode appears.
import { readFileSync } from "node:fs";

const buf = readFileSync(process.argv[2]);
let p = 0;
function rd8() { return buf[p++]; }
function rduleb() { let v = 0, s = 0, b; do { b = buf[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v >>> 0; }
function rdsleb() { let v = 0, s = 0, b; do { b = buf[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); if (s < 64 && (b & 0x40)) v |= (-1 << s); return v; }
function hex(n) { return "0x" + n.toString(16); }

if (!(buf[0] === 0 && buf[1] === 0x61)) { console.log("not a module?"); process.exit(1); }
p = 8;

let bodyStart = 0, bodyEnd = 0;
while (p < buf.length) {
  const id = rd8();
  const size = rduleb();
  const start = p;
  if (id === 10) { bodyStart = p; bodyEnd = p + size; }
  if (id !== 0) console.log(`section id=${id} size=${size} at ${hex(start)}`);
  p = start + size;
}

if (!bodyStart) { console.log("no code section"); process.exit(1); }
p = bodyStart;
const count = rduleb();
const bsz = rduleb();
console.log(`code: count=${count} body-size=${bsz} body@${hex(p)} bodyEnd=${hex(bodyEnd)} fileLen=${buf.length}`);
const locals = rduleb();
for (let i = 0; i < locals; i++) { const n = rduleb(); const t = rd8(); console.log(`  locals ${n}x ${hex(t)}`); }

const stack = [];
for (;;) {
  if (p >= bodyEnd) {
    console.log(`reached bodyEnd ${hex(p)} with open stack:`);
    stack.forEach(s => console.log(`  ${s.kind} @${hex(s.at)}`));
    break;
  }
  const at = p;
  const op = rd8();
  switch (op) {
    case 0x02: case 0x03: case 0x04: {
      const bt = rd8();
      let kind = op === 0x02 ? "block" : op === 0x03 ? "loop" : "if";
      kind += bt === 0x40 ? "(void)" : `(type ${hex(bt)})`;
      stack.push({ kind, at });
      break;
    }
    case 0x05: break; /* else */
    case 0x00: case 0x01: case 0x0f: break; /* unreachable/nop/return */
    case 0x0b: {
      const top = stack.pop();
      if (!top) { console.log(`EXTRA end @${hex(at)}`); process.exit(0); }
      if (stack.length === 0) {
        console.log(`function end @${hex(at)}; trailing ${bodyEnd - p} bytes`);
        process.exit(0);
      }
      break;
    }
    case 0x0c: case 0x0d: rduleb(); break;
    case 0x0e: { const n = rduleb(); for (let i = 0; i < n; i++) rduleb(); break; }
    case 0x10: rduleb(); break;
    case 0x11: rduleb(); rduleb(); break;
    case 0x41: case 0x42: rdsleb(); break;
    case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0xd2: rduleb(); break;
    default:
      if (op >= 0x28 && op <= 0x3e) { rduleb(); rduleb(); break; }
      if (op >= 0x45 && op <= 0xc4) break; /* plain numeric ops */
      if (op >= 0xd0 && op <= 0xd1) { rduleb(); break; }
      if (op === 0xfc) { rduleb(); break; }
      console.log(`UNKNOWN op ${hex(op)} @${hex(at)}; open stack:`);
      stack.forEach(s => console.log(`  ${s.kind} @${hex(s.at)}`));
      process.exit(0);
  }
}
