/*
 * Browser entry points for the Siemens fullflash code pmb887x-emu carries
 * as a library: src/siemens ("siemensfw", namespace SiemensFW), compiled
 * here into a small standalone module the page loads next to boards.tar
 * (scripts/build-recalc-wasm.sh builds the library sources + this glue).
 *
 * The page cannot get this from qemu: the algorithm lives in pmb887x-emu,
 * not in the emulator qemu builds. Everything the page needs from it:
 *
 *   sr_probe          which phone a fullflash came off (probeFullflash) —
 *                     the Siemens half of the page's device detection, with
 *                     the library as the source of truth
 *   sr_read_identity  the IMEI / SKEY / keys an image carries
 *   sr_recalc         rewrite the keys for an IMEI/ESN (recalculateFullflash)
 *   sr_scan           one bounded slice of the 2^32 ESN sweep
 *   sr_verify         forward check of one ESN against a stored key
 *
 * The sweep is re-expressed here (sr_scan) instead of calling the library's
 * recoverEsn(): that one owns a std::thread pool and runs to completion,
 * which in a browser means no progress, no cancel and no way to spread the
 * work over workers. sr_scan uses the same batched MD5 primitive
 * (crypto/md5.h md5Batch) with the same message layout recoverEsn()'s own
 * BKEY/HASH method hashes, so the arithmetic stays upstream's — only the
 * scheduling is the page's.
 */

#include "crypto/md5.h"
#include "siemens/crypto.h"
#include "siemens/eeprom.h"
#include "siemens/fullflash.h"
#include "siemens/recalc.h"
#include "utils/binary.h"

#include <emscripten.h>
#include <spdlog/sinks/base_sink.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cstring>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

// The image under work. The page writes it straight into this buffer through
// HEAPU8 so a 64 MiB fullflash is copied into the module once, not twice.
std::vector<uint8_t> g_flash;

// The library logs through spdlog (recalculateFullflash explains what it
// rewrote). Capture it instead of stdout: the page shows the log next to a
// failed recalc, and a wasm module has no stdout worth reading anyway.
std::string g_log;

class CaptureSink final : public spdlog::sinks::base_sink<std::mutex> {
protected:
	void sink_it_(const spdlog::details::log_msg &msg) override {
		if (!g_log.empty())
			g_log += '\n';
		g_log.append(msg.payload.data(), msg.payload.size());
	}

	void flush_() override {
	}
};

// Installed before any sr_* entry point can run, so no log line is lost.
__attribute__((constructor)) static void installLogCapture() {
	auto logger = std::make_shared<spdlog::logger>("siemensfw", std::make_shared<CaptureSink>());
	logger->set_level(spdlog::level::info);
	logger->flush_on(spdlog::level::info);
	spdlog::set_default_logger(std::move(logger));
}

// probeFullflash() reads its image from a file, and only ever seeks — 16
// bytes at each of four fixed offsets — so the page's head of the flash
// (PROBE_HEAD in site/fullflashes.js, sized to cover the farthest one) is
// all it needs to see. MEMFS holds it for the lifetime of the call.
constexpr const char *PROBE_PATH = "/siemensfw-probe.bin";

// Flat mirrors for JS, which reads them out of the heap by offset. Keep the
// layouts in sync with site/recalc.js and site/siemensfw.js.
struct SrIdentity {
	uint32_t ok;
	uint32_t skey;
	uint32_t useBootKey;   // a usable BKEY (block 52/320, consistent with the bootcore HASH)
	uint32_t reserved;
	char     imei[16];     // 15 digits, NUL padded
	uint8_t  bootKey[16];
	uint8_t  hash[16];
};

