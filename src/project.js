// Project files: one JSON document with the session plus every used audio buffer embedded as 24-bit WAV.
import { S, buffers, reserveIds } from './state.js';
import { ctx, addBuffer, addTrack, addBus, removeChannel, resetParams, routeAll, applyAll } from './audio.js';
import { encodeWav } from './wav.js';
import { stop } from './engine.js';
import { isMidi, syncMidiDurations } from './midi.js';
import { getInstrument, newInstrumentState } from './instruments/index.js';
import { AUDIO_KEYS, withAudioDefaults } from './clips.js';
import { resetStretch } from './stretch.js';

const PARAM_KEYS = ['vol', 'pan', 'lo', 'mid', 'hi', 'comp', 'mute'];
const pick = o => Object.fromEntries(PARAM_KEYS.filter(k => o && k in o).map(k => [k, o[k]]));
const toDataURL = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result); r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

export function clearSession() {
  if (S.playing) stop();
  for (const o of [...S.tracks, ...S.buses]) removeChannel(o);
  S.tracks = []; S.buses = [];
  buffers.clear();
  resetStretch();
  for (const o of [...S.returns, S.master]) resetParams(o);
  S.selTrack = S.selClip = null;
  S.pos = S.playFrom = 0;
}

export async function saveProject() {
  const used = new Set(S.tracks.flatMap(t => [...t.clips.filter(c => !isMidi(c)).map(c => c.buf), t.inst?.params?.buf].filter(Boolean)));
  const audio = {};
  for (const id of used) {
    const b = buffers.get(id);
    if (b) audio[id] = { name: b.name, data: await toDataURL(encodeWav(b.buffer, 24)) };
  }
  const fxOf = rid => S.returns.find(r => r.id === rid)?.fx;
  const doc = {
    app: 'tapehouse', version: 1, name: S.name, bpm: S.bpm, zoom: S.zoom, metro: S.metro, snap: S.snap, stretchTempo: S.stretchTempo,
    loop: { on: S.loop, start: S.loopStart, end: S.loopEnd },
    master: pick(S.master),
    returns: S.returns.map(r => ({ fx: r.fx, ...pick(r) })),
    buses: S.buses.map(b => ({ id: b.id, name: b.name, ...pick(b) })),
    tracks: S.tracks.map(t => ({
      id: t.id, name: t.name, color: t.color, ...pick(t), solo: t.solo, out: t.out,
      sends: Object.fromEntries(Object.entries(t.sends).map(([k, v]) => [fxOf(k), v]).filter(([k]) => k)),
      inst: t.inst || null,
      clips: t.clips.map(c => isMidi(c)
        ? { type: 'midi', id: c.id, start: c.start, off: c.off, beats: c.beats, dur: c.dur, notes: c.notes }
        : { type: 'audio', ...Object.fromEntries(AUDIO_KEYS.map(k => [k, c[k]])) })
    })),
    audio
  };
  return new Blob([JSON.stringify(doc)], { type: 'application/json' });
}

export async function loadProject(file, onProgress) {
  let doc;
  try { doc = JSON.parse(await file.text()); } catch { doc = null; }
  if (doc?.app !== 'tapehouse') throw new Error(`${file.name} is not a Tapehouse project.`);

  // Decode all audio before touching the session, so a bad file leaves the current one intact.
  const decoded = new Map(), entries = Object.entries(doc.audio || {});
  let i = 0;
  for (const [id, a] of entries) {
    onProgress?.(`Decoding audio ${++i} of ${entries.length}…`);
    const bytes = await (await fetch(a.data)).arrayBuffer();
    decoded.set(id, { name: a.name, buffer: await ctx.decodeAudioData(bytes) });
  }

  clearSession();
  const tracks = doc.tracks || [], buses = doc.buses || [];
  reserveIds([...decoded.keys(), ...buses.map(b => b.id), ...tracks.map(t => t.id), ...tracks.flatMap(t => (t.clips || []).map(c => c.id))]);
  for (const [id, b] of decoded) addBuffer(b.buffer, b.name, id);

  Object.assign(S, {
    name: doc.name || file.name.replace(/\.[^.]+$/, ''), bpm: doc.bpm || 120, zoom: doc.zoom || 44,
    metro: !!doc.metro, snap: doc.snap !== false, stretchTempo: doc.stretchTempo !== false,
    loop: !!doc.loop?.on, loopStart: doc.loop?.start || 0, loopEnd: doc.loop?.end || 0
  });
  Object.assign(S.master, pick(doc.master));
  for (const r of doc.returns || []) Object.assign(S.returns.find(x => x.fx === r.fx) || {}, pick(r));
  for (const b of buses) Object.assign(addBus(b.name, b.id), pick(b));
  for (const t of tracks) {
    const tr = addTrack(t.name, t.color, t.id);
    Object.assign(tr, pick(t), { solo: !!t.solo, out: t.out || 'master' });
    for (const [fx, v] of Object.entries(t.sends || {})) {
      const r = S.returns.find(x => x.fx === fx);
      if (r) tr.sends[r.id] = v;
    }
    if (t.inst) {
      // An instrument this build doesn't have (from a newer version) falls back to the synth.
      const def = getInstrument(t.inst.type);
      tr.inst = def ? { type: t.inst.type, params: { ...def.defaults, ...t.inst.params } } : newInstrumentState('synth');
    }
    tr.clips = (t.clips || []).filter(c => c.type === 'midi' || buffers.has(c.buf))
      .map(c => c.type === 'midi' ? { ...c, notes: (c.notes || []).map(n => ({ ...n })) } : withAudioDefaults(c));
  }
  syncMidiDurations();
  routeAll(); applyAll();
}
