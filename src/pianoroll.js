// Piano roll: canvas-drawn note editor for one MIDI clip, plus a velocity lane and the track's instrument panel.
//
// Mouse: click/drag on empty space draws a note (drag sets its length) · drag a note to move it ·
// drag its right edge to resize · Shift+drag on empty space selects a region · Shift+click toggles selection ·
// right-click or Alt+click deletes · ⌘/Ctrl while dragging disables snapping · ⌘/Ctrl+scroll zooms.
// Keys (after clicking in the roll): Delete, ⌘A, ⌘D, ↑/↓ (Shift = octave), ←/→, Q quantize, Esc.
import { S, buffers, spb, findClip, trackById } from './state.js';
import { ctx } from './audio.js';
import { position, seek } from './engine.js';
import { getInstrument, listInstruments, newInstrumentState, noteName, isBlack } from './instruments/index.js';
import { playNote, isMidi } from './midi.js';
import { knob } from './knob.js';
import { $, h, clamp, status } from './util.js';

const LO = 21, HI = 108, ROWH = 14, KEYW = 58, RULER = 20;
const GRIDS = [[1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32'], [1 / 3, '1/8T'], [1 / 6, '1/16T']];
const COL = {
  white: '#191c22', black: '#141619', octave: '#323844', bar: '#3b424e', beat: '#272c35', sub: '#1f2329',
  outside: 'rgba(5,6,8,.55)', ruler: '#1a1d23', text: '#8b93a1', keyW: '#d9dde4', keyB: '#24282f', keyLine: '#9aa1ad',
  playhead: '#dde1e7', sel: '#ffffff', marq: 'rgba(242,169,59,.14)', marqLine: '#f2a93b', clipEnd: '#f2a93b'
};

const PR = { t: null, c: null, pxBeat: 80, grid: 0.25, len: 0.5, vel: 100, sel: new Set(), focus: false, marq: null };
let onEdit = () => {};
export const setRollEditHook = fn => { onEdit = fn; };

const rollScroll = $('rollScroll'), rollSpace = $('rollSpace'), rollCanvas = $('rollCanvas'), velCanvas = $('velCanvas');
const visible = () => !$('roll').hidden && !$('mixer').hidden;

/* ---------- open / sync ---------- */
export function openRoll(t, c) {
  PR.t = t; PR.c = c; PR.sel.clear(); PR.focus = true;
  if (!t.inst) t.inst = newInstrumentState('synth');
  renderTools();
  layout();
  const ps = c.notes.map(n => n.p);
  const mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : 60;
  rollScroll.scrollTop = Math.max(0, (HI - mid) * ROWH - rollScroll.clientHeight / 2 + RULER);
  rollScroll.scrollLeft = Math.max(0, c.off * PR.pxBeat - 8);
  draw();
}
export const blurRoll = () => { PR.focus = false; };

// Called after arrange edits: drop a clip that no longer exists, follow tempo/length changes.
export function rollSync() {
  if (PR.c && (!findClip(PR.c.id) || !trackById(PR.t?.id))) { PR.t = PR.c = null; PR.sel.clear(); renderTools(); }
  else if (PR.c) { $('rollLen').value = +(PR.c.beats / 4).toFixed(3); $('rollTitle').textContent = titleText(); }
  if (visible()) { layout(); draw(); }
}

const titleText = () => PR.c ? `${PR.t.name} · ${getInstrument(PR.t.inst?.type)?.name || 'MIDI'}` : '';
function edited() { onEdit(); draw(); }

/* ---------- toolbar & instrument panel ---------- */
function renderTools() {
  $('rollTitle').textContent = titleText();
  const tools = $('rollTools'), empty = $('rollEmpty');
  empty.hidden = !!PR.c; tools.hidden = !PR.c; $('rollBody').hidden = !PR.c;
  if (!PR.c) return;
  const t = PR.t;
  const grid = h('select', { id: 'rollGrid', 'aria-label': 'Grid', onchange: e => { PR.grid = +e.target.value; draw(); } },
    ...GRIDS.map(([v, l]) => h('option', { value: v }, l)));
  grid.value = String(PR.grid);
  const len = h('input', { id: 'rollLen', type: 'number', min: 0.25, max: 256, step: 0.25, value: +(PR.c.beats / 4).toFixed(3), 'aria-label': 'Clip length in bars',
    onchange: e => { setLength(clamp(+e.target.value || 1, 0.0625, 256) * 4); e.target.value = +(PR.c.beats / 4).toFixed(3); } });
  const vel = h('input', { id: 'rollVel', type: 'number', min: 1, max: 127, step: 1, value: PR.vel, 'aria-label': 'Velocity for new notes',
    onchange: e => { PR.vel = clamp(Math.round(+e.target.value || 100), 1, 127); e.target.value = PR.vel; } });
  const instSel = h('select', { id: 'rollInst', 'aria-label': 'Instrument', onchange: e => changeInstrument(e.target.value) },
    ...listInstruments().map(d => h('option', { value: d.id }, d.name)));
  instSel.value = t.inst.type;
  tools.replaceChildren(
    h('div', { class: 'rgroup' },
      h('label', { class: 'field' }, 'Grid', grid),
      h('label', { class: 'field' }, 'Length', len, 'bars'),
      h('label', { class: 'field' }, 'Vel', vel),
      h('button', { class: 'act', title: 'Snap note starts to the grid (Q)', onclick: quantize }, 'Quantize')),
    h('div', { class: 'rgroup inst', style: `--c:${t.color}` },
      h('label', { class: 'field' }, 'Instrument', instSel),
      ...instrumentControls(t)));
}

function changeInstrument(type) {
  const extra = type === 'sampler' ? { buf: guessSample() } : {};
  PR.t.inst = newInstrumentState(type, extra);
  renderTools(); onEdit();
  if (type === 'sampler' && !extra.buf) status('Pick a sample for the Sampler. Import audio first if the list is empty.');
}
function guessSample() {
  const f = S.selClip && findClip(S.selClip);
  if (f && !isMidi(f.c)) return f.c.buf;
  return buffers.keys().next().value || null;
}

function instrumentControls(t) {
  const def = getInstrument(t.inst.type), p = t.inst.params;
  if (!def) return [h('span', { class: 'hint' }, `Instrument "${t.inst.type}" is not installed.`)];
  return def.params.map(spec => {
    const { key, label } = spec;
    if (spec.type === 'knob') {
      if (spec.scale === 'log') {
        const r = Math.log(spec.max / spec.min);
        const toN = v => Math.log(v / spec.min) / r, fromN = n => spec.min * Math.exp(n * r);
        return knob({ label, min: 0, max: 1, def: toN(def.defaults[key]), get: () => toN(p[key]), set: n => { p[key] = fromN(n); },
          fmt: n => (spec.fmt || String)(fromN(n)) });
      }
      return knob({ label, min: spec.min, max: spec.max, def: def.defaults[key], get: () => p[key], set: v => { p[key] = v; },
        fmt: spec.fmt || (v => v.toFixed(2)) });
    }
    if (spec.type === 'select') {
      const s = h('select', { id: `inst-${key}`, onchange: e => { p[key] = e.target.value; } }, ...spec.options.map(([v, l]) => h('option', { value: v }, l)));
      s.value = p[key];
      return h('label', { class: 'field' }, label, s);
    }
    if (spec.type === 'toggle') {
      const b = h('button', { class: 'act tog', 'aria-pressed': String(!!p[key]),
        onclick: () => { p[key] = !p[key]; b.setAttribute('aria-pressed', String(p[key])); } }, label);
      return b;
    }
    if (spec.type === 'note') {
      const name = h('span', { class: 'notename' }, noteName(p[key]));
      const inp = h('input', { id: `inst-${key}`, type: 'number', min: 0, max: 127, step: 1, value: p[key],
        onchange: e => { p[key] = clamp(Math.round(+e.target.value || 60), 0, 127); e.target.value = p[key]; name.textContent = noteName(p[key]); } });
      return h('label', { class: 'field', title: 'This note plays the sample at its original pitch' }, label, inp, name);
    }
    if (spec.type === 'sample') {
      const s = h('select', { id: `inst-${key}`, class: 'samplesel', onchange: e => { p[key] = e.target.value || null; } },
        h('option', { value: '' }, buffers.size ? '— choose audio —' : '— import audio first —'),
        ...[...buffers].map(([id, b]) => h('option', { value: id }, b.name)));
      s.value = p[key] || '';
      return h('label', { class: 'field' }, label, s);
    }
    return null;
  });
}

function setLength(beats) {
  const c = PR.c;
  c.beats = Math.max(PR.grid, beats);
  c.dur = c.beats * spb();
  layout(); edited();
}
function quantize() {
  const notes = PR.sel.size ? [...PR.sel] : PR.c.notes;
  for (const n of notes) n.s = Math.max(0, Math.round(n.s / PR.grid) * PR.grid);
  edited();
  status(`Quantized ${notes.length} note${notes.length === 1 ? '' : 's'} to ${GRIDS.find(g => g[0] === PR.grid)?.[1] || 'the grid'}.`);
}

/* ---------- geometry ---------- */
export function layout() {
  if (!PR.c) return;
  const beats = Math.max(PR.c.off + PR.c.beats + 16, 32);
  rollSpace.style.width = KEYW + beats * PR.pxBeat + 'px';
  rollSpace.style.height = RULER + (HI - LO + 1) * ROWH + 'px';
  const dpr = window.devicePixelRatio || 1;
  for (const [cv, w, hgt] of [[rollCanvas, rollScroll.clientWidth, rollScroll.clientHeight], [velCanvas, rollScroll.clientWidth, velCanvas.clientHeight]]) {
    cv.style.width = w + 'px';
    if (cv === rollCanvas) cv.style.height = hgt + 'px';
    cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(hgt * dpr));
  }
}
const xOf = b => KEYW + b * PR.pxBeat - rollScroll.scrollLeft;
const yOf = p => RULER + (HI - p) * ROWH - rollScroll.scrollTop;
function pt(e) {
  const r = rollScroll.getBoundingClientRect(), vx = e.clientX - r.left, vy = e.clientY - r.top;
  return { vx, vy, beat: (vx - KEYW + rollScroll.scrollLeft) / PR.pxBeat, pitch: HI - Math.floor((vy - RULER + rollScroll.scrollTop) / ROWH) };
}
const snapB = (b, free) => free ? b : Math.round(b / PR.grid) * PR.grid;
function hitNote(P) {
  const ns = PR.c.notes;
  for (let i = ns.length - 1; i >= 0; i--) { const n = ns[i]; if (n.p === P.pitch && P.beat >= n.s && P.beat < n.s + n.d) return n; }
  return null;
}
const nearEnd = (n, P) => n.d * PR.pxBeat >= 10 && P.vx > xOf(n.s + n.d) - 6;

/* ---------- drawing ---------- */
export function draw() {
  if (!visible() || !PR.c) return;
  const dpr = window.devicePixelRatio || 1, g = rollCanvas.getContext('2d');
  const W = rollCanvas.width / dpr, H = rollCanvas.height / dpr, c = PR.c, px = PR.pxBeat;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const sy = rollScroll.scrollTop, sx = rollScroll.scrollLeft;

  // rows
  const r0 = Math.max(0, Math.floor(sy / ROWH)), r1 = Math.min(HI - LO, Math.ceil((sy + H) / ROWH));
  for (let r = r0; r <= r1; r++) {
    const p = HI - r, y = RULER + r * ROWH - sy;
    g.fillStyle = isBlack(p) ? COL.black : COL.white;
    g.fillRect(KEYW, y, W - KEYW, ROWH);
    if (p % 12 === 0) { g.fillStyle = COL.octave; g.fillRect(KEYW, y + ROWH - 1, W - KEYW, 1); }
  }
  // grid lines
  const b0 = Math.max(0, Math.floor(sx / px)), b1 = Math.ceil((sx + W) / px);
  if (PR.grid * px >= 6 && PR.grid < 1) {
    g.fillStyle = COL.sub;
    for (let k = Math.floor(b0 / PR.grid); k * PR.grid <= b1; k++) g.fillRect(Math.round(xOf(k * PR.grid)), RULER, 1, H);
  }
  for (let b = b0; b <= b1; b++) { g.fillStyle = b % 4 === 0 ? COL.bar : COL.beat; g.fillRect(Math.round(xOf(b)), RULER, 1, H); }
  // outside the clip window
  g.fillStyle = COL.outside;
  const xs = xOf(c.off), xe = xOf(c.off + c.beats);
  if (xs > KEYW) g.fillRect(KEYW, RULER, xs - KEYW, H);
  if (xe < W) g.fillRect(Math.max(KEYW, xe), RULER, W - xe, H);
  // notes
  g.font = '500 9px "JetBrains Mono", monospace'; g.textBaseline = 'middle';
  for (const n of c.notes) {
    const x = xOf(n.s), w = Math.max(3, n.d * px - 1), y = yOf(n.p) + 1, hh = ROWH - 2;
    if (x + w < KEYW || x > W || y + hh < RULER || y > H) continue;
    const inside = n.s >= c.off && n.s < c.off + c.beats;
    g.globalAlpha = (inside ? 0.45 + 0.55 * n.v / 127 : 0.25);
    g.fillStyle = PR.t.color; g.fillRect(x, y, w, hh);
    g.globalAlpha = 1;
    if (PR.sel.has(n)) { g.strokeStyle = COL.sel; g.lineWidth = 1.5; g.strokeRect(x + 0.75, y + 0.75, w - 1.5, hh - 1.5); }
    if (w > 30) { g.fillStyle = '#101216'; g.fillText(noteName(n.p), x + 3, y + hh / 2 + 0.5); }
  }
  // marquee
  if (PR.marq) {
    const m = PR.marq, x0 = xOf(Math.min(m.b0, m.b1)), x1 = xOf(Math.max(m.b0, m.b1));
    const y0 = yOf(Math.max(m.p0, m.p1)), y1 = yOf(Math.min(m.p0, m.p1)) + ROWH;
    g.fillStyle = COL.marq; g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.strokeStyle = COL.marqLine; g.lineWidth = 1; g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
  }
  // playhead
  const pos = position();
  if (pos >= c.start && pos < c.start + c.dur) {
    const x = Math.round(xOf(c.off + (pos - c.start) / spb()));
    if (x >= KEYW) { g.fillStyle = COL.playhead; g.fillRect(x, 0, 1, H); }
  }
  // ruler (sticky top)
  g.fillStyle = COL.ruler; g.fillRect(KEYW, 0, W - KEYW, RULER);
  g.fillStyle = COL.bar; g.fillRect(KEYW, RULER - 1, W - KEYW, 1);
  g.fillStyle = COL.text; g.textBaseline = 'alphabetic';
  for (let b = b0 - (b0 % 4); b <= b1; b += 4) {
    const x = xOf(b); if (x < KEYW - 1) continue;
    g.fillRect(Math.round(x), 0, 1, RULER); g.fillText(String(b / 4 + 1), x + 4, 13);
  }
  if (xe >= KEYW && xe <= W) {
    g.fillStyle = COL.clipEnd; g.fillRect(Math.round(xe) - 1, 0, 2, RULER);
    g.beginPath(); g.moveTo(xe - 7, 0); g.lineTo(xe + 1, 0); g.lineTo(xe + 1, 9); g.closePath(); g.fill();
  }
  // keyboard (sticky left)
  for (let r = r0; r <= r1; r++) {
    const p = HI - r, y = RULER + r * ROWH - sy;
    g.fillStyle = isBlack(p) ? COL.keyB : COL.keyW;
    g.fillRect(0, y, KEYW, ROWH);
    g.fillStyle = COL.keyLine; g.fillRect(0, y + ROWH - 1, KEYW, isBlack(p) ? 0 : 1);
    if (p % 12 === 0) { g.fillStyle = '#4a515d'; g.fillText(noteName(p), 4, y + ROWH - 3); }
  }
  g.fillStyle = COL.ruler; g.fillRect(0, 0, KEYW, RULER);
  drawVel();
}

function drawVel() {
  const dpr = window.devicePixelRatio || 1, g = velCanvas.getContext('2d');
  const W = velCanvas.width / dpr, H = velCanvas.height / dpr, c = PR.c;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#121418'; g.fillRect(0, 0, W, H);
  g.fillStyle = COL.ruler; g.fillRect(0, 0, KEYW, H);
  g.fillStyle = COL.text; g.font = '600 9px "Barlow Condensed", sans-serif'; g.fillText('VELOCITY', 6, 14);
  for (const n of c.notes) {
    const x = xOf(n.s); if (x < KEYW || x > W) continue;
    const bh = (n.v / 127) * (H - 6);
    g.fillStyle = PR.t.color; g.globalAlpha = PR.sel.has(n) ? 1 : 0.6;
    g.fillRect(Math.round(x), H - bh, 3, bh);
    g.fillRect(Math.round(x) - 2, H - bh, 7, 2);
  }
  g.globalAlpha = 1;
}

/* ---------- interaction ---------- */
function preview(p, v = 100) {
  if (!PR.t?.inst) return;
  ctx.resume();
  const voice = playNote(ctx, PR.t.ch.input, PR.t.inst, p, v, ctx.currentTime);
  voice?.release(ctx.currentTime + 0.25);
}

rollScroll.addEventListener('contextmenu', e => e.preventDefault());
rollScroll.addEventListener('scroll', () => draw());
rollScroll.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey) || !PR.c) return;
  e.preventDefault();
  const P = pt(e), z = clamp(PR.pxBeat * Math.exp(-e.deltaY * 0.002), 12, 600);
  PR.pxBeat = z; layout();
  rollScroll.scrollLeft = KEYW + P.beat * z - P.vx;
  draw();
}, { passive: false });

