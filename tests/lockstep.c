/*
 * lockstep.c — TCG plugin: guest-state digests on an executed-insn grid.
 *
 * Phase 0b of doc/wasm-tcg-backend-plan.md §5: value-level comparison of
 * guest state between two TCG backends (native JIT vs native TCI today;
 * the wasm64 backend replaces one side from phase 1 on) over whole boots.
 * The old wasm32 port died on a data divergence that PC traces could not
 * see; this plugin folds *values*.
 *
 * Three qemu properties shape the design (all learned the hard way,
 * 2026-09-10 — see the phase-0b status note in the plan):
 *
 * 1. TB partitioning is TCG-internal state, not guest state. With
 *    -icount, accel/tcg/cpu-exec.c retranslates deadline-capped TBs
 *    (cflags_next_tb | insns_left) and the exact cap depends on
 *    generated-code expiry behavior: measured JIT vs TCI on S75, same
 *    guest insn stream and identical registers, TB lengths off by one
 *    (70 vs 69). A per-TB digest stream is therefore NOT comparable
 *    across backends — sampling here is keyed on a per-vCPU counter of
 *    *executed guest instructions*, incremented by an inline add at
 *    every insn (a few ns, no C call), with a conditional callback
 *    (QEMU_PLUGIN_COND_GE) that fires only when the counter reaches the
 *    sampling period. Both backends lower identical instrumentation to
 *    their own code, so sample points are guest-deterministic.
 *
 * 2. qemu_plugin_read_register() returns architectural values only in
 *    a callback registered with QEMU_PLUGIN_CB_R_REGS: TCG then syncs
 *    dirty globals to env around the call (plugins/core.c maps R_REGS to
 *    TCG_CALL_NO_WG). Also, gdb_get_reg32() APPENDS to the GByteArray —
 *    truncate it between reads or every register reads back the first
 *    one's bytes (this bug produced a fully green but vacuous comparison
 *    on the first try).
 *
 * 3. That per-insn global sync costs ~100x throughput inside multi-insn
 *    TBs (measured 0.25 MIPS on the S75 boot — the register allocator
 *    can no longer keep globals in host regs). Under -accel
 *    tcg,one-insn-per-tb=on there is nothing to keep alive and the same
 *    instrumentation runs at ~40 MIPS JIT / ~9.5 MIPS TCI. The driver
 *    (tools/lockstep.mjs) therefore boots both sides with
 *    one-insn-per-tb=on and -rtc base=<fixed>,clock=vm (the pmb887x RTC
 *    otherwise seeds from host time — the one real nondeterminism
 *    source found; under -icount the vm clock is guest-driven).
 *
 * At each sample the full GPR+CPSR vector is folded into a per-epoch
 * hash; every epoch an E-line is emitted; every `meminsns` the
 * configured memory ranges are digested into an M-line. All boundaries
 * are insn-indexed — byte-diffable across backends. Dense mode
 * (period=1) dumps a T-line per insn for localization of a divergent
 * epoch down to the exact insn + register vector, which then bisects
 * by op with the phase-0a suite (tests/tcg-isa).
 *
 * Usage:
 *   -plugin file=lockstep.so,out=/tmp/ls.log[,period=N][,epoch=N]
 *           [,meminsns=N][,mem=ADDR+LEN[:ADDR+LEN...]][,from=N][,to=N]
 *           [,corrupt=N][,probe=on]
 *
 *   period     sample every N executed insns (power of two, default 2^16;
 *              from=/to= imply 1)
 *   epoch      E-line every N insns (power of two, default 2^20)
 *   meminsns   M-line (memory digests) every N insns (default 2^24)
 *   mem        guest-vaddr ranges to digest (hex, no 0x; default
 *              800000+18000:a8000000+1000000 = pmb887x SRAM + SDRAM;
 *              ':' between ranges — ',' is qemu's plugin-arg separator)
 *   from/to    dense dump window of insn indices [from,to): every insn
 *              in the window gets a T-line (~150 bytes each)
 *   corrupt    positive control: flip one bit of r0 at the first sample
 *              at/after this insn (the harness must flag + localize it)
 *   stop_at    with stop_at=<insn>, exit the emulator after the first
 *              sample at/after that insn has run (X-line at the sample,
 *              exactly that many insns executed) — used to stop a side
 *              at an exact insn budget (the plugin can't reach qemu's
 *              shutdown request: static builds hide the symbol)
 *   probe      dump register list + first samples to stderr
 *
 * Log format (hashes are FNV-1a 64, host-endian fold — comparable only
 * between runs on the same host, which lockstep always is):
 *   C <args echoed>                                  config (line 1)
 *   E <vcpu> <epoch> <insn_total> <regs_hash>
 *   M <vcpu> <insn_total> <memdig> [<memdig>...]
 *   T <vcpu> <insn> <regs_hash> <r0> ... <r12> <sp> <lr> <pc> <cpsr> (dense)
 *   X <vcpu> <insn_total> <samples> <regs_all>             (at exit)
 *
 * Epoch hashes reset per epoch (localization granularity = 1 epoch);
 * regs_all folds the epoch hashes (whole-run equality check).
 */
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "plugins/qemu-plugin.h"

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

