# Workflow plan — five phases

The five improvements chosen from [`backlog.md`](./backlog.md), in the order they should be
built. Each phase ends with a **DOD**: the checks that must pass before the next phase starts.
The last section is the **verification checklist** — the browser work, which is yours.

Everything here came out of one interview. The decisions taken there are recorded first,
because several of them close off an obvious-looking alternative for a reason.

---

## Decisions from the interview

| Question | Decision | Why it matters |
|---|---|---|
| Library structure | **Automatic grouping, sort and search. No hand-made folders** | Folders go stale and cost bookkeeping on every import. Grouping by what a file *is* can never be wrong |
| Muting the mic mid-take | **Silence in place** — the track stays live and records silence | The file's length and its measured sub-frame start offset are untouched, so nothing has to be re-aligned afterwards |
| Where that control lives | **In the Record panel.** No floating bar, no second window | Cheapest surface that works; the library already forces the Record tab forward while a take runs |
| Drawing / annotation | **A clip on the timeline**, holding vector shapes | Non-destructive, editable forever, and it can annotate video — an image editor can do none of that |
| Text styling vs the FFmpeg fallback | **Rasterize text on a canvas in all three paths; retire `drawtext`** | Styling stops being limited by what a filter string can express, and the three paths agree by construction rather than by testing |
| Toolbar cleanup | **Aggressive**, but `+ Text` keeps a home — in the library, as an object like any other | Duplication was the complaint; deleting the button without rehousing it would just move the complaint |
| The panel above the timeline | **Split into View / Edit / Add** | Zoom controls and "add a track" are currently in the same row with nothing separating them |
| Gaps | **A close-gaps command *and* a ripple mode** | They are the same underlying shift, exposed once as a cleanup and once as a behaviour |
| Phase 5 scope | **One phase: the overlay layer, then text, then annotation** | Rich text and annotation need the same new machinery. Building it twice is the only way to get this wrong |

---

## Phase 1 — Controls, and the editing commands that had no home

**Goal:** every action appears exactly once, in the panel that owns it; and the two commands
that had nowhere to live get built into the row being reorganised.

### The top bar

Today it carries `↶ ↷ | + Video + Audio + Image + Text … Load FFmpeg · project chip · export
chip · Export (FFmpeg) · Export`. Three of those import files that `+ Import` in the library
already imports — the library's picker accepts video, audio and images together and routes each
file by `inferAssetKind`, so the three typed buttons are strictly less capable than the one they
duplicate.

```
↶  ↷   │   1920×1080 · 30 fps   │   Web · 8 Mb/s   │   Export
        history          project              export
```

- `+ Video`, `+ Audio`, `+ Image` — **removed**. The library imports.
- `+ Text` — **moves to the library header**, beside `+ Import`. In this phase it is only the
  button that moves and it still creates a text clip exactly as it does now; phase 5 turns text
  into a library object. The model changes once, not twice.
- `Load FFmpeg` — **moves into the export dialog** as *Preload FFmpeg*. It exists to warm a
  32 MB WASM download before a long export, which is a thing you decide while looking at export
  settings, not a thing that needs a permanent button.
- `Export (FFmpeg)` — **becomes an engine choice inside the export dialog**: *Automatic
  (WebCodecs, falling back to FFmpeg)* or *Force FFmpeg*. Held in session state, deliberately
  **not** in `exportSettings`: a forced slow path must never be a property a saved project
  carries silently into next week.
- What is left is grouped with dividers, and the FFmpeg status line keeps its place.

### The timeline toolbar

Zoom, snapping, splitting and adding tracks are currently one undifferentiated row. Three
groups, each labelled by position rather than by a heading:

| Group | Contents |
|---|---|
| **View** | `−` · px/s readout · `+` · Fit · Selection · Snap · Follow |
| **Edit** | Split · **Close gaps** · **Ripple** |
| **Add** | `+ Video track` · `+ Audio track` · `+ Adjustment` |

### Close gaps

`closeGaps(clips, trackIds)` — a pure function in `src/utils/ripple.ts`, asserted in
`check:math`. For each track, clips in timeline order are pulled left until each one begins
where the previous one ended.

Two rules that are the whole difficulty:

- **The first clip on a track does not move.** A deliberate head of silence or black is content,
  not a gap.
- **An existing overlap is preserved exactly.** A cross-dissolve *is* the overlap between two
  adjacent clips (`utils/transitions.ts` — there is no separate transition entity), so pulling
  clips until they butt against each other would silently delete every dissolve on the track.
  The shift preserves each pair's current spacing when that spacing is negative.