rollScroll.addEventListener('pointermove', e => {
  if (e.buttons || !PR.c) return;
  const P = pt(e);
  let cur = 'crosshair';
  if (P.vy < RULER) cur = Math.abs(P.vx - xOf(PR.c.off + PR.c.beats)) < 8 ? 'ew-resize' : 'text';
  else if (P.vx < KEYW) cur = 'pointer';
  else { const n = hitNote(P); if (n) cur = nearEnd(n, P) ? 'ew-resize' : 'grab'; }
  rollScroll.style.cursor = cur;
});

rollScroll.addEventListener('pointerdown', e => {
  if (!PR.c) return;
  const P = pt(e);
  if (P.vx >= rollScroll.clientWidth || P.vy >= rollScroll.clientHeight) return; // scrollbars
  PR.focus = true;
  e.preventDefault();
  try { rollScroll.setPointerCapture(e.pointerId); } catch { /* synthetic event without an active pointer */ }
  const c = PR.c;
  let mode = null, anchor = null, changed = false, lastPreview = null;
  const orig = new Map();
  const snapshot = () => { orig.clear(); for (const n of PR.sel) orig.set(n, { s: n.s, d: n.d, p: n.p }); };

  if (P.vy < RULER) {
    if (P.vx < KEYW) return;
    if (Math.abs(P.vx - xOf(c.off + c.beats)) < 8) mode = 'length';
    else { seek(c.start + (P.beat - c.off) * spb()); draw(); return; }
  } else if (P.vx < KEYW) {
    if (P.pitch >= LO && P.pitch <= HI) preview(P.pitch);
    return;
  } else if (P.pitch < LO || P.pitch > HI) {
    return;
  } else {
    const hit = hitNote(P);
    if (hit && (e.button === 2 || e.altKey)) {
      c.notes.splice(c.notes.indexOf(hit), 1); PR.sel.delete(hit); edited(); return;
    }
    if (e.button !== 0) return;
    if (hit) {
      if (e.shiftKey) { PR.sel.has(hit) ? PR.sel.delete(hit) : PR.sel.add(hit); draw(); return; }
      if (!PR.sel.has(hit)) { PR.sel.clear(); PR.sel.add(hit); }
      anchor = hit; mode = nearEnd(hit, P) ? 'resize' : 'move';
      preview(hit.p, hit.v); lastPreview = hit.p;
    } else if (e.shiftKey) {
      mode = 'marq'; PR.marq = { b0: P.beat, p0: P.pitch, b1: P.beat, p1: P.pitch, base: new Set(PR.sel) };
    } else {
      const n = { s: Math.max(0, Math.floor(P.beat / PR.grid) * PR.grid), d: PR.len, p: P.pitch, v: PR.vel };
      c.notes.push(n); PR.sel.clear(); PR.sel.add(n);
      anchor = n; mode = 'resize'; changed = true;
      preview(n.p, n.v);
    }
    snapshot();
  }
  draw();

  const move = ev => {
    const Q = pt(ev), free = ev.metaKey || ev.ctrlKey, dB = Q.beat - P.beat;
    if (mode === 'length') {
      setLengthLive(Math.max(PR.grid, snapB(Q.beat, free) - c.off));
      changed = true;
    } else if (mode === 'move') {
      let shift = snapB(dB, free), dp = Q.pitch - P.pitch;
      const os = [...orig.values()];
      shift = Math.max(shift, -Math.min(...os.map(o => o.s)));
      dp = clamp(dp, LO - Math.min(...os.map(o => o.p)), HI - Math.max(...os.map(o => o.p)));
      for (const [n, o] of orig) { n.s = o.s + shift; n.p = o.p + dp; }
      if (shift || dp) changed = true;
      if (anchor && anchor.p !== lastPreview) { lastPreview = anchor.p; preview(anchor.p, anchor.v); }
    } else if (mode === 'resize') {
      for (const [n, o] of orig) {
        const end = snapB(o.s + o.d + dB, free);
        n.d = Math.max(free ? 1 / 64 : PR.grid, end - o.s);
      }
      changed = true;
    } else if (mode === 'marq') {
      const m = PR.marq; m.b1 = Q.beat; m.p1 = Q.pitch;
      const bl = Math.min(m.b0, m.b1), bh = Math.max(m.b0, m.b1), pl = Math.min(m.p0, m.p1), ph = Math.max(m.p0, m.p1);
      PR.sel = new Set(m.base);
      for (const n of c.notes) if (n.s < bh && n.s + n.d > bl && n.p >= pl && n.p <= ph) PR.sel.add(n);
    }
    draw();
  };
  const up = () => {
    rollScroll.removeEventListener('pointermove', move);
    rollScroll.removeEventListener('pointerup', up);
    rollScroll.removeEventListener('pointercancel', up);
    PR.marq = null;
    if (mode === 'resize' && anchor) PR.len = anchor.d;
    if (mode === 'length') { $('rollLen').value = +(c.beats / 4).toFixed(3); layout(); }
    if (changed) edited(); else draw();
  };
  rollScroll.addEventListener('pointermove', move);
  rollScroll.addEventListener('pointerup', up);
  rollScroll.addEventListener('pointercancel', up);
});
function setLengthLive(beats) { PR.c.beats = beats; PR.c.dur = beats * spb(); }

