# Speed: retiming a clip

## Phase 0 — record the plan

This file, written before any code change, joining the other plans of record. `CLAUDE.md`'s
plan-doc sentence gains it, and `docs/backlog.md` promotes "speed / time-stretch" out of
*Wanted, not scheduled* into phase 7.

## Context

Every clip plays at the rate it was recorded at. Retiming is the one editing operation this
app has no answer for at all — not a rough one, none — and it is the thing a screen recording
needs most often: four minutes of somebody filling in a form at 4×, a half-second reaction at
0.4×.

It has stayed in the backlog because it is the first edit that changes what a clip's
**duration** means. Everything else in the document either moves numbers between fields
(split, trim, duplicate) or adds a property that renders (effects, placement, marks). Speed
changes the relationship between timeline time and source time, which is the relationship
that `sourceTimeAt`, `clipDuration`, trimming, transitions, keyframes, the element pool, the
audio mixdown and both export graphs are all written against.

That is also why it is tractable: there is *one* relationship, stated in two functions.

```
duration(clip)   = (sourceTrimOut - sourceTrimIn) / speed
sourceTime(clip, t) = sourceTrimIn + (t - timelineStart) * speed
```

Get those two right and most of the app follows without knowing anything happened.

**Decisions taken with the user:**

| Question | Decision |
|---|---|
| Pitch | **Preserved by default, with a per-clip toggle to let it follow the speed.** Speech stays speech at 1.5× |
| Growth | **Follows the ripple mode.** Ripple on, the rest of the track makes room; ripple off, the clip grows into the free space and stops at its neighbour |
| Scope | **One constant speed per clip, 0.25×–4×.** Speed ramps and reverse stay in the backlog |

## The model

A **`speed`** on video and audio clips. Absent means 1, so a project saved before this opens
unchanged — the rule `PROJECT_FILE_VERSION` forces, since a version bump discards the whole
document.

Image, text and annotation clips do not get one. Their duration is already arbitrary — there
is no source clock to run faster — and "speed" on a title would be a control that does
nothing.

**The source range is what stays fixed.** Changing speed keeps `sourceTrimIn`/`sourceTrimOut`
and changes how long the clip occupies the timeline. The alternative — keeping the timeline
duration and changing the source range — is a different operation, needs source material that
may not exist, and is what ⌥-dragging a trim handle does instead (below).

**Frame quantization is preserved by moving the out point, not by rounding the speed.**
`(out - in) / speed` will not generally land on a frame boundary, and a clip whose duration is
not a whole number of frames is exactly what `utils/time.ts` exists to prevent. So
`setClipSpeed` quantizes the resulting *duration* and recomputes
`sourceTrimOut = sourceTrimIn + duration × speed`. The speed the user asked for stays the
number they see; the sub-frame difference is absorbed by the source range, where nothing can
observe it.

## Phase A — the maths, and the store

**`src/types/editor.ts`** — `speed?: number` and `pitchFollowsSpeed?: boolean` on `VideoClip`
and `AudioClip`. Both optional, both defaulted, neither versioned.

**`src/utils/time.ts`** — `clipDuration` divides by the speed. Its parameter type gains
`speed?: number`; every caller in the app already passes a whole clip, so this is the single
edit that carries speed into the timeline layout, the ruler, collision, snapping, the
minimap, the export duration and the audio mixdown's window loop.

**`src/utils/clipRender.ts`**

- `sourceTimeAt` multiplies the elapsed timeline time by the speed. Its `epsilon` clamp is in
  *source* seconds and stays that way.
- `sourceRangeFor(clip, fromTimeline, toTimeline)` — new, pure: the source interval a stretch
  of timeline maps to. The audio mixdown and the FFmpeg `atrim` both need it, and neither
  should restate the multiplication.
- `clipSpeed(clip)` — the one place `?? 1` is written, and the clamp to 0.25–4 lives.

**`src/utils/retime.ts`** (new, pure — `check:math` imports it)

- `SPEED_MIN`, `SPEED_MAX`, `SPEED_PRESETS` (0.25, 0.5, 1, 1.5, 2, 4).
- `retimeToSpeed(clip, speed, fps)` → `{ speed, sourceTrimOut, duration }`, with the
  quantization above.
