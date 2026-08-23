# Capture & Effects Plan

Continuation of [`ux-plan.md`](./ux-plan.md), which covered phases 0–6 (viewport, layer
stack, unified A/V clips, history, snapping). Phases 0–5 are shipped; phase 6
(drag-drop placement, persistence) is still open and is **not** a blocker for anything here.

This plan adds capabilities the editor does not have at all today: **screen / camera / mic /
system-audio recording**, **video effects and shaders**, **fades and transitions**, and
**dynamic masked regions** (blur a moving licence plate).

> **Status (2026-08-15):** phases 7–15 are implemented and verified in Chrome.
> Phase 14 fixes the two originally reported defects: recordings stream to disk instead of
> filling the heap (30 minutes of 1080p at a flat ~11 MB), and every recording carries a real
> duration and scrubs — a raw `MediaRecorder` file reports `Infinity` in Chrome and `N/A` in
> `ffprobe`, and rebuilding it fills both in, as VLC confirms. **Phase 15 removes the rebuild
> entirely**: recordings are now encoded through WebCodecs into a fragmented MP4 as they run,
> so the file is finished when you press Stop — and a tab killed mid-take leaves one that
> already plays. MediaRecorder remains the automatic fallback.
> Preview and export share one WebGL2 compositor, export encodes through WebCodecs at
> **6.6× realtime for 1080p** with flat memory, and clips now carry an ordered effect
> chain, draggable fades, keyframed parameters, moving masked regions, track and ranged
> grades, and cross-dissolve transitions — all rendering identically in preview and
> export. See the results sections at the end for what was
> found along the way, including two pre-existing preview/export mismatches this work
> exposed.

Every phase below ends with a **DOD** — a short list of checks that must pass before the
next phase starts. Phases are ordered so each one lands in a working editor.

---

## Decisions from the interview

Recorded so they are not relitigated mid-build.

| Question | Decision |
|---|---|
| Renderer | **WebGL2 for preview *and* export**, encoded with WebCodecs + Mediabunny. One shader chain, no preview/export drift. FFmpeg WASM stays as a fallback and powers the library batch tools |
| Recording | **Staged.** First MediaRecorder streaming to OPFS with a container-metadata repair; later the same UI backed by a WebCodecs encoder |
| `shir-effects.txt` presets | **Split by cost.** Cheap per-frame looks become live timeline effects; expensive temporal ones (reverse, `minterpolate`, `deshake`, time-lapse, GIF, compress) become "process asset → new asset" jobs in the Media Library |
| Dynamic masks | **Manual keyframes only.** No automatic tracker |
| Recorded sources | **Separate synced tracks** — screen on a video track, mic on A1, system audio on A2 |
| Effects depth | All four: clip **fade handles**, **cross-dissolve** transitions, **adjustment layers**, **keyframable parameters** |
| Order | **Renderer first** |

---

## Why the current architecture cannot do this

Not guesses — this is what the code does today.

| Area | Evidence | Consequence for this plan |
|---|---|---|
| Preview is Canvas2D | `canvas.getContext('2d')`, `drawImage` per clip (`src/preview/PlaybackEngine.ts:39,164`) | No shader stage exists. `ctx.filter` could fake three of the presets and nothing else. A GPU pass is unavoidable |
| Export is an FFmpeg filter graph | `buildFilterGraph.ts:65` builds `filter_complex` from clips | Any effect would need a second, hand-matched implementation. This is the drift the interview chose to eliminate |
| Export is single-threaded WASM | `@ffmpeg/core` 0.12.6, and `ffprobe` already aborts in it (`probeStreams.ts`) | Export is ~10× slower than realtime today. `minterpolate` or `deshake` on a 2-minute clip is minutes of blocking work — that can never sit behind a live slider |
| Recording is mic-only, all in RAM | `chunks: Blob[]` accumulates every `dataavailable` (`src/audio/microphoneRecorder.ts:28,56`) | **This is the reported data loss.** A 40-minute 1080p capture is multiple GB held in JS heap; the tab dies and the whole recording is gone |
| Nothing repairs the container | Blob is handed straight to the library (`microphoneRecorder.ts:71`) | **This is the reported "no clear length".** MediaRecorder writes live-profile WebM: unknown segment size, no `Duration`, no `Cues`/`SeekHead`. Players cannot scrub it and report no length until the whole file is parsed |
| Clips have no effect slot | `VideoClip` is `assetId / trims / gain / transform` (`src/types/editor.ts:56-67`) | Needs a new model layer, plus history and export support |
| Overlap is banned | `moveClipsTo` rejects overlapping moves (`editorStore.ts`) | Cross-dissolve *requires* overlap. The invariant has to be relaxed deliberately, not by accident |
| No time-varying anything | Every clip property is a scalar | Masks and animated parameters need a keyframe engine before they can exist |

---

## Phase 7 — WebGL2 compositor (parity only, no effects)

**Goal:** replace the Canvas2D draw loop with a WebGL2 renderer that produces the *same*
picture. No new features. This is the foundation everything else attaches to.

### Design

New `src/render/`:

```
GLCompositor.ts     owns gl context, FBO ping-pong pair, viewport sizing
TextureSource.ts    per-asset GL texture, uploaded from <video>/<img> each frame
ProgramCache.ts     compile/link once, keyed by shader source
shaders/
  quad.vert         shared vertex shader (unit quad + transform)
  blit.frag         plain texture copy — the parity shader
```

Per frame: clear to black → for each clip in `compositeOrderedClips` order, upload its
source to a texture, draw a quad with its placement (letterbox fit when `transform` is
undefined, crop+frame rect when set), blending onto the frame buffer. Text clips keep the
existing Canvas2D `textRenderer`, rendered into an offscreen 2D canvas and uploaded as a
texture — no need to reimplement text layout in GL.

`PlaybackEngine` keeps ownership of timing, seeking and audio; only `drawFrameContents`
and `drawVisual` are swapped for compositor calls. Everything else in that file stays.

The compositor renders to an offscreen framebuffer at project resolution and blits to the
visible canvas, so the export path (phase 8) can read exactly the same buffer.

### Risks

- Context loss (`webglcontextlost`) must be handled — rebuild textures and programs, and
  fall back to the Canvas2D path rather than showing a black preview.
- Uploading a `<video>` to a texture every frame is the hot path; use one texture per
  asset and `texSubImage2D` where the size is unchanged.

### DOD

- [ ] Preview renders through WebGL2 for video, image, text, letterboxed and PiP clips.
- [ ] Side-by-side capture of the old and new renderer on a fixture project (2 videos, 1
      image PiP, 1 text) differs by no more than antialiasing noise at 5 sample times.
- [ ] Playback holds 60 fps on the fixture with 3 concurrent video layers.
- [ ] Simulated context loss recovers or falls back without a black frame.
- [ ] `tsc -b` and `npm run build` clean; FFmpeg export output unchanged from today.

---

## Phase 8 — WebCodecs export path

**Goal:** export renders the *same* compositor offscreen and encodes with hardware
acceleration. FFmpeg stays as the fallback.

### Design

```
src/export/webcodecs/
  exportWebCodecs.ts    orchestration, progress, cancellation
  frameSource.ts        deterministic decoded frames per asset
  audioMixdown.ts       OfflineAudioContext render of the whole mix
  muxer.ts              Mediabunny MP4 output, streamed to OPFS
```

- **Video:** step `t` by `1/fps` over the project duration. For each step, pull the source
  frame for every active clip, render with `GLCompositor`, wrap the canvas as
  `new VideoFrame(canvas, { timestamp })`, feed `VideoEncoder` (`avc1.42001f`), mux.
- **Decoding** is the part to get right. `HTMLVideoElement.currentTime` seeking is not
  frame-accurate and is slow. Use Mediabunny's demuxer + `VideoDecoder` to iterate samples
  in order, holding a small lookahead per clip. Element-based decode stays as the fallback
  for anything WebCodecs cannot decode.
- **Audio:** render the existing mix graph through `OfflineAudioContext` at 48 kHz, slice
  into `AudioData`, encode `mp4a.40.2`, mux alongside.
- **Backpressure:** watch `encoder.encodeQueueSize`; stall the render loop above ~8 frames
  so memory cannot run away on long projects.
- **Selection:** probe `VideoEncoder.isConfigSupported` at export time. Unsupported →
  automatically use the FFmpeg path, and say so in the UI rather than failing.

### DOD

- [ ] Export produces a playable MP4 with correct duration, seekable in VLC and in a
      `<video>` element, with H.264 video and AAC audio.
- [ ] Output of the fixture project matches the FFmpeg export within tolerance: frame
      hashes at 0.5 s intervals visually equivalent, audio RMS profile within 0.5 dB.
- [ ] A 2-minute 1080p fixture exports **faster than realtime**, versus the current path.
- [ ] Cancelling mid-export releases the encoder and leaves no OPFS garbage.
- [ ] Forcing `isConfigSupported` to fail transparently falls back to FFmpeg.
- [ ] Peak tab memory during a 10-minute export stays flat, not linear in duration.

---

## Phase 9 — Effect stack, shader library, fade handles

**Goal:** any clip carries an ordered list of effects with live preview, and fades are
draggable on the clip itself.

### Model

```ts
export interface EffectInstance {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number>;
}

export interface BaseClip {
  /* …existing… */
  effects: EffectInstance[];
  /** Seconds. 0 = no fade. Video fades to black, audio fades to silence. */
  fadeIn: number;
  fadeOut: number;
}
```

Effects render as a ping-pong chain between two FBOs before the clip is composited, so
effect order is the list order and is visible in the Inspector.

### Shader library (ported from `shir-effects.txt`)

| Effect | Source preset | Params |
|---|---|---|
| Brightness / Contrast / Saturation | `eq`, `enhance` | 3 sliders |
| Cinematic grade | `cinematic-grade-letterbox` | contrast, saturation, warmth |
| Black & white | `hue=s=0` | mix |
| Sharpen | `unsharp` | amount, radius |
| Denoise | `hqdn3d` | strength (spatial approximation) |
| Pixelate | double `scale=…:flags=neighbor` | block size |
| Edge detect / sketch | `edgedetect,negate` | low, high |
| Gaussian blur | `boxblur` | radius |
| Flip H / V | `hflip` | — |
| Colour balance | `colorbalance` | r/g/b shift |
| Fade (implicit) | `fade` + `afade` | from the clip's fade handles |

Each is one fragment shader plus a params descriptor that drives the Inspector UI
automatically — adding an effect should mean adding a `.frag` and a descriptor, nothing else.

`denoise` is called out honestly: `hqdn3d` is spatio-*temporal*; the shader is a spatial
approximation only. It is labelled as such in the UI.

### FFmpeg fallback

Each descriptor also carries an optional FFmpeg filter string, used only by the fallback
export path. Effects with no FFmpeg equivalent warn on fallback export instead of
silently rendering nothing.

### UI

- Inspector gains an **Effects** section: add, reorder by drag, toggle, remove, reset.
- Clips with effects show an `fx` badge on the timeline block.
- Fade handles are draggable triangles in the clip's top corners; dragging shows the
  duration in frames. One undo step per drag, via the existing `beginInteraction`.

### DOD

- [x] Adding, reordering, toggling and removing effects updates the preview immediately
      and is undoable as one step each.
- [x] All eleven effects above render in preview and in the WebCodecs export identically.
- [x] Fade handles produce a visible fade to/from black and an audible audio fade in both
      preview and export.
- [x] An effect with no FFmpeg mapping produces a visible warning on fallback export.
- [x] Ten stacked effects on one clip still play back at 60 fps.

---

## Phase 10 — Keyframe engine

**Goal:** any numeric effect parameter, and clip transform, can vary over time.

### Model

```ts
export type Interp = 'linear' | 'hold' | 'smooth';
export interface Keyframe { t: number; value: number; interp: Interp }

// EffectInstance gains:
keyframes?: Record<string, Keyframe[]>;   // paramName -> sorted keys
```

`t` is **clip-relative seconds**, so trimming or moving a clip carries its animation with
it. A parameter with keyframes ignores its scalar; evaluation is a binary search plus
interpolation, memoised per frame.

### UI

- A stopwatch toggle next to each slider arms keyframing for that parameter.
- With a parameter armed, changing its value at the playhead writes a key.
- Selecting a clip with animated parameters expands a **keyframe strip** under the clip on
  the timeline: one row per animated parameter, diamonds at each key, draggable in time,
  right-click to change interpolation or delete.
- `[` / `]` jump the playhead to the previous / next key.

All keyframe edits go through `commit()` so history and coalescing already work.

### DOD

- [x] Animating blur radius from 0 to 20 across a clip previews as a ramp and exports the
      same ramp.
- [x] Keys survive moving, trimming and splitting the clip (splitting divides the key set
      at the cut and rebases `t`).
- [x] Dragging a key on the strip is one undo step and snaps to frames.
- [x] `hold` interpolation produces a hard step; `smooth` produces no overshoot past the
      key values.

---

## Phase 11 — Dynamic masked regions

**Goal:** the licence-plate case. Apply an effect to a moving, keyframed region only.

### Model

```ts
export interface MaskRegion {
  shape: 'rect' | 'ellipse';
  /** Feather in fraction of the shorter canvas edge. 0 = hard edge. */
  feather: number;
  invert: boolean;
  /** Sorted by t, clip-relative. Position AND size are interpolated. */
  keys: { t: number; rect: NormalizedRect; interp: Interp }[];
}

// EffectInstance gains:
region?: MaskRegion;   // undefined = whole frame
```

Rendering is a single extra uniform block: the effect shader runs over the full frame into
a scratch FBO, then a compositing pass mixes source and result by the mask's coverage
value. Feather is a `smoothstep` on the signed distance to the region edge. Because this
happens on the GPU, a moving mask costs the same as a static one — this is the payoff for
choosing the WebGL path.

### UI

- Effects that support a region get a **Region** control: `Whole frame` / `Rect` / `Ellipse`.
- With a region active, the preview canvas shows a draggable, resizable, rotatable-later
  overlay handle set, reusing the interaction model already in `MediaOverlayEditor`.
- Moving the region at a new playhead position writes a keyframe automatically — the
  workflow is *scrub, drag, scrub, drag*, which is what the car case needs.
- The region's keys appear on the same keyframe strip from phase 10.
- Presets: **Blur region**, **Pixelate region**, **Black box** — one click each, since
  those are the actual jobs.

### FFmpeg fallback

A moving region is expressible as `crop` with `eval=frame` plus time expressions on
`overlay` x/y, but **only at constant size**. The fallback therefore supports position
animation at fixed size and warns when the region's size is animated. The WebCodecs path
has no such limit.

### DOD

- [x] A rect mask keyframed at t=0, 1.5 s and 3 s blurs a moving region and interpolates
      between the keys, in preview and export.
- [x] Feather produces a soft edge with no visible banding; `invert` blurs everything
      *except* the region.
- [x] Region handles drag and resize on the preview canvas and write keys automatically.
- [x] A 3-minute clip with an animated mask exports without a framerate drop versus the
      same clip without one.
- [x] Fallback export warns when it cannot reproduce an animated-size region.

---

## Phase 12 — Adjustment layers

**Goal:** one grade over the whole edit instead of per clip.

### Design

`Track` gains `effects: EffectInstance[]`. A video track's effects apply to the composited
result of everything **below** it — which is free in the WebGL model, since compositing is
already bottom-up into one framebuffer: run the track's chain over the accumulated buffer
before compositing the next track up.

Adds an `AdjustmentClip` kind so an adjustment can also cover a *time range* rather than
the whole timeline, rendered as a distinct striped block. Track-level effects are the
"always on" case; adjustment clips are the ranged case.

### DOD

- [x] An adjustment on V2 visibly grades clips on V1 and not clips on V3.
- [x] An adjustment clip affects only its own time range.
- [x] Track effects appear in preview and export identically.
- [x] Hiding the track disables its adjustment.

---

