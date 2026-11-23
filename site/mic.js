// The phone's microphone from the computer's (doc/gsm-relay.md). The page
// asks for it only when the mic button is pressed (getUserMedia needs https
// or localhost), captures it in an AudioContext running at the mic ADC's own
// 8 kHz (the browser resamples), and hands 16-bit samples to qemu
// (ui/wasm.c _wasm_mic_buf / _wasm_mic_put), where the AFE model takes them
// as its mic ADC input (hw/arm/pmb887x/dsp/peripheral/afe.c). No mic, or
// none allowed: the ADC hears silence, as before.

const RATE = 8000;
const CHUNK = 512;          // 64 ms at 8 kHz
const MIC_BUF = 2048;       // MIC_BUF_SAMPLES in qemu/ui/wasm.c

export class Mic {
  constructor() {
    this.m = null;          // the running qemu module, or null
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.samples = 0;       // handed to qemu
    this.dropped = 0;       // not kept by qemu (its ring was full)
  }

  get on() { return !!this.stream; }

  // the module of the run; null between runs (samples are then thrown away)
  attach(module) {
    this.m = module?._wasm_mic_put ? module : null;
  }

  async start() {
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const ctx = new AudioContext({ sampleRate: RATE });
    const src = ctx.createMediaStreamSource(stream);
    // ScriptProcessor: deprecated but everywhere, and a 64 ms block is fine
    // next to the GSM codec's own delay; its output is muted
    const node = ctx.createScriptProcessor(CHUNK, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.onaudioprocess = (e) => this.put(e.inputBuffer.getChannelData(0));
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    await ctx.resume().catch(() => {});
    this.stream = stream;
    this.ctx = ctx;
    this.node = node;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
    this.stream = this.ctx = this.node = null;
  }

  put(f32) {
    const m = this.m;
    if (!m) return;
    const n = Math.min(f32.length, MIC_BUF);
    const buf = new Int16Array(m.HEAPU8.buffer, Number(m._wasm_mic_buf()), n);
    for (let i = 0; i < n; i++) {
      const v = f32[i];
      buf[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
    }
    const kept = m._wasm_mic_put(n);
    this.samples += kept;
    this.dropped += n - kept;
  }
}
