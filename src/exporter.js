// Offline mixdown: rebuilds the whole mixer graph in an OfflineAudioContext and renders it faster than real time.
import { S, allChannels, projectEnd } from './state.js';
import { SR, createNodes, connectOut, setParams, makeLimiter } from './audio.js';
import { isMidi, scheduleMidiClip } from './midi.js';
import { scheduleAudioClip } from './clips.js';
import { prepareAll } from './stretch.js';

export const TAIL = 3; // seconds of reverb/echo tail after the last clip

export async function renderMix() {
  const end = projectEnd();
  if (end <= 0) throw new Error('There is nothing to export yet. Add or record some audio first.');
  await prepareAll(); // finish any pending pitch-preserving stretches first
  const oc = new OfflineAudioContext(2, Math.ceil((end + TAIL) * SR), SR);
  const limiter = makeLimiter(oc);
  limiter.connect(oc.destination);

  const nodes = new Map(allChannels().map(o => [o.id, createNodes(oc, o.kind, o.fx, false)]));
  const nodesOf = o => nodes.get(o.id);
  for (const o of [S.master, ...S.returns, ...S.buses, ...S.tracks]) {
    connectOut(o, nodesOf(o), nodesOf, limiter, oc);
    setParams(o, nodesOf(o), oc, false);
  }
  for (const t of S.tracks) for (const c of t.clips) {
    if (isMidi(c)) { scheduleMidiClip(oc, nodesOf(t).input, t, c, 0, Infinity, Infinity, 0, () => {}); continue; }
    scheduleAudioClip(oc, nodesOf(t).input, t, c, c.start, c.start + c.dur, c.start, 0, () => {});
  }
  return oc.startRendering();
}