## Phase 13 — Cross-dissolve transitions

**Goal:** overlap two clips on a track to blend between them.

### Design

This is the one phase that relaxes an existing invariant, so it is deliberately last among
the effect phases.

```ts
export interface Transition {
  id: string;
  trackId: string;
  fromClipId: string;
  toClipId: string;
  duration: number;
  type: 'dissolve' | 'dipToBlack' | 'wipeL' | 'wipeR';
}
```

- `moveClipsTo` stops rejecting overlap **when** the overlap is between two adjacent clips
  on the same track and is smaller than both; that creates or resizes a `Transition`.
  Every other overlap is still refused, exactly as today.
- The renderer composites both clips during the overlap window and mixes by progress.
  `PlaybackEngine` must therefore prime and play two video elements per track at once —
  supported already, since elements are cached per asset, but it needs an explicit test
  when both sides are the *same* asset (that case needs a second element).
- Audio cross-fades over the same window.
- UI: a transition renders as a hatched bowtie between the two clips; drag its edge to
  change duration; a dropdown picks the type. Dragging a clip apart deletes the transition.

### FFmpeg fallback

`xfade` + `acrossfade` cover `dissolve` and the wipes. Cases the fallback cannot express
warn rather than silently cutting.

### DOD

- [x] Dragging clip B onto the tail of clip A creates a dissolve, and only that overlap is
      permitted — all other overlaps still refuse.
- [x] Preview shows a real blend, not a cut, and audio cross-fades over the same window.
- [x] Two clips from the *same* asset dissolve correctly.
- [x] Export matches the preview.
- [x] Undo restores both the clip position and the transition in one step.
- [x] Splitting or deleting either clip removes the transition cleanly.

---

## Phase 14 — Recording v1: screen, mic, system audio

**Goal:** long recordings stop breaking and stop being unseekable. This is the phase that
fixes the two reported defects directly.

### Capture

```
src/capture/
  CaptureSession.ts    orchestrates the sources, one shared time anchor
  ChunkSink.ts         OPFS streaming writer (worker + createSyncAccessHandle)
  containerFix.ts      inject Duration + SeekHead + Cues into the finished WebM
  recovery.ts          find and offer orphaned recordings on startup
```

- Screen (+ system audio when the platform gives it) via
  `getDisplayMedia({ video: true, audio: true })`; microphone via a separate
  `getUserMedia`. Two recorders, started from one `performance.now()` anchor, with the
  measured start offset stored per source so they can be aligned exactly on import.
- **System audio is not universally available** and must be reported honestly, not
  silently recorded as silence: tab audio works broadly in Chrome; whole-screen/window
  system audio needs Windows/ChromeOS, or macOS 14.2+ with Chrome 141+; Firefox and Safari
  ignore the audio constraint entirely. Detect by inspecting
  `stream.getAudioTracks().length` after the picker returns and tell the user what they
  actually got.

### Fix 1 — the recording no longer lives in RAM

Every `dataavailable` chunk is written straight to an OPFS file handle and dropped. Heap
stays flat regardless of duration. Because bytes are already on disk, a tab crash leaves a
**recoverable partial file** instead of nothing — `recovery.ts` offers it on next launch.

A rolling segment boundary (default 5 minutes) caps the blast radius of any single failure
and keeps each file within comfortable repair size.

### Fix 2 — the file gets a real duration and is seekable

MediaRecorder writes live-profile WebM: unknown segment size, no `Duration`, no `Cues` or
`SeekHead`. That is precisely why players show no length and refuse to scrub. On stop, the
file is rewritten with those elements injected — the approach proven by `ts-ebml` and its
large-file descendants (`fix-webm-meta`, `webm-duration-fix`), both of which handle files
over 2 GB with bounded memory. Chrome's MP4 output has the same problem in a different
shape — it is fragmented MP4 with no top-level index — and gets the same treatment.

Belt and braces: the true duration is also measured from the time anchor and stored on the
`MediaAsset`, so the editor never depends on the container being honest.

### Placement

One session produces up to three assets. On stop they are added to the library **and**
placed at the playhead: screen on the first free video track, mic on A1, system audio on
A2, each offset by its measured start delta so they are frame-aligned.

### UI

A **Record** panel replacing today's single mic button: source toggles (screen / mic /
system), a live level meter per audio source, elapsed time, estimated size, and a visible
"writing to disk" indicator. Recording works during playback, as mic recording does today.

### DOD

- [x] A 30-minute 1080p screen recording completes with tab memory flat throughout
      (measured at start, middle and end), and the file plays. *Capture and memory verified
      at 30 minutes / 294 MB (heap 11.2 → 10.7 MB). The repair-and-play leg is verified at
      15 minutes / 145 MB, because repairing needs the raw file and its rebuilt copy at once
      and this machine has 3.7 GB of free disk — see "What the 30-minute run actually found".*
- [x] The resulting file reports its correct duration and scrubs freely in VLC, in Chrome,
      and in a bare `<video>` element.
- [x] Killing the tab mid-recording leaves a file that is offered on next launch and plays
      up to the kill point.
- [x] Screen, mic and system audio land on three separate tracks, aligned within one frame
      — verified by recording a clap and comparing waveform positions.
- [x] On a platform without system audio, the UI says so explicitly before recording starts.
- [x] Recording while the timeline plays does not drop frames from the capture.

---

## Phase 15 — Recording v2: WebCodecs engine

**Goal:** same UI, correct files by construction, no repair step.

Replace the MediaRecorder engine behind `CaptureSession` with
`MediaStreamTrackProcessor` → `VideoEncoder` / `AudioEncoder` → Mediabunny muxer → OPFS,
reusing the encoder and muxer work from phase 8. MediaRecorder stays as the fallback for
browsers without the pipeline.

### DOD

- [x] Recording produces a seekable MP4 with a correct duration **without** any repair pass.
- [x] Every phase-14 DOD item still passes with the new engine.
- [x] Dropped-frame count is reported and stays near zero for a 1080p60 screen capture.
- [x] Engine choice is visible in the UI and falls back automatically.

---

## Phase 16 — Library batch tools

**Goal:** the expensive presets from `shir-effects.txt`, as one-shot jobs producing new
library assets.

`src/tools/presets.ts` holds the command lines essentially verbatim — this is the one place
where the source file maps one-to-one:

| Group | Presets |
|---|---|
| Reframe | force 9:16, force 16:9, resize 720p / 1080p / 2K / 4K |
| Time | reverse, time-lapse, 60 fps, 120 fps (`minterpolate`) |
| Restore | stabilize (`deshake`), deflicker, denoise, enhance |
| Deliver | compress (x264 slow), web/SaaS compress, to GIF, strip audio |
| Fun | psychedelic echo, floating camera pan, vertical squeeze |

UI: right-click a library asset → **Process…** → pick a preset → progress bar → the result
is added as a **new** asset (never in place), named `<original> (reversed)` etc., with the
preset recorded on the asset so it is visible later.

Honest warnings on cost: `minterpolate` and `deshake` are slow in single-threaded WASM, and
the estimate is shown before the job starts. Jobs run one at a time with a cancel button.

### DOD

- [ ] Each preset produces a playable output added as a new library asset, with the source
      left untouched.
- [ ] Progress is reported and cancellation actually stops the job.
- [ ] A preset expected to be slow warns with an estimate before starting.
- [ ] Failures surface the FFmpeg error rather than failing silently.

---

## Phase 17 — Recording v3: camera

**Goal:** the camera as a fourth capture source, on its own track, framed as
picture-in-picture by default.

The encoding is nearly free: phase 15's `SourceEngine` seam takes any video track, so a
camera stream goes through the same `MediaStreamTrackProcessor` → `VideoEncoder` → muxer
path the screen already uses, and the MediaRecorder fallback takes it unchanged. What is
actually new is device choice, honesty about the format the camera negotiated, a **second
simultaneous encoder**, a source that can **end mid-take**, and placement that composites
rather than sits beside.

This extends the interview's "recorded sources → separate synced tracks" decision to a
fourth source; it does not revisit it.

### Acquisition

- `getUserMedia({ video: { deviceId, width, height, frameRate } })` — **video only**. The
  camera's built-in microphone is not recorded through this source; the mic stays its own
  `getUserMedia` and its own A1 track. Otherwise ticking both camera and mic would capture
  the same voice twice and put a duplicate on the timeline.
- `enumerateDevices()` returns blank labels until a camera permission has been granted
  once, so the picker is populated after the first grant and the chosen `deviceId` is
  remembered. Re-enumerate on `devicechange` — cameras get unplugged and virtual ones
  appear when other apps start.
- **Cameras negotiate, they do not obey.** A request for 1920×1080@60 can come back as
  1280×720@30, or as an MJPEG mode that costs a core to decode. So constrain from
  `getCapabilities()` where it exists, and after the track opens read `getSettings()` and
  display what was actually granted. Same rule as system audio in phase 14: report what
  the platform gave, never what was asked for.
- `NotReadableError` / `TrackStartError` — the camera is held by Zoom, Teams or Photo Booth
  — is the single most common failure and gets its own message naming the cause, not a
  generic "recording failed".

### Frame rate: 60 where the hardware allows

**Both video sources target 60 fps**, camera and screen alike, and degrade rather than fail.

- `frameRate: { ideal: 60 }` — **not** `min` or `exact`, which make `getUserMedia` throw
  `OverconstrainedError` on a 30 fps camera instead of quietly giving 30. 60 is a
  preference, and the readout below is what makes a downgrade visible.
- **60 usually costs resolution.** A typical USB camera offers 1280×720@60 or
  1920×1080@30 and not both — MJPEG buys the frame rate, and the higher mode gives it back.
  Where that trade appears, take the frame rate: an inset a quarter of the frame wide has
  no use for 1080 lines, and smooth motion is what a talking head actually shows. That is
  the same 720p default the encoder budget below wants anyway, now justified twice.
- **`getSettings()` can claim 60 while the camera delivers 30.** In dim light the driver
  lengthens exposure and halves the rate on its own, without renegotiating the track. So
  the panel shows the *delivered* rate, counted from phase 15's per-source frame tally over
  a rolling window, next to the negotiated one. A camera saying `60 fps · 31 delivered` is
  telling the user to turn a light on, which no amount of constraint code can do for them.
- Bitrate follows: 720p60 gets ~4 Mbps rather than the 2.5 Mbps a 30 fps inset would need.
- **The screen source is on 30 today** — `sources.ts` hardcodes `{ frameRate: 30 }` — and
  moves to `{ ideal: 60 }` with this phase. The engine is already proven there: phase 15's
  1080p60 capture ran at 59.9 fps with zero drops. The cost is bytes, and it is not small —
  that phase's 30-minute run wrote 100 MB at 30 fps, and doubling the frame rate lands
  nearer 160–180 MB for the same half hour. The record panel's size estimate has to reflect
  the rate actually in use, not a fixed number.

### The project is 30 fps, and that would throw half of this away

`editorStore` ships `settings: { fps: 30 }`, and `quantizeToFrame` snaps every clip edit and
every export frame to it. Capturing 60 and rendering 30 means half the captured frames are
discarded at export — the recording would be smoother than anything the editor could
produce from it.

So the frame rate has to reach the project, not just the file:

- When a recording lands at 60 and the timeline is **empty and still on the default 30**,
  the project moves to 60 with the change stated in the panel.
- When the timeline **already has content**, the project setting is left alone and the
  mismatch is surfaced instead — changing the frame rate under existing clips re-quantizes
  their edges, which is a destructive edit nobody asked for. The clip still holds all 60 fps
  of source; it renders at the project rate until the user decides otherwise.
- Project fps becomes settable in the UI — owned by **phase 19**, which this phase depends on
  rather than duplicating.

### Two video encoders in one session

Screen + camera means two H.264 encodes running at once, which is the first time this
pipeline has been asked for that.

- The camera targets 1280×720@60 rather than matching the screen's resolution. Against a
  1080p60 screen that is a quarter of the pixel rate, which is what makes a second
  simultaneous encode affordable at all.
- 1080p60 screen **and** 720p60 camera is roughly 2.5× the encoding load phase 15 measured,
  and it is the case most likely to drop frames. If it does not hold on this hardware, the
  camera gives up frame rate before the screen does — the screen is the content, the inset
  is the face — and the panel says which one was reduced.
- Phase 15's drop accounting is already per source, so a camera falling behind shows up
  separately in the panel instead of being averaged away against the screen.
- Each source writes its own OPFS file, so there is no new write contention beyond raw
  disk bandwidth.

### A source can end mid-take

New, and currently unhandled: nothing listens to `track.onended` today, so unplugging a
webcam — or pressing Chrome's "Stop sharing" bar — leaves a session that still looks alive
and yields a truncated file with no explanation. Phase 17 adds: on `ended`, finalize that
one source, record the reason and the stop time in its sidecar, keep the other sources
recording, and say so in the panel. If it was the last live source, stop the session.

### Placement and framing

- The camera lands on the video track **above** the screen (`SOURCE_LANE` gains
  `camera: 1`) so it composites over it.
- It arrives with a default picture-in-picture transform — bottom-right, 25% width, 24px
  margin — expressed with the existing overlay transform from phase 7, optionally with a
  circular mask from phase 11. No new rendering code; this is preset data on the clip and
  is fully editable afterwards.
- Camera **without** screen skips the PiP transform and lands full-frame on the first free
  video track.
- **Mirroring is a one-way door.** The record-panel preview is mirrored, because that is
  what people expect of their own face. The recording is **not** — a mirror baked in at
  encode time can never be removed. If a mirrored result is wanted it is a horizontal-flip
  effect on the clip, added and removed at will.

### Alignment

A camera takes 200–800ms to deliver its first frame while exposure and focus settle — far
longer than a screen or a microphone. Phase 15's clock measures each source's media start
against the earliest source, so the offset comes out right by construction; the change is
that it is now large enough to see, which is precisely why it is worth asserting rather
than assuming.

### UI

A fourth toggle beside screen / mic / system, a device dropdown next to it, a small live
preview so framing and lighting are checked before the take instead of after, and the
negotiated format next to the engine line with the delivered rate beside it
(`1280×720 · 60 fps · 59 delivered`). Project frame rate is edited in the phase 19 settings
dialog, and this panel only reports the mismatch.

### DOD

- [ ] A screen + camera + mic recording produces three files on three tracks, aligned
      within one frame — the phase-14 clap test extended to four sources.
- [ ] The camera clip is placed above the screen clip with a PiP transform, and composites
      identically in preview and export.
- [ ] The panel shows the format the camera actually granted; a downgraded 60 fps request
      is visibly different from what was asked for.
- [ ] Both video sources record at 60 fps where the hardware allows, and a camera that only
      offers 30 records at 30 rather than failing to open.
- [ ] The delivered frame rate is shown alongside the negotiated one, and the two visibly
      diverge when the camera is starved of light.
- [ ] 1080p60 screen + 720p60 camera for 10 minutes: both sources under 1% dropped frames,
      neither writer behind, heap inside the phase-15 band. If the load does not hold, the
      camera is what degrades and the panel says so.
- [ ] A 60 fps recording dropped onto an empty default project leaves the project at 60 fps,
      and one dropped onto a project with existing clips does not change it.
- [ ] Unplugging the camera mid-recording finalizes that source into a playable file with a
      stated reason, while the screen and mic recordings continue and end normally.
- [ ] A camera held by another application produces an error naming that cause, and the
      remaining sources still record.
- [ ] The recorded file is not mirrored; the record-panel preview is.

---

## Phase 18 — Timeline minimap

**Goal:** navigation that does not depend on the current zoom, replacing the transport
scrub slider with something that earns its space.

### Why the slider goes

`.transport-scrub` is an `<input type="range">` sitting in the transport bar, and it does
nothing dragging the ruler does not do better:

- It duplicates ruler-scrubbing at lower precision.
- It knows nothing about the timeline viewport, so at high zoom — the one situation where
  a second seek control would help — it cannot show where you are.
