import './style.css';
import { S, nid, spb, snapT, fmtBars, trackById } from './state.js';
import { ctx, addBuffer, addTrack, addBus, makeReturn, newChannel, routeAll, applyAll } from './audio.js';
import { events, play, stop, seek, restartIfPlaying, startEngine, position, T } from './engine.js';
import {
  renderAll, renderTracks, updateLoopUI, setZoom, fitZoom, showDock,
  startFrameLoop, deleteClip, splitClip, duplicateClip, editClip
} from './ui.js';
import { rollKey, setRollEditHook } from './pianoroll.js';
import { newMidiClip, syncMidiDurations } from './midi.js';
import { newInstrumentState } from './instruments/index.js';
import { ensureInput, startCapture, stopCapture, setUserOffset } from './recorder.js';
import { renderMix } from './exporter.js';
import { encodeWav } from './wav.js';
import { saveProject, loadProject, clearSession } from './project.js';
import { buildDemo } from './demo.js';
import { $, clamp, status, download, slug } from './util.js';

const scroller = $('scroller');

/* ---------- transport ---------- */
let recTracks = [], takeN = 0;

async function startRecording() {
  if (S.recording) return;
  let armed = S.tracks.filter(t => t.arm);
  if (!armed.length) {
    const t = trackById(S.selTrack) || addTrack('Audio');
    t.arm = true; S.selTrack = t.id;
    renderAll();
    armed = [t];
  }
  try {
    status('Waiting for microphone access…');
    await ctx.resume();
    await ensureInput();
  } catch (err) {
    status(`Can't record: ${err.message}. Allow microphone access for this page, then press record again.`, true);
    return;
  }
  if (S.playing) stop();
  recTracks = armed;
  S.recording = true;
  play();
  startCapture(T.segCtx);
  syncTransport();
  status(`Recording onto ${armed.map(t => t.name).join(', ')}. Press Space or Stop to finish.`);
}

async function finishRecording() {
  const startPos = S.playFrom;
  S.recording = false;
  stop();
  const buf = await stopCapture();
  if (!buf) { status('The take was too short to keep.'); return; }
  takeN++;
  for (const t of recTracks) {
    const id = addBuffer(buf, `${t.name} take ${takeN}`);
    const clip = { id: nid('c'), buf: id, start: startPos, offset: 0, dur: buf.duration };
    t.clips.push(clip);
    S.selClip = clip.id;
  }
  renderTracks();
  status(`Kept take ${takeN} (${buf.duration.toFixed(1)} s) at ${fmtBars(startPos)}.`);
}

const transportStop = () => S.recording ? finishRecording() : stop();
const togglePlay = () => S.recording ? finishRecording() : S.playing ? stop() : play();

function syncTransport() {
  $('bPlay').classList.toggle('on', S.playing);
  $('bPlay').setAttribute('aria-label', S.playing ? 'Stop' : 'Play');
  $('bRec').classList.toggle('on', S.recording);
  $('bRec').setAttribute('aria-pressed', String(S.recording));
}
events.addEventListener('change', syncTransport);

$('bPlay').onclick = togglePlay;
$('bStop').onclick = transportStop;
$('bRec').onclick = () => S.recording ? finishRecording() : startRecording();
$('bHome').onclick = () => { seek(0); scroller.scrollLeft = 0; };
$('bLoop').onclick = () => {
  S.loop = !S.loop;
  if (S.loop && S.loopEnd - S.loopStart < 0.05) { S.loopStart = 0; S.loopEnd = 16 * spb(); }
  updateLoopUI(); restartIfPlaying();
};
$('bMetro').onclick = () => { S.metro = !S.metro; $('bMetro').setAttribute('aria-pressed', String(S.metro)); restartIfPlaying(); };
$('bSnap').onclick = () => { S.snap = !S.snap; $('bSnap').setAttribute('aria-pressed', String(S.snap)); };
$('bMixer').onclick = () => showDock('mixer');
$('bRoll').onclick = () => showDock('roll');
$('tabMixer').onclick = () => showDock('mixer', false);
$('tabRoll').onclick = () => showDock('roll', false);
setRollEditHook(() => { renderTracks(); restartIfPlaying(); });
$('bpm').onchange = e => {
  const v = clamp(Math.round(+e.target.value || S.bpm), 40, 240);
  e.target.value = v;
  const p = position();
  S.bpm = v; syncMidiDurations(); applyAll(); renderTracks();
  if (S.playing) startEngine(p);
  status(`Tempo set to ${v} BPM. Clips keep their positions in time; the grid moves.`);
};
$('zoom').oninput = e => setZoom(+e.target.value);
$('recOffset').onchange = e => {
  const v = clamp(Math.round(+e.target.value || 0), -500, 500);
  e.target.value = v; setUserOffset(v);
  try { localStorage.setItem('tapehouse.recOffset', v); } catch { /* storage unavailable */ }
};
try { const v = +localStorage.getItem('tapehouse.recOffset') || 0; $('recOffset').value = v; setUserOffset(v); } catch { /* storage unavailable */ }

