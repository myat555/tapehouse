// Arrange view (tracks, clips, ruler), mixer strips, and the per-frame playhead/meter loop.
import { S, buffers, PEAK_RATE, spb, snapT, allChannels, findCh, trackById, findClip, projectEnd, fmtBars, nid } from './state.js';
import { applyParams, applyAll, route, removeChannel, addTrack } from './audio.js';
import { position, seek, restartIfPlaying } from './engine.js';
import { inputAnalyser } from './recorder.js';
import { $, h, clamp, status, dbOf, fmtEq, fmtPct, fmtPan, fmtTime } from './util.js';
import { knob } from './knob.js';
import { isMidi, newMidiClip, ensureInstrument, cloneClip } from './midi.js';
import { getInstrument, newInstrumentState } from './instruments/index.js';
import { openRoll, blurRoll, rollSync, layout as rollLayout, draw as rollDraw } from './pianoroll.js';
import { openClipEditor, ceSync, layout as ceLayout, draw as ceDraw } from './clipeditor.js';
import { MIN_RATE, MAX_RATE, fadesOf, envAt, curveOf, dbToGain } from './clips.js';
import { warmUp } from './stretch.js';

const content = $('content'), rowsEl = $('rows'), ruler = $('ruler'), scroller = $('scroller');
const loopBar = h('div', { class: 'loopbar' }), rulerHead = h('div', { class: 'rhead' });
export const headW = () => $('corner').offsetWidth;

/* ---------- arrange ---------- */
const timelineSec = () => Math.max(projectEnd() + 32 * spb(), S.loopEnd + 8 * spb(), 60);

export function renderAll() { renderTracks(); renderMixer(); }

export function renderTracks() {
  const W = Math.ceil(timelineSec() * S.zoom), beatPx = spb() * S.zoom, barPx = beatPx * 4;
  content.style.setProperty('--tl-w', W + 'px');
  content.style.setProperty('--bar-px', barPx + 'px');
  content.style.setProperty('--beat-px', (beatPx < 7 ? barPx : beatPx) + 'px');
  rowsEl.replaceChildren(...S.tracks.map(trackRow));
  $('trkCount').textContent = S.tracks.length;
  renderRuler(W, barPx);
  updateLoopUI();
  for (const el of rowsEl.querySelectorAll('.clip')) drawClip(el);
  rollSync();
  ceSync();
  warmUp();
}

function trackRow(t, i) {
  const meter = h('i');
  t.ui.h = meter;
  const head = h('div', { class: 'head', style: `--c:${t.color}` },
    h('div', { class: 'hnum' }, String(i + 1)),
    h('input', { class: 'tname', id: 'tn-' + t.id, value: t.name, 'aria-label': 'Track name',
      onchange: e => { t.name = e.target.value.trim() || t.name; renderMixer(); } }),
    flagBtn(t, 'm'), flagBtn(t, 's'), flagBtn(t, 'r'),
    routeSelect(t, 'h'),
    h('button', { class: 'mini x', title: `Delete ${t.name}`, 'aria-label': `Delete ${t.name}`, onclick: () => deleteTrack(t.id) }, '×'),
    h('div', { class: 'hmeter' }, meter));
  const lane = h('div', { class: 'lane', dataset: { id: t.id } }, ...t.clips.map(c => clipEl(t, c)));
  return h('div', { class: 'row' + (S.selTrack === t.id ? ' sel' : '') + (t.arm ? ' armed' : ''), dataset: { id: t.id } }, head, lane);
}

const FLAGS = { m: ['mute', 'Mute'], s: ['solo', 'Solo'], r: ['arm', 'Arm for recording'] };
function flagBtn(o, f) {
  const [key, title] = FLAGS[f], on = !!o[key];
  return h('button', {
    class: `mini ${f}` + (on ? ' on' : ''), dataset: { [f]: o.id }, 'aria-pressed': String(on), title,
    onclick: () => { o[key] = !o[key]; applyAll(); refreshFlags(); }
  }, f.toUpperCase());
}
export function refreshFlags() {
  for (const f of Object.keys(FLAGS)) {
    for (const b of document.querySelectorAll(`[data-${f}]`)) {
      const on = !!findCh(b.dataset[f])?.[FLAGS[f][0]];
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    }
  }
  for (const r of rowsEl.querySelectorAll('.row')) r.classList.toggle('armed', !!trackById(r.dataset.id)?.arm);
}