- Focused, it eats the arrow keys that are bound to frame-stepping.
- It shows nothing about the project. A thirty-minute recording and an empty project look
  identical.

The one thing it *could* have done is seek across the whole project independently of zoom.
Zoomed to frame level in a thirty-minute take, the lanes show two seconds, and reaching the
middle means zooming out, scrolling, and zooming back in. That capability is worth having.
A slider is the wrong control for it.

### What replaces it — and what else it absorbs

A minimap strip spanning the whole timeline: clips drawn at low fidelity, the current
viewport drawn as a window over them, the playhead as a line.

It also **replaces `HorizontalScrollbar`**. A viewport window on a minimap is a scrollbar
that happens to show its contents, and keeping both would put two controls for one job on
top of each other. So the strip spans the same range the scrollbar does today — the drawn
span, content plus tail, not just the content — and shades the beyond-content region the
same way the lanes do, so the two readings of "past the end" agree.

Net: two controls removed, one added.

| Input | Action |
|---|---|
| Click | Seek there |
| Drag | Scrub continuously |
| Drag the viewport window | Pan the timeline |
| Wheel | Zoom, as over the lanes |
| Double-click the window | Fit project to viewport |

### Drawing it

Canvas, not DOM: one rectangle per clip, drawn on change rather than per frame. Two rows —
video above, audio below — collapsed across tracks, because this is for recognizing the
shape of the project, not for editing it.

Two things follow from the performance rule the timeline already lives by (playhead state
must not flow through React at RAF rate): the playhead marker rides a transient store
subscription and a direct transform write, exactly like `PlayheadLine`; and the clip
rectangles are redrawn only when clips, tracks, or the span actually change.

Clips narrower than a pixel merge into their neighbour rather than being dropped, so a
project full of short cuts still reads as occupied rather than as gaps.

### DOD

- [ ] `.transport-scrub` and `HorizontalScrollbar` are both gone, replaced by the one strip.
- [ ] Zoomed to sub-frame in a thirty-minute project, one click near the far end of the
      minimap seeks there, and the viewport window lands with it.
- [ ] Dragging the window pans the lanes, and panning the lanes moves the window. The two
      never disagree, whichever one was touched.
- [ ] The playhead animates on the minimap during playback without re-rendering the clip
      components — checked the same way the playhead line was.
- [ ] Clips appear at their real positions, and the region past the last clip is shaded to
      match the lanes.
- [ ] Frame-step keys still work immediately after clicking the minimap. The slider used to
      swallow them.
- [ ] A 500-clip project redraws within one frame, with sub-pixel clips merged rather than
      dropped.

---

## Phase 19 — Project settings

**Goal:** the composition stops being permanently 16:9 at 30 fps.

`ProjectSettings` is two fields today — a `ResolutionPreset` union of four 16:9 sizes, and
`fps`, which is read in a dozen places and has **no setter at all**: `setResolution` exists,
`setFps` does not. So a vertical project cannot be expressed and 60 fps cannot be reached.
Phase 17 needs the second of those anyway; a phone-shaped project needs the first.

### Model

- `ProjectSettings` becomes `{ width, height, fps }` — pixels, not a preset name. Presets
  stay, but as a UI list that writes numbers: 16:9 (854×480, 1280×720, 1920×1080, 3840×2160),
  9:16 (720×1280, 1080×1920), 1:1 (1080×1080), 4:5 (1080×1350), and Custom.
- `ResolutionPreset` survives only as a migration read, so projects saved with
  `resolution: '1080p'` still open.
- Frame rate: 24, 25, 30, 50, 60, or a custom integer.
- Custom sizes are forced to even numbers — H.264 will not encode an odd dimension — and
  checked against `VideoEncoder.isConfigSupported` before they are accepted, so an
  unsupported size is refused in the dialog rather than at the end of an export.

### What already survives an aspect change, and what does not

Worth stating because it makes the refit far smaller than it sounds: `transform` is
**optional**, and undefined means full-frame fit. Those clips reframe themselves for free
when the canvas changes shape — no refit, no data touched. Only explicit geometry needs
rewriting:

| Data | Where | Note |
|---|---|---|
| `transform.frame` | video, image clips | PiP insets and manual placements |
| `textFrame` | text clips | |
| `region.x/y/w/h` | masked effects | stored as ordinary animatable params, so **every keyframe** of each channel too |

The mask case is the one that actually bites. The mask pass runs over a canvas-sized layer,
so a region is canvas-relative: change the aspect and the blur box slides off the licence
plate it was covering. Refitting the scalars without refitting the keyframes would fix the
first frame of an animated mask and break the rest, which is worse than not refitting at all.

### The refit

- Fires on **aspect** change only. 1080p → 4K is pure scale, and normalized rects are
  already resolution-independent, so nothing moves.
- Anchor-preserving: each rect is converted to pixels under the old size, re-anchored by its
  nearest edges (a bottom-right PiP keeps the same pixel margin from the same corner), fitted
  on the smaller axis so its own aspect is preserved, then renormalized against the new size.
- Keyframed channels are refit key by key, `interp` untouched.
- The settings change and the whole refit are **one history entry** — a single undo puts back
  both the canvas and every rect it moved. The result is ordinary transform data, so it stays
  hand-editable afterwards.

### Changing frame rate under existing clips

`quantizeToFrame` runs on every edit, so moving 30 → 60 leaves existing clip edges off the
new frame grid. Re-quantizing is the honest fix; doing it silently is not.

- Empty timeline: change outright.
- Content present: change, re-quantize every clip edge and every keyframe `t` in the same undo
  entry, and say in the dialog how many clips moved — the largest possible move is under one
  frame, and saying so is what makes the operation acceptable rather than alarming.

### UI

A Settings dialog from the toolbar, replacing the bare Resolution select: preset list, custom
W×H, an orientation swap button (the fastest route to vertical is swapping the two numbers),
and frame rate. Phase 17's camera panel reads the frame rate from here rather than proposing
its own.

### DOD

- [ ] A project set to 1080×1920 renders that size in preview, in the WebCodecs export and in
      the FFmpeg fallback.
- [x] Switching 1920×1080 → 1080×1920 leaves untransformed clips full-frame and correct, and
      re-anchors a bottom-right PiP to the same pixel margin from the same corner.
- [x] A keyframed blur region still covers its subject after the switch, checked at both ends
      of its animation, not only the first key.
- [ ] The aspect change and its refit undo as one step.
- [ ] fps can be set to 60; a 60 fps project exports 60 fps, and frame-step keys and the
      timecode readout agree with it.
- [ ] Changing fps with content present re-quantizes clips and keyframes in one undo step and
      reports what moved.
- [ ] A custom size is forced even, and one the encoder refuses is rejected in the dialog with
      a message naming the limit.
- [x] A project saved with `resolution: '1080p'` still loads.

---

## Phase 20 — Export settings

**Goal:** a quality choice, and an export that need not be the same shape as the project.

Not to be re-solved: `fastStart: 'reserve'` already writes the moov atom at the front of every
WebCodecs export *without* buffering the file, so exports already start playing before they
finish downloading and the heap still stays flat. The metadata-for-the-web problem is done.

Hardcoded today: `QUALITY_HIGH`, `keyFrameInterval: 2`, AAC at 192 kbps, and an output that is
always the project's size and rate.

### Presets

| Preset | Video | Keyframe interval | Audio | For |
|---|---|---|---|---|
| **Master** | high | 1 s | 256 kbps | archival, re-editing, hand-off |
| **Web** (default) | medium | 2 s | 192 kbps | upload, embedding — today's behaviour |
| **Small** | low | 4 s | 128 kbps | messaging, previews, review copies |

Video rates are computed from pixel rate (width × height × fps) rather than fixed, so a preset
means the same thing at 720p and at 4K.

### Advanced panel

Behind a disclosure, defaulting closed: video bitrate, keyframe interval, audio bitrate and
channel count, and an **output size / frame-rate override** — the 1080p web copy of a 4K
project, from the same timeline, without touching project settings.

The override may change scale freely. It may **not** change aspect: that would need the phase
19 refit, which is a project-level edit with an undo entry, not an export-time side effect. An
aspect-changing override is refused with a message pointing at project settings.

Frame-rate override downward is a resample of the render loop, not a re-quantize — clips keep
their edges, the exporter just samples fewer instants.

### Metadata actually still missing

Not faststart: colour signalling (`colr` — without it some players guess the transfer function
and the export looks washed out or crushed) and file-level tags (title, creation time). Added
where mediabunny exposes them, and named as a gap where it does not.

### DOD

- [ ] The three presets produce measurably different file sizes from one fixture, and all three
      play in Chrome, Safari and VLC.
- [ ] The moov atom is still at the front for every preset — verified by byte offset, not by
      assuming the flag did its job.
- [ ] Advanced values persist with the project and appear in the export log, so a file can be
      explained after the fact.
- [ ] A 4K project exported with a 1080p override produces a 1080p file with identical framing.
- [x] An aspect-changing override is refused, naming project settings as the place to do it.
- [ ] The FFmpeg fallback honours the same bitrate and keyframe choices, or warns precisely
      where it cannot.

---

## Phase 21 — Custom shaders

**Goal:** a user-supplied fragment shader as a first-class effect, with parameters.

Scoped against four real shaders (`shaders_example`) rather than against the idea of one.
What they need turns out to be narrower than "arbitrary Shadertoy" in the expensive
direction and wider in a cheap one.

### The four, and what each one costs us

| Shader | What it is | Needs |
|---|---|---|
| `XtK3W3` — VHS/analog glitch | single pass, `iChannel0` + `iTime` | **Nothing new beyond the prelude.** This is exactly the shape the chain already runs |
| `MllSzj` — ordered dither | single pass, but **two channels**: a tiled 8×8 threshold texture *and* the video | A second texture channel, with **`REPEAT` wrap and `NEAREST` filter** |
| `tsfXWj` — NTSC/PAL simulation | **three stages** — copy → downsample to YIQ → bicubic recombine | Named feed-forward buffers; later stages sampling earlier ones |
| `tsdXDB` — extruded video | single pass, but a **raymarcher**: 64 march steps, each calling `map()` (≈20 texture fetches), plus 24 shadow steps, AO, and 6 `map()` calls per normal | Nothing structural — but a cost budget, and a way to survive it |

The decisive fact: **none of the four samples its own previous frame.** Every one is a pure
function of the current input and the current time. So the tier that breaks scrubbing —
feedback buffers, where t=10 has no meaning unless you played from t=0 — is not needed and is
explicitly out of scope. Everything below stays deterministic: the same timeline instant
produces the same pixels in preview and in export, which is the property the whole renderer is
built on.

### Tier A — single pass (`XtK3W3`, `tsdXDB`)

- One new effect type carrying its GLSL source, with the program cache keyed by a **hash of
  the source** rather than by effect type: every instance can be a different shader.
- A compatibility prelude supplying `iResolution`, `iTime`, `iTimeDelta`, `iFrame`, `iChannel0`
  and `iDate`, and wrapping `mainImage(out vec4, in vec2)` — so a shader pastes in unedited.
  `iFrame` is not optional: `tsdXDB` writes `for(int i = min(iFrame, 0); ...)` to stop the
  compiler unrolling its march loops.
- `iTime` comes from the **timeline** clock, clip-relative. Wall-clock would make the first
  exported frame differ from the previewed one.
- Layers are **premultiplied**; Shadertoy's are not. The prelude unpremultiplies on the way in
  and re-premultiplies on the way out, or every custom shader haloes on text and soft edges.

### Tier B — extra channels (`MllSzj`)

`MllSzj` is `step(threshold_texture, video)`, and it samples the threshold at `i/8.` — it
relies on the texture **tiling**. Every texture in the compositor is created `CLAMP_TO_EDGE`
with `LINEAR` filtering, so pasted unchanged it would sample one stretched texel and produce a
flat result rather than a dither. Wrap and filter therefore become per-channel settings, the
same knobs Shadertoy exposes.

Channels are filled from: generated patterns (Bayer 8×8, blue noise, white noise — the common
case, and no asset management), or an image from the media library.

### Tier C — feed-forward stages (`tsfXWj`)

`tsfXWj` is three `mainImage` functions in one file: Buffer A copies the video, Buffer B
downsamples it to a bandwidth-limited YIQ, and the Image stage recombines with a bicubic
upsample. That is genuinely multi-pass, but strictly forward — no stage reads its own output.

The existing `passes` field runs *one* shader repeatedly over its own output, which is not this.
What is needed is named stages, compiled separately, each with its own persistent render target,
and later stages binding earlier ones as channels. The ping-pong machinery and the third layer
buffer already exist; this generalises them from two-plus-one fixed targets to a small named set.

`tsfXWj` also uses `iMouse` for its split-screen comparison. As an effect that becomes a
parameter — a wipe position slider — not a live cursor. It is the clearest argument for the
parameter system below.

### Tier D — feedback buffers

Out of scope, by evidence rather than by preference: none of the four needs it, and it is the
only tier that cannot be scrubbed or exported deterministically.

### Parameters

Shadertoy shaders hardcode their constants, which makes a pasted shader a fixed picture.
`XtK3W3` alone has five worth exposing — noise speed, displacement, interference, scanline
pitch, chroma shift — all currently literals in the body.

An annotation convention in the source, `// @param strength 0 1 0.5`, generates Inspector
sliders through the same descriptor machinery every built-in effect uses, which makes them
**keyframable for free** via phase 10. This is why "define your own shader" and "change its
parameters" are one feature rather than two.

Two of the four also carry **compile-time** switches — `#define VIDEO_STANDARD PAL`,
`#define SUBDIVIDE`, `#define SPARKLES`, `#define GRAYSCALE`. These cannot be uniforms. They
become dropdowns and checkboxes that recompile on change, which the source-hash cache handles
by construction, and they are **not** keyframable. The UI has to say which kind a control is,
because a slider that recompiles mid-drag is a very different thing from one that does not.

### Cost, and the shader that proves it matters

`tsdXDB` raymarches: up to 64 steps per pixel, each step calling `map()` — which samples the
video roughly twenty times — plus 24 shadow steps, ambient occlusion, and six more `map()`
calls per normal. That is on the order of thousands of texture fetches per pixel. At 1080p it
will not hold 60 fps on most hardware, and at 4K export a single frame can exceed the GPU
watchdog and take the whole context down with it.

WebGL cannot interrupt a running shader, so the answer is budget and honesty, not rescue:

- A **render-scale** parameter per custom effect (½, ¼) — the effect renders small and upscales.
  For an effect this stylised the loss is invisible and the saving is quadratic.
- Per-effect GPU timing via `EXT_disjoint_timer_query_webgl2` where available, shown in the
  Inspector, so an expensive shader is visibly expensive before it is exported.
- Context loss during a custom pass **disables that effect** and says so, rather than retrying
  into the same crash.

### Failure, and the fallback

A shader that fails to compile shows its log in the Inspector and passes the picture through
untouched. It never blacks the frame and never kills the render loop. `ffmpeg: null` — there is
no filter equivalent — so the fallback export warns and names the clip, as phase 9 already does.

### DOD

- [ ] `XtK3W3` pastes in unedited and renders in preview and export identically.
- [ ] `MllSzj` produces a real dither — proof that per-channel `REPEAT`/`NEAREST` works, since
      the wrong wrap yields a flat picture rather than an error.
- [ ] `tsfXWj` runs its three stages and matches the Shadertoy original side by side, with the
      `iMouse` split replaced by a parameter.
- [ ] `tsdXDB` renders at full rate at ½ scale, and its measured cost is visible in the
      Inspector before anyone exports with it.
- [ ] `@param` annotations produce working sliders, and those sliders keyframe.
- [ ] `#define` switches produce controls that recompile and are not offered as keyframable.
- [ ] A shader with a syntax error shows its compile log and leaves the picture untouched.
- [ ] A custom shader over text does not halo — the premultiply bridge checked on the case that
      exposes it.
