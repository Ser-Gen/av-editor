# Annotation: making the marks real

## Phase 0 — record the plan

This file, written before any code change, joining `capture-effects-plan.md`,
`persistence-plan.md`, `ux-plan.md`, `audio-export-plan.md`, `media-info-plan.md` and
`workflow-plan.md` as a phased plan of record. `CLAUDE.md`'s plan-doc sentence gains it, and
`docs/backlog.md` gains the three defects below as entries.

## Context

Phase 5 of `workflow-plan.md` shipped the annotation clip: five tools, a normalized shape
model, one rasterizer feeding all three render paths. What it did not ship is an *editor*.
Everything after the pointer goes up is missing — a mark cannot be selected, moved, restyled or
re-worded, and a callout's text is the literal string `'Note'` set at creation
(`AnnotationOverlay.tsx:67`) with no way to change it. Add the repaint bug below and the feature
reads, from the outside, as broken rather than unfinished.

Three complaints, three separate causes. All three were reproduced by reading the code, not
guessed:

### 1. Marks do not appear until the page is reloaded — a stale GPU texture

`uploadTexture(key, source, w, h, skipIfCached)` returns the cached entry **without uploading
new pixels** when one exists (`GLCompositor.ts:1193`). Both overlay call sites pass
`skipIfCached = true` — `drawAnnotationClip` at :1056 and `drawTextClip` at :1092 — and both
have *already* decided the content changed, because they only call it when their own
`contentKey` mismatches. So the first upload wins forever: the texture is frozen at whatever
the clip contained the first time it was drawn.

For an annotation clip that is always an **empty** frame, because a new clip is created with
`shapes: []` and drawn once before the first mark exists. After a reload the first draw carries
the saved shapes, so everything appears — exactly the symptom reported.

Two things follow from the same reading:

- **The bug is not new and it is not only annotation.** It is in `HEAD` (`git show
  HEAD:src/render/GLCompositor.ts | grep skipIfCached`), so editing a *text* clip's words,
  template or style has never repainted the GL preview either. It went unnoticed because
  `TextPlacementEditor` draws its own canvas preview, which is correct, and because the
  Canvas2D fallback has no cache and so has always been right.
- **`releaseTexture` (:1214) has no callers.** Overlay textures are composition-sized RGBA —
  about 8 MB each at 1080p — and a deleted text or annotation clip leaks its texture until the
  compositor is disposed.

### 2. There is no way to touch a mark once it is drawn

`AnnotationOverlay` handles `pointerdown → pointermove → pointerup` into a new shape and
nothing else. `ShapeOutline` binds `onContextMenu` to delete and no left-click at all. The
store already has `updateAnnotationShape(clipId, shapeId, patch)` — with the coalescing flag
set, so it is built for dragging — and nothing calls it. The tool strip's colour and width
inputs write component state consulted only at creation, which is why changing the width does
nothing to a mark already on screen.

### 3. Nothing places or animates an annotation

`AnnotationClip.transform?: OverlayTransform` exists in the type (`types/editor.ts:336`) and is
ignored by every renderer: the compositor draws the raster as a full-frame quad (:1075-1078),
the WebCodecs path passes no transform (`exportWebCodecs.ts:204`), and the FFmpeg path overlays
at `0,0` (`buildFilterGraph.ts:228`). `transformAt` already refuses only `kind === 'text'`, so
an annotation transform would animate through the existing keyframe machinery the moment
something wrote one.

### A fourth thing, unreported but the same confusion

The drawing surface mounts whenever an annotation clip is *selected*
(`AnnotationLayer.tsx:29`), with no reference to the playhead, while the renderer draws it only
when the playhead is inside the clip (`PlaybackEngine.isActive`). Scrub away from the clip
without deselecting it and drawing still works, silently, onto a frame that shows nothing. Once
phase A lands, this becomes the only remaining way to draw and see no mark.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Fix the stale texture, or fix the flag's callers | **Delete `skipIfCached` entirely** | It has two callers, both wrong, and no correct use: the contentKey check that precedes it is the real cache. A parameter that can only be misused is removed, not documented |
| What gets animated | **The clip's `transform`, not individual shapes** | It is the field the type already has, the machinery `transformAt` / `transformKeyframes` / `updateClipTransform` already implements, and the gesture (arm the stopwatch, drag, move the playhead, drag) users already know from picture-in-picture. Per-shape keyframes stay in the backlog |
| Raster size under a transform | **Still composition-sized, then placed** | `strokePx` is a fraction of the raster's smaller edge, so a shrunk frame shrinks the strokes with it and the mark set scales as one picture |
| Where a callout's words are edited | **Both**: a field in the Inspector, and double-click the callout on the preview | The Inspector is where every other clip property lives; the double-click is where anyone will actually look first |
| Selection state | **`selectedShapeId` in the store, outside `docSnapshot()`** | The Inspector and the overlay both need it, and it is a cursor, not a document fact — the same reasoning that keeps `selectedClipIds` out of undo |
| Freehand editing | **Move the whole path; no per-point editing** | Reshaping a hand-drawn line point by point is a drawing app's job. Redrawing it is two seconds |

