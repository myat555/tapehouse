# Tapehouse

A multitrack DAW that runs in the browser, built on the Web Audio API with no runtime dependencies.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve dist/ locally
```

It opens with a demo session synthesized in the browser: 6 tracks, a drum bus, and plate/echo returns. The Arp track is MIDI; double-click its clip to open it in the piano roll.

## Features

- Unlimited tracks and submix buses; route any track to any bus
- Channel strips: 3-band EQ, compressor, pan, fader (+6 dB to -∞), stereo peak meters, mute/solo
- Two effect returns (plate reverb, tempo-synced dotted-⅛ echo) with per-track sends; limiter on the master
- Clip editing: move (including across tracks), trim either edge, split, duplicate, delete, snap to beat
- Clip editor for audio: the whole source waveform, plus gain, normalize, fade in/out with five curve shapes, crossfades, reverse, pitch shift and time stretch
- Pitch-preserving time stretch (WSOLA, rendered in a background worker) or tape-style varispeed; **Stretch audio** keeps audio clips on the beat when the tempo changes
- MIDI clips with a piano roll: draw, move, resize, multi-select, transpose, quantize, velocity lane, adjustable grid (1/4 to 1/32 and triplets)
- Instruments for MIDI tracks: a polyphonic **Synth** and a **Sampler** that plays any audio in the project at any pitch; new instruments plug in through `src/instruments/`
- Loop region, metronome, tempo, zoom
- Import WAV/MP3/OGG/FLAC/M4A by button or drag and drop
- Record from a microphone or audio interface onto armed tracks
- Export the full mix to a 24-bit WAV (rendered offline, faster than real time)
- Save/open `.tapehouse` project files; the audio is embedded as 24-bit WAV

## Shortcuts

| Key | Action |
| --- | --- |
| Space | Play / stop (stop returns to where playback started) |
| R | Record onto armed tracks |
| S | Split the selected clip at the playhead |
| ⌘D | Duplicate the selected clip |
| Delete | Delete the selected clip |
| L / C / M / E / W | Loop / metronome / mixer / piano roll / clip editor |
| Home | Go to start |
| ⌘S / ⌘O | Save / open project |
| + / - or ⌘-scroll | Zoom |

Drag in the ruler to set a loop. Double-click any knob or fader to reset it. Hold Shift while dragging for fine control.

### MIDI

- **+ MIDI** adds a synth track with an empty 4-bar clip. Double-clicking an empty spot on any track adds a 1-bar MIDI clip.
- Double-click a MIDI clip to edit it. Double-click an audio clip to make a Sampler track that plays it (C4 plays it at its original pitch).
- In the piano roll, drag on empty space to draw a note and set its length. Drag a note to move it, or drag its right edge to resize it. Shift+drag selects a region, and right-click or Alt+click deletes a note. Hold ⌘/Ctrl while dragging to turn off snapping.
- Keys after clicking in the roll: Delete, ⌘A, ⌘D (duplicate the selection), ↑/↓ transpose (Shift = octave), ←/→ nudge, Q quantize, Esc deselect.
- Drag the orange marker in the roll's ruler to change the clip length. MIDI clips follow tempo changes; audio clips don't.

### Audio clips

- Click an audio clip to open it in the **Clip** tab. It shows the whole source file; the bright part is what the clip plays. Drag the orange edges to trim, the white squares to set the fades, and the orange line up or down to change gain. Click inside the region to move the playhead there.
- In the arrange view, drag the white squares at a clip's top corners to set its fades. **Alt+drag** either edge to stretch the clip instead of trimming it.
- **Gain** goes from -48 to +24 dB; **Normalize** sets it so the loudest peak reaches -0.3 dBFS. **Reverse** plays the same region backwards.
- **Fade in / Fade out**, each with a shape: Linear, Equal power, Fast, Slow, S-curve.
- **Crossfade:** overlapping clips on a track crossfade over the overlap, using their fade shapes. Linear keeps a split recording at constant level; use Equal power for unrelated material. The **X-fade** knob sets the overlap with the previous clip, pulling both edges out around the join so the audio stays in time. It works when the two clips touch or overlap (split a clip with S to try it).
- **Stretch · keep pitch** changes speed and pitch independently: **Length** (0.25× to 4×), **Pitch** (±24 semitones) and **Fine** (±100 cents). **Varispeed · tape** changes both together, like tape.
- **Source BPM** is the tempo the audio was recorded at. Typing it in stretches the clip to the project tempo. **Fit to bars** stretches the clip to the nearest whole number of bars (or 1, 2 or 4 beats).
- With **Stretch audio** on in the transport, changing the tempo moves every audio clip to stay on the same bar and stretches it to match. Turn off **Follow tempo** on a clip to keep its length; it still moves with its bar. With **Stretch audio** off, audio clips stay where they are in seconds.
- A stretched clip plays varispeed for the moment it takes to render (under a second for the demo loops), then switches to the stretched version. Export always waits for every render.

### Adding a synthesizer

Create `src/instruments/mysynth.js` exporting `{ name, defaults, params, start }` and register it in `src/instruments/index.js` with `registerInstrument('mysynth', def)`. The comment at the top of that file documents the voice interface. The piano roll builds the instrument's controls from `params`, and live playback, previews and WAV export all go through `start`, so a new instrument needs no other changes.

## Code map

| File | Role |
| --- | --- |
| `src/state.js` | Session state, ids, time helpers |
| `src/audio.js` | Channel graph; context-agnostic so live playback and export share it |
| `src/engine.js` | Lookahead transport scheduler with seamless looping |
| `src/ui.js` | Arrange view, clip editing, mixer strips, meters |
| `src/main.js` | Controls, keyboard, import, project and recording wiring |
| `src/exporter.js` | Offline mixdown |
| `src/project.js` | Save/load |
| `src/recorder.js` + `public/recorder-worklet.js` | Input capture |
| `src/clips.js` | Audio clip model, fades/crossfades, stretch edits, clip playback |
| `src/clipeditor.js` | Clip editor (waveform, fades, gain, pitch and stretch controls) |
| `src/stretch.js` + `src/stretch-worker.js` + `src/wsola.js` | Pitch-preserving time stretch and its render cache |
| `src/midi.js` | MIDI clip model and note scheduling |
| `src/pianoroll.js` | Piano roll editor and instrument panel |
| `src/instruments/` | Instrument registry, Synth, Sampler |
| `src/knob.js` | Rotary knob control |
| `src/demo.js` | Synthesized demo loops |
| `src/wav.js` | WAV encoder |

## Known limits

- WSOLA stretching is clean on drums and most loops, but large stretches of sustained tonal material can sound a little phasey. Stretched renders of very long files (over 10 minutes of output) fall back to varispeed.
- Gain and fades are per clip; there's no volume automation yet.
- Recording latency compensation uses the browser's reported latency. Use the **Rec offset** field to fine-tune it.
- No undo yet, and project files keep every clip's full source audio, so they can get large.
