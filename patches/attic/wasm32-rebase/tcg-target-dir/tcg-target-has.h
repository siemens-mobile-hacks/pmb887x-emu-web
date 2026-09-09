/* SPDX-License-Identifier: MIT */
/*
 * Define target-specific opcode support for the wasm32 runtime-JIT backend.
 * Mirrors tcg/tci (same TCI fallback), minus what the wasm emitter has not
 * been taught (gated off -> the middle end expands).
 */
#ifndef TCG_TARGET_HAS_H
#define TCG_TARGET_HAS_H

#define TCG_TARGET_HAS_tst              0

#define TCG_TARGET_HAS_extr_i64_i32     0
#define TCG_TARGET_HAS_qemu_ldst_i128   0

#define TCG_TARGET_extract_valid(type, ofs, len)   1
#define TCG_TARGET_sextract_valid(type, ofs, len)   1
#define TCG_TARGET_deposit_valid(type, ofs, len)    1

#endif