Scope follows the selection: with clips selected, the tracks those clips are on; with nothing
selected, every track. A modifier is not needed — the button's tooltip states which it will do.

### Ripple mode

A session toggle, `rippleEnabled`, sitting beside Snap in behaviour and in look.

- **Delete** already has a ripple variant (`removeSelected(ripple)`); the toggle makes it the
  default so `⌫` ripples without reaching for the context menu.
- **Trim** ripples: changing a clip's out point shifts everything later on that track by the
  same delta, so trimming never opens a hole.
- **Move does not ripple.** Dragging a clip somewhere is a positioning act, and having the rest
  of the track chase the drag makes the timeline unpredictable in exactly the situation where
  you are looking at one clip. Close gaps covers the cleanup.

**One latent bug this phase fixes.** Ripple delete today shifts only the clips on the deleted
clip's own track. Detached audio lives on a *different* track (`detachAudio` splits it there),
and nothing links the two, so a ripple delete on the video track has always slid the picture out
of sync with its own sound. Both ripple and close gaps therefore take a scope — **this track**
or **all tracks** — and all-tracks applies one shift at one time across every track, which is
what keeps detached audio with its picture.

### DOD

- [ ] `check:math` covers `closeGaps` and the ripple shift: an ordinary run of gaps closes; the
      first clip does not move; a two-clip overlap survives with its overlap length unchanged;
      a track with one clip is a no-op; all-tracks scope shifts every track by one shared amount
      and per-track scope does not.
- [ ] Every action that existed before this phase is still reachable: import of each type,
      preload, force-FFmpeg, export, add text.
- [ ] Each of ripple-delete, ripple-trim, close-gaps is **one** history entry with its own label.
- [ ] `npx tsc -p tsconfig.app.json --noEmit`, `npm run build`, `check:math` all clean.

---

## Phase 2 — A library you can find things in

**Goal:** find a file, see what it is before adding it, get it back out, and paste one in.

### Grouping, sorting, searching

`src/utils/libraryView.ts`, pure and asserted:

```ts
type LibraryGroup = 'none' | 'type' | 'origin' | 'date';
type LibrarySort  = 'custom' | 'name' | 'duration' | 'size' | 'added';
groupAssets(assets, group) → { label, assets }[]
sortAssets(assets, sort, dir) → assets
filterAssets(assets, query) → assets       // name, and the preset that made it
```

- **Group by origin** is the one that pays for itself immediately: *Recorded here*, *Made by a
  preset*, *Imported*. That is also the split that decides which files are taking up your quota,
  since imported media is never copied.
- **Sort: custom** means `libraryOrder` — the document's own manual order, which stays the
  default and stays draggable.
- The view is **not part of the document.** `libraryOrder` is inside `docSnapshot()` and is
  undoable, because reordering is an edit. Choosing to look at things by date is not an edit and
  must not be undoable, so group/sort/query live in session state persisted to `localStorage`,
  next to the library tab that is already stored there.
- `MediaAsset` gains `addedAt?: number`. Optional, because projects saved before this phase have
  no such field; assets without one sort last under *Added* and are labelled *Earlier* under
  *Date*. No version bump — a `PROJECT_FILE_VERSION` mismatch discards the whole project, so new
  fields are always defaulted, never versioned.

### Preview

- **Hover-scrub the thumbnail.** Moving across a video row's thumbnail scrubs it, using the
  frames `utils/videoThumbnailCache.ts` already holds for the timeline filmstrip.
- **Click the thumbnail for a real preview**: a popover with a transport for video, a waveform
  with a transport for audio, and the full picture for an image.
- The preview must **stop when timeline playback starts**, and must never hold a decoder open
  after it closes. It uses its own element, not `PlaybackEngine`'s pool.
- Offline assets keep their placeholder and say so; there are no bytes to preview.

### Download

A `⤓` action on the row and in the context menu: `URL.createObjectURL(asset.file)` behind an
`<a download>`, revoked on the next tick. **As it is on disk** — a recording downloads the exact
fragmented MP4 that was written during the take, with no remux and no re-encode. Disabled with a
reason when the asset is offline.

### Paste an image

A `paste` listener on the window, ignored while focus is in a text field.
`ClipboardEvent.clipboardData` gives an image as a `File`; it becomes a library asset named from
the clipboard when it has a name and `Pasted image N.png` when it does not.

