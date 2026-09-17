#!/usr/bin/env node
/*
 * What a TB->TB transition costs, with the emulator taken out of the picture.
 *
 * The wasm64 backend ends every TB with return_call_indirect through a
 * WebAssembly.Table shared by every TB module (signature type 0 =
 * (i64,i64,i64)->i32, 37 declared locals per function).  A four-point
 * W64_FTMAX sweep on a J2ME game prices that transition at ~26 ns, which is
 * an order of magnitude above what an indirect branch should cost -- but a
 * whole-emulator A/B cannot say which part of the sequence is expensive, and
 * every candidate fix is a large change to the backend.
 *
 * So build the transition by itself: chains of tiny functions that do nothing
 * but compute the next index and go there.  Every variant runs the same
 * number of transitions and the same index arithmetic, so the differences are
 * the mechanism and nothing else:
 *
 *   xtail    cross-module return_call_indirect     <- what the backend emits
 *   xtail37  the same, with 37 declared locals     <- prologue cost
 *   stail    same-module return_call_indirect      <- instance-switch cost
 *   loop     call_indirect from a driver loop      <- tail call vs call/return
 *   direct   same-module return_call, fixed chain  <- the floor
 *   merged   one function, NFUNC arms, br_table    <- the module-local loop
 *   merged37 the same, with 37 declared locals     <- its real shape
 *   xstub    xtail through a selector-setting stub <- the merge's entry cost
 *   sstub    stail through the same stub           <- the same, same-module
 *
 * `merged` is the probe for the module-local dispatch loop (see
 * performance-handoff.md): if a module's TBs were one function instead of
 * NFUNC of them, an intra-module transition would be `br` to the cascade head
 * plus a br_table, with no call at all.  It is also the only variant whose
 * risk is the compiler rather than the mechanism -- one function holding
 * NFUNC arms and 37 locals is what TurboFan's register allocator has to
 * survive -- so sweep NFUNC up to at least the ~277 TBs a real module holds
 * and watch for the point where it stops scaling.
 *
 * Run under node (same TurboFan as the Chromium the emulator runs in); it
 * needs no build and no page.
 */

/*
 * Table size and body size are parameters because they are the two ways this
 * benchmark can lie.  A 256-entry table of empty functions fits in L1i, so it
 * measures the dispatch mechanism with every cache effect removed; the real
 * code cache is thousands of TBs of a few hundred wasm instructions each, and
 * whatever the gap turns out to be is instruction fetch, which no change to
 * the dispatch sequence can recover.  Sweep both before believing either.
 */
const CFG = (typeof process !== 'undefined' && process.env)
    ? process.env : (globalThis.DB_CFG || {});
const NFUNC = Number(CFG.DB_NFUNC || 256);
const PAD = Number(CFG.DB_PAD || 0);
/* how many modules the cross-module variants spread NFUNC functions over;
 * NFUNC (the default) is one each, the shape this benchmark had before */
const NMOD = Math.max(1, Math.min(NFUNC, Number(CFG.DB_NMOD || NFUNC)));

/*
 * Two ways a reading of this benchmark goes silently wrong, both found by
 * running it:
 *
 * NFUNC must be a power of two.  nextIndex reduces the LCG with
 * `i64.and (NFUNC-1)` -- anything else would put a division on the hot
 * path -- so a non-power-of-two reaches only the indices whose bits are a
 * subset of NFUNC-1.  A sweep at 277 walked eight targets, not 277, and
 * reported xtail at 2.47 ns sitting between 6.68 at 128 and 66.63 at
 * 1024.  Use 256 for the ~259 TBs a real module holds.
 *
 * PAD must be > 0 before `merged` means anything.  At PAD=0 every arm of
 * the br_table is the identical two bytes `br $L`, and TurboFan merges
 * identical blocks: the 1024-way dispatch collapses to one target,
 * perfectly predicted, and reports 1.17 ns for what cannot cost less
 * than a mispredict.  pad(k) is seeded per arm precisely so the arms
 * stay distinct.
 */
