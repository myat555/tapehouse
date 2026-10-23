// Clip editor: the whole source file of one audio clip, the part the clip plays, its fades and gain,
// plus controls for level, fades, crossfade, reverse, pitch and time stretch.
//
// On the waveform: drag the region edges to trim · drag the square handles to set the fades ·
// drag the orange gain line up or down · click inside the region to move the playhead there.
import { S, buffers, PEAK_RATE, findClip } from './state.js';
import { position, seek } from './engine.js';
import { knob } from './knob.js';
import { $, h, clamp, status, fmtTime } from './util.js';
import {
  SHAPES, MIN_RATE, MAX_RATE, fadesOf, envAt, dbToGain, srcLen, bufDur, fmtSec,
  overlapPrev, canCrossfade, setCrossfade, setRate, setReverse, fitToBars, regionPeak
} from './clips.js';
import { stretchPending, stretchFailed } from './stretch.js';
import { isMidi } from './midi.js';

const CE = { t: null, c: null, self: false };
let onEdit = () => {};
export const setClipEditHook = fn => { onEdit = fn; };

const cv = $('ceCanvas'), wrap = $('ceWave');
const visible = () => !$('cedit').hidden && !$('mixer').hidden;
const RUL = 16, PAD = 6;
const COL = {
  bg: '#15181d', ruler: '#1a1d23', tick: '#3b424e', text: '#8b93a1', ghost: '#353b46', dim: 'rgba(5,6,8,.6)',
  env: '#f2a93b', mid: '#262b33', playhead: '#dde1e7', handle: '#dde1e7'
};

/* ---------- open / sync ---------- */
export function openClipEditor(t, c) { CE.t = t; CE.c = c; renderTools(); layout(); draw(); }

// Called after arrange edits: drop a deleted clip and pick up trims, moves and tempo changes.
export function ceSync() {
  const f = CE.c && findClip(CE.c.id);
  if (CE.c && (!f || isMidi(f.c))) { CE.t = CE.c = null; renderTools(); }
  else if (f) { CE.t = f.t; if (CE.self) refreshInfo(); else renderTools(); }
  if (visible()) { layout(); draw(); }
}
export const ceRefresh = () => { if (CE.c) refreshInfo(); if (visible()) draw(); };

function edited(rebuild = false) {
  CE.self = true;
  try { onEdit(); } finally { CE.self = false; }
  if (rebuild) renderTools(); else refreshInfo();
  draw();
}

/* ---------- controls ---------- */
const sq = max => ({ toN: v => Math.sqrt(clamp(v / max, 0, 1)), fromN: n => n * n * max });
const fmtDb = v => (v > 0.05 ? '+' : '') + v.toFixed(1) + ' dB';
const fmtSt = v => (Math.round(v) > 0 ? '+' : '') + Math.round(v) + ' st';
const fmtCt = v => (Math.round(v) > 0 ? '+' : '') + Math.round(v) + ' ct';