## Phase A — Overlays repaint when they change

**`src/render/GLCompositor.ts`**

- Remove the `skipIfCached` parameter from `uploadTexture` and both `true` arguments. The
  content-key guard at each call site stays; it is what makes the re-upload rare.
- Give the doc comment on `drawTextClip` / `drawAnnotationClip` the reason: the call site owns
  the cache decision, the upload is unconditional once it is reached.
- Add `releaseOverlay(clipId)` beside `releaseTexture`, dropping both `text:` and `anno:` keys.

**`src/preview/PlaybackEngine.ts`** — `retire()` already walks the clips the project no longer
contains in order to disconnect their audio routes. Release their overlay textures in the same
loop; it is the one place that already knows what went away.

**`src/export/webcodecs/exportWebCodecs.ts`** — no change needed, but confirm by reading: the
export builds a fresh compositor per run, so it never saw this bug. Say so in the results.

**DOD**
- [ ] Drawing a mark repaints the preview immediately, with no reload and no scrub.
- [ ] Editing a text clip's words repaints the preview immediately — the same fix, and the
      regression it uncovers.
- [ ] Deleting an annotation or text clip releases its texture.
- [ ] `grep -rn skipIfCached src/` returns nothing.
- [ ] Honest note in the results: `check:math` cannot reach this. It is WebGL, and the guard is
      that the flag no longer exists rather than an assertion.

## Phase B — Editing a mark

**`src/utils/annotationEdit.ts`** (new, pure — `check:math` imports it)

- `hitShape(shape, point, tolerance): boolean` — distance to a segment for arrow/callout,
  to the rectangle's edge for box, to the ellipse for ellipse, to the nearest segment for
  freehand. Tolerance is normalized, so it is a constant times the stage's smaller edge.
- `pickShape(shapes, point, tolerance): string | null` — topmost first, so the mark drawn last
  is the one picked.
- `shapeHandles(shape): { id: string; point: Point }[]` — the two ends for a two-point shape,
  none for freehand.
- `moveShape(shape, delta)` — every point shifted, then clamped so the shape stays reachable.
- `setShapePoint(shape, index, point)` — one handle dragged.
- `annotationBounds(shapes)` — the union box, used by phase C's placement default.

**`src/store/editorStore.ts`** — `selectedShapeId: string | null` and `selectShape(id)`, cleared
whenever `selectedClipIds` changes. Not in `docSnapshot()`.

**`src/components/AnnotationOverlay.tsx`**

- Pointer-down on an existing mark selects it instead of starting a new one; pointer-down on
  empty space with a mark selected deselects; pointer-down on empty space with nothing selected
  draws, as today.
- Dragging a selected mark's body moves it, dragging a handle moves that end — both through
  `updateAnnotationShape` with coalescing on, so one gesture is one undo entry, as
  `CLAUDE.md` requires.
- Handles are drawn only for the selected mark: small circles in screen pixels, matching the
  outline's `non-scaling-stroke` treatment.
- Double-click a callout opens an input positioned over its label. Enter and blur commit,
  Escape cancels.
- `Delete` / `Backspace` removes the selected mark. The key handler must not fire while the
  callout input has focus.

**`src/components/PreviewPanel.tsx`** — the colour and width controls apply to the selected mark
when there is one, and set the default for the next mark otherwise. The strip says which,
because a control that means two things has to.

**`src/components/Inspector.tsx`** — the annotation list becomes selectable rows: clicking a row
selects that mark on the preview, and the selected row expands into its own properties — colour,
width, fill for box and ellipse, and the text field for a callout.