function routeSelect(o, where) {
  const s = h('select', {
    class: 'route', id: `rt-${where}-${o.id}`, 'aria-label': `${o.name} output`,
    onchange: e => { o.out = e.target.value; route(o); renderAll(); }
  }, h('option', { value: 'master' }, '→ Master'), ...S.buses.map(b => h('option', { value: b.id }, '→ ' + b.name)));
  s.value = o.out;
  return s;
}

function clipLabel(t, c) {
  if (isMidi(c)) return `${getInstrument(t.inst?.type)?.name || 'MIDI'} · MIDI`;
  const tags = [buffers.get(c.buf)?.name || 'Clip'];
  if (Math.abs(c.rate - 1) > 1e-3) tags.push(c.rate.toFixed(2) + '×');
  if (c.mode !== 'varispeed' && (c.pitch || c.cents)) tags.push(`${c.pitch + c.cents / 100 > 0 ? '+' : ''}${(c.pitch + c.cents / 100).toFixed(c.cents ? 2 : 0)} st`);
  if (c.mode === 'varispeed' && Math.abs(c.rate - 1) > 1e-3) tags.push('tape');
  if (c.reverse) tags.push('rev');
  if (Math.abs(c.gain) > 0.05) tags.push(`${c.gain > 0 ? '+' : ''}${c.gain.toFixed(1)} dB`);
  return tags.join(' · ');
}
function clipEl(t, c) {
  const el = h('div', {
    class: 'clip' + (isMidi(c) ? ' midi' : '') + (S.selClip === c.id ? ' sel' : ''),
    style: `--c:${t.color};left:${c.start * S.zoom}px;width:${Math.max(3, c.dur * S.zoom)}px`
  }, h('span', { class: 'cname' }, clipLabel(t, c)), h('canvas'),
  h('i', { class: 'grip l', title: isMidi(c) ? 'Drag to trim' : 'Drag to trim · Alt+drag to stretch' }),
  h('i', { class: 'grip r', title: isMidi(c) ? 'Drag to trim' : 'Drag to trim · Alt+drag to stretch' }),
  isMidi(c) ? null : h('i', { class: 'fh l', title: 'Drag to set the fade-in' }),
  isMidi(c) ? null : h('i', { class: 'fh r', title: 'Drag to set the fade-out' }));
  el._clip = c; el._track = t;
  return el;
}