**The part that is easy to get wrong:** a pasted image has no file on disk. It is not `imported`
— there is nothing to relink it to, and nobody can be asked for it again — so it must be written
to OPFS like a recording or a preset output. Pasting an image and reloading the page must not
produce an offline asset.

### DOD

- [ ] `check:math` covers grouping, sorting and filtering: each sort over a fixture library
      including an asset with no `addedAt`; the search matching name and preset label;
      `sort: 'custom'` returning `libraryOrder` exactly.
- [ ] A project saved before this phase opens with every asset visible and correctly grouped.
- [ ] Downloading a recorded file produces a byte-identical copy of what OPFS holds.
- [ ] A pasted image survives a reload as an online asset.
- [ ] Group/sort/query survive a reload and are absent from `docSnapshot()` — undo after
      changing the sort undoes the last *edit*, not the sort.
- [ ] Type check, build and `check:math` clean.

---

## Phase 3 — Recording you can steer while it runs

**Goal:** stop talking without stopping the take, and see what every source is doing.

### Muting a source

`track.enabled = false` on the microphone's `MediaStreamTrack`. The encoder keeps receiving
samples; they are silent. Which means:

- the mic file's **duration is unchanged**, so it still lines up with the screen and the camera;
- the **measured start offset** that makes that alignment sub-frame accurate is still valid;
- nothing is placed differently on the timeline, and nothing needs trimming afterwards.

The alternative — ending the mic source and starting a second one — was rejected in the
interview for exactly this reason.

The same mechanism gives system audio a mute, free, and the meters must read zero while muted so
the button and the level never disagree.

### The recording control

The recording state moves out of `RecordPanel.tsx` (531 lines, and it also owns setup, device
choice and orphan recovery) into `RecordingControl.tsx`:

```
● 04:12                                      [ Stop ]  [ Cancel ]
─────────────────────────────────────────────────────────────────
Screen    1920×1080 · 60 fps      delivering 58     ▇▇▇▇▇▁▁▁
Camera    1280×720 · 30 fps       delivering 30     — 
Mic       48 kHz stereo                             ▇▇▁▁▁▁▁▁   [ Mute ]
System    48 kHz stereo                             ▁▁▁▁▁▁▁▁   [ Muted ]
```

Per source: what it negotiated, what it is actually delivering, its level, and its own mute and
stop. `CaptureSession.status()` already returns most of this — the panel is a rendering problem,
not a measurement problem.

Stopping one source without ending the take reuses `endSource`, the path an unplugged camera
already takes: that file is finalized and stays playable, and the rest of the take continues.

### DOD

- [ ] Mute and unmute change only `track.enabled`; no code path stops, replaces or re-negotiates
      a track while a take is running.
- [ ] A muted stretch produces silence of the correct length in the finished file — duration and
      the sidecar's `startOffset` are identical to an unmuted take of the same length.
- [ ] Stopping one source leaves the others recording, and the stopped file is playable.
- [ ] Mute state is visible in one place and matches the meter.
- [ ] Type check, build and `check:math` clean.

---

## Phase 4 — Audio worth editing on its own

**Goal:** the three things asked for — a volume envelope, loudness, and effects including
filters and pitch — without a fourth implementation of what a clip sounds like.

### Why this is smaller than it looks

Two things are already true:

- the preview routes each media element through `createMediaElementSource` into a gain graph
  (`preview/PlaybackEngine.ts`);
- the export mixdown renders every window through an `OfflineAudioContext`, placing each clip
  through its own `GainNode` (`export/webcodecs/audioMixdown.ts`).

Both are Web Audio graphs. So **one module that builds a clip's node chain** — used by the
preview and by the mixdown — makes the preview, the WebCodecs export and the audio-only export
agree by construction, in the same way `clipRender.ts` already does for the picture. No DSP is
written twice.

The FFmpeg fallback is the exception, and it is the familiar one: it filters in its own domain,
so its `af` chain is an equivalent, not the same thing. Where the bundled FFmpeg build has no
equivalent filter, the fallback **refuses the export naming the effect** rather than quietly
producing something that sounds different.

### Volume envelope

A `gain` parameter track on the clip, reusing `utils/keyframes.ts` — the same engine that
animates effect parameters, with the same three interpolations.

- Drawn as a line over the clip's own waveform. Click to add a point, drag to move, right-click
  to remove; a clip with no points renders exactly as it does today.
- `envelopeGainAt(clip, t)` joins `fadeGainAt` in `utils/clipRender.ts`, so fades, track volume,
  solo/mute and the envelope multiply in one place. Pure, and asserted.
