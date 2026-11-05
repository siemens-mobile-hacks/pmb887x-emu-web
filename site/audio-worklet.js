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
//   cap, 15 ring frames gained by playing slower — stats for tools only

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
// with it at the same pitch. The speed is the producer's, corrected by how
// far the bank is from the cushion (STRETCH_TAU), and it applies only below
// STRETCH_BELOW, so the jitter of a producer that keeps up never stretches.
// A phase vocoder does the slow-down. Until a window of input is banked for
// it, splices jump back to a stretch where the sound repeats itself and play
// it again, down to STRETCH_MIN of real time. The ring is far longer than
// DELAY_MAX, so the frames just behind the read cursor are still intact.
const STRETCH_MIN = 0.25;
const STRETCH_BELOW = 0.95;
const STRETCH_TAU = 0.5;       // output seconds
const STRETCH_RATE_TAU = 0.25; // smoothing of the producer speed it follows

// The vocoder: Hann windows of PV_WINDOW, rounded to a power of two (2048
// frames at 44.1 kHz), every 1/PV_OVERLAP of a window, with identity phase
// locking (Laroche & Dolson 1999). It runs at the ring rate into its own
// overlap-add buffer Y, which render reads like the ring. Entering and
// leaving go through identity frames (unmodified windowed input at speed 1),
// so both switches are sample-exact, and it leaves from PV_EXIT up. Its
// floor PV_MIN is below the producer's lowest STRETCH_MIN, so the bank
// refills and pays back the onsets, which go through at speed 1. An onset is
// a jump in high-frequency energy per PV_BLK input frames to PV_ONSET times
// that of the 8 blocks before it.
const PV_WINDOW = 0.046;       // seconds
const PV_OVERLAP = 4;
const PV_MIN = 0.15;
const PV_EXIT = 0.99;
const PV_STALL = 0.05;         // seconds of Y frozen for want of input = dropout
const PV_ONSET = 8;
const PV_ONSET_FLOOR = 64 * 200 * 200;
const PV_BLK = 64;

// Whether this scope's vocoder code has run once (see warmUp). The scope and
// its compiled code outlive a processor: every boot makes a new one.
let warmedUp = false;

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
    this.pvOn = false;      // playing from the vocoder's Y
    this.resetDrain();
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d?.type === "ring") {
        if (!warmedUp) {
          warmedUp = true;
          this.warmUp();
        }
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
      return this.underrun(n);
    }

    if (this.quiet >= sampleRate && !this.xfLen && !this.pvOn) {
      this.shedSilence(avail - need - Math.ceil(this.basePrime * this.freq));
      avail = (write - this.read) | 0;
    }
    this.judgeDrain(avail, write, n, ratio);
    if (!this.xfLen && !this.pvOn && avail - this.pos > DELAY_MAX * this.freq) {
      this.cutDelay(avail);
    } else {
      this.drain(avail, n * ratio);
      this.stretch(avail, n * ratio, streaming);
    }
    const pos = this.pvOn ? this.pvRender(out, n, ratio, avail)
                          : this.render(out, n, ratio, avail);
    if (pos === null) {
      return this.underrun(n);
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

    // Negative after a splice that jumped back.
    const used = Math.floor(pos);
    this.read = (this.read + used) | 0;
    this.pos = pos - used;
    this.xfAt -= used;
    Atomics.store(hdr, H_READ, this.read);
    return true;
  }
}