function drawClip(el) {
  const c = el._clip;
  const cv = el.querySelector('canvas'), dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, c.dur * S.zoom), hh = cv.clientHeight || 50;
  const W = Math.min(Math.round(w * dpr), 12000), H = Math.round(hh * dpr);
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = getComputedStyle(el).getPropertyValue('--c').trim() || '#ccc';
  if (isMidi(c)) { drawNotes(g, c, W, H); return; }
  const b = buffers.get(c.buf); if (!b) return;
  const f = fadesOf(el._track, c), gain = dbToGain(c.gain), mid = H / 2, pk = b.peaks, n = pk.length, spx = c.dur / c.rate / W;
  for (let x = 0; x < W; x++) {
    const s0 = c.offset + x * spx, i0 = Math.floor(s0 * PEAK_RATE), i1 = Math.max(i0 + 1, Math.ceil((s0 + spx) * PEAK_RATE));
    let m = 0;
    for (let i = i0; i < i1 && i < n; i++) { const v = pk[c.reverse ? n - 1 - i : i]; if (v > m) m = v; }
    const a = clamp(m * b.norm * mid * 0.92 * gain * envAt(c, f, (x + 0.5) / W * c.dur), 0.5, mid);
    g.fillRect(x, mid - a, 1, a * 2);
  }
  // Fades: shade above each fade curve
  const shade = (x0, x1, y) => {
    if (x1 - x0 < 1) return;
    g.beginPath(); g.moveTo(x0, 0);
    for (let x = x0; x <= x1; x++) g.lineTo(x, y(x));
    g.lineTo(x1, 0); g.closePath();
    g.fillStyle = 'rgba(8,9,12,.5)'; g.fill();
    g.beginPath();
    for (let x = x0; x <= x1; x++) x === x0 ? g.moveTo(x, y(x)) : g.lineTo(x, y(x));
    g.strokeStyle = 'rgba(221,225,231,.7)'; g.lineWidth = dpr; g.stroke();
  };
  const fiW = Math.round(f.fi / c.dur * W), foW = Math.round(f.fo / c.dur * W);
  shade(0, fiW, x => H * (1 - curveOf(f.si)(x / fiW)));
  shade(W - foW, W, x => H * (1 - curveOf(f.so)((W - x) / foW)));
  const fl = el.querySelector('.fh.l'), fr = el.querySelector('.fh.r');
  if (fl) { fl.style.left = c.fadeIn * S.zoom + 'px'; fr.style.right = c.fadeOut * S.zoom + 'px'; }
}

// Mini piano roll inside a MIDI clip, scaled to the clip's pitch range.
function drawNotes(g, c, W, H) {
  const vis = c.notes.filter(n => n.s - c.off < c.beats && n.s + n.d > c.off);
  if (!vis.length) return;
  let lo = Math.min(...vis.map(n => n.p)), hi = Math.max(...vis.map(n => n.p));
  if (hi - lo < 11) { const m = (lo + hi) / 2; lo = Math.floor(m - 6); hi = lo + 11; }
  const rows = hi - lo + 1, rh = Math.max(1, (H - 4) / rows), xb = W / c.beats;
  for (const n of vis) {
    const x = (n.s - c.off) * xb, y = 2 + (hi - n.p) * rh;
    g.fillRect(Math.max(0, x), y, Math.max(2, n.d * xb - 1), Math.max(1.5, rh - 1));
  }
}

function renderRuler(W, barPx) {
  ruler.style.width = W + 'px';
  let every = 1;
  while (barPx * every < 34) every *= 2;
  const marks = [];
  for (let b = 0; b * barPx < W; b += every) marks.push(h('span', { class: 'bar', style: `left:${b * barPx}px` }, String(b + 1)));
  ruler.replaceChildren(...marks, loopBar, rulerHead);
}

export function updateLoopUI() {
  const l = S.loopStart * S.zoom + 'px', w = Math.max(0, (S.loopEnd - S.loopStart) * S.zoom) + 'px';
  for (const el of [loopBar, $('loopShade')]) { el.style.left = l; el.style.width = w; el.classList.toggle('off', !S.loop); }
  $('bLoop').setAttribute('aria-pressed', String(S.loop));
}

export function markSelection() {
  for (const r of rowsEl.querySelectorAll('.row')) r.classList.toggle('sel', r.dataset.id === S.selTrack);
  for (const el of rowsEl.querySelectorAll('.clip')) el.classList.toggle('sel', el._clip.id === S.selClip);
  for (const s of document.querySelectorAll('.strip')) s.classList.toggle('sel', s.dataset.id === S.selTrack);
}

rowsEl.addEventListener('pointerdown', e => {
  const clipE = e.target.closest('.clip');
  blurRoll();
  if (clipE) { startClipDrag(e, clipE); return; }
  const lane = e.target.closest('.lane');
  if (lane) {
    S.selTrack = lane.dataset.id; S.selClip = null; markSelection();
    seek((e.clientX - lane.getBoundingClientRect().left) / S.zoom);
    return;
  }
  const row = e.target.closest('.row');
  if (row && !e.target.closest('input,select,button')) { S.selTrack = row.dataset.id; markSelection(); }
});

