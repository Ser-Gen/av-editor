# Persistence Plan

Closes the last line of [`CLAUDE.md`](../CLAUDE.md): *"Nothing is persisted. A refresh clears
the project."* Supersedes the persistence half of phase 6 in [`ux-plan.md`](./ux-plan.md),
which said "IndexedDB autosave + session restore" and left the media question open — that
question turns out to be the whole problem.

The document half is nearly free: `docSnapshot()` already names exactly the five
serializable fields, and custom shader GLSL is stored as text inside the clip that uses it.
Everything hard here is about **bytes** — which files exist, which of them the browser is
still allowed to read, and what the editor shows when it cannot read one.

---

## Decisions from the interview

Recorded so they are not relitigated mid-build.

| Question | Decision |
|---|---|
| Where the project lives | **OPFS.** One backend, works in every browser that runs the app today |
| Imported media | **Not copied.** A 4 GB import stays where the user put it; only its identity is stored. No quota exposure, no duplication, no import progress bar |
| App-made media | **Copied — they have nowhere else to live.** Recordings, preset outputs, GPU bakes, captured frames |
| Missing bytes | **Offline placeholder plus relink.** The clip keeps its trims, effects and keyframes and renders as a card; a relink action rebinds it |
| Native folder | **Save-a-copy / open-a-copy only.** A one-shot bundle. No live sync, no rescan, no permission-on-every-load |
| Project model | **One implicit session**, with the file format shaped so named projects need no migration. Plus a **Clear everything** that really clears everything |
| Derived assets | **Independent of their source.** Deleting an original never touches the bake or preset output made from it — only the lineage label goes stale |

### Why the folder is not the store

It was the starting preference and it lost on one fact: in Chromium, `createWritable()` on a
file outside OPFS writes to a `.crswap` swap file and commits only on `close()`. A tab killed
mid-capture would leave **zero bytes** — the exact opposite of the guarantee
`recordingStore.ts` is built on ("whatever reached disk is already a valid file", sidecar
written before the first byte). The streaming primitive that would fix it,
`createSyncAccessHandle()`, is OPFS-only. `showDirectoryPicker()` is also Chromium-only, and
a persisted directory handle needs a fresh `requestPermission()` — from a user gesture — on
every reload. As a *destination* none of that matters; as the store, all of it does.

---

## What the current model cannot express

`MediaAsset` is `{ id, file: File, blobUrl, … }` — a live handle and an object URL, with no
durable identity behind either. Assets arrive from five places and only one is a file the
user still has:

| Origin | Bytes today | After this plan |
|---|---|---|
| File picker | live `File` | identity only; relinked on open |
| URL fetch | memory | copied to OPFS (the app made it) |
| Recording | **already OPFS + sidecar** | bound to the asset id |
| FFmpeg preset output | memory | copied to OPFS |
| GPU bake, captured frame | memory | copied to OPFS |

Two consequences worth stating before any code:

- **`file` and `blobUrl` become optional.** That is the whole safety mechanism for phase B —
  the compiler then names every one of the ~12 consumers (`mediaElements.ts`, the three
  render paths, filmstrips, waveforms, posters, the overlay editor, FFmpeg) and each must
  answer "what if it is not here?" explicitly.
- **Restore is a `set`, not a `commit`.** Loading a project must not push an undo entry, and
  history starts empty — 100 doc snapshots are not worth persisting, and the store already
  treats history as session state.

---

## The file format

```
OPFS/
  project.json        the document + asset table
  project.prev.json   the previous good copy (there is no rename(); rotate instead)
  media/              app-made bytes, named <assetId>.<ext>
  recordings/         unchanged, sidecars as they are today
  exports/            unchanged scratch, still cleared after each export
```

```ts
interface ProjectFile {
  version: 1;
  savedAt: number;
  doc: EditorDoc;          // exactly docSnapshot()
  assets: StoredAsset[];   // library, in libraryOrder-independent form
}

type StoredAsset = {
  id, type, name, duration, width?, height?, hasAudio?, derivedFrom?;
} & (
  | { origin: 'imported'; fingerprint: { name: string; size: number; lastModified: number } }
  | { origin: 'derived';  opfsName: string }
  | { origin: 'recorded'; recordingId: string; opfsName: string }
);
```

Everything the timeline needs to *draw* itself — durations, dimensions, `hasAudio` — is in
the table, so a restored project lays out correctly with no bytes present at all. That is
what makes offline a display state rather than a broken state.

`version` exists from day one, and the asset table is a list rather than a map so a future
`projects/<id>/` layout is a containing directory, not a format change.

---

## Phase A — the document survives a refresh

