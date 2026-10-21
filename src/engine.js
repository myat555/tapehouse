// Transport: a lookahead scheduler that queues clip playback and metronome clicks
// ~200 ms ahead and stitches loop passes together sample-accurately.
import { S, buffers, spb, projectEnd } from './state.js';
import { ctx, clickBus } from './audio.js';
import { isMidi, scheduleMidiClip } from './midi.js';

const LOOK = 0.2;
let sources = [], timer = 0;
// A segment is a stretch of linear playback: timeline position segPos plays at ctx time segCtx.
export let T = { segCtx: 0, segPos: 0, schedPos: 0, first: true, prev: null };
export const events = new EventTarget();
const changed = () => events.dispatchEvent(new Event('change'));

export function position() {
  if (!S.playing) return S.pos;
  const now = ctx.currentTime, seg = (now < T.segCtx && T.prev) ? T.prev : T;
  return seg.segPos + Math.max(0, now - seg.segCtx);
}

// Holds AudioScheduledSourceNodes and instrument voices so Stop can silence everything.
function keep(src) {
  sources.push(src);
  if (src instanceof AudioScheduledSourceNode) src.onended = () => { const i = sources.indexOf(src); if (i >= 0) sources.splice(i, 1); };
}
function click(when, accent) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1760 : 1175;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.7, when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
  o.connect(g).connect(clickBus); o.start(when); o.stop(when + 0.05); keep(o);
}

function scheduleRange(from, to, end, initial) {
  const now = ctx.currentTime;
  for (const t of S.tracks) for (const c of t.clips) {
    if (isMidi(c)) { scheduleMidiClip(ctx, t.ch.input, t, c, from, to, end, T.segCtx - T.segPos, keep); continue; }
    const cs = c.start, ce = c.start + c.dur;
    if (!((cs >= from && cs < to) || (initial && cs < from && ce > from))) continue;
    const b = buffers.get(c.buf); if (!b) continue;
    const a = Math.max(cs, from), e = Math.min(ce, end);
    if (e - a <= 0.001) continue;
    const src = ctx.createBufferSource();
    src.buffer = b.buffer; src.connect(t.ch.input);
    const when = T.segCtx + (a - T.segPos);
    src.start(Math.max(when, now), c.offset + (a - cs) + Math.max(0, now - when), e - a);
    keep(src);
  }
  if (S.metro) {
    const q = spb();
    for (let k = Math.ceil(from / q - 1e-7); k * q < to; k++) click(T.segCtx + (k * q - T.segPos), k % 4 === 0);
  }
}

function pump() {
  if (!S.playing) return;
  const horizon = ctx.currentTime + LOOK;
  sources = sources.filter(s => !(s.end < ctx.currentTime - 0.1));
  for (let guard = 0; guard < 8; guard++) {
    const looping = S.loop && !S.recording && S.loopEnd - S.loopStart > 0.05 && T.segPos < S.loopEnd;
    const end = looping ? S.loopEnd : Infinity;
    const to = Math.min(T.segPos + (horizon - T.segCtx), end);
    if (to > T.schedPos) { scheduleRange(T.schedPos, to, end, T.first); T.first = false; T.schedPos = to; }
    if (looping && T.schedPos >= end) {
      T.prev = { segCtx: T.segCtx, segPos: T.segPos };
      T.segCtx += end - T.segPos; T.segPos = S.loopStart; T.schedPos = S.loopStart; T.first = true;
    } else break;
  }
  if (!S.loop && !S.metro && !S.recording && position() > projectEnd() + 2) stop();
}

function stopSources() {
  for (const s of sources) { try { s.stop(); } catch { /* already stopped */ } }
  sources = [];
}
export function startEngine(pos) {
  stopSources();
  if (S.loop && !S.recording && pos >= S.loopEnd && S.loopEnd > S.loopStart) pos = S.loopStart;
  T = { segCtx: ctx.currentTime + 0.05, segPos: pos, schedPos: pos, first: true, prev: null };
  pump();
}
export function play() {
  if (S.playing) return;
  ctx.resume();
  S.playing = true; S.playFrom = S.pos;
  startEngine(S.pos);
  clearInterval(timer); timer = setInterval(pump, 25);
  changed();
}
// Stop returns to where playback started; stopping while stopped returns to zero.
export function stop() {
  if (!S.playing) { S.pos = 0; S.playFrom = 0; changed(); return; }
  S.playing = false; clearInterval(timer); stopSources();
  S.pos = S.playFrom;
  changed();
}
export function seek(t) {
  t = Math.max(0, t);
  S.pos = t; S.playFrom = t;
  if (S.playing) startEngine(t);
}
export const restartIfPlaying = () => { if (S.playing) startEngine(position()); };
