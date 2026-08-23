# UX Improvement Plan

> Continued in [`capture-effects-plan.md`](./capture-effects-plan.md) — phases 7–16:
> screen/mic/system recording, WebGL effects and shaders, fades and transitions,
> keyframed dynamic masks, and library batch tools.

Five significant UX improvements for the browser AV editor, in dependency order.
Refactoring is unconstrained; the only hard invariant is that **preview and FFmpeg
export must agree** at every phase boundary.

> **Status (2026-08-15):** phases 0–5 are implemented and verified in a real browser
> (import → layer stack → unified A/V → viewport → history → snapping → FFmpeg export
> with audio). Phase 6 — drag-and-drop placement and project persistence — is not
> started. Two defects surfaced during verification and were fixed along the way:
> the export's `ffprobe`-based audio detection aborts in the bundled WASM core (it
> reported *no audio* for every file), and thumbnail seeks resolved on a fixed timeout,
> capturing black frames. See "What changed against this plan" at the end.

---

## Current state: what's actually wrong

Findings from reading the codebase, not guesses:

| Area | Evidence | Symptom |
|---|---|---|
| Timeline viewport | `.timeline-scroll { overflow: auto }` (`src/styles/theme.css:428`), no wheel handler anywhere | Timeline pans with browser scroll, no zoom-at-cursor, no playhead follow, page can scroll under you |
| Track labels | Labels live inside each row inside the h-scrolled inner (`src/components/Timeline/TrackLane.tsx:27`) | Scroll right and you lose all track identity |
| Tracks are decorative | Export layers by clip *property*, not track: `baseVideoClips` / `overlayVideoClips` / `imageClips` / `textClips` (`src/export/buildFilterGraph.ts:63-72`); playback does the same via `layer()` (`src/preview/PlaybackEngine.ts:139-145`) | 5 default lanes promise a structure the renderer ignores. Moving a clip between "Overlay 1" and "Overlay 2" changes nothing visually |
| Default track soup | `defaultTracks()` ships 2 overlay + 1 video + 2 audio before any media exists (`src/store/editorStore.ts:28-36`) | Empty project already looks cluttered and implies rules that don't exist |
| A/V split on import | `buildClipsForAsset` makes two independent clips and sets `muteAudio: true` on the video (`src/store/clipFactory.ts:106-143`) | Move / trim / split / delete the video and its audio stays behind. Silent desync |
| No vertical clip drag | `moveClip` only writes `timelineStart` (`src/store/editorStore.ts:374`) | Clips can never change track after placement |
| No undo | No history anywhere in the store | One Delete keystroke is unrecoverable |
| Overlap free-for-all | `moveClip` has no collision check | Clips stack invisibly; export order becomes arbitrary |
| Blind snapping | `snapTime` quantizes to a fixed 0.1s grid (`src/utils/time.ts:20`), unrelated to fps | Off-by-a-frame edits, no edge/playhead magnetism, no visual feedback |
| Ruler can't be dragged | `Ruler` has `onClick` only (`src/components/Timeline/Ruler.tsx:23`) | No scrubbing — click-to-jump only |
| Empty-lane click seeks | `TrackLane` `onClick` → `onSeek` (`src/components/Timeline/TrackLane.tsx:51`) | Clicking to deselect moves the playhead instead; blocks marquee selection |
| Playhead re-renders everything | `onTime` → `setPlayhead` every RAF (`src/components/PreviewPanel.tsx:33`) | Whole timeline re-renders ~60×/s during playback |
| Trim drift | Trim applies incremental deltas and rewrites `startX` each move; left-trim force-moves the playhead (`src/store/editorStore.ts:382-415`) | Float accumulation, playhead jumps while trimming |
| Nothing persists | Blob URLs + in-memory store only | Reload = project gone, no warning |

---

## Improvement 1 — Timeline as a real viewport (not a scroll div)

**Goal:** the timeline owns its own pan/zoom state and never rides browser scroll.

### Layout restructure

```
.timeline
├── .timeline-toolbar        zoom controls, fit, snap toggle, track ops
└── .timeline-body           CSS grid: [headers 168px] [viewport 1fr]
    ├── .track-headers       vertical scroll synced; NEVER moves horizontally
    └── .lanes-viewport      overflow:hidden; scroll state owned by JS
        ├── .ruler           sticky top, scrubbable
        └── .lanes-inner     width = duration × pxPerSec, translated by -scrollX
```

