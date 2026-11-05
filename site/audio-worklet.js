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
//   9 gap frames (output frames silenced by dropouts)  10 cushion ms
//   11 producer speed x1000 — 9-11 are stats for tools only
//   12 streaming: 0 once the last frame of a stream is in the ring
//   13 ring frames drained by playing faster, 14 ring frames cut by the delay
//   cap, 15 ring frames replayed by playing slower — stats for tools only

const H_CAP = 1, H_CH = 2, H_FREQ = 3, H_READ = 4, H_WRITE = 5,
      H_ACTIVE = 6, H_GEN = 7, H_UNDER = 8, H_GAP = 9, H_PRIME = 10, H_RATE = 11,
      H_STREAMING = 12, H_DRAINED = 13, H_CUT = 14, H_STRETCHED = 15;
const HDR_WORDS = 16;
const HDR_BYTES = HDR_WORDS * 4;

// A cushion banked while the guest rendered slowly is latency once it keeps
// up. Over every DRAIN_WINDOW of output, the lowest the bank went above the
// base cushion was not needed, and it is played out DRAIN_SPEED times faster
// than real time. The pitch stays: the speed-up splices out short stretches
// of input where the sound repeats itself, with a crossfade (time-domain
// WSOLA, as WebRTC's NetEQ shrinks its jitter buffer).
const DRAIN_SPEED = 1.1;
const DRAIN_WINDOW = 2;        // output seconds
const DRAIN_KEEPUP = 0.98;     // producer speed that counts as keeping up
const DRAIN_MIN = 0.02;        // seconds of excess worth draining
const SPLICE_LAG_MIN = 0.004;  // input seconds one splice skips or replays
const SPLICE_LAG_MAX = 0.02;
const SPLICE_FADE = 0.012;     // crossfade, input seconds
const SPLICE_CORR = 0.7;       // how alike the joined stretches must be
const SPLICE_RETRY = 0.005;    // input seconds before trying another spot
const SPLICE_QUIET = 32;       // RMS below which any spot will do
// The delay never stays past DELAY_MAX: beyond it the bank is cut back to the
// cushion at once, an audible jump. PRIME_MAX leaves room under it for the
// 100 ms the producer may run ahead (WASM_AUDIO_PACE_SLACK_NS).
const DELAY_MAX = 0.5;
const PRIME_MAX = 0.4;
// While the producer renders slower than real time, the output slows down
// with it, to STRETCH_MIN of real time at most, at the same pitch: splices
// jump back to a stretch where the sound repeats itself and play it again.
// The speed is the producer's, corrected by how far the bank is from the
// cushion (STRETCH_TAU), and it applies only below STRETCH_BELOW, so the
// jitter of a producer that keeps up never stretches. The ring is far longer
// than DELAY_MAX, so the frames just behind the read cursor are still intact.
const STRETCH_MIN = 0.25;
const STRETCH_BELOW = 0.95;
const STRETCH_TAU = 0.5;       // output seconds
const STRETCH_RATE_TAU = 0.25; // smoothing of the producer speed it follows

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
    this.dropout = false;   // priming again after an underrun: audible gap
    // Producer speed, in ring seconds per output second, and how long the
    // output has been silent.
    this.rate = 1;
    this.fastRate = 1;
    this.rateWrite = 0;
    this.rateFrames = 0;
    this.fastWrite = 0;
    this.quiet = 0;
    this.gen = -1;
    this.pos = 0;     // fractional read position within the ring
    this.read = 0;    // whole frames handed to the ring's read cursor
    // The splice in progress: a crossfade of xfLen input frames from
    // position xfAt (in this.pos's frame of reference) to xfSkip frames
    // further on, where reading carries on.
    this.xfLen = 0;
    this.xfAt = 0;
    this.xfSkip = 0;
    this.resetDrain();
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
      this.dropout = false;
      this.resetRate(this.read);
      this.resetDrain();
      if (this.freq > 0) {
        this.configureSplice();
      }
    }

    if (!(this.freq > 0)) {
      return true;    // no voice open yet
    }
    // Before the cursor: once a stream has ended, every frame it wrote is
    // already visible.
    const streaming = Atomics.load(hdr, H_STREAMING) !== 0;
    const write = Atomics.load(hdr, H_WRITE);
    if (!Atomics.load(hdr, H_ACTIVE)) {
      this.mute(write);
      return true;
    }
    const ratio = this.freq / sampleRate;
    let avail = (write - this.read) | 0;
    if (streaming && !(this.priming && avail === 0)) {
      this.measureRate(write, n, ratio);
    } else {
      this.resetRate(write);    // no sound in progress to measure
    }

    if (this.priming) {
      // A stream that has ended plays what it left, however short: nothing
      // more is coming to fill the cushion.
      if (avail === 0 || (streaming && avail < this.prime * this.freq)) {
        if (this.dropout) {
          Atomics.add(hdr, H_GAP, n);
        }
        return true;
      }
      this.priming = false;
      this.dropout = false;
    }

    // +1 for the interpolation partner of the last frame.
    const need = Math.ceil(this.pos + n * ratio) + 1;
    if (avail < need) {
      if (!streaming) {
        // The end of a stream, not a dropout.
        this.render(out, n, ratio, avail);
        this.mute(write);
        return true;
      }
      Atomics.add(hdr, H_UNDER, 1);
      Atomics.add(hdr, H_GAP, n);
      this.dropout = true;
      this.growPrime();
      this.priming = true;
      this.pos = 0;
      this.xfLen = 0;
      this.winDropout = true;
      return true;    // a clean 2.7 ms gap beats a torn half-buffer
    }

    if (this.quiet >= sampleRate && !this.xfLen) {
      this.shedSilence(avail - need - Math.ceil(this.basePrime * this.freq));
      avail = (write - this.read) | 0;
    }
    this.judgeDrain(avail, write, n, ratio);
    if (!this.xfLen && avail - this.pos > DELAY_MAX * this.freq) {
      this.cutDelay(avail);
    } else {
      this.drain(avail, n * ratio);
      this.stretch(avail, n * ratio, streaming);
    }
    const pos = this.render(out, n, ratio, avail);

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

    // Negative after a splice that jumped back.
    const used = Math.floor(pos);
    this.read = (this.read + used) | 0;
    this.pos = pos - used;
    this.xfAt -= used;
    Atomics.store(hdr, H_READ, this.read);
    return true;
  }
}