if ((NFUNC & (NFUNC - 1)) !== 0) {
    throw new Error(`DB_NFUNC=${NFUNC} is not a power of two: nextIndex masks `
                    + `with NFUNC-1, so only ${
                        [...Array(NFUNC).keys()].filter((i) =>
                            (i & (NFUNC - 1)) === i).length
                    } of the ${NFUNC} slots would ever be reached`);
}

/* node resolves nanoseconds; a browser gives 5 us at best, so runs are sized
 * in the tens of milliseconds and the quantisation washes out */
const nowNs = (typeof process !== 'undefined' && process.hrtime)
    ? () => Number(process.hrtime.bigint())
    : () => performance.now() * 1e6;
const SIG = 0;                  /* (i64,i64,i64)->i32, the backend's type 0 */

/* ------------------------------------------------------------ encoding */

function uleb(n) {
    const out = [];
    let v = BigInt(n);
    do {
        let b = Number(v & 0x7fn);
        v >>= 7n;
        if (v) b |= 0x80;
        out.push(b);
    } while (v);
    return out;
}

function sleb(n) {
    const out = [];
    let v = BigInt(n);
    for (;;) {
        const b = Number(v & 0x7fn);
        v >>= 7n;
        const sign = b & 0x40;
        if ((v === 0n && !sign) || (v === -1n && sign)) {
            out.push(b);
            return out;
        }
        out.push(b | 0x80);
    }
}

function vec(items) {
    return [...uleb(items.length), ...items.flat()];
}

function section(id, payload) {
    return [id, ...uleb(payload.length), ...payload];
}

function name(s) {
    const b = [...new TextEncoder().encode(s)];
    return [...uleb(b.length), ...b];
}

const I32 = 0x7f, I64 = 0x7e;

/* ---------------------------------------------------------- code parts */

/*
 * Locals declaration.  The backend declares 2 * TCG_TARGET_NB_REGS + 5 = 37
 * of them in every TB function, so the prologue that zeroes them is paid on
 * every transition; `extra` reproduces that.
 */
function localsDecl(extra) {
    return extra ? vec([[...uleb(extra), I32]]) : vec([]);
}

/* local 0 = countdown, local 1 = index state, local 2 = unused (arg 3) */
const DEC_AND_MAYBE_RETURN = [
    0x20, 0,                    /* local.get 0 */
    0x42, ...sleb(1),           /* i64.const 1 */
    0x7d,                       /* i64.sub */
    0x22, 0,                    /* local.tee 0 */
    0x50,                       /* i64.eqz */
    0x04, 0x40,                 /* if (void) */
    0x41, ...sleb(0),           /* i32.const 0 */
    0x0f,                       /* return */
    0x0b,                       /* end */
];

/*
 * Next index.  `rand` runs an LCG so the indirect target is unpredictable,
 * which is what a guest interpreter's dispatch looks like; `seq` strides by 7
 * so the branch predictor sees a pattern.  Both leave the state in local 1
 * and an i32 table index on the stack.
 */
function nextIndex(rand) {
    if (rand) {
        return [
            0x20, 1,
            0x42, ...sleb(6364136223846793005n),
            0x7e,                               /* i64.mul */
            0x42, ...sleb(1442695040888963407n),
            0x7c,                               /* i64.add */
            0x21, 1,                            /* local.set 1 */
            0x20, 1,
            0x42, ...sleb(33),
            0x88,                               /* i64.shr_u */
            0x42, ...sleb(NFUNC - 1),
            0x83,                               /* i64.and */
            0xa7,                               /* i32.wrap_i64 */
        ];
    }
    return [
        0x20, 1,
        0x42, ...sleb(7),
        0x7c,
        0x42, ...sleb(NFUNC - 1),
        0x83,
        0x21, 1,
        0x20, 1,
        0xa7,
    ];
}

/*
 * Body filler, to give each function a realistic footprint.  add and xor do
 * not distribute over each other, so alternating them defeats constant
 * folding; the chain ends in local 1, which feeds the index, so none of it is
 * dead.  Each op is one cycle, so PAD buys code size far faster than time.
 */
