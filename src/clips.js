// Audio clips: model, fades and crossfades, stretch/pitch edits, and scheduling.
//
// A clip plays source seconds [offset, offset + dur / rate) of its buffer (of the reversed buffer when
// `reverse` is set) over `dur` timeline seconds from `start`. rate > 1 makes the clip longer and slower.
// mode 'stretch' keeps pitch (and allows pitch shifting); 'varispeed' changes pitch with speed, like tape.
// Fades are in timeline seconds. Where two clips on a track overlap they crossfade, using each clip's fade
// shapes: Linear (the default) keeps split audio at constant level; Equal power suits unrelated material.
import { nid, buffers, spb } from './state.js';
import { playable } from './stretch.js';
import { isMidi } from './midi.js';
import { clamp } from './util.js';

export const MIN_RATE = 0.25, MAX_RATE = 4;
export const AUDIO_DEFAULTS = {
  gain: 0, fadeIn: 0, fadeOut: 0, fadeInShape: 'lin', fadeOutShape: 'lin',
  reverse: false, pitch: 0, cents: 0, rate: 1, mode: 'stretch', follow: true
};
export const AUDIO_KEYS = ['id', 'buf', 'start', 'offset', 'dur', ...Object.keys(AUDIO_DEFAULTS)];
export const SHAPES = [['lin', 'Linear'], ['eq', 'Equal power'], ['fast', 'Fast'], ['slow', 'Slow'], ['s', 'S-curve']];
const CURVES = {
  lin: x => x, eq: x => Math.sin(x * Math.PI / 2), fast: x => 1 - (1 - x) ** 2,
  slow: x => x * x, s: x => (1 - Math.cos(Math.PI * x)) / 2
};
export const curveOf = name => CURVES[name] || CURVES.lin;