- [ ] `iTime` yields the same frame at the same timeline instant in preview and export, compared
      by pixels rather than by eye.
- [ ] A context loss inside a custom pass disables that effect and reports it; the rest of the
      timeline still renders.
- [ ] The fallback export warns that a custom shader was not applied, naming the clip.

---

## Sequencing summary

| Phase | Content | Depends on |
|---|---|---|
| **7** | WebGL2 compositor, parity only | — |
| **8** | WebCodecs export path | 7 |
| **9** | Effect stack, shader library, fade handles | 7, 8 |
| **10** | Keyframe engine | 9 |
| **11** | Dynamic masked regions | 10 |
| **12** | Adjustment layers | 9 |
| **13** | Cross-dissolve transitions | 9 |
| **14** | Recording v1 — OPFS streaming + container repair + 3 tracks | — (independent) |
| **15** | Recording v2 — WebCodecs engine | 8, 14 |
| **16** | Library batch tools | — (independent) |
| **17** | Recording v3 — camera source, PiP placement | 15 (engine seam), 7 (overlay transform), 11 for the optional circular mask |
| **18** | Timeline minimap, replacing the scrub slider and the scrollbar | — (independent) |
| **19** | Project settings — canvas size, aspect, frame rate, geometry refit | 7, 11 (region keyframes are refit too) |
| **20** | Export settings — presets, advanced panel, size/rate override | 8, 19 |
| **21** | Custom shaders — user GLSL, extra channels, feed-forward stages, params | 9, 10, 11 (the layer buffers it generalises) |

Phases 14 and 16 have no dependency on the renderer work and can be pulled forward if the
recording data loss becomes urgent before phase 8 lands.

## Risks worth naming now

- **WebCodecs decode coverage.** `VideoDecoder` will not accept every file a user imports.
  The element-based decode fallback must exist from phase 8, not be bolted on later.
- **Effect parity on the FFmpeg fallback.** Warnings are the honest answer; pretending the
  fallback is equivalent is not.
- **Two-recorder drift** in phase 14. Measured start offsets fix the *offset*; genuine
  clock drift over a long capture would need resampling. The clap test in the DOD is what
  detects it.
- **System audio availability** is a platform fact, not something the code can fix. The
  requirement is to be clear about it up front.
- **Camera format negotiation** in phase 17. A camera returns whatever mode it likes, and
  an MJPEG fallback mode can cost a core before a single frame is encoded. The mitigation
  is to constrain modestly, read `getSettings()` afterwards, and show the user the truth.
- **Two encoders at once, both at 60 fps** in phase 17. 1080p60 screen alongside 720p60
  camera is around 2.5× the load phase 15 measured and is the first real CPU-budget
  question this pipeline faces. The per-source dropped-frame counter from phase 15 is what
  answers it, which is why the DOD measures the two sources apart and names in advance
  which one gives way.
- **Frame rate is negotiated twice** — once by the camera, once by the project. A camera
  can report 60 and deliver 30 in poor light, and a 30 fps project silently discards half
  of a 60 fps capture at export. Both are invisible without an explicit readout, so both
  get one.
- **Aspect change rewrites keyframes, not just scalars.** A masked region is stored as
  ordinary animatable params and is canvas-relative, so phase 19's refit has to walk every key
  of every region channel. Refitting the scalar alone would fix the first frame of an animated
  mask and break every later one — a failure that looks like it worked.
- **Frame-rate change is a destructive edit.** Re-quantizing existing clip edges and keyframe
  times is the only correct answer, and it must be one undo entry with an honest count of what
  moved. Silently leaving edges off the grid is the worse option.
- **A custom shader is arbitrary GPU code.** WebGL has no way to interrupt a shader that takes
  too long; a bad loop hangs the compositor and can reset the context for the whole tab. This
  is not hypothetical — `tsdXDB` in `shaders_example` is a raymarcher costing thousands of
  texture fetches per pixel, and a 4K frame of it can outlast the GPU watchdog. The mitigations
  are a render-scale parameter, per-effect GPU timing, passthrough on compile failure, and
  treating context loss during a custom pass as a signal to disable that effect rather than to
  retry it.
- **OPFS quota.** A long 4K recording can exceed the origin's storage budget. Request
  persistent storage, show remaining budget in the record panel, and stop cleanly rather
  than at the byte the quota runs out.

## Phase 7–8 results

Both phases shipped. Every DOD item passed except one, which failed for an instructive
reason — see the mismatch table below.

| Check | Result |
|---|---|
| WebGL2 vs Canvas2D parity, 5 sample times, video + image + text + PiP | Mean abs diff **0.035/255**, max 16 on antialiased text edges, 0.05 % of channels over 8 |
| Playback with 3 concurrent video layers | **60.2 fps** |
| WebGL context loss | Falls back to Canvas2D mid-playback with no black frame; `restoreContext` recovers |
| WebCodecs export, 120 s of **1080p** | 18.1 s → **6.64× realtime**, 3600 frames, h264 + aac |
| Export heap over that run | 30–49 MB, **zero growth** between first and second half |
| `moov` placement | Byte 28, before `mdat` — seekable without downloading the file |
| Cancel mid-export | Clean stop, OPFS scratch directory empty afterwards |
| WebCodecs unavailable | Falls back to FFmpeg automatically with a visible notice |
| Bundle cost | mediabunny is a lazy 511 kB chunk; initial bundle stays at 301 kB |

### Two pre-existing mismatches this work exposed

Comparing the two export paths against the preview surfaced defects that predate this
plan. Neither was introduced by phases 7–8; both were invisible while the preview and the
FFmpeg export were only ever compared by eye.

| Defect | Detail | Status |
|---|---|---|
| **`amix` silently attenuated multi-clip audio** | FFmpeg's `amix` divides by input count by default. A project with two audio sources exported **3.5 dB quieter** than the preview, and got quieter still with each added clip. The preview sums clip gains straight into the destination | **Fixed** — `normalize=0`. The two paths now agree within **0.1 dB** mean |
| **`drawtext` geometry ≠ canvas text geometry** | The FFmpeg fallback draws lower-third text at a different size and position than the canvas `textRenderer`. Measured against the preview at t=2.5 s: WebCodecs 24.0 dB PSNR, FFmpeg 12.4 dB | **Open, documented.** The WebCodecs path matches the preview; the FFmpeg fallback does not. Fixing `textDrawtext.ts` to match the canvas renderer is worth doing but was out of scope here |

The DOD item "output matches the FFmpeg export within tolerance" is therefore **not met
for text**, and deliberately so: phase 7 established that the new renderer matches the
preview exactly, so where the two exports disagree about text, FFmpeg is the one that is
wrong. Audio now matches.

### Deviations from the plan as written

| Planned | Shipped | Why |
|---|---|---|
| `readPixels` / `VideoFrame(canvas)` from the visible canvas | Compositor owns a private offscreen canvas; the visible canvas keeps its 2D context and blits | A canvas can hold only one context type. Keeping 2D on the visible canvas is what makes the context-loss fallback possible at all, and it lets the export run with no DOM canvas |
| `OfflineAudioContext` render of the whole mix | Rendered in **10-second windows** | A single pass holds the entire project's PCM in memory, which is the linear growth the DOD forbids. Windows are whole seconds so the resampler restarts on a sample boundary |
| `BufferTarget` for the muxer | `StreamTarget` → OPFS, with `fastStart: 'reserve'` | Keeps the finished file out of the JS heap while still writing `moov` first. The exact packet count `'reserve'` needs is known up front: one packet per frame |
| `decodeAudioData` for export audio | mediabunny `AudioBufferSink` (WebCodecs) | `decodeAudioData` already fails on containers in this project — it is why the timeline waveform has a flat-ribbon fallback. Demuxing directly means export audio works on files whose waveform cannot even be drawn |
| — | Added `?renderer=2d` and a runtime toggle | Needed to A/B the two renderers in one session; also a real escape hatch for a broken driver |

## Phase 9 results

All five DOD items pass.

| Check | Result |
|---|---|
| Every registry effect renders in the preview | 10/10. Mean abs diff vs the unfiltered frame, measured on a 1:1 centre crop: eq 19.3, cinematic 18.9, black & white 73.4, sharpen 1.7, pixelate 11.6, edge detect 136.9, blur 7.0, flip 13.2, colour balance 78.3 |
| Denoise, measured on noisy footage | Grain energy (mean adjacent-pixel difference) **3.77 → 1.56, a 59 % reduction** |
| Preview vs WebCodecs export, 3-effect chain + fades at both ends | **40.2 / 40.8 / 42.5 dB PSNR** at t = 0.5 s (mid-fade), 3 s and 5.5 s |
| Video fade in the export | Mean luma ramps 3.6 → 128.7 → 3.6, half-way point 64.7 — linear, and to true black |
| Audio fade in the export | −42 dB → −18 dB → −38 dB; the FFmpeg fallback agrees within ~1 dB through the ramp |
| Audio fade in the preview | Sampled from the live mixer during playback: largest deviation from the envelope **0.002** |
| Ten stacked effects, 720p playback | **60.2 fps** |
| Undo granularity | Add / reorder / toggle / remove / param drag are one step each, with their own labels |
| Fade grip drag | 150 px at 120 px/s → 1.20 s, one history entry labelled "Fade in", on-clip readout "36f" |
| Effect order | Reordering blur and pixelate changes the rendered frame (Δ 5.9), confirming list order is render order |
| Canvas2D parity regression check | Still 0.023 mad — phase 7's guarantee is intact |

### Deviations from the plan as written

| Planned | Shipped | Why |
|---|---|---|
| Fade darkens the picture to black | Fade multiplies the layer's **alpha** | With nothing underneath — the ordinary case — this is exactly a fade to/from black, and it is measured as such above. With a clip underneath it cross-fades instead of punching a black hole in the composite, which is what a layer-based editor should do. The FFmpeg fallback matches it via `fade=…:alpha=1` |
| Flip is a shader pass | Flip is folded into the draw call's source rectangle | No pass, no framebuffer, no cost — and a picture-in-picture mirrors its *content* instead of jumping to the mirrored position on the canvas. FFmpeg's `hflip` on the cropped layer behaves the same way |
| Effect chain runs on the clip's source | Chain runs on the clip's **placed layer** at project resolution | Makes blur radii and pixelate block sizes mean the same thing in both renderers, and makes the FFmpeg mapping a straight translation. Cost is one full-frame pass per effect, which the 60 fps measurement shows is affordable |
| — | Clips with no shader effects allocate **no layer at all** | The ping-pong framebuffers are only created on first use, so a project without effects pays nothing for the machinery |
| Denoise "labelled as an approximation" | Labelled in the Inspector, and the registry note names what is missing (`hqdn3d` averages across time; a per-frame shader cannot) | Same intent, stated where the user actually sees it |

### Known gap

The Canvas2D fallback renders fades but **not** shader effects — it shows the unfiltered
clip and logs a warning once. Reimplementing ten shaders against a 2D context to serve a
path that only runs when WebGL2 is missing is not worth it; the honest warning is.

## Phase 10 results

All four DOD items pass.

| Check | Result |
|---|---|
| Interpolation semantics | `linear` 0 / 5 / 10 / 15 / 20; `smooth` 0 / 3.125 / 10 / 16.875 / 20 — eased and strictly between the key values; `hold` 0 / 0 / 0 / 0 / **20** — a hard step |
| Blur radius 0 → 20 in the preview | Adjacent-pixel energy 2.88 → 1.31 → 0.96 → 0.88 → 0.83, monotonic |
| The export reproduces the animation | Preview vs export frames along a simultaneous blur-up / saturation-down ramp: **35.2 / 39.0 / 41.0 / 42.4 dB PSNR**. Control (preview at 0.5 s vs export at 3.5 s): **9.6 dB** — the measurement discriminates by 30 dB |
| Keys survive moving | Unchanged after moving the clip 2 s later |
| Keys survive trimming | Unchanged after trimming the out point |
| Keys survive splitting | Cut at 1.5 s of a 0 → 20 ramp: left `[[0,0],[1.5,7.5]]`, right `[[0,7.5],[2.5,20]]` — divided, rebased, and both halves hold the interpolated value at the cut |
| Dragging a key on the strip | One history entry ("Move keyframe"); all key times land on frame boundaries |
| Animated placement | A quarter-size picture-in-picture travels 0.18 → 0.85 across the frame, measured as the centroid of the lit pixels |
| `[` / `]` navigation | From 2 s: `[` → 0 s, `]` `]` → 4 s |
| Ten stacked effects, with the rewritten blur | Still **60.2 fps** |

### A real bug this phase surfaced

The phase 9 blur used a fixed nine taps spread across the radius. At radius 20 that puts
the taps **five texels apart**, so the detail *between* them survives: the picture stopped
getting blurrier past about radius 6, which is invisible on a static slider and obvious
the moment a ramp runs through the whole range. The tap count now follows the radius
(spacing ≤ ~1.3 texels, capped at 41 taps), and the ramp is monotonic to the end. Phase 9's
measurements were re-run afterwards — still 60.2 fps with all ten effects stacked.

### Deviations from the plan as written

| Planned | Shipped | Why |
|---|---|---|
| Right-click a key for an interpolation menu | Left-click cycles linear → smooth → hold; right-click deletes | A context menu is a lot of surface for three options. The diamond's shape shows the mode: filled = linear, round = smooth, square = hold |
| Keyframe strip "expands under the clip" | Strip is a sibling of the clip pinned to the bottom of the lane | `.clip` hides its overflow, so a strip drawn inside it would be cut off on short clips |
| Clip transform animates | Animates through the same channel machinery, armed as one unit | Eight separate stopwatches for `crop.x`…`frame.h` would be tedious and is never what is wanted; one toggle arms the whole rectangle |
| — | The Inspector slider reads out the **animated** value at the playhead | Otherwise the control disagrees with the picture, and dragging it would jump the value |

### Known gap

An FFmpeg filter chain is static, so the fallback export cannot animate a parameter. It
**freezes each animated parameter at the clip's midpoint** and says so in the export
notice. The WebCodecs path — the default — animates correctly.

## Phase 11 results

All five DOD items pass.

Geometry is measured by toggling the effect off and diffing the two frames: that isolates
exactly which pixels the mask touched, whatever the footage underneath happens to look
like. A `fill` effect over flat grey makes the affected area unambiguous.

| Check | Result |
|---|---|
| Static region geometry | Stored `{0.35, 0.35, 0.3, 0.3}` → affected pixels `{0.352, 0.347, 0.297, 0.306}` |
| Keyframed region tracks the interpolated rect | Five sample times, each compared against the evaluator's own answer: max error **0.003** in every channel |
| Effect confined to the region | Sharpness inside 0.94 vs outside 3.51 with a 30 px blur |
| `invert` | Flips it: inside 3.56, outside 0.94 |
| Feather (8 %) | **45 distinct levels** across the ramp, monotonic, 54 value changes — a hard edge would show one |
| Preview vs export, moving mask | **30.3 / 30.9 / 30.6 dB PSNR** at 0.5 s, 1.5 s, 2.5 s. Control against a mismatched time: 18.3 dB |
| Drag the box on the preview | Moves it, leaves the size alone, one undo step |
| Drag a corner handle | Resizes from that corner without moving the opposite one |
| Drag while armed | Writes a key at the playhead — the scrub-drag-scrub-drag workflow |
| 3-minute export, animated mask vs none | 15.2 s vs 16.9 s (11.8× vs 10.7× realtime) — **no measurable cost**, as predicted: the mask is one extra full-frame pass whether or not it moves |

### Deviations from the plan as written