function startClipDrag(e, el) {
  if (e.button !== 0) return;
  e.preventDefault();
  const c = el._clip, src = el._track;
  let dst = src, moved = false;
  S.selClip = c.id; S.selTrack = src.id; markSelection();
  const cl = e.target.classList, midi = isMidi(c), minDur = midi ? spb() / 16 : 0.02;
  const mode = cl.contains('fh') ? (cl.contains('l') ? 'fi' : 'fo') : cl.contains('grip') ? (cl.contains('l') ? 'l' : 'r') : 'm';
  const stretch = !midi && e.altKey && (mode === 'l' || mode === 'r');
  const x0 = e.clientX, y0 = e.clientY;
  const o = { start: c.start, offset: c.offset, dur: c.dur, off: c.off, beats: c.beats, rate: c.rate, fadeIn: c.fadeIn, fadeOut: c.fadeOut };
  // Alt-drag stretch keeps the source audio and changes the rate, within MIN_RATE..MAX_RATE.
  const durLo = midi ? 0 : o.dur / o.rate * MIN_RATE, durHi = midi ? 0 : o.dur / o.rate * MAX_RATE;
  const bufDur = midi ? Infinity : buffers.get(c.buf).buffer.duration;
  const onMove = ev => {
    if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
    if (!moved) { moved = true; el.classList.add('drag'); }
    const dt = (ev.clientX - x0) / S.zoom;
    if (mode === 'm') {
      let ns = Math.max(0, o.start + dt);
      if (S.snap) ns = snapT(ns);
      c.start = ns;
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lane[data-id]');
      if (under && under.dataset.id !== dst.id) {
        dst = trackById(under.dataset.id);
        under.append(el); el.style.setProperty('--c', dst.color); drawClip(el);
      }
    } else if (mode === 'fi' || mode === 'fo') {
      if (mode === 'fi') c.fadeIn = clamp(o.fadeIn + dt, 0, c.dur - c.fadeOut);
      else c.fadeOut = clamp(o.fadeOut - dt, 0, c.dur - c.fadeIn);
    } else if (mode === 'r') {
      let ne = o.start + o.dur + dt;
      if (S.snap) ne = snapT(ne);
      if (midi) { c.beats = Math.max(minDur, ne - o.start) / spb(); c.dur = c.beats * spb(); }
      else if (stretch) { c.dur = clamp(ne - o.start, durLo, durHi); c.rate = o.rate * c.dur / o.dur; }
      else c.dur = clamp(ne - o.start, minDur, (bufDur - o.offset) * o.rate);
    } else {
      let ns = o.start + dt;
      if (S.snap) ns = snapT(ns);
      const end = o.start + o.dur;
      if (stretch) {
        ns = clamp(ns, Math.max(0, end - durHi), end - durLo);
        c.start = ns; c.dur = end - ns; c.rate = o.rate * c.dur / o.dur;
      } else {
        ns = clamp(ns, midi ? 0 : Math.max(0, o.start - o.offset * o.rate), end - minDur);
        const d = ns - o.start;
        c.start = ns;
        if (midi) { c.off = o.off + d / spb(); c.beats = o.beats - d / spb(); c.dur = c.beats * spb(); }
        else { c.offset = o.offset + d / o.rate; c.dur = o.dur - d; }
      }
    }
    if (!midi) { c.fadeIn = Math.min(c.fadeIn, c.dur); c.fadeOut = Math.min(c.fadeOut, c.dur - c.fadeIn); }
    el.style.left = c.start * S.zoom + 'px';
    el.style.width = Math.max(3, c.dur * S.zoom) + 'px';
    if (mode !== 'm') drawClip(el);
    if (stretch) status(`Stretch ${c.rate.toFixed(3)}× · ${(c.dur).toFixed(2)} s`);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    el.classList.remove('drag');
    if (dst !== src) { src.clips.splice(src.clips.indexOf(c), 1); dst.clips.push(c); S.selTrack = dst.id; }
    if (moved) { renderTracks(); restartIfPlaying(); }
    // A plain click opens the clip in its editor: audio in the Clip tab; MIDI if the piano roll is showing.
    else if (!midi) editAudio(dst, c);
    else if (S.mixerOpen && S.dockTab === 'roll') editClip(dst, c);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// Double-click: a MIDI clip opens in the piano roll; an audio clip becomes a Sampler track;
// empty lane space gets a new one-bar MIDI clip.
rowsEl.addEventListener('dblclick', e => {
  const clipE = e.target.closest('.clip');
  if (clipE) {
    const { _clip: c, _track: t } = clipE;
    if (isMidi(c)) editClip(t, c);
    else samplerFromClip(c);
    return;
  }
  const lane = e.target.closest('.lane[data-id]');
  if (!lane) return;
  const t = trackById(lane.dataset.id), bar = 4 * spb();
  const at = Math.floor((e.clientX - lane.getBoundingClientRect().left) / S.zoom / bar) * bar;
  ensureInstrument(t);
  const c = newMidiClip(at, 4);
  t.clips.push(c); S.selClip = c.id;
  renderAll(); editClip(t, c);
  status(`Added a MIDI clip on ${t.name}. Click in the piano roll to draw notes.`);
});

export function editAudio(t, c) {
  S.selTrack = t.id; S.selClip = c.id; markSelection();
  showDock('clip', false);
  openClipEditor(t, c);
}

export function editClip(t, c) {
  S.selTrack = t.id; S.selClip = c.id; markSelection();
  showDock('roll', false);
  openRoll(t, c);
}

function samplerFromClip(c) {
  const b = buffers.get(c.buf); if (!b) return;
  const t = addTrack(`${b.name} sampler`.slice(0, 28));
  t.inst = newInstrumentState('sampler', { buf: c.buf, root: 60 });
  const bar = 4 * spb(), start = Math.floor(c.start / bar) * bar;
  const clip = newMidiClip(start, 4, [{ s: 0, d: 1, p: 60, v: 100 }]);
  t.clips.push(clip);
  renderAll(); editClip(t, clip);
  status(`Made a Sampler track from "${b.name}". C4 plays it at its original pitch; draw notes to play it at other pitches.`);
}

ruler.addEventListener('pointerdown', e => {
  e.preventDefault();
  const r = ruler.getBoundingClientRect(), tAt = ev => Math.max(0, (ev.clientX - r.left) / S.zoom), t0 = tAt(e);
  let drag = false;
  const mv = ev => {
    if (!drag && Math.abs(ev.clientX - e.clientX) < 4) return;
    drag = true;
    let a = t0, b = tAt(ev);
    if (S.snap) { a = snapT(a); b = snapT(b); }
    S.loopStart = Math.min(a, b); S.loopEnd = Math.max(a, b);
    S.loop = S.loopEnd - S.loopStart > 0.05;
    updateLoopUI();
  };
  const up = () => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    if (!drag) seek(t0);
    else {
      restartIfPlaying();
      status(S.loop ? `Loop set to ${fmtBars(S.loopStart)} – ${fmtBars(S.loopEnd)}.` : 'Loop cleared.');
    }
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
});

/* ---------- clip & channel edits ---------- */
export function deleteClip() {
  const f = findClip(S.selClip); if (!f) return;
  f.t.clips.splice(f.t.clips.indexOf(f.c), 1);
  S.selClip = null;
  renderTracks(); restartIfPlaying();
}
export function splitClip() {
  const f = findClip(S.selClip);
  if (!f) { status('Select a clip, then press S to split it at the playhead.'); return; }
  const { t, c } = f, p = position();
  if (p <= c.start + 0.01 || p >= c.start + c.dur - 0.01) { status('Move the playhead inside the selected clip to split it.'); return; }
  if (isMidi(c)) {
    const rel = (p - c.start) / spb();
    t.clips.push({ ...cloneClip(c), id: nid('c'), start: p, off: c.off + rel, beats: c.beats - rel, dur: c.dur - (p - c.start) });
    c.beats = rel;
  } else {
    const at = p - c.start;
    t.clips.push({ ...c, id: nid('c'), start: p, offset: c.offset + at / c.rate, dur: c.dur - at, fadeIn: 0, fadeOut: Math.min(c.fadeOut, c.dur - at) });
    c.fadeOut = 0; c.fadeIn = Math.min(c.fadeIn, at);
  }
  c.dur = p - c.start;
  renderTracks(); restartIfPlaying();
}
export function duplicateClip() {
  const f = findClip(S.selClip); if (!f) return;
  const n = { ...cloneClip(f.c), id: nid('c'), start: f.c.start + f.c.dur };
  f.t.clips.push(n); S.selClip = n.id;
  renderTracks(); restartIfPlaying();
}
export function deleteTrack(id) {
  const t = trackById(id); if (!t) return;
  removeChannel(t);
  S.tracks.splice(S.tracks.indexOf(t), 1);
  if (S.selTrack === id) S.selTrack = null;
  applyAll(); renderAll(); restartIfPlaying();
  status(`Deleted ${t.name}.`);
}
export function deleteBus(id) {
  const b = S.buses.find(x => x.id === id); if (!b) return;
  for (const t of S.tracks) if (t.out === id) { t.out = 'master'; route(t); }
  removeChannel(b);
  S.buses.splice(S.buses.indexOf(b), 1);
  renderAll();
  status(`Deleted ${b.name}. Its tracks now go to the master.`);
}

/* ---------- mixer ---------- */
// Fader law: gain = 2·p², so the top of travel is +6 dB and unity sits at p ≈ 0.71.
const pOfVol = v => Math.sqrt(v / 2), volOfP = p => 2 * p * p;
function faderBlock(o) {
  const db = h('div', { class: 'db' });
  const cap = h('div', { class: 'cap' });
  const ftrack = h('div', { class: 'ftrack', tabindex: 0, role: 'slider', 'aria-label': `${o.name} volume` }, cap);
  const scale = h('div', { class: 'fscale', 'aria-hidden': 'true' },
    ...[6, 0, -6, -12, -24, -48].map(d => h('span', { style: `bottom:calc(${pOfVol(Math.pow(10, d / 20))} * (100% - 22px) + 11px)` }, d > 0 ? '+' + d : String(d))));
  const sync = () => {
    cap.style.bottom = `calc(${pOfVol(o.vol)} * (100% - 22px))`;
    db.textContent = dbOf(o.vol);
    ftrack.setAttribute('aria-valuetext', dbOf(o.vol) + ' dB');
  };
  const put = p => { o.vol = volOfP(clamp(p, 0, 1)); applyParams(o); sync(); };
  ftrack.addEventListener('pointerdown', e => {
    e.preventDefault(); ftrack.focus(); ftrack.setPointerCapture(e.pointerId);
    const y0 = e.clientY, p0 = pOfVol(o.vol), travel = Math.max(20, ftrack.clientHeight - 22);
    const mv = ev => put(p0 + (y0 - ev.clientY) / travel * (ev.shiftKey ? 0.25 : 1));
    const up = () => { ftrack.removeEventListener('pointermove', mv); ftrack.removeEventListener('pointerup', up); ftrack.removeEventListener('pointercancel', up); };
    ftrack.addEventListener('pointermove', mv); ftrack.addEventListener('pointerup', up); ftrack.addEventListener('pointercancel', up);
  });
  ftrack.addEventListener('dblclick', () => put(pOfVol(1)));
  ftrack.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') { e.preventDefault(); put(pOfVol(o.vol) + 0.01); }
    if (e.key === 'ArrowDown') { e.preventDefault(); put(pOfVol(o.vol) - 0.01); }
  });
  const mL = h('i'), mR = h('i');
  o.ui.l = mL; o.ui.r = mR;
  sync();
  return {
    wrap: h('div', { class: 'fwrap' }, scale, ftrack, h('div', { class: 'meter' }, h('div', { class: 'mbar' }, mL), h('div', { class: 'mbar' }, mR))),
    db
  };
}

