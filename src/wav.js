// Encode an AudioBuffer as an interleaved PCM WAV file (16- or 24-bit).
export function encodeWav(buf, bits = 24) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const bps = bits / 8, block = ch * bps, dataLen = len * block;
  const ab = new ArrayBuffer(44 + dataLen), v = new DataView(ab);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * block, true); v.setUint16(32, block, true); v.setUint16(34, bits, true);
  tag(36, 'data'); v.setUint32(40, dataLen, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  const max = bits === 16 ? 32767 : 8388607;
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.round(Math.max(-1, Math.min(1, chans[c][i])) * max);
      if (bits === 16) { v.setInt16(o, x, true); o += 2; }
      else { v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; }
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