Track headers move out of `TrackLane` into a sibling `TrackHeader` column so they
stay pinned. Row heights come from a shared `track.height` so the two columns stay
aligned.

### New `useTimelineViewport` hook

Owns `{ scrollX, scrollY, pxPerSec }` and exposes `timeToX`, `xToTime`, `zoomAt`.

- Wheel listener attached via ref with `{ passive: false }`, `preventDefault()`
  unconditionally inside the timeline — the page never scrolls.
- `Cmd/Ctrl + wheel` **and trackpad pinch** (browsers deliver pinch as
  `ctrlKey` wheel) → geometric zoom anchored under the cursor:
  `t = xToTime(cursorX)` before, then `scrollX = t·pxPerSec' − cursorX` after.
- Plain wheel → pan: `deltaX` scrolls time, `deltaY` scrolls tracks.
  Two-finger trackpad panning works in both axes for free.
- Hold **Space** (or middle-button) + drag → grab-pan, `cursor: grabbing`.
- Zoom range becomes geometric, ~2 px/s (whole hour visible) to ~1000 px/s
  (sub-frame). Replaces the linear 20–400 slider.

### Navigation commands

| Input | Action |
|---|---|
| `Cmd/Ctrl + =` / `-` | Zoom in/out around the playhead |
| `Shift+Z` | Fit project to viewport |
| `Z` | Zoom to selection |
| Drag on ruler | Scrub (pointer capture, continuous) |
| Drag playhead handle | Scrub from anywhere vertically |
| `Home` / `End` | Jump to project start / end |

### Playhead follow

Page-scroll mode: while playing, when the playhead crosses 85% of the viewport
width, jump so it sits at 15%. Manual panning during playback disengages follow
until playback restarts or the follow toggle is re-armed.

### Performance fix (required, not optional)

The playhead must stop flowing through React state at RAF rate. Keep `playhead`
in the store but have the timeline subscribe *transiently*
(`useEditorStore.subscribe`) and move the playhead line with a direct
`style.transform = translateX(...)` write. Clip components then re-render only on
real edits. Without this, every improvement below feels laggy at 60fps.

### Panel sizing

Replace the hardcoded `.timeline-panel { height: 240px }` with a draggable
splitter between preview and timeline, min 120px, remembered in `localStorage`.

**Touches:** `Timeline.tsx`, `Ruler.tsx`, `TrackLane.tsx` (split into
`TrackHeader` + `TrackLane`), new `useTimelineViewport.ts`, `theme.css`,
`App.tsx` (splitter).

---

## Improvement 2 — Tracks become an ordered layer stack

**Goal:** what you see in the track order *is* the compositing order.

### Model

```ts
export type TrackKind = 'video' | 'audio';   // 'overlay' is deleted

export interface Track {
  id: string;
  kind: TrackKind;
  label: string;          // renameable: "V1", "B-roll", "Music"
  height: number;         // px, drag-resizable per track
  muted: boolean;
  solo: boolean;
  hidden: boolean;        // video tracks
  locked: boolean;        // blocks edits, allows selection
  volume: number;         // audio tracks, 0–1.5
}
```

`tracks` is stored in **UI order, top to bottom**: video tracks first (topmost
first), then audio. Compositing walks video tracks bottom-up. A new project
starts with exactly **V1 + A1**.

### Clips lose their layering flags

`overlayMode` disappears. Every visual clip (`video` | `image` | `text`) carries
an optional `transform?: OverlayTransform`:

- `undefined` → full-frame fit-and-letterbox (today's base-layer behavior)
- set → crop + placement (today's PiP behavior)

"PiP" stops being a checkbox and becomes what it actually is: *a clip on a higher
video track with a transform*. The Inspector shows the transform editor for any
visual clip, plus a "Reset to full frame" action.

### Placement rules

- video / image / text clips → video tracks only
- audio clips → audio tracks only
- dropping onto an incompatible track is rejected with a clear drop-cursor state
- text clips no longer get a magic "overlay" lane; they land on the topmost video
  track by default

### Export refactor (`buildFilterGraph.ts`)

Replace the four kind-filtered passes with **one ordered pass**:

```
sort clips by (video track index, bottom-up) then timelineStart
for each clip: chain onto videoLabel as trim → crop/scale → overlay(enable=…)
  - no transform  → scale=W:H:force_original_aspect_ratio=decrease + pad (as today)
  - transform     → crop + scale + overlay at frame x/y (as today's PiP path)
  - text          → drawtext onto current videoLabel at its stack position
```

This is mostly a re-ordering of filter strings that already exist and are proven,
so risk is contained. The win: text under a PiP, or a logo above everything,
becomes expressible — today text is always drawn last regardless of intent.

`PlaybackEngine.sortedClips()` gets the same ordering function so preview and
export share one source of truth. Extract it as
`src/utils/compositeOrder.ts` and have both import it — that's the guarantee they
can't drift.

### Track operations (all new)

Add / delete (with clip-loss warning) / rename inline / reorder by dragging the
header / mute / solo / hide / lock / drag-resize height / collapse to a thin
strip. Header shows a live meter position for audio tracks.

**Touches:** `types/editor.ts`, `editorStore.ts`, `clipFactory.ts`,
`buildFilterGraph.ts`, `PlaybackEngine.ts`, `Inspector.tsx`, new
`TrackHeader.tsx`, new `utils/compositeOrder.ts`.

---

## Improvement 3 — One clip for video + its audio

**Goal:** importing a video produces **one** object that moves, trims, splits and
deletes as one.

### Model

```ts
export interface VideoClip extends BaseClip {
  kind: 'video';
  assetId: string;
  hasAudio: boolean;          // from probe, immutable
  audioEnabled: boolean;      // replaces the inverted `muteAudio`
  gain: number;               // per-clip, 0–1.5
  hideVideo: boolean;
  transform?: OverlayTransform;
}
```

`buildClipsForAsset` creates **one** clip for a video asset. The paired
`AudioClip` construction (`clipFactory.ts:122-141`) is deleted.

### On the timeline

A video clip with audio renders as a split block: filmstrip in the upper ~60%,
waveform ribbon in the lower ~40%, divider line between. `ClipFilmstrip` and
`ClipWaveform` already exist and only need to be stacked and given heights
derived from `track.height`.

### Detach audio

`detachAudio(clipId)` — Inspector button and right-click menu:

1. creates an `AudioClip` on the first audio track with no overlap (creating one
   if needed), same `timelineStart` / `sourceTrimIn` / `sourceTrimOut`
2. sets `audioEnabled: false` on the video clip
3. one undo step; the two are independent afterwards (that is the point)

This preserves the current capability — per-lane audio volume, sliding audio
against picture — as an explicit act rather than the default.

### Audio path

- Preview: `PlaybackEngine.clipHasAudio` reads `audioEnabled`; final gain =
  `clip.gain × track.volume × (track.muted ? 0 : 1)`, with solo respected.
- Export: the audio branch already handles video clips with live audio
  (`buildFilterGraph.ts:156-175`); it gains the per-clip `gain` multiplier. Video
  clips sit on video tracks, so track volume no longer applies to them — per-clip
  gain replaces it.

### Inspector for a video clip

`Volume` slider · `Mute` · `Detach audio` (disabled when `hasAudio === false`) ·
`Hide video` · transform editor · source info (resolution, duration, fps).

**Risk to validate first:** `decodeWaveformPeaks` calls `decodeAudioData` on the
whole file (`src/utils/waveform.ts:36`). For MP4/MOV containers this is
unreliable across browsers — Chrome often decodes AAC-in-MP4, Firefox often does
not. Spike this in a day before committing to inline waveforms; fallback is
`WebCodecs` `AudioDecoder` with an `MP4Box` demux, or a flat "audio present"
ribbon with no peaks when decode fails. The waveform must degrade, never block
the clip from rendering.

**Touches:** `types/editor.ts`, `clipFactory.ts`, `editorStore.ts`,
`ClipBlock.tsx`, `ClipWaveform.tsx`, `PlaybackEngine.ts`, `buildFilterGraph.ts`,
`Inspector.tsx`.

---

## Improvement 4 — Undo/redo and edit safety

**Goal:** every destructive action is reversible; no edit silently corrupts state.

### History

Split the store into **document** (undoable) and **session** (not):

| Document | Session |
|---|---|
| `tracks`, `clips`, `settings`, `libraryOrder` | `playhead`, `isPlaying`, `selection`, viewport, `ffmpeg*`, `exportProgress`, notices |

`mediaLibrary` entries are add-only within a session — undoing an import removes
its clips, not the decoded asset (avoids re-probing and dead blob URLs).

Implement as a small zustand middleware: `past: Doc[]`, `future: Doc[]`, capped
at 100 entries, each with a human label ("Trim clip", "Delete 3 clips").

**Interaction coalescing is the part that's easy to get wrong.** Drags call
`beginInteraction(label)` on pointerdown and `endInteraction()` on pointerup;
intermediate `moveClip`/`trimClip` calls mutate without pushing history. One drag
= one undo step. Keyboard nudges coalesce if repeated within 500ms.

`Cmd/Ctrl+Z` undo · `Cmd+Shift+Z` / `Ctrl+Y` redo · toolbar buttons with the next
action's label in the tooltip · brief toast naming what was undone.

### Selection

`selectedClipId: string | null` → `selectedClipIds: string[]`.

- Shift/Cmd+click toggles
- marquee drag on empty lane space (this is why empty-lane click must stop
  seeking — see Improvement 1)
- click on empty space clears selection
- `Cmd+A` selects all on the focused track, again for all tracks
- all clip commands (move, delete, duplicate, split, nudge) operate on the set

### Overlap and collision

- Dragging shows a live ghost; an invalid drop (overlap, locked track,
  incompatible kind) renders red and is refused, snapping back on release.
- **Vertical drag changes `trackId`** — new capability, required now that track
  order means something.
- `moveClip` becomes `moveClips(ids, deltaTime, deltaTrack)` with a single
  validation pass so multi-clip drags stay rigid relative to each other.

### Deletion semantics

- `Delete` — lift, leaves a gap
- `Shift+Delete` — ripple delete, closes the gap on that track only
- deleting a track warns when it holds clips, and is undoable

**Touches:** `editorStore.ts` (largest change), new `store/history.ts`,
`ClipBlock.tsx`, `TrackLane.tsx`, `App.tsx` (keymap).

---

## Improvement 5 — Snapping and frame-accurate editing

**Goal:** edits land exactly where intended, at frame boundaries, visibly.

### Frames replace the arbitrary grid

`SNAP_GRID = 0.1` disappears. All edit math quantizes to `1 / settings.fps`.
Every `timelineStart`, `sourceTrimIn`, `sourceTrimOut` is frame-aligned, which
also removes a class of export mismatch where FFmpeg rounds differently from the
canvas preview.

### Snap engine (`src/utils/snapping.ts`)

Candidate targets, gathered per drag:

- playhead
- start/end of every other clip, on all tracks
- project start (0) and project end
- markers (once markers exist)

Threshold is **pixel-based** (~8px) converted to seconds through current
`pxPerSec`, so snapping feels identical at every zoom level. Nearest candidate
wins; a vertical accent line is drawn at the snap target while engaged.

Hold **Alt/Option** to bypass. Snap on/off toggle in the timeline toolbar (`N`).
Applies to clip drag, both trim edges, and the playhead itself.

### Keyboard precision

| Key | Action |
|---|---|
| `←` / `→` | Nudge selection 1 frame |
| `Shift+←/→` | Nudge 1 second |
| `,` / `.` | Step playhead 1 frame back/forward |
| `Shift+,` / `Shift+.` | Step 1 second |
| `I` / `O` | Trim selected clip's in/out to playhead |
| `S` | Split at playhead (keep) — now splits all selected clips |

### Timecode

Transport switches from `MM:SS.cc` to **`MM:SS:FF`** (frames — fps is known and
centiseconds are meaningless in a video editor). The field becomes an input: type
a timecode, press Enter, playhead jumps. Ruler tick density adapts to zoom, down
to individual frames when zoomed in far enough.

### Trim rework

Rewrite trim to absolute math from a drag-start snapshot
(`{ startX, startTrimIn, startTrimOut, startTimelineStart }`) instead of
per-move deltas with a rewritten `startX` (`editorStore.ts:382-415`). Removes
float accumulation. Left-trim stops force-moving the playhead
(`editorStore.ts:399`) — the trim *preview* in the canvas already covers that
need without hijacking the playhead.

**Touches:** `utils/time.ts`, new `utils/snapping.ts`, `ClipBlock.tsx`,
`Ruler.tsx`, `PreviewPanel.tsx`, `editorStore.ts`.

---

## Sequencing

Phases are ordered so each lands in a working editor.

| Phase | Content | Rough size | Why here |
|---|---|---|---|
| **0** | Waveform-from-MP4 spike; extract `compositeOrder`; playhead transient-subscribe perf fix | ~1 day | De-risks 3, unblocks 1 and 2 |
| **1** | Improvement 1 — viewport, headers, ruler scrub, splitter | ~2–3 days | Everything else is edited *through* the timeline |
| **2** | Improvement 2 — layer stack + export/preview reorder | ~3–4 days | Model change; do before behaviors pile on |
| **3** | Improvement 3 — unified A/V clip + detach | ~2–3 days | Depends on the track model of phase 2 |
| **4** | Improvement 4 — history, multi-select, collision, vertical drag | ~3–4 days | Wraps every mutation added above |
| **5** | Improvement 5 — snapping, frames, timecode, trim rework | ~2 days | Polishes the now-stable edit ops |
| **6** | Backlog: drag-drop from library/Finder onto a track+time; IndexedDB autosave + session restore | — | Valuable, deferred by your call |

Phase 6 is now done, in two halves. Persistence has its own document —
[`persistence-plan.md`](./persistence-plan.md) — where the storage question is settled
(OPFS, imports referenced rather than copied, offline media as a first-class state).

The drag-drop half shipped as drop-from-Finder onto a track and a time: `buildDropClips`
in `store/clipFactory.ts` (the placement rule, asserted in `check:math`), the
`useTimelineDrop` hook (the indicator and the `DataTransfer` reading), and
`dropFilesAt` in the store (one history entry per drop). Its one real design constraint is
that the time the pointer names is fixed while the lane is not — the same rule
`buildRecordingClips` follows, and for the same reason. Dragging *from the library* onto a
track is the remaining piece; the placement function it needs already exists.

**Verification at each boundary:** a fixture project (2 videos with sound, 1 image
PiP, 1 text, 1 music bed) exported before phase 2 and again after each phase —
frame hashes at 0.5s intervals plus an audio RMS profile must match. This is the
only reliable guard on the filter-graph rewrite; worth building as a script in
`scripts/` during phase 0.

## What changed against this plan during implementation

| Planned | Actually shipped | Why |
|---|---|---|
| Space-hold + middle-drag to pan | Middle-drag only | Space is play/pause; holding it to pan would start playback. Wheel panning plus the custom scrollbar covers the gap |
| Golden-file export check as a script in `scripts/` | Browser-driven verification (import → edit → export → `ffprobe` + `volumedetect` on the output) | Caught a real audio regression immediately; a committed fixture script is still worth adding for phase 6 |
| Waveform spike, fallback if `decodeAudioData` fails | Fallback shipped and is in use — MP4 audio does fail to decode in this setup | The flat ribbon path is live, not theoretical |
| — | **Fixed:** `fileHasAudioStream` used `ffprobe`, which aborts in the single-threaded WASM core and returned `false` for every file | Harmless before (video audio rode a separate audio clip), silently fatal after unification — it would have muted every video clip on export. Now parses `ffmpeg -i` output |
| — | **Fixed:** thumbnail seeks resolved on a blind 120 ms timeout | Produced black filmstrip tiles; now waits for `readyState >= 2` |
| — | Per-clip `gain` added to audio clips too, not just video clips | Track volume alone couldn't express "this one clip is too loud" |

## Assumptions made

- Per-clip gain replaces track volume for video clips, since video clips live on
  video tracks. Audio *tracks* keep their volume control.
- No project format migration is needed — nothing persists today. *(Superseded: see
  [`persistence-plan.md`](./persistence-plan.md), which introduces a versioned project file.)*
- `fps` stays a project setting (30 default); frame quantization uses it directly.
- Existing behavior kept intact: mic recording, URL import, frame capture,
  text templates, resolution presets, FFmpeg export path.