function pad(seed) {
    const out = [];
    for (let k = 0; k < PAD; k++) {
        out.push(0x20, 1,
                 0x42, ...sleb(((seed + k) * 2654435761) % 60 + 1),
                 k & 1 ? 0x85 : 0x7c,       /* i64.xor : i64.add */
                 0x21, 1);
    }
    return out;
}

/* the three i64 args, then the index, then the transition */
function tailBody(rand, extraLocals, seed = 0) {
    const code = [
        ...DEC_AND_MAYBE_RETURN,
        ...pad(seed),
        ...nextIndex(rand),
        0x21, 3 + extraLocals,              /* stash index in a scratch i32 */
        0x20, 0, 0x20, 1, 0x20, 2,
        0x20, 3 + extraLocals,
        0x13, ...uleb(SIG), 0x00,           /* return_call_indirect sig, tbl 0 */
        0x0b,
    ];
    const locals = vec([[...uleb(extraLocals + 1), I32]]);
    return [...locals, ...code];
}

/* returns the next index instead of going there; the driver loop calls back */
function leafBody(rand, seed = 0) {
    const code = [
        ...DEC_AND_MAYBE_RETURN,
        ...pad(seed),
        ...nextIndex(rand),
        0x0b,
    ];
    return [...localsDecl(0), ...code];
}

/* fixed successor: the transition a patched goto_tb would ideally compile to */
function directBody(succ, seed = 0, extra = 0) {
    const code = [
        ...DEC_AND_MAYBE_RETURN,
        ...pad(seed),
        0x20, 0, 0x20, 1, 0x20, 2,
        0x12, ...uleb(succ),                /* return_call */
        0x0b,
    ];
    return [...localsDecl(extra), ...code];
}

/*
 * The driver: decrement, call the current index, take its answer as the next
 * index.  Same transition count and same index arithmetic as the tail
 * variants, but a call/return pair instead of a tail call.
 */
function driverBody() {
    const code = [
        0x03, 0x40,                         /* loop (void) */
        0x20, 0, 0x50,                      /* local.get 0; i64.eqz */
        0x04, 0x40, 0x41, ...sleb(0), 0x0f, 0x0b,
        0x20, 0, 0x42, ...sleb(1), 0x7d, 0x21, 0,
        0x20, 0, 0x20, 1, 0x20, 2,
        0x20, 1, 0xa7,
        0x11, ...uleb(SIG), 0x00,           /* call_indirect sig, table 0 */
        0xac,                               /* i64.extend_i32_s */
        0x21, 1,
        0x0c, 0,                            /* br loop */
        0x0b,                               /* end loop */
        0x41, ...sleb(0),
        0x0b,
    ];
    return [...localsDecl(0), ...code];
}

/*
 * One function holding every "TB" as an arm of a br_table cascade, with the
 * transition expressed as `br` back to the loop head.  The shape is the one
 * the assembler can build today: bodies are position-independent because every
 * branch a TB emits targets a block that TB pushed itself, so wrapping them in
 * N more enclosing blocks cannot change their meaning.
 *
 *   block $exit
 *     loop $L
 *       br_if $exit (countdown exhausted)
 *       block B0 ... block B(N-1)
 *         br_table                     ; to B(N-1-j) for arm j
 *       end B(N-1)   BODY(N-1)  br $L  ; depth N-1
 *       ...
 *       end B0       BODY0      br $L  ; depth 0
 *     end
 *   end
 *
 * Branching to B_k lands immediately after `end B_k`, which is BODY_k, and
 * BODY_k is enclosed by B_0..B_(k-1) plus the loop -- so its `br $L` is
 * exactly depth k.  Not modelled: the real thing also tests `arm < N` and
 * falls back to a table call when the successor is in another module, which
 * is one compare and one perfectly-predicted br_if on top of this.
 */
