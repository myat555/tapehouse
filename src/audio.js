// Channel graph. createNodes/connectOut/setParams take any BaseAudioContext, so the
// live mixer and the offline WAV export build identical signal chains.
import { S, buffers, nid, PEAK_RATE, COLORS, spb, allChannels } from './state.js';

const AC = window.AudioContext || window.webkitAudioContext;
export const ctx = new AC({ latencyHint: 'interactive' });
export const SR = ctx.sampleRate;

export function makeLimiter(ac) {
  const l = ac.createDynamicsCompressor();
  l.threshold.value = -1; l.knee.value = 0; l.ratio.value = 20; l.attack.value = 0.002; l.release.value = 0.1;
  return l;
}
export const liveLimiter = makeLimiter(ctx);
liveLimiter.connect(ctx.destination);
export const clickBus = ctx.createGain();
clickBus.gain.value = 0.45;
clickBus.connect(ctx.destination);

/* ---------- buffers ---------- */
function computePeaks(buf) {
  const n = Math.ceil(buf.duration * PEAK_RATE), peaks = new Float32Array(n), step = buf.sampleRate / PEAK_RATE;
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  let max = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = Math.floor(i * step), b = Math.min(buf.length, Math.floor((i + 1) * step));
    for (const d of chs) for (let j = a; j < b; j++) { const v = Math.abs(d[j]); if (v > m) m = v; }
    peaks[i] = m; if (m > max) max = m;
  }
  return { peaks, norm: max > 0 ? 1 / max : 1 };
}
export function addBuffer(buffer, name, id = nid('b')) {
  buffers.set(id, { buffer, name, ...computePeaks(buffer) });
  return id;
}

/* ---------- nodes ---------- */
let IR = null;
function impulse() {
  if (IR) return IR;
  const len = Math.floor(SR * 2.4);
  IR = ctx.createBuffer(2, len, SR);
  for (let c = 0; c < 2; c++) {
    const d = IR.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4);
  }
  return IR;
}

export function createNodes(ac, kind, fx, withMeters = true) {
  const n = {
    input: ac.createGain(), lo: ac.createBiquadFilter(), mid: ac.createBiquadFilter(), hi: ac.createBiquadFilter(),
    comp: ac.createDynamicsCompressor(), pan: ac.createStereoPanner(), fader: ac.createGain(),
    mute: ac.createGain(), out: ac.createGain(), sends: {}, pL: 0, pR: 0
  };
  n.lo.type = 'lowshelf'; n.lo.frequency.value = 120;
  n.mid.type = 'peaking'; n.mid.frequency.value = 1000; n.mid.Q.value = 0.9;
  n.hi.type = 'highshelf'; n.hi.frequency.value = 6500;
  n.comp.attack.value = 0.006; n.comp.release.value = 0.15; n.comp.knee.value = 6;
  n.input.connect(n.lo).connect(n.mid).connect(n.hi).connect(n.comp).connect(n.pan).connect(n.fader).connect(n.mute).connect(n.out);
  if (withMeters) {
    n.split = ac.createChannelSplitter(2);
    n.anL = ac.createAnalyser(); n.anR = ac.createAnalyser();
    n.anL.fftSize = n.anR.fftSize = 1024; n.tbuf = new Float32Array(1024);
    n.mute.connect(n.split); n.split.connect(n.anL, 0); n.split.connect(n.anR, 1);
  }
  if (kind === 'return') {
    n.fxIn = ac.createGain();
    if (fx === 'reverb') {
      const cv = ac.createConvolver(); cv.buffer = impulse();
      n.fxIn.connect(cv).connect(n.input);
    } else {
      const d = ac.createDelay(4), fb = ac.createGain(), lp = ac.createBiquadFilter();
      fb.gain.value = 0.38; lp.type = 'lowpass'; lp.frequency.value = 3200;
      n.fxIn.connect(d); d.connect(n.input); d.connect(lp).connect(fb).connect(d);
      n.delay = d;
    }
  }
  return n;
}

export function isMuted(o) {
  const anySolo = S.tracks.some(t => t.solo);
  return o.mute || (o.kind === 'track' && anySolo && !o.solo);
}

export function setParams(o, n, ac, smooth = true) {
  const t = ac.currentTime;
  const set = (param, v) => smooth ? param.setTargetAtTime(v, t, 0.015) : (param.value = v);
  set(n.fader.gain, o.vol);
  set(n.pan.pan, o.pan);
  n.lo.gain.value = o.lo; n.mid.gain.value = o.mid; n.hi.gain.value = o.hi;
  n.comp.threshold.value = o.comp > 0 ? -o.comp * 36 : 0;
  n.comp.ratio.value = 1 + o.comp * 7;
  for (const rid in n.sends) set(n.sends[rid].gain, o.sends[rid] || 0);
  set(n.mute.gain, isMuted(o) ? 0 : 1);
  if (n.delay) set(n.delay.delayTime, 0.75 * spb());
}

// Wire a channel's output to its bus (or the master) plus post-fader sends to every return.
export function connectOut(o, n, nodesOf, masterSink, ac) {
  n.out.disconnect();
  if (o.kind === 'master') { n.out.connect(masterSink); return; }
  const bus = o.out !== 'master' && S.buses.find(b => b.id === o.out);
  if (!bus) o.out = 'master';
  n.out.connect(nodesOf(bus || S.master).input);
  if (o.kind === 'track') {
    for (const r of S.returns) {
      let g = n.sends[r.id];
      if (!g) { g = ac.createGain(); g.gain.value = 0; g.connect(nodesOf(r).fxIn); n.sends[r.id] = g; }
      n.out.connect(g);
    }
  }
}

/* ---------- live channels ---------- */
export const applyParams = o => setParams(o, o.ch, ctx);
export const route = o => connectOut(o, o.ch, x => x.ch, liveLimiter, ctx);
export const applyAll = () => allChannels().forEach(applyParams);
export const routeAll = () => { route(S.master); S.returns.forEach(route); S.buses.forEach(route); S.tracks.forEach(route); };

const DEFAULTS = { vol: 1, pan: 0, lo: 0, mid: 0, hi: 0, comp: 0, mute: false, solo: false, arm: false };
export function newChannel(kind, name, color, { fx, id } = {}) {
  return { id: id || nid(kind[0]), kind, name, color, fx, ...DEFAULTS, out: 'master', sends: {}, clips: [],
    ch: createNodes(ctx, kind, fx), ui: {} };
}
export function resetParams(o) {
  Object.assign(o, DEFAULTS, o.kind === 'return' ? { vol: 0.8 } : {});
  applyParams(o);
}
export function removeChannel(o) {
  o.ch.out.disconnect();
  for (const g of Object.values(o.ch.sends)) g.disconnect();
}

let colorIx = 0;
export function addTrack(name, color, id) {
  const t = newChannel('track', name || `Track ${S.tracks.length + 1}`, color || COLORS[colorIx++ % COLORS.length], { id });
  S.tracks.push(t); route(t); applyAll();
  return t;
}
export function addBus(name, id) {
  const b = newChannel('bus', name || `Bus ${S.buses.length + 1}`, '#b8bec8', { id });
  S.buses.push(b); route(b); applyParams(b);
  return b;
}
export function makeReturn(name, fx) {
  const o = newChannel('return', name, fx === 'reverb' ? '#8fa3bf' : '#a9b38c', { fx });
  o.vol = 0.8;
  return o;
}