Autosave `ProjectFile` to OPFS and restore it on launch. Every asset comes back offline;
nothing renders yet. This phase is deliberately shippable on its own — a timeline that
reappears with the right cuts, effects and keyframes is most of the value.

### Design

- `src/project/projectFile.ts` — pure `toProjectFile(state)` / `fromProjectFile(json)`, plus
  validation. Pure so `check:math` can round-trip a fixture.
- `src/project/projectStore.ts` — OPFS read/write, `project.json` ← `project.prev.json`
  rotation. Written temp-then-copy, because FS Access has no `rename()`.
- Autosave: subscribe to the store, gate on `!docEquals(prev, next)` (the helper already
  exists), debounce ~800 ms, and force a write on `visibilitychange → hidden`.
  `beforeunload` cannot await an async write and is not used as the mechanism.
- `navigator.storage.persist()` requested once, so OPFS is not evictable on a whim.
- Quota is shown, not assumed — see below.
- **Clear everything**: wipes `project.json`, `media/`, `recordings/`, `exports/`, the
  IndexedDB handle store, and the `localStorage` timeline-height key (`App.tsx:15`), then
  reloads. One button, one confirm, no partial states.

### Risks

- Two tabs on one origin autosave into one file, last write wins. Phase A takes a heartbeat
  claim in `project.json`; a second tab opens read-only and says so.
- A project saved mid-export references an `exports/` scratch file that `clearExportScratch()`
  then deletes. Exports are not assets, so the table cannot reference them — verified by the
  reachability test in phase C.

### DOD

- Import, cut, add effects and keyframes, refresh → identical timeline, identical inspector,
  every clip offline.
- Undo after restore does not cross the restore.
- `check:math`: a fixture project round-trips `toProjectFile → fromProjectFile` byte-identically.
- Killing the tab 100 ms after an edit loses at most that edit, never the file.
- Clear everything leaves the app in its first-run state.

---

## Quota, shown

Storage is the one resource this app can exhaust silently, and the failure lands at the
worst possible moment — forty minutes into a take. It is never presented as a raw byte
count alone, because "3.2 GB of 48 GB" does not answer the question anyone is actually
asking.

### The number that matters is time

The Record panel already knows what a take costs: `estimatedBytesPerSecond()` exists "for
the panel's estimate" and the panel renders `≈ 4.1 GB per hour at this rate`
(`RecordPanel.tsx:260`). Divide the free bytes by that and the readout becomes the one a
person can act on:

> `≈ 4.1 GB per hour at this rate · room for about 6 h 40 m`

The same conversion is what makes a warning meaningful: **under 15 minutes of headroom is a
warning, under 5 is a refusal to start a new take.** Refusing is the kinder failure — a take
that dies at minute 38 has already cost the thing it was recording.

`src/utils/storageBudget.ts` holds this as pure functions — `headroomSeconds(free, bytesPerSecond)`,
`budgetLevel(free, quota, headroomSeconds)`, `formatHeadroom(seconds)` — so `check:math`
asserts the arithmetic and every threshold boundary, per the project's rule about anything
numeric.

### Where it appears

| Place | Shows | Why there |
|---|---|---|
| Media library header | `3.2 GB of 48 GB` plus a thin bar, amber under 10% free, red under 2% | The library is where bytes accumulate and where assets get deleted |
| Media library rows | A size on each asset that owns OPFS bytes — recordings, bakes, preset outputs | Deletion never cascades, so these are the only files that reclaim space; they have to be findable |
| Record panel, before Record | Headroom in **time**, beside the existing per-hour estimate | The only moment the number can still change a decision |
| Record panel, during a take | The live byte counter gains a remaining figure | The counter already exists as proof bytes reach disk; this makes it a gauge |
| Clear everything | What will be freed, broken down: project, media, recordings, export scratch | A destructive confirm should say what it is worth |

`navigator.storage.estimate()` covers the whole origin — OPFS media, recordings, export
scratch, IndexedDB — so one figure is honest for the entire app. It is refreshed on library
change, on opening the Record panel, and after each recording and export. Never polled at
frame rate.

### Evictable is a different word from full

`navigator.storage.persisted()` is shown as a word next to the bar: **Persistent** or
**Can be evicted**. They are independent failures — plenty of free space and evictable
storage still loses a project. Two specifics worth naming:

- Safari evicts origin storage after **7 days without interaction**, regardless of free
  space. For a browser-only editor with no backend, that is a real data-loss path and the
  reason phase E's "save a copy" is worth building rather than optional. It is stated in the
  UI for Safari users, not buried here.