#define FNV0 0xcbf29ce484222325ull

#define MAX_REGS 24
#define MAX_MEM  8
#define MAX_VC   8

struct memrange {
    uint64_t addr;
    uint64_t len;
};

struct vstate {
    uint64_t samples;      /* samples taken = floor(insns/period) */
    uint64_t regs;         /* per-epoch regs hash */
    uint64_t regs_all;     /* fold of epoch hashes */
};

static FILE *logf;
static uint64_t period = 1ull << 16;
static uint64_t epoch_insns = 1ull << 20;
static uint64_t mem_insns = 1ull << 24;
static struct memrange memr[MAX_MEM];
static int n_memr;
static uint64_t tr_from = 0, tr_to = 0; /* dense window, empty by default */
static uint64_t corrupt_at = 0;        /* positive-control hook (tests) */
static uint64_t stop_at = 0;           /* exit after first sample at/after */
static int x_written = 0;

/* armed (set nonzero) at the budget sample; the per-insn inline check
 * is cheap, and the C call fires once — right after the sampled insn
 * has run, so exactly that many insns executed */
static void on_stopcheck(unsigned int vcpu, void *ud)
{
    (void)vcpu; (void)ud;
    exit(0);
}
static int probe_mode;
static int probe_reg_reported;
static int probe_mem_reported;

static struct qemu_plugin_register *regh[MAX_REGS];
static int n_regh;
static GByteArray *regbuf, *membuf;

static struct vstate vs[MAX_VC];

static struct qemu_plugin_scoreboard *score;
static qemu_plugin_u64 nexec; /* executed-insn counter, inline-inc'd */
static qemu_plugin_u64 stopflag; /* armed at the budget sample (stop_at) */

static inline uint64_t fnv1a(uint64_t h, const void *p, size_t n)
{
    const uint8_t *b = p;
    while (n--) {
        h ^= *b++;
        h *= 0x100000001b3ull;
    }
    return h;
}

static uint64_t mem_digest(const struct memrange *r)
{
    uint64_t h = fnv1a(FNV0, &r->addr, sizeof r->addr);
    g_byte_array_set_size(membuf, 0);
    /* failure must fold deterministically too: an epoch where the range
     * maps differently on the two backends *is* a divergence */
    bool ok = qemu_plugin_read_memory_vaddr(r->addr, membuf, r->len);
    if (probe_mode && probe_mem_reported < 4) {
        uint64_t first = 0;
        memcpy(&first, membuf->data, membuf->len < 8 ? membuf->len : 0);
        fprintf(stderr, "lockstep: mem read %llx+%llx ok=%d len=%u first=%016llx\n",
                (unsigned long long)r->addr, (unsigned long long)r->len,
                ok, membuf->len, (unsigned long long)first);
        probe_mem_reported++;
    }
    if (!ok) {
        return fnv1a(h, "UNMAPPED", 8);
    }
    return fnv1a(h, membuf->data, membuf->len);
}

