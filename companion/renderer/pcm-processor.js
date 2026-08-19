// Mic/system audio -> 16kHz mono Int16 PCM for the STT pipeline.
// The context is NOT guaranteed to run at 16kHz: some Windows drivers refuse
// a forced sample rate, so this worklet downsamples whatever rate it gets.
// Each post carries { buffer, level } where level is the block's RMS (0..1),
// which drives the voice wave in the UI.
class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetRate = (options && options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / targetRate;   // worklet-global sampleRate = context rate
    this.acc = 0;                            // fractional read position
    this.carry = [];                         // leftover input between process() calls
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;

    // Concatenate carry + fresh input.
    const input = this.carry.length ? Float32Array.from([...this.carry, ...ch]) : ch;
    let sumSq = 0;

    if (this.ratio <= 1.001) {
      // Context already at (or below) target rate: pass through.
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sumSq += s * s;
      }
      this.carry = [];
      this.port.postMessage({ buffer: out.buffer, level: Math.sqrt(sumSq / input.length) }, [out.buffer]);
      return true;
    }

    // Downsample by averaging each stride: cheap, and fine for speech.
    const outLen = Math.floor((input.length - this.acc) / this.ratio);
    if (outLen <= 0) { this.carry = Array.from(input); return true; }
    const out = new Int16Array(outLen);
    let pos = this.acc;
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(pos);
      const end = Math.min(input.length, Math.floor(pos + this.ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      const s = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSq += s * s;
      pos += this.ratio;
    }
    const consumed = Math.floor(pos);
    this.acc = pos - consumed;
    this.carry = consumed < input.length ? Array.from(input.subarray(consumed)) : [];
    this.port.postMessage({ buffer: out.buffer, level: Math.sqrt(sumSq / outLen) }, [out.buffer]);
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