- In the mixdown, `scheduleFade` already writes a value curve into an `AudioParam`; the envelope
  is more points on the same curve.

### Normalize and match loudness

Integrated loudness to EBU R128: K-weighting (two biquads), 400 ms blocks at 75% overlap, an
absolute gate at −70 LUFS and a relative gate at −10 LU. Pure arithmetic over a `Float32Array`,
which makes it the most testable thing in this plan — `check:math` measures synthetic signals
whose loudness is known.

- **Normalize** measures the clip and sets its gain so it lands on a target, default −16 LUFS.
- **Match loudness** measures every selected clip and sets each gain to a shared target — the
  loudest, the quietest, or the default.
- Both write a **gain**, not new samples. Nothing is re-encoded, the change is undoable as one
  entry, and the measurement is cached per clip until its trim changes.

### Effects: filter, EQ, pitch

An effect chain on an audio clip, edited in the Inspector beside the video effect stack.

| Effect | Preview and fast export | FFmpeg fallback |
|---|---|---|
| High-pass, low-pass | `BiquadFilterNode` | `highpass`, `lowpass` |
| 3-band EQ | three peaking `BiquadFilterNode`s | `equalizer` |
| Pitch (semitones) | an `AudioWorklet` phase vocoder | `asetrate` + `aresample` + `atempo` |

Filters are exact across paths — literally the same node object in the preview and in the
offline render. **Pitch is the risk in this phase**: Web Audio has no pitch node, so it needs a
phase vocoder written as a worklet, and the worklet has to run inside the `OfflineAudioContext`
as well as the live one. If it cannot be made to sound clean, pitch moves to the backlog and the
rest of the phase ships without it — the filters and the loudness work do not depend on it.

### DOD

- [ ] `check:math` covers `envelopeGainAt` across the three interpolations, its multiplication
      with fades and track volume, and R128 loudness against synthetic signals of known level,
      including the absolute gate discarding silence.
- [ ] A clip with no envelope, no normalization and no effects exports byte-for-byte as it does
      today.
- [ ] Preview and WebCodecs export of the same effected clip match within tolerance, measured
      the way the keyframe phase measured it.
- [ ] The FFmpeg fallback either applies an equivalent chain or refuses and names the effect. It
      never exports an audio effect silently unapplied.
- [ ] Normalize and match-loudness are one history entry each and change only gain.
- [ ] Type check, build and `check:math` clean.

---

## Phase 5 — The overlay layer: rich text and annotation

**Goal:** one way to put drawn things over the picture, used by styled text and by annotation.

### The layer

`src/render/overlayRaster.ts` — given an overlay clip and the composition size, draw it to an
`OffscreenCanvas` and return the bitmap. Three consumers:

- the **preview compositor**, which already accepts a canvas through `gl.drawSource` — the
  offline placeholder card takes exactly this route today, and inherits transform, crop, fade
  and the effect chain for free;
- the **WebCodecs export**, the same call;
- the **FFmpeg fallback**, which writes one PNG per overlay clip and `overlay`s it.

`drawtext` and `export/textDrawtext.ts` are **deleted**. Two things follow. Text stops being
limited to what a filter string can express — and effects on a text clip stop being refused by
the fallback, which is a warning `buildFilterGraph.ts` emits today.

### Text styling

A `TextStyle` on the clip: font family, size, weight, italic, colour, stroke width and colour,
shadow, background box with padding, radius and opacity, alignment, line height, letter spacing.

**Templates become data.** A template is a named preset over that style, so adding one is an
entry in a table rather than a `case` in a `switch` — which is what makes "more templates"
cheap after this phase rather than a change every time.

**The constraint worth stating before it bites:** the fallback rasterizes with the same canvas
the preview uses, so any font available to the page works in all three paths — but a font must
actually be *there*, and `bootstrap` currently downloads exactly one (DejaVu Sans). The style's
font list is the bundled set plus a documented system stack; adding a family means adding it to
`bootstrap.sh`.

### Text as a library object

`+ Text` in the library creates a reusable text object shown in the list like any other media,
and adding it to the timeline creates a clip referencing it. Editing the object updates every
clip using it; *Duplicate* makes an independent one.

**Where it is stored is not obvious and matters.** `mediaLibrary` sits deliberately *outside*
`docSnapshot()` — importing a file is not undone by pressing undo. But the words in a title very
much are. So text objects live in their own map **inside** the document snapshot, and are merely
*displayed* in the library panel alongside media. Same list, different home, undo intact.

### The annotation clip