static void read_regs(uint64_t vals[MAX_REGS])
{
    for (int i = 0; i < n_regh; i++) {
        /* gdb_get_reg32 appends — truncate between reads (execlog.c does
         * the same) or every value reads back the first register's bytes */
        g_byte_array_set_size(regbuf, 0);
        if (!qemu_plugin_read_register(regh[i], regbuf)) {
            vals[i] = 0xdeadbeefdeadbeefull;
            continue;
        }
        if (probe_mode && !probe_reg_reported) {
            fprintf(stderr, "lockstep: read_regs: regbuf len=%u\n", regbuf->len);
            probe_reg_reported = 1;
        }
        uint64_t v = 0;
        memcpy(&v, regbuf->data, regbuf->len < 8 ? regbuf->len : 8);
        vals[i] = v;
    }
}

/* fires exactly when the inline counter reaches `period` (the generated
 * code compares before every insn; we keep the residual on reset) */
static void on_sample(unsigned int vcpu, void *ud)
{
    if (vcpu >= MAX_VC) {
        return;
    }
    uint64_t cnt = qemu_plugin_u64_get(nexec, vcpu);
    qemu_plugin_u64_set(nexec, vcpu, cnt >= period ? cnt - period : 0);

    struct vstate *s = &vs[vcpu];
    uint64_t idx = ++s->samples;
    uint64_t insn_total = idx * period;

    uint64_t vals[MAX_REGS];
    read_regs(vals);

    /* positive control: inject a 1-bit value bug at (the first sample at
     * or after) this insn — the driver's digest comparison must flag the
     * epoch and the dense rerun must pinpoint the insn (--corrupt) */
    if (corrupt_at && insn_total >= corrupt_at) {
        corrupt_at = 0;
        vals[0] ^= 1;
    }

    /* fold the sample index with the values: a missing/extra sample must
     * diverge even when the register vector happens to repeat */
    uint64_t h = fnv1a(s->regs, &idx, sizeof idx);
    s->regs = fnv1a(h, vals, n_regh * sizeof(uint64_t));

    if (tr_to > tr_from && idx >= tr_from && idx < tr_to) {
        fprintf(logf, "T %u %llu %016llx", vcpu, (unsigned long long)insn_total,
                (unsigned long long)s->regs);
        for (int i = 0; i < n_regh; i++) {
            fprintf(logf, " %016llx", (unsigned long long)vals[i]);
        }
        fputc('\n', logf);
    }
    if (probe_mode && idx <= 4) {
        fprintf(stderr, "lockstep: insn %llu regs:",
                (unsigned long long)insn_total);
        for (int i = 0; i < n_regh; i++) {
            fprintf(stderr, " %016llx", (unsigned long long)vals[i]);
        }
        fputc('\n', stderr);
    }

    if (insn_total % epoch_insns == 0) {
        uint64_t epoch = insn_total / epoch_insns;
        /* Point-in-time hash of the register vector at this sample (folds
         * in idx so an off-by-one sample still diverges). The per-epoch
         * running digest `s->regs` is kept for regs_all but is not what the
         * E-line reports: comparing a rolling hash across backends is
         * fragile (it amplifies any transient), whereas the register vector
         * is the ground truth the gate checks. */
        uint64_t ehash = fnv1a(FNV0, &idx, sizeof idx);
        ehash = fnv1a(ehash, vals, n_regh * sizeof(uint64_t));
        s->regs_all = fnv1a(s->regs_all, &ehash, sizeof ehash);
        fprintf(logf, "E %u %llu %llu %016llx\n", vcpu,
                (unsigned long long)epoch, (unsigned long long)insn_total,
                (unsigned long long)ehash);
        fflush(logf);
        s->regs = FNV0;
    }
    if (insn_total % mem_insns == 0) {
        fprintf(logf, "M %u %llu", vcpu,
                (unsigned long long)insn_total);
        for (int i = 0; i < n_memr; i++) {
            fprintf(logf, " %016llx",
                    (unsigned long long)mem_digest(&memr[i]));
        }
        fputc('\n', logf);
        fflush(logf);
    }
    if (stop_at && insn_total >= stop_at && !x_written) {
        fprintf(logf, "X %u %llu %llu %016llx\n", vcpu,
                (unsigned long long)insn_total,
                (unsigned long long)s->samples,
                (unsigned long long)s->regs_all);
        fflush(logf);
        x_written = 1;
        /* stopflag arms the per-insn exit on the next insn */
        qemu_plugin_u64_set(stopflag, vcpu, 1);
    }
}

