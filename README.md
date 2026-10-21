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
| L / C / M / E | Loop / metronome / mixer / piano roll |
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
| `src/midi.js` | MIDI clip model and note scheduling |
| `src/pianoroll.js` | Piano roll editor and instrument panel |
| `src/instruments/` | Instrument registry, Synth, Sampler |
| `src/knob.js` | Rotary knob control |
| `src/demo.js` | Synthesized demo loops |
| `src/wav.js` | WAV encoder |

## Known limits

- Audio clip positions are in seconds, so changing the tempo moves the grid under them. MIDI clips follow the tempo.
- Recording latency compensation uses the browser's reported latency. Use the **Rec offset** field to fine-tune it.
- No undo yet, and project files keep every clip's full source audio, so they can get large.