| Planned | Shipped | Why |
|---|---|---|
| A `MaskRegion` structure with its own `keys` array | The region is **seven ordinary effect parameters** (`region.mode`, `region.x/y/w/h`, `region.feather`, `region.invert`) | This is the important one. Because a region is just parameters, it animates through the phase 10 keyframe engine, appears on the same timeline strip, splits with the clip, and undoes one step at a time — with no second implementation of any of it. A separate structure would have needed all of that again |
| Mask coverage mixed inside the effect shader | A separate mask pass mixes the effected layer with a snapshot of the layer taken before the effect ran | Keeps every effect shader unaware of masking. A multi-pass effect like blur overwrites both ping-pong buffers, hence the third buffer holding the snapshot |
| FFmpeg fallback animates position at fixed size via `crop` time expressions | The fallback crops, filters and overlays the region at its **midpoint pose**, and warns | Time-expression `crop` geometry is fragile and would still not handle the size animation. Freezing at the midpoint matches what the fallback already does with animated parameters, so there is one rule to explain instead of two |
| — | Feather and ellipse are dropped by the fallback, each with its own warning | `crop` is a hard rectangle. The warning names exactly what was lost |
| — | An **inverted** region has no fallback at all and warns | `crop` cannot express the complement of a rectangle |
| Presets: blur / pixelate / black box | Added an eleventh effect, **Solid fill**, to back the black-box preset | The other two reuse existing effects; a black box needed something that replaces colour outright. On its own it covers the frame, which is why its note points at the region |

## Phase 12 results

All four DOD items pass. The fixture puts one clip on each of V1/V2/V3 as three
horizontal bands, so a single frame shows all three layers and each can be measured
separately.

| Check | Result |
|---|---|
| Grade on V2 (brightness −0.35) | V1 **176 → 87**, V2 **176 → 87**, V3 **176 → 176** — everything up to V2 is graded, V3 is untouched |
| Hiding V2 | V1 back to **176** — the grade goes with the track |
| Adjustment clip, range 1 s–2.2 s | V1 luma 176 / **87** / 176 at t = 0.5 s / 1.6 s / 2.6 s |
| Preview vs WebCodecs export | **45.1 / 50.8 / 45.1 dB PSNR** across the three times, with a track grade and an adjustment clip both active |
| FFmpeg fallback | Applies the grade in the right range (176 / **71** / 176) and matches the preview outside it (45.0 dB) |

### The fallback's grade is in the right place but not the right amount

Inside the adjustment the fallback reads 71 where the preview and the WebCodecs export
read 87 — 25.98 dB PSNR against the preview. The range, the layer ordering and the
compositing are all correct; the *magnitude* differs because FFmpeg's `eq` works in
limited-range YUV with a 16-level offset while the shader works in RGB. Chasing exact
parity across two different colour pipelines is not worth it now that the fallback is only
the fallback, so it is recorded here rather than fixed.

### A fixture bug worth remembering

The first run showed the FFmpeg export going black near the end while the WebCodecs export
kept showing picture. Neither is a defect: the test clip had been trimmed *past the end of
its source*, which the UI itself prevents. Where that happens the two paths differ —
WebCodecs holds the last decoded frame, FFmpeg falls through to the background.

### Deviations from the plan as written

| Planned | Shipped | Why |
|---|---|---|
| Separate track-effect actions | The existing effect actions take a **target**: a clip id, or `{ kind: 'track', id }` | A bare string still means a clip, so nothing that already called them had to change, and there is one implementation of add / remove / reorder / toggle / reset instead of two |
| — | Track effects cannot be keyframed | A track has no time base to anchor clip-relative keys to. The stopwatches are hidden for a track grade; an adjustment *clip* has a time base and keyframes normally |
| Adjustment clips get their own striped block | Done, and they are placed **top-down** like text | An adjustment grades what is below it, so the topmost free lane is the only sensible default |

## Phase 13 results

All six DOD items pass.

| Check | Result |
|---|---|
| Overlap rule | A partial overlap is accepted; one clip swallowing another is refused; identical ranges are refused |
| Preview blends | The mid-dissolve frame differs from the outgoing clip by 58.5 and from the incoming by 52.0 (mean abs, 0–255). A cut would be ~0 from one of them |
| Audio cross-fade | Sampled from the live mixer: A 1.0 → 0.7 → 0.3 → 0, B 0 → 0.3 → 0.7 → 1.0, summing to 1.0 throughout |
| Same-asset dissolve | Blended frame is **0.18** from the exact 50/50 mix of the two sides, which are themselves 10.5 apart — both source times are decoded and mixed |
| Preview vs WebCodecs export | 37.7 / 34.3 / 30.7 dB PSNR across the dissolve |
| Preview vs FFmpeg export | 36.1 / 38.0 / 38.7 dB — the fallback reproduces this one closely, because it uses the same alpha ramp rather than `xfade` |
| Undo | A whole drag is one history entry; undoing restores the clip position and the transition together |
| Split / delete | Splitting the outgoing clip keeps the transition; deleting the incoming clip removes it, with no cleanup code |

### Deviations from the plan as written

| Planned | Shipped | Why |
|---|---|---|
| A stored `Transition` entity with its own id, track and duration | **The overlap *is* the transition.** Only the type is stored, on the incoming clip | This is the important one. A stored entity has to be created, resized, garbage-collected on split and delete, and kept consistent through undo. Deriving it from the overlap makes every one of those free and impossible to desync — which is why "splitting or deleting either clip removes the transition cleanly" needed no code at all |
| Overlap allowed when "smaller than both clips" | Overlap allowed up to **half** of either clip | Literally smaller-than-both still lets a clip sit almost entirely inside its neighbour, which is a clip being swallowed, not a transition. The first test run caught exactly that |
| `xfade` / `acrossfade` in the fallback | `fade=…:alpha=1` on the incoming clip, `afade` on both | The compositor's dissolve *is* an alpha ramp of the incoming clip over the outgoing one, so the same construction in FFmpeg matches it — and it fits the existing overlay graph instead of requiring it to be rebuilt around `xfade`. Measured at 36–39 dB against the preview |
| Wipes as a transition type | Implemented with a **scissor rectangle**, not a shader | A wipe is a hard-edged reveal; clipping the draw is exact and free. The fallback cannot express it and warns |
| Per-asset media elements | A clip in a same-asset transition gets its **own** element | One element cannot be at two `currentTime`s. The key is a pure function of the timeline, so only the clips that need a second decoder allocate one |

---

## Phase 14 results

The two reported defects are fixed, and both were confirmed as defects before being fixed
rather than assumed. Verified in Chrome with synthetic capture sources, so the same
transient could be put into every source at one known instant — the only way to check
alignment without a person clapping. Everything downstream of the streams is the real code.

### The defect, at the byte level

