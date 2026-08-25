# Media Info Plan

Continuation of [`audio-export-plan.md`](./audio-export-plan.md), which added audio-only export
and a form for writing metadata tags. This is the read side of the same library: **what is
actually in a file**, shown per library item — an ffprobe, in the browser, with no FFmpeg.

> **Status (2026-08-25):** phases A–D implemented, `check:math` and the build pass, browser
> checks left to the user. See the results section at the end.

Every phase below ends with a **DOD** — a short list of checks that must pass before the next
phase starts.

---

## Why this is needed

The library can say four things about a file: its name, its type, a duration, and — for files
the app made itself — a size. Everything else is invisible.

That gap shows up at the worst moments. An export declines the fast path with *"X cannot be
decoded by WebCodecs in this browser"* and there is nowhere to go and see what X is. A recording
comes back from a crashed tab and nothing shows what it really contains against what its header
claims. And having just built a form for *writing* tags, there was still no way to read them
back off a file — including one this editor exported five minutes earlier.

## What mediabunny gives us

Everything ffprobe would, minus the WASM. Per file: `getFormat()`, `getMimeType()`,
`getDurationFromMetadata()`, `getMetadataTags()`. Per track: `getCodec()`,
`getCodecParameterString()`, `getLanguageCode()`, `canDecode()`, and then the kind-specific set
— `getCodedWidth`/`getDisplayWidth`/`getRotation`/`getPixelAspectRatio`/`getColorSpace`/
`hasHighDynamicRange`/`canBeTransparent`/`hasOnlyKeyPackets` for video,
`getNumberOfChannels`/`getSampleRate`/`getBitrate` for audio. Plus `computePacketStats()` and
`computeDuration()` for what the header cannot be trusted about.

It is **already in the main bundle** — `useCaptureSession` → `capture/engine.ts` imports it
statically — so none of this costs a byte of new download.

## The cost line that shapes the design

Not every one of those is free.

| Call | Cost | Evidence |
|---|---|---|
| `getFormat`, `getTracks`, every per-track getter, `getMetadataTags` | The header and the index, already parsed | Backed by the demuxer's metadata read |
| `getDurationFromMetadata()` | Reads what the container claims | Documented as "cheaper" than the alternative |
| `computeDuration()` | Walks **every packet** of every track | `input.js:218` fans out to `track.computeDuration()` |
| `computePacketStats(n)` | Walks packets until `n`, then stops | `input-track.js:206-222` |

`computePacketStats` and `computeDuration` iterate with `metadataOnly: true`, so they never
decode and never read sample bytes — but on a fragmented MP4 they still read every `moof`. On an
hour-long recording that is a real wait, which is why measurement is a **button** and not
something the window does on open.

## Decisions from the interview

| Question | Decision |
|---|---|
| Where it appears | **A modal per file**, opened by an ℹ button on the library row and by the row's context menu — exactly as ⚙ opens `ProcessDialog` today. The library column is too narrow for a codec string or a colour space |
| What is read when | **Header facts on open, measurement on demand.** Everything from the index appears instantly; true frame rate, average bitrate and exact duration sit behind Measure, labelled with what they cost |
| Scope | **The import path is fixed too.** The same probe answers a question the app has been guessing at wrongly since it was written |

## The bug this uncovered

`probeMedia.ts` decided whether a video has sound by reading `HTMLVideoElement.audioTracks`:

```js
// Most video files include audio; only mark false when the browser reports no tracks.
hasAudio = true;
if (v.audioTracks && v.audioTracks.length === 0) hasAudio = false;
```

**Chrome does not implement `audioTracks`.** The branch never fired, so every imported video was
recorded as `hasAudio: true` — a silent screen recording included. Visible consequences: the
Inspector offers "Detach audio" on a clip with no audio to detach, and the FFmpeg export runs a
whole `ffmpeg -i` per file (`probeStreams.ts`) to find out the truth for itself.

`(await input.getAudioTracks()).length > 0` answers it from the container, instantly.

---

## Phase A — the probe and the pure formatting