// The bank ran out: silence until the cushion is banked again.
QemuAudio.prototype.underrun = function (n) {
  Atomics.add(this.hdr, H_UNDER, 1);
  Atomics.add(this.hdr, H_GAP, n);
  this.dropout = true;
  this.growPrime();
  this.priming = true;
  this.pos = 0;
  this.xfLen = 0;
  this.pvOn = false;
  this.winDropout = true;
  return true;    // a clean 2.7 ms gap beats a torn half-buffer
};

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
  this.pvOn = false;
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
  this.lastCorr = 0;      // of the last splice search, for tools
  this.configurePv();
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
  if (this.xfLen || this.pvOn) {
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

// Follows a producer slower than real time: with the vocoder, which takes the
// speed once per frame, or else with one splice back whenever the speed has
// fallen a whole maximal lag behind, by 1/2 to 1 maximal lag, so that
// back-to-back splices can reach STRETCH_MIN.
QemuAudio.prototype.stretch = function (avail, consumed, streaming) {
  const fill = (avail - this.pos) / this.freq;
  const speed = Math.max(this.pvOn ? PV_MIN : STRETCH_MIN, Math.min(1,
    this.fastRate + (fill - this.prime) / STRETCH_TAU));
  this.pvSpeed = speed;
  if (this.pvOn && !streaming) {
    // Nothing more to read ahead: drop the vocoder where it is.
    this.pos = this.pvMap(this.pvYPos);
    this.pvOn = false;
    return;
  }
  if (this.pvOn) {
    if (this.drainGoal > 0 || speed >= PV_EXIT || fill > DELAY_MAX) {
      this.pvExit = true;
    }
    return;
  }
  if (!streaming || this.drainGoal > 0 || speed >= STRETCH_BELOW) {
    this.stretchCredit = 0;
    return;
  }
  if (!this.xfLen && this.pvEnter(avail)) {
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

// In-place radix-2 complex FFT, forward. pvFft(im, re, ...) is the inverse
// times n. Two stages at a time: the four points of a pair of stages stay in
// locals in between, which halves the memory traffic and the time. Every
// butterfly is still the radix-2 one.
function pvFft(re, im, n, rev, cos, sin) {
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  let h = 1, step = n >> 1;
  for (; 4 * h <= n; h <<= 2, step >>= 2) {
    const step2 = step >> 1;
    for (let i = 0; i < n; i += 4 * h) {
      for (let j = 0; j < h; j++) {
        const p0 = i + j, p1 = p0 + h, p2 = p1 + h, p3 = p2 + h;
        let c = cos[j * step], s = sin[j * step], tr, ti;
        let r0 = re[p0], i0 = im[p0], r1 = re[p1], i1 = im[p1];
        let r2 = re[p2], i2 = im[p2], r3 = re[p3], i3 = im[p3];
        tr = r1 * c + i1 * s; ti = i1 * c - r1 * s;
        r1 = r0 - tr; i1 = i0 - ti; r0 = r0 + tr; i0 = i0 + ti;
        tr = r3 * c + i3 * s; ti = i3 * c - r3 * s;
        r3 = r2 - tr; i3 = i2 - ti; r2 = r2 + tr; i2 = i2 + ti;
        c = cos[j * step2]; s = sin[j * step2];
        tr = r2 * c + i2 * s; ti = i2 * c - r2 * s;
        re[p2] = r0 - tr; im[p2] = i0 - ti; re[p0] = r0 + tr; im[p0] = i0 + ti;
        c = cos[(j + h) * step2]; s = sin[(j + h) * step2];
        tr = r3 * c + i3 * s; ti = i3 * c - r3 * s;
        re[p3] = r1 - tr; im[p3] = i1 - ti; re[p1] = r1 + tr; im[p1] = i1 + ti;
      }
    }
  }
  if (2 * h <= n) {
    for (let a = 0, k = 0; a < h; a++, k += step) {
      const b = a + h;
      const c = cos[k], s = sin[k];
      const tr = re[b] * c + im[b] * s;
      const ti = im[b] * c - re[b] * s;
      re[b] = re[a] - tr; im[b] = im[a] - ti;
      re[a] += tr; im[a] += ti;
    }
  }
}

// The vocoder's window, tables and buffers for the stream's rate.
QemuAudio.prototype.configurePv = function () {
  const N = 1 << Math.round(Math.log2(PV_WINDOW * this.freq));
  const H = N / PV_OVERLAP, half = N >> 1, bins = half + 1;
  this.pvN = N;
  this.pvHs = H;
  const w = this.pvWin = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  }
  let s = 0;
  for (let i = 0; i < N; i += H) {
    s += w[i] * w[i];
  }
  this.pvNorm = 1 / s;
  const bits = Math.log2(N);
  this.pvRev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | ((i >> b) & 1);
    }
    this.pvRev[i] = r;
  }
  this.pvCos = new Float64Array(half);
  this.pvSin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    this.pvCos[k] = Math.cos(2 * Math.PI * k / N);
    this.pvSin[k] = Math.sin(2 * Math.PI * k / N);
  }
  this.pvRe = new Float64Array(N);
  this.pvIm = new Float64Array(N);
  this.pvMag = new Float64Array(bins);
  // Per bin, of this frame and the one before: the L + R spectrum, and the
  // rotation pvLock gave it. Phases are taken only at peaks, from these.
  this.pvMr = new Float64Array(bins);
  this.pvMi = new Float64Array(bins);
  this.pvRot = new Float64Array(bins);
  this.pvPrevMr = new Float64Array(bins);
  this.pvPrevMi = new Float64Array(bins);
  this.pvPrevRot = new Float64Array(bins);
  this.pvPrevPlain = true;
  this.pvInst = new Float64Array(bins);
  this.pvPeaks = new Int32Array(bins);
  this.pvYMask = 4 * N - 1;
  this.pvY = [new Float64Array(4 * N), new Float64Array(4 * N)];
  this.pvHc = new Float64Array(16);    // recent frames: Y centre,
  this.pvHa = new Float64Array(16);    // analysis centre from pvBase
  this.pvE = new Float64Array(64);     // HF energy per PV_BLK input frames
  // Every field the vocoder uses exists from here on, so the object keeps
  // one shape for the compiled code (see warmUp).
  this.pvSpeed = 1;
  this.pvExit = false;
  this.pvReset(0);
};

