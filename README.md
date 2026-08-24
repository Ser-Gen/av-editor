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

1. Import media from the toolbar or **Media Library** (left panel), or drag files straight from Finder onto a track.
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

### Right-click a clip

| Item | Notes |
|------|-------|
| Split at playhead | `S`. Needs the playhead inside the clip |
| Trim start / end to playhead | Cut here and discard that side, without the leftover clip to select and delete |
| Duplicate | `⌘D` |
| Bake this range to the library… | Renders the clip's effect chain through the compositor into a new file — this clip's range, not the whole source |
| Run a preset on this range… | The FFmpeg presets, over the same range |
| Detach audio · Mute this clip · Hide video | The inspector's video toggles, one click away |
| Zoom to clip | `Z` |
| Delete · Ripple delete | `⌫` and `⇧⌫` |

Right-clicking a clip that is not selected selects it first, so a menu offering to delete
three clips can never mean three you were not pointing at. Anything that cannot apply is
listed but disabled, with the reason as its tooltip — offline media cannot be baked, a locked
track refuses every edit, and only one preset or bake may run at a time.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| **Space** | Play / pause |
| **Media keys** | Play / pause the project (not whichever file the preview last decoded) |
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

The left sidebar has three tabs — **Media**, **Record** and **Storage** — and the inspector on
the right has up to three of **Clip**, **Placement** and **Effects**, listing only the ones the
selected clip has anything to put in. Drag either sidebar's inner edge to resize it, or
double-click that edge to go back to the default width; the widths are remembered, and
re-clamped on a smaller screen so a layout saved on a large display cannot open with both
sidebars covering the preview. The placement and crop stages grow with the panel, so dragging
the inspector wider is how you get a bigger one to work on.

The **Media** tab stores all imported media for reuse. Files are referenced by `assetId` — the same file can appear in multiple timeline clips without duplicating bytes in memory.

| Action | Where | Result |
|--------|-------|--------|
| Import Video / Audio / Image | Toolbar | File → library **and** timeline |
| **+ Import** | Media Library | File → library only |
| **Storage** tab | Media Library | Quota, what is using it, save/open a folder copy, Clear everything |
| **+** on a library item | Media Library | Same asset added to timeline at playhead |
| **×** on a library item | Media Library | Remove from library (disabled while used on timeline) |
| **Record** tab | Media Library | The capture panel: screen, microphone, system audio (see below). A recording in progress pulls this tab forward and marks it |
| Drag files from Finder | Onto the timeline | File → library **and** a clip at the track and time you dropped on |

A video file imports as **one clip** that carries its own audio — it moves, trims, splits and deletes as a single object. Use **Detach audio** in the Inspector to move that audio onto its own audio track when you need to slide it against the picture.

Status messages (import, URL load, recording, frame capture) appear briefly in the library panel.

---

## Saving, and what survives a refresh

The project saves itself. There is no Save button and no project list — whatever you are
working on is written to browser storage as you edit, and reopens when you come back.

**What comes back on its own:** the whole timeline — cuts, tracks, effects, keyframes, fades,
masks, custom shaders, project and export settings — together with every file the app *made*:
recordings, preset outputs, baked clips, captured frames, and anything fetched from a URL.

**What does not:** the files you imported from your own disk. They are never copied into the
browser, so a 4 GB import costs nothing and takes no time — but the browser cannot reopen a
file on its own. Those clips come back **offline**: full length, all their edits intact,
drawn as a striped placeholder that says what is missing.

| Action | Where | Result |
|--------|-------|--------|
| **Relink…** | Media Library, when anything is offline | One picker for the whole project — hand back the files and each finds its own clip |
| **Relink** | On an offline library item | Find that one file |
| **Save a copy…** | Media Library | Writes the project *and every file it uses* into a folder you choose |
| **Open a copy…** | Media Library | Opens a project back out of such a folder, media and all |
| **Clear everything** | Media Library, beside the storage bar | Deletes the project, all recordings and all produced files. Your own imported files are untouched |

Relinking matches on name, size and modification date, so a whole project usually relinks in
one interaction. A file matched on name alone is accepted and flagged — it may be a different
cut of the same thing. **Export refuses to start while any clip is offline**, and names the
files, because the alternative is discovering a black rectangle after the upload.

Saving a copy to a folder is worth doing on anything you care about. It is a real backup
outside the browser, it survives *Clear everything*, and it is the answer to eviction —
browsers may reclaim storage on their own, and Safari does so after seven days without a
visit. It also makes reopening free: one folder permission covers every file inside it, so a
project saved to a folder tends to reopen with no relinking at all.

Two tabs cannot edit one project. The second one opens read-only and says so, rather than
silently overwriting the first.

### Storage