function mergedBody(rand, extraLocals) {
    const N = NFUNC;
    const code = [
        0x02, 0x40,                         /* block $exit */
        0x03, 0x40,                         /* loop $L */
        0x20, 0, 0x50, 0x0d, 1,             /* if countdown == 0: br $exit */
        0x20, 0, 0x42, ...sleb(1), 0x7d, 0x21, 0,
    ];
    for (let k = 0; k < N; k++) {
        code.push(0x02, 0x40);
    }
    code.push(...nextIndex(rand));
    code.push(0x0e, ...uleb(N));
    for (let k = 0; k < N; k++) {
        code.push(...uleb(N - 1 - k));
    }
    code.push(...uleb(0));                  /* default: the mask makes it dead */
    for (let k = N - 1; k >= 0; k--) {
        code.push(0x0b);                    /* end B_k */
        code.push(...pad(k));
        code.push(0x0c, ...uleb(k));        /* br $L */
    }
    code.push(0x0b);                        /* end loop (unreachable) */
    code.push(0x0b);                        /* end $exit */
    code.push(0x41, ...sleb(0));
    code.push(0x0b);                        /* end func */
    return [...localsDecl(extraLocals), ...code];
}

/* --------------------------------------------------------------- module */

const TYPE_SEC = section(1, vec([
    [0x60, ...vec([[I64], [I64], [I64]]), ...vec([[I32]])],
]));

const IMPORT_TABLE = section(2, vec([
    [...name('e'), ...name('t'), 0x01, 0x70, 0x00, ...uleb(NFUNC)],
]));

function moduleOf(bodies, withGlobal) {
    return Uint8Array.from([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        ...TYPE_SEC,
        ...IMPORT_TABLE,
        ...section(3, vec(bodies.map(() => uleb(SIG)))),
        ...(withGlobal
            ? section(6, vec([[I32, 0x01, 0x41, ...sleb(0), 0x0b]]))
            : []),
        ...section(7, vec(bodies.map((_, i) => [...name('f' + i), 0x00, ...uleb(i)]))),
        ...section(10, vec(bodies.map((b) => [...uleb(b.length), ...b]))),
    ]);
}

/*
 * The entry stub the merged design needs: the chain table still holds one
 * funcref per TB, so something has to turn the table index back into a
 * cascade arm.  It sets the selector global and tail-calls the merged body.
 *
 * This is the variable the merged design lives or dies on.  Merging buys the
 * tier-up amortisation (3-6 % of a game), but it adds this hop to every TB
 * entry, and ~108k TB boundaries/Mi against 10.03 ms/Mi means a hop costing
 * 3 ns is already 3.2 % -- the whole prize.  `xstub`/`sstub` differ from
 * `xtail`/`stail` by the stub and nothing else, so the difference is the
 * price, and price x rate says whether to build it this way or make the
 * caller store the index instead.
 */
function stubBody(arm, target) {
    return [
        ...localsDecl(0),
        0x41, ...sleb(arm),
        0x24, ...uleb(0),                   /* global.set $sel */
        0x20, 0, 0x20, 1, 0x20, 2,
        0x12, ...uleb(target),              /* return_call */
        0x0b,
    ];
}

/* ---------------------------------------------------------------- run */