- `speedForDuration(clip, duration)` → the speed that makes a clip last exactly that long —
  the inverse, and what the ⌥-drag rate trim needs.
- `roomAfter(clips, clip)` → how far a clip may grow on its track before it meets its
  neighbour, for the non-ripple clamp.

**`src/store/editorStore.ts`**

- `setClipSpeed(id, speed)` — retimes through `retimeToSpeed`, then either ripples the rest of
  the track by the delta (`rippleShift` from `utils/ripple.ts`, honouring `rippleScope`) or
  clamps the growth to `roomAfter` and reports the clamp. One `commit`, one undo entry, and
  coalescing on so dragging the slider is not fifty of them.
- `setClipPitchFollows(id, follows)`.
- `trimClipTo` — the trim edge maps through the speed: dragging a handle one second on the
  timeline consumes `speed` seconds of source. The existing bounds arithmetic is in source
  seconds and needs the conversion at exactly two places.
- **Rate trim**: `trimClipTo` gains an `alt` mode that holds the source range and solves for
  the speed instead, through `speedForDuration`.
- `splitSelectedAtPlayhead` — the split point maps through `sourceTimeAt`; both halves keep
  the speed. Already true if the split uses `sourceTimeAt`, which is what to verify.
- `detachAudio` — the detached clip carries `speed` and `pitchFollowsSpeed`, or the two halves
  drift apart the moment either is retimed. This is the same class of bug the ripple scope was
  built to prevent.
- `requantizeClips` (fps change) — the duration must land on a frame of the *new* rate.

**`scripts/checkProjectMath.ts`** — a section covering: duration and source-time at 0.5×, 1×
and 2×; that `sourceTimeAt` at the clip's end lands on `sourceTrimOut` for every speed;
`retimeToSpeed` producing a frame-exact duration at 29.97 and 25 fps; `speedForDuration` being
its inverse; the clamp at both ends of the range; `roomAfter` with a neighbour, without one,
and with a locked track; and that retiming an audio clip and its detached partner keeps them
the same length.

**DOD**
- [ ] A clip at 2× occupies half the timeline and shows the same frames, twice as fast.
- [ ] Every duration in the app agrees: ruler, snapping, minimap, project duration, export.
- [ ] With ripple on, retiming makes room; with it off, the clip stops at its neighbour and
      says so.
- [ ] Trimming a retimed clip lands where the pointer is.
- [ ] Splitting a retimed clip gives two clips that together play what the one did.
- [ ] A project saved before this opens with every clip at 1× and byte-identical layout.

## Phase B — the preview

**`src/preview/PlaybackEngine.ts`** — `element.playbackRate = speed` and
`element.preservesPitch = !pitchFollowsSpeed`, applied where the element is claimed for a
clip rather than once at creation. That last part matters: `mediaElements.buildKeys` gives two
clips of the same asset a *shared* element unless they overlap in time, so the rate has to be
set per use or a 2× clip would leave the rate behind for the 1× clip after it.

Seeking already goes through `sourceTimeAt`, so scrubbing is right for free. `nudgeElement`'s
drift tolerance is in source seconds and needs no change; the drift it corrects is now
`speed` times as fast in timeline terms, which is the correct behaviour.

**`src/components/Timeline/ClipBlock.tsx`** — the filmstrip and waveform map the trimmed
source range across the block's width, and both ends move together under speed, so this is
expected to need nothing. Verify rather than assume, and add a speed badge (`2×`) to the block
label when the speed is not 1.

**DOD**
- [ ] Playback, scrubbing and the transport all agree with the timeline.
- [ ] A retimed clip's audio is in sync with its picture at both ends of the clip.
- [ ] With pitch preserved, speech at 1.5× is intelligible; with the toggle off, it is a
      chipmunk. Both are what the export produces.
- [ ] Two clips of the same file at different speeds, back to back, both play at their own.

## Phase C — the WebCodecs export