function renderTools() {
  const has = !!CE.c;
  $('ceEmpty').hidden = has; $('ceBody').hidden = !has;
  $('ceTitle').textContent = has ? `${CE.t.name} · ${buffers.get(CE.c.buf)?.name || 'Clip'}` : '';
  if (!has) { $('ceTools').replaceChildren(); return; }
  const c = CE.c;

  const gain = knob({ label: 'GAIN', min: -48, max: 24, def: 0, fmt: fmtDb, get: () => c.gain, set: v => { c.gain = v; edited(); } });
  const normalize = h('button', { class: 'act', title: 'Set the gain so the loudest peak in the clip reaches -0.3 dBFS', onclick: () => {
    const pk = regionPeak(c);
    if (!pk) { status('This clip is silent, so there is nothing to normalize.'); return; }
    c.gain = clamp(20 * Math.log10(0.966 / pk), -48, 24);
    edited(true); status(`Normalized: gain ${fmtDb(c.gain)}.`);
  } }, 'Normalize');
  const reverse = h('button', { id: 'ceReverse', class: 'act tog', 'aria-pressed': String(!!c.reverse), title: 'Play the clip backwards',
    onclick: () => { setReverse(c, !c.reverse); edited(true); } }, 'Reverse');

  const fadeKnob = (label, key, other) => {
    const m = sq(10);
    return knob({ label, min: 0, max: 1, def: 0, fmt: n => fmtSec(m.fromN(n)), get: () => m.toN(c[key]),
      set: n => { c[key] = Math.min(m.fromN(n), Math.max(0, c.dur - c[other])); edited(); } });
  };
  const shapeSel = (key, label) => {
    const s = h('select', { id: `ce-${key}`, 'aria-label': label, onchange: e => { c[key] = e.target.value; edited(); } },
      ...SHAPES.map(([v, l]) => h('option', { value: v }, l)));
    s.value = c[key];
    return s;
  };
  const xm = sq(4), xOk = canCrossfade(CE.t, c);
  const xfade = knob({ label: 'X-FADE', min: 0, max: 1, def: 0, fmt: n => fmtSec(xm.fromN(n)),
    get: () => xm.toN(overlapPrev(CE.t, c)), set: n => { if (setCrossfade(CE.t, c, xm.fromN(n))) edited(); } });
  xfade.classList.toggle('off', !xOk);

  const mode = h('select', { id: 'ceMode', 'aria-label': 'Stretch mode', onchange: e => { c.mode = e.target.value; edited(true); } },
    h('option', { value: 'stretch' }, 'Stretch · keep pitch'), h('option', { value: 'varispeed' }, 'Varispeed · tape'));
  mode.value = c.mode;
  const lr = Math.log(MAX_RATE / MIN_RATE), rToN = v => Math.log(v / MIN_RATE) / lr, nToR = n => MIN_RATE * Math.exp(n * lr);
  const rate = knob({ label: 'LENGTH', min: 0, max: 1, def: rToN(1), fmt: n => nToR(n).toFixed(2) + '×',
    get: () => rToN(c.rate), set: n => { setRate(c, nToR(n)); edited(); } });
  const bpm = h('input', { id: 'ceBpm', type: 'number', min: 10, max: 999, step: 0.01, value: +(c.rate * S.bpm).toFixed(2),
    title: 'The tempo the audio was recorded at. Changing it stretches the clip to the project tempo.',
    onchange: e => { const v = +e.target.value; if (v > 0) setRate(c, v / S.bpm); edited(true); } });
  const fit = h('button', { class: 'act', title: 'Stretch the clip to the nearest whole number of bars (or 1, 2 or 4 beats)', onclick: () => {
    const beats = fitToBars(c);
    edited(true);
    status(`Stretched to ${beats >= 4 ? `${beats / 4} bar${beats > 4 ? 's' : ''}` : `${beats} beat${beats === 1 ? '' : 's'}`} (${c.rate.toFixed(3)}×).`);
  } }, 'Fit to bars');
  const follow = h('button', { id: 'ceFollow', class: 'act tog', 'aria-pressed': String(c.follow !== false),
    title: 'Stretch this clip when the project tempo changes (needs "Stretch audio" on in the transport)',
    onclick: () => { c.follow = c.follow === false; edited(true); } }, 'Follow tempo');

  const vs = c.mode === 'varispeed';
  const pitch = knob({ label: 'PITCH', min: -24, max: 24, def: 0, bip: true, fmt: fmtSt, get: () => c.pitch, set: v => { c.pitch = Math.round(v); edited(); } });
  const cents = knob({ label: 'FINE', min: -100, max: 100, def: 0, bip: true, fmt: fmtCt, get: () => c.cents, set: v => { c.cents = Math.round(v); edited(); } });
  for (const k of [pitch, cents]) k.classList.toggle('off', vs);

  const col = `--c:${CE.t.color}`;
  $('ceTools').replaceChildren(
    h('div', { class: 'rgroup', style: col }, gain, normalize, reverse),
    h('div', { class: 'rgroup sep', style: col },
      fadeKnob('FADE IN', 'fadeIn', 'fadeOut'), shapeSel('fadeInShape', 'Fade-in shape'),
      fadeKnob('FADE OUT', 'fadeOut', 'fadeIn'), shapeSel('fadeOutShape', 'Fade-out shape'), xfade),
    h('div', { class: 'rgroup sep', style: col },
      mode, rate, h('label', { class: 'field' }, 'Source BPM', bpm), fit, follow),
    h('div', { class: 'rgroup sep', style: col, title: vs ? 'Varispeed changes pitch along with speed. Switch to Stretch to shift pitch on its own.' : '' },
      pitch, cents),
    h('span', { id: 'ceInfo', class: 'ceinfo' }));
  refreshInfo();
}