velCanvas.addEventListener('pointerdown', e => {
  if (!PR.c || e.button !== 0) return;
  e.preventDefault(); PR.focus = true;
  velCanvas.setPointerCapture(e.pointerId);
  const paint = ev => {
    const r = velCanvas.getBoundingClientRect(), vx = ev.clientX - r.left;
    const v = clamp(Math.round((1 - (ev.clientY - r.top - 3) / (r.height - 6)) * 127), 1, 127);
    const near = PR.c.notes.filter(n => Math.abs(xOf(n.s) + 1.5 - vx) <= 5);
    const targets = near.some(n => PR.sel.has(n)) ? near.filter(n => PR.sel.has(n)) : near;
    for (const n of targets) n.v = v;
    draw();
  };
  paint(e);
  const up = () => { velCanvas.removeEventListener('pointermove', paint); velCanvas.removeEventListener('pointerup', up); edited(); };
  velCanvas.addEventListener('pointermove', paint);
  velCanvas.addEventListener('pointerup', up);
});

// Returns true when the key was handled by the piano roll.
export function rollKey(e) {
  if (!PR.c || !PR.focus || !visible()) return false;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), c = PR.c, sel = [...PR.sel];
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!sel.length) return true;
    c.notes = c.notes.filter(n => !PR.sel.has(n)); PR.sel.clear(); edited(); return true;
  }
  if (mod && k === 'a') { PR.sel = new Set(c.notes); draw(); return true; }
  if (mod && k === 'd') {
    if (!sel.length) return true;
    const lo = Math.min(...sel.map(n => n.s)), hi = Math.max(...sel.map(n => n.s + n.d));
    const span = Math.ceil((hi - lo) / PR.grid - 1e-9) * PR.grid;
    const copies = sel.map(n => ({ ...n, s: n.s + span }));
    c.notes.push(...copies); PR.sel = new Set(copies); edited(); return true;
  }
  if (mod) return false;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!sel.length) return true;
    const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
    if (sel.every(n => n.p + d >= LO && n.p + d <= HI)) { for (const n of sel) n.p += d; preview(sel[0].p, sel[0].v); edited(); }
    return true;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (!sel.length) return true;
    const d = (e.key === 'ArrowRight' ? 1 : -1) * PR.grid;
    if (sel.every(n => n.s + d >= 0)) { for (const n of sel) n.s += d; edited(); }
    return true;
  }
  if (k === 'q') { quantize(); return true; }
  if (e.key === 'Escape') { PR.sel.clear(); draw(); return true; }
  return false;
}

// Redraw while playing so the playhead moves; resize with the dock.
let wasPlaying = false;
(function tick() {
  requestAnimationFrame(tick);
  if (S.playing || wasPlaying) draw();
  wasPlaying = S.playing;
})();
new ResizeObserver(() => { if (visible()) { layout(); draw(); } }).observe($('rollBody'));