// Starts the vocoder at the play position: frames centred up to half a
// window past it are identity frames, so Y starts out as the input itself.
// It needs a whole window of input ahead.
QemuAudio.prototype.pvEnter = function (avail) {
  const i0 = Math.floor(this.pos);
  if (avail - i0 < this.pvN + this.pvHs + 2) {
    return false;
  }
  this.pvOn = true;
  this.pvExit = false;
  this.pvReset(i0);
  return true;
};

// The vocoder's state for a start at ring frame i0 from the read cursor.
QemuAudio.prototype.pvReset = function (i0) {
  const N = this.pvN, H = this.pvHs, half = N >> 1;
  this.pvBase = this.read;
  this.pvYPos = this.pos - i0;
  this.pvC = -half;           // Y centre of the last frame
  this.pvA = i0 - half;       // and its analysis centre, from pvBase
  this.pvAnchor = NaN;        // a - c of the current run of reset frames
  this.pvIdentTo = half;
  this.pvIdentFrom = Infinity;
  this.pvFinal = this.pvC + H - half;
  this.pvCarry = 0;
  this.pvFrozenRun = 0;
  this.pvRate1 = 0;
  this.pvLastOnset = -Infinity;
  this.pvScan = i0 + N;       // onsets are looked for past here
  this.pvHn = 0;
  this.pvY[0].fill(0);
  this.pvY[1].fill(0);
  this.pvENext = Math.floor((i0 - N) / PV_BLK);
};

// The input position (from the read cursor) that Y position y plays.
QemuAudio.prototype.pvMap = function (y) {
  const hc = this.pvHc, ha = this.pvHa, last = this.pvHn - 1;
  let k = last;
  while (k > 0 && k > last - 15 && hc[k & 15] > y) {
    k--;
  }
  const c0 = hc[k & 15], a0 = ha[k & 15];
  const a = k < last
    ? a0 + (y - c0) * (ha[(k + 1) & 15] - a0) / (hc[(k + 1) & 15] - c0)
    : a0 + (y - c0);
  return a - ((this.read - this.pvBase) | 0);
};

// High-frequency energy of the mono mix per PV_BLK input frames, for every
// block before b1 (block b starts PV_BLK * b frames after pvBase).
QemuAudio.prototype.pvEnergyTo = function (b1) {
  const pcm = this.pcm, mask = this.mask, ch = this.channels, E = this.pvE;
  if (b1 - this.pvENext > 64) {
    this.pvENext = b1 - 64;
  }
  for (let b = this.pvENext; b < b1; b++) {
    let at = (this.pvBase + b * PV_BLK) | 0;
    let o = ((at - 1) & mask) * ch;
    let prev = ch > 1 ? pcm[o] + pcm[o + 1] : 2 * pcm[o];
    let e = 0;
    for (let i = 0; i < PV_BLK; i++, at++) {
      o = (at & mask) * ch;
      const v = ch > 1 ? pcm[o] + pcm[o + 1] : 2 * pcm[o];
      e += (v - prev) * (v - prev);
      prev = v;
    }
    E[b & 63] = e;
  }
  this.pvENext = Math.max(this.pvENext, b1);
};