function refreshInfo() {
  const c = CE.c, info = $('ceInfo');
  if (!c || !info) return;
  const parts = [
    `Plays ${fmtTime(c.offset)}–${fmtTime(c.offset + srcLen(c))} of ${fmtTime(bufDur(c))}${c.reverse ? ' (reversed)' : ''}`,
    `${fmtSec(c.dur)} on the timeline`
  ];
  if (Math.abs(c.rate - 1) > 1e-4) parts.push(`${c.rate.toFixed(3)}× length`);
  if (!canCrossfade(CE.t, c)) parts.push('Butt it against the clip before it to crossfade');
  if (stretchFailed(c)) parts.push('Too long to stretch; playing varispeed');
  else if (stretchPending()) parts.push('Stretching…');
  info.textContent = parts.join(' · ');
  const bpm = $('ceBpm');
  if (bpm && document.activeElement !== bpm) bpm.value = +(c.rate * S.bpm).toFixed(2);
}

/* ---------- waveform ---------- */
function geo() {
  const W = cv.clientWidth, H = cv.clientHeight, D = bufDur(CE.c) || 1, top = RUL + PAD, bot = H - PAD;
  return { W, H, D, top, bot, mid: (top + bot) / 2, xOf: s => s / D * W, sOf: x => x / W * D };
}
// The gain line uses the upper half: -48 dB at the centre line, +24 dB at the top.
const dbY = (db, G) => G.top + (1 - clamp((db + 48) / 72, 0, 1)) * (G.mid - G.top);

export function layout() {
  const dpr = window.devicePixelRatio || 1, W = wrap.clientWidth, H = wrap.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
}

function rulerLabel(s, step) {
  if (step >= 1) return fmtTime(s).replace(/\.\d+$/, '');
  return s < 60 ? s.toFixed(step >= 0.1 ? 1 : 2) : fmtTime(s);
}

export function draw() {
  if (!visible()) return;
  const g = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = CE.c, b = c && buffers.get(c.buf);
  if (!b) { g.clearRect(0, 0, cv.width, cv.height); return; }
  const G = geo();
  g.fillStyle = COL.bg; g.fillRect(0, 0, G.W, G.H);

  // Ruler in source time
  g.fillStyle = COL.ruler; g.fillRect(0, 0, G.W, RUL);
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => G.xOf(s) >= 64) || 600;
  g.font = '10px "JetBrains Mono", ui-monospace, monospace'; g.textBaseline = 'middle';
  for (let k = 0; k * step <= G.D; k++) {
    const x = Math.round(G.xOf(k * step)) + 0.5;
    g.fillStyle = COL.tick; g.fillRect(x, 0, 1, RUL);
    g.fillStyle = COL.text; g.fillText(rulerLabel(k * step, step), x + 3, RUL / 2);
  }

  // Waveform: the whole file as a ghost, the played region shaped by gain and fades in the track colour
  const f = fadesOf(CE.t, c), gain = dbToGain(c.gain), r0 = c.offset, r1 = c.offset + srcLen(c);
  const half = G.mid - G.top, pk = b.peaks, n = pk.length, pxS = G.D / G.W;
  g.fillStyle = COL.mid; g.fillRect(0, Math.round(G.mid), G.W, 1);
  for (let x = 0; x < G.W; x++) {
    const s0 = x * pxS, i0 = Math.floor(s0 * PEAK_RATE), i1 = Math.max(i0 + 1, Math.ceil((s0 + pxS) * PEAK_RATE));
    let m = 0;
    for (let i = i0; i < i1 && i < n; i++) { const v = pk[c.reverse ? n - 1 - i : i]; if (v > m) m = v; }
    const raw = Math.max(0.5, m * b.norm * half * 0.92), sm = s0 + pxS / 2;
    g.fillStyle = COL.ghost; g.fillRect(x, G.mid - raw, 1, raw * 2);
    if (sm >= r0 && sm <= r1) {
      const a = clamp(raw * gain * envAt(c, f, (sm - r0) * c.rate), 0.5, half);
      g.fillStyle = CE.t.color; g.fillRect(x, G.mid - a, 1, a * 2);
    }
  }
  const x0 = G.xOf(r0), x1 = G.xOf(r1);
  g.fillStyle = COL.dim;
  g.fillRect(0, RUL, x0, G.H - RUL); g.fillRect(x1, RUL, G.W - x1, G.H - RUL);

  // Gain envelope (gain × fades)
  g.strokeStyle = COL.env; g.lineWidth = 1.5; g.beginPath();
  for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(G.W, Math.ceil(x1)); x++) {
    const u = clamp((G.sOf(x) - r0) * c.rate, 0, c.dur), v = gain * envAt(c, f, u);
    const y = dbY(v > 1e-6 ? 20 * Math.log10(v) : -100, G);
    if (x === Math.max(0, Math.floor(x0))) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();

  // Region edges and fade handles
  g.fillStyle = COL.env;
  for (const x of [x0, x1]) { g.fillRect(Math.round(x) - 1, RUL, 2, G.H - RUL); g.fillRect(Math.round(x) - 4, 0, 8, RUL); }
  g.fillStyle = COL.handle;
  for (const x of fadeXs(G)) g.fillRect(Math.round(x) - 4, G.top - 3, 8, 8);

  // Playhead, mapped into source time
  const p = position();
  if (p >= c.start && p <= c.start + c.dur) {
    const x = Math.round(G.xOf(r0 + (p - c.start) / c.rate)) + 0.5;
    g.fillStyle = COL.playhead; g.fillRect(x, RUL, 1, G.H - RUL);
  }
}
const fadeXs = G => [G.xOf(CE.c.offset + CE.c.fadeIn / CE.c.rate), G.xOf(CE.c.offset + (CE.c.dur - CE.c.fadeOut) / CE.c.rate)];

