/*
 * Tiny Code Generator for QEMU — wasm32 runtime-JIT dispatch
 * (ported from ktock/qemu-wasm, qemu 8.2; emitters in tcg/wasm32/
 * tcg-target.c.inc)
 *
 * Each TB carries both TCI bytecode (fallback interpreter) and a
 * standalone wasm module (tcg/tcg.c assembles it after the TB).  This
 * file owns the instance lifecycle and the execution dispatch loop:
 *
 *   - a TB's wasm instance is created on first execution (WebAssembly.
 *     Module/Instance via JS glue, called through the emscripten
 *     function table; instances are registered with FinalizationRegistry
 *     so the engine's GC can reclaim them, tracked per thread)
 *   - live instances chain TBs without returning to cpu_exec: the
 *     instance stores the next TB's tc.ptr in ctx.tb_ptr and returns;
 *     the loop below resolves and calls the next instance (or runs the
 *     TCI fallback when no instance is alive)
 *   - ctx.tb_ptr == 0 means a real exit (exit_tb); the return value
 *     propagates to cpu_tb_exec
 *
 * The TCI fallback uses the same protocol via the tci_w32_next* ops
 * (see tcg/tci/tcg-target-opc.h.inc), so fallback TBs chain identically.
 */

#if !defined(CONFIG_TCG_INTERPRETER) && defined(__EMSCRIPTEN__)

#include "qemu/osdep.h"
#include "tcg/tcg.h"
#include "tcg/tcg-ldst.h"
#include "exec/memop.h"
#include "exec/memopidx.h"
#include "tcg/tcg-op.h"
#include "system/cpu-timers.h"
#include <string.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include "wasm32.h"

uintptr_t QEMU_DISABLE_CFI tcg_qemu_tb_exec_tci(CPUArchState *env,
                                                const void *v_tb_ptr);
extern __thread uintptr_t tci_tb_ptr;

/*
 * Instantiate the wasm module for the TB whose prefix pointer is stored
 * in ctx.tb_ptr (thread-local, read via the JS-side pointer).  The TB
 * layout (see tcg/tcg.c) is:
 *
 *   [tci_code_off][export sz][export vec][counter sz][counter vec]
 *   [icount][code_size][TCI code][wasm_size][wasm module][helper sz]
 *   [helper index table]
 */
EM_JS(int, instantiate_wasm, (), {
    const memory_v = new DataView(HEAP8.buffer);

    const tb_ptr = memory_v.getInt32(Module.__wasm32_tb.tb_ptr_ptr, true);
    const export_vec_size = memory_v.getInt32(tb_ptr + 4, true);
    const export_vec_begin = tb_ptr + 4 + 4;

    const counter_vec_size =
        memory_v.getInt32(export_vec_begin + export_vec_size, true);
    const counter_vec_begin = export_vec_begin + export_vec_size + 4;

    /* layout after counters: [icount(4)] [code_size(4)] [TCI code] */
    const tmp_body_size =
        memory_v.getInt32(counter_vec_begin + counter_vec_size + 4, true);
    const tmp_body_begin = counter_vec_begin + counter_vec_size + 8;
    const wasm_size = memory_v.getInt32(tmp_body_begin + tmp_body_size, true);
    const wasm_begin = tmp_body_begin + tmp_body_size + 4;
    const import_vec_size = memory_v.getInt32(wasm_begin + wasm_size, true);
    const import_vec_begin = wasm_begin + wasm_size + 4;

    // Create a full copy of the bytes instead of a subarray view to fix
    // Firefox compatibility (https://bugzilla.mozilla.org/show_bug.cgi?id=1965217)
    const wasmBytes = new Uint8Array(HEAP8.slice(wasm_begin, wasm_begin + wasm_size));

    var helper = {};
    for (var i = 0; i < import_vec_size / 4; i++) {
        helper[i] = wasmTable.get(
            memory_v.getInt32(import_vec_begin + i * 4, true));
    }
    const mod = new WebAssembly.Module(wasmBytes);
    const inst = new WebAssembly.Instance(mod, {
        "env": { "buffer": wasmMemory },
        "helper": helper,
    });

    Module.__wasm32_tb.inst_gc_registry.register(inst, "instance");

    const fidx = addFunction(inst.exports.start, 'ii');

    return fidx;
});

EM_JS(void, remove_module_js, (), {
    const memory_v = new DataView(HEAP8.buffer);
    const remove_n =
        memory_v.getInt32(Module.__wasm32_tb.to_remove_instance_idx_ptr, true);
    for (var i = 0; i < remove_n * 4; i += 4) {
        removeFunction(
            memory_v.getInt32(Module.__wasm32_tb.to_remove_instance_ptr + i, true));
    }
    memory_v.setInt32(Module.__wasm32_tb.to_remove_instance_idx_ptr, 0, true);
});