// The first block in (from, to] (input frames from pvBase) where the HF
// energy jumps PV_ONSET times over the 8 blocks before it, or Infinity.
QemuAudio.prototype.pvOnset = function (from, to, lim) {
  const E = this.pvE;
  const b0 = Math.floor(from / PV_BLK) + 1;
  const b1 = Math.min(Math.floor(to / PV_BLK), Math.floor(lim / PV_BLK) - 2);
  if (b1 < b0) {
    return Infinity;
  }
  this.pvEnergyTo(b1 + 2);
  for (let b = b0; b <= b1; b++) {
    if (b < this.pvLastOnset + 16) {
      continue;
    }
    let ref = 0;
    for (let j = 1; j <= 8; j++) {
      ref += E[(b - j) & 63];
    }
    const cur = (E[b & 63] + E[(b + 1) & 63]) / 2;
    if (cur > PV_ONSET * ref / 8 + PV_ONSET_FLOOR) {
      this.pvLastOnset = b;
      return b * PV_BLK;
    }
  }
  return Infinity;
};

// Computes the next frame and overlap-adds it into Y. False when the input
// has run dry for PV_STALL.
QemuAudio.prototype.pvFrame = function (avail) {
  const N = this.pvN, H = this.pvHs, half = N >> 1;
  const shift = (this.read - this.pvBase) | 0;
  const c = this.pvC + H;
  let reset = this.pvExit || c <= this.pvIdentTo;
  let a;
  if (reset) {
    a = this.pvA + H;
  } else {
    this.pvCarry += (this.pvRate1 > 0 ? 1 : this.pvSpeed) * H;
    const adv = Math.floor(this.pvCarry);
    this.pvCarry -= adv;
    a = this.pvA + adv;
    if (this.pvRate1 > 0) {
      this.pvRate1--;
    }
  }
  const maxA = avail + shift - half;
  if (a > maxA) {
    // Short of input: an onset pass that is not banked yet, or a starved
    // bank. Frames go on from the newest input instead of stalling.
    a = Math.max(this.pvA, maxA);
  }
  const ha = a - this.pvA;
  if (!reset && ha === 0) {
    this.pvFrozenRun += H;
    if (this.pvFrozenRun > PV_STALL * this.freq) {
      return false;
    }
  } else {
    this.pvFrozenRun = 0;
  }
  if (!reset && ha > 0) {
    // An onset entering the window: reset here, before any frame holds it,
    // and go at speed 1 until it leaves the window. At speed 1 the locked
    // phases stay those of the input, so the attack comes out as it went in
    // instead of smeared over the window.
    const to = Math.min(a + half, avail + shift - 3 * PV_BLK);
    if (to > this.pvScan) {
      if (this.pvOnset(Math.max(this.pvScan, a - half), to,
                       avail + shift) !== Infinity) {
        reset = true;
        this.pvRate1 = PV_OVERLAP;
      }
      this.pvScan = to;
    }
  }
  // Y frames from here on: identity when every frame over them is a reset
  // frame with the same anchor.
  if (reset && a - c === this.pvAnchor) {
    if (this.pvIdentFrom === Infinity) {
      this.pvIdentFrom = c;
    }
  } else {
    this.pvIdentFrom = reset ? c : Infinity;
    this.pvAnchor = reset ? a - c : NaN;
  }

  const Y0 = this.pvY[0], Y1 = this.pvY[1], ym = this.pvYMask, nrm = this.pvNorm;
  for (let j = c + half - H; j < c + half; j++) {
    Y0[j & ym] = 0;
    Y1[j & ym] = 0;
  }
  const re = this.pvRe, im = this.pvIm, w = this.pvWin;
  const pcm = this.pcm, mask = this.mask, ch = this.channels;
  let at = (this.pvBase + a - half) | 0;
  for (let i = 0; i < N; i++, at++) {
    const o = (at & mask) * ch;
    re[i] = pcm[o] * w[i];
    im[i] = ch > 1 ? pcm[o + 1] * w[i] : 0;
  }
  const y0 = c - half;
  if (reset) {
    for (let i = 0; i < N; i++) {
      const g = w[i] * nrm;
      Y0[(y0 + i) & ym] += re[i] * g;
      Y1[(y0 + i) & ym] += im[i] * g;
    }
  }
  // A frame a vocoded one follows needs its phases.
  const needPhase = !reset || (!this.pvExit && c + H > this.pvIdentTo);
  if (needPhase) {
    pvFft(re, im, N, this.pvRev, this.pvCos, this.pvSin);
    const mag = this.pvMag, mr = this.pvMr, mi = this.pvMi;
    let mx = 0;
    for (let k = 0; k <= half; k++) {
      const nk = (N - k) & (N - 1);
      const zr = re[k], zi = im[k], nr = re[nk], ni = im[nk];
      const r = zr + nr + zi + ni, i = zi - ni + nr - zr;    // 2 (L + R)
      const m = r * r + i * i;
      mr[k] = r;
      mi[k] = i;
      mag[k] = m;
      if (m > mx) {
        mx = m;
      }
    }
    // Unrotated: the synthesis phases are the analysis ones.
    let plain = true;
    if (reset) {
      const inst = this.pvInst;
      for (let k = 0; k <= half; k++) {
        inst[k] = 2 * Math.PI * k / N;
      }
    } else {
      plain = !this.pvLock(ha, mx * 1e-8);
      pvFft(im, re, N, this.pvRev, this.pvCos, this.pvSin);
      for (let i = 0; i < N; i++) {
        const g = w[i] * nrm / N;
        Y0[(y0 + i) & ym] += re[i] * g;
        Y1[(y0 + i) & ym] += im[i] * g;
      }
      Atomics.add(this.hdr, H_STRETCHED, Math.max(0, H - ha));
    }
    this.pvMr = this.pvPrevMr;
    this.pvPrevMr = mr;
    this.pvMi = this.pvPrevMi;
    this.pvPrevMi = mi;
    const rot = this.pvRot;
    this.pvRot = this.pvPrevRot;
    this.pvPrevRot = rot;
    this.pvPrevPlain = plain;
  }

  const k = this.pvHn++ & 15;
  this.pvHc[k] = c;
  this.pvHa[k] = a;
  this.pvA = a;
  this.pvC = c;
  this.pvFinal = c + H - half;
  return true;
};

