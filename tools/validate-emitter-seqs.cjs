// Validate the fixed wasm64 emitter sequences for W-01 (deposit_i32),
// W-02 (sextract mid-field) and W-03 (bswap32_i64), mirroring the
// reproductions in doc/wasm-port-review.md §12.


function u8(...bs) { return bs; }
function uleb(v) { const o = []; do { let b = v & 0x7f; v >>>= 7; o.push(v ? b | 0x80 : b); } while (v); return o; }
function sleb64(v) { // BigInt sleb
  v = BigInt(v);
  const o = []; let more = true;
  while (more) {
    let b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) more = false; else b |= 0x80;
    o.push(b);
  }
  return o;
}
function sleb32(v) {
  const o = []; let more = true;
  while (more) {
    let b = v & 0x7f; v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) more = false; else b |= 0x80;
    o.push(b);
  }
  return o;
}

function module(body, params, results, locals) {
  // locals: array of counts by type (0x7f i32, 0x7e i64)
  const loc = [];
  let ngroups = 0;
  if (locals[0]) { loc.push(...uleb(locals[0]), 0x7f); ngroups++; }
  if (locals[1]) { loc.push(...uleb(locals[1]), 0x7e); ngroups++; }
  const code = [...uleb(ngroups), ...loc, ...body, 0x0b];
  const sec = (id, payload) => [id, ...uleb(payload.length), ...payload];
  const type = sec(1, [1, 0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results]);
  const func = sec(3, [1, 0]);
  const exp = sec(7, [1, 1, 0x66, 0x00, 0]);
  const cd = sec(10, [1, ...uleb(code.length), ...code]);
  const m = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...type, ...func, ...exp, ...cd]);
  return m;
}

let fails = 0;

// --- W-01: deposit_i32, t=I32, ofs=4 len=8 (mask 0xff0) ---
// new sequence: deposit_field -> local.set $scr32; get a1; const ~mask; and; local.get $scr32; or
{
  const body = [
    0x41, ...sleb32(0x1234),        // a2
    0x41, ...sleb32(4), 0x74,       // shl 4
    0x41, ...sleb32(0xff0), 0x71,   // and mask
    0x21, 0x00,                     // local.set $scr32
    0x41, ...sleb32(0xabcd),        // a1
    0x41, ...sleb32(-16 | 0), 0x71, // a1 & ~mask
    0x20, 0x00,                     // local.get $scr32  (was W64_L_SCR0 i64 before the fix)
    0x72,                           // i32.or
  ];
  const m = module(body, [], [0x7f], [1, 0]);
  if (!WebAssembly.validate(m)) { console.log('W-01 deposit_i32: INVALID'); fails++; }
  else {
    const r = new WebAssembly.Instance(new WebAssembly.Module(m)).exports.f();
    const want = (0x1234 << 4 & 0xff0) | (0xabcd & 0xfffffff0);
    // recompute with a1 folded in:
    console.log('W-01 deposit_i32: valid');
  }
}

// --- W-02: sextract_i32, ofs=4 len=8: shl 20; shr_s 24 ---
{
  const body = [
    0x41, ...sleb32(0x12345678),    // a1
    0x41, ...sleb32(20), 0x74,      // shl (32-4-8)
    0x41, ...sleb32(24), 0x75,      // shr_s (32-8)
  ];
  const m = module(body, [], [0x7f], [0, 0]);
  if (!WebAssembly.validate(m)) { console.log('W-02 sextract: INVALID'); fails++; }
  else {
    const r = new WebAssembly.Instance(new WebAssembly.Module(m)).exports.f() | 0;
    const want = ((0x12345678 << 20) >> 24) | 0;  // JS semantics: sign-extends
    if (r !== want) { console.log(`W-02 sextract: WRONG ${r.toString(16)} != ${want.toString(16)}`); fails++; }
    else console.log('W-02 sextract: valid, value ok');
  }
}

// --- W-03: bswap32_i64 ---
{
  const body = [
    0x42, ...sleb64('0x1122334455667788'),  // a1
    0x42, ...sleb64('0xffffffff'), 0x83,    // and
    0x21, 0x00,                             // local.set $scr0 (i64)
    // 16-bit half swap of the low 32 bits
    0x20, 0x00, 0x42, ...sleb64(16), 0x86,  // shl
    0x20, 0x00, 0x42, ...sleb64(16), 0x88,  // shr_u
    0x84,                                   // or
    0x42, ...sleb64('0xffffffff'), 0x83,    // and
    0x21, 0x00,
    // two-mask adjacent-byte swap
    0x20, 0x00,
    0x42, ...sleb64('0xff00ff00'), 0x83,    // and
    0x42, ...sleb64(8), 0x88,               // shr_u
    0x20, 0x00,
    0x42, ...sleb64('0xff00ff'), 0x83,      // and
    0x42, ...sleb64(8), 0x86,               // shl
    0x84,                                   // or
  ];
  const m = module(body, [], [0x7e], [0, 1]);
  if (!WebAssembly.validate(m)) { console.log('W-03 bswap32_i64: INVALID'); fails++; }
  else {
    const r = new WebAssembly.Instance(new WebAssembly.Module(m)).exports.f();
    if (r !== 0x88776655n) { console.log(`W-03 bswap32_i64: WRONG ${r.toString(16)} != 88776655`); fails++; }
    else console.log('W-03 bswap32_i64: valid, value ok');
  }
}

// --- old (buggy) W-01 sequence must be invalid: read-back from the i64 scratch ---
{
  const body = [
    0x41, ...sleb32(0x1234),
    0x41, ...sleb32(4), 0x74,
    0x41, ...sleb32(0xff0), 0x71,
    0x21, 0x00,                     // local.set $scr32 (local 0 is i32)
    0x41, ...sleb32(-16 | 0), 0x71,
    0x20, 0x01,                     // local.get 1 = the i64 scratch (old bug)
    0x72,
  ];
  const m = module(body, [], [0x7f], [1, 1]);
  console.log('old W-01 sequence still detected invalid:',
              WebAssembly.validate(m) ? 'NO (unexpected!)' : 'yes');
}

process.exit(fails ? 1 : 0);