**`src/utils/mediaInfo.ts`** (new, impure — beside `probeMedia.ts`, which is impure for the same
reason)

- `MediaInfo` — container name, MIME, size, duration from metadata, `tracks: TrackInfo[]`, the
  file's own tags, and `unreadable: string | null` for a container that will not parse
- `TrackInfo` — id, kind, codec, full codec string, language, `canDecode`, and the per-kind
  fields
- `inspectAsset(asset)` — one `Input`, read, dispose. Reads no packet data. Offline returns
  early; an unparseable container comes back as `unreadable`, never as a throw
- `measureTracks(asset)` — the on-demand half: `computePacketStats()` per track plus
  `computeDuration()`

**`src/utils/mediaInfoFormat.ts`** (new, pure — `check:math` imports it): `formatFileSize`,
`formatPreciseDuration`, `formatFrameRate`, `formatChannels`, `aspectRatio`,
`describeColorSpace`, `describeRotation`, and `decodeSummary` — the one sentence saying whether
this browser can play the file, which is the answer someone opens the window for.

**DOD**
- [x] Aspect reduction, including a non-square-pixel case
- [x] Frame-rate rounding either side of 29.97
- [x] Channel naming, precise duration across an hour boundary
- [x] Colour-space description, including a partial one
- [x] `decodeSummary` for all-decodable, none-decodable and mixed files

## Phase B — the dialog

**`src/components/MediaInfoDialog.tsx`**, built like `ProcessDialog`. Sections in the order
someone reads them: **File** (with the decode verdict as the headline), **Tracks** (one block
each, a track this browser cannot decode marked there — which is what explains a "fast path
declined" notice), **Measured** (the button and its results), **Tags** (what the file carries,
cover art rendered from the embedded bytes), **Origin** (for a recording, the sidecar: engine,
source, when, negotiated format, why it stopped early; for a derived asset, the preset).

Offline assets show what the library stored and say to relink.

**`src/components/MediaLibrary.tsx`** — an ℹ button for every asset, offline included. The row's
context menu, which opened ProcessDialog for video only, becomes a small menu so info is
reachable by right-click on any file.

**DOD**
- [ ] An MP4, an MP3, a WAV, a PNG and a recovered recording each open without throwing
- [ ] An unparseable container shows the reason instead of an empty window
- [ ] Measure on an hour-long recording finishes and the dialog stays responsive

## Phase C — the import probe

`probeMediaFile` tries mediabunny first for video and audio: duration from metadata,
`displayWidth`/`displayHeight` (post-rotation, so a phone video imports the right way round —
the element probe reports the coded size), and `hasAudio` from the track list. The element probe
stays as the fallback for a container mediabunny cannot parse or a header with no duration.
Images keep the `Image` path; mediabunny does not read PNGs.

**Deliberately not changed:** `fileHasAudioStream` in the FFmpeg export. Projects saved before
this change still carry the old always-true guess in their asset table, and re-probing is what
protects them. It is a per-file `ffmpeg -i` on the fallback path only; removing it would trade a
correctness guarantee for a speed win on the slow path.

**DOD**
- [ ] A silent video imports reporting no audio, and the Inspector stops offering to detach it
- [ ] A rotated phone video imports at its display size
- [ ] A container mediabunny cannot read still imports through the element probe

## Phase D — docs

`README.md` gains a "What's in this file" section under Media Library.

---

## Results

### What the exploration turned up

- **`hasAudio` has always been a guess, and always "yes".** See above. The info window was what
  made it visible: the track list says one thing and the asset table said another.
- **Two of mediabunny's getters cost real time and the rest cost nothing.** The split is not
  obvious from the API — `getDurationFromMetadata()` and `computeDuration()` sit next to each
  other and differ by the whole file. Putting the expensive pair behind a button, and saying so
  on the button, is the entire UX decision here.
- **`displayWidth` is not `codedWidth`.** A rotated phone video has its rotation in the
  container, not in the pixels. The `<video>` element applies it; `codedWidth` does not. Import
  uses the display size, so a portrait video no longer lands sideways.
