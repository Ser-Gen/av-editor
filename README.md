# Browser AV Editor

Minimalist multi-track audio/video editor in the browser. English UI, dark theme. Export uses FFmpeg WASM.

## Setup

Dependencies and assets are installed automatically:

```bash
npm run bootstrap
npm install
npm run dev
```

Open the dev server URL. COOP/COEP headers are required for FFmpeg WASM (configured in `vite.config.ts`).

## Scripts

| Command | Description |
|---------|-------------|
| `npm run bootstrap` | Copy FFmpeg core to `public/ffmpeg/`, download DejaVu font |
| `npm run dev` | Development server |
| `npm run build` | Production build |

## Quick start

1. Import media from the toolbar or **Media Library** (left panel).
2. Drag clips along the timeline or between tracks; trim with edge handles.
3. Add text with templates (lower third, center title, subtitle).
4. Preview with transport controls; adjust clip and track volume as needed.
5. **Load FFmpeg**, then **Export MP4** (480p / 720p / 1080p / 4K).

### Timeline navigation

The timeline owns its own scrolling — it never rides browser scroll.

| Input | Action |
|-------|--------|
| **Wheel** | Pan (vertical scrolls tracks, horizontal scrolls time) |
| **⇧ Wheel** | Pan horizontally with a mouse wheel |
| **⌘/Ctrl + wheel**, **trackpad pinch** | Zoom, anchored under the cursor |
| **Middle-drag** | Grab and pan |
| **Drag on ruler** | Scrub the playhead |
| **Drag on empty lane** | Marquee-select clips |

Below the lanes is the **minimap**: the whole project drawn at a fixed size, with the lanes'
viewport as a window over it. It navigates independently of the zoom — at frame-level zoom in a
long take, one click on the far end goes there.

| Input | Action |
|-------|--------|
| **Click / drag** | Seek there, bringing the lanes with it |
| **Drag the window** | Pan the timeline |
| **Wheel** | Zoom |
| **Double-click** | Fit the project to the viewport |

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| **Space** | Play / pause |
| **⌘Z** / **Ctrl+Z** | Undo (⇧⌘Z or Ctrl+Y to redo) |
| **S** | Split selected clips at playhead |
| **⌘D** / **Ctrl+D** | Duplicate selection |
| **⌘A** / **Ctrl+A** | Select all clips |
| **Delete** / **Backspace** | Delete selection (leaves a gap) |
| **⇧Delete** | Ripple delete — closes the gap on that track |
| **← →** | Nudge selection 1 frame (**⇧** for 1 second) |
| **, .** | Step the playhead 1 frame (**⇧** for 1 second) |
| **Home** / **End** | Jump to project start / end |
| **⌘+** / **⌘−** | Zoom in / out |
| **Z** / **⇧Z** | Zoom to selection / fit project |
| **N** | Toggle snapping |
| **⌥ (hold)** | Bypass snapping during a drag |

Selection is multi-clip: **⇧-click** or **⌘-click** to add and remove, or marquee-drag
across empty lane space. Moves, trims and deletes are undoable, and a whole drag
collapses into a single undo step.

### Snapping

Clip edges snap to the playhead, to other clips' edges, and to `0:00`, with a
threshold measured in pixels — so it feels the same at every zoom level. An amber
line marks the engaged target. Hold **⌥** to bypass, or turn **Snap** off in the
timeline toolbar. All edits quantize to frame boundaries (`1 / fps`), which keeps
the preview and the FFmpeg export in agreement.

---

## Media Library

The **Media Library** panel stores all imported media for reuse. Files are referenced by `assetId` — the same file can appear in multiple timeline clips without duplicating bytes in memory.

| Action | Where | Result |
|--------|-------|--------|
| Import Video / Audio / Image | Toolbar | File → library **and** timeline |
| **+ Import** | Media Library | File → library only |
| **+** on a library item | Media Library | Same asset added to timeline at playhead |
| **×** on a library item | Media Library | Remove from library (disabled while used on timeline) |
| **Record** | Media Library | Opens the capture panel: screen, microphone, system audio (see below) |

A video file imports as **one clip** that carries its own audio — it moves, trims, splits and deletes as a single object. Use **Detach audio** in the Inspector to move that audio onto its own audio track when you need to slide it against the picture.

Status messages (import, URL load, recording, frame capture) appear briefly in the library panel.

---

## URL import

On page load, media URLs from the query string are fetched into the **Media Library only** (not the timeline). Useful for opening the editor with assets pre-loaded from another app or a bookmark.

