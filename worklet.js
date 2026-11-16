// Hands the engine 100 ms chunks of 16 kHz mono audio.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const n = channels[0].length;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const ch of channels) sum += ch[i];
      this.buffer[this.filled++] = sum / channels.length;
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer);
        this.buffer = new Float32Array(1600);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('tap', Tap);