**Video** samples the source at `sourceTimeAt` per output frame, so it follows phase A with no
change. Confirm by reading, and say so in the results rather than implying work happened.

**`src/export/webcodecs/audioMixdown.ts`** — the buffer source gets
`playbackRate.value = speed`, the decode range comes from `sourceRangeFor`, and
`source.start(when, offset, duration)`'s third argument is in *buffer* seconds, so it is the
source-range length rather than the timeline overlap. When the pitch is preserved, the
phase-4 pitch worklet corrects by `-12 × log2(speed)` semitones — the same node the pitch
effect uses, from the same module.

**The honest part.** There is no time-stretcher in an `OfflineAudioContext`. The preview gets
one free from the browser's `preservesPitch`; FFmpeg has `atempo`; this path has a crossfaded
delay line, which is clean on speech and warbles on sustained musical material. The export
will therefore sound slightly different from the preview on music at a non-1× speed. It is
written down here, in the README, and it moves the backlogged phase vocoder from "nice" to
"the fix for a known artefact".

**DOD**
- [ ] A retimed clip exports at the right length, in sync, in one pass.
- [ ] Pitch-preserved and pitch-following both export as previewed.
- [ ] A project mixing 0.5×, 1× and 2× clips mixes down with everything aligned.

## Phase D — the FFmpeg fallback

**`src/export/buildFilterGraph.ts`**

- Video: `trim=start=…:end=…` in source seconds (already), then `setpts=(PTS-STARTPTS)/speed`
  before the timeline shift. Order matters — the shift is in timeline seconds and must not be
  divided.
- Audio, pitch preserved: `atempo`. Its range is 0.5–2.0 per instance, so 0.25× and 4× chain
  two of them — `atempoChain(speed)` as a small pure function with its own assertions.
- Audio, pitch following: `asetrate=sr*speed,aresample=sr,asetpts=N/SR/TB`, which is the tape
  behaviour exactly.
- The audio delay for a retimed clip is unchanged: it is timeline time.

**DOD**
- [ ] Both engines produce the same length and the same cut points for a retimed project.
- [ ] `atempoChain` covers the whole 0.25–4 range and is asserted in `check:math`.
- [ ] Nothing is silently dropped: if a case cannot be expressed, the export refuses by name,
      the way pitch already does.

## Phase E — the controls, and the docs

**`src/components/Inspector.tsx`** — a Speed section on video and audio clips: the preset
buttons, a slider, the resulting duration in timecode, and the *Pitch follows the speed*
checkbox with a line about what it costs. Disabled with a reason when the track is locked.

**The timeline gesture** — ⌥-drag a trim handle to rate-trim: the source range holds and the
speed solves for where the edge lands. The cursor and the trim overlay say which mode is
active, because a handle that means two things has to.

**`src/utils/clipMenu.ts`** — the clip context menu gets the presets, since that is where
somebody will look for them.

**Docs** — a README section under Timeline & audio: what speed does, what the pitch toggle
does, the ⌥-drag, and the honest note about the WebCodecs warble. `docs/backlog.md` ticks the
entry and gains the two things this phase deliberately does not do.

**DOD**
- [ ] Speed is reachable from the Inspector, the context menu and the trim handle.
- [ ] The Inspector shows the resulting duration before the drag ends.
- [ ] A locked track refuses, with the reason.

## Also in scope because it will break otherwise

- **`bakeClipOf`** spreads the clip, so a bake of a retimed clip renders *at speed* — which is
  correct — but the asset it produces plays at 1×, so the clip that replaces it must have its
  speed reset to 1 or the retiming is applied twice.
- **`detachAudio`**, **`duplicateSelected`** and the clip copy paths carry both new fields.
- **`ProcessDialog`** presets operate on library *assets*, not clips, and are unaffected.

## Verification

```
npm run check:math                      # must print ALL PASS
npx tsc -p tsconfig.app.json --noEmit
npm run build
```

Then in the browser — yours, per your standing preference. Tick as you go; anything that does
not do what it says here is a bug in this document or in the code, and either way I want it.

**The basics**

- [ ] 1. Drop a video with speech on the timeline. Set 2× in the Inspector: the block halves,
      the ruler agrees, and it plays twice as fast with the voice still sounding like a voice.
