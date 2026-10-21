// Polyphonic subtractive synth: two detuned oscillators + sub, resonant low-pass with its own envelope, ADSR amp.
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const hz = v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '';
const ms = v => v >= 1 ? v.toFixed(2) + 's' : Math.round(v * 1000) + 'ms';
const pct = v => Math.round(v * 100) + '%';

export default {
  name: 'Synth',
  defaults: { wave: 'sawtooth', detune: 12, sub: 0.3, cutoff: 2200, reso: 4, fenv: 0.4, attack: 0.005, decay: 0.25, sustain: 0.6, release: 0.25, gain: 0.8 },
  params: [
    { key: 'wave', label: 'Wave', type: 'select', options: [['sawtooth', 'Saw'], ['square', 'Square'], ['triangle', 'Triangle'], ['sine', 'Sine']] },
    { key: 'detune', label: 'DETUNE', type: 'knob', min: 0, max: 50, fmt: v => Math.round(v) + 'c' },
    { key: 'sub', label: 'SUB', type: 'knob', min: 0, max: 1, fmt: pct },
    { key: 'cutoff', label: 'CUTOFF', type: 'knob', min: 60, max: 16000, scale: 'log', fmt: hz },
    { key: 'reso', label: 'RESO', type: 'knob', min: 0.1, max: 20, fmt: v => v.toFixed(1) },
    { key: 'fenv', label: 'F.ENV', type: 'knob', min: 0, max: 1, fmt: pct },
    { key: 'attack', label: 'ATK', type: 'knob', min: 0.001, max: 2, scale: 'log', fmt: ms },
    { key: 'decay', label: 'DEC', type: 'knob', min: 0.01, max: 3, scale: 'log', fmt: ms },
    { key: 'sustain', label: 'SUS', type: 'knob', min: 0, max: 1, fmt: pct },
    { key: 'release', label: 'REL', type: 'knob', min: 0.01, max: 4, scale: 'log', fmt: ms },
    { key: 'gain', label: 'LEVEL', type: 'knob', min: 0, max: 1, fmt: pct }
  ],
  start(ac, out, p, { pitch, vel, when }) {
    const f = mtof(pitch), g = ac.createGain(), flt = ac.createBiquadFilter();
    flt.type = 'lowpass'; flt.Q.value = p.reso;
    const oscs = [];
    for (const det of p.detune > 0.5 ? [-p.detune / 2, p.detune / 2] : [0]) {
      const o = ac.createOscillator();
      o.type = p.wave; o.frequency.value = f; o.detune.value = det;
      o.connect(flt); oscs.push(o);
    }
    if (p.sub > 0.01) {
      const o = ac.createOscillator(), sg = ac.createGain();
      o.frequency.value = f / 2; sg.gain.value = p.sub;
      o.connect(sg).connect(flt); oscs.push(o);
    }
    flt.connect(g).connect(out);

    const peak = p.gain * (0.15 + 0.85 * vel / 127) * 0.3;
    const atkEnd = when + p.attack, tc = p.decay / 3 + 0.001;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, atkEnd);
    g.gain.setTargetAtTime(peak * p.sustain, atkEnd, tc);
    const top = Math.min(18000, p.cutoff * Math.pow(2, p.fenv * 6));
    flt.frequency.setValueAtTime(p.cutoff, when);
    flt.frequency.linearRampToValueAtTime(top, atkEnd);
    flt.frequency.setTargetAtTime(p.cutoff + (top - p.cutoff) * p.sustain, atkEnd, tc);
    for (const o of oscs) o.start(when);

    let released = false;
    const voice = {
      end: Infinity,
      release(t) {
        if (released) return;
        released = true;
        t = Math.max(t, atkEnd);
        g.gain.setTargetAtTime(0, t, p.release / 3 + 0.001);
        flt.frequency.setTargetAtTime(p.cutoff, t, p.release / 3 + 0.001);
        voice.end = t + p.release * 2 + 0.05;
        for (const o of oscs) o.stop(voice.end);
      },
      stop() {
        for (const o of oscs) { try { o.stop(); } catch { /* not started or already stopped */ } }
        g.disconnect();
        voice.end = 0;
      }
    };
    return voice;
  }
};
