// Session state shared by every module. Clip times are in seconds (REAPER's default "time" timebase).
export const S = {
  name: 'Untitled', bpm: 112, zoom: 44,
  pos: 0, playFrom: 0, playing: false, recording: false,
  loop: true, loopStart: 0, loopEnd: 0, metro: false, snap: true,
  tracks: [], buses: [], returns: [], master: null,
  selTrack: null, selClip: null, mixerOpen: true
};

// id -> { buffer, name, peaks, norm }
export const buffers = new Map();

export const PEAK_RATE = 200;
export const COLORS = ['#e8894f', '#e2b84d', '#86c96d', '#4fbfae', '#5f9fe6', '#9f84e6', '#dc78bd', '#e66a6a'];

let uidN = 1;
export const nid = p => p + (uidN++);
// Keep new ids above any loaded from a project file.
export function reserveIds(ids) {
  for (const id of ids) {
    const n = parseInt(String(id).replace(/^\D+/, ''), 10);
    if (n >= uidN) uidN = n + 1;
  }
}

export const spb = () => 60 / S.bpm;
export const snapT = t => Math.max(0, Math.round(t / spb()) * spb());

export const allChannels = () => [...S.tracks, ...S.buses, ...S.returns, S.master];
export const findCh = id => allChannels().find(o => o.id === id);
export const trackById = id => S.tracks.find(t => t.id === id);
export function findClip(id) {
  for (const t of S.tracks) { const c = t.clips.find(x => x.id === id); if (c) return { t, c }; }
  return null;
}
export function projectEnd() {
  let e = 0;
  for (const t of S.tracks) for (const c of t.clips) e = Math.max(e, c.start + c.dur);
  return e;
}

export function fmtBars(t) {
  const beats = t / spb(), bar = Math.floor(beats / 4) + 1, beat = Math.floor(beats % 4) + 1, sub = Math.floor((beats % 1) * 100);
  return `${bar}.${beat}.${String(sub).padStart(2, '0')}`;
}