export function newAudioClip(buf, start, dur, extra = {}) {
  return { id: nid('c'), type: 'audio', buf, start, offset: 0, dur, ...AUDIO_DEFAULTS, ...extra };
}
export const withAudioDefaults = c => ({ ...AUDIO_DEFAULTS, ...c, type: 'audio' });
export const srcLen = c => c.dur / c.rate;
export const bufDur = c => buffers.get(c.buf)?.buffer.duration ?? 0;
export const dbToGain = db => 10 ** (db / 20);
export const fmtSec = s => s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`;

// Effective fades: a clip's own fades, lengthened to cover any overlap with neighbours on its track.
export function fadesOf(t, c) {
  let fi = c.fadeIn, fo = c.fadeOut;
  const si = c.fadeInShape, so = c.fadeOutShape;
  const ce = c.start + c.dur;
  for (const o of t?.clips || []) {
    if (o === c || isMidi(o)) continue;
    const oe = o.start + o.dur;
    if (o.start <= c.start && oe > c.start + 1e-4 && oe < ce) { const ov = oe - c.start; if (ov > fi) fi = ov; }
    if (o.start > c.start && o.start < ce - 1e-4 && oe > ce) { const ov = ce - o.start; if (ov > fo) fo = ov; }
  }
  if (fi + fo > c.dur) { const k = c.dur / (fi + fo); fi *= k; fo *= k; }
  return { fi, fo, si, so };
}
// Fade gain (0..1) at clip-local time u.
export function envAt(c, f, u) {
  let v = 1;
  if (f.fi > 0 && u < f.fi) v *= curveOf(f.si)(clamp(u / f.fi, 0, 1));
  if (f.fo > 0 && u > c.dur - f.fo) v *= curveOf(f.so)(clamp((c.dur - u) / f.fo, 0, 1));
  return v;
}

/* ---------- edits ---------- */
// Change the stretch rate, keeping the same source audio (so the clip gets longer or shorter).
export function setRate(c, r) {
  const sl = srcLen(c);
  c.rate = clamp(r, MIN_RATE, MAX_RATE);
  c.dur = sl * c.rate;
  const room = c.dur - c.fadeIn - c.fadeOut;
  if (room < 0) { c.fadeIn = Math.max(0, c.fadeIn + room / 2); c.fadeOut = Math.max(0, c.dur - c.fadeIn); }
}
// Flip the clip so it plays the same stretch of audio backwards.
export function setReverse(c, on) {
  if (!!c.reverse === on) return;
  c.offset = Math.max(0, bufDur(c) - (c.offset + srcLen(c)));
  c.reverse = on;
}
// Shortest musical length (1, 2 or 4 beats, or whole bars) close to the source length; returns beats.
export function fitToBars(c) {
  const beats = srcLen(c) / spb();
  const target = beats >= 3 ? Math.max(4, Math.round(beats / 4) * 4) : 2 ** clamp(Math.round(Math.log2(beats)), -2, 1);
  setRate(c, target * spb() / srcLen(c));
  return target;
}
export function regionPeak(c) {
  const b = buffers.get(c.buf)?.buffer;
  if (!b) return 0;
  const sr = b.sampleRate, len = Math.round(srcLen(c) * sr);
  const a = c.reverse ? b.length - Math.round(c.offset * sr) - len : Math.round(c.offset * sr);
  let m = 0;
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = Math.max(0, a), e = Math.min(b.length, a + len); i < e; i++) { const v = Math.abs(d[i]); if (v > m) m = v; }
  }
  return m;
}

/* ---------- crossfades ---------- */
export function prevClip(t, c) {
  let p = null;
  for (const o of t.clips) if (o !== c && !isMidi(o) && o.start < c.start && (!p || o.start > p.start)) p = o;
  return p;
}
export function overlapPrev(t, c) {
  const p = prevClip(t, c);
  return p ? Math.max(0, p.start + p.dur - c.start) : 0;
}
// A clip can crossfade with the previous one when they touch or overlap.
export function canCrossfade(t, c) {
  const p = prevClip(t, c);
  return !!p && p.start + p.dur >= c.start - 0.002;
}
// Set the overlap with the previous clip to x seconds. The audio stays where it is in time: this clip's
// start is pulled earlier and the previous clip's end is pushed later, half each where there's source
// audio to do it, so the crossfade is centred on the edit point.
export function setCrossfade(t, c, x) {
  if (!canCrossfade(t, c)) return false;
  const p = prevClip(t, c), ov = Math.max(0, p.start + p.dur - c.start);
  let d = x - ov;
  if (d > 0) {
    const roomC = Math.max(0, Math.min(c.offset * c.rate, c.start - p.start - 0.01));
    const roomP = Math.max(0, Math.min((bufDur(p) - p.offset) * p.rate - p.dur, c.start + c.dur - (p.start + p.dur) - 0.01));
    let a = Math.min(d / 2, roomC);
    const b = Math.min(d - a, roomP);
    a = Math.min(d - b, roomC);
    c.start -= a; c.offset -= a / c.rate; c.dur += a; p.dur += b;
  } else if (d < 0) {
    d = -d;
    let a = Math.min(d / 2, c.dur - 0.02);
    const b = Math.min(d - a, p.dur - 0.02, ov);
    a = Math.min(d - b, c.dur - 0.02);
    c.start += a; c.offset += a / c.rate; c.dur -= a; p.dur -= b;
  }
  return true;
}

/* ---------- playback ---------- */
const DECLICK = 0.004;
function envelope(param, c, f, u0, u1, t0) {
  const base = dbToGain(c.gain), val = u => base * envAt(c, f, u), at = u => t0 + (u - u0);
  const curve = (a, b) => {
    if (b - a < 1e-4) return;
    const n = clamp(Math.ceil((b - a) * 300), 2, 512), arr = new Float32Array(n);
    for (let i = 0; i < n; i++) arr[i] = val(a + (b - a) * i / (n - 1));
    param.setValueCurveAtTime(arr, at(a), b - a);
  };
  try {
    const fs = c.dur - f.fo, tail = f.fo > 0 && u1 > fs;
    let busy = u0; // events must not overlap a value curve, so track where the last one ended
    if (u0 < f.fi) { curve(u0, Math.min(f.fi, u1)); busy = Math.min(f.fi, u1); }
    else if (tail && u0 >= fs) { curve(u0, u1); return; }
    else if (u0 > 1e-3 && u1 - u0 > 2 * DECLICK) {
      // Starting mid-clip (seek or loop): ramp in briefly instead of clicking.
      param.setValueAtTime(0, t0); param.linearRampToValueAtTime(val(u0 + DECLICK), at(u0 + DECLICK)); busy = u0 + DECLICK;
    } else param.setValueAtTime(val(u0), t0);
    if (tail) curve(Math.max(busy, fs), u1);
    else if (u1 < c.dur - 1e-3 && u1 - busy > DECLICK) {
      // Cut short by the loop end: ramp out.
      param.setValueAtTime(val(u1 - DECLICK), at(u1 - DECLICK)); param.linearRampToValueAtTime(0, at(u1));
    }
  } catch {
    param.cancelScheduledValues(0);
    param.setValueAtTime(val(u0), t0);
  }
}

// Play timeline range [a, e) of clip c (track t) into `out`, with position a at context time `when`.
export function scheduleAudioClip(ac, out, t, c, a, e, when, now, keep) {
  const p = playable(c);
  if (!p) return;
  const late = Math.max(0, now - when), t0 = when + late, pa = a + late;
  if (e - pa <= 0.001) return;
  const off = (c.offset + (pa - c.start) / c.rate) * p.scale;
  if (off >= p.buffer.duration) return;
  const src = ac.createBufferSource(), g = ac.createGain();
  src.buffer = p.buffer;
  src.playbackRate.value = p.rate;
  src.connect(g).connect(out);
  src.addEventListener('ended', () => g.disconnect());
  envelope(g.gain, c, fadesOf(t, c), pa - c.start, e - c.start, t0);
  src.start(t0, Math.max(0, off));
  src.stop(t0 + (e - pa));
  keep(src);
}
