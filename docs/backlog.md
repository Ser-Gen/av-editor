# Backlog

Everything this editor has been asked for, in one list, with what became of it.

The phased plans (`capture-effects-plan.md`, `persistence-plan.md`, `ux-plan.md`,
`audio-export-plan.md`, `media-info-plan.md`, `workflow-plan.md`) each answer *how* one body of
work was built. This file answers a different question — **what is left** — and it is the place
the next phase is chosen from. When an item here is picked up, it gets a phase number; when that
phase ships, it gets ticked and a pointer to the document that describes it.

| Mark | Meaning |
|---|---|
| `[x]` | Shipped. The plan doc named beside it has the design and the results |
| `[x]` | Scheduled, phase 1 of [`workflow-plan.md`](./workflow-plan.md) |
| `[ ]` | Wanted, not scheduled. The reason it is not in the next five is given |
| `[!]` | Not a code question — needs a decision from a person |

---

## Shipped

### Timeline and editing

- `[x]` Timeline viewport, track headers, ruler scrub, panel splitter — *ux-plan 1*
- `[x]` Layer stack: composite order shared by preview and both exports — *ux-plan 2*
- `[x]` Unified A/V clip, detach audio onto its own track — *ux-plan 3*
- `[x]` Undo/redo as document snapshots, multi-select, collision, vertical drag — *ux-plan 4*
- `[x]` Snapping, frame quantization, timecode, trim rework — *ux-plan 5*
- `[x]` Ripple delete on one clip, from the clip context menu — *ux-plan 4*
- `[x]` Drag and drop from Finder onto a track **and a time** — *ux-plan 6 / persistence*
- `[x]` Timeline minimap, replacing the scrub slider and the horizontal scrollbar — *capture 18*
- `[x]` Keyframe engine: animated effect parameters with linear / smooth / hold — *capture 10*
- `[x]` Cross-dissolve transitions — *capture 13*
- `[x]` Adjustment clips: a grade over everything below, for a time range — *capture 12*
- `[x]` Dynamic masked regions, keyframed — *capture 11*

### Rendering and export

- `[x]` WebGL2 compositor; one placement rule shared by all three render paths — *capture 7*
- `[x]` WebCodecs export, with FFmpeg WASM as the fallback — *capture 8*
- `[x]` Effect stack, shader library, fade handles — *capture 9*
- `[x]` Custom shaders: a Shadertoy fragment shader pastes in unedited — *capture 21*
- `[x]` Project settings; export settings with presets and an advanced panel — *capture 19, 20*
- `[x]` Audio-only export: MP3, M4A, OGG, FLAC, WAV, with per-format settings — *audio-export*
- `[x]` Metadata tag form, cover art from the library, written into every container — *audio-export*
- `[x]` Relative-based, unhashed build: `dist/` hosts from any directory of any static host

### Media library

- `[x]` Import once, add to the timeline many times; imported files are referenced, never copied
- `[x]` Offline media as a first-class state, with relink by fingerprint — *persistence*
- `[x]` Library batch tools: FFmpeg preset jobs producing new assets — *capture 16*
- `[x]` GPU bake of a clip's effect chain into a new asset — *capture 9*
- `[x]` File info window: container, per-track codec detail, decode verdict, tags, measure on
  demand — *media-info*
- `[x]` Import probe reads the container, so `hasAudio` and display size are right — *media-info*
- `[x]` Right-click menu on a library row, every action reachable on every file type

### Recording

- `[x]` Screen, microphone and system audio, streamed to OPFS, never buffered in RAM — *capture 14*
- `[x]` WebCodecs recording engine, fragmented MP4, MediaRecorder as the fallback — *capture 15*
- `[x]` Camera as a third source, aligned sub-frame, placed as PiP — *capture 17*
- `[x]` Crash recovery: a sidecar written before the first byte, orphans offered back — *capture 14*
- `[x]` Storage headroom shown in four places and counted down during a take — *persistence*