- `quota` is a padded estimate, not a promise. The readout says `about`, and the thresholds
  leave margin rather than trusting the last percent.

### Running out mid-write

A `write()` past the quota rejects with `QuotaExceededError`. The capture engine catches it,
stops that source cleanly, and keeps what is on disk — which is already a valid file by
design, and is exactly the path `endedReason` on the sidecar exists to describe. The take
ends early and says why; it does not throw away the thirty-eight minutes that made it.

### DOD

- With a nearly-full disk, the Record panel shows a headroom figure that matches what the
  take actually writes, within a few percent over 5 minutes.
- Under 5 minutes of headroom, Record refuses and explains; over 15, no warning appears.
- `check:math`: headroom arithmetic and every threshold boundary, both sides.
- Filling the quota mid-take ends that source with a stated reason and leaves a playable file.
- The library figure moves after an import, a bake, a recording and a delete.

---

## Phase B — offline is a first-class state

Make `file`/`blobUrl` optional and answer the compiler.

### Design

- Timeline: an offline clip keeps its block, label and duration, hatched, with an "offline"
  badge instead of a filmstrip or waveform.
- Preview: the compositor draws a placeholder card (name + "Media offline") in the clip's
  own frame rectangle, through the *shared* `overlayTransform` — not a second placement rule.
- Library: offline entries greyed, with **Relink** on each and a header count.
- Export refuses to start while any clip in range is offline, naming them. A silent black
  frame in a finished file is the failure mode this exists to prevent.
- `probeMediaFile` is not re-run on restore; the table is the source of truth until a relink
  produces a real file, which then re-probes and reconciles.

### DOD

- A restored project scrubs and plays: online clips render, offline clips show the card,
  audio does not desync around them.
- Export is blocked with a named list; exporting a range containing no offline clips works.
- `npx tsc --noEmit` clean with `file?`/`blobUrl?` — no `!` assertions added to silence it.

---

## Phase C — app-made bytes actually persist

### Design

- `adoptProduced()` writes the produced file to `media/<assetId>.<ext>` before it enters the
  library. One place, so preset outputs and bakes are covered together; captured frames and
  URL imports call the same helper.
- Recordings are **bound, not copied**: `StoredAsset.recordingId` points at the existing
  sidecar. On restore, `fileOf(meta.readyFile)` rehydrates the asset.
- `findOrphans()` gains an exclusion set: a recording referenced by the restored project is
  not an orphan. This is the actual bug the current code has — after a refresh it offers a
  project's own recordings back as leftovers.
- Garbage collection: on load, delete `media/` files and recording sidecars that no
  `StoredAsset` references. Deleting an asset from the library deletes its bytes; **undo does
  not restore them**, which is consistent with `mediaLibrary` being outside `docSnapshot()`
  and must be said in the confirm dialog.
- **Deletion never cascades.** An asset made by a preset or a bake is a file in its own right:
  deleting the original it came from leaves it untouched and playable. Only its lineage goes
  stale, which the type already anticipates — `derivedFrom.assetId` is documented as "may
  since have been removed". The library renders that case as the preset label alone
  (`Baked effects`) rather than naming a source that is gone; GC keys on `StoredAsset`
  reachability and never on `derivedFrom`, so a dangling lineage is display text and nothing
  more.
- The consequence is worth stating plainly: under this design **imported originals have no
  OPFS bytes and derived assets have all of them**, so deleting an original frees nothing and
  the only files that reclaim space are the ones deletion is forbidden from cascading to. The
  library therefore shows a size on every asset that owns bytes — see below — or the biggest
  files become unfindable.

### DOD

- Record → refresh → the recording is a normal online clip, and the recovery prompt does not
  mention it.
- Run a preset, bake a clip, save a frame → refresh → all three online.
- Delete an asset, reload → its bytes are gone from OPFS.
- Bake a clip, delete the original from the library, reload → the bake still plays, still
  shows its label, and its bytes are still there.
- `check:math`: given a project file, the reachable-name set is exactly what GC keeps.

---

## Phase D — relink

The dominant path, because imports are never copied: any project with imported media reopens
offline.

### Design

- **One picker, many files.** `Relink all` opens a multi-select picker; each chosen file is
  matched to an offline asset by fingerprint — exact `(name, size, lastModified)` first, then
  `(name, size)`, then name alone with a "this file differs" warning. One gesture for a whole
  project, and it works in every browser via `<input type="file" multiple>`.
- **Silent fast path, best-effort.** When `showOpenFilePicker` is available, persist each
  `FileSystemFileHandle` in IndexedDB. On load, `queryPermission({mode:'read'})`; anything
  already `granted` rehydrates with no click. Chrome grants this to frequently-used and
  installed sites — treated as a bonus, never as the design.
