// Drains qemu's audio ring straight off the wasm heap.
//
// The ring is a static struct inside the emulator's linear memory (see
// qemu/audio/wasmaudio.c); the heap is a SharedArrayBuffer, so this processor
// reads the very bytes the mixeng wrote — no per-buffer postMessage, and the
// audio render thread never waits on the main thread.
//
// Header layout (int32 words, then int16 frames at byte offset 64):
//   0 magic  1 capacity  2 channels  3 freq  4 read  5 write
//   6 active  7 generation  8 underruns

const H_CAP = 1, H_CH = 2, H_FREQ = 3, H_READ = 4, H_WRITE = 5,
      H_GEN = 7, H_UNDER = 8;
const HDR_WORDS = 16;
const HDR_BYTES = HDR_WORDS * 4;

class QemuAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.hdr = null;
    // How much has to be banked before playback starts, and after every
    // dropout. A guest that renders slower than real time would otherwise
    // spend its whole life one frame short. Times are in output seconds.
    this.basePrime = options?.processorOptions?.prime ?? 0.08;
    this.prime = this.basePrime;
    this.priming = true;
    // Producer speed, in ring seconds per output second, and how long the
    // output has been silent.
    this.rate = 1;
    this.rateWrite = 0;
    this.rateFrames = 0;
    this.quiet = 0;
    this.gen = -1;
    this.pos = 0;     // fractional read position within the ring
    this.read = 0;    // whole frames handed to the ring's read cursor
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d?.type === "ring") {
        this.hdr = new Int32Array(d.buffer, d.ptr, HDR_WORDS);
        const cap = this.hdr[H_CAP];
        this.cap = cap;
        this.mask = cap - 1;
        this.pcm = new Int16Array(d.buffer, d.ptr + HDR_BYTES, cap * 2);
        this.gen = -1;
      } else if (d?.type === "stop") {
        this.dead = true;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const hdr = this.hdr;

    if (this.dead) {
      return false;
    }
    if (!hdr) {
      return true;    // output buffers arrive zeroed
    }

    // A (re)opened voice resets both cursors and republishes the format.
    const gen = Atomics.load(hdr, H_GEN);
    if (gen !== this.gen) {
      this.gen = gen;
      this.freq = hdr[H_FREQ];
      this.channels = hdr[H_CH] || 1;
      this.read = Atomics.load(hdr, H_WRITE);
      Atomics.store(hdr, H_READ, this.read);
      this.pos = 0;
      this.priming = true;
      this.rateWrite = this.read;
      this.rateFrames = 0;
    }

    if (!(this.freq > 0)) {
      return true;    // no voice open yet
    }
    const ratio = this.freq / sampleRate;
    const write = Atomics.load(hdr, H_WRITE);
    const avail = (write - this.read) | 0;
    this.measureRate(write, n, ratio);

    if (this.priming) {
      // A stream that ends before the cushion fills still plays: qemu pads
      // silence once the guest goes quiet, and that tops the ring up.
      if (avail < this.prime * this.freq) {
        return true;
      }
      this.priming = false;
    }

    // +1 for the interpolation partner of the last frame.
    const need = Math.ceil(this.pos + n * ratio) + 1;
    if (avail < need) {
      Atomics.add(hdr, H_UNDER, 1);
      this.growPrime();
      this.priming = true;
      this.pos = 0;
      return true;    // a clean 2.7 ms gap beats a torn half-buffer
    }

    const pcm = this.pcm, mask = this.mask, ch = this.channels;
    if (this.quiet >= sampleRate) {
      this.shedSilence(avail - need - Math.ceil(this.basePrime * this.freq));
    }
    const base = this.read;
    let pos = this.pos;

    for (let i = 0; i < n; i++) {
      const f = pos | 0;
      const t = pos - f;
      const a0 = ((base + f) & mask) * ch;
      const a1 = ((base + f + 1) & mask) * ch;
      for (let c = 0; c < out.length; c++) {
        const sc = c < ch ? c : ch - 1;
        const a = pcm[a0 + sc], b = pcm[a1 + sc];
        out[c][i] = (a + (b - a) * t) / 32768;
      }
      pos += ratio;
    }

    let loud = false;
    for (let c = 0; c < out.length && !loud; c++) {
      const o = out[c];
      for (let i = 0; i < n; i++) {
        if (o[i] !== 0) { loud = true; break; }
      }
    }
    this.quiet = loud ? 0 : this.quiet + n;
    if (this.quiet >= sampleRate) {
      this.prime = this.basePrime;    // between sounds: back to low latency
    }

    const used = pos | 0;
    this.read = (base + used) | 0;
    this.pos = pos - used;
    Atomics.store(hdr, H_READ, this.read);
    return true;
  }
}

// Producer speed over the last half second of output, in ring seconds per
// output second. qemu pads silence while the guest is quiet, so this only
// drops below 1 while a sound is being rendered slower than real time.
QemuAudio.prototype.measureRate = function (write, n, ratio) {
  this.rateFrames += n;
  if (this.rateFrames < sampleRate / 2) {
    return;
  }
  const produced = (write - this.rateWrite) | 0;
  this.rate = produced / (this.rateFrames * ratio);
  this.rateWrite = write;
  this.rateFrames = 0;
};

// A cushion banked for a slow sound outlives it: once the guest goes quiet qemu
// pads in real time and the backlog would stay as latency. Skip the silent
// frames at the head of the ring, never into the next sound.
QemuAudio.prototype.shedSilence = function (excess) {
  const pcm = this.pcm, mask = this.mask, ch = this.channels;
  let skip = 0;
  while (skip < excess) {
    const a = ((this.read + skip) & mask) * ch;
    if (pcm[a] !== 0 || (ch > 1 && pcm[a + 1] !== 0)) {
      break;
    }
    skip++;
  }
  if (skip > 0) {
    this.read = (this.read + skip) | 0;
    Atomics.store(this.hdr, H_READ, this.read);
  }
};

// A dropout mid-sound: bank enough that a sound of PRIME_HORIZON seconds
// rendered at the measured speed plays through without another one, and at
// least twice the last cushion, so a producer that keeps falling short
// converges in a few dropouts instead of stuttering throughout.
const PRIME_HORIZON = 5;
const PRIME_MAX = 4;
QemuAudio.prototype.growPrime = function () {
  const deficit = Math.max(0, 1 - this.rate) * PRIME_HORIZON;
  this.prime = Math.min(PRIME_MAX, Math.max(this.prime * 2, deficit));
};

registerProcessor("qemu-audio", QemuAudio);
