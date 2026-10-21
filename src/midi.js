// MIDI clips. Notes are { s: start beat, d: length in beats, p: MIDI pitch, v: velocity 1–127 },
// relative to the clip's content. The clip shows beats [off, off + beats) starting at `start` seconds,
// so MIDI follows tempo changes while audio clips stay put in time.
import { S, buffers, nid, spb } from './state.js';
import { getInstrument, newInstrumentState } from './instruments/index.js';

export function newMidiClip(start, beats, notes = []) {
  return { id: nid('c'), type: 'midi', start, off: 0, beats, dur: beats * spb(), notes };
}
export const isMidi = c => c.type === 'midi';
export const syncMidiDurations = () => {
  for (const t of S.tracks) for (const c of t.clips) if (isMidi(c)) c.dur = c.beats * spb();
};
export function ensureInstrument(t) {
  if (!t.inst) t.inst = newInstrumentState('synth');
  return t.inst;
}
export const cloneClip = c => isMidi(c) ? { ...c, notes: c.notes.map(n => ({ ...n })) } : { ...c };

export function playNote(ac, out, inst, pitch, vel, when) {
  const def = inst && getInstrument(inst.type);
  return def ? def.start(ac, out, inst.params, { pitch, vel, when }, { buffers }) : null;
}

// Schedule notes of clip `c` whose start falls in timeline range [from, to), cut off at `end`.
// ctx time = timeline position + timeOffset.
export function scheduleMidiClip(ac, out, t, c, from, to, end, timeOffset, keep) {
  if (!t.inst) return;
  const q = spb(), clipEnd = Math.min(c.start + c.dur, end), now = ac.currentTime;
  for (const n of c.notes) {
    const rel = n.s - c.off;
    if (rel < 0 || rel >= c.beats) continue;
    const pos = c.start + rel * q;
    if (pos < from || pos >= to || pos >= clipEnd) continue;
    const when = Math.max(now, pos + timeOffset);
    const voice = playNote(ac, out, t.inst, n.p, n.v, when);
    if (!voice) continue;
    voice.release(when + Math.min(n.d * q, clipEnd - pos));
    keep(voice);
  }
}