__thread bool initdone = false;
__thread int cur_core_num = -1;
__thread int export_vec_off = -1;
__thread int counter_vec_off = -1;
__thread int tb_icount_off = -1;
__thread int all_cores_num = -1;
int cur_core_num_max = 0;

int instance_alive_global = 0;
__thread int instance_alive_local = 0;
__thread int instance_running_local = 0;
__thread uint32_t instance_garbage_collected_local = 0;

struct instance_info {
    uint8_t *tb;
    int fidx;
};

#define MAX_INSTANCE_ALIVE 15000
#define INSTANCE_RUNNING_LEN MAX_INSTANCE_ALIVE
__thread struct instance_info instance_running[INSTANCE_RUNNING_LEN];
__thread int instance_running_begin = 0;
__thread int instance_running_end = 0;

#define TO_REMOVE_INSTANCE_SIZE 50000
__thread static int to_remove_instance[TO_REMOVE_INSTANCE_SIZE];
__thread static int to_remove_instance_idx = 0;

static bool can_add_instance(void)
{
    return qatomic_read(&instance_alive_global) < MAX_INSTANCE_ALIVE;
}

static void inc_instance_local(void)
{
    instance_running_local++;
    instance_alive_local++;
}

static int instance_pending_gc_local(void)
{
    return instance_alive_local - instance_running_local;
}

static void check_instance_garbage_collected(void)
{
    if (instance_garbage_collected_local > 0) {
        if (instance_garbage_collected_local > instance_pending_gc_local()) {
            printf("unexpected number of removed instances %d > %d\n",
                   instance_garbage_collected_local, instance_pending_gc_local());
            exit(1);
        }
        qatomic_sub(&instance_alive_global, instance_garbage_collected_local);
        instance_alive_local -= instance_garbage_collected_local;
        instance_garbage_collected_local = 0;
    }
}

static void remove_instance_running_local(void)
{
    if (instance_pending_gc_local() > 0) {
        return;
    }
    int to_remove = instance_running_local / 2;
    for (int i = 0; i < to_remove; i++) {
        instance_running[instance_running_begin].tb = NULL;
        to_remove_instance[to_remove_instance_idx++] =
            instance_running[instance_running_begin].fidx;
        instance_running_local--;
        instance_running_begin = (instance_running_begin + 1) % INSTANCE_RUNNING_LEN;
    }
    if (to_remove_instance_idx > 0) {
        remove_module_js();
    }
}

static void add_instance_running_local(int fidx, void *tb_ptr)
{
    instance_running[instance_running_end].tb = tb_ptr;
    instance_running[instance_running_end].fidx = fidx;

    int tb_export_ptr = (uint32_t)tb_ptr + export_vec_off;
    *(uint32_t *)tb_export_ptr = (uint32_t)(&(instance_running[instance_running_end]));

    instance_running_end = (instance_running_end + 1) % INSTANCE_RUNNING_LEN;
    inc_instance_local();
    qatomic_inc(&instance_alive_global);
}

static int get_instance_running_local(void *tb_ptr)
{
    int tb_export_ptr = (uint32_t)tb_ptr + export_vec_off;
    struct instance_info *elm = (struct instance_info *)(*(uint32_t *)tb_export_ptr);
    if (elm == NULL) {
        return 0;
    }
    if (elm->tb != tb_ptr) {
        /* the ring slot was recycled for another TB: re-instantiate */
        *(uint32_t *)tb_export_ptr = 0;
        int tb_counter_ptr = (uint32_t)tb_ptr + counter_vec_off;
        *(uint32_t *)tb_counter_ptr = INSTANTIATE_NUM; /* instantiate soon */
        return 0;
    }
    return elm->fidx;
}

__thread struct wasmContext ctx = {
    .tb_ptr = 0,
    .stack = NULL,
    .do_init = 1,
    .stack128 = NULL,
};

/* shared with the TCI fallback interpreter (tci_w32_next* ops);
 * initialized by init_wasm32() - emscripten TLS cannot hold dynamic
 * initializers such as &ctx. */
__thread struct wasmContext *tci_w32_ctx;

void set_done_flag(void)
{
    ctx.done_flag = 1;
}

void set_unwinding_flag(void)
{
    ctx.unwinding = 1;
}

int get_core_nums(void)
{
    return emscripten_num_logical_cores();
}

