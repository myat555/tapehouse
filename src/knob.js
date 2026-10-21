// Rotary knob: vertical drag (Shift for fine), arrow keys, double-click to reset.
import { h, svgEl, clamp } from './util.js';

function arcPath(cx, cy, r, a0, a1) {
  const p = a => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function knob({ label, min, max, def, get, set, fmt, bip = false }) {
  const A = 0.75 * Math.PI;
  const val = svgEl('path', { class: 'kval' }), ptr = svgEl('line', { x1: 16, y1: 16, x2: 16, y2: 6, class: 'kptr' });
  const svg = svgEl('svg', { viewBox: '0 0 32 32', class: 'kn' });
  svg.append(svgEl('path', { class: 'ktrack', d: arcPath(16, 16, 12, -A, A) }), val, ptr);
  const lab = h('span', { class: 'klab' }, label);
  const el = h('div', { class: 'knob', tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max }, svg, lab);
  const sync = () => {
    const v = get(), a = -A + ((v - min) / (max - min)) * 2 * A, a0 = bip ? 0 : -A;
    val.setAttribute('d', Math.abs(a - a0) < 0.02 ? '' : arcPath(16, 16, 12, Math.min(a0, a), Math.max(a0, a)));
    ptr.setAttribute('transform', `rotate(${(a * 180 / Math.PI).toFixed(1)} 16 16)`);
    el.setAttribute('aria-valuenow', v.toFixed(2));
    el.setAttribute('aria-valuetext', fmt(v));
    el.title = `${label} ${fmt(v)} · double-click to reset`;
    lab.textContent = el.classList.contains('active') ? fmt(v) : label;
  };
  const put = v => { set(clamp(v, min, max)); sync(); };
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); el.focus(); el.setPointerCapture(e.pointerId); el.classList.add('active');
    const y0 = e.clientY, v0 = get();
    const mv = ev => put(v0 + (y0 - ev.clientY) / 140 * (max - min) * (ev.shiftKey ? 0.2 : 1));
    const up = () => {
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      el.classList.remove('active'); sync();
    };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    sync();
  });
  el.addEventListener('dblclick', () => put(def));
  el.addEventListener('keydown', e => {
    const step = (max - min) / 50;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); put(get() + step); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); put(get() - step); }
  });
  sync();
  return el;
}