- [ ] 2. Set 0.5×. The block doubles. With ripple off it stops at the next clip and says so;
      undo, turn ripple on, and it makes room instead.
- [ ] 3. Tick *Pitch follows the speed*: at 2× the voice goes high, and stays high in the export.
- [ ] 4. Set 1× again. The clip is exactly the length it started at.

**The edits that touch it**

- [ ] 5. Trim a 2× clip from either end. The edge lands under the pointer.
- [ ] 6. ⌥-drag the right edge of a 1× clip. The clip keeps its frames and the speed changes.
- [ ] 7. Split a 2× clip at the playhead. Both halves stay at 2×, and together they play what
      the one did.
- [ ] 8. Detach the audio of a 0.5× clip. The two are the same length and stay in sync.
- [ ] 9. Put a cross-dissolve between a 1× and a 2× clip. The transition is where the overlap is.
- [ ] 10. Animate an effect on a 2× clip. The keyframes stretch with the clip.

**Both engines**

- [ ] 11. Export with WebCodecs. Length, sync and pitch as previewed.
- [ ] 12. Export forcing FFmpeg. Same length, same cuts. Compare a 0.25× clip's audio between
      the two — the FFmpeg one is `atempo` and should be the cleaner of the pair.
- [ ] 13. Export a project with 0.25×, 1× and 4× clips on three tracks. Everything lines up.

**Persistence**

- [ ] 14. Reload. Every speed is where it was.
- [ ] 15. Open a project saved before this phase. Nothing has moved.

## Results

All five phases landed together. `npm run check:math` prints **ALL PASS** over 783 assertions,
`npx tsc -p tsconfig.app.json --noEmit` and `npm run build` are clean. Not checked in a
browser, per your standing preference; the 15-step checklist above is the check.

### The shape it took

The two relationships went where the plan said, and the leverage was as expected:
`clipDuration` dividing by the speed carried retiming into the ruler, snapping, collision, the
minimap, the project duration, the export length and the mixdown's window loop without any of
those files being touched. The WebCodecs *video* export needed no change at all — it samples
`reader.frameAt(sourceTimeFor(clip, t))`, so it followed `sourceTimeAt`. Same for the timeline
filmstrip and waveform, which spread the source range across the block's width and so compress
and stretch with it by construction.

`speedOf(speed)` takes the number rather than the clip. Taking the clip tripped TypeScript's
weak-type check — `ImageClip` has no property in common with `{ speed?: number }` — and
`utils/time.ts` importing the type graph would cost more than the nicer call site is worth.
`clipSpeedOf(clip)` in `clipRender.ts` is the version that takes a clip, for the files that
already import the types.

### Five places the maths had to be found rather than derived

- **`trimClipTo`'s bounds.** Three of them are conversions between timeline and source
  seconds, and the source-side `quantizeToFrame` on the derived trim had to *go*: it is a
  no-op at 1× and knocks a retimed clip's duration off the frame grid at any other speed. The
  timeline edge is what lands on a frame; the source point is derived from it.
- **`requantizeClips`.** It snapped `sourceTrimOut` to the grid, which for a retimed clip
  snaps the wrong number — the *duration* is what has to be a whole number of frames. It now
  branches, and `summarize` reports the timeline end rather than the source out-point for a
  retimed clip, so the count in the dialog matches what will actually move.
- **`splitSelectedAtPlayhead`.** The cut is a timeline offset and the source point behind it
  is `speed` times as far in. Without that a split 2× clip lost or repeated half its material.
- **`buildKeys` in the element pool.** Two clips of the same asset share one `<video>` unless
  they overlap in time, and `playbackRate` belongs to the element — so a 2× clip and the 1×
  clip after it are the same element. `PlaybackEngine.claim()` sets the rate every time an
  element is handed to a clip, which is the only correct place for it.
- **`source.start(when, offset, duration)` in the mixdown.** The third argument is in *buffer*
  seconds. Passing the timeline overlap cut a 2× clip off half way through each window.

### The bake, which would have applied the retiming twice