A new clip kind holding vector shapes: arrow, box, ellipse, freehand and callout — each with
normalized coordinates, stroke colour and width, and an optional fill.

- Drawn and edited **on the preview**, following the conventions `MaskOverlay` and
  `TextPlacementEditor` already set.
- Coordinates are normalized against the composition, and refit under an aspect change through
  the same rule as masks — phase 19 of the capture plan recorded what happens when a region is
  refitted against the wrong thing: the blur slides off the licence plate.
- Keyframing the shapes is not in this phase. The clip is shaped so it can be added later
  without moving the data.

### DOD

- [ ] `check:math` covers the style→layout arithmetic: line breaking at a width, the box
      growing with padding, alignment anchors, and every template resolving to a complete style.
- [ ] The same text clip rendered by the preview, the WebCodecs export and the FFmpeg fallback
      is the same picture within tolerance — measured, not eyeballed.
- [ ] `drawtext` and `textDrawtext.ts` are gone, and the "effects on a text clip cannot be
      rendered by FFmpeg" warning is gone with them.
- [ ] A project saved before this phase opens with its three old templates rendering unchanged.
- [ ] Editing a text object updates every clip that references it, in one history entry.
- [ ] An annotation survives a project aspect change still pointing at the same thing.
- [ ] Type check, build and `check:math` clean.

---

## Sequencing

| Phase | Why here |
|---|---|
| 1 | Nothing depends on it, everything is seen through it, and it is the cheapest. It also builds the Edit group that phase 4's audio commands will want |
| 2 | The library is where every other phase's output arrives — recordings, pasted images, text objects |
| 3 | Self-contained. Touches only the capture layer, and gets the most use per line of code |
| 4 | Needs no new rendering machinery, but does need the Inspector conventions to be settled |
| 5 | Largest, and the only one that deletes a render path. Last, so it lands on a code base that is otherwise still |

**Risks worth naming now.** Phase 4's pitch worklet is the one item that could fail on its own
terms; it is isolated so the rest of the phase does not wait on it. Phase 5 removes `drawtext`,
which is the fallback's only text path — until the PNG overlay works, the fallback cannot render
text at all, so that switch happens in one commit with both sides done.

---

## Your verification checklist

The browser work. Everything above is checked by `check:math`, the type checker and the build;
none of that can tell whether the thing feels right, and none of it opens a window.

### Phase 1 — Controls

- [x] The top bar has no `+ Video` / `+ Audio` / `+ Image`, and `+ Import` in the library still
      takes a mixed selection of all three at once.
- [x] `+ Text` is in the library header and still adds a text clip.
- [x] The export dialog can preload FFmpeg and can force the FFmpeg engine; a forced export
      still produces the same file.
- [x] Reload the page: the forced-FFmpeg choice is **not** remembered.
- [x] The timeline toolbar reads as three groups, and nothing that was there has vanished.
- [x] Lay out three clips with gaps, press **Close gaps** — they close, and the first clip has
      not moved.
- [x] Overlap two clips into a cross-dissolve, add a gap after them, press **Close gaps** — the
      dissolve is still there and still the same length.
- [x] Turn **Ripple** on, trim a clip's out point — everything after it follows. Turn it off,
      trim again — a hole opens.
- [x] With ripple on, delete a clip on a video track whose audio was detached to an audio track,
      with **all tracks** scope — picture and sound stay in sync.
- [x] `⌘Z` once undoes the whole close-gaps, not one clip of it.

### Phase 2 — Library

- [x] Group by origin: recordings, preset outputs and imports separate correctly.
- [x] Sort by size, then by duration, then back to Custom — Custom is your manual drag order.
- [x] Type part of a file name in the search box; the list narrows and the rest is still there
      when you clear it.
- [x] Reload: the group and sort you chose are still chosen.
- [x] Change the sort, then press `⌘Z` — it undoes your last **edit**, not the sort.
- [x] Hover across a video thumbnail — it scrubs.
- [x] Click a video thumbnail — it previews with a transport. Start timeline playback — the
      preview stops.
- [x] Preview an audio file and an image; neither throws, both close cleanly.
- [x] Download a recording, open it in a player — it plays, and it is the same size as the
      library says.
- [x] Copy an image in another app, click the library, press `⌘V` — it appears.
- [x] Reload the page — the pasted image is still there and **not** offline.
- [x] Put the cursor in a text field and press `⌘V` — it pastes text, not an image.

### Phase 3 — Recording