// Identity phase locking: each spectral peak's phase advances by its
// measured frequency over the synthesis hop, and the bins around it keep
// their phase offsets to it. The rotation applies to the packed spectrum,
// L + iR, as e^{i rot} at k and e^{-i rot} at N - k: the same rotation for
// both channels, so the stereo phase stays. False when there is no peak and
// nothing turns.
QemuAudio.prototype.pvLock = function (ha, floor) {
  const N = this.pvN, H = this.pvHs, half = N >> 1;
  const re = this.pvRe, im = this.pvIm, mag = this.pvMag;
  const mr = this.pvMr, mi = this.pvMi, rots = this.pvRot;
  const prevMr = this.pvPrevMr, prevMi = this.pvPrevMi;
  const prevRot = this.pvPrevRot, prevPlain = this.pvPrevPlain;
  const inst = this.pvInst, peaks = this.pvPeaks;
  const TAU = 2 * Math.PI;
  let np = 0;
  for (let k = 1; k < half; k++) {
    if (mag[k] > floor && mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
      peaks[np++] = k;
    }
  }
  if (np === 0) {
    return false;
  }
  let lo = 1;
  for (let j = 0; j < np; j++) {
    const p = peaks[j];
    const hi = j + 1 < np ? (p + peaks[j + 1]) >> 1 : half - 1;
    const ph = Math.atan2(mi[p], mr[p]);
    const prevPh = Math.atan2(prevMi[p], prevMr[p]);
    let f;
    if (ha > 0) {
      const omega = TAU * p / N;
      let d = ph - prevPh - omega * ha;
      d -= TAU * Math.round(d / TAU);
      f = omega + d / ha;
      inst[p] = f;
    } else {
      f = inst[p];
    }
    // The phase the previous frame was synthesized with at p.
    const prevSyn = prevPlain ? prevPh : prevPh + prevRot[p];
    let rot = prevSyn + f * H - ph;
    rot -= TAU * Math.round(rot / TAU);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let k = lo; k <= hi; k++) {
      rots[k] = rot;
      let r = re[k], i = im[k];
      re[k] = r * cr - i * sr;
      im[k] = r * sr + i * cr;
      const nk = N - k;
      r = re[nk]; i = im[nk];
      re[nk] = r * cr + i * sr;
      im[nk] = i * cr - r * sr;
    }
    lo = hi + 1;
  }
  return true;
};