### Project

- `[x]` OPFS project file, debounced autosave, flush on `visibilitychange` — *persistence*
- `[x]` Files the app made are kept; files the user imported are recognised again — *persistence*
- `[x]` Folder bundle export/import for moving a project between machines — *persistence*

---

## Shipped — the five workflow phases

Design, DOD and results are in [`workflow-plan.md`](./workflow-plan.md).

### Phase 1 — Controls, and the editing commands that had no home

- `[x]` Remove the duplicated import buttons; one import, in the library
- `[x]` One export button; the FFmpeg path and preloading move into the export dialog
- `[x]` Group the top bar: history · add · project · export
- `[x]` Split the timeline toolbar, which currently mixes zoom with adding objects, into
  **View / Edit / Add**
- `[x]` `+ Text` leaves the top bar for the library
- `[x]` **Close gaps** — pull every clip on a track left until the holes are gone
- `[x]` **Ripple mode** — a toggle so trims, moves and deletes drag the rest of the track along

### Phase 2 — A library you can find things in

- `[x]` Group by type / origin / date added, with sort and a search box
- `[x]` Preview: hover-scrub the thumbnail, click for a full preview with transport
- `[x]` Download any library file as it is on disk, recordings included
- `[x]` Paste an image from the clipboard straight into the library

### Phase 3 — Recording you can steer while it runs

- `[x]` Mute the microphone mid-take, from a button, without breaking alignment
- `[x]` A recording control worth looking at: per-source level, elapsed, delivered frame
  rate, and per-source state in one place

### Phase 4 — Audio worth editing on its own

- `[x]` Volume envelope drawn on the clip's own waveform
- `[x]` Normalize, and match loudness across several clips
- `[x]` Audio effects: filters, EQ and pitch

### Phase 5 — The overlay layer: rich text and annotation

- `[x]` Text rasterized on a canvas in all three render paths, retiring `drawtext`
- `[x]` Real text styling: font, weight, colour, stroke, shadow, background box, alignment
- `[x]` More templates
- `[x]` Text becomes a library object, added to the timeline like any other media
- `[x]` Annotation clip: arrow, box, ellipse, freehand, callout — drawn on the preview

---

## Phase 6 — Annotation, finished (`docs/annotation-plan.md`)

Phase 5 shipped the annotation clip and no editor for it. These are the three things that
made it read as broken rather than unfinished, plus the one nobody had hit yet.

- `[x]` **Overlay textures never repaint.** `uploadTexture`'s `skipIfCached` returned the
  cached entry without uploading, so a text or annotation texture was frozen at its first
  draw. The flag is deleted. It was never annotation-specific: **editing a text clip's words
  repaints the preview now too**, which it never did.
- `[x]` **A mark cannot be edited after it is drawn** — there is a Select tool, handles,
  moving, reshaping, restyling, `Delete`, and a callout's label is editable both in the
  Inspector and by double-clicking it on the preview.
- `[x]` **An annotation cannot be placed or animated.** It places through the same
  `placeTexture` / `overlayTransformToPixels` as every other overlay, and animates through the
  placement stopwatch. FFmpeg freezes it at the midpoint and says so.
- `[x]` **Drawing while the playhead is off the clip** — the surface says the marks are not on
  screen and offers the playhead a way back.

---

## Phase 7 — Speed (`docs/speed-plan.md`)

The first edit that changes what a clip's *duration* means, which is why it waited for its own
phase rather than a corner of one.

- `[x]` **Constant speed per clip, 0.25×–4×**, from the Inspector, the context menu and an
  ⌥-drag on a trim handle. Pitch preserved by default, with a toggle to let it follow.
  Growing a clip follows the ripple mode.

---

## Wanted, not scheduled