- [x] Start a screen + mic take. Mute the mic mid-way, speak, unmute, speak again.
- [x] Stop, add the mic file to the timeline — the silence is where you muted, the same length,
      and the clip still lines up with the screen recording.
- [x] The meter reads zero while muted.
- [x] With screen + camera + mic running, stop just the camera — the other two keep going, and
      the camera file plays.
- [x] The panel shows what each source negotiated and what it is delivering, and the two differ
      visibly if you overload the machine.

### Phase 4 — Audio

- [x] Draw a volume envelope under a voice clip; the preview follows it while playing.
- [x] Export that project and listen — the export matches what the preview did.
- [x] Normalize a quiet clip; it gets louder, `⌘Z` puts it back in one step.
- [x] Select three clips recorded at different levels, match loudness, listen across the joins.
- [x] Add a high-pass to a clip with rumble in it; the preview changes as you drag the cutoff.
- [x] Export the same project with WebCodecs and again with **Force FFmpeg** — either they sound
      equivalent, or the FFmpeg one refuses and names the effect. It must not silently drop one.
- [x] Pitch a clip up two semitones — it does not sound like a chipmunk on a broken tape, and it
      is the same length.

### Phase 5 — Overlay

- [x] Add text, restyle it — font, colour, stroke, shadow, a background box.
- [x] Export with WebCodecs and with **Force FFmpeg**; open both — the text looks the same.
- [x] Put an effect on a text clip and export with FFmpeg — it renders, with no warning about
      text clips.
- [x] Open a project saved before this phase — its old text looks as it always did.
- [x] Make a text object in the library, use it in three places, edit it once — all three change.
- [x] Duplicate it, edit the copy — only the copy changes.
- [x] Draw an arrow and a box over a screen recording; scrub — they stay where you put them.
- [x] Change the project aspect ratio — the arrow still points at the same thing (it moves
      with the picture, which itself becomes a letterboxed band).
- [x] Export the annotation with both engines and compare.

---

## Results

All five phases are built. `check:math` is at **683 assertions, ALL PASS** (was 619 before this
work), `npx tsc -p tsconfig.app.json --noEmit` is clean and `npm run build` is clean. Nothing
below was checked in a browser — that is the checklist above.

### What the plan got right

**Naming the transition trap before writing the code was the whole value of phase 1.** A
transition is the overlap between two adjacent clips and nothing else, so the obvious
implementation of "close gaps" — pull each clip until it touches the one before it — deletes
every cross-dissolve on the track with no entry in the history saying so. `closeGapsOnTracks`
measures each pair's spacing against where the previous clip *was* and only ever closes a
positive gap, and there is an assertion holding it to that.

**Phase 4 really was mostly already built.** The preview routes elements through
`createMediaElementSource` into a gain graph and the export mixdown renders every window
through an `OfflineAudioContext` with a `GainNode` per clip. One module — `utils/audioChain.ts`
— now builds the node chain for both, so an effect heard while scrubbing is the effect that
lands in the file, by construction rather than by testing.

### What changed against the plan

| Planned | Actually shipped | Why |
|---|---|---|
| Close gaps: "with nothing selected, every track" | With nothing selected, the **timeline as a whole** — only stretches where nothing plays anywhere are removed | Closing every track independently is the one operation guaranteed to slide detached audio out of sync with its own picture. `closeGapsAcrossTracks` shifts whole blocks, so cross-track relationships survive |
| Ripple: delete and trim | Same, plus a **scope** control — this track, or all tracks | Ripple delete has always shifted only the deleted clip's own track, which has been desyncing detached audio since it was written. The scope is the fix, and it is the same control both operations needed |
| Pitch as "an AudioWorklet phase vocoder" | A **crossfaded delay line** worklet | It runs identically in a live `AudioContext` and in the `OfflineAudioContext` the export renders through, which is the property that actually matters. On speech it is clean; on sustained musical material the periodic crossfade is audible, and the effect's own hint says so rather than hiding it |
| Loudness "to EBU R128" | Same, with the K-weighting **rebuilt from its prototypes at the file's own rate** | The published coefficients are for 48 kHz. A 44.1 kHz file now gets a correct filter instead of a slightly wrong one, and `check:math` measures both against the EBU test signal |
| Text objects "in their own map inside the document snapshot" | An array in `EditorDoc.textLibrary` | Same decision, simpler shape. `docSnapshot` gained one line and `fromProjectFile` defaults it to `[]`, so a project saved last week opens without a repair notice |
| — | **Added:** the FFmpeg path now overlays a PNG per text *and* annotation clip | `drawtext` and `export/textDrawtext.ts` are deleted, and with them the "effects on a text clip cannot be rendered by FFmpeg" warning — an overlay is a layer like any other, so the chain runs on it |
| — | **Added:** `runExport` no longer writes `font.ttf` into the WASM filesystem | It went in for `drawtext`. Text now arrives as a bitmap the page drew, with the browser's own font machinery behind it |
| — | **Added:** `pasted` as a fourth asset origin | A pasted image has no path, so `imported` would have sent `rehydrate` hunting for a fingerprint that can never match and the image would have come back offline after every reload |

