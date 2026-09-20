# Upstream split plan (branch 1 + branch 2)

Base: 5b24f7b50f (tip of master @ siemens-mobile-hacks/qemu-pmb887x)
Target state: hw/arm/pmb887x exactly as at 474bff9dbe (review pass applied),
minus board.c + flash-blk.c (wasm-only, #ifdef-guarded).

Test per commit: bash tools/perf/build-rev.sh <sha> && node tests/run.mjs --label <l>

## Branch 1: pmb887x-upstream (self-contained, no core changes)
 1. dsp.c + dsp/runtime.c   — dsp_hexdump byte indexing fix; dead #if 0 blocks
 2. fifo.h                  — wrap by compare; total accessor
 3. mod.c                   — ctz32 bit loops in srb_set_icr/isr
 4. mod.h                   — pmb887x_completion_clock()
 5. ssc.c                   — transfer timer on completion clock
 6. vic.c                   — asserted bitmap, unified pending, parent-line cache
 7. gptu.c                  — T0/T1 step to observable boundary; T2/OSEL/OUT sync fixes
 8. tpu.c                   — re-arm only on deadline move; advance gating; event-RAM window
 9. dif_v2.c                — lazy mux tables; pin/request caches; one-bit DMA acks
10. dif_v1.c (subset)       — lazy mux tables; breq cache; run-where-asked (dif_run_transfers);
                              NO burst machinery (dif_can_run_burst/dif_run_word/dif_run_ssi_burst/
                              dif_io_write_run/.write_run/mux_identity/bswap.h)
11. lcd_common.c + s1d13716.c (cast hunks only) — plain casts on per-byte SSI paths
12. dmac.c (subset)         — completion clock; in_run in-callback pickup; QEMU_UNINITIALIZED buffer;
                              NO xlat/write_run/direct/coalescing/stream extraction

## Branch 2: pmb887x-upstream-burst (on top of branch 1)
 1. memory.{h,c} — memory_region_topology_gen() (minimal topo_commit_gen port)
 2. memory.{h,c} — memory_region_write_direct_ok/_dispatch_write_direct
 3. memory.{h,c} — MemoryRegionOps::write_run + memory_region_dispatch_write_run
 4. ssi.{h,c}    — SSIPeripheralClass::transfer_run + ssi_transfer_run + plain casts
 5. dmac.c       — translation windows (topology-keyed), memory-source memcpy,
                   MMIO write fast path (direct dispatch); no run/coalesce yet
 6. lcd_common.c + lcd_common_format.{c,h} + s1d13716.c — transfer_run + row blit
 7. dif_v1.c     — burst machinery (final HEAD state of the file)
 8. dmac.c       — write_run burst + coalescing + stream extraction (final HEAD state)