function strip(o, num) {
  const p = key => v => { o[key] = v; applyParams(o); };
  const name = o.kind === 'master'
    ? h('div', { class: 'sname' }, 'Master')
    : h('input', { class: 'sname', id: 'sn-' + o.id, value: o.name, 'aria-label': 'Channel name',
        onchange: e => { o.name = e.target.value.trim() || o.name; renderAll(); } });
  const tag = o.kind === 'track' ? `Track ${num}` + (o.inst ? ` · ${getInstrument(o.inst.type)?.name || 'MIDI'}` : '') : o.kind === 'bus' ? 'Submix bus'
    : o.kind === 'return' ? (o.fx === 'reverb' ? 'Return · plate' : 'Return · echo ⅛.') : 'Stereo out';
  const eq = h('div', { class: 'krow' },
    knob({ label: 'LO', min: -12, max: 12, def: 0, bip: true, fmt: fmtEq, get: () => o.lo, set: p('lo') }),
    knob({ label: 'MID', min: -12, max: 12, def: 0, bip: true, fmt: fmtEq, get: () => o.mid, set: p('mid') }),
    knob({ label: 'HI', min: -12, max: 12, def: 0, bip: true, fmt: fmtEq, get: () => o.hi, set: p('hi') }));
  const sends = o.kind === 'track' ? S.returns.map(r => knob({
    label: r.fx === 'reverb' ? 'VERB' : 'ECHO', min: 0, max: 1, def: 0, fmt: fmtPct,
    get: () => o.sends[r.id] || 0, set: v => { o.sends[r.id] = v; applyParams(o); }
  })) : [];
  const dyn = h('div', { class: 'krow' },
    knob({ label: 'COMP', min: 0, max: 1, def: 0, fmt: fmtPct, get: () => o.comp, set: p('comp') }),
    ...sends, ...Array.from({ length: 2 - sends.length }, () => h('span')));
  const pan = h('div', { class: 'krow' }, h('span'),
    knob({ label: 'PAN', min: -1, max: 1, def: 0, bip: true, fmt: fmtPan, get: () => o.pan, set: p('pan') }), h('span'));
  const f = faderBlock(o);
  const btns = h('div', { class: 'sbtns' },
    flagBtn(o, 'm'),
    o.kind === 'track' ? flagBtn(o, 's') : null,
    o.kind === 'track' ? flagBtn(o, 'r') : null,
    o.kind === 'bus' ? h('button', { class: 'mini x', title: `Delete ${o.name}`, 'aria-label': `Delete ${o.name}`, onclick: () => deleteBus(o.id) }, '×') : null);
  const out = o.kind === 'track' ? routeSelect(o, 's') : h('div', { class: 'sout' }, o.kind === 'master' ? 'OUTPUT 1/2' : '→ MASTER');
  const el = h('div', { class: `strip k-${o.kind}` + (S.selTrack === o.id ? ' sel' : ''), style: `--c:${o.color}`, dataset: { id: o.id } },
    name, h('div', { class: 'stag' }, tag), eq, dyn, pan, f.wrap, f.db, btns, out);
  el.addEventListener('pointerdown', e => {
    if (o.kind === 'track' && !e.target.closest('input,select,button,.knob,.ftrack')) { S.selTrack = o.id; markSelection(); }
  });
  return el;
}