**`scripts/checkProjectMath.ts`** — a new section: hit-testing inside, outside and exactly on
each shape kind; picking order with overlapping shapes; a move that keeps every point's spacing;
a handle drag that moves one end and leaves the other; bounds for one shape, several, and none.

**DOD**
- [ ] A mark can be selected, moved, restyled and deleted without touching the timeline.
- [ ] A callout's words can be changed from both places, and the preview follows.
- [ ] A drag is one undo entry.
- [ ] Nothing draws a new mark by accident while a mark is selected.
- [ ] `check:math` covers every function in `annotationEdit.ts`.

## Phase C — Placement, and animating it

**`src/render/GLCompositor.ts`** — `drawAnnotationClip(clip, transform, alpha, flip)`. When a
transform is present the raster is placed through the *same* code `drawSource` uses for crop,
frame and rotation — extracted rather than copied, because CLAUDE.md's rule is that a placement
rule implemented twice stops being true.

**`src/preview/PlaybackEngine.ts`**, **`src/export/webcodecs/exportWebCodecs.ts`** — pass
`transformAt(clip, t)`, exactly as the video and image branches beside them already do.
**`src/preview/PlaybackEngine.drawFrame2D`** — the Canvas2D fallback draws the annotation
through `drawOverlaySource`, as it already does for video and image.

**`src/export/buildFilterGraph.ts`** — an annotation's overlay PNG takes its `x`/`y` and its
scale from `transformAt(clip, midpoint)` instead of `0,0`. Keyframes freeze at the midpoint and
warn there, which is the rule this path already follows for every other animated parameter — no
new behaviour, and no new silence.

**`src/components/Inspector.tsx`** — the placement tab accepts annotation clips: the same
"custom placement" checkbox, the same stopwatch arming all `TRANSFORM_CHANNELS`, and numeric
frame fields. `MediaOverlayEditor` is not reused — it wants a media blob URL and there is no
media — so the preview canvas itself is the direct-manipulation surface.

**`src/components/AnnotationOverlay.tsx`** — with no mark selected and a transform set, dragging
the annotation moves the whole overlay: `updateClipTransform` writes a keyframe at the playhead
when the stopwatch is armed, and a plain move when it is not. That is the picture-in-picture
gesture, unchanged.

**DOD**
- [ ] An annotation can be moved and scaled as a whole, and the preview, the WebCodecs export
      and the FFmpeg fallback agree about where it lands.
- [ ] With placement armed, dragging at two playhead positions makes the marks travel.
- [ ] The FFmpeg export warns once that the animation is frozen, and does not silently drop it.
- [ ] A project saved before this phase opens unchanged — no transform means full-frame, which
      is what the field's absence has always meant.

## Phase D — The states that were unclear

- **Playhead outside the clip.** The overlay shows a line saying the marks are not on screen at
  this moment, with a button that moves the playhead to the clip's start. The playhead is not
  moved silently: it is a cursor the user placed.
- **An empty annotation clip** says what to do — the Inspector hint exists, the preview does not
  have one.
- **The timeline block** already names the clip and its mark count, from the last fix.
- **README** gains an Annotation section under the overlay material: what the tools do, that a
  mark is editable after the fact, that placement animates like a picture-in-picture, and what
  the FFmpeg fallback freezes.
- **`docs/backlog.md`** — the repaint bug, mark editing and annotation placement move to done;
  "keyframed annotation *shapes*" stays open and is narrowed to what phase C does not do:
  a single arrow tracking a moving subject independently of the others.
- **`docs/workflow-plan.md`** — the phase 5 known-gaps list is amended to point here.

## Verification

```
npm run check:math                      # must print ALL PASS
npx tsc -p tsconfig.app.json --noEmit
npm run build
```

Then in the browser — yours, per your standing preference. Tick as you go; anything that does
not do what it says here is a bug in this document or in the code, and either way I want it.

**The repaint bug**

- [x] 1. Add an annotation clip, draw an arrow. It appears immediately, with no reload.
- [x] 2. Draw three more. Each appears as it is finished.
- [x] 3. Select a text clip and change its words. The preview follows — this had the same bug.
- [x] 4. Delete the annotation clip. The marks go with it.

**Editing** — the strip's first button, **Select**, is the mode for all of this.

- [x] 5. The tool you are in is visibly lit in the strip. (It was not, until the overlay round:
      the class was there and nothing styled it.)