- A relinked file whose duration disagrees with the table keeps the *stored* duration and
  flags the clip, rather than silently moving cuts.

### DOD

- A 10-asset project relinks in one picker interaction.
- Picking a wrong-but-same-named file warns and does not move any cut.
- Relinking one asset relinks every clip that references it.
- Declining the picker leaves the project exactly as it was — offline, not damaged.

---

## Phase E — save a copy to a folder

Portability, backup, and the escape hatch from quota.

### Design

- **Save a copy** → `showDirectoryPicker()` → writes `project.json` plus **every** asset,
  imported originals included: they are live `File`s during the session, so the bundle is
  self-contained even though OPFS is not.
- **Open a copy** → pick the folder → read `project.json`, bind assets to the folder's files
  for this session, and store the *directory* handle in IndexedDB. One directory grant covers
  every file inside it, so a project that has ever been saved to a folder reopens with a
  single click rather than a relink pass. This is the strongest reason to build phase E.
- Non-Chromium: **Save project file** downloads `project.json` alone, media not bundled, and
  says so. A zip bundle is a later option and a dependency; not in this plan.

### DOD

- Save to a folder, Clear everything, Open the folder → the project is whole, online, and
  never asks for a relink.
- Moving the folder to another location and opening it there still works.
- Firefox/Safari get the JSON path with an accurate explanation, not a broken button.

---

## Later, not now

- **Thumbnail and waveform cache** in OPFS. Filmstrips and waveforms are memory-only, so
  reopening a 40-clip project re-decodes all of them; an offline clip cannot re-derive them
  at all. Caching makes a restored project look right immediately. Real value, no
  correctness weight.
- **Named projects.** `projects/<id>/` with the same layout, a picker, and a rule for assets
  shared between projects. The format is already shaped for it.
- **Drag-and-drop from Finder onto a track+time** — the other half of ux-plan phase 6, and
  independent of everything above.

---

## Results

Shipped: phases A–E and the quota work, in one pass. `npm run build` is clean,
`npx tsc -p tsconfig.app.json --noEmit` is clean, and `check:math` is at **264 assertions,
ALL PASS** (was 223 — 41 new). Everything below was found while building and is not in the
plan above.

### What the plan got right

**Making `file` and `blobUrl` optional was the whole safety mechanism.** The compiler named
exactly twelve call sites, which is what the plan predicted, and each one turned out to have
a different right answer rather than a shared one: the element pool returns `null` (nothing
to decode), the export collectors skip (unreachable behind the guard), and the WebCodecs
demuxer throws with the file's name (loud beats a black rectangle). No `!` assertions were
added to make it compile.

**The orphan bug was real and would have shipped with phase A.** `findOrphans()` documents
itself as returning "everything on disk that is not in the current session's library", and
the exclusion it relies on is a `useRef` — which a reload empties. Restoring a project
without `useCaptureSession`'s new `owned` set would have offered every recording in the open
project back as a crash leftover.

### What changed against the plan

| Planned | Actually shipped | Why |
|---|---|---|
| Offline placeholder drawn "through the shared `overlayTransform`" | Drawn as a **canvas handed to `gl.drawSource`** | Stronger version of the same idea. The card is rasterized at the source's own dimensions and enters the normal path, so it inherits transform, crop, fade *and* the effect chain with no new placement code at all |
| `project.json` + `project.prev.json` rotation | Same, plus the old copy is secured **before** the new one is written | The order is the property: a tab killed anywhere in the sequence leaves at least one complete file |
| Relink matches on three tiers | Same three, but each sweep spends a file once and fills an asset once | Two files named `holiday.mp4` of different sizes could otherwise be swapped by iteration order — now asserted |
| — | **Added:** a clip referencing an asset the file does not describe gets a `Missing file` placeholder | Otherwise it is invisible *and* unrelinkable: nothing could tell it what it was waiting for. Repairing beats discarding someone's edit over a missing field |
| — | **Added:** producers refuse to run on offline media | `fetchFile()` accepts `undefined` and would have encoded an empty input silently. This was a live hole, not a hypothetical |
| — | **Added:** `removeLibraryItem` now explains its refusal | It returned bare. Tolerable when deleting only dropped an entry; not now that it also deletes bytes nobody can re-supply |
| Quota shown in four places | Four places, and headroom **counts down during a take** | The estimate is not refreshed mid-recording, so the bytes already written are subtracted. Without it the figure sat still while the disk filled |

### Two bugs written and caught here