export function renderMixer() {
  const sep = label => h('div', { class: 'gsep' }, h('span', {}, label));
  $('strips').replaceChildren(
    ...S.tracks.map((t, i) => strip(t, i + 1)),
    S.buses.length ? sep('Buses') : null, ...S.buses.map(b => strip(b)),
    sep('Returns'), ...S.returns.map(r => strip(r)),
    sep('Master'), strip(S.master));
}

/* ---------- view controls ---------- */
export function setZoom(z, anchorX) {
  const old = S.zoom;
  z = clamp(z, 8, 400);
  if (z === old) return;
  const r = ruler.getBoundingClientRect();
  const ax = anchorX ?? (r.left + scroller.scrollLeft + (scroller.clientWidth - headW()) / 2);
  const t = (ax - r.left) / old;
  S.zoom = z;
  $('zoom').value = Math.min(300, Math.round(z));
  renderTracks();
  scroller.scrollLeft += t * (z - old);
}
export function fitZoom() {
  const span = S.loop && S.loopEnd > S.loopStart ? S.loopEnd : Math.max(projectEnd(), 16 * spb());
  S.zoom = clamp((scroller.clientWidth - headW() - 24) / (span * 1.04), 10, 160);
  $('zoom').value = Math.round(S.zoom);
}
// The bottom dock holds the mixer, the piano roll and the clip editor. Pressing an open tab's button again closes the dock.
const DOCK = [['mixer', 'tabMixer', 'strips', 'bMixer'], ['roll', 'tabRoll', 'roll', 'bRoll'], ['clip', 'tabClip', 'cedit', 'bClip']];
export function showDock(tab, toggle = true) {
  if (toggle && S.mixerOpen && S.dockTab === tab) S.mixerOpen = false;
  else { S.mixerOpen = true; S.dockTab = tab; }
  $('mixer').hidden = !S.mixerOpen;
  for (const [name, tabId, panel, btn] of DOCK) {
    $(panel).hidden = S.dockTab !== name;
    $(tabId).setAttribute('aria-selected', String(S.dockTab === name));
    $(btn).setAttribute('aria-pressed', String(S.mixerOpen && S.dockTab === name));
  }
  $('rollTitle').hidden = S.dockTab !== 'roll';
  $('ceTitle').hidden = S.dockTab !== 'clip';
  if (S.mixerOpen && S.dockTab === 'roll') { rollLayout(); rollDraw(); }
  if (S.mixerOpen && S.dockTab === 'clip') { ceLayout(); ceDraw(); }
}