The library shows how much of the browser's storage is used, whether it can be evicted, and
the size of every file the app produced — those are the ones taking up room, and deleting an
original never deletes what was made from it.

Before a recording, the Record panel converts the space left into the number that matters:
`≈ 4.1 GB per hour at this quality · room for about 6 h 40 m`. Under 15 minutes of headroom
it warns; under 5 it will not start a take. If storage does run out mid-recording, that
source stops cleanly and says why — the file already on disk stays playable.

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

### Dropping files onto the timeline

Files dragged in from Finder land on the track and at the time you drop them, rather than
at the playhead. While you drag, a line shows the exact frame it will land on and the lane
it will land in; it snaps like a clip drag does, and ⌥ suspends snapping the same way.

What the pointer chooses is the **time**, and that is not negotiated — a clip that quietly
slid down its track would be wrong in the one dimension you were specific about. The lane
is negotiated, for the two reasons a lane can be wrong: it is locked or holds the other
kind of media, or something is already sitting at that time. In both cases the file keeps
its time and takes the next lane, and a new track is made if no lane is free.

Dropping several files at once lays them end to end from the drop point — but one sequence
per kind, so a video and a music bed dropped together both start at the pointer instead of
the music queueing behind the picture. The whole drop is one undo step.

The length of what you are dragging cannot be shown: no browser will name a dragged file
before you let go of it, so there is no duration to draw a ghost clip from. Folders are
skipped with a message rather than imported as an unreadable file.

