/*
 * What one guest exception costs before any of QEMU runs.
 *
 * Every ARM SVC the guest executes leaves TB code through
 * cpu_loop_exit -> siglongjmp(cpu->jmp_env) back into cpu_exec_setjmp,
 * and this workload takes ~691 of them per Mi of guest work.  Under
 * emscripten's default SjLj that longjmp is a JS `throw` crossing the
 * wasm boundary and unwinding every frame in between; under
 * -sSUPPORT_LONGJMP=wasm it is a wasm EH branch.  The difference decides
 * whether rebuilding the world with wasm EH is worth a workstream.
 *
 * The shape is QEMU's, not a microbenchmark's: the jump leaves a helper
 * called from an *indirect* call through the function table, standing in
 * for the generated TB in its own module.
 *
 *   emcc -O2 -sMEMORY64=1 -sWASM_BIGINT [-sSUPPORT_LONGJMP=wasm]
 *        tests/wasm/sjljbench.c -o out.js
 */
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <emscripten.h>

static sigjmp_buf env;
static volatile long sink;

__attribute__((noinline)) static void level4(long x)
{
    sink += x;
    siglongjmp(env, 1);
}
__attribute__((noinline)) static void level3(long x) { sink += x; level4(x); }
__attribute__((noinline)) static void level2(long x) { sink += x; level3(x); }
__attribute__((noinline)) static void level1(long x) { sink += x; level2(x); }

typedef void (*fn_t)(long);
/* volatile so the call stays indirect: the real unwind crosses a table
 * call into a separately instantiated TB module */
static volatile fn_t indirect = level1;

__attribute__((noinline)) static void outer(long x) { sink += x; indirect(x); }

/* the shape of cpu_exec_setjmp: sigsetjmp, then the loop it guards */
__attribute__((noinline)) static long jumped(long x)
{
    if (sigsetjmp(env, 0) != 0) {
        return 1;
    }
    outer(x);
    return 0;
}

int main(int argc, char **argv)
{
    long n = argc > 1 ? atol(argv[1]) : 200000;
    long taken = 0;

    for (long i = 0; i < 2000; i++) {
        taken += jumped(i);              /* warm the tiers */
    }
    double t0 = emscripten_get_now();
    for (long i = 0; i < n; i++) {
        taken += jumped(i);
    }
    double t1 = emscripten_get_now();
    printf("SJLJ n=%ld taken=%ld ns/longjmp=%.1f total_ms=%.1f sink=%ld\n",
           n, taken, (t1 - t0) * 1e6 / n, t1 - t0, sink);

    /* the same call depth without the jump, so the number above is the
     * jump and not the four calls under it */
    double t2 = emscripten_get_now();
    for (long i = 0; i < n; i++) {
        sink += i;
    }
    double t3 = emscripten_get_now();
    printf("SJLJ baseline loop ns/iter=%.2f\n", (t3 - t2) * 1e6 / n);
    return 0;
}
