# Audio Export & Metadata Plan

Continuation of [`capture-effects-plan.md`](./capture-effects-plan.md), which covered
recording, effects and the WebCodecs export path. Nothing here depends on its open items.

This plan adds an output the editor does not have at all today: **an audio-only file** —
MP3, M4A, WAV, FLAC or Ogg — with its own settings, and a **form for descriptive metadata
tags** (title, artist, album, cover art) written into whatever is exported.

> **Status (2026-08-25):** phases A–D implemented, `check:math` and the build pass, browser
> checks left to the user. See the results section at the end.

Every phase below ends with a **DOD** — a short list of checks that must pass before the next
phase starts.

---

## Why this is needed

The editor can produce exactly one kind of file: an MP4 of the whole composition. There is no
way to get *just the audio* out — no MP3 of a recorded call, no WAV to hand to a DAW, no FLAC
to archive. And nothing the app writes carries descriptive tags: `exportWebCodecs.ts` sets a
creation date and a fixed comment and that is the entire metadata story, so an exported file
has no title, no artist, no album — nothing a music player or a podcast host would read.

Recording an hour-long call is already a first-class use of this editor. The file you actually
want out of one of those is usually audio.

## Two constraints found before designing

Not guesses — this is what the libraries do.

| Fact | Evidence | Consequence |
|---|---|---|
| Chrome's WebCodecs cannot encode MP3 | `canEncodeAudio('mp3')` falls through to `AudioEncoder.isConfigSupported`, which says no (`mediabunny/…/encode.js:446-460`) | MP3 needs an encoder from somewhere: a new dependency, or FFmpeg |
| Mediabunny already muxes every wanted format | `Mp3OutputFormat`, `WavOutputFormat`, `OggOutputFormat`, `FlacOutputFormat`, `Mp4OutputFormat`, and `Output.setMetadataTags()` writes tags into all of them | No muxing work at all. The tags land in each format's native convention: ID3v2 for MP3, `ilst` for MP4, Vorbis comments for FLAC/Ogg, RIFF INFO or ID3 for WAV |

Mediabunny also encodes PCM and reads back FLAC itself, so **WAV needs no encoder** — it is the
format that works when nothing else will.

## Decisions from the interview

Recorded so they are not relitigated mid-build.

| Question | Decision |
|---|---|
| MP3 encoder | **`@mediabunny/mp3-encoder`** — mediabunny's official LAME extension, MPL-2.0 like mediabunny itself, ~312 KB with the WASM inlined, encoding in a worker. Lazily imported, so it costs nothing until MP3 is chosen. Rejected: FFmpeg's `libmp3lame`, which is already in our core but can only be handed a *finished* WAV — ~660 MB in the WASM heap for an hour of 48 kHz stereo, which is precisely the case this feature exists for |
| Where the tags live | **Per export, for now.** Session state in the store, outside `docSnapshot()`: no undo entry, nothing in `project.json`. Typed as its own object so promoting it into the document later is a one-line change |
| Cover art | **Chosen from the media library**, referenced by `assetId`. Nothing new to persist and nothing new for the OPFS garbage collector to reach. An offline image is dropped with a notice rather than failing the export |
| Which exports carry tags | Audio **and** the existing MP4. `setMetadataTags` already runs on the video path; it was simply being given a fixed comment |
| Engine | Audio export runs on the mediabunny path only. FFmpeg has no part in it |

## Why the audio path is small

The hard part — the mix — is already written and already correct. `mixdownWindows()`
(`src/export/webcodecs/audioMixdown.ts`) renders the project mix in bounded windows with
fades, transitions and per-clip gain applied, streaming rather than buffering. The audio-only
export is that generator, a muxer, and a file:

- `mixdownWindows()` / `downmixToMono()` — the mix and the mono fold
- `MediaInputCache` (`src/export/webcodecs/mediaInputs.ts`), `audibleClips()` (`src/utils/compositeOrder.ts`)
- `openScratchFile()` (`src/export/webcodecs/opfs.ts`) — streams to OPFS, so an hour-long
  export stays flat in memory and comes back as a disk-backed `File`
- `downloadFile()`, `exportBlockedBy()`, `clearExportScratch()` around `runExport.ts`

