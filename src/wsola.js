// WSOLA (waveform-similarity overlap-add) time stretch: changes length without changing pitch.
// factor = output length / input length. Each output frame is taken from near its nominal input
// position, shifted to the offset whose waveform best continues the previous frame, then overlap-added
// with a Hann window. Correlation runs on a mono mix, coarse-to-fine, so a minute of stereo takes well
// under a second.
export function wsola(chs, factor, sr) {
  const inLen = chs[0].length, outLen = Math.max(1, Math.round(inLen * factor));
  const N = 2 * Math.round(sr * 0.02); // ~40 ms frames
  const Hs = N / 2, Ha = Hs / factor, tol = Math.round(Hs / 2), D = 4;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const mono = new Float32Array(inLen);
  for (const c of chs) for (let i = 0; i < inLen; i++) mono[i] += c[i] / chs.length;
  const m = i => (i >= 0 && i < inLen ? mono[i] : 0);
  const out = chs.map(() => new Float32Array(outLen + N)), norm = new Float32Array(outLen + N);

  let prev = 0;
  for (let k = 0, op = 0; op < outLen; k++, op += Hs) {
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      const target = prev + Hs; // where the previous frame's waveform naturally continues
      const score = (d, step) => {
        let xy = 0, yy = 1e-9;
        for (let j = 0; j < Hs; j += step) { const y = m(nominal + d + j); xy += m(target + j) * y; yy += y * y; }
        return xy / Math.sqrt(yy);
      };
      let bd = 0, bs = score(0, D);
      for (let d = -tol; d <= tol; d += D) { const s = score(d, D); if (s > bs) { bs = s; bd = d; } }
      const c0 = bd;
      bs = score(c0, 1);
      for (let d = c0 - D + 1; d < c0 + D; d++) { const s = score(d, 1); if (s > bs) { bs = s; bd = d; } }
      best = nominal + bd;
    }
    for (let ci = 0; ci < chs.length; ci++) {
      const s = chs[ci], o = out[ci];
      for (let i = 0; i < N; i++) { const j = best + i; if (j >= 0 && j < inLen) o[op + i] += s[j] * win[i]; }
    }
    for (let i = 0; i < N; i++) norm[op + i] += win[i];
    prev = best;
  }
  return out.map(o => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-8 ? o[i] / norm[i] : 0;
    return r;
  });
}