EM_JS(void, init_wasm32_js,
      (int tb_ptr_ptr, int cur_core_num, int to_remove_instance_ptr,
       int to_remove_instance_idx_ptr, int instance_garbage_collected_ptr), {
    Module.__wasm32_tb = {
        tb_ptr_ptr: tb_ptr_ptr,
        cur_core_num: cur_core_num,
        to_remove_instance_ptr: to_remove_instance_ptr,
        to_remove_instance_idx_ptr: to_remove_instance_idx_ptr,
        instance_garbage_collected_ptr: instance_garbage_collected_ptr,
        inst_gc_registry: new FinalizationRegistry((i) => {
            if (i == "instance") {
                const memory_v = new DataView(HEAP8.buffer);
                let v = memory_v.getInt32(
                    Module.__wasm32_tb.instance_garbage_collected_ptr, true);
                memory_v.setInt32(
                    Module.__wasm32_tb.instance_garbage_collected_ptr, v + 1, true);
            }
        })
    };
});

void init_wasm32(void)
{
    if (!initdone) {
        cur_core_num = qatomic_fetch_inc(&cur_core_num_max);
        all_cores_num = get_core_nums();
        export_vec_off = 4 + 4 + cur_core_num * 4;
        counter_vec_off = 4 + 4 + all_cores_num * 4 + 4 + cur_core_num * 4;
        tb_icount_off = 4 + 4 + all_cores_num * 4 + 4 + all_cores_num * 4;
        ctx.stack = malloc(TCG_STATIC_CALL_ARGS_SIZE + TCG_STATIC_FRAME_SIZE);
        ctx.stack128 = malloc(TCG_STATIC_CALL_ARGS_SIZE + TCG_STATIC_FRAME_SIZE);
        ctx.tci_tb_ptr = (uint32_t *)&tci_tb_ptr;
        tci_w32_ctx = &ctx;
        init_wasm32_js((int)&ctx.tb_ptr, cur_core_num, (int)to_remove_instance,
                       (int)&to_remove_instance_idx,
                       (int)&instance_garbage_collected_local);
        initdone = true;
    }
}

/*
 * TCI fallback: run the shared tcg/tci.c interpreter over the TB's TCI
 * bytecode (stored after the TB prefix; first word = its offset).  TBs
 * ending in goto_tb/goto_ptr set ctx.tb_ptr via the tci_w32_next* ops
 * and return 0; exit_tb returns its value with ctx.tb_ptr left null.
 */
static inline uintptr_t tci_exec_fallback(CPUArchState *env)
{
    uint32_t off = *(uint32_t *)ctx.tb_ptr;
    uint32_t *code_ptr = (uint32_t *)((uint8_t *)ctx.tb_ptr + off);
    return tcg_qemu_tb_exec_tci(env, code_ptr);
}

typedef uint32_t (*wasm_func_ptr)(struct wasmContext *);

/* diagnostics: instance pressure (page: m._wasm32_alive()) */
EMSCRIPTEN_KEEPALIVE
int wasm32_alive(void)
{
    return qatomic_read(&instance_alive_global);
}

uintptr_t QEMU_DISABLE_CFI tcg_qemu_tb_exec(CPUArchState *env,
                                            const void *v_tb_ptr)
{
    ctx.env = env;
    ctx.tb_ptr = (uint32_t *)v_tb_ptr;
    ctx.do_init = 1;

    while (true) {
        uint32_t res;
        /*
         * Per-TB accounting (mirrors INDEX_op_tci_tbhdr in the TCI
         * build): wasm_tb_account feeds the WATCH insns/tbs counters;
         * icount2 only runs under the icount2 timing model.  The TB
         * prefix's [icount] slot is filled at translation time.
         */
        {
            extern void wasm_tb_account(unsigned insns);
            uint32_t ic = *(uint32_t *)((uint8_t *)ctx.tb_ptr + tb_icount_off);
            wasm_tb_account(ic);
            if (icount2_enabled()) {
                icount2_advance(ic);
            }
        }
        int tb_counter_ptr = (uint32_t)ctx.tb_ptr + counter_vec_off;
        int fidx = get_instance_running_local(ctx.tb_ptr);
        if (fidx > 0) {
            res = ((wasm_func_ptr)(fidx))(&ctx);
        } else if (*(int32_t *)tb_counter_ptr < INSTANTIATE_NUM) {
            *(int32_t *)tb_counter_ptr += 1;
            res = tci_exec_fallback(env);
        } else if (!can_add_instance()) {
            remove_instance_running_local();
            check_instance_garbage_collected();
            res = tci_exec_fallback(env);
        } else {
            int fidx = instantiate_wasm();
            add_instance_running_local(fidx, ctx.tb_ptr);
            res = ((wasm_func_ptr)(fidx))(&ctx);
        }
        if ((uint32_t)ctx.tb_ptr == 0) {
            return res;
        }
    }
}

#endif /* !CONFIG_TCG_INTERPRETER && __EMSCRIPTEN__ */
