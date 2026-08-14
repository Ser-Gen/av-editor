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
2. Drag clips on the timeline; trim with edge handles.
3. Add text with templates (lower third, center title, subtitle).
4. Preview with transport controls; adjust audio lane volume as needed.
5. **Load FFmpeg**, then **Export MP4** (480p / 720p / 1080p / 4K).

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| **Space** | Play / pause |
| **S** | Split selected clip at playhead |
| **⌘D** / **Ctrl+D** | Duplicate selected clip |
| **Delete** / **Backspace** | Remove selected clip |

Inspector (right panel): mute audio / hide video on selected video clips.

---

## Media Library

The **Media Library** panel stores all imported media for reuse. Files are referenced by `assetId` — the same file can appear in multiple timeline clips without duplicating bytes in memory.

| Action | Where | Result |
|--------|-------|--------|
| Import Video / Audio / Image | Toolbar | File → library **and** timeline |
| **+ Import** | Media Library | File → library only |
| **+** on a library item | Media Library | Same asset added to timeline at playhead |
| **×** on a library item | Media Library | Remove from library (disabled while used on timeline) |
| **Record** / **Stop** | Media Library | Microphone → library (see below) |

Video files with an audio track create two clips on toolbar import: a video clip (embedded audio muted) and a matching audio clip on an audio lane.

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

### Tracks

| Lane | Purpose |
|------|---------|
| Overlay 1, Overlay 2, … | Images and text (parallel layers) |
| Video 1 | Video clips |
| Audio 1, Audio 2, … | Audio clips (parallel mixing) |

### Parallel overlay lanes

The timeline starts with **Overlay 1** and **Overlay 2**. Images and text are placed at the playhead on the first overlay lane free at that time. Add an image on **Overlay 1**, then text at the same playhead — it lands on **Overlay 2**. Use **+ Overlay track** to add more lanes.

### Parallel audio lanes

The timeline starts with **Audio 1** and **Audio 2**. New audio is placed at the playhead on the first lane with no time overlap at that position. If both lanes are occupied, **Audio N** is created automatically.

- **+ Audio track** (timeline toolbar) — add an empty lane manually.
- Preview and export **mix** all active audio clips (`amix` in FFmpeg).

### Per-lane volume

Each audio lane has a slider in the track label: **0–150%** (100% = unchanged, up to 150% = boost).

- Applies to **all clips** on that lane.
- Affects preview (Web Audio `GainNode`) and export (FFmpeg `volume` filter).

### Overlay placement (video, image, text)

**Video (PiP):** enable **Use as overlay (PiP)** on a video clip.

**Image:** select any image clip on the overlay track — the placement editor opens automatically.

**Text:** select a text clip — use **Text box on screen** to move and resize the area where the template is drawn.

All editors share the same interaction model:

- **Position on screen** — drag the frame or set X/Y/W/H (% of canvas)
- **Crop source** (video & image only) — drag the crop region on the source or set X/Y/W/H (% of source)

Video PiP defaults to the top-right. New images start letterboxed to fit. New text uses the full canvas until you resize the box. Preview and export use the same transforms (canvas + FFmpeg `crop` / `scale` / `overlay` for media; framed `drawtext` for text).

### Video thumbnails

| Location | Preview |
|----------|---------|
| Media Library | First frame (~0.05 s) for video items |
| Timeline (video clips) | Filmstrip of multiple frames across the trimmed region |

Thumbnails are extracted in the browser (canvas + `<video>`), cached per `assetId`, and updated when trim handles change the visible range. Images in the library use the file directly as a thumb.

### Waveforms

Audio clips display a **waveform** inside the clip block:

- Generated on first display via Web Audio `decodeAudioData`.
- Cached per `assetId` (reused across clips and timeline zoom).
- Trim handles update the visible region (`sourceTrimIn` / `sourceTrimOut`).
- Works for imported audio, microphone recordings, and audio extracted from video.
- Files larger than **80 MB** are skipped (warning in console).

---

## Microphone recording

**Record** in the Media Library header starts capturing the default microphone. **Stop** saves the file to the library.

| Topic | Detail |
|-------|--------|
| During playback | Recording works while the project plays — suitable for voiceover |
| Timeline | Not auto-placed; use **+** on the library item to add at playhead |
| Permission | Browser prompts on first use |
| Format | Browser-dependent (usually WebM/Opus); named `mic-recording_<timestamp>.webm` |
| Processing | Echo cancellation and noise suppression enabled |

---

## Preview

### Transport

Play / pause, seek slider, and timecode. **Save frame** captures the composited preview at the current playhead.

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
