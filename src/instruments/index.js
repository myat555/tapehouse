// Instrument registry. An instrument turns MIDI notes into audio on any BaseAudioContext,
// so the same code runs for live playback, piano-roll previews and offline export.
//
// To add a synth, call registerInstrument(id, def) with:
//   name      display name
//   defaults  { [paramKey]: value }
//   params    [{ key, label, type: 'knob'|'select'|'toggle'|'note'|'sample', ... }]
//             knob:   { min, max, scale?: 'log', fmt?: v => string }
//             select: { options: [[value, label], ...] }
//   start(ac, out, params, { pitch, vel, when }, env) -> voice | null
//             env.buffers is the project's audio buffer map.
//             voice.release(t) begins the release at ctx time t (call once; extra calls are ignored)
//             voice.stop() silences immediately (transport stop)
//             voice.end is the ctx time after which the voice is silent (Infinity until released)
// The UI for each instrument is generated from `params`, so a new instrument needs no UI code.

import synth from './synth.js';
import sampler from './sampler.js';

const registry = new Map();
export function registerInstrument(id, def) { registry.set(id, { id, ...def }); }
export const getInstrument = id => registry.get(id);
export const listInstruments = () => [...registry.values()];
export const newInstrumentState = (type, extra = {}) => ({ type, params: { ...registry.get(type).defaults, ...extra } });

export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = p => NAMES[p % 12] + (Math.floor(p / 12) - 1);
export const isBlack = p => [1, 3, 6, 8, 10].includes(p % 12);

registerInstrument('synth', synth);
registerInstrument('sampler', sampler);