function build(variant, rand) {
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: NFUNC });
    const imports = { e: { t: table } };
    const fns = [];

    if (variant === 'xtail' || variant === 'xtail37' || variant === 'xloop') {
        /* NFUNC functions spread over NMOD modules.  Table size and instance
         * count are separate axes and NFUNC alone welds them together: the
         * emulator runs ~7000 TBs out of ~27 batch modules, a combination
         * one-module-per-function never reaches. */
        const extra = variant === 'xtail37' ? 36 : 0;
        const per = Math.ceil(NFUNC / NMOD);
        for (let i = 0; i < NFUNC; i += per) {
            const bodies = [];
            for (let j = i; j < Math.min(i + per, NFUNC); j++) {
                bodies.push(variant === 'xloop' ? leafBody(rand, j)
                                                : tailBody(rand, extra, j));
            }
            const inst = new WebAssembly.Instance(
                new WebAssembly.Module(moduleOf(bodies)), imports);
            for (let k = 0; k < bodies.length; k++) {
                fns.push(inst.exports['f' + k]);
            }
        }
        if (variant === 'xloop') {
            const d = new WebAssembly.Module(moduleOf([driverBody()]));
            fns.push(new WebAssembly.Instance(d, imports).exports.f0);
        }
    } else if (variant === 'xstub' || variant === 'sstub') {
        /* identical to xtail/stail except that the table entry is a stub
         * which sets the selector and tail-calls the body */
        if (variant === 'xstub') {
            for (let i = 0; i < NFUNC; i++) {
                const m = new WebAssembly.Module(
                    moduleOf([stubBody(i, 1), tailBody(rand, 0, i)], true));
                fns.push(new WebAssembly.Instance(m, imports).exports.f0);
            }
        } else {
            const bodies = [];
            for (let i = 0; i < NFUNC; i++) {
                bodies.push(tailBody(rand, 0, i));
            }
            for (let i = 0; i < NFUNC; i++) {
                bodies.push(stubBody(i, i));
            }
            const inst = new WebAssembly.Instance(
                new WebAssembly.Module(moduleOf(bodies, true)), imports);
            for (let i = 0; i < NFUNC; i++) {
                fns.push(inst.exports['f' + (NFUNC + i)]);
            }
        }
    } else if (variant.startsWith('merged')) {
        const extra = Number(variant.slice(6) || 0);
        const inst = new WebAssembly.Instance(
            new WebAssembly.Module(moduleOf([mergedBody(rand, extra)])), imports);
        return inst.exports.f0;
    } else if (variant === 'stail' || variant === 'loop' ||
               variant.startsWith('direct')) {
        const bodies = [];
        /* directNN declares NN extra locals: the backend declares 37 in every
         * TB function, and whether a tiered-up function still pays for the
         * ones it never touches is the whole question */
        const extra = Number(variant.slice(6) || 0);
        for (let i = 0; i < NFUNC; i++) {
            bodies.push(variant === 'stail' ? tailBody(rand, 0, i)
                      : variant === 'loop' ? leafBody(rand, i)
                      : directBody((i + 1) % NFUNC, i, extra));
        }
        if (variant === 'loop') {
            bodies.push(driverBody());
        }
        const inst = new WebAssembly.Instance(
            new WebAssembly.Module(moduleOf(bodies)), imports);
        for (let i = 0; i < NFUNC; i++) {
            fns.push(inst.exports['f' + i]);
        }
        if (variant === 'loop') {
            fns.push(inst.exports['f' + NFUNC]);
        }
    } else {
        throw new Error('unknown variant ' + variant);
    }

    for (let i = 0; i < NFUNC; i++) {
        table.set(i, fns[i]);
    }
    return (variant === 'loop' || variant === 'xloop') ? fns[NFUNC] : fns[0];
}

function time(entry, n) {
    const t0 = nowNs();
    const r = entry(BigInt(n), 1n, 0n);
    return { ns: (nowNs() - t0) / n, sink: r };
}

const VARIANTS = (CFG.DB_VARIANTS ||
    'xtail,xtail37,xloop,stail,loop,direct,merged,merged37').split(',');
const N = Number((typeof process !== 'undefined' && process.argv[2]) ||
                 CFG.DB_N || 20e6);
const REPS = Number((typeof process !== 'undefined' && process.argv[3]) ||
                    CFG.DB_REPS || 5);

for (const rand of [true, false]) {
    const rows = [];
    for (const v of VARIANTS) {
        const entry = build(v, rand);
        time(entry, 2e6);                       /* tier up */
        const runs = [];
        for (let r = 0; r < REPS; r++) {
            runs.push(time(entry, N).ns);
        }
        runs.sort((a, b) => a - b);
        rows.push([v, runs[0], runs[(REPS - 1) >> 1]]);
    }
    const base = rows[0][1];
    console.log(`--- ${rand ? 'unpredictable' : 'strided'} targets, ` +
                `${NFUNC} slots, ${NMOD} modules, pad=${PAD}, `
                + `${N} transitions x ${REPS} ---`);
    for (const [v, best, med] of rows) {
        console.log(`${v.padEnd(8)} best=${best.toFixed(2)}ns ` +
                    `med=${med.toFixed(2)}ns  vs-xtail=${(best - base).toFixed(2)}ns`);
    }
}
