// The phone's microphone from the computer's (doc/gsm-relay.md). The page
// asks for it only when the mic button is pressed (getUserMedia needs https
// or localhost), captures it in an AudioContext at the device's own rate
// (Firefox will not connect a stream to a context of another rate), averages
// it down to the mic ADC's 8 kHz, and hands 16-bit samples to qemu
// (ui/wasm.c _wasm_mic_buf / _wasm_mic_put), where the AFE model takes them
// as its mic ADC input (hw/arm/pmb887x/dsp/peripheral/afe.c). No mic, or
// none allowed: the ADC hears silence, as before.

const RATE = 8000;
const CHUNK = 2048;         // ~43 ms at 48 kHz; at most MIC_BUF samples once at 8 kHz
const MIC_BUF = 2048;       // MIC_BUF_SAMPLES in qemu/ui/wasm.c
const CANCELLED = Symbol("mic start cancelled");

export class Mic {
  constructor() {
    this.m = null;          // the running qemu module, or null
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.starting = null;   // the start() under way (the permission prompt)
    this.gen = 0;           // stop() count: a start() from before a stop() is dropped
    this.samples = 0;       // handed to qemu
    this.dropped = 0;       // not kept by qemu (its ring was full)
    this.step = 1;          // input samples per 8 kHz sample
    this.acc = 0;           // the 8 kHz sample being averaged: sum, count, phase
    this.accN = 0;
    this.phase = 0;
  }

  get on() { return !!this.stream; }
  get pending() { return !!this.starting; }

  // the module of the run; null between runs (samples are then thrown away)
  attach(module) {
    this.m = module?._wasm_mic_put ? module : null;
  }

  // true: the mic is on; false: a stop() came while the browser was still
  // asking for it (nothing stays open). A second start() during the
  // permission prompt waits for the first one.
  start() {
    if (this.stream) return Promise.resolve(true);
    if (!this.starting) {
      const gen = this.gen;
      this.starting = this.open(gen).finally(() => {
        if (this.gen === gen) this.starting = null;
      });
    }
    return this.starting;
  }

  async open(gen) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    let ctx = null;
    try {
      if (this.gen !== gen) throw CANCELLED;
      ctx = new AudioContext();
      this.step = Math.max(1, ctx.sampleRate / RATE);
      this.acc = this.accN = this.phase = 0;
      const src = ctx.createMediaStreamSource(stream);
      // ScriptProcessor: deprecated but everywhere, and a ~40 ms block is fine
      // next to the GSM codec's own delay; its output is muted
      const node = ctx.createScriptProcessor(CHUNK, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.onaudioprocess = (e) => this.put(e.inputBuffer.getChannelData(0));
      src.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      await ctx.resume().catch(() => {});
      if (this.gen !== gen) throw CANCELLED;
      this.stream = stream;
      this.ctx = ctx;
      this.node = node;
      return true;
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      if (e === CANCELLED) return false;
      throw e;
    }
  }

  stop() {
    if (this.stream) this.m?._wasm_mic_put(0);   // what it queued is not for the next call
    this.gen++;
    this.starting = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
    this.stream = this.ctx = this.node = null;
  }

  put(f32) {
    const m = this.m;
    if (!m) return;
    const buf = new Int16Array(m.HEAPU8.buffer, Number(m._wasm_mic_buf()), MIC_BUF);
    let n = 0;
    for (let i = 0; i < f32.length && n < MIC_BUF; i++) {
      this.acc += f32[i];
      this.accN++;
      if (++this.phase < this.step) continue;
      this.phase -= this.step;
      const v = this.acc / this.accN;
      this.acc = this.accN = 0;
      buf[n++] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
    }
    if (!n) return;
    const kept = m._wasm_mic_put(n);
    this.samples += kept;
    this.dropped += n - kept;
  }
}
