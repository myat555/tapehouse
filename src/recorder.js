// Microphone / audio-interface capture through an AudioWorklet, aligned to the transport clock.
import { ctx, SR } from './audio.js';

let node = null, chunks = [], pending = null, alignCtx = 0;
export let inputAnalyser = null;

// Extra alignment, in ms, added on top of the browser's reported latency. Tune it if takes land early or late.
export let userOffsetMs = 0;
export const setUserOffset = ms => { userOffsetMs = ms; };

export async function ensureInput() {
  if (node) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('this browser cannot access audio inputs');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
  await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}recorder-worklet.js`);
  const src = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'tapehouse-recorder', { numberOfOutputs: 1, outputChannelCount: [1] });
  // The worklet only runs while it is pulled, so feed it into a silent sink.
  const sink = ctx.createGain(); sink.gain.value = 0;
  src.connect(node).connect(sink).connect(ctx.destination);
  inputAnalyser = ctx.createAnalyser(); inputAnalyser.fftSize = 1024;
  src.connect(inputAnalyser);
  node.port.onmessage = e => {
    if (e.data.done) { pending?.(); pending = null; }
    else chunks.push(e.data);
  };
}

// alignAt: the ctx time at which the transport plays the take's start position.
export function startCapture(alignAt) {
  chunks = []; alignCtx = alignAt;
  node.port.postMessage('start');
}

export function stopCapture() {
  return new Promise(res => { pending = res; node.port.postMessage('stop'); }).then(assemble);
}

function assemble() {
  if (!chunks.length) return null;
  // A sound you hear at timeline position p left the speakers outputLatency after it was scheduled,
  // and your performance reaches the worklet one input latency later (estimated as baseLatency).
  const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + userOffsetMs / 1000;
  const total = chunks.reduce((a, c) => a + c.L.length, 0);
  const skip = Math.round((alignCtx + latency - chunks[0].t0) * SR);
  const len = total - skip;
  if (len < SR * 0.05) return null;
  const buf = ctx.createBuffer(2, len, SR);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let at = -skip;
  for (const c of chunks) {
    const from = Math.max(0, -at), dst = Math.max(0, at), n = Math.min(c.L.length - from, len - dst);
    if (n > 0) { L.set(c.L.subarray(from, from + n), dst); R.set(c.R.subarray(from, from + n), dst); }
    at += c.L.length;
  }
  chunks = [];
  return buf;
}