// Renders from Y. Once leaving, and Y is identity from the play position
// on, carries on from the ring at the very same spot.
QemuAudio.prototype.pvRender = function (out, n, ratio, avail) {
  const H = this.pvHs, half = this.pvN >> 1;
  if (this.pvExit && this.pvYPos >= this.pvIdentFrom + half - H) {
    this.pos = this.pvMap(this.pvYPos);
    this.pvOn = false;
    return this.render(out, n, ratio, avail);
  }
  const end = Math.floor(this.pvYPos + (n - 1) * ratio) + 2;
  while (this.pvFinal < end) {
    if (!this.pvFrame(avail)) {
      return null;
    }
  }
  const Y = this.pvY, ym = this.pvYMask, ch = this.channels;
  let y = this.pvYPos;
  for (let i = 0; i < n; i++) {
    const f = Math.floor(y), t = y - f;
    for (let c = 0; c < out.length; c++) {
      const Yc = Y[c < ch ? c : ch - 1];
      const a = Yc[f & ym], b = Yc[(f + 1) & ym];
      out[c][i] = (a + (b - a) * t) / 32768;
    }
    y += ratio;
  }
  this.pvYPos = y;
  return this.pvMap(y);
};

// The first runs of a function are interpreted. The vocoder's first frames
// would take 5-9 ms each on a desktop CPU, a stall in the output the first
// time it slows down. This plays two made-up voices through process() once,
// before the first real one opens, each from a ring of its own: two tones, a
// noise burst every 1024 frames and silences. The producer keeps up, falls
// to 0.3 of real time, then catches up again (the first voice) or stops (the
// second). Their rates are made up too, for 128-frame windows: the code is
// the same, the interpreted frames are much cheaper. Every field then has
// held the kinds of values a stream gives it, and been set more than once,
// which the compiled code depends on. What the next voice does not reset
// goes back to the constructor's values.
QemuAudio.prototype.warmUp = function () {
  const n = 128, len = 1 << 13;
  const Buffer = typeof SharedArrayBuffer === "function"
    ? SharedArrayBuffer : ArrayBuffer;
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let voice = 0; voice < 2; voice++) {
    const freq = 2800 + 200 * voice;
    const buf = new Buffer(HDR_BYTES + 4 * len);
    const hdr = this.hdr = new Int32Array(buf, 0, HDR_WORDS);
    this.cap = len;
    this.mask = len - 1;
    const pcm = this.pcm = new Int16Array(buf, HDR_BYTES, 2 * len);
    this.gen = -1;
    hdr[H_CAP] = len;
    hdr[H_CH] = 2;
    hdr[H_FREQ] = freq;
    hdr[H_GEN] = 1;
    hdr[H_ACTIVE] = 1;
    hdr[H_STREAMING] = 1;
    let write = 0, due = 0, seed = 1;
    for (let q = 0; q < 600; q++) {
      const t = q * n / sampleRate;
      due += (t < 0.3 ? 1 : t < 1 ? 0.3 : voice === 0 ? 1 : 0) * n * freq /
             sampleRate;
      for (; write < due; write++) {
        const i = write & 2047, w = 2 * Math.PI * write / freq;
        let v = 4000 * Math.sin(440 * w) + 2000 * Math.sin(1250 * w);
        if ((i & 1023) < 64) {
          seed = (Math.imul(seed, 1103515245) + 12345) | 0;
          v += (seed >> 19) * (1 - (i & 1023) / 64);
        }
        pcm[(write & (len - 1)) * 2] = i < 1536 ? v : 0;
        pcm[(write & (len - 1)) * 2 + 1] = i < 1536 ? v / 2 : 0;
      }
      Atomics.store(hdr, H_WRITE, write);
      out[0].fill(0);
      out[1].fill(0);
      this.process(null, [out]);
    }
  }
  this.rate = 1;
  this.fastRate = 1;
  this.prime = this.basePrime;
  this.quiet = 0;
  this.xfAt = 0;
  this.xfSkip = 0;
};

registerProcessor("qemu-audio", QemuAudio);