Dropped files are imported like any other — **referenced, not copied**, so they come back
offline after a reload exactly like files chosen through the picker. See
[Saving, and what survives a refresh](#saving-and-what-survives-a-refresh).

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

**An overlay may hang off the edge of the frame.** Drag it past any side and the part that
leaves the canvas is simply not drawn — that is how a picture-in-picture slides in from
the side or sits half out of shot. The placement stage shows a margin around the frame so
you can see where the overlay went and still reach its resize handle; anything in that
margin is dimmed, because it is real geometry that will not be in the render. X and Y
accept negative percentages for the same reason.

At least a tenth of the overlay always stays on the canvas. Something with no pixels in
shot is invisible in the preview *and* in the editor, which would leave nothing to drag
back — the clip would look empty with no way to find out why.

A **crop** is a different rule and is unchanged: it addresses pixels of the source file,
and outside the source there is nothing to sample.

**Keep aspect ratio** under either stage locks that rectangle's proportions while you drag
its handle or type a W or H. The ratio is the one you see on screen, not the raw
percentages — 30% × 30% is square only on a square canvas.

**Rotate** turns the placed picture about the frame's own centre, in degrees, clockwise. It
is part of the placement rather than an effect, which means the placement stopwatch animates
it along with everything else: arm **Animate placement**, move the playhead, set an angle,
and the overlay spins between the keys. The value is not wrapped to one turn, so keying 0 →
720 is two full spins.

The crop stage follows the playhead while playback is paused, so you are cropping against
the frame the clip is actually showing rather than the one it opened on.

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

### Frame rate and quality

| Setting | Choices | Effect |
|---------|---------|--------|
| Frame rate | 24 / 30 / 60 fps | Asked of the display and the camera. A request, not a promise — a display that cannot do 60 hands back 30, and the panel reports what each track actually negotiated |
| Scale | 100 / 75 / 50 / 25 % | A fraction of whatever the source turns out to be, applied to the screen and the camera alike |
| Video bitrate | Draft / Normal / High, or 4 / 2 / 1 Mbps / 600 / 300 kbps | A preset multiplies the derived bitrate by 0.6 / 1 / 1.6. A fixed rate replaces it outright, per video source. Audio is unaffected either way |

**Scale, not resolution**, because for a screen capture the resolution is not the app's to
choose: the browser's share picker decides it, and a program window is whatever size you
left it. A fraction means the same thing for a 4K display, a 1440p monitor and a
1000-pixel-wide window. Halving the edges quarters the pixels, and the bitrate curve
follows the pixel count — so 50% is roughly a quarter of the bytes.

It is asked of the live track, so everything downstream follows on its own: the reported
format, the bitrate, the sidecar, and the `MediaRecorder` fallback as much as the WebCodecs
path. Both axes come out even (H.264 refuses an odd dimension), and anything that would
land under 128 px on an edge is left unscaled rather than scaled badly.

A **preset** derives the bitrate from resolution and frame rate: 6 Mbps at 1080p30, scaled
by `pixels^0.95 × √(fps/30)`. **Normal is exactly 1×**, so it is the bitrate every recording
made before this setting existed used. Draft is for long screen captures, where two-thirds
the size is worth more than detail nobody will look at; High is for anything that will be
graded or scaled afterwards.

A **fixed rate** is the escape from that curve, and exists for one recording in particular:
an hour-long call whose shared screen is a static slide for minutes at a time. The presets
cannot go where that needs to go — the smallest of them is still 3.6 Mbps at 1080p, about
1.6 GB an hour — and reaching 500 kbps would need a multiplier of 0.08, at which point the
number on the dial is a fiction. A fixed rate deliberately does **not** scale with the
picture: the reason for naming a number is that the curve's answer was the wrong one, and a
"fixed" rate that moved when the share picker handed back a different window would not be.
It is spent per video source, so screen + camera costs twice the number shown. Below
100 kbps it is lifted to 100 kbps.

Encoding is **variable bitrate**, which is what makes a static screen cheap: under a
constant bitrate an encoder with nothing to say pads until it has spent the bits anyway, so
an hour of a motionless picture would cost the same as an hour of motion. This is what
WebCodecs already defaults to; it is now said explicitly, because it is the one setting
whose absence would be silent — nothing in the file records which mode wrote it, only the
size, an hour later.

**Key frames widen as the rate narrows** — every 1 second at or above Draft, every 2 at a
quarter of the curve, every 4 below that. A 1080p key frame is a whole picture encoded from
nothing, call it 100 KB, and one second of a 500 kbps stream is 62 KB in total: asking for
both every second means the encoder wrecks the key frame or starves the 29 frames after it,
and the low rate that was meant to make a small clean file makes a small smeared one. The
cost is stated where you choose it: a fragmented MP4 closes a fragment only on a key frame,
so at the bottom of the dial scrubbing lands on a 4-second grid and a killed tab loses up
to 4 seconds instead of 1. Nothing at or above Draft changes.

All three controls are locked once a take is running — the encoder and the tracks were
configured from them at the start, and a control that silently applied to the *next*
recording would be worse than one that is greyed out.

The size line under the controls is priced at the rate the capture will **request** and at
what each audio stream will really encode at (192 kbps for a microphone, 256 for system
audio), and it names the format it is estimating: `≈ 3.62 GB per hour at 1080p60 · Normal`.

### Starting a take, and getting out of one that will not start

Pressing Record begins a chain of waits on things the page does not control: choosing an
engine, the screen picker, asking the chosen source to resize, the camera prompt, the
microphone prompt, opening files on disk, starting the encoders. The panel names the one it
is waiting on, because "the button went dead" and "it is waiting for the microphone" are
very different problems.

Every one of those can sit there forever without ever failing. So:

- **Cancel is live for the whole start.** It is the only control that is, and it has to be —
  everything else was used to configure the encoder. Without it the only way out of a wait
  that never ends is reloading the page and losing the project. Anything already granted is
  stopped, including a stream that arrives after you gave up, so the browser never goes on
  claiming your screen is shared over a page that has gone back to idle.
- **A step that stops making sense says so** after 20 seconds — that the picker never came
  back, that a prompt is behind another window. It is advisory and cancels nothing: there is
  no honest timeout for how long someone should take to choose a window.
- **The resize is given up on rather than escaped**, after 4 seconds. `applyConstraints` on a
  display track is answered by the capturer, and a window capturer producing no frames —
  minimised, occluded, on another desktop — has nothing to answer with. The recording then
  proceeds at the source's own size, which the panel reports truthfully. This wait sat between
  the picker and every other step with no deadline, so a window that would not resize stopped
  the take there with the panel still saying it was waiting for the picker.

The screen picker is also asked for **before** anything else is awaited, because
`getDisplayMedia` needs the click to still be warm — the engine choice is normally already
made, on page load, which is also what lets the panel say how it will record before you press
anything. It is only worked out at Record time if you get there first.

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

### Expanded player

Double-click the picture, or press **⛶** in the transport, to fill the window with the
player. **Esc** or **Exit** leaves. It is a viewport overlay rather than a re-parenting of
the canvas — the WebGL context and the running playback engine are the same ones, so
expanding costs nothing and loses no state.

The controls float over the picture and fade out, cursor included, after about two seconds
without pointer movement; any movement brings them straight back. What they offer is
deliberately less than the editing transport: a scrub bar over the whole project, a plain
`M:SS` clock instead of a frame-accurate timecode, volume, and the way out. Frame stepping,
timecode entry, frame capture and mask handles are editing controls and stay in the editing
layout.

### Transport

Play / pause, frame-step buttons, seek slider, and an **editable `MM:SS:FF` timecode** —
type a timecode and press Enter to jump. **Save frame** captures the composited preview
at the current playhead.

**Preview volume** is monitoring only. It sits next to **Save frame**, is remembered between
sessions, and never reaches an encoder — turning the speakers down while you work does not
turn the export down. Track volume and clip gain are the ones that are part of the project.

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
