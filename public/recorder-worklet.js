// Captures raw input samples on the audio thread and posts them in ~8k-frame chunks,
// each stamped with the AudioContext time of its first sample.
class TapehouseRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false; this.parts = []; this.n = 0; this.t0 = 0;
    this.port.onmessage = e => {
      if (e.data === 'start') { this.parts = []; this.n = 0; this.on = true; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.on && inp && inp.length) {
      if (this.n === 0) this.t0 = currentTime;
      const L = inp[0], R = inp[1] || inp[0];
      this.parts.push([L.slice(0), R.slice(0)]);
      this.n += L.length;
      if (this.n >= 8192) this.flush();
    }
    return true;
  }
  flush() {
    if (!this.n) return;
    const L = new Float32Array(this.n), R = new Float32Array(this.n);
    let o = 0;
    for (const [l, r] of this.parts) { L.set(l, o); R.set(r, o); o += l.length; }
    this.port.postMessage({ t0: this.t0, L, R }, [L.buffer, R.buffer]);
    this.parts = []; this.n = 0;
  }
}
registerProcessor('tapehouse-recorder', TapehouseRecorder);
