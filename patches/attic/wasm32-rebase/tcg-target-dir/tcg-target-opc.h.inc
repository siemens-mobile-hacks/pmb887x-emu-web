/* SPDX-License-Identifier: MIT */
/*
 * Internal opcodes for the wasm32 backend.  The TCI bytecode that backs the
 * interpreter fallback is emitted by the shared tcg/tci/tci-emitters.h.inc
 * and interpreted by tcg/tci.c, so reuse its internal opcode set.
 */
#include "../tci/tcg-target-opc.h.inc"
