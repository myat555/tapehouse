// Offline mixdown: rebuilds the whole mixer graph in an OfflineAudioContext and renders it faster than real time.
import { S, buffers, allChannels, projectEnd } from './state.js';
import { SR, createNodes, connectOut, setParams, makeLimiter } from './audio.js';

export const TAIL = 3; // seconds of reverb/echo tail after the last clip

export async function renderMix() {
  const end = projectEnd();
  if (end <= 0) throw new Error('There is nothing to export yet. Add or record some audio first.');
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
    const b = buffers.get(c.buf); if (!b) continue;
    const src = oc.createBufferSource();
    src.buffer = b.buffer;
    src.connect(nodesOf(t).input);
    src.start(c.start, c.offset, c.dur);
  }
  return oc.startRendering();
}