static void on_translate(struct qemu_plugin_tb *tb, void *ud)
{
    size_t n = qemu_plugin_tb_n_insns(tb);
    for (size_t i = 0; i < n; i++) {
        struct qemu_plugin_insn *insn = qemu_plugin_tb_get_insn(tb, i);
        /* executed-insn counter: inline add, no C call */
        qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu(
            insn, QEMU_PLUGIN_INLINE_ADD_U64, nexec, 1);
        /* sample point: conditional call, fires on counter >= period */
        qemu_plugin_register_vcpu_insn_exec_cond_cb(
            insn, on_sample, QEMU_PLUGIN_CB_R_REGS,
            QEMU_PLUGIN_COND_GE, nexec, period, NULL);
        if (stop_at) {
            /* per-insn inline check (no C call until armed) so the
             * stop lands one insn after the budget sample */
            qemu_plugin_register_vcpu_insn_exec_cond_cb(
                insn, on_stopcheck, QEMU_PLUGIN_CB_NO_REGS,
                QEMU_PLUGIN_COND_NE, stopflag, 0, NULL);
        }
    }
}

static void on_vcpu_init(unsigned int vcpu, void *ud)
{
    static const char *want[] = {
        "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10",
        "r11", "r12", "sp", "lr", "pc", "cpsr",
    };
    GArray *regs = qemu_plugin_get_registers();
    if (!regs) {
        fprintf(stderr, "lockstep: no register list\n");
        return;
    }
    for (guint i = 0; i < regs->len; i++) {
        qemu_plugin_reg_descriptor *d =
            &g_array_index(regs, qemu_plugin_reg_descriptor, i);
        if (probe_mode) {
            fprintf(stderr, "lockstep: reg[%u] %s\n", i, d->name);
        }
        if (n_regh >= (int)(sizeof want / sizeof want[0])) {
            continue;
        }
        if (strcmp(d->name, want[n_regh]) == 0) {
            regh[n_regh++] = d->handle;
        }
    }
    g_array_free(regs, TRUE);
    if (n_regh != (int)(sizeof want / sizeof want[0])) {
        fprintf(stderr, "lockstep: found only %d/%zu wanted registers "
                "(first missing: %s) — regs digest degraded\n",
                n_regh, sizeof want / sizeof want[0],
                want[n_regh < 0 ? 0 : n_regh]);
    }
}

static void plugin_atexit(void *ud)
{
    for (unsigned v = 0; v < MAX_VC; v++) {
        if (x_written) {
            break;
        }
        if (vs[v].samples == 0) {
            continue;
        }
        fprintf(logf, "X %u %llu %llu %016llx\n", v,
                (unsigned long long)(vs[v].samples * period),
                (unsigned long long)vs[v].samples,
                (unsigned long long)vs[v].regs_all);
    }
    fflush(logf);
    if (logf) {
        fclose(logf);
    }
}

static void parse_mem(const char *spec)
{
    char *dup = g_strdup(spec), *p = dup;
    while (p && *p && n_memr < MAX_MEM) {
        char *colon = strchr(p, ':');
        if (colon) {
            *colon = 0;
        }
        char *plus = strchr(p, '+');
        if (!plus) {
            fprintf(stderr, "lockstep: bad mem range: %s\n", p);
            exit(1);
        }
        *plus = 0;
        memr[n_memr].addr = strtoull(p, NULL, 16);
        memr[n_memr].len = strtoull(plus + 1, NULL, 16);
        if (!memr[n_memr].len) {
            fprintf(stderr, "lockstep: zero-length mem range: %s\n", p);
            exit(1);
        }
        n_memr++;
        p = colon ? colon + 1 : NULL;
    }
    g_free(dup);
}