struct SrProbe {
	uint32_t found;
	char vendor[24];   // "SIEMENS" / "BENQ-SIEMENS"
	char model[24];    // e.g. "S75" — what the record says, not the board id
	char device[40];   // the library's board name: "siemens-" + lower(model)
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

// Reads the IMEI, SKEY and stored keys (getFullflashInfo). Returns 1 when
// the image carries enough to recover an ESN from: an IMEI, the service key
// and a key to sweep against (BKEY, or the bootcore HASH the BKEY would
// hash to). Which of the two `useBootKey` says — the same choice the
// library's own recoverEsn() makes.
EMSCRIPTEN_KEEPALIVE int sr_read_identity(SrIdentity *out) {
	memset(out, 0, sizeof(*out));

	SiemensFW::Eeprom eeprom(g_flash);
	auto info = SiemensFW::getFullflashInfo(eeprom, g_flash);
	if (!info)
		return out->ok = 0;

	out->ok = !info->imei.empty() && info->skey.size() == 4 &&
		(info->bkey.size() == 16 || info->hash.size() == 16);
	out->skey = info->skey.size() == 4 ? readUInt32LE(info->skey.data()) : 0;
	out->useBootKey = info->bkey.size() == 16 ? 1 : 0;
	memcpy(out->imei, info->imei.data(), std::min<size_t>(info->imei.size(), sizeof(out->imei) - 1));
	memcpy(out->bootKey, info->bkey.data(), std::min(info->bkey.size(), sizeof(out->bootKey)));
	memcpy(out->hash, info->hash.data(), std::min(info->hash.size(), sizeof(out->hash)));
	return out->ok;
}

// Recalculates the keys in place for the given identity (recalculateFullflash).
// Returns 1 when something had to be rewritten, 0 when the image already
// carried the right keys, or -1 when the layout was not recognized. The
// library's log goes into logBuf (truncated to logCap, always NUL terminated).
EMSCRIPTEN_KEEPALIVE int sr_recalc(const char *imei, uint32_t esn, uint32_t skey,
	int *outComplete, char *logBuf, uint32_t logCap) {
	SiemensFW::Keys keys;
	keys.imei = imei;
	keys.esn = esn;
	keys.skey = skey;
	// Only internal consistency matters to the emulator, so the master codes
	// are the service key as well — what pmb887x-emu's main.cpp does.
	keys.masterKeys.fill(skey);

	g_log.clear();
	auto result = SiemensFW::recalculateFullflash(g_flash, keys);

	if (logCap) {
		const size_t n = std::min<size_t>(g_log.size(), logCap - 1);
		memcpy(logBuf, g_log.data(), n);
		logBuf[n] = '\0';
	}

	if (!result)
		return -1;
	*outComplete = result->complete ? 1 : 0;
	return result->changed ? 1 : 0;
}

/*
 * One bounded slice of the ESN sweep: batches of MD5_BATCH_SIZE consecutive
 * candidates, the first at `start`, the next `stride` candidates later, and
 * so on for at most `count` candidates (whole batches only, and never past
 * the end of the 2^32 space — a count of 0xffffffff still reaches the last
 * batch). start and stride are multiples of MD5_BATCH_SIZE: worker i of n
 * sweeps start = i * MD5_BATCH_SIZE, stride = n * MD5_BATCH_SIZE, so the
 * workers partition the space exactly. The caller (site/recalc-worker.js)
 * runs one slice per turn of the event loop so it can report progress and
 * take a cancel between slices.
 *
 * Message layout and padding are recoverEsn()'s BKEY/HASH method, verbatim:
 * both hashed messages are 16 bytes, so only words 0..3 move, and one batch
 * costs one md5Batch() (two when only the bootcore HASH is known and the
 * BKEY it came from has to be derived first).
 *
 * Returns 1 and writes *outEsn on a hit, 0 otherwise.
 */
EMSCRIPTEN_KEEPALIVE int sr_scan(uint32_t skey, const uint8_t *target16, int useBootKey,
	uint32_t start, uint32_t stride, uint32_t count, uint32_t *outEsn) {
	uint32_t target[4];
	for (size_t index = 0; index < 4; index++)
		target[index] = readUInt32LE(target16 + index * 4);

	uint64_t scanned = 0;
	for (uint64_t first = start; scanned < count && first + MD5_BATCH_SIZE <= 0x100000000ULL;
		first += stride, scanned += MD5_BATCH_SIZE) {
		Md5BlockBatch blocks{};
		blocks[1].fill(skey);
		blocks[4].fill(0x80);
		blocks[14].fill(128);
		for (size_t lane = 0; lane < MD5_BATCH_SIZE; lane++) {
			uint32_t candidate = (uint32_t) (first + lane);
			blocks[0][lane] = candidate;
			blocks[2][lane] = candidate ^ (candidate >> 24) ^ (skey << 8);
			blocks[3][lane] = skey ^ (skey >> 24) ^ (blocks[2][lane] << 8);
		}

		Md5DigestBatch digest;
		md5Batch(digest, blocks);
		if (!useBootKey) {
			Md5BlockBatch hashBlocks{};
			for (size_t word = 0; word < 4; word++)
				hashBlocks[word] = digest[word];
			hashBlocks[4].fill(0x80);
			hashBlocks[14].fill(128);
			md5Batch(digest, hashBlocks);
		}

		for (size_t lane = 0; lane < MD5_BATCH_SIZE; lane++) {
			if (digest[0][lane] == target[0] && digest[1][lane] == target[1] &&
				digest[2][lane] == target[2] && digest[3][lane] == target[3]) {
				*outEsn = (uint32_t) (first + lane);
				return 1;
			}
		}
	}
	return 0;
}

// Forward check of one ESN against the stored key — what the library
// confirms its own sweep hits with (calculateBkeyAndHash), and what the page
// confirms a cached ESN with.
EMSCRIPTEN_KEEPALIVE int sr_verify(uint32_t esn, uint32_t skey, const uint8_t *target16,
	int useBootKey) {
	std::array<uint8_t, 16> bkey, hash;
	SiemensFW::calculateBkeyAndHash(esn, skey, bkey, hash);
	return memcmp((useBootKey ? bkey : hash).data(), target16, 16) == 0 ? 1 : 0;
}

// Which Siemens phone the image came off: the library's probeFullflash(),
// verbatim — vendor at one of its four fixed offsets ("SIEMENS" or
// "BENQ-SIEMENS"), model at the 16 bytes before it, board name derived as
// "siemens-" + lowercase(model). Returns 0 when the image is not a Siemens
// fullflash (LG and the rest are the JS fallback's business).
EMSCRIPTEN_KEEPALIVE int sr_probe(const uint8_t *head, uint32_t len, SrProbe *out) {
	memset(out, 0, sizeof(*out));

	{
		std::ofstream file(PROBE_PATH, std::ios::binary | std::ios::trunc);
		if (!file)
			return 0;
		file.write((const char *) head, (std::streamsize) len);
	}

	auto info = SiemensFW::probeFullflash(PROBE_PATH);
	if (!info)
		return 0;

	out->found = 1;
	memcpy(out->vendor, info->vendor.data(), std::min<size_t>(info->vendor.size(), sizeof(out->vendor) - 1));
	memcpy(out->model, info->model.data(), std::min<size_t>(info->model.size(), sizeof(out->model) - 1));
	memcpy(out->device, info->device.data(), std::min<size_t>(info->device.size(), sizeof(out->device) - 1));
	return 1;
}

} // extern "C"