/* ---------- tracks & buses ---------- */
const doAddTrack = () => {
  const t = addTrack(); S.selTrack = t.id; renderAll();
  status(`Added ${t.name}. Arm it (R) to record, or drop an audio file on its lane.`);
};
$('bAddTrack').onclick = doAddTrack;
$('bAddTrack2').onclick = doAddTrack;
$('bAddMidi').onclick = () => {
  const t = addTrack(`Synth ${S.tracks.filter(x => x.inst).length + 1}`);
  t.inst = newInstrumentState('synth');
  const bar = 4 * spb(), c = newMidiClip(Math.floor(S.pos / bar) * bar, 16);
  t.clips.push(c);
  renderAll(); editClip(t, c);
  status(`Added ${t.name} with a 4-bar MIDI clip. Click in the piano roll to draw notes.`);
};
$('bAddBus').onclick = () => { const b = addBus(); renderAll(); status(`Added ${b.name}. Route tracks to it with their output menus.`); };

/* ---------- files ---------- */
const AUDIO_RE = /\.(wav|mp3|ogg|oga|flac|m4a|aac|aif|aiff|opus|webm)$/i;
async function importFiles(files, track, at) {
  const list = files.filter(f => f.type.startsWith('audio') || AUDIO_RE.test(f.name));
  if (!list.length) { status('Those files are not audio. Use WAV, MP3, OGG, FLAC, or M4A.', true); return; }
  let n = 0;
  for (const f of list) {
    const base = f.name.replace(/\.[^.]+$/, '');
    status(`Decoding ${f.name}…`);
    try {
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      const id = addBuffer(buf, base);
      const t = track || addTrack(base.slice(0, 28));
      track = null;
      t.clips.push({ id: nid('c'), buf: id, start: at, offset: 0, dur: buf.duration });
      S.selTrack = t.id; n++;
    } catch {
      status(`Couldn't decode ${f.name}. Your browser may not support that format; try WAV or MP3.`, true);
    }
  }
  if (n) { renderAll(); restartIfPlaying(); status(`Imported ${n} file${n > 1 ? 's' : ''} at ${fmtBars(at)}.`); }
}
$('bImport').onclick = () => $('file').click();
$('file').onchange = e => { importFiles([...e.target.files], null, S.pos); e.target.value = ''; };

scroller.addEventListener('dragover', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  $('dropLane').classList.toggle('over', !!e.target.closest('#dropLane'));
});
scroller.addEventListener('dragleave', () => $('dropLane').classList.remove('over'));
scroller.addEventListener('drop', e => {
  e.preventDefault(); $('dropLane').classList.remove('over');
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  if (files.length === 1 && /\.(tapehouse|json)$/i.test(files[0].name)) { openProject(files[0]); return; }
  const lane = e.target.closest('.lane[data-id]');
  const at = lane ? Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / S.zoom) : S.pos;
  importFiles(files, lane ? trackById(lane.dataset.id) : null, S.snap ? snapT(at) : at);
});

function syncProjectUI() {
  $('projName').value = S.name;
  $('bpm').value = S.bpm;
  $('bMetro').setAttribute('aria-pressed', String(S.metro));
  $('bSnap').setAttribute('aria-pressed', String(S.snap));
  $('zoom').value = Math.round(S.zoom);
  renderAll();
}
$('projName').onchange = e => { S.name = e.target.value.trim() || 'Untitled'; e.target.value = S.name; };

