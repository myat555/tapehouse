# Tapehouse

A multitrack DAW that runs in the browser, built on the Web Audio API with no runtime dependencies.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve dist/ locally
```

It opens with a demo session synthesized in the browser: 6 tracks, a drum bus, and plate/echo returns.

## Features

- Unlimited tracks and submix buses; route any track to any bus
- Channel strips: 3-band EQ, compressor, pan, fader (+6 dB to -∞), stereo peak meters, mute/solo
- Two effect returns (plate reverb, tempo-synced dotted-⅛ echo) with per-track sends; limiter on the master
- Clip editing: move (including across tracks), trim either edge, split, duplicate, delete, snap to beat
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
| L / C / M | Loop / metronome / mixer |
| Home | Go to start |
| ⌘S / ⌘O | Save / open project |
| + / - or ⌘-scroll | Zoom |

Drag in the ruler to set a loop. Double-click any knob or fader to reset it. Hold Shift while dragging for fine control.

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
| `src/demo.js` | Synthesized demo loops |
| `src/wav.js` | WAV encoder |

## Known limits

- Clip positions are in seconds. Changing the tempo moves the grid, not the clips.
- Recording latency compensation uses the browser's reported latency. Use the **Rec offset** field to fine-tune it.
- No undo yet, and project files keep every clip's full source audio, so they can get large.
