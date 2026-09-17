/*
 * Validate the byte layout that wasm64.c's W64_MERGE path emits, without
 * building QEMU: same section order, same type 0, same selector global,
 * the same nested-block + br_table cascade, the same entry stubs and the
 * same run thunk.  A mis-encoded LEB or a section out of order is a
 * WebAssembly.CompileError here in a second, instead of a dead vCPU
 * worker after a sixty-second rebuild and a battery slot.
 *
 *   node tests/wasm/mergeshape.mjs [nmember] [mode]
 *
 * mode 1 is the merged cascade; mode 2 is the control build, where the
 * members are emitted unchanged and the stubs simply hop to them.  Mode
 * 2 changes three index computations (function count, export, element),
 * so it is worth the second of CPU to check them here.
 *
 * The bodies stand in for real TBs: each returns a distinct constant, so
 * instantiating and calling through the chain table proves the cascade
 * selects the arm the stub asked for -- which is the one property the
 * whole mechanism rests on.
 */
const N = Number(process.argv[2] || 277);
const MODE = Number(process.argv[3] || 1);

const uleb = (v) => {
    const o = [];
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v);
    return o;
};
const sleb = (v) => {
    const o = [];
    for (;;) {
        const b = v & 0x7f;
        v >>= 7;
        if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) {
            o.push(b);
            return o;
        }
        o.push(b | 0x80);
    }
};
const sec = (id, body) => [id, ...uleb(body.length), ...body];

/* five-byte padded LEB, as mb_uleb_p5 writes it */
const uleb_p5 = (v) => {
    const o = [];
    for (let i = 0; i < 5; i++) {
        let b = v & 0x7f;
        v >>>= 7;
        if (i < 4) b |= 0x80;
        o.push(b);
    }
    return o;
};

/* A stand-in TB body as the emitter stages it: [p5 size][locals][expr][end].
 * The locals declaration is the real one -- four runs, 37 locals, nine
 * bytes -- because that count is what makes the merged function's local
 * indices line up with every body's. */
const LOCALS = [0x04, 17, 0x7f, 16, 0x7e, 1, 0x7f, 3, 0x7e];

function stagedBody(k) {
    const expr = [
        0x20, 0,                /* local.get 0  -- touch a parameter */
        0x1a,                   /* drop */
        0x23, 0x00,             /* global.get 0 -- legal inside a body too */
        0x1a,                   /* drop */
        0x02, 0x40,             /* block: a body's own nesting */
        0x0c, 0x00,             /* br 0 -- targets its own block, never the fn */
        0x0b,                   /* end block */
        0x41, ...sleb(1000 + k),
        0x0f,                   /* return, as tcg_out_exit_tb emits */
        0x41, ...sleb(0),       /* the emitter's trailing i32.const 0 */
    ];
    const inner = [...LOCALS, ...expr, 0x0b];
    return [...uleb_p5(inner.length), ...inner];
}

const bodies = [];
for (let k = 0; k < N; k++) bodies.push(stagedBody(k));

const LOC_LEN = LOCALS.length;
const SKIP = 5 + LOC_LEN;

/* spread is a call, so a 60 KB payload spread into push() overflows the
 * stack long before wasm objects to anything */
const pushAll = (dst, src) => { for (let i = 0; i < src.length; i++) dst.push(src[i]); };

const NFN = MODE === 1 ? N + 2 : 2 * N + 1;
const STUB_BASE = MODE === 1 ? 1 : N;       /* n_uimp is 0: only a table is imported */
const STUB_DST0 = 0;

/* ---- the merged function, exactly as the C builds it ---- */
let mergedLen = 0;
const code = [];
if (MODE === 1) {
    const mc = [...LOCALS];
    for (let k = 0; k < N; k++) mc.push(0x02, 0x40);
    mc.push(0x23, ...uleb(0));
    mc.push(0x0e, ...uleb(N));
    for (let k = 0; k < N; k++) pushAll(mc, uleb(k));
    pushAll(mc, uleb(N - 1));
    for (let k = 0; k < N; k++) {
        mc.push(0x0b);
        pushAll(mc, bodies[k].slice(SKIP, bodies[k].length - 1));
        mc.push(0x0f);
    }
    mc.push(0x41, ...sleb(0), 0x0b);
    mergedLen = mc.length;
    pushAll(code, uleb(mc.length));
    pushAll(code, mc);
} else {
    for (let k = 0; k < N; k++) pushAll(code, bodies[k]);
}
for (let k = 0; k < N; k++) {
    const st = [
        0x00,
        0x41, ...sleb(k),
        0x24, ...uleb(0),
        0x20, ...uleb(0), 0x20, ...uleb(1), 0x20, ...uleb(2),
        0x12, ...uleb(STUB_DST0 + (MODE === 1 ? 0 : k)),
        0x0b,
    ];
    pushAll(code, uleb(st.length));
    pushAll(code, st);
}
const thunk = [0, 0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3, 0x13, 0, 0, 0x0b];
pushAll(code, uleb(thunk.length));
pushAll(code, thunk);

/* ---- sections, in the order wasm64.c emits them ---- */
const TB_TYPE = [0x60, 3, 0x7e, 0x7e, 0x7e, 1, 0x7f];
const THUNK_TYPE = [0x60, 4, 0x7e, 0x7e, 0x7e, 0x7f, 1, 0x7f];

const mod = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
mod.push(...sec(1, [2, ...TB_TYPE, ...THUNK_TYPE]));
mod.push(...sec(2, [
    1,
    1, 0x65, 1, 0x74, 0x01, 0x70, 0x00, ...uleb(1),   /* e.t : table */
]));
{
    const fn = [...uleb(NFN)];
    for (let k = 0; k + 1 < NFN; k++) pushAll(fn, uleb(0));
    pushAll(fn, uleb(1));                       /* the thunk's type */
    mod.push(...sec(3, fn));
}
mod.push(...sec(6, [1, 0x7f, 0x01, 0x41, ...sleb(0), 0x0b]));
mod.push(...sec(7, [1, 3, 0x72, 0x75, 0x6e, 0x00, ...uleb(NFN - 1)]));
{
    const el = [...uleb(N)];
    for (let k = 0; k < N; k++) {
        el.push(0x00, 0x41, ...sleb(k), 0x0b, ...uleb(1), ...uleb(STUB_BASE + k));
    }
    mod.push(...sec(9, el));
}
{
    const payload = [...uleb(NFN)];
    pushAll(payload, code);
    mod.push(10, ...uleb_p5(payload.length));
    pushAll(mod, payload);
}

const bytes = new Uint8Array(mod);
const table = new WebAssembly.Table({ element: 'anyfunc', initial: N });
const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes),
                                      { e: { t: table } });

let fail = 0;
for (let k = 0; k < N; k++) {
    const got = inst.exports.run(0n, 0n, 0n, k);
    if (got !== 1000 + k) {
        console.log(`arm ${k}: got ${got} want ${1000 + k}`);
        if (++fail > 8) break;
    }
}
console.log(`mode=${MODE} members=${N} bytes=${bytes.length} merged=${mergedLen} ` +
            (fail ? `FAIL(${fail})` : 'ok — every arm selected correctly'));
process.exit(fail ? 1 : 0);