- [x] 6. With Select, click an arrow. Its outline goes solid and handles appear at both ends.
- [x] 7. Drag its middle: the whole arrow moves. Drag a handle: that end moves and the other stays.
- [x] 8. Press undo once. The whole drag comes back, not a fraction of it.
- [x] 9. With the arrow selected, drag the width slider. This arrow gets thicker.
- [x] 10. Press Escape, pick Arrow, draw another. It uses the width the slider now shows.
- [x] 11. Draw a **Label**. It is a caption box with **no shaft and no arrowhead**, placed by a
      click; dragging while you place it moves nothing.
- [x] 12. Look at the label with the annotation clip selected. Its outline is a dashed rectangle
      **around the caption box** — the same rectangle you can click it by. Not a ring in the
      middle of the text, which is what it was: the anchor is the box's *centre*, so the ring
      sat inside the label attached to nothing.
- [x] 13. Every mark's outline traces that mark the same way — dashed while it is not selected,
      solid when it is. It is the selection and the grab region, never part of the drawing.
- [x] 14. Double-click a label, type something else, press Enter.
- [x] 15. Edit the same words from the Inspector's Selected mark panel. Both agree.
- [x] 16. Select a mark and press Delete. Then press Escape and Delete again: now the *clip* goes.
- [x] 17. **Right-click a mark's outline**, under the Arrow tool or any other, without selecting
      it first. That mark is deleted on the spot — no menu, one undo entry. It is the shortcut
      that existed before the Select tool did, and it still works from every tool.

**Marks that follow a subject** — the ⏱ in the tool strip, with one mark selected.

- [x] 18. Select a mark and press ⏱. **Nothing moves**: it records where the mark already is, so
      there is something to travel from. The ⏱ stays lit while the mark has poses.
- [x] 19. Move the playhead, drag the mark. Scrub between: it travels.
- [x] 19a. Now click that mark where it is drawn *between* its poses, and drag it. It is
      selected and it moves. (It could not be: picking read the stored points, so a mark that
      travelled was only clickable at its base pose.)
- [x] 20. The Inspector lists the poses by time, and clicking one jumps the playhead to it.
- [x] 21. The poses also appear **on the clip in the timeline**, as round markers on their own
      row — the same strip that shows an effect's or a placement's keyframes, because a mark
      that follows its subject is animation like any other. Clicking one selects its mark.
- [x] 22. Drag a pose marker along the clip. The mark reaches that pose at the new moment.
- [ ] 22a. Do the same to an **effect's or a placement's** keyframe on the same strip. It
      follows the pointer the whole way. It used to move one frame and stick, for the same
      reason the pose markers would not move at all — one drag handler serves both now.
- [x] 23. Delete a pose: right-click its marker on the timeline, or press the **×** beside its
      time in the Inspector.
- [x] 24. Delete poses until one is left. The mark now sits at that pose for the *whole* clip —
      a single pose is a placement, not the start of a move — and deleting the last one bakes
      that pose into the mark rather than dropping it back where it was first drawn.

**Placement and animation** — the Placement tab, with the annotation clip selected.

- [x] 25. Tick **Place the marks in a frame**. *Nothing moves* — that is the point of seeding the
      frame from the marks' own box. Then drag the marks to a corner with the Select tool, and
      shrink them with the Width slider.
- [x] 26. Arm the stopwatch, move the playhead to the clip's end, drag the marks across the frame.
      Scrub between: they travel.
- [x] 27. Export with WebCodecs. The travel is in the file.
- [x] 28. Export forcing FFmpeg. The marks are there, frozen at the midpoint position, with the
      warning saying so.

**The unclear states**

- [x] 29. Select an annotation clip, then scrub the playhead off it. The overlay says the marks
      are not visible right now and offers to jump back.
- [x] 30. Change the project's aspect ratio — 16:9 to 9:16. The picture becomes a centred band,
      and **the marks go with it**, still on what they were pointing at. A mark is anchored to
      the picture, not to the frame; a placed overlay or a text box is the other way round and
      keeps its distance from its edge.
- [x] 31. Before you press Apply in that dialog, the warning above the button **counts this
      annotation clip** among what will be re-anchored, and names both rules. It used to count
      only overlays, text boxes and masks, so a project of nothing but marks was told "changing
      the shape moves nothing" and then had all of it moved.
- [x] 32. The mark's stroke is the same thickness *relative to the picture* as it was — not
      twice as heavy over a picture that halved.
