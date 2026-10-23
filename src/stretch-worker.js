// Runs WSOLA off the main thread so stretching never stalls playback or the UI.
import { wsola } from './wsola.js';

self.onmessage = e => {
  const { id, chs, factor, sr } = e.data;
  try {
    const out = wsola(chs, factor, sr);
    self.postMessage({ id, chs: out }, out.map(c => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