### Query parameters

Equivalent parameter names: `media`, `url`, `file`.

Repeat the parameter for multiple files, or use comma-separated URLs in one value.

```
http://localhost:5173/?media=https://example.com/clip.mp4

http://localhost:5173/?media=https://a.mp4&media=https://b.mp3

http://localhost:5173/?media=https://a.mp4,https://b.mp3,https://c.png

http://localhost:5173/?media=/samples/demo.mp4
```

Percent-encode special characters in URLs:

```
http://localhost:5173/?media=https%3A%2F%2Fexample.com%2Fmy%20video.mp4
```

### Behavior

1. Parse `window.location.search` for `media`, `url`, and `file`.
2. `fetch` each URL → `File` → probe duration/dimensions → append to library.
3. Remove import params from the address bar (`history.replaceState`) so refresh does not re-import.
4. Show status in Media Library; log failures to the console.

### Types & CORS

Type is inferred from `Content-Type` and file extension (`mp4`, `mp3`, `png`, etc.). Unknown types default to image.

Remote hosts must allow [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) for your origin. There is no proxy in this project.

---

## Timeline & audio

### Tracks are an ordered layer stack

The project starts with one video track (**V1**) and one audio track (**A1**).

Video tracks composite **bottom-up**: a clip on **V2** draws over a clip on **V1**,
exactly as the track order shows. Move a clip to a higher track to put it in front —
there is no separate "overlay" concept and no layering checkbox. Video, image and
text clips live on video tracks; audio clips live on audio tracks. The preview and
the FFmpeg export share one ordering function (`src/utils/compositeOrder.ts`), so
what you see is what you get.

| Track control | Effect |
|---------------|--------|
| **▲ ▼** | Reorder within its own group — changes layering for video tracks |
| **👁** (video) | Hide the layer in preview and export |
| **M** / **S** (audio) | Mute / solo. An active solo also silences video-clip audio |
| **🔒** | Lock — clips on the track can't be moved or trimmed |
| **✕** | Delete the track and its clips (undoable; last track of a kind is kept) |
| Double-click name | Rename |
| Drag bottom edge | Resize the lane |

New clips land on the first lane with room at the playhead. Video imports fill the
base lane as a sequence; text prefers the topmost lane so it lands over the picture.
A new lane is created automatically only when nothing free exists.

### Volume

Two stages, multiplied together:

- **Per clip** — Inspector slider, **0–150%**. This is where a video clip's own audio is controlled.
- **Per audio track** — slider in the track header, **0–150%**. Applies to audio clips on that track. (Video clips sit on video tracks, so no track volume applies to them.)

Both affect preview (Web Audio `GainNode`) and export (FFmpeg `volume` filter).
Preview and export mix all audible clips (`amix` in FFmpeg).

### Placement (video, image, text)

Every visual clip fills the frame by default (fit and letterbox). Tick
**Custom placement (crop / picture-in-picture)** in the Inspector to crop the source
and position it on the canvas; untick to return to full frame. Layer order is *not*
part of placement — that comes from the track stack.

**Text:** select a text clip — use **Text box on screen** to move and resize the area where the template is drawn.

All editors share the same interaction model:

- **Position on screen** — drag the frame or set X/Y/W/H (% of canvas)
- **Crop source** (video & image only) — drag the crop region on the source or set X/Y/W/H (% of source)

Custom placement defaults to the top-right. New text uses the full canvas until you resize the box. Preview and export use the same transforms (canvas + FFmpeg `crop` / `scale` / `overlay` for media; framed `drawtext` for text).

### Video thumbnails

| Location | Preview |
|----------|---------|
| Media Library | First frame (~0.05 s) for video items |
| Timeline (video clips) | Filmstrip of multiple frames across the trimmed region |

Thumbnails are extracted in the browser (canvas + `<video>`), cached per `assetId`, and updated when trim handles change the visible range. Images in the library use the file directly as a thumb.

### Waveforms

Audio clips display a **waveform** inside the clip block; video clips carrying audio
show a waveform ribbon under their filmstrip.

- Generated on first display via Web Audio `decodeAudioData`.
- When a container's audio can't be decoded (AAC-in-MP4 support varies by browser), the clip falls back to a flat ribbon rather than hiding the audio.
- Cached per `assetId` (reused across clips and timeline zoom).
- Trim handles update the visible region (`sourceTrimIn` / `sourceTrimOut`).
- Works for imported audio, microphone recordings, and audio extracted from video.
- Files larger than **80 MB** are skipped (warning in console).