- [x] 33. Reload the page. Everything above is exactly where it was left.

Not on this list, though it was: *"redraw a freehand path mid-clip so two poses have different
point counts"*. There is no way to do that from the UI — a pose records the mark's existing
points moved, and drawing again makes a new mark — so it is a case `check:math` covers and a
browser cannot reach. It stays asserted there: poses of unequal length hold rather than
blending into nonsense.

## Results

All four phases landed together. `npm run check:math` prints **ALL PASS** over 729 assertions,
`npx tsc -p tsconfig.app.json --noEmit` and `npm run build` are clean. None of it was checked
in a browser, per your standing preference; the checklist above is the check.

### Phase A — overlays repaint

`skipIfCached` is gone from `uploadTexture`, along with both call sites' `true`. The comment
in its place says why a flag like it cannot come back: the caller's `contentKey` *is* the
cache, so reaching the upload means the pixels are wanted.

The fix was never annotation-specific. **Editing a text clip's words, template or style now
repaints the GL preview too** — it never did, in any released build, and nobody noticed
because `TextPlacementEditor` draws its own correct canvas and the Canvas2D fallback has no
texture cache at all.

`releaseTexture` had no callers; `retainOverlays(clipIds)` does the job the other way round —
the caller knows the whole document and a deleted clip does not announce itself — and
`PlaybackEngine.retire()` calls it beside the audio routes it already retires.

### Phase B — editing a mark

`src/utils/annotationEdit.ts` holds the geometry: `hitShape`, `pickShape`, `shapeHandles`,
`moveShape`, `setShapePoint`, `shapeBounds`, `annotationBounds`, `placementForShapes`. Every
distance is taken with x scaled by the stage's aspect, because a grab radius in raw normalized
units is an oval on screen — easy to hit sideways, impossible from above. `check:math` section
44 covers all of it, including the two cases that are only wrong on a wide frame.

Three decisions differ from the plan as written:

- **A Select tool was added**, rather than letting a click during a drawing tool grab an
  existing mark. Grabbing-while-drawing makes it impossible to draw a small mark on top of a
  large one, and there is no way to explain which gesture won. The tools are now Select,
  Arrow, Box, Ellipse, Draw, Callout; Arrow stays the default, so the first drag after adding
  a clip still draws.
- **Colour and width mean both things at once** — they restyle the selected mark *and* set
  what the next one is drawn with. The alternative is two identical-looking controls and a
  question about which one a slider just moved.
- **`moveShape` clamps the delta, not the points.** Clamping each point independently would
  flatten an arrow against the edge instead of stopping it there; the assertion for it checks
  that a shape shoved ten frames to the right arrives intact.

A drag is one undo entry through `beginInteraction`/`endInteraction`, the idiom `MaskOverlay`
and `KeyframeStrip` already use — not the 500 ms coalescing window, which would split a slow
drag in two. `Delete` removes the selected mark and `Escape` deselects, both from a
capture-phase handler that runs ahead of the app's own shortcuts: with a mark selected,
`Delete` means the mark, and deselecting is how you get back to deleting the clip.

### Phase C — placement and animation

`drawSource`'s placement maths came out into `placeTexture`, and the annotation draws through
it. That is the whole of the change in the compositor: crop, frame, rotation, letterboxing and
the fade all arrive for free, and there is still exactly one implementation of where a placed
picture goes.

`projectNormalizedPoint` / `unprojectNormalizedPoint` were added to `overlayTransform.ts`
rather than to `annotationEdit.ts` — that module owns the placement rule, and the editing
overlay needed the rule evaluated at a single point to keep its outlines and handles on top of
the marks they belong to.

Ticking *Place the marks in a frame* seeds crop **and** frame from the marks' own padded box.
Equal rectangles are an identity mapping, so nothing moves when the box is ticked; what
changes is what the frame then means — dragging or scaling it moves the marked region rather
than a composition-sized raster with the marks somewhere inside it.

The FFmpeg fallback places an annotation's PNG through the same `overlayTransformToPixels` the
video branch uses, rotation included, and freezes an animated placement at the clip's midpoint
with the warning that path already emits for every other animated parameter.

### Phase D — the unclear states

`AnnotationLayer` now compares the playhead against the clip's range and, when they disagree,
replaces the drawing surface with a line saying the marks are not on screen and a button that
moves the playhead to the clip. It does not move the playhead by itself: that is a cursor the
user placed.

