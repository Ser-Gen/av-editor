# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-track audio/video editor that runs entirely in the browser — no backend. React 19 +
zustand + TypeScript on Vite. Rendering is WebGL; export is WebCodecs with FFmpeg WASM as the
fallback. `README.md` documents the app from the user's side; `docs/capture-effects-plan.md` and
`docs/audio-export-plan.md` and `docs/media-info-plan.md` are the phased plans of record, each
with a results section and a DOD checklist per phase.

## Commands

| Command | Notes |
|---|---|
| `npm run bootstrap` | Required before the first `dev`: copies FFmpeg core into `public/ffmpeg/`, downloads the DejaVu font |
| `npm run dev` | Vite dev server. No special headers: the bundled `@ffmpeg/core` is single-threaded, so nothing here needs cross-origin isolation |
| `npm run build` | `tsc -b && vite build` |
| `npm run check:math` | The only automated test suite — see below |

There is **no test runner and no linter**. `npx tsc --noEmit` is the fast type check.

`check:math` bundles `scripts/checkProjectMath.ts` with esbuild and runs it under node: a flat
list of `check(name, got, want)` assertions over the project's pure logic (reframing, export
bitrates, shader annotations, tool presets, capture math). It prints `ALL PASS` or exits 1. Add
assertions here for anything numeric. Its constraint: **it cannot import anything that touches
Vite-only specifiers** (`?worker&url`) or the DOM at module scope — which is why pure logic is
deliberately split out of files like `runPreset.ts` into importable modules.

Anything needing a real browser (playback, capture, GPU) is checked by hand. Dev builds expose
`window.__store`, `__effects`, `__capture` and friends (`src/main.tsx`) for driving those from
the console.

## Structure

```
src/store/      editorStore.ts (one zustand store, all actions), history.ts, clipFactory.ts
src/project/    persistence: project file, OPFS stores, autosave, relink, folder bundle
src/render/     GLCompositor.ts + effects/ (registry, custom shader compiler, presets)
src/preview/    PlaybackEngine.ts — drives <video>/<audio> elements against the compositor
src/export/     runExport.ts, webcodecs/ (fast path), audio/ (audio-only), buildFilterGraph.ts
src/capture/    recording: CaptureSession, source acquisition, two engines, OPFS store, recovery
src/tools/      FFmpeg preset jobs (presets.ts) and the GPU bake (bakeClip.ts)
src/utils/      shared semantics — see below; most of the pure logic lives here
src/components/ UI, including Timeline/
```

## The aspects that are not simple

**Three render paths must agree.** The preview compositor, the WebCodecs export and the FFmpeg
fallback each draw the same project. They stay in agreement by *sharing* the modules that define
what a project means — `utils/compositeOrder.ts` (layer order), `utils/clipRender.ts` (fades,
animated effect params, clip clock), `utils/overlayTransform.ts` (crop/frame placement),
`render/effects/registry.ts`. Never implement a placement or effect rule twice; a second
implementation turns "what you see is what you get" into something to test for rather than
something that is true. Note the two engines genuinely differ in colour space — FFmpeg filters in
YUV, the compositor in RGB — so a filter and its shader equivalent are *not* interchangeable.

**Undo is a document snapshot, not a command log.** `commit(label, fn)` in `editorStore.ts` is how
every undoable mutation is made. `docSnapshot()` in `history.ts` defines exactly what is undoable:
settings, exportSettings, tracks, clips, libraryOrder. `mediaLibrary` is deliberately outside it —
importing a file is not undone by pressing undo. One user action must be one entry, including
compound ones (a whole drag, a recording that also changes the project frame rate).

**A clip is a reference, never a copy**: `(assetId, sourceTrimIn, sourceTrimOut)`. Split, trim and
duplicate move numbers only. All edits quantize to `1/fps` (`utils/time.ts`), which is what keeps
preview and export agreeing about where a cut is.

**The build is relative-based and unhashed**, so `dist/` can be hosted from any directory of
any static host. Vite rewrites the URLs it can see; it cannot see a string passed to `fetch()`,
so a new hand-written path to something in `public/` must go through `publicUrl()`
(`src/utils/publicUrl.ts`) — an absolute `'/fonts/…'` works in dev and breaks everywhere else.
See the README's Hosting section.

**One shared FFmpeg WASM instance** (`export/ffmpegLoader.ts`) serves both export and the library
tool presets. Two consequences that have already caused bugs: `ffmpeg.on()` *appends* handlers, so
every registration needs a matching `off()` in a `finally`; and `terminate()` is the only thing
that actually cancels a WASM encode, which kills whatever else is running. Producers therefore
refuse to start while `exportProgress !== null`.

**Recording never buffers in memory.** Encoded bytes stream to OPFS as they are produced, and a
JSON sidecar is written *before* the first byte so a killed tab leaves a described file. The
container is a fragmented MP4 for the same reason: whatever reached disk is already a valid file.
The `MediaRecorder` fallback writes a live container with no duration or seek index, so those
recordings are remuxed on stop. Sources are separate files with measured start offsets — that
sub-frame alignment is why recordings are *placed* rather than imported.

**`src/tools/presets.ts` arg arrays are transcribed verbatim** from `shir-effects.txt`, and
`check:math` re-parses that file and diffs all of them element-by-element. A "tidied" filter chain
fails the check run. That is the point.

**The project persists; imported media does not.** `project.json` in OPFS is `docSnapshot()`
plus a serializable asset table, autosaved debounced and flushed on `visibilitychange`
(`beforeunload` cannot await an async write). Files the app *made* — recordings, preset
outputs, bakes, captured frames — are kept in OPFS, because nobody can be asked for them
again; recordings are bound to their existing sidecar rather than copied. Files the user
*imported* are never copied, so every reopened project starts with them **offline**:
`MediaAsset.file` and `.blobUrl` are optional on purpose, which is what forces each consumer
to answer for the missing case instead of assuming. Offline is a display state, not an error
— the timeline lays out from the stored table, the preview draws a placeholder card through
the ordinary `drawSource` path, and export refuses to start. See
`docs/persistence-plan.md`.
