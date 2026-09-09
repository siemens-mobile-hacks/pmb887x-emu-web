/*
 * Tiny Code Generator for QEMU
 *
 * Copyright (c) 2018 SiFive, Inc
 * Copyright (c) 2008-2009 Arnaud Patard <arnaud.patard@rtp-net.org>
 * Copyright (c) 2009 Aurelien Jarno <aurelien@aurel32.net>
 * Copyright (c) 2008 Fabrice Bellard
 * Copyright (c) 2009, 2011 Stefan Weil
 *
 * Based on riscv/tcg-target.c.inc and tci/tcg-target.c
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

#include "../wasm32.h"
#include <emscripten.h>
#include <ffi.h>
#include "../tci/tci-emitters.h.inc"


static const int tcg_target_reg_alloc_order[TCG_TARGET_NB_REGS] = {
    TCG_REG_R0,
    TCG_REG_R1,
    TCG_REG_R2,
    TCG_REG_R3,
    TCG_REG_R4,
    TCG_REG_R5,
    TCG_REG_R6,
    TCG_REG_R7,
    TCG_REG_R8,
    TCG_REG_R9,
    TCG_REG_R10,
    TCG_REG_R11,
    TCG_REG_R12,
    TCG_REG_R13,
    TCG_REG_R14,
    TCG_REG_R15,
};

#define NUM_OF_IARG_REGS 5
static const int tcg_target_call_iarg_regs[NUM_OF_IARG_REGS] = {
   TCG_REG_R8,
   TCG_REG_R9,
   TCG_REG_R10,
   TCG_REG_R11,
   TCG_REG_R12,
};

static TCGReg tcg_target_call_oarg_reg(TCGCallReturnKind kind, int slot)
{
    tcg_debug_assert(kind == TCG_CALL_RET_NORMAL);
    tcg_debug_assert(slot >= 0 && slot < 128 / TCG_TARGET_REG_BITS);
    return TCG_REG_R0 + slot;
}

#ifdef CONFIG_DEBUG_TCG
static const char *const tcg_target_reg_names[TCG_TARGET_NB_REGS] = {
    "r00",
    "r01",
    "r02",
    "r03",
    "r04",
    "r05",
    "r06",
    "r07",
    "r08",
    "r09",
    "r10",
    "r11",
    "r12",
    "r13",
    "r14",
    "r15",
};
#endif

#define REG_INDEX_IARG_BASE 8
static const uint8_t tcg_target_reg_index[TCG_TARGET_NB_REGS] = {
    0, // TCG_REG_R0
    1, // TCG_REG_R1
    2, // TCG_REG_R2
    3, // TCG_REG_R3
    4, // TCG_REG_R4
    5, // TCG_REG_R5
    6, // TCG_REG_R6
    7, // TCG_REG_R7
    8, // TCG_REG_R8
    9, // TCG_REG_R9
    10, // TCG_REG_R10
    11, // TCG_REG_R11
    12, // TCG_REG_R12
    13, // TCG_REG_R13
    14, // TCG_REG_R14
    15, // TCG_REG_R15
};

#define BLOCK_PTR_IDX 16

#define CTX_IDX 0
#define TMP32_LOCAL_ENV_IDX 1
#define TMP32_LOCAL_0_IDX 2
#define TMP64_0_IDX 3
#define TMP64_1_IDX 4
#define TMP64_2_IDX 5
#define TMP64_3_IDX 6
#define TMP64_4_IDX 7

__thread bool env_cached = false;

// function index
#define RETURN_CALL_IDX 0
#define FUNC_HELPER_CALL_IDX 1
#define FUNC_CALL_LD_HELPER_IDX 2
#define FUNC_CALL_ST_HELPER_IDX 3

// table index
#define HELPER_TABLE_IDX 0

static inline void tcg_wasm_out8(TCGContext *s, uint32_t v)
{
    tcg_sub_out8(s, v);
}

static uintptr_t cur_wasm_ptr(TCGContext *s)
{
    return (uintptr_t)cur_sub_buf_ptr();
}

static void tcg_wasm_out_leb128_sint32_t(TCGContext *s, int32_t v) {
    bool more = true;
    bool negative = (v < 0);
    uint8_t b;
    uint32_t low7 = 0x7f;
    uint32_t uv = v;
    while (more) {
        b = uv & low7;
        uv >>= 7;
        if (negative)
            uv |= (~0 << (32 - 7));
        if (((uv == 0) && ((b & 0x40) == 0)) || ((uv == -1) && ((b & 0x40) != 0)))
            more = false;
        else
            b |= 0x80;
        tcg_wasm_out8(s, b);
    }
}

static void tcg_wasm_out_leb128_sint64_t(TCGContext *s, int64_t v) {
    bool more = true;
    bool negative = (v < 0);
    uint8_t b;
    uint64_t low7 = 0x7f;
    uint64_t uv = v;
    while (more) {
        b = uv & low7;
        uv >>= 7;
        if (negative)
            uv |= ((int64_t)(~0) << (64 - 7));
        if (((uv == 0) && ((b & 0x40) == 0)) || (((int64_t)uv == -1) && ((b & 0x40) != 0)))
            more = false;
        else
            b |= 0x80;
        tcg_wasm_out8(s, b);
    }
}

static void tcg_wasm_out_leb128_uint32_t(TCGContext *s, uint32_t v) {
    uint32_t low7 = 0x7f;
    uint8_t b;
    do {
        b = v & low7;
        v >>= 7;
        if (v != 0)
            b |= 0x80;
        tcg_wasm_out8(s, b);
    } while (v != 0);
}

static void tcg_wasm_out_op_br(TCGContext *s, int i)
{
    tcg_wasm_out8(s, 0x0c);
    tcg_wasm_out8(s, i);
}

static void tcg_wasm_out_op_if_noret(TCGContext *s)
{
    tcg_wasm_out8(s, 0x04);
    tcg_wasm_out8(s, 0x40);
}

static void tcg_wasm_out_op_if_ret_i64(TCGContext *s)
{
    tcg_wasm_out8(s, 0x04);
    tcg_wasm_out8(s, 0x7e);
}

static void tcg_wasm_out_op_if_ret_i32(TCGContext *s)
{
    tcg_wasm_out8(s, 0x04);
    tcg_wasm_out8(s, 0x7f);
}

static void tcg_wasm_out_op_else(TCGContext *s)
{
    tcg_wasm_out8(s, 0x05);
}

static void tcg_wasm_out_op_end(TCGContext *s)
{
    tcg_wasm_out8(s, 0x0b);
}

static void tcg_wasm_out_op_i32_eqz(TCGContext *s){ tcg_wasm_out8(s, 0x45); }
static void tcg_wasm_out_op_i32_eq(TCGContext *s){ tcg_wasm_out8(s, 0x46); }
static void tcg_wasm_out_op_i32_and(TCGContext *s){ tcg_wasm_out8(s, 0x71); }
static void tcg_wasm_out_op_i32_or(TCGContext *s){ tcg_wasm_out8(s, 0x72); }
//static void tcg_wasm_out_op_i32_xor(TCGContext *s){ tcg_wasm_out8(s, 0x73); }
static void tcg_wasm_out_op_i32_shl(TCGContext *s){ tcg_wasm_out8(s, 0x74); }
static void tcg_wasm_out_op_i32_shr_s(TCGContext *s){ tcg_wasm_out8(s, 0x75); }
static void tcg_wasm_out_op_i32_shr_u(TCGContext *s){ tcg_wasm_out8(s, 0x76); }
static void tcg_wasm_out_op_i32_rotl(TCGContext *s){ tcg_wasm_out8(s, 0x77); }
static void tcg_wasm_out_op_i32_rotr(TCGContext *s){ tcg_wasm_out8(s, 0x78); }
static void tcg_wasm_out_op_i32_clz(TCGContext *s){ tcg_wasm_out8(s, 0x67); }
static void tcg_wasm_out_op_i32_ctz(TCGContext *s){ tcg_wasm_out8(s, 0x68); }
static void tcg_wasm_out_op_i32_popcnt(TCGContext *s){ tcg_wasm_out8(s, 0x69); }
static void tcg_wasm_out_op_i32_add(TCGContext *s){ tcg_wasm_out8(s, 0x6a); }
//static void tcg_wasm_out_op_i32_sub(TCGContext *s){ tcg_wasm_out8(s, 0x6b); }
//static void tcg_wasm_out_op_i32_mul(TCGContext *s){ tcg_wasm_out8(s, 0x6c); }
//static void tcg_wasm_out_op_i32_div_s(TCGContext *s){ tcg_wasm_out8(s, 0x6d); }
//static void tcg_wasm_out_op_i32_div_u(TCGContext *s){ tcg_wasm_out8(s, 0x6e); }
//static void tcg_wasm_out_op_i32_rem_s(TCGContext *s){ tcg_wasm_out8(s, 0x6f); }
//static void tcg_wasm_out_op_i32_rem_u(TCGContext *s){ tcg_wasm_out8(s, 0x70); }
static void tcg_wasm_out_op_i32_ne(TCGContext *s){ tcg_wasm_out8(s, 0x47); }
//static void tcg_wasm_out_op_i32_le_u(TCGContext *s){ tcg_wasm_out8(s, 0x4d); }

static void tcg_wasm_out_op_i64_eqz(TCGContext *s){ tcg_wasm_out8(s, 0x50); }
static void tcg_wasm_out_op_i64_eq(TCGContext *s){ tcg_wasm_out8(s, 0x51); }
static void tcg_wasm_out_op_i64_and(TCGContext *s){ tcg_wasm_out8(s, 0x83); }
static void tcg_wasm_out_op_i64_or(TCGContext *s){ tcg_wasm_out8(s, 0x84); }
static void tcg_wasm_out_op_i64_xor(TCGContext *s){ tcg_wasm_out8(s, 0x85); }
static void tcg_wasm_out_op_i64_shl(TCGContext *s){ tcg_wasm_out8(s, 0x86); }
static void tcg_wasm_out_op_i64_shr_s(TCGContext *s){ tcg_wasm_out8(s, 0x87); }
static void tcg_wasm_out_op_i64_shr_u(TCGContext *s){ tcg_wasm_out8(s, 0x88); }
static void tcg_wasm_out_op_i64_rotl(TCGContext *s){ tcg_wasm_out8(s, 0x89); }
static void tcg_wasm_out_op_i64_rotr(TCGContext *s){ tcg_wasm_out8(s, 0x8a); }
static void tcg_wasm_out_op_i64_clz(TCGContext *s){ tcg_wasm_out8(s, 0x79); }
static void tcg_wasm_out_op_i64_ctz(TCGContext *s){ tcg_wasm_out8(s, 0x7a); }
static void tcg_wasm_out_op_i64_popcnt(TCGContext *s){ tcg_wasm_out8(s, 0x7b); }
static void tcg_wasm_out_op_i64_add(TCGContext *s){ tcg_wasm_out8(s, 0x7c); }
static void tcg_wasm_out_op_i64_sub(TCGContext *s){ tcg_wasm_out8(s, 0x7d); }
static void tcg_wasm_out_op_i64_mul(TCGContext *s){ tcg_wasm_out8(s, 0x7e); }
static void tcg_wasm_out_op_i64_div_s(TCGContext *s){ tcg_wasm_out8(s, 0x7f); }
static void tcg_wasm_out_op_i64_div_u(TCGContext *s){ tcg_wasm_out8(s, 0x80); }
static void tcg_wasm_out_op_i64_rem_s(TCGContext *s){ tcg_wasm_out8(s, 0x81); }
static void tcg_wasm_out_op_i64_rem_u(TCGContext *s){ tcg_wasm_out8(s, 0x82); }
//static void tcg_wasm_out_op_i64_ne(TCGContext *s){ tcg_wasm_out8(s, 0x52); }
static void tcg_wasm_out_op_i64_le_u(TCGContext *s){ tcg_wasm_out8(s, 0x58); }
static void tcg_wasm_out_op_i64_lt_u(TCGContext *s){ tcg_wasm_out8(s, 0x54); }
static void tcg_wasm_out_op_i64_gt_u(TCGContext *s){ tcg_wasm_out8(s, 0x56); }

static void tcg_wasm_out_op_i32_wrap_i64(TCGContext *s){ tcg_wasm_out8(s, 0xa7); }

static void tcg_wasm_out_op_var(TCGContext *s, uint8_t instr, uint8_t i)
{
    tcg_wasm_out8(s, instr);
    tcg_wasm_out8(s, i);
}

static void tcg_wasm_out_op_local_get(TCGContext *s, uint8_t i)
{
    tcg_wasm_out_op_var(s, 0x20, i);
}

static void tcg_wasm_out_op_local_set(TCGContext *s, uint8_t i)
{
    tcg_wasm_out_op_var(s, 0x21, i);
}

static void tcg_wasm_out_op_local_tee(TCGContext *s, uint8_t i)
{
    tcg_wasm_out_op_var(s, 0x22, i);
}

static void tcg_wasm_out_op_global_get(TCGContext *s, uint8_t i)
{
    tcg_wasm_out_op_var(s, 0x23, i);
}

static void tcg_wasm_out_op_global_set(TCGContext *s, uint8_t i)
{
    if (i == tcg_target_reg_index[TCG_REG_R14]) {
        env_cached = false;
    }
    tcg_wasm_out_op_var(s, 0x24, i);
}

static void tcg_wasm_out_op_global_get_r_i32(TCGContext *s, TCGReg r0)
{
    if (r0 == TCG_REG_R14) {
        if (!env_cached) {
            tcg_wasm_out_op_global_get(s, tcg_target_reg_index[r0]);
            tcg_wasm_out_op_i32_wrap_i64(s);
            tcg_wasm_out_op_local_tee(s, TMP32_LOCAL_ENV_IDX);
            env_cached = true;
        } else {
            tcg_wasm_out_op_local_get(s, TMP32_LOCAL_ENV_IDX);
        }
        return;
    }
    tcg_wasm_out_op_global_get(s, tcg_target_reg_index[r0]);
    tcg_wasm_out_op_i32_wrap_i64(s);
}

static void tcg_wasm_out_op_global_get_r(TCGContext *s, TCGReg r0)
{
    tcg_wasm_out_op_global_get(s, tcg_target_reg_index[r0]);
}

static void tcg_wasm_out_op_global_set_r(TCGContext *s, TCGReg r0)
{
    tcg_wasm_out_op_global_set(s, tcg_target_reg_index[r0]);
}

static void tcg_wasm_out_op_i32_const(TCGContext *s, int32_t v)
{
    tcg_wasm_out8(s, 0x41);
    tcg_wasm_out_leb128_sint32_t(s, v);
}

static void tcg_wasm_out_op_i64_const(TCGContext *s, int64_t v)
{
    tcg_wasm_out8(s, 0x42);
    tcg_wasm_out_leb128_sint64_t(s, v);
}

static void tcg_wasm_out_op_loadstore(TCGContext *s, uint8_t instr, uint32_t a, uint32_t o)
{
    tcg_wasm_out8(s, instr);
    tcg_wasm_out_leb128_uint32_t(s, a);
    tcg_wasm_out_leb128_uint32_t(s, o);
}

static void tcg_wasm_out_op_i64_store(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x37, a, o);
}

static void tcg_wasm_out_op_i32_store(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x36, a, o);
}

static void tcg_wasm_out_op_i64_store8(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x3c, a, o);
}
    
static void tcg_wasm_out_op_i64_store16(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x3d, a, o);
}

static void tcg_wasm_out_op_i64_store32(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x3e, a, o);
}

static void tcg_wasm_out_op_i64_load(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x29, a, o);
}

static void tcg_wasm_out_op_i32_load(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x28, a, o);
}

 static void tcg_wasm_out_op_i64_load8_s(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x30, a, o);
}

static void tcg_wasm_out_op_i64_load8_u(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x31, a, o);
}

static void tcg_wasm_out_op_i64_load16_s(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x32, a, o);
}

static void tcg_wasm_out_op_i64_load16_u(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x33, a, o);
}

static void tcg_wasm_out_op_i64_load32_u(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x35, a, o);
}

static void tcg_wasm_out_op_i64_load32_s(TCGContext *s, uint32_t a, uint32_t o)
{
    tcg_wasm_out_op_loadstore(s, 0x34, a, o);
}

static void tcg_wasm_out_op_return(TCGContext *s)
{
    tcg_wasm_out8(s, 0x0f);
}

static void tcg_wasm_out_op_call(TCGContext *s, uint32_t func_idx)
{
    tcg_wasm_out8(s, 0x10);
    tcg_wasm_out_leb128_uint32_t(s, func_idx);
}

static void tcg_wasm_out_op_i64_extend_i32_u(TCGContext *s)
{
    tcg_wasm_out8(s, 0xad);
}

static void tcg_wasm_out_op_i64_extend_i32_s(TCGContext *s)
{
    tcg_wasm_out8(s, 0xac);
}

static void tcg_wasm_out_op_i64_extend8_s(TCGContext *s)
{
    tcg_wasm_out8(s, 0xc2);
}

static void tcg_wasm_out_op_i64_extend16_s(TCGContext *s)
{
    tcg_wasm_out8(s, 0xc3);
}

static void tcg_wasm_out_op_not(TCGContext *s){
    tcg_wasm_out_op_i64_const(s, -1);
    tcg_wasm_out_op_i64_xor(s);
}

static void tcg_wasm_out_op_set_r_as_i64(TCGContext *s, TCGReg al, TCGReg ah)
{
    tcg_wasm_out_op_local_set(s, TMP64_4_IDX);

    // set lower bits
    tcg_wasm_out_op_local_get(s, TMP64_4_IDX);
    tcg_wasm_out_op_i64_const(s, 0xffffffff);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_global_set_r(s, al);

    // set higher bits
    tcg_wasm_out_op_local_get(s, TMP64_4_IDX);
    tcg_wasm_out_op_i64_const(s, 32);
    tcg_wasm_out_op_i64_shr_u(s);
    tcg_wasm_out_op_i64_const(s, 0xffffffff);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_global_set_r(s, ah);
}

static const struct {
    uint8_t i32;
    uint8_t i64;
} tcg_cond_to_inst[] = {
    [TCG_COND_EQ] =  { 0x46 /* i32.eq */   , 0x51 /* i64.eq */},
    [TCG_COND_NE] =  { 0x47 /* i32.ne */   , 0x52 /* i64.ne */},
    [TCG_COND_LT] =  { 0x48 /* i32.lt_s */ , 0x53 /* i64.lt_s */},
    [TCG_COND_GE] =  { 0x4e /* i32.ge_s */ , 0x59 /* i64.ge_s */},
    [TCG_COND_LE] =  { 0x4c /* i32.le_s */ , 0x57 /* i64.le_s */},
    [TCG_COND_GT] =  { 0x4a /* i32.gt_s */ , 0x55 /* i64.gt_s */},
    [TCG_COND_LTU] = { 0x49 /* i32.lt_u */ , 0x54 /* i64.lt_u */},
    [TCG_COND_GEU] = { 0x4f /* i32.ge_u */ , 0x5a /* i64.ge_u */},
    [TCG_COND_LEU] = { 0x4d /* i32.le_u */ , 0x58 /* i64.le_u */},
    [TCG_COND_GTU] = { 0x4b /* i32.gt_u */ , 0x56 /* i64.gt_u */}
};