| | Raw MediaRecorder file | After repair |
|---|---|---|
| `<video>.duration` in Chrome | **`Infinity`** | `5.994` |
| `ffprobe` duration | **`N/A`** | `5.982000` |
| Matroska `Segment` size | `01ffffffffffffff` (unknown) | known |
| `SeekHead` | **absent** | at byte 49 |
| `Cues` | **absent** | at byte 66 |
| `Duration` in `Info` | **absent** | at byte 161 |
| VLC's own demuxer | **`no cues/empty cues found->seek won't be precise`** | `Duration=5982`, Seek head, Cues all parsed |

Each row compares a raw capture against its own repaired copy. The Chrome row is from the
main test run's 5.994s capture; the byte-level and external-tool rows are from a separate
5.982s capture saved to disk for probing — hence the two lengths.

### Measurements

| Check | Result |
|---|---|
| Repair cost | **28ms** for a 6s screen capture, 5–16ms for audio — a remux, not a re-encode |
| Alignment, mic vs system audio | **1.0ms** apart |
| Alignment, all three sources | **16.9ms**, worst of three runs 16.8ms, against a 33.3ms frame |
| Placement | Screen → V1, mic → A1, system → A2, sub-frame offsets preserved (`2`, `2.0033`, `2.0042`) |
| Undo | The whole session is **one** history entry |
| Heap during a 6s capture | 11.2 → 11.4 MB while 0.7 MB reached disk |
| Frames kept while recording | 99.3% idle, **99.0% with the timeline playing** — a 0.3 point cost |
| 15-minute capture, end to end | 145 MB repaired in **0.9s**; container duration 15.00 min matches the capture clock exactly; seeked to 450.1s and played on. Heap 11.1 → 10.9 MB during capture, 38.4 MB after repair *and* library probe of a 145 MB file |
| Crash recovery | Tab killed at 8.0s; both sources recovered, repaired and played on from 6.1s |
| Editing a recording | A recorded clip trimmed and graded exports through **both** paths: WebCodecs `h264 1280x720 + aac, 8.000s`, FFmpeg fallback `7.933s` |
| System audio, unsupported platform | Warned **before** recording, naming the actual requirement (`Chrome 141+`) |
| System audio, platform returns no track | Detected from the stream; no silent file created |

### The repair is a remux, not an EBML patcher

The plan called for injecting `Duration`, `SeekHead` and `Cues` into the finished file by
hand, following `ts-ebml`. A spike found something better first: **mediabunny reads the
live-profile file exactly as it is** — unknown segment size and all — and computes the true
duration from it. So writing it back out produces a correctly indexed container, with the
codecs carried across untouched.

That replaced a hand-written EBML parser and offset-fixup pass with about forty lines, and
it covers Chrome's fragmented MP4 output by the same route rather than needing a second
implementation. Input and output both stream through OPFS, so nothing materialises in the
heap at either end.

### A real bug the tests caught: the wrong clock

The first alignment run put the screen **74ms** behind the two audio sources — outside a
frame, so a genuine failure. The cause was measuring each source's start from
`MediaRecorder`'s `onstart` event, which fires after an encoder-init hop that is far longer
for video (143ms) than for audio (59ms). The media timeline does not wait for that event.

Measuring from the synchronous `start()` call instead brought the spread to 16.9ms, and the
residual is real pipeline latency rather than measurement error. Worth naming: because all
sources are acquired before any recorder starts, the offsets now come out near zero
(0–4ms), so the offset machinery is currently carrying very little — it earns its keep only
if a source is ever acquired late.

### What the 30-minute run actually found

The capture leg passed exactly as designed:

| Elapsed | Heap | On disk | Chunks queued |
|---|---|---|---|
| 0 min | 11.2 MB | 0 MB | 0 |
| 10 min | 10.9 MB | 97.7 MB | 0 |
| 20 min | 10.8 MB | 196.2 MB | 0 |
| 30 min | **10.7 MB** | **294.1 MB** | 0 |

Heap drifted *down* over half a gigabyte of recording, and the writer never once fell
behind. But the **repair then failed** — `Cannot close a ERRORED writable stream`.

The cause is not the writer. This machine's disk is 99% full (3.7 GB free), so Chrome's
usable origin quota works out around 553 MB, and repairing needs the raw recording *and*
its rebuilt copy present at once: 294 + 294 = 588 MB. It did not fit. Probing both OPFS
writers confirmed it is a storage ceiling rather than an API choice — `createWritable` and
a sync access handle both stop at the same 553 MB.

Three things came out of that:

- **A pre-flight check.** Repair now asks whether there is room before it starts, and if
  not, keeps the recording and says so in plain numbers instead of dying mid-stream:
  *"not enough storage to rebuild the container: it needs about 323 MB beside the 294 MB
  already recorded, and only 259 MB is free."* The recording still plays; it just will not
  scrub until space is freed.
- **A silent data-loss bug, fixed.** `FileSystemSyncAccessHandle.write()` returns how many
  bytes it took, and out of quota it takes *fewer with no exception*. The worker ignored
  that return value, so a recording could be truncated while reporting success. The probe
  made it visible: it claimed 734 MB written with 553 MB on disk. Short writes now fail loudly.
- **Repair transiently needs 2× the recording.** Inherent to remuxing, and the reason
  phase 15 matters: a WebCodecs capture writes a correct container directly and needs no
  second copy at all.

The end-to-end leg (capture → repair → seek → play) is therefore verified at the largest
size this disk can repair rather than at thirty minutes; the thirty-minute figures above
are the capture and memory measurements, which is what that DOD item is about.

### Another the tests caught: a recording could be restored twice

`findOrphans` returns everything on disk, and restoring one did not remove it from the
offer list — so a second click produced a duplicate asset. Recordings are now tracked as
consumed for the session. They deliberately stay on disk: the project itself is not
persisted yet, so they are still worth offering after a reload.

### Deviations from the plan as written

| Planned | Shipped | Why |
|---|---|---|
| `containerFix.ts` injecting `Duration` + `SeekHead` + `Cues` into the finished WebM | A **remux** through mediabunny | The spike proved mediabunny reads the live-profile file. This is a fraction of the code, handles fragmented MP4 by the same path, and is verified against VLC's demuxer rather than against my own reading of the spec |
| A rolling 5-minute segment boundary | **Not implemented** | Its two stated motivations are already met: every chunk is flushed as it is written, so a crash keeps everything acknowledged; and the repair is a streaming remux with bounded memory, so "comfortable repair size" is not a constraint. Segmenting would add a concatenation step to buy nothing measured |
| Start offsets from when each recorder began | From the synchronous `start()` call | See above — the event lags the media, and measuring it actively made alignment worse |
| Recordings deleted once imported | Kept on disk, filtered from the offer list per session | Until projects persist, a recording on disk is the only durable copy |

### Known gaps

- **Segment rotation is not implemented** (above). A single failure mid-capture therefore
  affects one file rather than one segment — but the flushed bytes still survive.
- **The storage guard trusts `navigator.storage.estimate()`**, which is optimistic: on this
  machine it reported 2147 MB free where the real ceiling was 553 MB. It catches the clearly
  impossible case; a repair can still run out mid-way, and when it does the recording is
  kept and the failure is reported rather than thrown.
- The mic path no longer has a separate implementation: `MicrophoneRecorder` and
  `useMicrophoneRecorder` are deleted, and mic-only capture is a `CaptureSession` with one
  source. The old button's behaviour is preserved, including recording during playback.
- Recovered files are placed at the playhead with **offset 0** — a recovered recording has
  no surviving session to align against.
- The 30-minute DOD run is measured with a synthetic 1080p30 source, not a real desktop.

## Phase 15 results

The repair pass is gone. A recording now comes off the encoder already indexed, already
carrying its duration, and — the part that was not expected — **already playable if the tab
dies mid-take**. Same UI, same three tracks, same alignment guarantees.

### The container was chosen by measurement, not by preference

The plan said "Mediabunny muxer". Which container, and how it is written, turned out to
decide whether an interrupted recording is worth anything. Three candidates, each recorded
for 6 seconds and then examined twice — finished normally, and with the muxer never
finalised, which is exactly what a killed tab leaves:

| Written as | Finished file | Killed mid-recording, no finalize |
|---|---|---|
| Plain MP4 (index at the end) | 6.08s, seeks to the middle | **Total loss** — `DEMUXER_ERROR_COULD_NOT_OPEN`, and the repair cannot read it either |
| **Fragmented MP4** | 6.08s, seeks to the middle | **0.14 MB plays as it is, reporting 4.03s** |
| WebM | 6.03s, seeks to the middle | Opens but reports `Infinity`; the phase-14 repair recovers 5.97s |

A fragmented MP4 is a run of self-contained fragments, so the last complete one is simply
the end of a valid file. That is the whole difference, and it is why this is not the plain
MP4 the DOD asked for by name.

**How the bytes are written mattered just as much.** Mediabunny's `StreamTarget` has a
`chunked` mode that accumulates up to 16 MiB before writing anything — the phase-8 export
uses it. With it on, a killed tab left **0 bytes on disk**. Writing through instead costs 3
disk writes per 6 seconds for fragmented MP4 (against 405 for WebM, which has no fragment
structure to batch behind), and leaves everything up to the last fragment. The writer is
phase 14's `ChunkSink` — a sync access handle flushed per write — and not phase 8's
`openScratchFile`, which buffers through `createWritable` and commits only on close.

### Measurements

| Check | Result |
|---|---|
| Finishing a stopped recording | **0.4–0.9ms**, and it rewrites nothing. Phase 14 spent 28ms on a 6s capture and 0.9s on a 15-minute one |
| File straight off the encoder | `ffprobe`: `h264`, `duration=6.033333`, `moov` at the front. No repair anywhere in the path |
| Alignment, mic vs system audio | **0.1ms** apart |
| Alignment, all three sources | **10.0 / 12.4 / 16.4 / 17.1 / 17.3ms** across five runs — inside one 30fps frame, and at the measurement floor (a flash can only be located on the video's own 33ms frame grid) |
| 1080p60, 20s | 1197 frames delivered, **1197 encoded, 0 dropped**, 59.8 fps, writer never behind |
| Frame accounting | `delivered = encoded + dropped` holds exactly, under load and at rest |
| Tab killed at 8.0s | Both sources play **with no repair at all**: 7.03s and 7.02s, seek to a second before the end and play on |
| Recovery of an interrupted take | Rebuilt in 35ms / 19ms to an exact duration |
| Fallback | With `MediaStreamTrackProcessor` deleted from the page, `auto` picks MediaRecorder and says why; asking for WebCodecs explicitly refuses rather than silently doing something else |
| Recorded media through export | Both paths: WebCodecs `h264 1280x720 + aac duration=8.085`, FFmpeg `8.008` |
| **30 minutes of 1080p** | 100.4 MB, container duration **30.01 min** against a 30.01 min capture clock, **0 dropped frames of 54,009**, writer never behind, stop took 40ms and finishing 6ms, seekable to 1800.3s and plays on from the midpoint |

### The thirty-minute run, and what it says about memory

This is the run phase 14 could not finish. Not because of the engine — because repairing a
recording needs the original and its rebuilt copy on disk at once, and 294 + 294 MB did not
fit in this machine's 553 MB of usable quota. There is no second copy now, and H.264 at
`QUALITY_HIGH` writes 100 MB where MediaRecorder's VP8 wrote 294 MB for the same half hour.
The whole end-to-end leg — capture, stop, seek, play — is verified at thirty minutes.

Memory needs stating precisely, because it is not the flat line phase 14 produced:

| | Phase 14 (MediaRecorder) | Phase 15 (WebCodecs) |
|---|---|---|
| Heap through the run | flat ~11 MB | **sawtooth, 11.6–19.8 MB, 16 collections** |
| First half vs second half | — | 11.6–18.2 MB, then 13.7–19.8 MB — with twice the recording behind it |
| Once the capture ended | — | **11.1 MB**, below the 12.3 MB it started at |

MediaRecorder hands over a blob per second and the page transfers it away, allocating almost
nothing. The WebCodecs engine touches every frame, so it makes garbage — about 220 bytes per
frame across 54,009 frames — and the heap sawtooths as that garbage is collected. What
matters is that the *band* does not move with the recording: it rose 1.6 MB while the file
doubled from 48 MB to 100 MB, and the heap fell below its starting point once capture
stopped, so nothing was being retained.

**The original assertion failed, and it deserved to be replaced rather than loosened.** It
compared start-to-end growth against 5% of the bytes recorded — 7.3 MB against 100 MB — which
is the wrong shape twice over: a percentage of the recording makes a *longer* capture easier
to pass, and on a garbage-collected heap the start-to-end delta mostly reports where in the
sawtooth the last sample happened to land. The predicate is now a fixed ceiling that does not
scale with the file, plus the half-against-half band comparison and the post-capture heap. The
numbers above are from the run as it happened; only the question asked of them changed.

### Two real bugs the alignment check found

**The microphone was landing 20ms late.** The engine infers the offset between a source's
sample timestamps and `performance.now()` — they are not the same clock, and audio arrives
on a different epoch again. The first estimator took the smallest observed
`arrival - timestamp`. But an audio chunk covers a *span*: a chunk stamped `t` holding 20ms
of sound cannot exist until `t + 20ms`, so every measurement was one chunk-duration too
large, and every microphone track sat that far behind the picture. Accounting for the
sample's own duration fixed it — the clap moved from 33.8ms out to 17.1ms, which is the
measurement floor. Video needs no such correction: a captured frame's timestamp is the
instant it was grabbed.

**The dropped-frame counter was dead code.** Reading a frame and awaiting its encode before
reading the next leaves the reader idle while the encoder works — so when the encoder falls
behind it is the *platform* that discards frames, from a buffer nothing in the page can see.
The counter could only ever read zero. Under a deliberate main-thread stall the old shape
encoded 201 frames where ~600 were produced and reported **no drops at all**. Reading and
encoding now run as separate loops with a short queue between them: the reader always
drains, so the choice of what to lose is ours and the count is exact. Pushing frames at 982
fps into the engine produces drops and `delivered = encoded + dropped` still balances.

### Two smaller things fixed on the way

- **Discard left the recording on disk.** `cancel()` closed the writers but kept the files
  and their sidecars, so an abandoned take was offered back as a leftover on the next
  launch — the opposite of what the button says. It now deletes them.
- **An audio-only MP4 would have imported as a blank video clip.** The library infers a
  clip's kind from the mime type and extension, and `video/mp4` is what an OPFS file called
  `.mp4` reports regardless of what is inside it. Audio-only sources are written as `.m4a`
  with an `audio/mp4` type, and the rebuilt-file path now takes its type from the capture
  rather than from the name of the file it was rebuilt into.

### And one in the test harness, which changes a phase-14 number

The synthetic clap scheduled its audio burst 20ms ahead on the audio clock but fired the
white flash immediately — so every alignment measurement made with it, phase 14's included,
was biased by 20ms in the picture's favour. The fixture now delays the flash to match.
Phase 14's reported 13.5ms and phase 15's 17.1ms are therefore not directly comparable;
both are well inside a frame, and the audio-to-audio figure (1.0ms then, 0.1ms now) was
never affected.

### Deviations from the plan as written

| Planned | Shipped | Why |
|---|---|---|
| "A seekable **MP4**" | A **fragmented** MP4 | Measured: a plain MP4 loses the entire recording if the tab dies, because its index is written last. Fragmented keeps everything up to the last complete fragment, and still seeks |
| Reuse the encoder and muxer work from phase 8 | Reused the muxer and the codecs; **not** the target | Phase 8's OPFS target buffers through `createWritable` and commits on close, which is right for an export and fatal for a recording. Capture writes through phase 14's crash-safe sink instead |
| `VideoEncoder` / `AudioEncoder` driven directly | Driven through mediabunny's `VideoSampleSource` / `AudioSampleSource` | Same pipeline, with encoder configuration and backpressure already solved. The frame reading, timestamping, queueing and drop policy — the parts that decide correctness here — are ours |
| — | Keyframes every **1 second**, matching the fragment length | A fragment can only start on a keyframe, so the keyframe interval *is* the crash granularity. A 2-second GOP would double what an interrupted take loses |

### Known gaps

- **Drops the platform makes are still invisible.** `MediaStreamTrack.stats` is not
  implemented in this Chrome (checked, not assumed), so if the main thread stalls hard
  enough that the reader itself stops draining, frames vanish uncounted. While the reader
  keeps up — which is the case at 1080p60 — every discarded frame is ours and is counted.
- **An interrupted recording loses up to one fragment**, one second of media. Measured:
  7.03s survived of 8.0s.
- **Heap sawtooths between roughly 12 and 20 MB** rather than sitting flat, because this
  engine allocates per frame where MediaRecorder did not. It is bounded and independent of
  the recording's length, and it returns to baseline afterwards, but it is not the same
  measurement phase 14 reported.
- H.264 and AAC only on this engine. WebM/VP9 was measured worse for interrupted recordings
  and is not offered as an alternative; browsers without the pipeline fall back to
  MediaRecorder, which still writes WebM.
- Audio-only sources are written as `.m4a` (`audio/mp4`) so they import as audio. An
  audio-only file named `.mp4` becomes a video clip with no picture — the extension is the
  only thing the library has to go on.
- Recovered files are still placed at offset 0: a recovered recording has no surviving
  session to align against.
- The endurance run uses a synthetic 1080p source, not a real desktop.

## Explicitly not in this plan

- Automatic object tracking for masks (chosen against; keyframes only).
- Phase 6 of the previous plan — drag-and-drop placement and IndexedDB project persistence.
  Note that phase 14's OPFS work makes project persistence considerably easier afterwards.

---

## Phase 19 results

Implemented. `npm run check:geometry` asserts the reframe and re-quantize maths — 25 checks,
all passing — and `tsc -b` and `npm run build` are clean. What is **not** verified is anything
that needs the app on screen: the dialog itself, a vertical project rendering through the two
export paths, and the encoder-rejection message, which only exists in a browser.

### The refit is much smaller than it looked, for one reason

`transform` is optional, and a clip without one is fit-and-letterboxed by the renderer. Those
clips re-fit themselves when the canvas changes shape — nothing to rewrite, and `reframeClips`
returns the identical array when nothing needed moving. Only placed overlays, text boxes and
masked regions are touched.

### Masks needed a different rule from everything else, and the DOD is what forced it

Canvas-anchored refitting is right for `transform.frame` and `textFrame`, and **wrong** for a
masked region. A mask covers something *in the picture*, and an aspect change moves the picture
inside the frame: an untransformed 16:9 clip in a 9:16 project becomes a band across the middle.
Refitting a region against the canvas would have left a licence-plate blur sitting in the black
bar above the video, while every other rect looked correct.

So regions are remapped through the clip's **content rect** — where its picture actually lands —
which makes the mapping a similarity transform and keeps the mask exactly on its subject. The
check asserts this in content-relative coordinates rather than by eye, at both ends of an
animated region.

Track grades keep the canvas rule: they apply to everything below them and have no content of
their own to follow.

### Keyframes are transformed with one map, chosen once

The anchor decision (nearest edge, or centred when the margins match) is made from the base rect
and then applied to every key. Deciding per key would let a PiP animating left-to-right flip its
anchor mid-path and tear the animation in half. `frame.x` also depends on the width at that
instant, so the width channel is evaluated at each key's own time rather than assumed constant.

### One action, one history entry

`setProjectSettings` takes size and rate together. The first cut had the dialog call two actions
and produced two undo steps for one Apply, which is exactly the failure the plan warned about:
undoing a canvas change and finding the overlays still moved. `setCanvasSize` and `setFps` remain
as thin wrappers for programmatic use — phase 17 needs the latter.

### Deviations from the plan as written

- **The Inspector's placement stage was hardcoded to 196 × 110**, a 16:9 box. Not in the plan,
  but a vertical project would have been edited on a landscape stage — the one surface in the
  app that lied about the canvas. It now derives from the project aspect and comes out at
  exactly 196 × 110 for 16:9, so nothing moves for existing projects.
- **Margins are preserved in pixels, not proportionally**, when re-anchoring. A 24 px inset
  stays 24 px. Refit only ever fires on an aspect change, where the scale factor is near 1, so
  the alternative buys nothing and reads worse — a proportionally-scaled margin on a smaller
  canvas looks cramped.
- **`normalizeSettings` exists with nothing to migrate.** There is no project persistence yet,
  so no file uses the old shape. It is written now because the alternative is discovering the
  gap the day persistence lands, long after the change that caused it.
- **A clip shorter than one frame of the new grid keeps one frame** rather than quantizing to
  nothing. Coarsening the grid should not delete work.
- **Colliding keyframes merge, later wins**, when a coarser grid puts two keys on one frame —
  matching what dragging one key onto another already does.

### Known gaps

- The FFmpeg fallback receives the new size, but its `drawtext` geometry mismatch is unchanged
  and pre-existing.
- Nothing re-checks encoder support when a project is *loaded* rather than edited; the dialog is
  the only gate.

---

## Phase 20 results

Implemented. The export maths is asserted in the same harness as phase 19 — `npm run check:math`,
38 checks, all passing — and `tsc -b` and `npm run build` are clean. Not verified: the finished
files themselves. Nobody has yet exported all three presets and compared their sizes, checked the
moov offset by hand, or played the results in Safari and VLC. Those are the DOD items still
unticked, and they need someone at the machine.

### A preset is one number

`bitsPerPixel`, multiplied by width × height × fps. That is the entire quality ladder: Master
0.15, Web 0.08, Small 0.04. It matters because a *fixed* bitrate means something different at
every frame size — generous at 720p, unusable at 4K — and a preset that changes meaning with the
project is not a preset. The check asserts a preset scales exactly with pixel count and with
frame rate.

### Both engines are given the same number

The FFmpeg fallback moved from `-crf 23` to `-b:v <the same bitrate the WebCodecs path got>`,
plus `-g` from the keyframe interval and `-ac` from the channel count. CRF would produce a
slightly better file at an unpredictable size — which is exactly what makes two engines disagree
about what "Web" means. Matching the number is worth more here than winning on quality.

### The override scales, and is not allowed to reshape

An output override changes the pixel size the compositor renders at; the composition itself is
normalized, so this is a scale rather than a re-layout. Changing the *aspect* at export time
would move every overlay and mask with no undo entry and no record — a project edit smuggled
into a file operation. So the height field follows the width automatically, and `outputSpec()`
refuses a mismatch before either engine starts, naming project settings as the place to do it.

### The metadata that was actually missing

`fastStart: 'reserve'` was already in place from phase 8, so the moov atom has been at the front
of every export since then — the "metadata at the beginning for the web" problem was solved
before this phase started. What was genuinely absent was a creation date: an exported file had
none at all, and players fell back to whenever it was copied. Both paths now write one.

### Deviations from the plan as written

- **No title tag.** mediabunny exposes `title`, but a project has no name to put in it until
  projects can be saved. A title of `export_1755600000000` is worse than no title.
- **Export settings live in the undo document.** They are project data, so they save with the
  project when persistence lands, and changing them is one undo entry like any other edit.
- **Mono is a downmix at the last moment.** The mixdown stays stereo because that is what the
  timeline mixes into; `downmixToMono` folds the window on its way to the encoder, so nothing
  upstream has to know the output is mono.

### Known gaps

- **Colour signalling is still missing.** mediabunny's `VideoTrackMetadata` exposes rotation and
  frame rate but no `colr` atom, so an export still carries no transfer-function or primaries
  tag and a player is free to guess. Named here rather than worked around.
- The FFmpeg path still runs `-preset ultrafast`; the quality presets change the bitrate but not
  the encoder effort, because effort is what makes WASM export unbearably slow.
- The size estimate in the dialog is bitrate × duration. It is honest for a constant-bitrate
  target and slightly high for quiet footage.

---

## Phase 21 results

Built against the four shaders rather than against the idea of arbitrary GLSL, and the shape of
the feature is the shape of what they needed.

**A Shadertoy shader pastes in unedited.** The prelude supplies `iResolution` (a `vec3` — the NTSC
shader writes `vec2(iResolution)`, which will not compile against a `vec2`), `iTime`, `iTimeDelta`,
`iFrameRate`, `iFrame` (an `int`, so the extruded shader's `min(iFrame, 0)` still defeats loop
unrolling), `iMouse`, `iDate`, four `iChannel`s and `iChannelResolution`. A wrapper calls
`mainImage`. Everything beyond that comes from annotation comments, which are ordinary comments to
any other compiler — an annotated shader still runs on Shadertoy unchanged.

**Parameters are ordinary effect parameters, and that is the whole point.** `// @param speed 0.1 6 2`
becomes `#define speed uP[0]` in the generated source and a slider in the Inspector. Because it is a
plain numeric param it keyframes, splits with the clip, undoes one step at a time and draws on the
timeline strip through phase 10's machinery — no second implementation of any of it. That is why
"define your own shader" and "change its parameters" were one feature rather than two. The cap is
eight, the same array every built-in effect packs into; a ninth is reported in the editor rather
than silently dropped.

**Compile-time switches are a different kind of control and say so.** `// @define VIDEO_STANDARD NTSC PAL`
becomes a dropdown, `// @toggle SUBDIVIDE on` a checkbox, and both *replace* the source's own
`#define` line rather than being prepended alongside it — redefining a macro to a different body is
a compile error, so pasting the published shader and annotating it would otherwise fail. They
recompile, so they cannot be keyframed; the Inspector marks them "recompiles" and hides the
stopwatch, because a slider that recompiles mid-drag is not the same object as one that does not.