// Interpolates up to n output frames from the ring, stopping short where it
// runs out (the rest of the output stays zeroed), and crossfades through a
// splice in progress. Returns the new position.
QemuAudio.prototype.render = function (out, n, ratio, avail) {
  const pcm = this.pcm, mask = this.mask, ch = this.channels, base = this.read;
  let pos = this.pos;
  for (let i = 0; i < n; i++) {
    if (this.xfLen && pos - this.xfAt >= this.xfLen) {
      pos += this.xfSkip;    // the crossfade is over: go on from the far side
      this.xfLen = 0;
    }
    const f = Math.floor(pos);
    if (f + 1 >= avail) {
      break;
    }
    const t = pos - f;
    const a0 = ((base + f) & mask) * ch;
    const a1 = ((base + f + 1) & mask) * ch;
    if (this.xfLen) {
      const s = this.xfSkip;
      if (f + s + 1 >= avail) {
        break;
      }
      const b0 = ((base + f + s) & mask) * ch;
      const b1 = ((base + f + s + 1) & mask) * ch;
      const g = (pos - this.xfAt) / this.xfLen;
      for (let c = 0; c < out.length; c++) {
        const sc = c < ch ? c : ch - 1;
        const a = pcm[a0 + sc] + (pcm[a1 + sc] - pcm[a0 + sc]) * t;
        const b = pcm[b0 + sc] + (pcm[b1 + sc] - pcm[b0 + sc]) * t;
        out[c][i] = (a + (b - a) * g) / 32768;
      }
    } else {
      for (let c = 0; c < out.length; c++) {
        const sc = c < ch ? c : ch - 1;
        const a = pcm[a0 + sc], b = pcm[a1 + sc];
        out[c][i] = (a + (b - a) * t) / 32768;
      }
    }
    pos += ratio;
  }
  return pos;
};