static void tcg_wasm_out_op_cond_i64(TCGContext *s, TCGCond cond, TCGReg arg1, TCGReg arg2)
{
    uint8_t op = tcg_cond_to_inst[cond].i64;
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out8(s, op);
}

static void tcg_wasm_out_op_cond_i32(TCGContext *s, TCGCond cond, TCGReg arg1, TCGReg arg2)
{
    uint8_t op = tcg_cond_to_inst[cond].i32;
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out8(s, op);
}

#define tcg_wasm_out_i64_calc(op)                                            \
    static void tcg_wasm_out_i64_calc_##op(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){ \
        tcg_wasm_out_op_global_get_r(s, arg1);                               \
        tcg_wasm_out_op_global_get_r(s, arg2);                               \
        tcg_wasm_out_op_i64_##op(s);                                         \
        tcg_wasm_out_op_global_set_r(s, ret);                                \
    }
tcg_wasm_out_i64_calc(and);
tcg_wasm_out_i64_calc(or);
tcg_wasm_out_i64_calc(xor);
tcg_wasm_out_i64_calc(shl);
tcg_wasm_out_i64_calc(shr_s);
tcg_wasm_out_i64_calc(shr_u);
tcg_wasm_out_i64_calc(rotl);
tcg_wasm_out_i64_calc(rotr);
tcg_wasm_out_i64_calc(add);
tcg_wasm_out_i64_calc(sub);
tcg_wasm_out_i64_calc(mul);
tcg_wasm_out_i64_calc(div_s);
tcg_wasm_out_i64_calc(div_u);
tcg_wasm_out_i64_calc(rem_s);
tcg_wasm_out_i64_calc(rem_u);