**The coordinate system fell out for free — after one wrong turn.** Layers store the picture
bottom-up, which is exactly Shadertoy's origin, so `fragCoord = vUv * iResolution` needs no
correction. What I got wrong first was which source rectangle is the identity one: the vertex
shader takes its destination in y-down pixels, so the `{0, 1, 1, -1}` rect that *looks* like a flip
is the one that cancels that convention, and the plain `{0, 0, 1, 1}` is the one that flips. Custom
passes drew with the latter, and with three passes for a single-stage shader — input copy, stage,
resolve — the odd count reached the screen and the encoder upside down. Every custom pass now uses
the same identity rectangle the built-in effects always did.

**Premultiplied alpha needed a bridge, and it costs two blits.** Layers are premultiplied; a shader
samples `iChannel0` itself, so there is nowhere to intercept the read. An input pass hands it
straight colour (and does the render-scale downsample on the way), and a resolve pass premultiplies
the result. The resolve also multiplies by the *layer's* alpha at full resolution — most Shadertoy
shaders end `fragColor = vec4(rgb, 1.0)`, and taking that at face value would turn the transparent
letterbox around a clip into an opaque black rectangle hiding every track below it.

**Stage buffers are half-float.** Not in the plan, and not optional: the NTSC shader's middle stage
writes YIQ, whose chroma is signed. An 8-bit buffer would clamp every negative component to zero and
return a picture that is wrong rather than merely coarse — the kind of failure that looks like a bad
shader instead of a bad buffer. Falls back to 8-bit where `EXT_color_buffer_float` is missing.

**Two bugs the type checker and the reading found, not the screen.** Sampler uniforms default to
texture unit 0, so `iChannel1` and up would all have read whatever channel 0 held — the dither
preset would have compared the video against itself. And `iChannelResolution` initially reported the
frame size for the input channel while the texture was at render scale, which would desynchronise
any shader that works out its own pixel grid; the NTSC preset does exactly that.

### Deviations from the plan

- **The NTSC shader lost a stage.** Its Buffer A only copied the video, and this renderer already
  hands every stage that copy as `input`. Two stages instead of three, one full-frame pass saved,
  same picture.
- **Channels come from generated patterns, not the media library.** Bayer 8×8, seeded white noise
  and flat grey. The library-image binding in the plan is not built: no shader among the four wanted
  one, and the dither shader — the only one with a second channel at all — wants a threshold matrix,
  which is exact and free to generate and approximate at best to import. A pasted shader that needs
  a photographic channel has no way to get one yet.
- **`iMouse` became two automatic parameters** rather than a per-shader decision. When the source
  mentions it — with comments stripped first, so the extruded shader's commented-out mouse block
  does not conscript two useless sliders — `Mouse X` and `Mouse Y` appear and keyframe. The NTSC
  preset goes further and names its wipe explicitly, which reads better than "Mouse X".
- **Feedback buffers are out of scope**, as planned, and the parser enforces it: a stage that names
  itself or a later stage is refused at parse time with the reason, and that channel falls back to
  the input. This is the one rule that keeps scrubbing honest.

### Cost, and what happens when it is too much

Render scale (full / half / quarter) is per effect, defaulting to whatever `// @scale` says — the
extruded raymarcher ships at half. Per-effect GPU time is measured with
`EXT_disjoint_timer_query_webgl2` where the driver exposes it and shown in the Inspector, smoothed,
with a warning past 16 ms. If the context is lost while a custom shader is on the GPU, that effect
is switched off by name with an explanation rather than retried into the same crash; toggling it
back on or editing the source clears the strike.

### What the harness checks, and what it cannot

`npm run check:math` now covers the annotation layer — 48 new assertions on top of the 38 from
phases 19 and 20. It asserts that parameters land in the `uP` slots their `#define`s name, that the
dither channel really is `repeat` + `nearest`, that the source's own `#define VIDEO_STANDARD` is
replaced exactly once rather than duplicated, that the shared preamble reaches the last stage, that
a stage may not sample itself, that the parameter cap is enforced and reported, and that changing a
switch produces a different program key while changing a slider does not.

What it cannot check is anything involving a GPU. Every DOD item above is left unticked: nobody has
yet seen the four presets render, compared a stage against Shadertoy side by side, watched a slider
keyframe, read a compile log in the panel, or exported a frame and compared it with the previewed
one pixel for pixel. The shader editor compiles what is typed in a throwaway WebGL2 context and
shows the log, so a broken shader should be visible at the point of pasting — but that path, too,
has only been read, not run.

### Attribution

The four presets are other people's work, kept with their links and their authors' comments intact:
`XtK3W3`, `MllSzj`, `tsfXWj` and `tsdXDB` from Shadertoy. Shadertoy's default licence is CC BY-NC-SA
3.0 unless an author states otherwise, which is worth settling before this ships to anyone.

---

## Phase 16 results

The one part of this project where the right amount of design is none. These are command lines
someone arrived at by running them, and the value is in exactly that — so the table holds them
character for character and the code around them does not get a vote.

**"Verbatim" is asserted, not promised.** `scripts/checkProjectMath.ts` section 13 re-parses
`shir-effects.txt` at check time and compares all 29 argument arrays against the table element by
element. A tidied filter chain, a reordered flag, a dropped `-threads 0` — each fails the run. That
matters more than it sounds: a filter graph that has been "cleaned up" is a different command line
wearing the same name, and it will look fine until the one clip that exercised the difference.

**One preset could not be verbatim, and it is the only one.** `fade-in-out-1s` hard-codes its
fade-out at `st=20`, which is the tail of a 21-second clip and the middle of everything else. It is
the sole entry with an `adapt` hook, applied to a copy of the args at run time; the check asserts
that the hook moves both the video and the audio fade, clamps at zero for a short clip, leaves the
stored args untouched, and changes nothing else in the command line.

**The estimate is the feature, not the progress bar.** Half these presets finish before you let go
of the mouse and half take longer than the edit you were in the middle of, and the button looks
identical either way. So each preset carries a rough cost — seconds of work per second of source,
honest to the order of magnitude and no further — and the dialog states it, in words that stay
vague on purpose (`over half an hour`, not `47 minutes`), before the Run button rather than after
it. Anything at or above 20× realtime must set `slow`, which the harness enforces; those get a
sharper warning and a note that cancelling is free.

**Never in place.** A preset reads one asset and writes a new one, inserted directly after its
source in the library so the pair can be compared, named `holiday (stabilized).mp4`, and carrying a
`derivedFrom` record that the library row shows. Nothing is destroyed, which is what makes it safe
to start a slow job on a hunch. Like every other import it is not a history entry — it changes what
is available to edit with, not the edit.

**Cancellation is a `terminate()`, and that has a consequence worth stating.** Killing the worker
mid-frame is the only thing that actually stops a WASM encode. Because the FFmpeg instance is
shared with the fallback exporter, a preset refuses to start while an export is running and says
why, rather than quietly murdering the export. Finding this also turned up an existing leak:
`runFfmpegExport` registered a `progress` handler on every run and never removed it, and since
`FFmpeg.on` appends, a preset job after an FFmpeg export would have driven the export progress bar.
Both sites now register and remove symmetrically.

**Failures carry FFmpeg's own words.** A non-zero exit pulls the last two meaningful stderr lines —
skipping the `frame=`/`size=` progress spam — into the notice, so "It said: No such filter:
'deflicker'" reaches the user instead of an exit code.

**Scope taken deliberately:** presets are offered on video assets only. Every recipe in the source
assumes a `-vf` chain, and offering them on an audio or image asset would be offering a failure.
The GIF preset is kept but flagged — its output joins the library as an image, so the timeline uses
one frame of it; it is for sending somewhere else, not for editing with.

### Phase 16a — the same presets over a timeline excerpt

Asked for immediately after the phase landed, and it turned out to be the cheap half of the
feature: a split does not copy media, it moves two numbers ([`BaseClip.sourceTrimIn/Out`]), so a
clip *already is* an excerpt description. Nothing had to be measured, cut or staged.

**Four arguments in front of an unchanged recipe.** `-ss` before `-i` so FFmpeg seeks the input
instead of decoding the whole file and discarding most of it; `-t` after it to cap the output.
Frame-accurate without compromise, because every one of these presets re-encodes anyway. The
recipe that follows sees material starting at t = 0, which is exactly what the time-dependent
filters need — `echo-effect`'s `hue=h=180*sin(t)`, the drifting crop, the fades all restart with
the cut rather than inheriting an offset from where it happened to sit in the file.

**The cost argument is the real one.** These estimates scale with material, so Stabilize over the
six seconds that need it is 3 minutes instead of the 2 hours the four-minute file would have cost.
That is the difference between a preset you use and one you read about.

**Building the command line moved out of the runner** so the harness can assert it. `runPreset`
imports the FFmpeg worker through a Vite-specific `?worker&url` specifier, which esbuild cannot
resolve for the Node check — so `commandLine()` lives in `presets.ts`, is pure, and section 14
pins down that the seek precedes the input, the cap follows it, the recipe's own arguments come
through byte-identical for all 29, and that no recipe smuggles in its own `-ss`, which ours would
silently shadow.

**A duration-aware preset is told about the cut, not the file.** `fade-in-out-1s` is the only one
that reads a length, and it now reads the excerpt's: fading out at 7s of an 8-second cut taken
from 100s into a 5-minute source, not at 299s where nobody would ever see it.

**Replacing the clip is offered, never assumed.** The processed excerpt always joins the library;
a checkbox additionally points the clip at it. The swap keeps everything that describes the *edit*
— position, effect chain, keyframes, placement, fades — and rewrites only what describes the
source, clamping fades to the new length and letting a video's audio flags follow the new file so
that `mute` leaves a clip which knows it has no audio. Deliberately: the library entry is added
*outside* the history entry, so undoing the replacement restores the clip without discarding a
file that took ten minutes to make.

**Three consequences are stated before the run rather than discovered after it:**

- **Time-lapse is the only preset that changes length** (8× shorter). The clip shrinks in place and
  a gap opens after it; nothing later on the track moves. Chosen over rippling because rippling
  silently relocates work elsewhere on the track, and over refusing because "make me a fast version
  of this cut" is a reasonable thing to want.
- **Reframing presets change the frame's shape**, and placements and masked regions are stored as
  fractions of the frame — so they stay put while the picture inside them moves. Warned about only
  when it applies: the clip is actually placed *and* the preset actually reshapes.
- **A GIF cannot stand in for a video clip.** It enters the library as an image, which is a
  different kind of clip. The checkbox disables itself and says so, and the store re-checks rather
  than trusting the dialog.

**Known and left alone:** detaching a clip's audio leaves a separate audio clip still pointing at
the original asset with the original trims, and replacing the video's source does not follow it.
That is arguably right — the detached audio is its own clip the user placed — but it is a real way
to end up with a processed picture over unprocessed sound, and it is not signposted anywhere.

### Phase 16b — the GPU route, and what it makes redundant

Asked next: could some of these run on the WebCodecs path instead of FFmpeg? The answer turned
out to be embarrassing in a useful way — **17 of the 29 already run on the GPU.** The effect
registry was written *from* these same filters in phase 9, and still says so in its own section
headers: `// ---- hqdn3d` above `denoise`, `// ---- edgedetect,negate` above `edgeDetect`.

| Preset | Already is |
|---|---|
| `black-white`, `enhance`, `sharpen`, `pixelate`, `edge-detect`, `horizontal-flip` | the `blackWhite` / `eq` / `sharpen` / `pixelate` / `edgeDetect` / `flip` effects |
| `cinematic-grade-letterbox` | the `cinematic` effect; the letterbox is the project frame |
| `denoise` | the `denoise` effect — spatial half only, as the registry already admits |
| `moving-window` | animated `crop` keyframes |
| `fade-in-out-1s` | the clip's own fade handles |
| `wide-walk`, the two force-aspects, the four resizes | project frame size and clip placement |

**So the missing piece was never a port — it was a bake.** `ExportSlice` is four fields, so
`bakeClip` hands the existing WebCodecs exporter a synthetic one-clip project and gets back a
file: same `GLCompositor` that drew the preview, same hardware encoder, no new rendering code and
no second implementation to drift out of agreement with the first. That last part is the whole
argument. A bake that re-implemented the effects would be a second renderer, and "what you see is
what you get" would become a thing to test for instead of a thing that is true.

**The surgery on the clip is where a bake can quietly go wrong**, so section 15 pins it down.
Everything describing the *picture* survives — the effect chain and its keyframes, the excerpt.
Everything describing the *edit* is dropped — placement and its keyframes, fades, transitions,
clip gain — because the clip the file replaces still carries all of it and would otherwise apply
each one twice. And when the bake does replace the clip, the chain comes off it, for exactly the
same reason; the notice says so rather than leaving someone to notice their footage got sharpened
twice.

**Deliberately not done: fast twins.** The tempting version of this is to give the 17 duplicated
presets a GPU implementation and quietly prefer it. That would break the one property phase 16 was
built around. A shader `eq` is not `eq=contrast=1.1` — FFmpeg filters in YUV, the compositor works
in RGB, and they disagree in the shadows. Same preset name, two different files depending on the
machine, no way to tell which one you got. So the table *records* the equivalent
(`ToolPreset.gpu`) and the dialog offers it — naming the effect, saying where it stops short,
and, on a clip, adding it for you — while the FFmpeg command line stays exactly as recorded for
anyone who wants that specific tuning. Advice, not substitution.

**The twelve that keep FFmpeg, and why**: `minterpolate` (60/120 fps) and `deshake` need motion
estimation; `deflicker` needs a seven-frame window; `echo-effect` needs a feedback buffer — the
same tier D cut from phase 21; `reverse` needs the whole clip in memory; `time-lapse` needs a
pitch-preserving `atempo`; `to-gif` has no WebCodecs encoder to target; `rotate-90` has no
rotation in the renderer; and `x264-slow`, `x264-web-saas` and `mute` exist *for* x264's rate
control, which is the one thing a hardware encoder will not reproduce.

### DOD

Unticked: every item needs real files through real FFmpeg, which is the browser check.

- [ ] Each preset produces a playable output added as a new library asset, with the source
      left untouched.
- [ ] Progress is reported and cancellation actually stops the job.
- [ ] A preset expected to be slow warns with an estimate before starting.
- [ ] Failures surface the FFmpeg error rather than failing silently.
- [ ] A clip made by splitting processes only its own excerpt, and the result is that long.
- [ ] Replacing the clip keeps its effects, keyframes and placement, and undo puts the
      original back while leaving the processed file in the library.
- [ ] A bake of the same look finishes in a fraction of the preset's time and looks the same
      as the preview did.
- [ ] Baking with replace on takes the effects off the clip, and the picture does not change.

---

## Phase 17 results

The camera is a fourth capture source. The encoding really was nearly free — phase 15's
`SourceEngine` seam takes any video track, so `{ kind: 'camera', stream, video: true }` in the
session's plan is the whole of it — and everything that took work was one of the four things the
plan predicted: honesty about the negotiated format, a source that can end mid-take, placement
that composites, and the project's own frame rate.

### A bug the phase found in code that was already shipped

`QUALITY_HIGH` — what the recorder asked mediabunny for — derives a bitrate from **pixel count
alone**. Its formula has no frame-rate term at all:

```js
const scaleFactor = Math.pow(pixels / referencePixels, 0.95);
const baseBitrate = referenceBitrate * scaleFactor;   // referenceBitrate = 3 Mbps at 1080p
```

