/*
 * Browser entry points for the Siemens fullflash key recalculation and ESN
 * recovery that pmb887x-emu does natively.
 *
 * The page cannot get this from qemu: the algorithm lives entirely in the
 * pmb887x-emu launcher (src/siemens_recalc.cpp), and the browser build
 * compiles qemu alone.  So the launcher's file is compiled here, unmodified,
 * into a small standalone module the page loads next to boards.tar.
 *
 * It is #included rather than linked, on purpose.  The 2^32 ESN sweep needs
 * siemens_recalc.cpp's file-local md5Transform()/MD5_INIT/rd32, and the
 * sweep has to be re-expressed here anyway (see sr_scan): siemensRecoverEsn()
 * owns its own std::thread pool and runs to completion, which in a browser
 * means no progress, no cancel and no way to spread the work over workers.
 * Rebuilding it on the public siemensCalcKeys() instead would cost two MD5
 * compressions per candidate where the real loop needs one.  Including the
 * translation unit keeps the arithmetic byte-identical to upstream and
 * leaves the submodule untouched.
 *
 * siemensRecoverEsn() itself is never called from here. Its std::thread pool
 * still compiles, but nothing reaches it, so the linker drops it and the
 * module needs no pthread support of its own.
 */
#include "../../pmb887x-emu/src/siemens_recalc.cpp"

#include <emscripten.h>

#include <algorithm>
#include <cstring>

namespace {

// The image under work. The page writes it straight into this buffer through
// HEAPU8 so a 64 MiB fullflash is copied into the module once, not twice.
std::vector<uint8_t> g_flash;

// Flat mirror of SiemensIdentity for JS, which reads it out of the heap by
// offset. Keep the layout in sync with readIdentity() in site/recalc.js.
struct SrIdentity {
	uint32_t ok;
	uint32_t skey;
	uint32_t useBootKey;   // hasBootKey && the BootKey is not blank
	uint32_t reserved;
	char     imei[16];     // 15 digits, NUL padded
	uint8_t  bootKey[16];
	uint8_t  hash[16];
};

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uint8_t *sr_flash_alloc(uint32_t len) {
	g_flash.assign(len, 0);
	return g_flash.data();
}

EMSCRIPTEN_KEEPALIVE uint8_t *sr_flash_ptr(void) {
	return g_flash.data();
}

EMSCRIPTEN_KEEPALIVE void sr_flash_free(void) {
	std::vector<uint8_t>().swap(g_flash);
}

// Reads the IMEI, SKEY and stored keys. Returns 1 when the image carries
// enough to recover an ESN from.
EMSCRIPTEN_KEEPALIVE int sr_read_identity(SrIdentity *out) {
	memset(out, 0, sizeof(*out));

	const SiemensIdentity id = siemensReadIdentity(g_flash);
	out->ok = id.ok ? 1 : 0;
	out->skey = id.skey;
	out->useBootKey = (id.hasBootKey && !isBlank(id.bootKey)) ? 1 : 0;
	memcpy(out->imei, id.imei.data(), std::min<size_t>(id.imei.size(), sizeof(out->imei) - 1));
	memcpy(out->bootKey, id.bootKey.data(), 16);
	memcpy(out->hash, id.hash.data(), 16);
	return out->ok;
}

// Recalculates the keys in place for the given identity. Returns the number
// of items rewritten, or -1 when the layout was not recognized. The joined
// result log goes into logBuf (truncated to logCap, always NUL terminated).
EMSCRIPTEN_KEEPALIVE int sr_recalc(const char *imei, uint32_t esn, uint32_t skey,
	int *outComplete, char *logBuf, uint32_t logCap) {
	SiemensKeys keys;
	keys.imei = imei;
	keys.esn = esn;
	keys.skey = skey;
	// Only internal consistency matters to the emulator, so the master codes
	// are the service key as well — what pmb887x-emu's main.cpp does.
	keys.masterKeys.fill(skey);

	const SiemensRecalcResult result = siemensRecalcFullflash(g_flash, keys);

	if (logCap) {
		std::string joined;
		for (const std::string &line : result.log) {
			if (!joined.empty())
				joined += '\n';
			joined += line;
		}
		const size_t n = std::min<size_t>(joined.size(), logCap - 1);
		memcpy(logBuf, joined.data(), n);
		logBuf[n] = '\0';
	}

	*outComplete = result.complete ? 1 : 0;
	return result.structureOk ? (int) result.replaced : -1;
}

/*
 * One bounded slice of the ESN sweep: candidates start, start+stride,
 * start+2*stride, ... , `count` of them. The caller (site/recalc-worker.js)
 * runs one slice per turn of the event loop so it can report progress and
 * take a cancel between slices, and gives worker i of n stride = n, start = i.
 *
 * Body and padding trick are siemensRecoverEsn()'s, verbatim: both hashed
 * messages are 16 bytes, so only X[0..3] move. One MD5 compression per
 * candidate against the BootKey, two when only the bootcore HASH is known.
 *
 * Returns 1 and writes *outEsn on a hit, 0 otherwise.
 */
EMSCRIPTEN_KEEPALIVE int sr_scan(uint32_t skey, const uint8_t *target16, int useBootKey,
	uint32_t start, uint32_t stride, uint32_t count, uint32_t *outEsn) {
	uint32_t target[4];
	for (int i = 0; i < 4; i++)
		target[i] = rd32(target16 + i * 4);

	uint32_t X[16] = {};
	uint32_t Y[16] = {};
	X[4] = Y[4] = 0x80;
	X[14] = Y[14] = 128;

	uint64_t candidate = start;
	for (uint32_t n = 0; n < count && candidate < 0x100000000ULL; n++, candidate += stride) {
		const uint32_t value = (uint32_t) candidate;
		X[0] = value;
		X[1] = skey;
		X[2] = value ^ (value >> 24) ^ (skey << 8);
		X[3] = skey ^ (skey >> 24) ^ (X[2] << 8);

		uint32_t h[4] = { MD5_INIT[0], MD5_INIT[1], MD5_INIT[2], MD5_INIT[3] };
		md5Transform(h, X);
		if (!useBootKey) {
			Y[0] = h[0];
			Y[1] = h[1];
			Y[2] = h[2];
			Y[3] = h[3];
			h[0] = MD5_INIT[0];
			h[1] = MD5_INIT[1];
			h[2] = MD5_INIT[2];
			h[3] = MD5_INIT[3];
			md5Transform(h, Y);
		}

		if (h[0] == target[0] && h[1] == target[1] && h[2] == target[2] && h[3] == target[3]) {
			*outEsn = value;
			return 1;
		}
	}
	return 0;
}

// Forward check of one ESN against the stored key — what siemensRecoverEsn()
// confirms its own hit with, and what the page confirms a cached ESN with.
EMSCRIPTEN_KEEPALIVE int sr_verify(uint32_t esn, uint32_t skey, const uint8_t *target16,
	int useBootKey) {
	std::array<uint8_t, 16> bootKey, hash;
	siemensCalcKeys(esn, skey, bootKey, hash);
	return memcmp((useBootKey ? bootKey : hash).data(), target16, 16) == 0 ? 1 : 0;
}

} // extern "C"
