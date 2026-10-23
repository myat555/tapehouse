// Demo session: six loops synthesized offline (no sample files), routed through a drum bus and both returns.
import { S, spb, buffers } from './state.js';
import { newAudioClip } from './clips.js';
import { SR, addBuffer, addTrack, addBus, route, applyAll } from './audio.js';
import { newMidiClip } from './midi.js';
import { newInstrumentState } from './instruments/index.js';

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const PROG = [
  { root: 33, chord: [57, 60, 64] }, // Am
  { root: 29, chord: [53, 57, 60] }, // F
  { root: 36, chord: [55, 60, 64] }, // C
  { root: 31, chord: [55, 59, 62] }  // G
];

function render(sec, build) {
  const oc = new OfflineAudioContext(2, Math.ceil(sec * SR), SR);
  const out = oc.createGain(); out.connect(oc.destination);
  build(oc, out);
  return oc.startRendering();
}
function noise(oc, sec = 1) {
  const b = oc.createBuffer(1, Math.ceil(sec * oc.sampleRate), oc.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function env(g, t, peak, a, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function kick(oc, out, t, v = 1) {
  const o = oc.createOscillator(), g = oc.createGain();
  o.frequency.setValueAtTime(165, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
  env(g, t, v, 0.003, 0.42); o.connect(g).connect(out); o.start(t); o.stop(t + 0.5);
}
function snare(oc, out, t, nb, v = 1) {
  const n = oc.createBufferSource(), hp = oc.createBiquadFilter(), g = oc.createGain();
  n.buffer = nb; hp.type = 'highpass'; hp.frequency.value = 1500; env(g, t, 0.7 * v, 0.002, 0.2);
  n.connect(hp).connect(g).connect(out); n.start(t, Math.random() * 0.5); n.stop(t + 0.25);
  const o = oc.createOscillator(), g2 = oc.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(230, t); o.frequency.exponentialRampToValueAtTime(165, t + 0.08);
  env(g2, t, 0.55 * v, 0.002, 0.11); o.connect(g2).connect(out); o.start(t); o.stop(t + 0.15);
}
function hat(oc, out, t, nb, v, len = 0.045) {
  const n = oc.createBufferSource(), hp = oc.createBiquadFilter(), g = oc.createGain();
  n.buffer = nb; hp.type = 'highpass'; hp.frequency.value = 7500; env(g, t, v, 0.001, len);
  n.connect(hp).connect(g).connect(out); n.start(t, Math.random() * 0.5); n.stop(t + len + 0.03);
}
function bassNote(oc, out, t, f, d) {
  const o = oc.createOscillator(), s = oc.createOscillator(), lp = oc.createBiquadFilter(), sg = oc.createGain(), g = oc.createGain();
  o.type = 'sawtooth'; o.frequency.value = f; s.frequency.value = f; sg.gain.value = 0.7;
  lp.type = 'lowpass'; lp.Q.value = 5;
  lp.frequency.setValueAtTime(1900, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.18);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.42, t + 0.006);
  g.gain.setTargetAtTime(0.26, t + 0.01, 0.08); g.gain.setTargetAtTime(0.0001, t + d, 0.012);
  o.connect(lp).connect(g); s.connect(sg).connect(g); g.connect(out);
  o.start(t); s.start(t); o.stop(t + d + 0.08); s.stop(t + d + 0.08);
}
function padChord(oc, out, t, notes, d) {
  const lp = oc.createBiquadFilter(), g = oc.createGain();
  lp.type = 'lowpass'; lp.frequency.setValueAtTime(650, t); lp.frequency.linearRampToValueAtTime(2300, t + d * 0.6);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.085, t + 0.35);
  g.gain.setValueAtTime(0.085, t + d - 0.22); g.gain.linearRampToValueAtTime(0, t + d - 0.01);
  lp.connect(g).connect(out);
  for (const m of notes) for (const det of [-9, 9]) {
    const o = oc.createOscillator(), pn = oc.createStereoPanner();
    o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det; pn.pan.value = det < 0 ? -0.55 : 0.55;
    o.connect(pn).connect(lp); o.start(t); o.stop(t + d);
  }
}
export async function buildDemo() {
  const q = spb(), bar = 4 * q, L = 4 * bar;
  const each = fn => { for (let b = 0; b < 4; b++) fn(b, b * bar); };
  const [kB, sB, hB, bB, pB] = await Promise.all([
    render(L, (oc, out) => each((b, t0) => [0, 2, 2.75, ...(b === 3 ? [3.5] : [])].forEach(x => kick(oc, out, t0 + x * q, x % 1 ? 0.7 : 1)))),
    render(L, (oc, out) => { const nb = noise(oc); each((b, t0) => [1, 3, ...(b === 3 ? [3.75] : [])].forEach(x => snare(oc, out, t0 + x * q, nb, x % 1 ? 0.35 : 1))); }),
    render(L, (oc, out) => { const nb = noise(oc); each((b, t0) => { for (let i = 0; i < 8; i++) hat(oc, out, t0 + i * q / 2, nb, i % 2 ? 0.32 : 0.16, i === 7 && b === 3 ? 0.22 : 0.045); }); }),
    render(L, (oc, out) => each((b, t0) => [0, 0, 12, 0, 0, 12, 0, 10].forEach((s, i) => bassNote(oc, out, t0 + i * q / 2, mtof(PROG[b].root + s), q / 2 * 0.82)))),
    render(L, (oc, out) => each((b, t0) => padChord(oc, out, t0, PROG[b].chord, bar)))
  ]);
  const ids = {
    kick: addBuffer(kB, 'Kick'), snare: addBuffer(sB, 'Snare'), hats: addBuffer(hB, 'Hats'),
    bass: addBuffer(bB, 'Bass Am-F-C-G'), pad: addBuffer(pB, 'Pad chords')
  };
  const [rev, dly] = S.returns;
  const bus = addBus('Drum Bus');
  bus.comp = 0.35;
  const mk = (name, buf, starts, opts) => {
    const t = addTrack(name);
    const { sends = {}, ...rest } = opts;
    Object.assign(t, rest);
    Object.assign(t.sends, sends);
    for (const s of starts) t.clips.push(newAudioClip(ids[buf], s, buffers.get(ids[buf]).buffer.duration));
    route(t);
    return t;
  };
  mk('Kick', 'kick', [0, L], { vol: 0.95, out: bus.id });
  mk('Snare', 'snare', [0, L], { vol: 0.55, out: bus.id, sends: { [rev.id]: 0.22 } });
  mk('Hats', 'hats', [L], { vol: 0.42, pan: 0.22, out: bus.id });
  mk('Bass', 'bass', [0, L], { vol: 0.55, lo: 2 });
  mk('Pad', 'pad', [0, L], { vol: 0.5, hi: -2, sends: { [rev.id]: 0.45 } });
  // The arp is MIDI driving the built-in synth, so it opens in the piano roll.
  const arp = mk('Arp', null, [], { vol: 0.5, pan: -0.2, sends: { [rev.id]: 0.3, [dly.id]: 0.35 } });
  arp.inst = newInstrumentState('synth', { wave: 'square', detune: 0, sub: 0, cutoff: 1400, reso: 3, fenv: 0.45, decay: 0.16, sustain: 0, release: 0.08, gain: 0.9 });
  const notes = [];
  PROG.forEach(({ chord }, b) => {
    const seq = [chord[0], chord[1], chord[2], chord[0] + 12];
    for (let i = 0; i < 16; i++) notes.push({ s: b * 4 + i / 4, d: 0.2, p: seq[i % 4] + 12, v: i % 4 === 0 ? 112 : 84 });
  });
  arp.clips.push(newMidiClip(L, 16, notes));
  S.name = 'Demo session';
  S.loop = true; S.loopStart = 0; S.loopEnd = 2 * L;
  applyAll();
}
