/*
 * insncount.c — TCG plugin: count executed guest instructions.
 *
 * Used by tests/run.mjs to benchmark emulator throughput (MIPS) over a
 * fixed wall-time window, independent of guest milestones.
 *
 * Usage: -plugin file=insncount.so,count=/path/to/count.txt
 * The counter file always holds the most recent flush:
 *     "<monotonic_ns> <insn_count>\n"
 * Flushed every FLUSH_EVERY executed instructions (one pwrite per ~8M
 * insns — negligible) and once more at qemu exit, so the count survives
 * SIGKILL up to the last flush.
 */
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#include <sys/types.h>

#include "plugins/qemu-plugin.h"

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

static int out_fd = -1;

static _Atomic unsigned long long insn_count;
static unsigned long long flush_mask = (8ULL << 20) - 1;

static void flush_counter(void)
{
	char buf[96];
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	int len = snprintf(buf, sizeof(buf), "%lld.%09ld %llu\n",
		(long long)ts.tv_sec, ts.tv_nsec,
		(unsigned long long)insn_count);
	if (out_fd >= 0) {
		ssize_t r = pwrite(out_fd, buf, len, 0);
		(void)r;
	}
}

static void vcpu_tb_exec(unsigned int cpu_index, void *udata)
{
	insn_count += (unsigned long long)(uintptr_t)udata;
	if ((insn_count & flush_mask) == 0)
		flush_counter();
}

static void vcpu_tb_translate(struct qemu_plugin_tb *tb, void *udata)
{
	size_t n = qemu_plugin_tb_n_insns(tb);
	qemu_plugin_register_vcpu_tb_exec_cb(tb, vcpu_tb_exec,
		QEMU_PLUGIN_CB_NO_REGS, (void *)(uintptr_t)n);
}

static void plugin_exit(void *p)
{
	flush_counter();
	if (out_fd >= 0)
		close(out_fd);
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install(qemu_plugin_id_t id,
	const qemu_info_t *info, int argc, char **argv)
{
	const char *path = NULL;

	for (int i = 0; i < argc; i++) {
		char *opt = argv[i];
		if (g_str_has_prefix(opt, "count=")) {
			path = opt + strlen("count=");
		} else {
			fprintf(stderr, "insncount: unknown argument: %s\n", opt);
			return -1;
		}
	}

	if (path) {
		out_fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
		if (out_fd < 0)
			fprintf(stderr, "insncount: cannot open %s\n", path);
		flush_counter(); /* t0 line: 0 insns */
	}

	qemu_plugin_register_vcpu_tb_trans_cb(id, vcpu_tb_translate, NULL);
	qemu_plugin_register_atexit_cb(id, plugin_exit, NULL);
	return 0;
}