**No new audio logic is introduced.** That is what keeps an exported MP3 identical to what the
MP4's audio track would have been, which is the same "one definition, used twice" rule the
three render paths already follow.

---

## Phase A — the settings model and the pure core

Two new DOM-free modules, so `check:math` can cover the arithmetic and the tag mapping. Both
use `import type` only from mediabunny; esbuild erases those, so the check bundle stays
node-safe.

**`src/utils/audioExport.ts`**

- `AudioFormat = 'mp3' | 'm4a' | 'wav' | 'flac' | 'ogg'`
- `AUDIO_FORMATS` — one row per format: label, extension, MIME type, mediabunny codec
  (`mp3` / `aac` / `pcm-s16` / `flac` / `opus`), lossless flag, the bitrates it offers, and one
  sentence saying what it is for. `.m4a` is a deliberate override of
  `Mp4OutputFormat.fileExtension` (`.mp4`), which is wrong for an audio-only file
- `resolveAudioExport(settings)` — mirrors `resolveExport()` on the video side
- `estimateAudioBytes(resolved, seconds)` — lossy is `bitrate / 8 × seconds`; WAV is
  `sampleRate × channels × 2 + 44`; FLAC is a stated ~0.6 of the PCM size
- `audioFileName(tags, resolved, now)` — the Title tag, sanitised, when there is one;
  otherwise `export_<timestamp>`

**`src/utils/audioMetadata.ts`**

- `AudioMetadata` — title, artist, album, albumArtist, genre, comment, lyrics (strings);
  trackNumber, tracksTotal, discNumber, discsTotal (`number | null`); date as an ISO
  `yyyy-mm-dd` string, which is what `<input type="date">` gives; `coverAssetId: string | null`
- `toMetadataTags(meta, cover?)` → mediabunny's `MetadataTags`. Blank strings and nulls are
  **dropped, not written empty** — an empty ID3 frame is worse than an absent one
- `wavMetadataFormat(meta)` → `'info' | 'id3'`. RIFF INFO is what DAWs read but holds only a
  small subset, so INFO is used unless the tags include something it cannot carry (cover art
  or lyrics)

**`src/types/editor.ts`** — `ExportSettings` gains `output: 'video' | 'audio'`,
`audioFormat`, `audioSampleRate`. The existing `audioBitrate` and `audioChannels` are reused;
parallel fields would be two places to disagree.

**`src/project/projectFile.ts`** casts `doc.exportSettings` through without looking at it, so a
project written before this change would load with `audioFormat` undefined and an empty
select. `DEFAULT_EXPORT_SETTINGS` is merged underneath it — the "repair rather than discard"
rule the file's own header states. This avoids bumping `PROJECT_FILE_VERSION`, which returns
`null` on mismatch and would throw away every existing project.