/* ---------- mouse ---------- */
function hit(x, y) {
  const c = CE.c, G = geo(), x0 = G.xOf(c.offset), x1 = G.xOf(c.offset + srcLen(c)), [fiX, foX] = fadeXs(G);
  if (Math.abs(y - (G.top + 1)) < 9) {
    if (Math.abs(x - fiX) < 7 && c.fadeIn >= c.fadeOut) return 'fi';
    if (Math.abs(x - foX) < 7) return 'fo';
    if (Math.abs(x - fiX) < 7) return 'fi';
  }
  if (Math.abs(x - x0) < 6) return 'l';
  if (Math.abs(x - x1) < 6) return 'r';
  if (x > x0 && x < x1 && Math.abs(y - dbY(c.gain, G)) < 6) return 'gain';
  if (x > x0 && x < x1 && y > RUL) return 'seek';
  return null;
}
const CURSORS = { fi: 'ew-resize', fo: 'ew-resize', l: 'ew-resize', r: 'ew-resize', gain: 'ns-resize', seek: 'text' };
const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

cv.addEventListener('pointermove', e => {
  if (e.buttons || !CE.c) return;
  cv.style.cursor = CURSORS[hit(...local(e))] || 'default';
});
cv.addEventListener('pointerdown', e => {
  if (!CE.c || e.button !== 0) return;
  e.preventDefault();
  const c = CE.c, [x, y] = local(e), mode = hit(x, y);
  if (!mode) return;
  if (mode === 'seek') { seek(c.start + (geo().sOf(x) - c.offset) * c.rate); draw(); return; }
  try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  const o = { start: c.start, offset: c.offset, dur: c.dur, gain: c.gain }, minSrc = 0.02 / c.rate;
  const mv = ev => {
    const G = geo(), [mx, my] = local(ev), s = G.sOf(mx), u = (s - c.offset) * c.rate;
    if (mode === 'l') {
      let ns = clamp(s, 0, o.offset + o.dur / c.rate - minSrc);
      ns = Math.max(ns, o.offset - o.start / c.rate); // can't start before 0 on the timeline
      const d = (ns - o.offset) * c.rate;
      c.offset = ns; c.start = o.start + d; c.dur = o.dur - d;
    } else if (mode === 'r') {
      c.dur = (clamp(s, o.offset + minSrc, G.D) - o.offset) * c.rate;
    } else if (mode === 'fi') c.fadeIn = clamp(u, 0, Math.max(0, c.dur - c.fadeOut));
    else if (mode === 'fo') c.fadeOut = clamp(c.dur - u, 0, Math.max(0, c.dur - c.fadeIn));
    else if (mode === 'gain') c.gain = clamp(o.gain - (my - y) * 72 / (G.mid - G.top) * (ev.shiftKey ? 0.2 : 1), -48, 24);
    c.fadeIn = Math.min(c.fadeIn, c.dur); c.fadeOut = Math.min(c.fadeOut, c.dur - c.fadeIn);
    edited();
  };
  const up = () => {
    cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up);
    renderTools();
  };
  cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
});

new ResizeObserver(() => { if (visible()) { layout(); draw(); } }).observe(wrap);
let wasPlaying = false;
(function tick() {
  requestAnimationFrame(tick);
  if ((S.playing || wasPlaying) && CE.c && visible()) draw();
  wasPlaying = S.playing;
})();
