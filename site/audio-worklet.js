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
    // spend its whole life one frame short.
    this.prime = Math.round(sampleRate * (options?.processorOptions?.prime ?? 0.08));
    this.priming = true;
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
    }

    const ratio = this.freq > 0 ? this.freq / sampleRate : 1;
    const avail = (Atomics.load(hdr, H_WRITE) - this.read) | 0;

    if (this.priming) {
      if (avail < this.prime) {
        return true;
      }
      this.priming = false;
    }

    // +1 for the interpolation partner of the last frame.
    const need = Math.ceil(this.pos + n * ratio) + 1;
    if (avail < need) {
      Atomics.add(hdr, H_UNDER, 1);
      this.priming = true;
      this.pos = 0;
      return true;    // a clean 2.7 ms gap beats a torn half-buffer
    }

    const pcm = this.pcm, mask = this.mask, ch = this.channels;
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

    const used = pos | 0;
    this.read = (base + used) | 0;
    this.pos = pos - used;
    Atomics.store(hdr, H_READ, this.read);
    return true;
  }
}

registerProcessor("qemu-audio", QemuAudio);