static int ispow2(uint64_t x)
{
    return x && !(x & (x - 1));
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install(qemu_plugin_id_t id,
                                           const qemu_info_t *info,
                                           int argc, char **argv)
{
    const char *out_path = "/tmp/lockstep.log";

    for (int i = 0; i < argc; i++) {
        char *opt = argv[i];
        if (g_str_has_prefix(opt, "out=")) {
            out_path = opt + strlen("out=");
        } else if (g_str_has_prefix(opt, "period=")) {
            period = strtoull(opt + strlen("period="), NULL, 0);
        } else if (g_str_has_prefix(opt, "epoch=")) {
            epoch_insns = strtoull(opt + strlen("epoch="), NULL, 0);
        } else if (g_str_has_prefix(opt, "meminsns=")) {
            mem_insns = strtoull(opt + strlen("meminsns="), NULL, 0);
        } else if (g_str_has_prefix(opt, "mem=")) {
            parse_mem(opt + strlen("mem="));
        } else if (g_str_has_prefix(opt, "from=")) {
            tr_from = strtoull(opt + strlen("from="), NULL, 0);
        } else if (g_str_has_prefix(opt, "to=")) {
            tr_to = strtoull(opt + strlen("to="), NULL, 0);
        } else if (g_str_has_prefix(opt, "corrupt=")) {
            corrupt_at = strtoull(opt + strlen("corrupt="), NULL, 0);
        } else if (g_str_has_prefix(opt, "stop_at=")) {
            stop_at = strtoull(opt + strlen("stop_at="), NULL, 0);
        } else if (strcmp(opt, "probe") == 0 ||
                   g_str_has_prefix(opt, "probe=")) {
            probe_mode = strcmp(opt, "probe=off") != 0;
        } else {
            fprintf(stderr, "lockstep: unknown argument: %s\n", opt);
            return -1;
        }
    }
    if (tr_to > tr_from) {
        period = 1; /* dense mode: sample every insn */
    }
    if (!ispow2(period) || !ispow2(epoch_insns) || !ispow2(mem_insns) ||
        epoch_insns < period || mem_insns < epoch_insns) {
        fprintf(stderr, "lockstep: period/epoch/meminsns must be powers "
                "of two, period <= epoch <= meminsns\n");
        return -1;
    }
    if (!n_memr) {
        memr[0].addr = 0x800000;   /* pmb887x internal SRAM, 96k */
        memr[0].len = 0x18000;
        memr[1].addr = 0xa8000000; /* SDRAM via EBU CS1, 16M */
        memr[1].len = 0x1000000;
        n_memr = 2;
    }

    logf = fopen(out_path, "w");
    if (!logf) {
        fprintf(stderr, "lockstep: cannot open %s\n", out_path);
        return -1;
    }
    /* large buffer: T-lines are bulky; E/M lines are fflush'd anyway */
    static char iobuf[1 << 20];
    setvbuf(logf, iobuf, _IOFBF, sizeof iobuf);

    fprintf(logf, "C period=%llu epoch=%llu meminsns=%llu from=%llu to=%llu mem=",
            (unsigned long long)period, (unsigned long long)epoch_insns,
            (unsigned long long)mem_insns,
            (unsigned long long)tr_from, (unsigned long long)tr_to);
    for (int i = 0; i < n_memr; i++) {
        fprintf(logf, "%s%llx+%llx", i ? ":" : "",
                (unsigned long long)memr[i].addr,
                (unsigned long long)memr[i].len);
    }
    fputc('\n', logf);
    fflush(logf);

    regbuf = g_byte_array_sized_new(16);
    membuf = g_byte_array_sized_new(1 << 20);
    for (int v = 0; v < MAX_VC; v++) {
        vs[v].regs = FNV0;
        vs[v].regs_all = FNV0;
    }
    struct stop_score { uint64_t nexec; uint64_t stopflag; };
    score = qemu_plugin_scoreboard_new(sizeof(struct stop_score));
    nexec = qemu_plugin_scoreboard_u64_in_struct(score, struct stop_score, nexec);
    stopflag = qemu_plugin_scoreboard_u64_in_struct(score, struct stop_score, stopflag);

    qemu_plugin_register_vcpu_init_cb(id, on_vcpu_init, NULL);
    qemu_plugin_register_vcpu_tb_trans_cb(id, on_translate, NULL);
    qemu_plugin_register_atexit_cb(id, plugin_atexit, NULL);
    return 0;
}