### Follow-up: the checkbox that would not tick

Reported immediately after the phases landed, and the same class of bug a third time.
`updateClipTransform`'s writer guarded with `if (c.kind !== 'video' && c.kind !== 'image')
return c`, so an annotation's transform was never stored and the controlled checkbox could
never flip. `currentChannelValue` and `freezeChannel` — the arming and disarming halves of the
placement stopwatch — carried the same list, so arming would have captured no starting value
and disarming would have frozen nothing back.

All three now ask `acceptsTransform(clip)`, in `utils/clipRender.ts` beside `transformAt`,
with `check:math` asserting it against the clip union in both directions and against
`isVisualClip` — something placed has to be something drawn. Three hand-written copies of one
list is what made this a bug rather than a typo; there is one copy now.

### Follow-up: what came back from the checklist

Two changes from using it, and both were the design being wrong rather than the code:

- **A callout was an arrow with a label on it**, which made it an arrow you could not aim
  separately from its text — two marks in one, when the arrow tool already exists for the half
  that points. It is now a **Label**: a caption box placed with a click, with no shaft and no
  end handles. Old callouts keep their two stored points and the label still sits on the first
  of them, which is where it was already drawn, so nothing moves in an existing project.
- **Marks could not follow anything.** Phase C animated the clip's placement, which moves every
  mark together; what an arrow actually needs is to stay on a subject that moves. Each mark now
  carries its own poses in `pointKeys`, in clip-local seconds like every other keyframe, and
  `utils/annotationAnim.ts` is the one function that turns them back into points for all three
  render paths. Arm the ⏱ in the tool strip and drag; move the playhead and drag again.

Both of those came back a second time, and both were mine to get wrong:

- **The label still looked like it had an arrow.** The rasterizer had stopped drawing one; the
  *picking outline* had not, because its final branch draws a line from the first point to the
  last for anything that is not a box, an ellipse or a path. And dragging while placing a label
  still moved that second point, so there was something to draw a line to. The outline is now a
  small ellipse at the anchor, and a label's drag no longer moves anything. This is the third
  time the picking outline has been mistaken for the artwork — it is the layer that looks like
  the mark but is not it.
- **Animation had a hidden mode, and the first pose looked like a bug.** Arming was session
  state on the tool strip, so a drag meant either "move this" or "record a pose here" with
  nothing on screen saying which; and because one pose holds for the whole clip, the first
  recorded pose moved the mark *everywhere* — correct by the rule below, and indistinguishable
  from the mark simply jumping. The ⏱ now acts on the selected mark: pressing it records where
  the mark already is, so there is something to travel *from*, and it is lit for as long as the
  mark moves. Dragging a moving mark keys it; dragging a still one moves it. The Inspector
  lists the poses by time and jumps to them, because where the poses are is exactly what you
  need in order to put the next one somewhere sensible. This is the same idiom
  `toggleChannelArmed` already used for placement — `currentChannelValue` exists precisely to
  capture the first key — and not following it is what made the feature unusable.

The rule worth writing down is that **a single pose is a placement, not the start of a move**:
it holds for the whole clip. The alternative makes the first pose you record change the clip
everywhere except at the playhead, which reads as the feature having broken the mark. Poses of
different lengths — a freehand path redrawn mid-clip — hold rather than blending into nonsense,
and `annotationShapesAt` returns the clip's *own* array when nothing moves, because the
compositor caches its raster against `JSON.stringify(shapes)` and an equal-but-new array would
re-upload a full-frame texture thirty times a second.

`refitAnnotationShapes` originally refitted every pose against its own bounding box, on the
canvas-anchored rule. The overlay round replaced that: marks are **content-anchored**, so every
shape and every pose goes through the one map that takes the old frame into the box the picture
now occupies — the same fit `contentRect` gives a mask. A travelling mark is translated rigidly
and arrives at the same landmark at every moment, and it stays on the picture rather than on the
black bar beside it. See `docs/workflow-plan.md`, "Corrections from the walkthrough — the
overlay half".

### Follow-up: what came back from the checklist, second pass

Six notes from working through the list. Two were bugs, two were missing UI, and two were the
checklist itself being unreadable — which is a defect in the same sense.

- **"when I add a Label, it is drawn with a circle in the middle. I don't know why."** The ring
  was the picking outline, and the anchor it was drawn at is the *centre* of the label box — so
  it sat inside the text, attached to nothing, looking like part of the artwork. Third time this
  layer has been mistaken for the mark. The outline is now the label's box: `labelRect` in
  `utils/annotationEdit.ts` estimates it from the glyph count and the stroke width, and
  **`hitShape` uses the same rectangle**, so what can be clicked is exactly what is outlined.
  The old grab region was a disc around the centre, which left the near end of a long label
  outside its own hit region.

  The estimate is deliberate: the drawn box comes from `measureText` on a canvas, which
  hit-testing does not have and must not need. It is drawn a little larger than the artwork so
  it reads as a selection *around* the label rather than a border on it.

- **"I don't understand what exactly it was written about"** (right-click a mark). Right-click
  on a mark's outline deletes it, from any tool, with no menu — a shortcut older than the Select
  tool. The step now says that instead of saying "as before", and the Select tool's own tooltip
  mentions it.

- **"it seems like it would be useful to display this on a timeline"** (poses). Correct, and
  they were the one kind of animation the timeline could not show: you had to select the mark to
  find out it moved at all. `KeyframeStrip` now takes a discriminated row — a *channel*, which
  is a number with a curve, or a mark's *poses*, which are whole point sets and have no value to
  graph. Poses draw as round markers on a row that lights up when their mark is selected, drag
  along the clip, and delete on right-click, exactly as a keyframe does.

- **"I didn't understand how to do it"** (delete every pose but one). There was no way:
  `removeShapeKeyAt` existed in `annotationAnim.ts` and nothing in the store called it, so the
  only control was "Stop it moving", which clears the lot. There is now
  `removeAnnotationShapeKey`, reachable from the timeline marker and from a **×** beside each
  time in the Inspector. Deleting the *last* pose bakes it into the mark's own points rather
  than dropping the list — otherwise the mark would jump back to wherever it was first drawn at
  the moment you deleted its last pose.

- **"I can draw another freehand path…"** — quite: there is no way to give one mark two poses of
  different lengths from the UI, so that step could never have been performed. It is off the
  browser list and stays in `check:math`, where it belongs.

- **"I also didn't fully understand what it was about"** (the settings dialog). The step now
  names the place: the warning line above Apply in Project settings, after changing the frame to
  a different aspect. It counts annotation clips as of the overlay round and describes both
  anchoring rules.

### Follow-up: the two that came straight back

- **"I can't move these marks"** (the pose markers). A key is addressed by the time it sits at,
  and where it lands is quantized to a frame. The drag passed the *unrounded* pointer time as
  the next step's "from", so after the first frame of travel it was looking for a key at a time
  no key was at, found none, and the marker stopped. The drag now quantizes exactly as the store
  does and carries the quantized time forward.

  The same defect was already in effect and placement keyframes, where the drag passed the
  drag's *origin* as "from" on every step: once the key had moved one frame, every later step
  addressed a time nothing was at. Nobody had reported it because a one-frame drag looks like a
  small drag. One `startDrag` serves both now.

- **"after adding several marks, it is not possible to select and move the object"** — it was
  not about how many marks there are. It was about a mark that *moves*: `onDown` hit-tested
  `clip.shapes` while the compositor drew `annotationShapesAt(clip, playhead)`, so from the
  moment a mark got poses it could only be selected by clicking where it used to be — its base
  pose, which is somewhere there is nothing to see. Having just walked through making marks
  follow things, several of them had poses. Picking and the handle lookup both read `posed` now,
  and `check:math` asserts a travelling label is picked where it is drawn and *not* at its
  stored points, which is the assertion that would have caught it.

  Two things made this hide. At the base pose the stored and drawn points are identical, so it
  works right up until the mark is moved to a second pose. And `annotationShapesAt` deliberately
  returns the clip's own array when nothing moves, so for every static mark the two are the same
  object — the bug is invisible until the feature is used.

### Known gaps

- **A rotated annotation cannot have its marks edited.** Rotation is about the frame's centre
  in *pixel* space and the overlay works in the composition's normalized units, where it would
  have to guess at the aspect. It says so on screen and still allows the whole set to be moved
  from the Inspector, rather than drawing handles in the wrong place.
- **Freehand paths have no handles.** Moving one moves the whole path; reshaping it means
  redrawing it, which takes two seconds.
- **`check:math` cannot reach phase A.** It is WebGL. The guard is that the flag no longer
  exists, not an assertion.