// Muted (or the page stopped listening): what is banked would otherwise keep
// playing for as long as the cushion lasts, and the drain would count as a
// dropout. Drop it and start the next unmute from the base cushion. A stream
// that ended leaves at most a frame, and the next sound starts the same way.
QemuAudio.prototype.mute = function (write) {
  if (this.read !== write) {
    this.read = write;
    Atomics.store(this.hdr, H_READ, write);
  }
  this.pos = 0;
  this.priming = true;
  this.dropout = false;
  this.prime = this.basePrime;
  this.quiet = 0;
  this.resetRate(write);
  this.resetDrain();
};

QemuAudio.prototype.resetRate = function (write) {
  this.rateWrite = write;
  this.rateFrames = 0;
  this.fastWrite = write;
};

// Producer speed over the last half second of output, in ring seconds per
// output second, and smoothed over STRETCH_RATE_TAU for the stretch to
// follow. It is measured only while a sound is in progress, so it drops
// below 1 only while one is being rendered slower than real time.
QemuAudio.prototype.measureRate = function (write, n, ratio) {
  const recent = (write - this.fastWrite) | 0;
  this.fastWrite = write;
  this.fastRate += (recent / (n * ratio) - this.fastRate) * n /
    (STRETCH_RATE_TAU * sampleRate);
  this.rateFrames += n;
  if (this.rateFrames < sampleRate / 2) {
    return;
  }
  const produced = (write - this.rateWrite) | 0;
  this.rate = produced / (this.rateFrames * ratio);
  Atomics.store(this.hdr, H_RATE, Math.round(this.rate * 1000));
  Atomics.store(this.hdr, H_PRIME, Math.round(this.prime * 1000));
  this.rateWrite = write;
  this.rateFrames = 0;
};

// A cushion banked for a slow sound outlives it while the stream goes on in
// silence: the guest then renders in real time and the backlog would stay as
// latency. Skip the silent frames at the head of the ring, never into the next
// sound.
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
// rendered at the measured speed, and stretched as far as STRETCH_MIN allows,
// plays through without another one, and at least twice the last cushion, so
// a producer that keeps falling short converges in a few dropouts instead of
// stuttering throughout.
const PRIME_HORIZON = 5;
QemuAudio.prototype.growPrime = function () {
  const deficit = Math.max(0, STRETCH_MIN - this.rate) * PRIME_HORIZON;
  this.prime = Math.min(PRIME_MAX, Math.max(this.prime * 2, deficit));
};

QemuAudio.prototype.resetDrain = function () {
  this.winFrames = 0;     // output frames of the current window
  this.winWrite = 0;
  this.winMin = 0;        // the lowest the bank went in it, ring frames
  this.winDropout = false;
  this.drainGoal = 0;     // ring frames still to drain
  this.credit = 0;        // ring frames the speed limit allows to cut
  this.stretchCredit = 0; // ring frames the stretch is behind on replaying
  this.wait = 0;          // ring frames to play before the next try
  this.xfLen = 0;
};

// Splice sizes in ring frames, and the scratch buffers of the search.
QemuAudio.prototype.configureSplice = function () {
  const f = this.freq;
  this.dec = Math.max(1, Math.floor(f / 8000));
  this.fadeFrames = Math.round(SPLICE_FADE * f);
  this.lagMin = Math.round(SPLICE_LAG_MIN * f);
  this.lagMax = Math.round(SPLICE_LAG_MAX * f);
  const span = this.fadeFrames + this.lagMax;
  this.decA = new Float32Array(Math.ceil(this.fadeFrames / this.dec) + 1);
  this.decB = new Float32Array(Math.ceil(span / this.dec) + 1);
  this.fullA = new Float32Array(this.fadeFrames);
  this.fullB = new Float32Array(this.fadeFrames + 2 * this.dec);
};

