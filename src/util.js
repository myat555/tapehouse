export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const $ = id => document.getElementById(id);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export function status(text, err = false) {
  const m = $('msg');
  m.textContent = text;
  m.classList.toggle('err', err);
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const slug = s => (s || 'untitled').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'untitled';

export const dbOf = v => v < 1e-4 ? '-∞' : (x => (x > 0.05 ? '+' : '') + x.toFixed(1))(20 * Math.log10(v));
export const fmtEq = v => (v > 0 ? '+' : '') + v.toFixed(1) + 'dB';
export const fmtPct = v => Math.round(v * 100) + '%';
export const fmtPan = v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
export function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