/* ---------- frame loop ---------- */
const lvl = x => x < 1e-4 ? 0 : clamp((20 * Math.log10(x) + 60) / 66, 0, 1);
const inBuf = new Float32Array(1024);
let inPeak = 0, lastClock = '';
function peakOf(an, buf) {
  an.getFloatTimeDomainData(buf);
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; }
  return m;
}
function frame() {
  requestAnimationFrame(frame);
  const p = position(), x = p * S.zoom;
  $('playhead').style.transform = rulerHead.style.transform = `translateX(${x}px)`;
  const ck = fmtBars(p);
  if (ck !== lastClock) { lastClock = ck; $('tBars').textContent = ck; $('tTime').textContent = fmtTime(p); }
  if (S.playing) {
    const viewW = scroller.clientWidth - headW();
    if (x > scroller.scrollLeft + viewW - 30 || x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - viewW * 0.1);
  }
  // Armed tracks show the live input level instead of their playback level.
  if (inputAnalyser) inPeak = Math.max(peakOf(inputAnalyser, inBuf), inPeak * 0.9);
  for (const o of allChannels()) {
    const n = o.ch;
    n.pL = Math.max(peakOf(n.anL, n.tbuf), n.pL * 0.9);
    n.pR = Math.max(peakOf(n.anR, n.tbuf), n.pR * 0.9);
    let l = lvl(n.pL), r = lvl(n.pR);
    if (o.arm && inputAnalyser) l = r = lvl(inPeak);
    if (o.ui.l) o.ui.l.style.transform = `scaleY(${1 - l})`;
    if (o.ui.r) o.ui.r.style.transform = `scaleY(${1 - r})`;
    if (o.ui.h) o.ui.h.style.transform = `scaleX(${1 - Math.max(l, r)})`;
  }
}
export const startFrameLoop = () => requestAnimationFrame(frame);