let newArmed = 0;
$('bNew').onclick = () => {
  if (S.recording) return;
  if (S.tracks.length && Date.now() - newArmed > 3000) {
    newArmed = Date.now();
    $('bNew').textContent = 'Discard?';
    setTimeout(() => { $('bNew').textContent = 'New'; }, 3000);
    status('Click New again within 3 seconds to discard this session. Save first if you want to keep it.');
    return;
  }
  newArmed = 0; $('bNew').textContent = 'New';
  clearSession();
  Object.assign(S, { name: 'Untitled', loop: false, loopStart: 0, loopEnd: 0 });
  addTrack(); fitZoom(); syncProjectUI();
  status('New session. Arm a track and press record, or import audio.');
};

$('bOpen').onclick = () => $('projFile').click();
$('projFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openProject(f); };
async function openProject(file) {
  if (S.recording) return;
  try {
    await loadProject(file, msg => status(msg));
    syncProjectUI();
    status(`Opened ${S.name}: ${S.tracks.length} tracks.`);
  } catch (err) {
    status(`Couldn't open ${file.name}: ${err.message}`, true);
  }
}

$('bSave').onclick = async () => {
  status('Saving project…');
  try {
    download(await saveProject(), `${slug(S.name)}.tapehouse`);
    status(`Saved ${slug(S.name)}.tapehouse to your downloads folder.`);
  } catch (err) { status(`Couldn't save: ${err.message}`, true); }
};

$('bExport').onclick = async () => {
  status('Rendering mixdown…');
  try {
    const t0 = performance.now();
    const buf = await renderMix();
    download(encodeWav(buf, 24), `${slug(S.name)}-mix.wav`);
    status(`Exported ${slug(S.name)}-mix.wav (${buf.duration.toFixed(1)} s, 24-bit) in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  } catch (err) { status(err.message, true); }
};

/* ---------- mixer resize & zoom gestures ---------- */
scroller.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(S.zoom * Math.exp(-e.deltaY * 0.002), e.clientX);
}, { passive: false });

$('mgrip').addEventListener('pointerdown', e => {
  e.preventDefault();
  const g = e.currentTarget;
  g.setPointerCapture(e.pointerId);
  const y0 = e.clientY, h0 = $('mixer').offsetHeight;
  const mv = ev => $('mixer').style.setProperty('--mix-h', clamp(h0 + (y0 - ev.clientY), 180, window.innerHeight * 0.7) + 'px');
  const up = () => { g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up); };
  g.addEventListener('pointermove', mv); g.addEventListener('pointerup', up);
});

/* ---------- keyboard ---------- */
document.addEventListener('keydown', e => {
  const tg = e.target, tag = tg.tagName;
  if ((tag === 'INPUT' && tg.type !== 'range') || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (e.key === 'Escape' || e.key === 'Enter') tg.blur();
    return;
  }
  if (rollKey(e)) { e.preventDefault(); return; }
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (S.selClip) { e.preventDefault(); deleteClip(); } }
  else if (mod && k === 'd') { e.preventDefault(); duplicateClip(); }
  else if (mod && k === 's') { e.preventDefault(); $('bSave').click(); }
  else if (mod && k === 'o') { e.preventDefault(); $('bOpen').click(); }
  else if (mod) return;
  else if (k === 's') splitClip();
  else if (k === 'r') $('bRec').click();
  else if (k === 'm') showDock('mixer');
  else if (k === 'e') showDock('roll');
  else if (k === 'l') $('bLoop').click();
  else if (k === 'c') $('bMetro').click();
  else if (e.key === 'Home') { e.preventDefault(); $('bHome').click(); }
  else if (e.key === '=' || e.key === '+') setZoom(S.zoom * 1.25);
  else if (e.key === '-') setZoom(S.zoom / 1.25);
});
document.addEventListener('keyup', e => { if (e.key === ' ' && e.target.tagName === 'BUTTON') e.preventDefault(); });

/* ---------- boot ---------- */
S.master = newChannel('master', 'Master', '#f2a93b');
S.returns = [makeReturn('Plate', 'reverb'), makeReturn('Echo', 'delay')];
routeAll(); applyAll();
syncProjectUI();
startFrameLoop();
buildDemo()
  .then(() => { fitZoom(); syncProjectUI(); status('Demo session ready: 6 tracks, a drum bus, plate and echo returns. Press Space to play.'); })
  .catch(err => status(`Couldn't build the demo session (${err.message}). Add a track and import audio to start.`, true));