`bakeClipOf` spreads the clip, so a bake renders *at speed* — correct — and writes a file whose
duration is the clip's timeline length. The clip that replaces it therefore had to lose the
speed, or a 2× clip pointed at an already-2× file would play at 4× and be half as long.

`replaceClipSource`'s `clearEffects` option became **`baked`**, because it was already doing
one half of this and its name only described that half: a baked file contains the effect chain
*and* the retiming, and both come off the clip. A preset's output is the opposite case —
unretimed material of the same source range — so it keeps the speed and the clip stays exactly
as long as it was.

### The FFmpeg fallback

`atempoChain(speed)` is a pure function with its own assertions, because `atempo` accepts
0.5–2.0 per instance and the ends of this app's range need two: 0.25× is `atempo=0.5,atempo=0.5`
and 4× is `atempo=2,atempo=2`. The assertions check the *product*, not the string.

The pitch-following path resamples through a forced 48 kHz — `asetrate` takes a number, and a
filter graph is built before anything is decoded, so the source's own rate is not known there.
`amix` unifies rates downstream regardless.

### Follow-up: the WebCodecs export was mangled, not warbling

Reported straight after the phases landed: FFmpeg exported as previewed, WebCodecs came back
"heavily distorted… as if the audio pieces are heavily compressed and not arranged in the right
order."

That description is the algorithm. Holding the pitch was implemented as the plan said — resample
to retime, then shift the pitch back by `-12 log2(speed)` semitones — and at 2× that asks
`pitch-processor.js` for a **whole octave**. It is a crossfaded delay line with its two taps
100 ms apart in a 200 ms ring, built for the couple of semitones the pitch *effect* asks of it.
At an octave it re-reads a tenth of a second of the past every fifth of a second, which is
audibly chopped and out of order. "Pieces not in the right order" is a literal description of a
delay-line shifter pushed past its range.

Calling that a warble in the plan, the README and the Inspector hint was wrong about the
magnitude, and it was wrong because I reasoned about the artefact instead of measuring it.

The fix is not a better shifter — it is not shifting. `src/utils/timeStretch.ts` stretches the
audio directly: WSOLA, overlapping frames laid down at a different spacing than they were taken
from, each sliding a few milliseconds to where it best continues what is already written. Same
samples, different length, no pitch to put back. The mixdown stretches the window's source
range and plays it at rate 1; the pitch worklet is left to the pitch effect, which is what it
was built for.

**The assertion that would have caught it** is now section 47: a 440 Hz sine through the
stretcher comes out at 440 Hz and a different length. Every check the shipped bug passed was
about *length*, and every length was right — which is exactly why it shipped. Zero crossings
per second is the measure that separates a stretch from a resample, and it is the one nobody
had written down. A resample to 2× reports 1760 there; the stretcher reports 880.

Two smaller things fell out of it:

- A window overlap shorter than one stretch frame (~85 ms — the last sliver of a clip ending
  just past a 10-second window boundary) cannot be stretched. It falls back to resampling:
  a pitch shift nobody can name in 80 ms is a much better failure than the wrong 80 ms.
- The exact source range is sliced before stretching. The decoder returns whole packets and
  usually starts a little before what was asked for; stretching the overhang would drag audio
  from outside the window into it.

### Known gaps

- **Three engines, three stretchers.** The preview uses the browser's, the WebCodecs export
  uses WSOLA, FFmpeg uses `atempo`. All hold the pitch; a heavily retimed clip can still sound
  slightly different between them on sustained music, and `atempo` is the best of the three.
  Each window is stretched independently, so there is one phase discontinuity every
  `MIX_WINDOW_SECONDS` rather than a continuous artefact.
- **A cached loudness reading describes the unretimed source.** `measureLoudness` decodes the
  clip's source range, so *Normalize* on a heavily retimed clip is measuring material that is
  slightly not what will be heard. The reading is invalidated whenever the trim changes, and
  retiming moves the out point, so it is never *stale* — just measured before the stretch.
- **Speed ramps and reverse are not here**, deliberately, and are in the backlog with what
  each would actually cost.
