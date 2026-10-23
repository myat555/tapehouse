// Playable buffers for audio clips. A pitch-preserving stretch renders the source once per
// (buffer, direction, factor) in a worker and caches it; until the render is ready the clip plays
// varispeed, so its timing is right straight away and only the pitch is briefly off.
import { S, buffers } from './state.js';
import { ctx } from './audio.js';
import { isMidi } from './midi.js';

const MAX_SECONDS = 600; // longest stretched render we keep in memory
const cache = new Map(); // key -> { buffer, failed, factor, promise, res }
const reversedOf = new Map(); // buf id -> { src, buf }
const queue = new Map(), jobs = new Map();
let worker = null, jobN = 0, timer = 0, onReady = () => {};
export const setStretchReady = fn => { onReady = fn; };

export const pitchRatio = c => c.mode === 'varispeed' ? 1 : 2 ** (((c.pitch || 0) + (c.cents || 0) / 100) / 12);
const factorOf = c => +(c.rate * pitchRatio(c)).toFixed(4);
const needsRender = c => c.mode !== 'varispeed' && Math.abs(factorOf(c) - 1) > 1e-4;
const keyOf = c => `${c.buf}|${c.reverse ? 'r' : 'f'}|${factorOf(c)}`;
const audioClips = () => S.tracks.flatMap(t => t.clips.filter(c => !isMidi(c) && buffers.has(c.buf)));

function sourceOf(c) {
  const b = buffers.get(c.buf)?.buffer;
  if (!b || !c.reverse) return b || null;
  let r = reversedOf.get(c.buf);
  if (!r || r.src !== b) {
    const buf = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (let i = 0; i < b.numberOfChannels; i++) { const d = buf.getChannelData(i); d.set(b.getChannelData(i)); d.reverse(); }
    r = { src: b, buf };
    reversedOf.set(c.buf, r);
  }
  return r.buf;
}

// { buffer, rate: playbackRate, scale: buffer seconds per source second, pending }
export function playable(c) {
  const src = sourceOf(c);
  if (!src) return null;
  if (c.mode === 'varispeed') return { buffer: src, rate: 1 / c.rate, scale: 1 };
  const pr = pitchRatio(c);
  if (!needsRender(c)) return { buffer: src, rate: pr, scale: 1 };
  const e = request(c);
  if (e.buffer) return { buffer: e.buffer, rate: pr, scale: e.factor };
  return { buffer: src, rate: 1 / c.rate, scale: 1, pending: !e.failed };
}

function request(c, now = false) {
  const k = keyOf(c);
  let e = cache.get(k);
  if (!e) {
    e = { buffer: null, failed: false, factor: factorOf(c) };
    e.promise = new Promise(r => { e.res = r; });
    cache.set(k, e);
    queue.set(k, { e, src: sourceOf(c) });
    // Debounced, so dragging a knob renders only the value it settles on.
    clearTimeout(timer); timer = setTimeout(flush, now ? 0 : 200);
  }
  return e;
}

function flush() {
  timer = 0;
  const want = new Set(audioClips().filter(needsRender).map(keyOf));
  for (const [k, job] of queue) {
    queue.delete(k);
    const { e, src } = job;
    if (!want.has(k)) { cache.delete(k); e.res(null); continue; }
    if (src.duration * e.factor > MAX_SECONDS) { e.failed = true; e.res(null); onReady(); continue; }
    run(src, e.factor).then(
      buf => { e.buffer = buf; e.res(buf); onReady(); },
      () => { e.failed = true; e.res(null); onReady(); });
  }
  for (const [k, e] of cache) if (!want.has(k) && (e.buffer || e.failed)) cache.delete(k);
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./stretch-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ev => {
    const j = jobs.get(ev.data.id);
    jobs.delete(ev.data.id);
    if (ev.data.error) j?.rej(new Error(ev.data.error)); else j?.res(ev.data.chs);
  };
  worker.onerror = ev => {
    for (const j of jobs.values()) j.rej(new Error(ev.message || 'The stretch worker failed.'));
    jobs.clear(); worker = null;
  };
  return worker;
}

function run(src, factor) {
  const id = ++jobN, chs = [];
  for (let i = 0; i < src.numberOfChannels; i++) chs.push(src.getChannelData(i).slice());
  return new Promise((res, rej) => {
    jobs.set(id, { res, rej });
    getWorker().postMessage({ id, chs, factor, sr: src.sampleRate }, chs.map(c => c.buffer));
  }).then(out => {
    const b = ctx.createBuffer(out.length, out[0].length, src.sampleRate);
    out.forEach((d, i) => b.copyToChannel(d, i));
    return b;
  });
}

// Renders every stretch the session needs (the export waits on this).
export async function prepareAll() {
  await Promise.all(audioClips().filter(needsRender).map(c => request(c, true).promise));
}
// Starts (debounced) renders for every clip that needs one, so they're ready before playback reaches them.
export function warmUp() { for (const c of audioClips()) if (needsRender(c)) request(c); }
export const stretchPending = () => [...cache.values()].filter(e => !e.buffer && !e.failed).length;
export const stretchFailed = c => needsRender(c) && !!cache.get(keyOf(c))?.failed;
export function resetStretch() {
  clearTimeout(timer); timer = 0;
  for (const e of cache.values()) e.res(null);
  cache.clear(); queue.clear(); reversedOf.clear();
}