Moving the screen from 30 to 60 fps would therefore have spread the same budget over twice as
many frames — the picture getting *worse* precisely because the capture got smoother, which is
the opposite of what asking for 60 was meant to buy. `captureVideoBitrate` puts the rate in
explicitly, as a square root rather than linearly: consecutive frames at 60 are more alike than
at 30, so doubling the rate costs about 40% more bits, not 100%. The spatial half is deliberately
mediabunny's own curve, so **720p30 still encodes at exactly 2,777,000 bps** — this change moves
nothing that was already right, which is asserted rather than asserted-to.

| | 30 fps | 60 fps |
|---|---|---|
| 1280 × 720 | 2.78 Mbps (unchanged) | 3.93 Mbps |
| 1920 × 1080 | 6.00 Mbps (unchanged) | 8.49 Mbps |

### The inset's height is derived, never chosen

`GLCompositor.drawSource` stretches a clip's crop into its frame — there is no letterboxing
*inside* a transform. So a constant PiP rectangle would squash any camera whose shape did not
match it, by a few percent, in the one part of the frame everybody looks at.
`pictureInPictureTransform` takes the width as given and computes the height from the source's
aspect and the project's, so a 4:3 webcam gets a taller box rather than a stretched face. The
same argument makes the margin pixels rather than fractions: 24 thousandths of a 1920-wide frame
and of a 1080-wide one are not the same distance from the corner.

Everything it produces is ordinary clip data. The camera arrives framed and is then movable,
resizable and removable exactly like a transform dragged out by hand.

### A source can now end mid-take

Nothing listened to `track.onended` before, so unplugging a webcam — or pressing Chrome's
"Stop sharing" bar — left a session that still looked alive, still counted elapsed time, and
yielded a truncated file with no explanation. `endSource` now finishes that one source cleanly:
its file is closed and playable, the reason goes on its sidecar, it stays visible in the panel
with the bytes it wrote, and **every other source records on undisturbed**. If it was the last
live one, the session winds itself up rather than waiting for a Stop press that is not coming.

The bookkeeping that makes this safe is small and worth naming: sources that ended early are held
in `finished` and merged back in `stop()`, so they still get an offset measured against the same
earliest-source clock and still reach the timeline. `cancel()` deletes them too — discard means
discard, including the half of the take that stopped by itself.

### Two frame rates, and the gap between them

`getSettings()` reports what the track *negotiated* and goes on reporting it even when the camera
quietly halves its output: in dim light a driver lengthens exposure and delivers 30 while still
calling itself 60. No constraint can fix that. So the panel shows the delivered rate — counted
over a rolling two-second window, not averaged over the take, because a camera that fell to 30
five minutes in would otherwise read as 45 for the rest of the session and never recover on
screen — beside the negotiated one, and marks it when the two diverge. `1280 × 720 · 60 fps · 31
delivered` is a sentence telling someone to turn a light on.

### When the machine cannot keep up, the camera is what gives way

1080p60 screen plus 720p60 camera is the case most likely to drop frames. `considerDegrading`
watches the same poll the meters run on, and if more than 15 frames are lost inside five seconds
it halves the *camera's* frame rate — the screen is the content, the inset is the face. That is a
real reduction in load rather than a nicer-looking count: fewer frames are pulled off the track at
all, so the encoder is asked for less instead of asked to drop more. It happens once per session,
and the panel says it happened.

### The project's frame rate, and the edit it must not make

Capturing 60 into a 30 fps project throws half the frames away at export. But forcing the project
to 60 re-quantizes the edges of every clip already on the timeline — a destructive edit arriving
as a side effect of pressing Stop. `frameRateDecision` adopts the rate only where there is nothing
to damage: an empty timeline still on the default 30. A project with clips, or one deliberately
set to something else, is left alone and told about it instead. Either way the clip holds every
recorded frame and renders at the project's rate until the user decides otherwise in phase 19's
settings dialog.

It rides in the *same* commit as `Add recording`. Undoing a recording one track — or one setting —
at a time would be a strange thing to make someone do.

### Deviations from the plan as written

- **The plan said the camera preview is for before the take.** It is also shown *during* it, from
  the session's own stream rather than a second `getUserMedia` — a camera can only be opened once,
  and a preview that fought the recorder for the device would fail exactly when it mattered. The
  device picker and the mirror note stay idle-only.
- **The size estimate** the plan asked for is computed from the formats actually negotiated
  (`estimatedBytesPerSecond`) rather than from a fixed number, and is shown as bytes per hour
  during the take. 1080p60 + 720p60 + two audio tracks lands between 2 and 3 GB per half hour,
  which the harness asserts as a band rather than a figure.
- **`enumerateDevices()` labels** are blank until a camera permission has been granted once, so
  the picker names them `Camera 1`, `Camera 2` and re-reads the list the moment the preview opens.
  A remembered `deviceId` that has since been unplugged is dropped rather than requested: as an
  `exact` constraint it is an `OverconstrainedError`, and as an `ideal` one it silently opens a
  different camera than the panel is showing.

### Known gaps

- **Mirroring is preview-only, as designed**, and there is no one-click "flip it" on the clip —
  the horizontal-flip effect is there, but the panel does not offer to add it.
- **The camera's own microphone is never recorded.** Ticking camera and mic captures the voice
  once, through the mic. A camera with a better microphone than the system default cannot be used
  as one without picking it as the microphone.
- **`considerDegrading` only ever reduces.** It does not restore 60 fps when the load passes, so a
  brief spike costs the rest of the take. Restoring would need hysteresis and a reason to believe
  the spike is over; neither is worth guessing at without a measurement.

### DOD

Unticked: every item needs a real camera, real hardware load and the app on screen.

- [ ] A screen + camera + mic recording produces three files on three tracks, aligned
      within one frame — the phase-14 clap test extended to four sources.
- [ ] The camera clip is placed above the screen clip with a PiP transform, and composites
      identically in preview and export.
- [ ] The panel shows the format the camera actually granted; a downgraded 60 fps request
      is visibly different from what was asked for.
- [ ] Both video sources record at 60 fps where the hardware allows, and a camera that only
      offers 30 records at 30 rather than failing to open.
- [ ] The delivered frame rate is shown alongside the negotiated one, and the two visibly
      diverge when the camera is starved of light.
- [ ] 1080p60 screen + 720p60 camera for 10 minutes: both sources under 1% dropped frames,
      neither writer behind, heap inside the phase-15 band. If the load does not hold, the
      camera is what degrades and the panel says so.
- [ ] A 60 fps recording dropped onto an empty default project leaves the project at 60 fps,
      and one dropped onto a project with existing clips does not change it.
- [ ] Unplugging the camera mid-recording finalizes that source into a playable file with a
      stated reason, while the screen and mic recordings continue and end normally.
- [ ] A camera held by another application produces an error naming that cause, and the
      remaining sources still record.
- [ ] The recorded file is not mirrored; the record-panel preview is.

---

## Phase 18 results

Two controls removed, one added, as planned. `.transport-scrub` is gone from the transport bar
and `HorizontalScrollbar` is gone from `Timeline.tsx`; `Minimap.tsx` occupies the grid slot the
scrollbar had, with the geometry in `utils/minimap.ts` so it can be asserted rather than looked
at.

### The window is the thumb

The decision that made this one control instead of two: the strip is drawn over the *drawn
span* — `getTimelineSpan()`, content plus the four-second tail — not over the project duration.
That is exactly the range `clampScroll` allows, so the window can reach the right edge of the
strip precisely when the lanes are scrolled as far as they go, and the region past the last clip
shades on the minimap at the same time it shades in the lanes. Had the strip spanned the
duration instead, the window would have run off the end at maximum scroll and the two readings
of "past the end" would have disagreed by four seconds.

`viewportWindow` and `scrollForWindowX` are each other's inverse, which is what keeps a long
drag from creeping: dragging the window to where it already is returns the scroll position it
already had.

### A minimum window, and why it is not a minimum thumb

At 200 px/sec over thirty minutes the lanes show 1000 of 360,000 content pixels — 2.5 px of a
900 px strip. The window is floored at 14 px so it stays grabbable. The old scrollbar floored
its thumb at 32 px for the same reason, but the floor mattered less there because a thumb only
had to be draggable; here the floor also decides which gesture a press starts, and a press
inside a 2.5 px window would have been unhittable.

That gesture choice is made from the geometry, not from the event target: the window element is
`pointer-events: none` and `onPointerDown` compares the press against the same
`viewportWindow()` result that drew it. A press cannot land on a window that is not where it
looks.

### Sub-pixel clips

At half a pixel per second a one-second clip rounds to nothing, and a project of five hundred
short cuts would draw as an empty strip — the opposite of the truth about it. `packBars` widens
every span to at least a pixel and *then* merges whatever touches, so those five hundred clips
become one 500 px run of occupied timeline. The merge is adjacency only: two clips with real
space between them stay two bars. Packing 500 clips measures in single-digit milliseconds, well
inside a frame, and it happens on clip/track/span change rather than per frame.

### What rides React and what does not

The clip rectangles are a canvas redraw keyed on `[clips, tracks, span, duration, width]`. The
playhead marker and the viewport window share one transient store subscription and write
`transform` directly, exactly as `PlayheadLine` does — so playback moves the minimap without
re-rendering a single clip component, and follow-playhead scrolling moves the window through
the same path.

Colours are read from the element's computed style (`--clip-video`, `--clip-audio`, `--bg`,
`--border`) rather than hardcoded, so the strip cannot drift from the lanes' palette.

### Deviations from the plan as written

1. **Wheel zoom centres rather than anchors.** Over the lanes, `zoomAt` keeps the time under
   the cursor pinned to the cursor. Over a strip showing the whole project, the time under the
   cursor is usually not on screen at all, so pinning it is meaningless — the minimap zooms
   about that time and brings it to the middle of the lanes instead.
2. **Double-click works anywhere on the strip**, not only on the window. Restricting it to the
   window would have made "fit the project" unavailable exactly when the window is a 14 px
   sliver, which is when it is most wanted.
3. **A click seeks *and* scrolls.** The plan's table lists click as "seek there". A seek that
   left the lanes where they were would have made the one zoom-independent control land the
   playhead somewhere the lanes are not looking, so the lanes centre on the destination — on
   the playhead as `setPlayhead` clamped it, not on the raw click time.

### Known gaps

- The strip collapses all video tracks onto one row and all audio onto another. A project
  where two video tracks matter separately reads as one. That is the deliberate trade in the
  plan — recognition, not editing — but it is a real limit.
- Nothing distinguishes selected clips on the minimap.
- Vertical scrolling still has no equivalent control; the lanes scroll vertically by wheel
  alone, as before.

### DOD

- [ ] `.transport-scrub` and `HorizontalScrollbar` are both gone, replaced by the one strip.
- [ ] Zoomed to sub-frame in a thirty-minute project, one click near the far end of the
      minimap seeks there, and the viewport window lands with it.
- [ ] Dragging the window pans the lanes, and panning the lanes moves the window. The two
      never disagree, whichever one was touched.
- [ ] The playhead animates on the minimap during playback without re-rendering the clip
      components — checked the same way the playhead line was.
- [ ] Clips appear at their real positions, and the region past the last clip is shaded to
      match the lanes.
- [ ] Frame-step keys still work immediately after clicking the minimap. The slider used to
      swallow them.
- [ ] A 500-clip project redraws within one frame, with sub-pixel clips merged rather than
      dropped.

---

## Detached audio, when a clip's source is replaced

Not a phase — a gap found while reviewing what was left, and closed here.

`detachAudio` records no link. It puts an audio clip on an audio track carrying the video
clip's asset, trims and start, and switches the video clip's own audio off. So the
relationship between the two clips is a *shape*, not a field. `replaceClipSource` swapped only
the clip it was given, which meant a preset run with "put the result on the timeline in this
clip's place" could leave a processed picture over the original sound — silently, because both
clips were individually doing exactly what they had been told.

Four presets make that visible rather than academic: `mute` (`-an`) left the stripped clip
still audible, `time-lapse` (`durationScale: 0.125`) left the sound eight times too long,
`reverse-playback` (`-af areverse`) left it running forwards under a backwards picture, and
`fade-in-out-1s` (`-af afade`) left the fade off the sound.

### The rule

`utils/detachedAudio.ts` separates two cases that need different handling, guarded by
`hasAudio && !audioEnabled` — a video still playing its own sound has not been detached,
whatever else is on the audio tracks:

- **following** — an audio clip playing the exact range of the exact file the video plays,
  which is what detaching leaves behind. There is nothing in it to lose, so it can be re-cut.
- **strayed** — the same file, overlapping in time, but a different range. It has been trimmed
  since, so it is a separate element now; re-cutting it would throw that trim away. It is left
  alone and named in the notice.

An unrelated second use of the same asset elsewhere on the timeline is neither.

### Who decides whether to follow

The producer, not the clip — because whether the new file's sound stands in for the old one is
a property of what was run:

- **Presets:** `presetChangesSound(preset)`, read off the verbatim args (`-af`, `-an`, a
  `durationScale`) rather than carried as a hand-set flag. A preset that grows an audio filter
  later is covered the day it is transcribed. A picture-only preset leaves the original file's
  audio correct, so nothing needs to move.
- **Bake:** never. `bakeClipOf` keeps `audioEnabled`, which on a detached clip is `false`, so
  the bake writes a silent file — following would mute the detached audio.

Both halves of the swap happen inside the one `commit`, so one user action is still one undo
entry.

The `ProcessDialog` says which of the three outcomes applies *before* the run, next to the
replace checkbox, and `replaceClipSource`'s notice says which one happened afterwards.

### DOD

- [ ] Detach a clip's audio, run **Strip audio** with replace on: the clip goes silent and
      the detached clip goes silent with it.
- [ ] The same with **Time-lapse (8×)**: both clips end up one eighth as long and stay in sync.
- [ ] Detach, then trim the audio clip, then run **Strip audio**: the audio clip is left alone
      and both the dialog and the notice say so before and after.
- [ ] Detach, then run **Sharpen**: nothing happens to the audio clip and the dialog explains
      that the original file carries the same sound.
- [ ] Undo after any of the above restores both clips in one press.
- [ ] Bake a clip whose audio is detached: the detached clip keeps playing the original file
      rather than going silent.

---

## Media keys, and what they were reaching

Reported from use: add a video, delete it, press the keyboard's play key — and it plays.

Two independent defects, both of which had to hold for it to happen.

**Nothing claimed the media session.** With no `navigator.mediaSession` action handlers
registered, Chrome's default for the play key is to resume the page's most recently played
media element directly. In an editor that is never right: those elements are the engine's
private decoders, one per asset, held in `MediaElementPool` and driven against the project
clock. Resuming one plays a file from wherever it was abandoned, with `PlaybackEngine.playing`
still `false` — so no `tick` runs, the playhead does not move, nothing is drawn, and nothing
ever stops it. `preview/mediaSession.ts` now claims `play`, `pause` and `stop` and points them
at the same store actions the transport buttons call. `stop` deliberately does not rewind: the
playhead is an edit position, not a track position.

**The stopped path never retired anything.** `syncAudio` is what disconnects a gone clip's
gain node and hands the pool the frame's demand — and it is only reached while playing.
Deleting a clip with playback stopped went through `renderFrameAsync`, which draws and
returns. So the deleted clip's gain node stayed connected to the destination and its element
stayed at full volume, paused. Nothing inside the app could sound it, which is exactly why it
survived: it took something outside the app resuming that element to make it audible.
`seek()` now calls `retire()` first, which sweeps routes whose clip is gone and settles the
pool with an empty listening set — nothing is audible while stopped, by definition.

Fixing either one alone would have hidden the report without closing it. The first stops the
keys reaching an element at all; the second means that if anything else ever does, it finds a
silenced, disconnected one.

### DOD

- [ ] Import a video, delete the clip, press the play key: nothing sounds, and the transport
      starts the (now empty) project rather than a file.
- [ ] With clips on the timeline, the play key plays and pauses the project, and the OS media
      control shows the right state.
- [ ] Playing, then pausing from the OS control, leaves the transport button showing paused.
- [ ] Deleting a clip mid-playback still stops its sound, as before.