// Judges, at the end of every DRAIN_WINDOW of output, how much of the bank
// the stream did not need: the lowest it went above the base cushion while
// the producer kept up and nothing dropped out. The cushion for the next
// dropout halves in such a window too, since the slowness it was grown for
// is over.
QemuAudio.prototype.judgeDrain = function (avail, write, n, ratio) {
  if (this.winFrames === 0) {
    this.winWrite = write;
    this.winMin = avail;
  }
  this.winMin = Math.min(this.winMin, avail);
  this.winFrames += n;
  if (this.winFrames < DRAIN_WINDOW * sampleRate) {
    return;
  }
  const rate = ((write - this.winWrite) | 0) / (this.winFrames * ratio);
  const excess = this.winMin - Math.ceil(this.basePrime * this.freq);
  if (!this.winDropout && rate >= DRAIN_KEEPUP) {
    this.drainGoal = excess >= DRAIN_MIN * this.freq ? excess : 0;
    this.prime = Math.max(this.basePrime, this.prime / 2);
  } else {
    this.drainGoal = 0;
  }
  this.winFrames = 0;
  this.winDropout = false;
};

// Plays the excess out faster: one splice whenever the speed limit has
// banked a whole maximal lag, at the next spot where the sound repeats
// itself closely enough.
QemuAudio.prototype.drain = function (avail, consumed) {
  if (this.drainGoal < this.lagMin) {
    this.drainGoal = 0;
    this.credit = 0;
    return;
  }
  this.credit = Math.min(this.credit + (DRAIN_SPEED - 1) * consumed,
                         2 * this.lagMax);
  if (this.xfLen) {
    return;
  }
  if (this.wait > 0) {
    this.wait -= consumed;
    return;
  }
  if (this.credit < this.lagMax) {
    return;
  }
  const p = Math.floor(this.pos);
  const hi = Math.min(this.lagMax, this.drainGoal);
  if (avail - p < hi + this.fadeFrames + Math.ceil(consumed) + 2) {
    return;
  }
  const q = this.findSplice(p, p + this.lagMin, p + hi, SPLICE_CORR);
  if (q === null) {
    this.wait = SPLICE_RETRY * this.freq;
    return;
  }
  const lag = q - p;
  this.splice(lag);
  this.credit -= lag;
  this.drainGoal -= lag;
  Atomics.add(this.hdr, H_DRAINED, lag);
};

// Follows a producer slower than real time: one splice back whenever the
// speed has fallen a whole maximal lag behind, by 1/2 to 1 maximal lag, so
// that back-to-back splices can reach STRETCH_MIN.
QemuAudio.prototype.stretch = function (avail, consumed, streaming) {
  const fill = (avail - this.pos) / this.freq;
  const speed = Math.max(STRETCH_MIN, Math.min(1,
    this.fastRate + (fill - this.prime) / STRETCH_TAU));
  if (!streaming || this.drainGoal > 0 || speed >= STRETCH_BELOW) {
    this.stretchCredit = 0;
    return;
  }
  this.stretchCredit = Math.min(this.stretchCredit + (1 - speed) * consumed,
                                2 * this.lagMax);
  if (this.xfLen) {
    return;
  }
  if (this.wait > 0) {
    this.wait -= consumed;
    return;
  }
  if (this.stretchCredit < this.lagMax) {
    return;
  }
  const p = Math.floor(this.pos);
  if (avail - p < this.fadeFrames + Math.ceil(consumed) + 2) {
    return;
  }
  // Short of half the cushion a dropout is near, and any splice beats one.
  const minCorr = fill < this.prime / 2 ? -Infinity : SPLICE_CORR;
  const q = this.findSplice(p, p - this.lagMax, p - (this.lagMax >> 1),
                            minCorr);
  if (q === null) {
    this.wait = SPLICE_RETRY * this.freq;
    return;
  }
  this.splice(q - p);
  this.stretchCredit -= p - q;
  Atomics.add(this.hdr, H_STRETCHED, p - q);
};