---

## Recording

**Record** in the Media Library header opens the capture panel. Tick any of **Screen**,
**Microphone** and **System audio**, press **Record**, and press **Stop** when done. Each
source becomes its own file, its own library asset and its own timeline track.

| Topic | Detail |
|-------|--------|
| Tracks | Screen → first free video lane, microphone → A1, system audio → A2 |
| Alignment | All sources share one time anchor and are placed frame-aligned (measured at 17 ms across three sources, against a 33 ms frame) |
| During playback | Recording works while the project plays — suitable for voiceover and for capturing a playthrough |
| Undo | A whole session is one undo step |
| Memory | Nothing is buffered in RAM. Encoded media streams to disk (OPFS) as it is produced, so a thirty-minute capture costs no more heap than a thirty-second one — measured at 30 minutes of 1080p: 100 MB on disk, heap bounded under 20 MB and back to its starting point afterwards |
| Seeking | Recordings carry a real duration and scrub as soon as they stop — see below |
| Dropped frames | Reported live while recording. A 1080p60 capture drops none |
| Permission | The browser prompts for the screen picker and the microphone on first use |
| Format | H.264/AAC in a fragmented MP4 (`.m4a` for audio-only sources), named `<source>-recording_<timestamp>_<length>.mp4`. Browsers without the WebCodecs pipeline fall back to WebM — see below |
| Processing | Echo cancellation and noise suppression enabled on the microphone |

### How recordings are written

Frames are read off the stream, encoded with WebCodecs and muxed to disk as the recording
runs, so the file is finished the moment you press Stop — no rebuild step, and stopping a
half-hour take costs under a millisecond.

The container is a **fragmented** MP4, which matters for one reason: it is a run of
self-contained fragments, so whatever reached the disk is a valid file on its own. A tab
killed mid-recording leaves something that plays immediately, rather than a recording whose
index never got written.

The capture's own clock is stored on the asset as well, so the editor never has to trust the
container.

**Where this is not available**, the panel says so and falls back to `MediaRecorder`. That
writes a *live* container — no duration, no seek index, `duration = Infinity` in a browser
and `N/A` in `ffprobe` — so those recordings are remuxed on stop, codecs copied untouched,
to fill in the duration and the index. The panel names which engine is in use before you
press Record.

### System audio

Availability is a platform matter, and the panel says so **before** you record rather than
leaving you with a silent track:

- **Tab audio** works broadly in Chrome.
- **Window or whole-screen audio** needs Windows or ChromeOS, or macOS 14.2+ with Chrome 141+.
- **Firefox and Safari** ignore the request entirely.

If the picker returns without an audio track, no system-audio file is created and the panel
tells you why.

### If a recording is interrupted

Because bytes are on disk as they are captured, a crashed or closed tab leaves a real file
rather than nothing. On the next launch the capture panel offers it under **A recording was
interrupted**, with **Restore** and **Delete** per source.

Such a file already plays — it is complete up to its last whole fragment, so an eight-second
take killed without warning comes back as a seven-second recording. **Restore** rebuilds it
anyway, which takes tens of milliseconds and replaces the fragment-rounded length with an
exact one.

---

## Preview

### Transport

Play / pause, frame-step buttons, seek slider, and an **editable `MM:SS:FF` timecode** —
type a timecode and press Enter to jump. **Save frame** captures the composited preview
at the current playhead.

### Save frame

| Topic | Detail |
|-------|--------|
| Content | Full composite: video, images, text overlays |
| Output | PNG in Media Library |
| Resolution | Matches project setting (480p / 720p / 1080p / 4K) |
| Filename | `frame_MM-SS-ms.png` from playhead timecode |
| Playback | Paused before capture |
| Timeline | Use **+** in library to place the still |

---

## Export

1. **Load FFmpeg** — downloads WASM core (once per session).
2. **Export MP4** — builds a filter graph from timeline clips, resolution preset, and lane volumes.

Prefer H.264/AAC MP4 inputs for reliable export. Large projects may hit browser memory limits.

---

## References

- [FFmpeg WASM](https://ffmpegwasm.netlify.app/)
- [@ffmpeg/core on npm](https://www.npmjs.com/package/@ffmpeg/core)
- [DejaVu fonts](https://github.com/dejavu-fonts/dejavu-fonts)

## Notes

- All processing runs in the browser; no backend.
- Session state is not persisted — refresh clears the project unless media was loaded via URL (params are stripped after import).
- Waveform and video thumbnail caches are cleared when a library item is removed.