### Known gaps

- **Move does not ripple**, by choice — see the phase 1 design. Close gaps covers the cleanup.
- **The FFmpeg fallback freezes a drawn volume envelope at the clip midpoint**, exactly as it
  already freezes keyframed video parameters, and warns in the same place. The WebCodecs path
  follows the drawn curve.
- **Pitch has no FFmpeg equivalent.** `ffmpegAudioFilters` returns null and the export refuses,
  naming the effect. `asetrate`+`atempo` would have produced something audibly different from
  what the preview played, which is worse than refusing.
- **Annotation shipped without an editor.** A mark cannot be selected, moved, restyled or
  re-worded once drawn, the clip's `transform` is in the type and read by no renderer, and an
  overlay texture never repaints after its first upload — which is why the marks appear only
  after a reload. All of it is picked up by `docs/annotation-plan.md`; per-shape keyframes
  stay in the backlog.
- **The Canvas2D fallback still renders no effect chain** — unchanged, and still warned once.

## Corrections from the walkthrough — the overlay half

Four more, from the text and annotation steps.

- **"restyle it — font, colour, stroke, shadow, a background box"** — the shadow had never been
  drawn. `textRenderer` set `shadowColor`/`shadowBlur`, drew the stroke, then cleared them again
  before `fillText` — so a style with a shadow and no stroke cast no shadow, and no template
  pairs the two. Switching Shadow on did nothing, ever, in any of the three paths. The shadow is
  now cast by the outermost thing drawn — the box if there is one, otherwise the stroke,
  otherwise the fill — and by exactly one of them, which is what a drop shadow is.

  Its numbers were also raw canvas pixels, alone in a file whose first paragraph is about
  everything being a fraction of the frame: 8 px of blur is a soft halo in a 480p proxy and a
  hairline in a 4K export. They are fractions of the font size now, and `shadowPixels` reads a
  stored value ≥ 1 as one of the old pixel ones — a blur as tall as the type is not a fraction —
  so nothing saved before this becomes a black rectangle.

- **"I don't see the enabled status for the buttons"** — `is-active` was written three times
  against three different ancestors (`.timeline-toolbar`, `.track-header-controls`,
  `.panel-tab`), so every toggle outside those had a class that styled nothing: italic, shadow,
  box, the speed presets, and **the annotation tool buttons** — which is part of why the drawing
  tools were hard to read last round. The rule now lives on `button.is-active`, where the class
  is, and the two scoped copies are gone.

- **"we need the ability to make Stroke even stronger"** — the slider stopped at 0.2 and only
  half of that was visible: a canvas stroke straddles the glyph outline, and the fill covers the
  inner half. `strokeWidth` now means the outline you can see (the renderer draws twice it), and
  the slider reaches 35%. The *Outlined* template's stored value is halved to keep it looking
  exactly as it did.

- **"Duplicate it, edit the copy — only the copy changes"** — duplicating a clip kept its
  `textObjectId`, so the copy was another *use* of the same library object and restyling it
  changed every other clip showing that object. A duplicate is a copy: the link is dropped, and
  the library's ⧉ (an independent object) and + (another use) are where the two intentions live.
  The Inspector also says when a clip is linked and how many clips an edit will land on, with a
  way out — an edit that silently changes four clips elsewhere on the timeline is
  indistinguishable from a bug, which is how it was reported.

- **"Change the project aspect ratio — the arrow still points at the same thing"** — it did not,
  and the reason the promise sounded strange is that it was only half stated. Reshaping the
  canvas *moves the picture*: 16:9 footage in a 9:16 project is a centred band 607.5 lines tall.
  The arrow has to move with it, and it was not — marks were canvas-anchored, each refitted
  against its own bounding box and keeping its distance from whichever edge it was nearest,
  which is the rule for a lower third and leaves a mark stranded on the black bar beside the
  picture it was drawn on. `AnnotationShape`'s own doc comment already said they "refit the way
  masks refit"; now they do, through one content map shared with `contentRect`. Stroke widths
  ride it too, so a mark over a halved picture is not twice as heavy. `countAnchored` counts
  annotation clips, so the dialog no longer promises that nothing will move and then moves it,
  and it now names both rules.

