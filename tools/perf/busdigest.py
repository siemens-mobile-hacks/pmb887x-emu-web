#!/usr/bin/env python3
# busdigest.py QEMU_TREE: patches a temporary digest of the DSP peripheral bus
# into a qemu tree (never commit it; `git -C qemu checkout -- .` drops it).
# Every 2^18 events the patched binary prints to stderr
#   BUSHASH <events> <fnv> cyc=<bus cycles> I= R= W= T= X=
# over each register read and write with its value, each interrupt flag set
# and each I2S word fetched (T) or received (X), every one hashed with the
# running sum of the cycles handed to dsp_bus_advance().  Two builds whose
# bus timing is the same print the same lines on a deterministic boot:
#
#   python3 tools/perf/busdigest.py qemu && ninja -C build/qemu-native-build qemu-system-arm
#   QEMU_BIN=<copy of it> MONITOR=none DISPLAY_MODE=none timeout 150 scripts/run-native.sh \
#     fullflashes/<board>.bin -rtc base=2000-01-01T00:00:00,clock=vm 2> new.err
#   # the same for the reference tree, then compare the common prefix of
#   # `grep BUSHASH` in both.  The S75 and EL71 boots play a startup sound,
#   # so they cover I2S in both directions and timer 2.
#
# Built for the bus deferral (wasm-fast-paths.md D12): run it after a merge
# that touches hw/arm/pmb887x/dsp/peripheral*, against the same tree with
# dsp_bus_get_horizon() returning 0.  A horizon late by 50 cycles diverges
# within the first million events.
import sys
root = sys.argv[1] + '/hw/arm/pmb887x/dsp/'
def sub(path, old, new):
    s = open(root + path).read()
    assert s.count(old) == 1, (path, old, s.count(old))
    open(root + path, 'w').write(s.replace(old, new))

sub('peripheral/interrupt.c', '#include "qemu/osdep.h"\n', '''#include "qemu/osdep.h"
#include <stdio.h>
uint64_t dsp_trace_cycles;
static uint64_t dsp_trace_hash = 1469598103934665603ULL, dsp_trace_count, dsp_trace_tags[8];
void dsp_trace(unsigned tag, uint32_t a, uint32_t b);
void dsp_trace(unsigned tag, uint32_t a, uint32_t b) {
	uint64_t words[3] = { dsp_trace_cycles, ((uint64_t) tag << 32) | a, b };
	for (int i = 0; i < 3; i++)
		dsp_trace_hash = (dsp_trace_hash ^ words[i]) * 1099511628211ULL;
	dsp_trace_tags[tag]++;
	if ((++dsp_trace_count & ((1 << 18) - 1)) == 0)
		fprintf(stderr, "BUSHASH %llu %016llx cyc=%llu I=%llu R=%llu W=%llu T=%llu X=%llu\\n",
			(unsigned long long) dsp_trace_count, (unsigned long long) dsp_trace_hash,
			(unsigned long long) dsp_trace_cycles, (unsigned long long) dsp_trace_tags[0],
			(unsigned long long) dsp_trace_tags[1], (unsigned long long) dsp_trace_tags[2],
			(unsigned long long) dsp_trace_tags[3], (unsigned long long) dsp_trace_tags[4]);
}
''')
sub('peripheral/interrupt.c', '''	g_assert(group < INTERRUPT_GROUP_COUNT);

	qatomic_or(&state->flags[group], flags & dsp_int_valid_mask(device, group));
''', '''	g_assert(group < INTERRUPT_GROUP_COUNT);

	dsp_trace(0, group, flags);
	qatomic_or(&state->flags[group], flags & dsp_int_valid_mask(device, group));
''')
sub('peripheral/internal.h', 'struct dsp_route_t {', '''extern uint64_t dsp_trace_cycles;
void dsp_trace(unsigned tag, uint32_t a, uint32_t b);

struct dsp_route_t {''')
sub('peripheral/internal.h', '''		bus->fallback->ops->read(bus->fallback, address - bus->fallback->config->base, pc, &value);
	return value;
''', '''		bus->fallback->ops->read(bus->fallback, address - bus->fallback->config->base, pc, &value);
	dsp_trace(1, address, value);
	return value;
''')
sub('peripheral/internal.h', '''	if (!device->ops->write(device, route->offset, pc, value))
''', '''	dsp_trace(2, address, value);
	if (!device->ops->write(device, route->offset, pc, value))
''')
sub('peripheral.c', '''void dsp_bus_advance(dsp_bus_t *bus, size_t cycles) {
''', '''void dsp_bus_advance(dsp_bus_t *bus, size_t cycles) {
	dsp_trace_cycles += cycles;
''')
sub('peripheral/i2s.c', '''		state->transmit_fifo[state->transmit_fifo_words++] = state->host.data_read(state->host.opaque, address);
''', '''		state->transmit_fifo[state->transmit_fifo_words++] = state->host.data_read(state->host.opaque, address);
		dsp_trace(3, address, (uint16_t) state->transmit_fifo[state->transmit_fifo_words - 1]);
''')
sub('peripheral/i2s.c', '''				state->host.data_write(state->host.opaque, address, frame[0]);
''', '''				state->host.data_write(state->host.opaque, address, frame[0]);
				dsp_trace(4, address, (uint16_t) frame[0]);
''')