**DOD**
- [x] `check:math` covers the format table (each row's extension, MIME, codec)
- [x] Size estimates checked at known rates, for lossy and for PCM
- [x] Filename sanitising, including a title that is entirely punctuation
- [x] Tag mapping: blank fields absent from the result, date parsed, track numbers carried
- [x] The WAV INFO/ID3 rule
- [x] A project-file fixture predating the new fields loads with defaults filled in

## Phase B — the audio export run

`npm install @mediabunny/mp3-encoder` (peer-depends on `mediabunny ^1.0.0`; 1.51.0 satisfies it).

`mixdownWindows()` takes the sample rate as a parameter defaulting to `MIX_SAMPLE_RATE`, so
`OfflineAudioContext` renders 44.1 kHz directly instead of resampling afterwards. The video
path passes nothing and is untouched.

**`src/export/audio/exportAudioTrack.ts`** — the whole run:

1. Duration and `audibleClips()`, as the video path does
2. If the codec is `mp3` and `canEncodeAudio('mp3')` is false, lazily import
   `@mediabunny/mp3-encoder` and register it. Any other codec the browser refuses throws a
   message naming the format and pointing at WAV, which needs no encoder
3. Cover art: resolve `coverAssetId`, read bytes from `asset.file`; offline → drop it and set
   a notice, never fail
4. `Output` with the chosen format + `StreamTarget(scratch.writable, { chunked: true })`,
   `setMetadataTags(...)`, one `AudioBufferSource`
5. Pump `mixdownWindows()` to the end, `downmixToMono()` when mono, progress from
   `audioSeconds / duration`, aborting per window
6. `finalize()`, hand back the `File`

`runExport()` branches on `exportSettings.output` before the engine choice. The audio path
never touches FFmpeg and never probes for AVC: `webCodecsExportSupported()` tests a *video*
encoder, which is the wrong question when the answer for WAV is "no encoder needed". A project
with no audible clips is refused up front, the same shape as the existing empty-project and
offline-media refusals.

**DOD**
- [ ] All five formats export from a project with a video clip and a music clip
- [ ] The MP3 opens in a player showing the tags typed
- [ ] An hour-long recording exports without the tab's memory climbing
- [ ] Cancel mid-export leaves no file in OPFS

## Phase C — the UI

An **Output** switch at the top of the export dialog: Video (MP4) / Audio only. Video keeps
today's dialog exactly. Audio replaces the quality list, the output size and the keyframe
interval — none of which mean anything without a picture — with format, bitrate (disabled and
labelled lossless for WAV and FLAC), sample rate, channels, and the same estimate sentence,
which is the most useful line on the screen.

The **tag form** is a disclosure inside that same dialog rather than a separate modal, so the
thing being described and the description are edited in one place: a label/input grid, number
inputs for track and disc, a date input, a `<select>` of the library's image assets for the
cover, and a Clear button. A note says plainly that tags are remembered while the tab is open
but are not saved with the project — which is the decision, and saying it beats letting
someone discover it.

Save writes settings through `setExportSettings` (an undoable `commit`, as now) and tags
through `setAudioMetadata`, a plain `set` deliberately outside `docSnapshot()`.

The toolbar's settings button reads `MP3 · 192 kbps` in audio mode instead of the video preset
name; the primary button says `Export MP3`; `Export (FFmpeg)` is disabled with a title
explaining FFmpeg has no part in an audio export.

**DOD**
- [ ] Switching to Audio and back leaves the video settings untouched
- [ ] The estimate tracks the format
- [ ] Tags survive closing and reopening the dialog
- [ ] An offline cover image warns at export instead of failing it

## Phase D — docs

`README.md` gains an "Exporting audio" section: the formats and what each is for, the
settings, and the tag list with a note on which formats carry which tags.

---

## Results

Filled in as phases land.

### Phase A–D — what the exploration turned up

- **`bitrateMode` and MP3 are unrelated problems.** The recording work established that
  WebCodecs defaults to variable bitrate. That says nothing about MP3, which Chrome cannot
  encode at any bitrate mode — the gap is an encoder, not a setting.
- **`webCodecsExportSupported()` is a video question.** It probes `avc1.42001f`. Reusing it to
  gate audio export would have refused WAV on a machine with no H.264 encoder, even though WAV
  needs no encoder at all. The audio path asks `canEncodeAudio` about the codec it will
  actually use, and asks nothing when writing PCM.
- **The project file quietly widens.** `fromProjectFile` casts `exportSettings` through
  unvalidated, so every field added to `ExportSettings` since the format was frozen has been
  arriving as `undefined` in projects written earlier. Defaults are now merged underneath,
  which fixes this addition and every future one.
- **Three of those fields are lookup keys.** `quality`, `output` and `audioFormat` index tables.
  An unrecognised value would not degrade — it would throw on a property of `undefined` and take
  the dialog with it — so the repair validates those three against their known values rather
  than only filling in missing ones.
- **The modal had no height limit.** `.modal` was `display: flex` with no `max-height`, which
  was survivable while the tallest dialog was three preset cards. With the tag form open the
  Save button sat below the bottom of the window with no way to reach it. The modal now scrolls.
- **The LAME encoder splits cleanly.** Vite emits it as its own 311 kB chunk
  (`mediabunny-mp3-encoder-*.js`, 131 kB gzipped) behind the dynamic import, so a session that
  never exports MP3 never fetches it.

### Checks

`npm run check:math` — 521 assertions, ALL PASS. `npx tsc -p tsconfig.app.json --noEmit` and
`npm run build` clean. The browser checks in phases B and C are left to the user.
