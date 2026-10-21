// Sampler: plays any audio buffer in the project, repitched so `root` plays at the original speed.
const ms = v => v >= 1 ? v.toFixed(2) + 's' : Math.round(v * 1000) + 'ms';
const pct = v => Math.round(v * 100) + '%';

export default {
  name: 'Sampler',
  defaults: { buf: null, root: 60, gain: 0.8, attack: 0.002, release: 0.15, oneshot: false },
  params: [
    { key: 'buf', label: 'Sample', type: 'sample' },
    { key: 'root', label: 'Root', type: 'note' },
    { key: 'oneshot', label: 'One-shot', type: 'toggle' },
    { key: 'attack', label: 'ATK', type: 'knob', min: 0.001, max: 1, scale: 'log', fmt: ms },
    { key: 'release', label: 'REL', type: 'knob', min: 0.01, max: 3, scale: 'log', fmt: ms },
    { key: 'gain', label: 'LEVEL', type: 'knob', min: 0, max: 1, fmt: pct }
  ],
  start(ac, out, p, { pitch, vel, when }, env) {
    const b = p.buf && env.buffers.get(p.buf);
    if (!b) return null;
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = b.buffer;
    src.playbackRate.value = Math.pow(2, (pitch - p.root) / 12);
    const peak = p.gain * (0.15 + 0.85 * vel / 127), atkEnd = when + p.attack;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, atkEnd);
    src.connect(g).connect(out);
    src.start(when);
    const natural = when + b.buffer.duration / src.playbackRate.value;
    let released = false;
    const voice = {
      end: p.oneshot ? natural : Infinity,
      release(t) {
        if (released || p.oneshot) return;
        released = true;
        t = Math.max(t, atkEnd);
        g.gain.setTargetAtTime(0, t, p.release / 3 + 0.001);
        voice.end = Math.min(natural, t + p.release * 2 + 0.05);
        try { src.stop(voice.end); } catch { /* already stopped */ }
      },
      stop() {
        try { src.stop(); } catch { /* already stopped */ }
        g.disconnect();
        voice.end = 0;
      }
    };
    return voice;
  }
};