- `[ ]` **Thumbnail and waveform cache in OPFS.** Filmstrips and waveforms are memory-only, so
  reopening a 40-clip project re-decodes every one, and an offline clip cannot re-derive them at
  all. Real value, no correctness weight — which is exactly why it loses to five things the user
  asked for out loud. *(persistence-plan "Later, not now")*
- `[ ]` **Named projects** — `projects/<id>/` with a picker. The file format is already shaped
  for it; the unanswered part is what happens to an asset two projects share, and that is a
  design question, not an afternoon.
- `[ ]` **A floating recording bar** over the app — dropped from phase 3 by your call; the
  Record panel got the controls instead. Worth revisiting the first time you lose a take
  because the panel was behind something.
- `[ ]` **An image editor in the library** — draw on an image asset and save a new derived file.
  Phase 5's annotation clip is the general case and subsumes most of it; this becomes "flatten
  that annotation onto this image" afterwards, which is much smaller.
- `[x]` **Keyframed annotation shapes** — one arrow tracking a moving subject independently of
  the others. Each mark carries its own poses in `pointKeys`; arm the ⏱ and drag.
  *(annotation-plan follow-up)*
- `[ ]` **Editing the marks of a *rotated* annotation.** Rotation is about the frame's centre
  in pixel space and the editing overlay works in normalized composition units; it refuses and
  says so rather than putting handles in the wrong place. *(annotation-plan known gap)*
- `[ ]` **A better pitch shifter.** The delay-line worklet is clean on speech and warbles on
  sustained musical material. A phase vocoder would fix it and is a self-contained job.
  *(workflow-plan phase 4 known gap. Phase 7 briefly leaned on this worklet to hold pitch
  while retiming and it mangled the export — retiming now stretches instead, in
  `utils/timeStretch.ts`, and the worklet is back to the small shifts it was built for)*
- `[ ]` **Speed ramps** — speed as a keyframed channel, easing into slow motion. The source-time
  mapping stops being a multiplication and becomes an integral of the speed curve, which every
  seek then has to invert numerically. *(speed-plan, deliberately out of scope)*
- `[ ]` **Reverse (negative speed).** A different problem from retiming: `<video>` cannot play
  backwards usefully, so the preview needs frame-by-frame seeking and the export needs a
  decoded buffer per clip. *(speed-plan, deliberately out of scope)*
- `[ ]` **Segment rotation while recording.** A single failure mid-capture costs one file rather
  than one segment. The flushed bytes always survive, so this is a size-of-loss improvement.
  *(capture-plan phase 14 known gap)*

---

## Known gaps that are decisions, not debt

Listed so nobody spends a week "fixing" a thing that was chosen.

- `[x]` **The Canvas2D fallback renders fades but not shader effects.** It shows the unfiltered
  clip and warns once. Reimplementing ten shaders against a 2D context, to serve a path that
  only runs when WebGL2 is missing, is not worth it. *(capture 9)*
- `[x]` **The FFmpeg fallback freezes each animated parameter at the clip midpoint.** A filter
  chain is static. The notice says so; the WebCodecs path — the default — animates correctly.
  *(capture 10)*
- `[x]` **Recovered recordings are placed at offset 0.** A recording rescued from a killed tab
  has no surviving session to align against. *(capture 14)*
- `[x]` **An interrupted WebCodecs recording loses up to one fragment**, about a second.
  Measured: 7.03s of 8.0s survived. *(capture 15)*
- `[x]` **`fileHasAudioStream` still re-probes in the FFmpeg export**, even though imports now
  read the container. Projects saved before that fix carry the old always-true guess, and the
  re-probe is what protects them. *(media-info)*

---

## Needs a person, not a commit

- `[!]` **Shader preset licensing.** `XtK3W3`, `MllSzj`, `tsfXWj` and `tsdXDB` are other
  people's work from Shadertoy, kept with their links and comments intact. Shadertoy's default
  is CC BY-NC-SA 3.0 unless the author says otherwise. Worth settling before this ships to
  anyone. *(capture-effects-plan.md, "Attribution")*