## Corrections from the walkthrough — the audio half

Four more steps found four more things the plan claimed and the code did not do.

- **"Normalize a quiet clip; it gets louder"** — it wrote a gain nothing would play.
  `clampNormalizeGain` allows +12 dB, which is what a take at −23 LUFS aimed at −16 needs, but
  `setClipGain`, the Inspector slider and `compositeOrder`'s resolver all clamped to 1.5×
  (+3.5 dB) — the *track fader's* ceiling, shared with clips because there was one number. So
  Normalize measured correctly, wrote 2.34, and the clip played at 1.5. A clip's gain now
  reaches +12 dB and a track's still stops at +3.5, and normalizing says in the status line
  what it did and where it stopped short.
- **"Select three clips… match loudness"** — unreachable. The button lived in the single-clip
  Audio section, and the Inspector short-circuits a multi-selection to a count and a sentence
  about dragging. Matching is a multi-clip operation by definition, so it belongs in exactly
  the view that had nothing in it; the multi-selection Inspector now offers it.
- **"the preview changes as you drag the cutoff"** — two causes, one fixed last round. The
  play loop reads the document every frame now, so the change arrives; but the route's
  fingerprint was `JSON.stringify(effects)`, so *every* slider step tore the graph down and
  built it again, which is heard as a gap rather than as a filter sweeping. The fingerprint is
  now the chain's *structure*; values are written into the existing `AudioParam`s.
- **"pitch up two semitones — it does not sound like a chipmunk on a broken tape"** — it
  sounded like a broken tape, and the effect's own hint claimed it was a phase vocoder, which
  it never was. It was a crossfaded delay line: two taps 100 ms apart in a 200 ms ring, with
  the read phase sweeping half the ring at `ratio - 1` per sample. At +2 semitones that is
  0.122 per sample, so a sweep takes 4800 / 0.122 ≈ 39 000 samples — **0.8 seconds** — and the
  audible result is a tenth of a second of the past being re-read on a slow cycle. An echo
  with the audio chopped and repeated, exactly as reported. It is the same mechanism that
  mangled retimed exports, at a shift small enough that it was supposed to be fine.

  The worklet is now overlap-add with waveform alignment: 512-sample grains read at the shift
  ratio and laid down at a fixed hop, each slid up to 2 ms to where it best continues the one
  before. Whatever periodicity is left is up at ~180 Hz instead of down at 1.2 Hz. Measured on
  a 440 Hz tone driven through the worklet's own `process()` in node: ±2, ±7 and ±12 semitones
  all land within 0.5 Hz of the target with the level unchanged.

  **The export does not use it at all any more.** A grain-based shifter needs latency, and
  latency inside a fixed-length render window delays that clip against everything else in the
  mix with nothing to compensate. Offline the whole segment is in hand, so `pitchShift` in
  `utils/timeStretch.ts` stretches and resamples it exactly — which also means pitch now comes
  *first* in both engines, before the filters, because samples can only be shifted before they
  enter a graph.

## Corrections from the walkthrough

Four checklist steps found things the plan claimed and the code did not do. All four are fixed;
they are listed here because the checklist above still reads as though they always worked.

- **"Custom is your manual drag order"** — `custom` sorted by `libraryOrder` and nothing could
  change it. The sort-direction button's own tooltip said "drag rows to change it". Rows are
  draggable now, under that sort only: under any other, a dropped row would spring back to
  where the sort says it goes, which reads as the drag having failed.
- **"the same size as the library says"** — the library only sized files this app had made,
  because the size was originally there to show what was filling the OPFS quota. "How big is
  this" is a question about a file, not about where it came from; every online file is sized
  now.
- **"the preview follows it while playing"** — it did not, and neither did anything else edited
  mid-playback. The RAF loop recursed with the `StoreSlice` captured when playback started, so
  a gain change, a new clip or a trim was invisible until you stopped and started again. The
  loop reads the document every frame now.
- **The Record tab stopped scrolling once the camera preview appeared**, taking the Record
  button off the bottom of the panel with it: a replaced element with an `aspect-ratio`
  contributes a height that does not shrink with its flex parent. The panel takes the column's
  remaining height explicitly, the preview is capped at 26vh, and the controls are sticky, so
  the button that starts and stops a take is reachable from anywhere in the panel.