// Past DELAY_MAX the bank is cut back to the cushion in one splice: an
// audible jump, but the delay stays bounded however the producer bursts.
QemuAudio.prototype.cutDelay = function (avail) {
  const p = Math.floor(this.pos);
  const keep = Math.ceil(this.prime * this.freq);
  const hi = avail - p - keep;
  const q = this.findSplice(p, p + Math.max(this.lagMin, hi - this.lagMax),
                            p + hi, -Infinity);
  this.splice(q - p);
  this.drainGoal = 0;
  this.credit = 0;
  Atomics.add(this.hdr, H_CUT, q - p);
};

// Crossfades from the play position to lag frames away, ahead or back.
QemuAudio.prototype.splice = function (lag) {
  this.xfAt = this.pos;
  this.xfLen = this.fadeFrames;
  this.xfSkip = lag;
};

// The ring frames from p on, mixed to mono and box-filtered down by dec.
QemuAudio.prototype.decimate = function (dst, p, count) {
  const pcm = this.pcm, mask = this.mask, ch = this.channels, d = this.dec;
  let at = this.read + p;
  for (let k = 0; k < count; k++) {
    let s = 0;
    for (let j = 0; j < d; j++, at++) {
      const a = (at & mask) * ch;
      s += ch > 1 ? pcm[a] + pcm[a + 1] : pcm[a];
    }
    dst[k] = s;
  }
};

QemuAudio.prototype.mono = function (dst, p, count) {
  const pcm = this.pcm, mask = this.mask, ch = this.channels;
  for (let k = 0, at = this.read + p; k < count; k++, at++) {
    const a = (at & mask) * ch;
    dst[k] = ch > 1 ? (pcm[a] + pcm[a + 1]) / 2 : pcm[a];
  }
};

// The position in [lo, hi] (ring frames, at most a maximal lag apart, ahead
// of p or behind it) where the sound from p on repeats itself best over a
// crossfade: the normalized cross-correlation of the mono mix, searched on a
// 1/dec decimation and refined at the full rate. Returns null when the best
// match is below minCorr and the stretch is not quiet.
QemuAudio.prototype.findSplice = function (p, lo, hi, minCorr) {
  const d = this.dec, w = this.fadeFrames;
  const A = this.decA, B = this.decB;
  const na = Math.floor(w / d);
  const nb = Math.min(B.length, Math.floor((hi - lo + w) / d));
  this.decimate(A, p, na);
  this.decimate(B, lo, nb);
  let ea = 0, eb = 0;
  for (let i = 0; i < na; i++) {
    ea += A[i] * A[i];
    eb += B[i] * B[i];
  }
  let best = -Infinity, bestK = 0;
  for (let k = 0; k + na <= nb; k++) {
    if (k > 0) {
      eb += B[k + na - 1] * B[k + na - 1] - B[k - 1] * B[k - 1];
    }
    let c = 0;
    for (let i = 0; i < na; i++) {
      c += A[i] * B[k + i];
    }
    const nc = c / Math.sqrt(ea * Math.max(eb, 0) + 1);
    if (nc > best) {
      best = nc;
      bestK = k;
    }
  }

  const FA = this.fullA, FB = this.fullB;
  const from = Math.max(lo, lo + bestK * d - d + 1);
  const to = Math.min(hi, lo + bestK * d + d - 1);
  this.mono(FA, p, w);
  this.mono(FB, from, w + to - from);
  let fa = 0;
  for (let i = 0; i < w; i++) {
    fa += FA[i] * FA[i];
  }
  best = -Infinity;
  let at = from, fbBest = 0;
  for (let q = from; q <= to; q++) {
    const o = q - from;
    let c = 0, fb = 0;
    for (let i = 0; i < w; i++) {
      c += FA[i] * FB[o + i];
      fb += FB[o + i] * FB[o + i];
    }
    const nc = c / Math.sqrt(fa * fb + 1);
    if (nc > best) {
      best = nc;
      at = q;
      fbBest = fb;
    }
  }
  this.lastCorr = best;
  const quietEnergy = SPLICE_QUIET * SPLICE_QUIET * w;
  if (best < minCorr && (fa > quietEnergy || fbBest > quietEnergy)) {
    return null;
  }
  return at;
};

registerProcessor("qemu-audio", QemuAudio);