- `useStorageBudget` first depended on `processJob`, which is republished on every progress
  tick — an `estimate()` per tick. It depends on the job's *phase* now.
- The folder-open path attached bytes by laundering `MediaAsset` through `StoredAsset`, which
  `rehydrate` then ignored, re-looking-up every file. `restoreProject` takes an explicit
  `files` map instead.

### Deliberately not done

- **Thumbnail and waveform cache.** Still memory-only, so a restored project re-decodes its
  filmstrips and an offline clip shows none at all. Listed as later work and unchanged.
- **A zip bundle for Firefox and Safari.** Those browsers get project JSON alone with an
  explicit sentence saying the media is not in it.
- **Named projects.** The format is shaped for it — `version`, and an asset *list* rather
  than a map — but there is one implicit session.

### Two defects found in use, and what they cost

Reported after the first browser session: a reload always said *"open in another tab"*, a
baked clip came back offline, and a second reload lost the project. One root cause, one
consequence, and they are worth recording because both were designed in rather than mistyped.

**The claim could not be released.** `claimProject` wrote a `session.json` heartbeat and
treated a claim under 15 seconds old as live. Release ran on `pagehide` via `removeEntry` —
which is **asynchronous**, and the page is gone before it lands. So every reload found its own
heartbeat and declared itself a second tab. Liveness cannot be inferred from a file that a
dying tab was supposed to clean up. It is now *asked*: a `BroadcastChannel` probe with a
250 ms window, which does not deliver to its own sender, so a lone tab hears nothing and takes
ownership, and a crashed tab cannot answer at all. There is no stale window left to wait out.

**And a read-only tab is one that does not autosave** — which turned the first defect into
data loss, through a second one. `collectGarbage` deleted every file in `media/` the loaded
project did not reference. That is only the same thing as "garbage" when the project on disk
is *current*. It was not: a bake made in a tab that could not save, or made in the second
before the debounce fired, is unreferenced and very much wanted. The sweep took it.

Three changes, each closing a different part of it:

| Change | Why this one |
|---|---|
| `collectGarbage(keep, newerThan)` skips anything modified at or after the project's `savedAt` | A file newer than the save cannot be described by it *by definition*. It is collected on some later load, once the project has had a chance to mention it |
| The sweep is skipped entirely in a read-only tab, and in a folder-bundle open | A read-only tab holds a project that is behind the one on disk by construction; a bundle's assets live in the folder, so OPFS reachability says nothing about them |
| A produced file **flushes the project immediately**, skipping the debounce (`saveSignal.ts`) | The debounce exists so a drag does not write sixty times. A bake costs minutes of encoding and cannot be recreated by re-picking anything — it should never be sitting in a debounce window |

`removeLibraryItem` also no longer drops bytes in a read-only tab: the deletion is not being
saved, so it would take a file the owning tab still references.

Two smaller hardenings went in alongside: `putMedia` now materialises the bytes before
writing (the source is often a `File` over another OPFS entry) and **reads the file back**,
because a short write is otherwise invisible until a reload — at which point the only evidence
is a clip claiming to be offline about a file that was never anywhere else. If it does fail,
the library says so immediately, while the source clip is still there to bake again.

The sweep rule is now a pure predicate, `isCollectable`, with four assertions in `check:math`
covering both sides of the boundary. It is a regression test, not a precaution.

For diagnosing any recurrence, `__project.diagnose()` in a dev build reports `missing`
(references with no bytes) against `orphaned` (bytes nothing references) — the two symptoms
this pair of defects produced.

### DOD — for the browser, all unticked

Phase A: import, cut, add effects and keyframes, refresh → identical timeline and inspector,
every imported clip offline · undo after restore does not cross the restore · killing the tab
100 ms after an edit loses at most that edit · Clear everything returns the app to first-run.

Phase B: a restored project scrubs and plays, offline clips showing the card without
desyncing the audio around them · export is blocked with a named list.

Phase C: record → refresh → a normal online clip, and **the recovery prompt does not mention
it** · run a preset, bake a clip, save a frame → refresh → all three online · delete an
asset, reload → its bytes are gone · bake a clip, delete the original, reload → the bake
still plays.

Phase D: a 10-asset project relinks in one picker interaction · a wrong-but-same-named file
warns and moves no cut · declining the picker leaves the project offline, not damaged.

Phase E: save to a folder, Clear everything, open the folder → whole, online, no relink ·
move the folder elsewhere and open it there.

Quota: the Record panel's headroom matches what a take actually writes · under 5 minutes
Record refuses, over 15 nothing appears · filling the quota mid-take ends that source with a
stated reason and leaves a playable file.