static void tcg_wasm_out_rem_s(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2) {
    switch (type) {
    case TCG_TYPE_I32:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_extend_i32_s(s);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_extend_i32_s(s);
        tcg_wasm_out_op_i64_rem_s(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_rem_s(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_rem_u(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2) {
    switch (type) {
    case TCG_TYPE_I32:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_i64_const(s, 0xffffffff);
        tcg_wasm_out_op_i64_and(s);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_const(s, 0xffffffff);
        tcg_wasm_out_op_i64_and(s);
        tcg_wasm_out_op_i64_rem_u(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_rem_u(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_div_s(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2) {
    switch (type) {
    case TCG_TYPE_I32:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_extend_i32_s(s);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_extend_i32_s(s);
        tcg_wasm_out_op_i64_div_s(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_div_s(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_div_u(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2) {
    switch (type) {
    case TCG_TYPE_I32:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_i64_const(s, 0xffffffff);
        tcg_wasm_out_op_i64_and(s);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_const(s, 0xffffffff);
        tcg_wasm_out_op_i64_and(s);
        tcg_wasm_out_op_i64_div_u(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_div_u(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_shl(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2){
    switch (type) {
    case TCG_TYPE_I32:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_i64_const(s, 0xffffffff);
        tcg_wasm_out_op_i64_and(s);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_const(s, 31);
        tcg_wasm_out_op_i64_and(s);
        tcg_wasm_out_op_i64_shl(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_shl(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_shr_u(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2){
    switch (type) {
    case TCG_TYPE_I32:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_i64_const(s, 0xffffffff);
        tcg_wasm_out_op_i64_and(s);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_const(s, 31);
        tcg_wasm_out_op_i64_and(s);
        tcg_wasm_out_op_i64_shr_u(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_shr_u(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_shr_s(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2){
    switch (type) {
    case TCG_TYPE_I32:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_extend_i32_s(s);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_const(s, 31);
        tcg_wasm_out_op_i64_and(s);
        tcg_wasm_out_op_i64_shr_s(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_global_get_r(s, arg2);
        tcg_wasm_out_op_i64_shr_s(s);
        tcg_wasm_out_op_global_set_r(s, ret);
        break;
    default:
        g_assert_not_reached();
    }
}
static void tcg_wasm_out_i32_rotl(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_i32_rotl(s);
    tcg_wasm_out_op_i64_extend_i32_s(s);
    tcg_wasm_out_op_global_set_r(s, ret); 
}

static void tcg_wasm_out_i32_rotr(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_i32_rotr(s);
    tcg_wasm_out_op_i64_extend_i32_s(s);
    tcg_wasm_out_op_global_set_r(s, ret); 
}

static void tcg_wasm_out_clz64(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i64_eqz(s);
    tcg_wasm_out_op_if_ret_i64(s);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_else(s);
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i64_clz(s);
    tcg_wasm_out_op_end(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_clz32(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i64_eqz(s);
    tcg_wasm_out_op_if_ret_i32(s);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_else(s);
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_i32_clz(s);
    tcg_wasm_out_op_end(s);
    tcg_wasm_out_op_i64_extend_i32_s(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_ctz64(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i64_eqz(s);
    tcg_wasm_out_op_if_ret_i64(s);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_else(s);
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i64_ctz(s);
    tcg_wasm_out_op_end(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_ctz32(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i64_eqz(s);
    tcg_wasm_out_op_if_ret_i32(s);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_else(s);
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_i32_ctz(s);
    tcg_wasm_out_op_end(s);
    tcg_wasm_out_op_i64_extend_i32_s(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_not(TCGContext *s, TCGReg ret, TCGReg arg){
    tcg_wasm_out_op_global_get_r(s, arg);
    tcg_wasm_out_op_not(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_andc(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_not(s);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_orc(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_not(s);
    tcg_wasm_out_op_i64_or(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_eqv(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_xor(s);
    tcg_wasm_out_op_not(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_nand(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_not(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_nor(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2){
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_or(s);
    tcg_wasm_out_op_not(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_neg(TCGContext *s, TCGReg ret, TCGReg arg){
    tcg_wasm_out_op_global_get_r(s, arg);
    tcg_wasm_out_op_not(s);
    tcg_wasm_out_op_i64_const(s, 1);
    tcg_wasm_out_op_i64_add(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_ld(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_i64_load32_u(s, 0, (uint32_t)offset);
        tcg_wasm_out_op_global_set_r(s, val);
        break;
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_i64_load(s, 0, (uint32_t)offset);
        tcg_wasm_out_op_global_set_r(s, val);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_ld8s(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_i64_load8_s(s, 0, (uint32_t)offset);
        tcg_wasm_out_op_global_set_r(s, val);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_ld8u(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_i64_load8_u(s, 0, (uint32_t)offset);
        tcg_wasm_out_op_global_set_r(s, val);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_ld16s(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_i64_load16_s(s, 0, (uint32_t)offset);
        tcg_wasm_out_op_global_set_r(s, val);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_ld16u(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_i64_load16_u(s, 0, (uint32_t)offset);
        tcg_wasm_out_op_global_set_r(s, val);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_ld32s(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_i64_load32_s(s, 0, (uint32_t)offset);
        tcg_wasm_out_op_global_set_r(s, val);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_ld32u(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_i64_load32_u(s, 0, (uint32_t)offset);
        tcg_wasm_out_op_global_set_r(s, val);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_st(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_global_get_r(s, val);
        tcg_wasm_out_op_i64_store32(s, 0, (uint32_t)offset);
        break;
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_global_get_r(s, val);
        tcg_wasm_out_op_i64_store(s, 0, (uint32_t)offset);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_st8(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_global_get_r(s, val);
        tcg_wasm_out_op_i64_store8(s, 0, (uint32_t)offset);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_st16(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_global_get_r(s, val);
        tcg_wasm_out_op_i64_store16(s, 0, (uint32_t)offset);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_st32(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r_i32(s, base);
        if ((int32_t)offset < 0) {
            tcg_wasm_out_op_i32_const(s, (int32_t)offset);
            tcg_wasm_out_op_i32_add(s);
            offset = 0;
        }
        tcg_wasm_out_op_global_get_r(s, val);
        tcg_wasm_out_op_i64_store32(s, 0, (uint32_t)offset);
        break;
    default:
        g_assert_not_reached();
    }
}

static inline bool tcg_wasm_out_sti(TCGContext *s, TCGType type, TCGArg val,
                               TCGReg base, intptr_t offset)
{
    return false;
}

static bool tcg_wasm_out_mov(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg)
{
   switch (type) {
   case TCG_TYPE_I32:
       tcg_wasm_out_op_global_get_r(s, arg);
       tcg_wasm_out_op_i32_wrap_i64(s);
       tcg_wasm_out_op_i64_extend_i32_u(s);
       tcg_wasm_out_op_global_set_r(s, ret);
       break;
   case TCG_TYPE_I64:
       tcg_wasm_out_op_global_get_r(s, arg);
       tcg_wasm_out_op_global_set_r(s, ret);
       break;
   default:
       g_assert_not_reached();
   }
    return true;
}

static void tcg_wasm_out_movi(TCGContext *s, TCGType type,
                        TCGReg ret, tcg_target_long arg)
{
   switch (type) {
   case TCG_TYPE_I32:
       tcg_wasm_out_op_i64_const(s, (int32_t)arg);
       break;
   case TCG_TYPE_I64:
       tcg_wasm_out_op_i64_const(s, arg);
       break;
   default:
       g_assert_not_reached();
   }
   tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_ext8s(TCGContext *s, TCGType type, TCGReg rd, TCGReg rs)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r(s, rs);
        tcg_wasm_out_op_i64_extend8_s(s);
        tcg_wasm_out_op_global_set_r(s, rd);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_ext8u(TCGContext *s, TCGReg rd, TCGReg rs)
{
    tcg_wasm_out_op_global_get_r(s, rs);
    tcg_wasm_out_op_i64_const(s, 0xff);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_global_set_r(s, rd);
}

static void tcg_wasm_out_ext16s(TCGContext *s, TCGType type, TCGReg rd, TCGReg rs)
{
    switch (type) {
    case TCG_TYPE_I32:
    case TCG_TYPE_I64:
        tcg_wasm_out_op_global_get_r(s, rs);
        tcg_wasm_out_op_i64_extend16_s(s);
        tcg_wasm_out_op_global_set_r(s, rd);
        break;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_ext16u(TCGContext *s, TCGReg rd, TCGReg rs)
{
    tcg_wasm_out_op_global_get_r(s, rs);
    tcg_wasm_out_op_i64_const(s, 0xffff);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_global_set_r(s, rd);
}

static void tcg_wasm_out_ext32s(TCGContext *s, TCGReg rd, TCGReg rs)
{
    tcg_wasm_out_op_global_get_r(s, rs);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_i64_extend_i32_s(s);
    tcg_wasm_out_op_global_set_r(s, rd);
}

static void tcg_wasm_out_ext32u(TCGContext *s, TCGReg rd, TCGReg rs)
{
    tcg_wasm_out_op_global_get_r(s, rs);
    tcg_wasm_out_op_i64_const(s, 0xffffffff);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_global_set_r(s, rd);
}

static void tcg_wasm_out_exts_i32_i64(TCGContext *s, TCGReg rd, TCGReg rs)
{
    tcg_wasm_out_ext32s(s, rd, rs);
}

static void tcg_wasm_out_extu_i32_i64(TCGContext *s, TCGReg rd, TCGReg rs)
{
    tcg_wasm_out_ext32u(s, rd, rs);
}

static void tcg_wasm_out_extrl_i64_i32(TCGContext *s, TCGReg rd, TCGReg rs)
{
    tcg_wasm_out_op_global_get_r(s, rs);
    tcg_wasm_out_op_i64_const(s, 0xffffffff);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_global_set_r(s, rd);
}

static void tcg_wasm_out_extrh_i64_i32(TCGContext *s, TCGReg rd, TCGReg rs)
{
    tcg_wasm_out_op_global_get_r(s, rs);
    tcg_wasm_out_op_i64_const(s, 32);
    tcg_wasm_out_op_i64_shr_u(s);
    tcg_wasm_out_op_global_set_r(s, rd);
}

static void tcg_wasm_out_setcond_i32(TCGContext *s, TCGCond cond, TCGReg ret,
                            TCGReg arg1, TCGReg arg2)
{
    tcg_wasm_out_op_cond_i32(s, cond, arg1, arg2);
    tcg_wasm_out_op_i64_extend_i32_u(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_setcond_i64(TCGContext *s, TCGCond cond, TCGReg ret,
                            TCGReg arg1, TCGReg arg2)
{
    tcg_wasm_out_op_cond_i64(s, cond, arg1, arg2);
    tcg_wasm_out_op_i64_extend_i32_u(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_movcond_i32(TCGContext *s, TCGCond cond, TCGReg ret,
                            TCGReg c1, TCGReg c2, TCGReg v1, TCGReg v2)
{
    tcg_wasm_out_op_cond_i32(s, cond, c1, c2);
    tcg_wasm_out_op_if_ret_i64(s);
    tcg_wasm_out_op_global_get_r(s, v1);
    tcg_wasm_out_op_else(s);
    tcg_wasm_out_op_global_get_r(s, v2);
    tcg_wasm_out_op_end(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_movcond_i64(TCGContext *s, TCGCond cond, TCGReg ret,
                            TCGReg c1, TCGReg c2, TCGReg v1, TCGReg v2)
{
    tcg_wasm_out_op_cond_i64(s, cond, c1, c2);
    tcg_wasm_out_op_if_ret_i64(s);
    tcg_wasm_out_op_global_get_r(s, v1);
    tcg_wasm_out_op_else(s);
    tcg_wasm_out_op_global_get_r(s, v2);
    tcg_wasm_out_op_end(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_add2(TCGContext *s, TCGReg retl, TCGReg reth,
                             TCGReg al, TCGReg ah, TCGReg bl, TCGReg bh)
{
    // add higer
    tcg_wasm_out_op_global_get_r(s, ah);
    tcg_wasm_out_op_global_get_r(s, bh);
    tcg_wasm_out_op_i64_add(s);

    // add lower
    tcg_wasm_out_op_global_get_r(s, al);
    tcg_wasm_out_op_global_get_r(s, bl);
    tcg_wasm_out_op_i64_add(s);

    // get carry
    if ((al == retl) && (bl == retl)) {
        tcg_wasm_out_op_local_set(s, TMP64_0_IDX);
        tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
        tcg_wasm_out_op_global_get_r(s, al);
        tcg_wasm_out_op_i64_lt_u(s);
        tcg_wasm_out_op_i64_extend_i32_s(s);
        tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
        tcg_wasm_out_op_global_set_r(s, retl);
    } else {
        tcg_wasm_out_op_global_set_r(s, retl);
        tcg_wasm_out_op_global_get_r(s, retl);
        if (al == retl) {
            tcg_wasm_out_op_global_get_r(s, bl);
        } else {
            tcg_wasm_out_op_global_get_r(s, al);
        }
        tcg_wasm_out_op_i64_lt_u(s);
        tcg_wasm_out_op_i64_extend_i32_s(s);
    }

    // add carry to higher
    tcg_wasm_out_op_i64_add(s);
    tcg_wasm_out_op_global_set_r(s, reth);
}

static void tcg_wasm_out_sub2(TCGContext *s, TCGReg retl, TCGReg reth,
                             TCGReg al, TCGReg ah, TCGReg bl, TCGReg bh)
{
    // sub higher
    tcg_wasm_out_op_global_get_r(s, ah);
    tcg_wasm_out_op_global_get_r(s, bh);
    tcg_wasm_out_op_i64_sub(s);

    // sub lower
    tcg_wasm_out_op_global_get_r(s, al);
    tcg_wasm_out_op_global_get_r(s, bl);
    tcg_wasm_out_op_i64_sub(s);

    // get underflow
    if (al == retl) {
        tcg_wasm_out_op_local_set(s, TMP64_0_IDX);

        tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
        tcg_wasm_out_op_global_get_r(s, al);
        tcg_wasm_out_op_i64_gt_u(s);

        tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
        tcg_wasm_out_op_global_set_r(s, retl);
    } else {
        tcg_wasm_out_op_global_set_r(s, retl);

        tcg_wasm_out_op_global_get_r(s, retl);
        tcg_wasm_out_op_global_get_r(s, al);
        tcg_wasm_out_op_i64_gt_u(s);
    }

    tcg_wasm_out_op_i64_sub(s);
    tcg_wasm_out_op_global_set_r(s, reth);
}

static void tcg_wasm_out_mulu2_i32(TCGContext *s, TCGReg retl, TCGReg reth, TCGReg arg1, TCGReg arg2)
{
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_mul(s);
    tcg_wasm_out_op_set_r_as_i64(s, retl, reth);
}

static void tcg_wasm_out_muls2_i32(TCGContext *s, TCGReg retl, TCGReg reth, TCGReg arg1, TCGReg arg2)
{
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_mul(s);
    tcg_wasm_out_op_set_r_as_i64(s, retl, reth);
}

static void tcg_wasm_out_muluh_i32(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_mul(s);
    tcg_wasm_out_op_i64_const(s, 32);
    tcg_wasm_out_op_i64_shr_u(s);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_mulsh_i32(TCGContext *s, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_mul(s);
    tcg_wasm_out_op_i64_const(s, 32);
    tcg_wasm_out_op_i64_shr_u(s);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_global_set_r(s, ret);
}

static void tcg_wasm_out_ctpop_i32(TCGContext *s, TCGReg dest, TCGReg src)
{
    tcg_wasm_out_op_global_get_r(s, src);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_i32_popcnt(s);
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_ctpop_i64(TCGContext *s, TCGReg dest, TCGReg src)
{
    tcg_wasm_out_op_global_get_r(s, src);
    tcg_wasm_out_op_i64_popcnt(s);
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_deposit_i32(TCGContext *s, TCGReg dest, TCGReg arg1, TCGReg arg2, int pos, int len)
{
    int32_t mask = ((1<<len)-1)<<pos;
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_i32_const(s, ~mask);
    tcg_wasm_out_op_i32_and(s);

    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_i32_const(s, pos);
    tcg_wasm_out_op_i32_shl(s);
    tcg_wasm_out_op_i32_const(s, mask);
    tcg_wasm_out_op_i32_and(s);

    tcg_wasm_out_op_i32_or(s);

    tcg_wasm_out_op_i64_extend_i32_u(s);
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_deposit_i64(TCGContext *s, TCGReg dest, TCGReg arg1, TCGReg arg2, int pos, int len)
{
    int64_t mask = (((int64_t)1<<len)-1)<<pos;
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i64_const(s, ~mask);
    tcg_wasm_out_op_i64_and(s);

    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_const(s, pos);
    tcg_wasm_out_op_i64_shl(s);
    tcg_wasm_out_op_i64_const(s, mask);
    tcg_wasm_out_op_i64_and(s);

    tcg_wasm_out_op_i64_or(s);
    
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_extract(TCGContext *s, TCGReg dest, TCGReg arg1, int pos, int len, TCGType type, bool sign)
{
    /*
     * NOTE: the upstream (ktock) version performed the extract with i64
     * shifts even for TCG_TYPE_I32; for len < 32 that is an identity for
     * any 32-bit value ((x << (32-len)) >> (32-len) == x when x < 2^32),
     * so e.g. gen_bx's "thumb = val & 1" extracted the whole register.
     * Extract i32 values with real i32 ops instead.
     */
    if (type == TCG_TYPE_I32) {
        int sl = 32 - len - pos;
        tcg_wasm_out_op_global_get_r(s, arg1);
        tcg_wasm_out_op_i32_wrap_i64(s);
        if (sl > 0) {
            tcg_wasm_out_op_i32_const(s, sl);
            tcg_wasm_out8(s, 0x74); /* i32.shl */
        }
        if (sign) {
            tcg_wasm_out_op_i32_const(s, 32 - len);
            tcg_wasm_out8(s, 0x75); /* i32.shr_s */
            tcg_wasm_out8(s, 0xac); /* i64.extend_i32_s */
        } else {
            if (pos > 0) {
                tcg_wasm_out_op_i32_const(s, pos);
                tcg_wasm_out8(s, 0x76); /* i32.shr_u */
            }
            tcg_wasm_out8(s, 0xad); /* i64.extend_i32_u */
        }
        tcg_wasm_out_op_global_set_r(s, dest);
        return;
    }

    int rs = 64 - len;
    int sl = rs - pos;
    tcg_wasm_out_op_global_get_r(s, arg1);
    if (sl > 0) {
        tcg_wasm_out_op_i64_const(s, sl);
        tcg_wasm_out_op_i64_shl(s);
    }
    tcg_wasm_out_op_i64_const(s, rs);
    if (sign) {
        tcg_wasm_out_op_i64_shr_s(s);
    } else {
        tcg_wasm_out_op_i64_shr_u(s);
    }
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_extract2_i32(TCGContext *s, TCGReg dest, TCGReg arg1, TCGReg arg2, int pos)
{
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_const(s, 32-pos);
    tcg_wasm_out_op_i64_shl(s);

    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i64_const(s, 0xffffffff);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_i64_const(s, pos);
    tcg_wasm_out_op_i64_shr_u(s);

    tcg_wasm_out_op_i64_or(s);

    tcg_wasm_out_op_i64_const(s, 0xffffffff);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_extract2_i64(TCGContext *s, TCGReg dest, TCGReg arg1, TCGReg arg2, int pos)
{
    tcg_wasm_out_op_global_get_r(s, arg2);
    tcg_wasm_out_op_i64_const(s, 64-pos);
    tcg_wasm_out_op_i64_shl(s);
        
    tcg_wasm_out_op_global_get_r(s, arg1);
    tcg_wasm_out_op_i64_const(s, pos);
    tcg_wasm_out_op_i64_shr_u(s);

    tcg_wasm_out_op_i64_or(s);
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_bswap64(TCGContext *s, TCGReg dest, TCGReg src, int flags)
{
    tcg_wasm_out_op_global_get_r(s, src); // ABCDEFGH
    tcg_wasm_out_op_i64_const(s, 32);
    tcg_wasm_out_op_i64_rotr(s);
    tcg_wasm_out_op_local_set(s, TMP64_0_IDX); // EFGHABCD

    tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
    tcg_wasm_out_op_i64_const(s, 0xff000000ff000000);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_i64_const(s, 24);
    tcg_wasm_out_op_i64_shr_u(s); // ___E___A

    tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
    tcg_wasm_out_op_i64_const(s, 0x00ff000000ff0000);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_i64_const(s, 8);
    tcg_wasm_out_op_i64_shr_u(s); // __F___B_

    tcg_wasm_out_op_i64_or(s);

    tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
    tcg_wasm_out_op_i64_const(s, 0x0000ff000000ff00);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_i64_const(s, 8);
    tcg_wasm_out_op_i64_shl(s); // _G___C__

    tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
    tcg_wasm_out_op_i64_const(s, 0x000000ff000000ff);
    tcg_wasm_out_op_i64_and(s);
    tcg_wasm_out_op_i64_const(s, 24);
    tcg_wasm_out_op_i64_shl(s); // H___D___
    
    tcg_wasm_out_op_i64_or(s);

    tcg_wasm_out_op_i64_or(s); // HGFEDCBA
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_bswap32(TCGContext *s, TCGReg dest, TCGReg src, int flags)
{
    tcg_wasm_out_op_global_get_r(s, src);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_local_set(s, TMP32_LOCAL_0_IDX);
    
    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX); // ABCD
    tcg_wasm_out_op_i32_const(s, 16);
    tcg_wasm_out_op_i32_rotr(s);
    tcg_wasm_out_op_local_set(s, TMP32_LOCAL_0_IDX); // CDAB

    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);
    tcg_wasm_out_op_i32_const(s, 0xff00ff00);
    tcg_wasm_out_op_i32_and(s);
    tcg_wasm_out_op_i32_const(s, 8);
    tcg_wasm_out_op_i32_shr_u(s); // _C_A

    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);
    tcg_wasm_out_op_i32_const(s, 0x00ff00ff);
    tcg_wasm_out_op_i32_and(s);
    tcg_wasm_out_op_i32_const(s, 8);
    tcg_wasm_out_op_i32_shl(s); // D_B_

    tcg_wasm_out_op_i32_or(s); // DCBA
    tcg_wasm_out_op_i64_extend_i32_u(s);
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_bswap16(TCGContext *s, TCGReg dest, TCGReg src, int flags)
{
    tcg_wasm_out_op_global_get_r(s, src);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_local_set(s, TMP32_LOCAL_0_IDX);

    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX); // __AB
    tcg_wasm_out_op_i32_const(s, 8);
    tcg_wasm_out_op_i32_rotr(s);
    tcg_wasm_out_op_local_set(s, TMP32_LOCAL_0_IDX); // B__A

    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);
    tcg_wasm_out_op_i32_const(s, 0x000000ff);
    tcg_wasm_out_op_i32_and(s); // ___A

    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);
    tcg_wasm_out_op_i32_const(s, 0xff000000);
    tcg_wasm_out_op_i32_and(s);
    tcg_wasm_out_op_i32_const(s, 16);
    if (flags & TCG_BSWAP_OS) {
        tcg_wasm_out_op_i32_shr_s(s); // SSB_
    } else {
        tcg_wasm_out_op_i32_shr_u(s); // 00B_
    }

    tcg_wasm_out_op_i32_or(s); // **BA
    tcg_wasm_out_op_i64_extend_i32_u(s);
    tcg_wasm_out_op_global_set_r(s, dest);
}

static void tcg_wasm_out_ctx_i32_store_const(TCGContext *s, int off, int32_t v)
{
    tcg_wasm_out_op_local_get(s, CTX_IDX);
    tcg_wasm_out_op_i32_const(s, v);
    tcg_wasm_out_op_i32_store(s, 0, off);
}

static void tcg_wasm_out_ctx_i32_store_r(TCGContext *s, int off, TCGReg r0)
{
    tcg_wasm_out_op_local_get(s, CTX_IDX);
    tcg_wasm_out_op_global_get_r(s, r0);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_i32_store(s, 0, off);
}

static void tcg_wasm_out_ctx_i32_load(TCGContext *s, int off)
{
    tcg_wasm_out_op_local_get(s, CTX_IDX);
    tcg_wasm_out_op_i32_load(s, 0, off);
}

static void tcg_wasm_out_label_idx(TCGContext *s, int label)
{
    int block_idx = wasm_alloc_block_idx(s);
    wasm_add_label_context(s, label, block_idx);

    tcg_wasm_out_op_end(s); // end if of the previous block

    // following block
    tcg_wasm_out_op_global_get(s, BLOCK_PTR_IDX);
    tcg_wasm_out_op_i64_const(s, block_idx);
    tcg_wasm_out_op_i64_le_u(s);
    tcg_wasm_out_op_if_noret(s);
    env_cached = false;
}

__thread int current_label[100];
__thread int current_label_pos;

static void tcg_out_label_cb(TCGContext *s, TCGLabel *l)
{
    current_label[current_label_pos++] = l->id;
    tcg_debug_assert(current_label_pos < 100);
    tcg_wasm_out_label_idx(s, l->id + 1);
}

static void tcg_wasm_out_op_br_to_label(TCGContext *s, TCGLabel *l, bool br_if)
{
    int toploop_depth = 1;
    if (br_if) {
        tcg_wasm_out_op_if_noret(s);
        toploop_depth++;
    }
    tcg_wasm_out8(s, 0x42); // i64.const
    wasm_add_label_block_ptr_placeholder(l->id + 1, cur_wasm_ptr(s));
    tcg_wasm_out8(s, 0x80); // filled before instantiation
    tcg_wasm_out8(s, 0x80);
    tcg_wasm_out8(s, 0x80);
    tcg_wasm_out8(s, 0x80);
    tcg_wasm_out8(s, 0x00);
    tcg_wasm_out_op_global_set(s, BLOCK_PTR_IDX);
    bool found = false;
    for (int i = 0; i < current_label_pos; i++) {
        if (current_label[i] == l->id) {
            found = true;
            break;
        }
    }
    if (found) {
        tcg_wasm_out_op_br(s, toploop_depth); // br to the top of loop
    } else {
        tcg_wasm_out_op_br(s, toploop_depth - 1); // br to the end of the current block
    }
    if (br_if) {
        tcg_wasm_out_op_end(s);
    }
}

static void tcg_wasm_out_br(TCGContext *s, TCGLabel *l)
{
    tcg_wasm_out_op_br_to_label(s, l, false);
}

static void tcg_wasm_out_brcond_i32(TCGContext *s, TCGCond cond, TCGReg arg1,
                           TCGReg arg2, TCGLabel *l)
{
    tcg_wasm_out_op_cond_i32(s, cond, arg1, arg2);
    tcg_wasm_out_op_br_to_label(s, l, true);
}

static void tcg_wasm_out_brcond_i64(TCGContext *s, TCGCond cond, TCGReg arg1,
                           TCGReg arg2, TCGLabel *l)
{
    tcg_wasm_out_op_cond_i64(s, cond, arg1, arg2);
    tcg_wasm_out_op_br_to_label(s, l, true);
}

static void tcg_wasm_out_exit_tb(TCGContext *s, uintptr_t arg)
{
    tcg_wasm_out_ctx_i32_store_const(s, TB_PTR_OFF, 0);
    tcg_wasm_out_op_i32_const(s, (int32_t)arg);
    tcg_wasm_out_op_return(s);
}

static void tcg_wasm_out_goto_ptr(TCGContext *s, TCGReg arg)
{
    tcg_wasm_out_op_global_get_r(s, arg);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_ctx_i32_load(s, TB_PTR_OFF);
    tcg_wasm_out_op_i32_eq(s);
    tcg_wasm_out_op_if_noret(s);
    tcg_wasm_out_op_i64_const(s, 0);
    tcg_wasm_out_op_global_set(s, BLOCK_PTR_IDX);
    tcg_wasm_out_op_br(s, 2); // br to the top of loop
    tcg_wasm_out_op_end(s);

    tcg_wasm_out_ctx_i32_store_r(s, TB_PTR_OFF, arg);
    tcg_wasm_out_ctx_i32_store_const(s, DO_INIT_OFF, 1);
    tcg_wasm_out_op_i32_const(s, 0);
    tcg_wasm_out_op_return(s);
}

static void tcg_wasm_out_goto_tb(TCGContext *s, int which)
{
    tcg_wasm_out_op_i32_const(s, (int32_t)get_jmp_target_addr(s, which));
    tcg_wasm_out_op_i32_load(s, 0, 0);
    tcg_wasm_out_op_local_set(s, TMP32_LOCAL_0_IDX);

    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);
    tcg_wasm_out_op_i32_const(s, 0);
    tcg_wasm_out_op_i32_ne(s);
    tcg_wasm_out_op_if_noret(s);

    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);
    tcg_wasm_out_ctx_i32_load(s, TB_PTR_OFF);
    tcg_wasm_out_op_i32_eq(s);
    tcg_wasm_out_op_if_noret(s);
    tcg_wasm_out_op_i64_const(s, 0);
    tcg_wasm_out_op_global_set(s, BLOCK_PTR_IDX);
    tcg_wasm_out_op_br(s, 3); // br to the top of loop
    tcg_wasm_out_op_end(s);
    
    // store jmp target address to buf
    tcg_wasm_out_op_local_get(s, CTX_IDX);
    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);
    tcg_wasm_out_op_i32_store(s, 0, TB_PTR_OFF);
    tcg_wasm_out_ctx_i32_store_const(s, DO_INIT_OFF, 1);

    tcg_wasm_out_op_i32_const(s, 0);
    tcg_wasm_out_op_return(s);
    tcg_wasm_out_op_end(s);
}

static void push_arg_i64(TCGContext *s, int *reg_idx, int *stack_offset) {
    if (*reg_idx < NUM_OF_IARG_REGS) {
        tcg_wasm_out_op_global_get_r(s, REG_INDEX_IARG_BASE + *reg_idx);  // arg register
        int addend = 1;
        *reg_idx = *reg_idx + addend;
    } else {
        tcg_wasm_out_op_global_get_r(s, TCG_REG_CALL_STACK);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_load(s, 0, *stack_offset);
        int addend = 8;
        *stack_offset = *stack_offset + addend;
    }
}

void gen_func_wrapper_code(TCGContext *s, const tcg_insn_unit *func, const TCGHelperInfo *info, int func_idx)
{
    int nargs;
    unsigned typemask = info->typemask;
    int rettype = typemask & 7;

    if (rettype ==  dh_typecode_i128) {
        // receive 128bit return value via the stack buffer
        tcg_wasm_out_op_global_get_r(s, TCG_REG_CALL_STACK);
        tcg_wasm_out_op_i32_wrap_i64(s);
    }
    
    nargs = 32 - clz32(typemask >> 3);
    nargs = DIV_ROUND_UP(nargs, 3);
    int stack_offset = 0;
    int reg_idx = 0;
    int stack128_base = 0;
    bool cached_128base = false;
    for (int j = 0; j < nargs; ++j) {
        int typecode = extract32(typemask, (j + 1) * 3, 3);
        if (typecode == dh_typecode_void) {
            continue;
        }
        switch (typecode) {
        case dh_typecode_i32:
        case dh_typecode_s32:
        case dh_typecode_ptr:
            push_arg_i64(s, &reg_idx, &stack_offset);
            tcg_wasm_out_op_i32_wrap_i64(s);
            break;
        case dh_typecode_i64:
        case dh_typecode_s64:
            push_arg_i64(s, &reg_idx, &stack_offset);
            break;
        case dh_typecode_i128:
            // copy data to 128stack
            if (!cached_128base) {
                tcg_wasm_out_ctx_i32_load(s, STACK128_OFF);
                tcg_wasm_out_op_i64_extend_i32_s(s);
                tcg_wasm_out_op_local_set(s, TMP64_0_IDX);
                cached_128base = true;
            }

            // push current 128stack pointer
            tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
            tcg_wasm_out_op_i32_wrap_i64(s);
            tcg_wasm_out_op_i32_const(s, stack128_base);
            tcg_wasm_out_op_i32_add(s);

            tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
            tcg_wasm_out_op_i32_wrap_i64(s);
            push_arg_i64(s, &reg_idx, &stack_offset);
            tcg_wasm_out_op_i64_store(s, 0, stack128_base);
            stack128_base += 8;

            tcg_wasm_out_op_local_get(s, TMP64_0_IDX);
            tcg_wasm_out_op_i32_wrap_i64(s);
            push_arg_i64(s, &reg_idx, &stack_offset);
            tcg_wasm_out_op_i64_store(s, 0, stack128_base);
            stack128_base += 8;
            break;
        default:
            g_assert_not_reached();
        }
    }

    tcg_wasm_out_op_call(s, func_idx);

    stack_offset = 0;
    if (rettype != dh_typecode_void) {
        switch (rettype) {
        case dh_typecode_i32:
        case dh_typecode_s32:
        case dh_typecode_ptr:
            tcg_wasm_out_op_i64_extend_i32_s(s);
            tcg_wasm_out_op_global_set_r(s, TCG_REG_R0);
            break;
        case dh_typecode_i64:
        case dh_typecode_s64:
            tcg_wasm_out_op_global_set_r(s, TCG_REG_R0);
            break;
        case dh_typecode_i128:
            tcg_wasm_out_op_global_get_r(s, TCG_REG_CALL_STACK);
            tcg_wasm_out_op_i32_wrap_i64(s);
            tcg_wasm_out_op_i64_load(s, 0, stack_offset);
            tcg_wasm_out_op_global_set_r(s, TCG_REG_R0);
            stack_offset += 8;
            
            tcg_wasm_out_op_global_get_r(s, TCG_REG_CALL_STACK);
            tcg_wasm_out_op_i32_wrap_i64(s);
            tcg_wasm_out_op_i64_load(s, 0, stack_offset);
            tcg_wasm_out_op_global_set_r(s, TCG_REG_R1);
            stack_offset += 8;
            break;
        default:
            g_assert_not_reached();
        }
    }

    return;
}

static void gen_func_type(TCGContext *s, const TCGHelperInfo *info)
{
    int nargs;
    unsigned typemask = info->typemask;
    int rettype = typemask & 7;
    uint8_t * buf_start = wasm_get_helper_types_begin(s);
    uint8_t * buf_ptr = buf_start;
    nargs = 32 - clz32(typemask >> 3);
    nargs = DIV_ROUND_UP(nargs, 3);

    *buf_ptr++ = 0x60;
    uint8_t * buf_ptr_vec_size = buf_ptr;
    *buf_ptr += 0x80;
    *buf_ptr += 0x80;
    *buf_ptr += 0x80;
    *buf_ptr += 0x80;
    *buf_ptr += 0x00;
    *buf_ptr++ = 0; // vector size (placeholder)

    int vec_size = 0;
    
    if (rettype == dh_typecode_i128) {
        *buf_ptr++ = 0x7f; // i32 (stack buffer pointer)
        vec_size++;
    }
    
    for (int j = 0; j < nargs; ++j) {
        int typecode = extract32(typemask, (j + 1) * 3, 3);
        if (typecode == dh_typecode_void) {
            continue;
        }
        switch (typecode) {
        case dh_typecode_i32:
        case dh_typecode_s32:
        case dh_typecode_ptr:
            *buf_ptr++ = 0x7f;
            vec_size++;
            break;
        case dh_typecode_i64:
        case dh_typecode_s64:
            *buf_ptr++ = 0x7e;
            vec_size++;
            break;
        case dh_typecode_i128:
            *buf_ptr++ = 0x7f;
            vec_size++;
            break;
        default:
            g_assert_not_reached();
        }
    }
    fill_uint32_leb128((uintptr_t)buf_ptr_vec_size, vec_size); // fill size

    if ((rettype == dh_typecode_void) || (rettype == dh_typecode_i128)) {
        *buf_ptr++ = 0x0; // no return value
    } else {
        *buf_ptr++ = 0x1;
        switch (rettype) {
        case dh_typecode_i32:
        case dh_typecode_s32:
        case dh_typecode_ptr:
            *buf_ptr++ = 0x7f;
            break;
        case dh_typecode_i64:
        case dh_typecode_s64:
            *buf_ptr++ = 0x7e;
            break;
        default:
            g_assert_not_reached();
        }
    }
    int sz = (uint32_t)(buf_ptr - buf_start);
    wasm_add_helper_types_pos(s, sz);
    return;
}

static void gen_func_type_qemu_ld(TCGContext *s, uint32_t oi)
{
    uint8_t * buf_start = wasm_get_helper_types_begin(s);
    uint8_t * buf_ptr = buf_start;
    *buf_ptr++ = 0x60;
    *buf_ptr++ = 0x4;
    *buf_ptr++ = 0x7f;
    *buf_ptr++ = 0x7e;
    *buf_ptr++ = 0x7f;
    *buf_ptr++ = 0x7f;
    *buf_ptr++ = 0x1;
    MemOp mop = get_memop(oi);
    switch (mop & MO_SSIZE) {
    case MO_UQ:
        *buf_ptr++ = 0x7e;
        break;
    default:
        *buf_ptr++ = 0x7e;
        break;
    }
    int sz = (uint32_t)(buf_ptr - buf_start);
    wasm_add_helper_types_pos(s, sz);
}

static void gen_func_type_qemu_st(TCGContext *s, uint32_t oi)
{
    uint8_t * buf_start = wasm_get_helper_types_begin(s);
    uint8_t * buf_ptr = buf_start;
    *buf_ptr++ = 0x60;
    *buf_ptr++ = 0x5;
    *buf_ptr++ = 0x7f;
    *buf_ptr++ = 0x7e;
    MemOp mop = get_memop(oi);
    switch (mop & MO_SSIZE) {
    case MO_UQ:
        *buf_ptr++ = 0x7e;
        break;
    default:
        *buf_ptr++ = 0x7f;
        break;
    }
    *buf_ptr++ = 0x7f;
    *buf_ptr++ = 0x7f;
    *buf_ptr++ = 0x0;
    int sz = (uint32_t)(buf_ptr - buf_start);
    wasm_add_helper_types_pos(s, sz);
}

static void tcg_wasm_out_call(TCGContext *s, const tcg_insn_unit *func,
                         const TCGHelperInfo *info)
{
    // set return position
    tcg_wasm_out_ctx_i32_load(s, HELPER_RET_TB_PTR_OFF);
    tcg_wasm_out_op_i32_const(s, (int32_t)s->code_ptr);

    tcg_wasm_out_op_i32_store(s, 0, 0);

    int func_idx = get_wasm_helper_idx(s, (int)func);
    if (func_idx < 0) {
        func_idx = wasm_register_helper_alloc_num(s);
        tcg_debug_assert(func >= 0);
        wasm_register_helper(s, func_idx, (int)func);
        gen_func_type(s, info);
    }

    int target_block_idx = wasm_block_current_idx(s) + 1;
    tcg_wasm_out_op_i64_const(s, target_block_idx);
    tcg_wasm_out_op_global_set(s, BLOCK_PTR_IDX);
    tcg_wasm_out_op_end(s); // close if of this block (rewind skips this)
    env_cached = false;

    int block_idx = wasm_alloc_block_idx(s);
    tcg_wasm_out_op_global_get(s, BLOCK_PTR_IDX);
    tcg_wasm_out_op_i64_const(s, block_idx);
    tcg_wasm_out_op_i64_le_u(s);
    tcg_wasm_out_op_if_noret(s);
    tcg_wasm_out_ctx_i32_store_const(s, UNWINDING_OFF, 0);
    gen_func_wrapper_code(s, func, info, func_idx);

    tcg_wasm_out_op_i32_const(s, 1);
    tcg_wasm_out_ctx_i32_load(s, UNWINDING_OFF);
    tcg_wasm_out_op_i32_eq(s);
    tcg_wasm_out_op_if_noret(s);
    tcg_wasm_out_op_i32_const(s, 0);
    tcg_wasm_out_op_return(s);
    tcg_wasm_out_op_end(s);
}

void tb_target_set_jmp_target(const TranslationBlock *tb, int n,
                              uintptr_t jmp_rx, uintptr_t jmp_rw)
{
    /* Always indirect, nothing to do */
}

static uint8_t tcg_wasm_out_tlb_load(TCGContext *s, TCGReg addr, MemOpIdx oi, bool is_ld)
{
    MemOp opc = get_memop(oi);
    TCGAtomAlign aa;
    unsigned a_mask;

    aa = atom_and_align_for_opc(s, opc, MO_ATOM_IFALIGN, false);
    a_mask = (1u << aa.align) - 1;

    unsigned s_bits = opc & MO_SIZE;
    unsigned s_mask = (1u << s_bits) - 1;
    tcg_target_long compare_mask;
    int mem_index = get_mmuidx(oi);
    int fast_ofs = tlb_mask_table_ofs(s, mem_index);
    int mask_ofs = fast_ofs + offsetof(CPUTLBDescFast, mask);
    int table_ofs = fast_ofs + offsetof(CPUTLBDescFast, table);
    int add_off = offsetof(CPUTLBEntry, addend);

    tcg_wasm_out_op_global_get_r(s, addr);
    tcg_wasm_out_op_i64_const(s, TARGET_PAGE_BITS - CPU_TLB_ENTRY_BITS);
    tcg_wasm_out_op_i64_shr_u(s);
    
    tcg_wasm_out_op_global_get_r_i32(s, TCG_AREG0);
    int off = mask_ofs;
    if ((int64_t)off < 0) {
        tcg_wasm_out_op_i32_const(s, (int64_t)off);
        tcg_wasm_out_op_i32_add(s);
        off = 0;
    }
    tcg_wasm_out_op_i64_load(s, 0, (uint64_t)off);
    tcg_wasm_out_op_local_set(s, TMP64_2_IDX);

    tcg_wasm_out_op_local_get(s, TMP64_2_IDX);

    tcg_wasm_out_op_i64_and(s);

    tcg_wasm_out_op_global_get_r_i32(s, TCG_AREG0);
    off = table_ofs;
    if ((int64_t)off < 0) {
        tcg_wasm_out_op_i32_const(s, (int64_t)off);
        tcg_wasm_out_op_i32_add(s);
        off = 0;
    }
    tcg_wasm_out_op_i64_load(s, 0, (uint64_t)off);
    tcg_wasm_out_op_i64_add(s);
    
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_local_tee(s, TMP32_LOCAL_0_IDX);

    off = is_ld ? offsetof(CPUTLBEntry, addr_read)
        : offsetof(CPUTLBEntry, addr_write);
    if ((int64_t)off < 0) {
        tcg_wasm_out_op_i32_const(s, (int64_t)off);
        tcg_wasm_out_op_i32_add(s);
        off = 0;
    }
    tcg_wasm_out_op_i64_load(s, 0, (uint64_t)off);

    tcg_wasm_out_op_global_get_r(s, addr);
    if (a_mask < s_mask) {
        tcg_wasm_out_op_i64_const(s, s_mask - a_mask);
        tcg_wasm_out_op_i64_add(s);
    }
    compare_mask = (uint64_t)TARGET_PAGE_MASK | a_mask;
    tcg_wasm_out_op_i64_const(s, compare_mask);
    tcg_wasm_out_op_i64_and(s);

    tcg_wasm_out_op_i64_eq(s);

    tcg_wasm_out_op_i64_const(s, 0);
    tcg_wasm_out_op_local_set(s, TMP64_0_IDX);
    
    tcg_wasm_out_op_if_noret(s);
    tcg_wasm_out_op_local_get(s, TMP32_LOCAL_0_IDX);
    off = add_off;
    if ((int64_t)off < 0) {
        tcg_wasm_out_op_i32_const(s, (int64_t)off);
        tcg_wasm_out_op_i32_add(s);
        off = 0;
    }
    tcg_wasm_out_op_i32_load(s, 0, (uint64_t)off);
    tcg_wasm_out_op_i64_extend_i32_u(s);
    tcg_wasm_out_op_global_get_r(s, addr);
    tcg_wasm_out_op_i64_add(s);
    tcg_wasm_out_op_local_set(s, TMP64_0_IDX);
    
    tcg_wasm_out_op_end(s);
    
    
    return TMP64_0_IDX;
}

static void tcg_wasm_out_qemu_ld_direct(TCGContext *s, TCGReg r, uint8_t base, MemOp opc)
{
    /* Byte swapping is left to middle-end expansion. */
    tcg_debug_assert((opc & MO_BSWAP) == 0);

    switch (opc & (MO_SSIZE)) {
    case MO_UB:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_load8_u(s, 0, 0);
        tcg_wasm_out_op_global_set_r(s, r);
        break;
    case MO_SB:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_load8_s(s, 0, 0);
        tcg_wasm_out_op_global_set_r(s, r);
        break;
    case MO_UW:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_load16_u(s, 0, 0);
        tcg_wasm_out_op_global_set_r(s, r);
        break;
    case MO_SW:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_load16_s(s, 0, 0);
        tcg_wasm_out_op_global_set_r(s, r);
        break;
    case MO_UL:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_load32_u(s, 0, 0);
        tcg_wasm_out_op_global_set_r(s, r);
        break;
    case MO_SL:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_load32_s(s, 0, 0);
        tcg_wasm_out_op_global_set_r(s, r);
        break;
    case MO_UQ:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_i64_load(s, 0, 0);
        tcg_wasm_out_op_global_set_r(s, r);
        break;
    default:
        g_assert_not_reached();
    }
}

static void* qemu_ld_helper_ptr(uint32_t oi)
{
    MemOp mop = get_memop(oi);
    switch (mop & MO_SSIZE) {
    case MO_UB:
        return helper_ldub_mmu;
    case MO_SB:
        return helper_ldsb_mmu;
    case MO_UW:
        return helper_lduw_mmu;
    case MO_SW:
        return helper_ldsw_mmu;
    case MO_UL:
        return helper_ldul_mmu;
    case MO_SL:
        return helper_ldsl_mmu;
    case MO_UQ:
        return helper_ldq_mmu;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_qemu_ld(TCGContext *s, const TCGArg *args, bool is_64)
{
    TCGReg addr_reg;
    TCGReg data_reg;
    MemOpIdx oi;
    MemOp opc;

    data_reg = *args++;
    addr_reg = *args++;
    oi = *args++;
    opc = get_memop(oi);

    uint8_t base = tcg_wasm_out_tlb_load(s, addr_reg, oi, true);
    
    tcg_wasm_out_op_local_get(s, base);
    tcg_wasm_out_op_i64_eqz(s);
    tcg_wasm_out_op_if_noret(s);

    // path for miss case
    int helper_func_idx = (uint32_t)qemu_ld_helper_ptr(oi);
    int func_idx = get_wasm_helper_idx(s, helper_func_idx);
    if (func_idx < 0) {
        func_idx = wasm_register_helper_alloc_num(s);
        tcg_debug_assert(helper_func_idx >= 0);
        wasm_register_helper(s, func_idx, helper_func_idx);
        gen_func_type_qemu_ld(s, oi);
    }

    // save function pointer
    tcg_wasm_out_ctx_i32_store_const(s, DONE_FLAG_OFF, 0);

    tcg_wasm_out_op_else(s);

    // fast path
    tcg_wasm_out_qemu_ld_direct(s, data_reg, base, opc);

    tcg_wasm_out_op_end(s);

    int target_block_idx = wasm_block_current_idx(s) + 1;
    tcg_wasm_out_op_i64_const(s, target_block_idx);
    tcg_wasm_out_op_global_set(s, BLOCK_PTR_IDX);

    tcg_wasm_out_op_end(s); // close if of this block (rewind skips this)
    env_cached = false;
    
    // block for calling helper (+1)
    int block_idx = wasm_alloc_block_idx(s);
    tcg_wasm_out_op_global_get(s, BLOCK_PTR_IDX);
    tcg_wasm_out_op_i64_const(s, block_idx);
    tcg_wasm_out_op_i64_le_u(s);
    tcg_wasm_out_op_if_noret(s);

    tcg_wasm_out_op_local_get(s, base);
    tcg_wasm_out_op_i64_eqz(s);
    tcg_wasm_out_op_if_noret(s);

    // call helper
    tcg_wasm_out_op_global_get_r(s, TCG_AREG0);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_global_get_r(s, addr_reg);
    tcg_wasm_out_op_i32_const(s, oi);
    tcg_wasm_out_op_i32_const(s, (int32_t)s->code_ptr);

    tcg_wasm_out_op_call(s, func_idx);
    tcg_wasm_out_op_global_set_r(s, data_reg);
    tcg_wasm_out_ctx_i32_load(s, DONE_FLAG_OFF);
    tcg_wasm_out_op_i32_eqz(s);

    tcg_wasm_out_op_if_noret(s);
    tcg_wasm_out_op_i32_const(s, 0);
    tcg_wasm_out_op_return(s);
    tcg_wasm_out_op_end(s);
    tcg_wasm_out_op_end(s);
}

static void tcg_wasm_out_qemu_st_direct(TCGContext *s, TCGReg lo, uint8_t base, MemOp opc)
{
    /* Byte swapping is left to middle-end expansion. */
    tcg_debug_assert((opc & MO_BSWAP) == 0);

    switch (opc & (MO_SSIZE)) {
    case MO_8:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_global_get_r(s, lo);
        tcg_wasm_out_op_i64_store8(s, 0, 0);
        break;
    case MO_16:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_global_get_r(s, lo);
        tcg_wasm_out_op_i64_store16(s, 0, 0);
        break;
    case MO_32:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_global_get_r(s, lo);
        tcg_wasm_out_op_i64_store32(s, 0, 0);
        break;
    case MO_64:
        tcg_wasm_out_op_local_get(s, base);
        tcg_wasm_out_op_i32_wrap_i64(s);
        tcg_wasm_out_op_global_get_r(s, lo);
        tcg_wasm_out_op_i64_store(s, 0, 0);
        break;
    default:
        g_assert_not_reached();
    }
}

static void* qemu_st_helper_ptr(uint32_t oi)
{
    MemOp mop = get_memop(oi);
    switch (mop & MO_SIZE) {
    case MO_8:
        return helper_stb_mmu;
    case MO_16:
        return helper_stw_mmu;
    case MO_32:
        return helper_stl_mmu;
    case MO_64:
        return helper_stq_mmu;
    case MO_128:
        return helper_st16_mmu;
    default:
        g_assert_not_reached();
    }
}

static void tcg_wasm_out_qemu_st(TCGContext *s, const TCGArg *args, bool is_64)
{
    TCGReg addr_reg;
    TCGReg data_reg;
    MemOpIdx oi;
    MemOp opc;

    data_reg = *args++;
    addr_reg = *args++;
    oi = *args++;
    opc = get_memop(oi);

    uint8_t base = tcg_wasm_out_tlb_load(s, addr_reg, oi, false);

    tcg_wasm_out_op_local_get(s, base);
    tcg_wasm_out_op_i64_eqz(s);
    tcg_wasm_out_op_if_noret(s);

    // path for miss case
    int helper_func_idx = (uint32_t)qemu_st_helper_ptr(oi);
    int func_idx = get_wasm_helper_idx(s, helper_func_idx);
    if (func_idx < 0) {
        func_idx = wasm_register_helper_alloc_num(s);
        tcg_debug_assert(helper_func_idx >= 0);
        wasm_register_helper(s, func_idx, helper_func_idx);
        gen_func_type_qemu_st(s, oi);
    }

    // save function pointer
    tcg_wasm_out_ctx_i32_store_const(s, DONE_FLAG_OFF, 0);

    tcg_wasm_out_op_else(s);

    // fast path
    tcg_wasm_out_qemu_st_direct(s, data_reg, base, opc);

    tcg_wasm_out_op_end(s);

    int target_block_idx = wasm_block_current_idx(s) + 1;
    tcg_wasm_out_op_i64_const(s, target_block_idx);
    tcg_wasm_out_op_global_set(s, BLOCK_PTR_IDX);

    tcg_wasm_out_op_end(s); // close if of this block (rewind skips this)
    env_cached = false;

    // block for calling helper (+1)
    int block_idx = wasm_alloc_block_idx(s);
    tcg_wasm_out_op_global_get(s, BLOCK_PTR_IDX);
    tcg_wasm_out_op_i64_const(s, block_idx);
    tcg_wasm_out_op_i64_le_u(s);
    tcg_wasm_out_op_if_noret(s);

    tcg_wasm_out_op_local_get(s, base);
    tcg_wasm_out_op_i64_eqz(s);
    tcg_wasm_out_op_if_noret(s);
    
    // call helper
    tcg_wasm_out_op_global_get_r(s, TCG_AREG0);
    tcg_wasm_out_op_i32_wrap_i64(s);
    tcg_wasm_out_op_global_get_r(s, addr_reg);
    MemOp mop = get_memop(oi);
    switch (mop & MO_SSIZE) {
    case MO_UQ:
        tcg_wasm_out_op_global_get_r(s, data_reg);
        break;
    default:
        tcg_wasm_out_op_global_get_r(s, data_reg);
        tcg_wasm_out_op_i32_wrap_i64(s);
        break;
    }
    tcg_wasm_out_op_i32_const(s, oi);
    tcg_wasm_out_op_i32_const(s, (int32_t)s->code_ptr);

    tcg_wasm_out_op_call(s, func_idx);

    tcg_wasm_out_ctx_i32_load(s, DONE_FLAG_OFF);
    tcg_wasm_out_op_i32_eqz(s);
    tcg_wasm_out_op_if_noret(s);
    tcg_wasm_out_op_i32_const(s, 0);
    tcg_wasm_out_op_return(s);
    tcg_wasm_out_op_end(s);
    tcg_wasm_out_op_end(s);
}

static bool patch_reloc(tcg_insn_unit *code_ptr_i, int type,
                        intptr_t value, intptr_t addend)
{
    int32_t *code_ptr = (int32_t*)code_ptr_i;
    intptr_t diff = value - (intptr_t)(code_ptr + 1);

    tcg_debug_assert(addend == 0);
    tcg_debug_assert(type == 20);

    if (diff == sextract32(diff, 0, type)) {
        tcg_patch32(code_ptr, deposit32(*code_ptr, 32 - type, type, diff));
        return true;
    }
    return false;
}


static inline void tcg_tci_out32(TCGContext *s, uint32_t v)
{
    tcg_out32(s, v);
}

static uintptr_t cur_tci_ptr(TCGContext *s)
{
    return (uintptr_t)s->code_ptr;
}













static void tcg_tci_out_call(TCGContext *s, const tcg_insn_unit *func,
                         const TCGHelperInfo *info)
{
    ffi_cif *cif = info->cif;
    uint32_t insn = 0;
    uint8_t which;

    if (cif->rtype == &ffi_type_void) {
        which = 0;
    } else {
        tcg_debug_assert(cif->rtype->size == 4 ||
                         cif->rtype->size == 8 ||
                         cif->rtype->size == 16);
        which = ctz32(cif->rtype->size) - 1;
    }
    new_pool_l2(s, 20, (void*)cur_tci_ptr(s), 0, (uintptr_t)func, (uintptr_t)cif);
    insn = deposit32(insn, 0, 8, INDEX_op_call);
    insn = deposit32(insn, 8, 4, which);
    tcg_tci_out32(s, insn);
}

#if TCG_TARGET_REG_BITS == 64
# define CASE_32_64(x) \
        case glue(glue(INDEX_op_, x), _i64): \
        case glue(glue(INDEX_op_, x), _i32):
# define CASE_64(x) \
        case glue(glue(INDEX_op_, x), _i64):
#else
# define CASE_32_64(x) \
        case glue(glue(INDEX_op_, x), _i32):
# define CASE_64(x)
#endif

static void tcg_tci_out_exit_tb(TCGContext *s, uintptr_t arg)
{
    tcg_out_op_p(s, INDEX_op_exit_tb, (void *)arg);
}

static void tcg_tci_out_goto_tb(TCGContext *s, int which)
{
    /*
     * wasm32 dispatch protocol: the fallback interpreter cannot chain
     * via the stock goto_tb (a chained jmp slot holds the next TB's
     * *prefix* pointer, not a TCI stream pointer).  Emit tci_w32_next
     * instead: the interpreter hands the slot value (0 = unchained) to
     * tcg/wasm32.c's dispatch loop, which resolves the next TB.
     * set_jmp_reset_offset is still recorded so cpu_exec's tb_add_jump
     * keeps patching tb->jmp_target_addr for the wasm side.
     */
    tcg_out_op_p(s, INDEX_op_tci_w32_next, (void *)get_jmp_target_addr(s, which));
    set_jmp_reset_offset(s, which);
}

static void tcg_out_nop_fill(tcg_insn_unit *p, int count)
{
    int32_t *p2 = (int32_t*)p;
    memset(p2, 0, sizeof(*p2) * count);
}

static void tcg_out_goto_ptr(TCGContext *s, TCGReg arg)
{
    /* TCI half: same dispatch protocol as goto_tb (see above). */
    tcg_out_op_r(s, INDEX_op_tci_w32_next_r, arg);
    tcg_wasm_out_goto_ptr(s, arg);
}
static void tcg_out_br(TCGContext *s, TCGLabel *l)
{
    tcg_out_op_l(s, INDEX_op_br, l);
    tcg_wasm_out_br(s, l);
}
static void tcg_out_setcond_i32(TCGContext *s, TCGOpcode opc, TCGCond cond, TCGReg ret,
                            TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrrc(s, opc, ret, arg1, arg2, cond);
    tcg_wasm_out_setcond_i32(s, cond, ret, arg1, arg2);
}
static void tcg_out_setcond_i64(TCGContext *s, TCGOpcode opc, TCGCond cond, TCGReg ret,
                            TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrrc(s, opc, ret, arg1, arg2, cond);
    tcg_wasm_out_setcond_i64(s, cond, ret, arg1, arg2);
}
static void tcg_out_movcond_i32(TCGContext *s, TCGOpcode opc, TCGCond cond, TCGReg ret,
                            TCGReg c1, TCGReg c2, TCGReg v1, TCGReg v2)
{
    tcg_out_op_rrrrrc(s, opc, ret, c1, c2, v1, v2, cond);
    tcg_wasm_out_movcond_i32(s, cond, ret, c1, c2, v1, v2);
}
static void tcg_out_movcond_i64(TCGContext *s, TCGOpcode opc, TCGCond cond, TCGReg ret,
                            TCGReg c1, TCGReg c2, TCGReg v1, TCGReg v2)
{
    tcg_out_op_rrrrrc(s, opc, ret, c1, c2, v1, v2, cond);
    tcg_wasm_out_movcond_i64(s, cond, ret, c1, c2, v1, v2);
}
static void tcg_out_ld(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
        tcg_out_ldst(s, INDEX_op_ld32u, val, base, offset);
        break;
    case TCG_TYPE_I64:
        tcg_out_ldst(s, INDEX_op_ld, val, base, offset);
        break;
    default:
        g_assert_not_reached();
    }
    tcg_wasm_out_ld(s, type, val, base, offset);
}
static void tcg_out_ld8s(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    tcg_out_ldst(s, INDEX_op_ld8s, val, base, offset);
    tcg_wasm_out_ld8s(s, type, val, base, offset);
}
static void tcg_out_ld8u(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    tcg_out_ldst(s, INDEX_op_ld8u, val, base, offset);
    tcg_wasm_out_ld8u(s, type, val, base, offset);
}
static void tcg_out_ld16s(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    tcg_out_ldst(s, INDEX_op_ld16s, val, base, offset);
    tcg_wasm_out_ld16s(s, type, val, base, offset);
}
static void tcg_out_ld16u(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    tcg_out_ldst(s, INDEX_op_ld16u, val, base, offset);
    tcg_wasm_out_ld16u(s, type, val, base, offset);
}
static void tcg_out_ld32s(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    tcg_out_ldst(s, INDEX_op_ld32s, val, base, offset);
    tcg_wasm_out_ld32s(s, type, val, base, offset);
}
static void tcg_out_ld32u(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    tcg_out_ldst(s, INDEX_op_ld32u, val, base, offset);
    tcg_wasm_out_ld32u(s, type, val, base, offset);
}
static void tcg_out_st(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    switch (type) {
    case TCG_TYPE_I32:
        tcg_out_ldst(s, INDEX_op_st32, val, base, offset);
        break;
    case TCG_TYPE_I64:
        tcg_out_ldst(s, INDEX_op_st, val, base, offset);
        break;
    default:
        g_assert_not_reached();
    }
    tcg_wasm_out_st(s, type, val, base, offset);
}
static void tcg_out_st8(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    tcg_out_ldst(s, INDEX_op_st8, val, base, offset);
    tcg_wasm_out_st8(s, type, val, base, offset);
}
static void tcg_out_st16(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    tcg_out_ldst(s, INDEX_op_st16, val, base, offset);
    tcg_wasm_out_st16(s, type, val, base, offset);
}
static void tcg_out_st32(TCGContext *s, TCGType type, TCGReg val, TCGReg base,
                       intptr_t offset)
{
    tcg_out_ldst(s, INDEX_op_st32, val, base, offset);
    tcg_wasm_out_st32(s, type, val, base, offset);
}
static void tcg_out_i64_calc_add(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_add(s, ret, arg1, arg2);
}
static void tcg_out_i64_calc_sub(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_sub(s, ret, arg1, arg2);
}
static void tcg_out_i64_calc_mul(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_mul(s, ret, arg1, arg2);
}
static void tcg_out_i64_calc_and(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_and(s, ret, arg1, arg2);
}
static void tcg_out_i64_calc_or(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_or(s, ret, arg1, arg2);
}
static void tcg_out_i64_calc_xor(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_xor(s, ret, arg1, arg2);
}
static void tcg_out_shl(TCGContext *s, TCGOpcode opc, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_shl(s, type, ret, arg1, arg2);
}
static void tcg_out_i64_calc_shl(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_shl(s, ret, arg1, arg2);
}
static void tcg_out_shr_u(TCGContext *s, TCGOpcode opc, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_shr_u(s, type, ret, arg1, arg2);
}
static void tcg_out_i64_calc_shr_u(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_shr_u(s, ret, arg1, arg2);
}
static void tcg_out_shr_s(TCGContext *s, TCGOpcode opc, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_shr_s(s, type, ret, arg1, arg2);
}
static void tcg_out_i64_calc_shr_s(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_shr_s(s, ret, arg1, arg2);
}
static void tcg_out_i64_calc_rotl(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_rotl(s, ret, arg1, arg2);
}
static void tcg_out_i32_rotl(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i32_rotl(s, ret, arg1, arg2);
}
static void tcg_out_i32_rotr(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i32_rotr(s, ret, arg1, arg2);
}
static void tcg_out_i64_calc_rotr(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_i64_calc_rotr(s, ret, arg1, arg2);
}
static void tcg_out_i64_calc_div_s(TCGContext *s, TCGOpcode opc, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_div_s(s, type, ret, arg1, arg2);
}
static void tcg_out_i64_calc_div_u(TCGContext *s, TCGOpcode opc, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_div_u(s, type, ret, arg1, arg2);
}
static void tcg_out_i64_calc_rem_s(TCGContext *s, TCGOpcode opc, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_rem_s(s, type, ret, arg1, arg2);
}
static void tcg_out_i64_calc_rem_u(TCGContext *s, TCGOpcode opc, TCGType type, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_rem_u(s, type, ret, arg1, arg2);
}
static void tcg_out_andc(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_andc(s, ret, arg1, arg2);
}
static void tcg_out_orc(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_orc(s, ret, arg1, arg2);
}
static void tcg_out_eqv(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_eqv(s, ret, arg1, arg2);
}
static void tcg_out_nand(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_nand(s, ret, arg1, arg2);
}
static void tcg_out_nor(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_nor(s, ret, arg1, arg2);
}
static void tcg_out_clz32(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_clz32(s, ret, arg1, arg2);
}
static void tcg_out_clz64(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_clz64(s, ret, arg1, arg2);
}
static void tcg_out_ctz32(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_ctz32(s, ret, arg1, arg2);
}
static void tcg_out_ctz64(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrr(s, opc, ret, arg1, arg2);
    tcg_wasm_out_ctz64(s, ret, arg1, arg2);
}
static void tcg_out_brcond_i32(TCGContext *s, TCGOpcode opc, TCGCond cond, TCGReg arg1,
                           TCGReg arg2, TCGLabel *l)
{
    tcg_out_op_rrrc(s, (opc == INDEX_op_brcond ? INDEX_op_setcond : INDEX_op_setcond), TCG_REG_TMP, arg1, arg2, cond);
    tcg_out_op_rl(s, opc, TCG_REG_TMP, l);
    tcg_wasm_out_brcond_i32(s, cond, arg1, arg2, l);

}
static void tcg_out_brcond_i64(TCGContext *s, TCGOpcode opc, TCGCond cond, TCGReg arg1,
                           TCGReg arg2, TCGLabel *l)
{
    tcg_out_op_rrrc(s, (opc == INDEX_op_brcond ? INDEX_op_setcond : INDEX_op_setcond), TCG_REG_TMP, arg1, arg2, cond);
    tcg_out_op_rl(s, opc, TCG_REG_TMP, l);
    tcg_wasm_out_brcond_i64(s, cond, arg1, arg2, l);

}
static void tcg_out_neg(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg)
{
    tcg_out_op_rr(s, opc, ret, arg);
    tcg_wasm_out_neg(s, ret, arg);
}
static void tcg_out_not(TCGContext *s, TCGOpcode opc, TCGReg ret, TCGReg arg)
{
    tcg_out_op_rr(s, opc, ret, arg);
    tcg_wasm_out_not(s, ret, arg);
}
static void tcg_out_ctpop_i32(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg src)
{
    tcg_out_op_rr(s, opc, dest, src);
    tcg_wasm_out_ctpop_i32(s, dest, src);
}
static void tcg_out_ctpop_i64(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg src)
{
    tcg_out_op_rr(s, opc, dest, src);
    tcg_wasm_out_ctpop_i64(s, dest, src);
}
static void tcg_out_mulu2_i32(TCGContext *s, TCGOpcode opc, TCGReg retl, TCGReg reth, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrrr(s, opc, retl, reth, arg1, arg2);
    tcg_wasm_out_mulu2_i32(s, retl, reth, arg1, arg2);
}
static void tcg_out_muls2_i32(TCGContext *s, TCGOpcode opc, TCGReg retl, TCGReg reth, TCGReg arg1, TCGReg arg2)
{
    tcg_out_op_rrrr(s, opc, retl, reth, arg1, arg2);
    tcg_wasm_out_muls2_i32(s, retl, reth, arg1, arg2);
}

static void tcg_out_bswap16_i32(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg src, int flags)
{
    tcg_out_op_rr(s, opc, dest, src);
    if (flags & TCG_BSWAP_OS) {
        tcg_out_op_rrbb(s, INDEX_op_sextract, dest, dest, 0, 16);
    }
    tcg_wasm_out_bswap16(s, dest, src, flags);
    if (flags & TCG_BSWAP_OS) {
        tcg_wasm_out_ext16s(s, TCG_TYPE_I32, dest, dest);
    }
}
static void tcg_out_bswap16_i64(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg src, int flags)
{
    tcg_out_op_rr(s, opc, dest, src);
    if (flags & TCG_BSWAP_OS) {
        tcg_out_op_rrbb(s, INDEX_op_sextract, dest, dest, 0, 16);
    }
    tcg_wasm_out_bswap16(s, dest, src, flags);
    if (flags & TCG_BSWAP_OS) {
        tcg_wasm_out_ext16s(s, TCG_TYPE_I64, dest, dest);
    }
}

static void tcg_out_bswap32_i32(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg src, int flags)
{
    tcg_out_op_rr(s, opc, dest, src);
    tcg_wasm_out_bswap32(s, dest, src, flags);
}
static void tcg_out_bswap32_i64(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg src, int flags)
{
    tcg_out_op_rr(s, opc, dest, src);
    if (flags & TCG_BSWAP_OS) {
        tcg_out_op_rrbb(s, INDEX_op_sextract, dest, dest, 0, 32);
    }
    tcg_wasm_out_bswap32(s, dest, src, flags);
    if (flags & TCG_BSWAP_OS) {
        tcg_wasm_out_ext32s(s, dest, dest);
    }
}
static void tcg_out_bswap64_i64(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg src, int flags)
{
    tcg_out_op_rr(s, opc, dest, src);
    tcg_wasm_out_bswap64(s, dest, src, flags);
}
static void tcg_out_deposit_i32(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg arg1, TCGReg arg2, int pos, int len)
{
    TCGArg max = opc == INDEX_op_deposit ? 32 : 64;
    tcg_out_op_rrrbb(s, opc, dest, arg1, arg2, pos, len);
    tcg_wasm_out_deposit_i32(s, dest, arg1, arg2, pos, len);
}
static void tcg_out_deposit_i64(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg arg1, TCGReg arg2, int pos, int len)
{
    TCGArg max = opc == INDEX_op_deposit ? 32 : 64;
    tcg_out_op_rrrbb(s, opc, dest, arg1, arg2, pos, len);
    tcg_wasm_out_deposit_i64(s, dest, arg1, arg2, pos, len);
}
static void tcg_out_extract_i32(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg arg1, int pos, int len)
{
        tcg_out_op_rrbb(s, opc, dest, arg1, pos, len);
    tcg_wasm_out_extract(s, dest, arg1, pos, len, TCG_TYPE_I32, false);
}
static void tcg_out_extract_i64(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg arg1, int pos, int len)
{
        tcg_out_op_rrbb(s, opc, dest, arg1, pos, len);
    tcg_wasm_out_extract(s, dest, arg1, pos, len, TCG_TYPE_I64, false);
}
static void tcg_out_sextract_i32(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg arg1, int pos, int len)
{
        tcg_out_op_rrbb(s, opc, dest, arg1, pos, len);
    tcg_wasm_out_extract(s, dest, arg1, pos, len, TCG_TYPE_I32, true);
}
static void tcg_out_sextract_i64(TCGContext *s, TCGOpcode opc, TCGReg dest, TCGReg arg1, int pos, int len)
{
        tcg_out_op_rrbb(s, opc, dest, arg1, pos, len);
    tcg_wasm_out_extract(s, dest, arg1, pos, len, TCG_TYPE_I64, true);
}
static void tcg_out_ext8s(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg)
{
    tcg_out_ext8s(s, type, ret, arg);
    tcg_wasm_out_ext8s(s, type, ret, arg);
}
static void tcg_out_ext16s(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg)
{
    tcg_out_ext16s(s, type, ret, arg);
    tcg_wasm_out_ext16s(s, type, ret, arg);
}
static void tcg_out_ext8u(TCGContext *s, TCGReg ret, TCGReg arg)
{
    tcg_out_ext8u(s, ret, arg);
    tcg_wasm_out_ext8u(s, ret, arg);
}
static void tcg_out_ext16u(TCGContext *s, TCGReg ret, TCGReg arg)
{
    tcg_out_ext16u(s, ret, arg);
    tcg_wasm_out_ext16u(s, ret, arg);
}
static void tcg_out_ext32s(TCGContext *s, TCGReg ret, TCGReg arg)
{
    tcg_out_ext32s(s, ret, arg);
    tcg_wasm_out_ext32s(s, ret, arg);
}
static void tcg_out_ext32u(TCGContext *s, TCGReg ret, TCGReg arg)
{
    tcg_out_ext32u(s, ret, arg);
    tcg_wasm_out_ext32u(s, ret, arg);
}
static void tcg_out_exts_i32_i64(TCGContext *s, TCGReg ret, TCGReg arg)
{
    tcg_out_exts_i32_i64(s, ret, arg);
    tcg_wasm_out_exts_i32_i64(s, ret, arg);
}
static void tcg_out_extu_i32_i64(TCGContext *s, TCGReg ret, TCGReg arg)
{
    tcg_out_extu_i32_i64(s, ret, arg);
    tcg_wasm_out_extu_i32_i64(s, ret, arg);
}

static void tcg_out_extrl_i64_i32(TCGContext *s, TCGReg rd, TCGReg rs)
{
    tcg_out_extrl_i64_i32(s, rd, rs);
    tcg_wasm_out_extrl_i64_i32(s, rd, rs);
}

static bool tcg_out_mov(TCGContext *s, TCGType type, TCGReg ret, TCGReg arg)
{
    tcg_out_op_rr(s, INDEX_op_mov, ret, arg);
    tcg_wasm_out_mov(s, type, ret, arg);
    return true;
}
static void tcg_out_movi(TCGContext *s, TCGType type,
                        TCGReg ret, tcg_target_long arg)
{
    if (arg == sextract32(arg, 0, 20)) {
        tcg_out_op_ri(s, INDEX_op_tci_movi, ret, arg);
    } else {
        new_pool_label(s, arg, 20, s->code_ptr, 0);
        uint32_t insn = 0;
        insn = deposit32(insn, 0, 8, INDEX_op_tci_movl);
        insn = deposit32(insn, 8, 4, ret);
        tcg_tci_out32(s, insn);
    }
    tcg_wasm_out_movi(s, type, ret, arg);
}
static void tcg_out_addi_ptr(TCGContext *s, TCGReg rd, TCGReg rs,
                             tcg_target_long imm)
{
    g_assert_not_reached();
}
static bool tcg_out_xchg(TCGContext *s, TCGType type, TCGReg r1, TCGReg r2)
{
    return false;
}
static void tcg_out_exit_tb(TCGContext *s, uintptr_t arg)
{
    tcg_tci_out_exit_tb(s, arg);
    tcg_wasm_out_exit_tb(s, arg);
}
static void tcg_out_goto_tb(TCGContext *s, int which)
{
    tcg_tci_out_goto_tb(s, which);
    tcg_wasm_out_goto_tb(s, which);
}
static bool tcg_out_sti(TCGContext *s, TCGType type, TCGArg val,
                        TCGReg base, intptr_t ofs)
{
    return false;
}
static void tcg_out_call(TCGContext *s, const tcg_insn_unit *target,
                         const TCGHelperInfo *info)
{
    tcg_tci_out_call(s, target, info);
    tcg_wasm_out_call(s, target, info);
}


/* ===== qemu 11 OUTOP dispatch (dual emission: shared TCI + wasm) ===== */

static void tgen_qemu_ld(TCGContext *s, TCGType type, TCGReg data,
                         TCGReg addr, MemOpIdx oi)
{
    /* TCI half: standard encoding understood by tcg/tci.c (the fallback) */
    if (oi & ~0xffff) {
        tcg_out_movi(s, TCG_TYPE_I32, TCG_REG_TMP, oi);
        tcg_out_op_rrr(s, INDEX_op_tci_qemu_ld_rrr, data, addr, TCG_REG_TMP);
    } else {
        tcg_out_op_rrm(s, INDEX_op_qemu_ld, data, addr, oi);
    }
    /* wasm half */
    TCGArg args[3] = { data, addr, oi };
    tcg_wasm_out_qemu_ld(s, args, type == TCG_TYPE_I64);
}

static const TCGOutOpQemuLdSt outop_qemu_ld = {
    .base.static_constraint = C_O1_I1(r, r),
    .out = tgen_qemu_ld,
};

static const TCGOutOpQemuLdSt2 outop_qemu_ld2 = {
    .base.static_constraint = C_NotImplemented,
};

static void tgen_qemu_st(TCGContext *s, TCGType type, TCGReg data,
                         TCGReg addr, MemOpIdx oi)
{
    if (oi & ~0xffff) {
        tcg_out_movi(s, TCG_TYPE_I32, TCG_REG_TMP, oi);
        tcg_out_op_rrr(s, INDEX_op_tci_qemu_st_rrr, data, addr, TCG_REG_TMP);
    } else {
        tcg_out_op_rrm(s, INDEX_op_qemu_st, data, addr, oi);
    }
    TCGArg args[3] = { data, addr, oi };
    tcg_wasm_out_qemu_st(s, args, type == TCG_TYPE_I64);
}

static const TCGOutOpQemuLdSt outop_qemu_st = {
    .base.static_constraint = C_O0_I2(r, r),
    .out = tgen_qemu_st,
};

static const TCGOutOpQemuLdSt2 outop_qemu_st2 = {
    .base.static_constraint = C_NotImplemented,
};

#define T32(type)  ((type) == TCG_TYPE_I32)

static TCGConstraintSetIndex cset_i32_only(TCGType type, unsigned flags)
{
    return type == TCG_TYPE_I32 ? C_O1_I2(r, r, r) : C_NotImplemented;
}

static TCGConstraintSetIndex cset_i32_only_4(TCGType type, unsigned flags)
{
    return type == TCG_TYPE_I32 ? C_O2_I2(r, r, r, r) : C_NotImplemented;
}

/* ---- binary ALU: ktock's combined wrappers emit TCI + wasm ---- */
static void tgen_add(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_add(s, INDEX_op_add, a0, a1, a2); }
static const TCGOutOpBinary outop_add = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_add };

static void tgen_sub(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_sub(s, INDEX_op_sub, a0, a1, a2); }
static const TCGOutOpSubtract outop_sub = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_sub };

static void tgen_mul(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_mul(s, INDEX_op_mul, a0, a1, a2); }
static const TCGOutOpBinary outop_mul = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_mul };

static void tgen_and(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_and(s, INDEX_op_and, a0, a1, a2); }
static const TCGOutOpBinary outop_and = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_and };

static void tgen_or(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_or(s, INDEX_op_or, a0, a1, a2); }
static const TCGOutOpBinary outop_or = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_or };

static void tgen_xor(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_xor(s, INDEX_op_xor, a0, a1, a2); }
static const TCGOutOpBinary outop_xor = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_xor };

/* andc/orc/eqv/nand/nor: dual wrappers (tci op + wasm) */
static void tgen_andc(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_op_rrr(s, INDEX_op_andc, a0, a1, a2); tcg_wasm_out_andc(s, a0, a1, a2); }
static const TCGOutOpBinary outop_andc = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_andc };

static void tgen_orc(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_op_rrr(s, INDEX_op_orc, a0, a1, a2); tcg_wasm_out_orc(s, a0, a1, a2); }
static const TCGOutOpBinary outop_orc = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_orc };

static void tgen_eqv(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_op_rrr(s, INDEX_op_eqv, a0, a1, a2); tcg_wasm_out_eqv(s, a0, a1, a2); }
static const TCGOutOpBinary outop_eqv = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_eqv };

static void tgen_nand(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_op_rrr(s, INDEX_op_nand, a0, a1, a2); tcg_wasm_out_nand(s, a0, a1, a2); }
static const TCGOutOpBinary outop_nand = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_nand };

static void tgen_nor(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_op_rrr(s, INDEX_op_nor, a0, a1, a2); tcg_wasm_out_nor(s, a0, a1, a2); }
static const TCGOutOpBinary outop_nor = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_nor };

/* div/rem (signedness via op) */
static void tgen_divs(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_div_s(s, INDEX_op_divs, t, a0, a1, a2); }
static const TCGOutOpBinary outop_divs = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_divs };

static void tgen_divu(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_div_u(s, INDEX_op_divu, t, a0, a1, a2); }
static const TCGOutOpBinary outop_divu = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_divu };

static void tgen_rems(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_rem_s(s, INDEX_op_rems, t, a0, a1, a2); }
static const TCGOutOpBinary outop_rems = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_rems };

static void tgen_remu(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_i64_calc_rem_u(s, INDEX_op_remu, t, a0, a1, a2); }
static const TCGOutOpBinary outop_remu = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_remu };

/* shifts/rotates (type-dispatching wrappers) */
static void tgen_shl(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_shl(s, INDEX_op_shl, t, a0, a1, a2); }
static const TCGOutOpBinary outop_shl = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_shl };

static void tgen_shr(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_shr_u(s, INDEX_op_shr, t, a0, a1, a2); }
static const TCGOutOpBinary outop_shr = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_shr };

static void tgen_sar(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_shr_s(s, INDEX_op_sar, t, a0, a1, a2); }
static const TCGOutOpBinary outop_sar = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_sar };

static void tgen_rotl(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{
    tcg_out_op_rrr(s, INDEX_op_rotl, a0, a1, a2);
    if (T32(t)) { tcg_wasm_out_i32_rotl(s, a0, a1, a2); }
    else { tcg_wasm_out_i64_calc_rotl(s, a0, a1, a2); }
}
static const TCGOutOpBinary outop_rotl = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_rotl };

static void tgen_rotr(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{
    tcg_out_op_rrr(s, INDEX_op_rotr, a0, a1, a2);
    if (T32(t)) { tcg_wasm_out_i32_rotr(s, a0, a1, a2); }
    else { tcg_wasm_out_i64_calc_rotr(s, a0, a1, a2); }
}
static const TCGOutOpBinary outop_rotr = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_rotr };

/* clz/ctz (reg args: 3-arg with value-for-zero) */
static void tgen_clz(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{
    if (T32(t)) { tcg_out_clz32(s, INDEX_op_clz, a0, a1, a2); }
    else { tcg_out_clz64(s, INDEX_op_clz, a0, a1, a2); }
}
static const TCGOutOpBinary outop_clz = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_clz };

static void tgen_ctz(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{
    if (T32(t)) { tcg_out_ctz32(s, INDEX_op_ctz, a0, a1, a2); }
    else { tcg_out_ctz64(s, INDEX_op_ctz, a0, a1, a2); }
}
static const TCGOutOpBinary outop_ctz = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_ctz };

/* mul high (i64-only wasm emitters exist in ktock? keep NotImplemented for now) */
/* mul-high (i32 wrappers exist; i64 guests not targeted) */
static void tgen_mulsh(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_op_rrr(s, INDEX_op_mulsh, a0, a1, a2); tcg_wasm_out_mulsh_i32(s, a0, a1, a2); }
static const TCGOutOpBinary outop_mulsh = {
    .base.static_constraint = C_Dynamic,
    .base.dynamic_constraint = cset_i32_only,
    .out_rrr = tgen_mulsh,
};

static void tgen_muluh(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2)
{ tcg_out_op_rrr(s, INDEX_op_muluh, a0, a1, a2); tcg_wasm_out_muluh_i32(s, a0, a1, a2); }
static const TCGOutOpBinary outop_muluh = {
    .base.static_constraint = C_Dynamic,
    .base.dynamic_constraint = cset_i32_only,
    .out_rrr = tgen_muluh,
};

/* mul2 / div2 (i32-only wrappers; 64-bit guests not targeted) */
static void tgen_mulu2(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2, TCGReg a3)
{ tcg_out_mulu2_i32(s, INDEX_op_mulu2, a0, a1, a2, a3); }
static const TCGOutOpMul2 outop_mulu2 = {
    .base.static_constraint = C_Dynamic,
    .base.dynamic_constraint = (void *)cset_i32_only_4,
    .out_rrrr = tgen_mulu2,
};

static void tgen_muls2(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2, TCGReg a3)
{ tcg_out_muls2_i32(s, INDEX_op_muls2, a0, a1, a2, a3); }
static const TCGOutOpMul2 outop_muls2 = {
    .base.static_constraint = C_Dynamic,
    .base.dynamic_constraint = (void *)cset_i32_only_4,
    .out_rrrr = tgen_muls2,
};

static const TCGOutOpDivRem outop_divs2 = { .base.static_constraint = C_NotImplemented };
static const TCGOutOpDivRem outop_divu2 = { .base.static_constraint = C_NotImplemented };

/* carry ops: not implemented; the middle end expands them */
static const TCGOutOpBinary outop_addco  = { .base.static_constraint = C_NotImplemented };
static const TCGOutOpAddSubCarry outop_addci = { .base.static_constraint = C_NotImplemented };
static const TCGOutOpBinary outop_addcio = { .base.static_constraint = C_NotImplemented };
static const TCGOutOpBinary outop_addc1o = { .base.static_constraint = C_NotImplemented };
static const TCGOutOpAddSubCarry outop_subbo  = { .base.static_constraint = C_NotImplemented };
static const TCGOutOpAddSubCarry outop_subbi = { .base.static_constraint = C_NotImplemented };
static const TCGOutOpAddSubCarry outop_subbio = { .base.static_constraint = C_NotImplemented };
static const TCGOutOpAddSubCarry outop_subb1o = { .base.static_constraint = C_NotImplemented };

/* unary */
static void tgen_neg(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1)
{ tcg_out_neg(s, INDEX_op_neg, a0, a1); }
static const TCGOutOpUnary outop_neg = { .base.static_constraint = C_O1_I1(r, r), .out_rr = tgen_neg };

static void tgen_not(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1)
{ tcg_out_not(s, INDEX_op_not, a0, a1); }
static const TCGOutOpUnary outop_not = { .base.static_constraint = C_O1_I1(r, r), .out_rr = tgen_not };

static void tgen_ctpop(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1)
{
    tcg_out_op_rr(s, INDEX_op_ctpop, a0, a1);
    if (T32(t)) { tcg_wasm_out_ctpop_i32(s, a0, a1); } else { tcg_wasm_out_ctpop_i64(s, a0, a1); }
}
static const TCGOutOpUnary outop_ctpop = { .base.static_constraint = C_O1_I1(r, r), .out_rr = tgen_ctpop };

/* setcond / negsetcond */
static void tgen_setcond(TCGContext *s, TCGType t, TCGCond c, TCGReg ret, TCGReg a1, TCGReg a2)
{
    tcg_out_op_rrrc(s, INDEX_op_setcond, ret, a1, a2, c);
    if (T32(t)) { tcg_wasm_out_setcond_i32(s, c, ret, a1, a2); } else { tcg_wasm_out_setcond_i64(s, c, ret, a1, a2); }
}
static const TCGOutOpSetcond outop_setcond = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_setcond };

static const TCGOutOpSetcond outop_negsetcond = { .base.static_constraint = C_NotImplemented };

/* brcond: the 11 TCI encoding tests a single register (result of a
 * previous setcond), like tcg/tci does; the wasm side tests directly. */
static void tgen_brcond(TCGContext *s, TCGType t, TCGCond c, TCGReg a1, TCGReg a2, TCGLabel *l)
{
    tgen_setcond(s, t, c, TCG_REG_TMP, a1, a2);
    tcg_out_op_rl(s, INDEX_op_brcond, TCG_REG_TMP, l);
    if (T32(t)) { tcg_wasm_out_brcond_i32(s, c, a1, a2, l); } else { tcg_wasm_out_brcond_i64(s, c, a1, a2, l); }
}
static const TCGOutOpBrcond outop_brcond = { .base.static_constraint = C_O0_I2(r, r), .out_rr = tgen_brcond };

/* movcond */
static void tgen_movcond(TCGContext *s, TCGType t, TCGCond c, TCGReg ret,
                         TCGReg c1, TCGArg c2, bool const_c2,
                         TCGArg vt, bool const_vt, TCGArg vf, bool const_vf)
{
    /* no constant-fold variants: materialize via TCI encoding (regs only) */
    tcg_out_op_rrrrrc(s, INDEX_op_movcond, ret, c1, c2, vt, vf, c);
    if (T32(t)) { tcg_wasm_out_movcond_i32(s, c, ret, c1, c2, vt, vf); }
    else { tcg_wasm_out_movcond_i64(s, c, ret, c1, c2, vt, vf); }
}
static const TCGOutOpMovcond outop_movcond = { .base.static_constraint = C_O1_I4(r, r, r, r, r), .out = tgen_movcond };

/* deposit */
static void tgen_deposit(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2, unsigned ofs, unsigned len)
{
    tcg_out_op_rrrbb(s, INDEX_op_deposit, a0, a1, a2, ofs, len);
    if (T32(t)) { tcg_wasm_out_deposit_i32(s, a0, a1, a2, ofs, len); }
    else { tcg_wasm_out_deposit_i64(s, a0, a1, a2, ofs, len); }
}
static const TCGOutOpDeposit outop_deposit = { .base.static_constraint = C_O1_I2(r, r, r), .out_rrr = tgen_deposit };

/* extract / sextract */
static void tgen_extract(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, unsigned ofs, unsigned len)
{
    tcg_out_op_rrbb(s, INDEX_op_extract, a0, a1, ofs, len);
    tcg_wasm_out_extract(s, a0, a1, ofs, len, t, false);
}
static const TCGOutOpExtract outop_extract = { .base.static_constraint = C_O1_I1(r, r), .out_rr = tgen_extract };

static void tgen_sextract(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, unsigned ofs, unsigned len)
{
    tcg_out_op_rrbb(s, INDEX_op_sextract, a0, a1, ofs, len);
    tcg_wasm_out_extract(s, a0, a1, ofs, len, t, true);
}
static const TCGOutOpExtract outop_sextract = { .base.static_constraint = C_O1_I1(r, r), .out_rr = tgen_sextract };

static void tgen_extract2(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, TCGReg a2, unsigned shr)
{
    tcg_out_op_rrrr(s, INDEX_op_extract2, a0, a1, a2, shr);
    if (T32(t)) { tcg_wasm_out_extract2_i32(s, a0, a1, a2, shr); }
    else { tcg_wasm_out_extract2_i64(s, a0, a1, a2, shr); }
}
static const TCGOutOpExtract2 outop_extract2 = {
    .base.static_constraint = C_O1_I2(r, r, r),
    .out_rrr = tgen_extract2,
};

/* bswap */
static void tgen_bswap16(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, unsigned flags)
{
    if (T32(t)) { tcg_out_bswap16_i32(s, INDEX_op_bswap16, a0, a1, flags); } else { tcg_out_bswap16_i64(s, INDEX_op_bswap16, a0, a1, flags); }
}
static const TCGOutOpBswap outop_bswap16 = { .base.static_constraint = C_O1_I1(r, r), .out_rr = tgen_bswap16 };

static void tgen_bswap32(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1, unsigned flags)
{
    if (T32(t)) { tcg_out_bswap32_i32(s, INDEX_op_bswap32, a0, a1, flags); } else { tcg_out_bswap32_i64(s, INDEX_op_bswap32, a0, a1, flags); }
}
static const TCGOutOpBswap outop_bswap32 = { .base.static_constraint = C_O1_I1(r, r), .out_rr = tgen_bswap32 };

static void tgen_bswap64(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1)
{
    tcg_out_bswap64_i64(s, INDEX_op_bswap64, a0, a1, 0);
}
static const TCGOutOpUnary outop_bswap64 = { .base.static_constraint = C_O1_I1(r, r), .out_rr = tgen_bswap64 };

/* i32<->i64 extensions: ktock's dual wrappers */
static void tgen_exts(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1)
{ tcg_out_exts_i32_i64(s, a0, a1); }
static void tgen_extu(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1)
{ tcg_out_extu_i32_i64(s, a0, a1); }
static void tgen_extrl(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1)
{ tcg_out_extrl_i64_i32(s, a0, a1); }
static void tgen_extrh(TCGContext *s, TCGType t, TCGReg a0, TCGReg a1)
{
    tcg_out_op_rr(s, INDEX_op_extrh_i64_i32, a0, a1);
    tcg_wasm_out_extrh_i64_i32(s, a0, a1);
}
static const TCGOutOpUnary outop_extrh_i64_i32 = { .base.static_constraint = C_O1_I1(r, r), .out_rr = tgen_extrh };

/* loads/stores (TCG-internal, on the call stack frame) */
static const TCGOutOpLoad outop_ld8u = { .base.static_constraint = C_O1_I1(r, r), .out = tcg_out_ld8u };
static const TCGOutOpLoad outop_ld8s = { .base.static_constraint = C_O1_I1(r, r), .out = tcg_out_ld8s };
static const TCGOutOpLoad outop_ld16u = { .base.static_constraint = C_O1_I1(r, r), .out = tcg_out_ld16u };
static const TCGOutOpLoad outop_ld16s = { .base.static_constraint = C_O1_I1(r, r), .out = tcg_out_ld16s };
static const TCGOutOpLoad outop_ld32u = { .base.static_constraint = C_O1_I1(r, r), .out = tcg_out_ld32u };
static const TCGOutOpLoad outop_ld32s = { .base.static_constraint = C_O1_I1(r, r), .out = tcg_out_ld32s };
static const TCGOutOpStore outop_st8 = { .base.static_constraint = C_O0_I2(r, r), .out_r = tcg_out_st8 };
static const TCGOutOpStore outop_st16 = { .base.static_constraint = C_O0_I2(r, r), .out_r = tcg_out_st16 };
static const TCGOutOpStore outop_st = { .base.static_constraint = C_O0_I2(r, r), .out_r = tcg_out_st };

void tcg_out_init() {
    current_label_pos = 0;
    env_cached = false;
}

/* Test if a constant matches the constraint. */
static bool tcg_target_const_match(int64_t val, int ct, TCGType type, TCGCond cond, int vece)
{
    return ct & TCG_CT_CONST;
}

static void tcg_out_tb_start(TCGContext *s)
{
    /* nothing to do */
}

bool tcg_target_has_memory_bswap(MemOp memop)
{
    return false;
}


static void tcg_out_mb(TCGContext *s, unsigned a0)
{
    tcg_out_op_v(s, INDEX_op_mb);
    tcg_wasm_out8(s, 0x01); // nop (single-threaded wasm memory ordering)
}

static bool tcg_out_qemu_ld_slow_path(TCGContext *s, TCGLabelQemuLdst *l)
{
    g_assert_not_reached();
}

static bool tcg_out_qemu_st_slow_path(TCGContext *s, TCGLabelQemuLdst *l)
{
    g_assert_not_reached();
}


static void tcg_out_set_carry(TCGContext *s)
{
    /* carry ops are C_NotImplemented for this backend */
    g_assert_not_reached();
}

static void tcg_out_set_borrow(TCGContext *s)
{
    g_assert_not_reached();
}

static TCGConstraintSetIndex tcg_target_op_def(TCGOpcode op, TCGType type, unsigned flags)
{
    g_assert_not_reached();
}

static void tcg_target_init(TCGContext *s)
{
    /* The current code uses uint8_t for tcg operations. */
    tcg_debug_assert(tcg_op_defs_max <= UINT8_MAX);

    /* Registers available for 32 bit operations. */
    tcg_target_available_regs[TCG_TYPE_I64] = BIT(TCG_TARGET_NB_REGS) - 1;
    tcg_target_available_regs[TCG_TYPE_I32] = BIT(TCG_TARGET_NB_REGS) - 1;
    /*
     * The interpreter "registers" are in the local stack frame and
     * cannot be clobbered by the called helper functions.  However,
     * the interpreter assumes a 64-bit return value and assigns to
     * the return value registers.
     */
    tcg_target_call_clobber_regs =
        MAKE_64BIT_MASK(TCG_REG_R0, 128 / TCG_TARGET_REG_BITS);

    s->reserved_regs = 0;
    tcg_regset_set_reg(s->reserved_regs, TCG_REG_TMP);
    tcg_regset_set_reg(s->reserved_regs, TCG_REG_CALL_STACK);

    /* The call arguments come first, followed by the temp storage. */
    tcg_set_frame(s, TCG_REG_CALL_STACK, TCG_STATIC_CALL_ARGS_SIZE,
                  TCG_STATIC_FRAME_SIZE);
}

/* Generate global QEMU prologue and epilogue code. */
static inline void tcg_target_qemu_prologue(TCGContext *s)
{
}
