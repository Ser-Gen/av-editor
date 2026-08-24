/**
 * The audio-only export.
 *
 * Short on purpose. The mix is the hard part and it is already written: `mixdownWindows()`
 * renders the project's audio in bounded windows with fades, transitions and per-clip gain
 * applied, and both the video export and this one consume the same generator. An MP3 of a
 * project is therefore the MP4's audio track by construction, not by coincidence — the same
 * "one definition, used twice" rule the three render paths follow.
 *
 * What is new here is only the container: which `OutputFormat`, which codec, and — for MP3 —
 * an encoder the browser does not have.
 */
import {
  AudioBufferSource,
  FlacOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  StreamTarget,
  WavOutputFormat,
  canEncodeAudio,
} from 'mediabunny';
import type { MetadataTags, OutputFormat } from 'mediabunny';
import type { EditorState } from '../../types/editor';
import { audibleClips } from '../../utils/compositeOrder';
import { clipDuration } from '../../utils/time';
import { AUDIO_FORMATS, estimateAudioBytes } from '../../utils/audioExport';
import type { ResolvedAudioExport } from '../../utils/audioExport';
import { MIX_WINDOW_SECONDS, downmixToMono, mixdownWindows } from '../webcodecs/audioMixdown';
import { MediaInputCache } from '../webcodecs/mediaInputs';
import { openScratchFile } from '../webcodecs/opfs';

export type AudioExportSlice = Pick<EditorState, 'clips' | 'mediaLibrary' | 'tracks'>;

export interface AudioExportResult {
  file: File;
  durationSeconds: number;
}

/** Thrown when this browser cannot encode the chosen format. Carries a way forward. */
export class AudioCodecUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioCodecUnsupportedError';
  }
}

/**
 * WAVE tops out at 4 GiB; past that it has to be written as RF64, which is a different (and
 * less widely understood) file. Switching only when the size demands it keeps the ordinary
 * case ordinary.
 */
const RF64_THRESHOLD = 3.5 * 1024 * 1024 * 1024;

/** AAC packs this many samples into each packet — the basis of the MP4 packet budget. */
const AAC_SAMPLES_PER_PACKET = 1024;

function outputFormatFor(
  resolved: ResolvedAudioExport,
  wavMetadata: 'info' | 'id3',
  estimatedBytes: number,
): OutputFormat {
  switch (resolved.format) {
    case 'mp3':
      // The Xing header is what gives the file a duration and a seek index up front. Without
      // it a player has to scan the whole thing before it can show a length or scrub.
      return new Mp3OutputFormat({ xingHeader: true });
    case 'm4a':
      // 'reserve' writes the index at the front without buffering the file, exactly as the
      // video export does; it is what makes the file streamable and keeps the heap flat.
      return new Mp4OutputFormat({ fastStart: 'reserve' });
    case 'ogg':
      return new OggOutputFormat();
    case 'flac':
      return new FlacOutputFormat();
    case 'wav':
      return new WavOutputFormat({
        metadataFormat: wavMetadata,
        large: estimatedBytes > RF64_THRESHOLD,
      });
  }
}

/**
 * Makes sure the chosen codec can actually be encoded here, registering the LAME extension
 * for MP3, which no browser's WebCodecs implementation provides.
 */
async function ensureEncoder(resolved: ResolvedAudioExport): Promise<void> {
  if (await canEncodeAudio(resolved.codec)) return;

  if (resolved.codec === 'mp3') {
    // ~312 KB with its WASM inlined, so it is imported only when MP3 is actually chosen.
    const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
    registerMp3Encoder();
    if (await canEncodeAudio('mp3')) return;
  }

  const label = AUDIO_FORMATS[resolved.format].label;
  throw new AudioCodecUnsupportedError(
    `This browser cannot encode ${label}. WAV needs no encoder at all and always works.`,
  );
}

export async function exportAudioTrack(
  state: AudioExportSlice,
  resolved: ResolvedAudioExport,
  tags: MetadataTags,
  wavMetadata: 'info' | 'id3',
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<AudioExportResult> {
  const audible = audibleClips(state.clips, state.tracks).filter(
    ({ clip }) => clip.kind === 'audio' || clip.kind === 'video',
  );
  if (audible.length === 0) {
    throw new Error('This project has no audio to export.');
  }

  await ensureEncoder(resolved);

  // The file is as long as the project, not as long as its audio: a silent tail after the last
  // audible clip is part of the edit, and trimming it here would make the audio and the video
  // export disagree about how long the project is.
  const duration = Math.max(0.1, ...state.clips.map((c) => c.timelineStart + clipDuration(c)));

  const inputs = new MediaInputCache();
  const scratch = await openScratchFile(`export_${Date.now()}${resolved.extension}`);

  try {
    const output = new Output({
      format: outputFormatFor(resolved, wavMetadata, estimateAudioBytes(resolved, duration)),
      target: new StreamTarget(scratch.writable, { chunked: true }),
    });
    output.setMetadataTags(tags);

    const source = new AudioBufferSource({
      codec: resolved.codec,
      // Absent for PCM and FLAC, which mediabunny rejects a bitrate for outright.
      ...(resolved.lossless ? {} : { bitrate: resolved.bitrate }),
    });

    if (resolved.format === 'm4a') {
      // 'reserve' needs to know how much room to leave. One extra packet per window can appear
      // at a window boundary, and the encoder's priming and final partial frame need slack.
      const windows = Math.ceil(duration / MIX_WINDOW_SECONDS);
      const packets =
        Math.ceil((duration * resolved.sampleRate) / AAC_SAMPLES_PER_PACKET) + windows * 2 + 32;
      output.addAudioTrack(source, { maximumPacketCount: packets });
    } else {
      output.addAudioTrack(source);
    }

    await output.start();

    const windows = mixdownWindows(
      audible,
      state.mediaLibrary,
      inputs,
      duration,
      signal,
      state.clips,
      resolved.sampleRate,
    );

    let seconds = 0;
    for await (const window of windows) {
      signal.throwIfAborted();
      // `add` resolves on encoder backpressure, so this loop cannot outrun the encoder and
      // pile finished windows up in memory.
      await source.add(resolved.channels === 1 ? downmixToMono(window) : window);
      seconds += window.duration;
      onProgress(Math.min(1, seconds / duration));
    }

    // finalize() awaits the target's stream close, so the OPFS file is complete here.
    await output.finalize();
    onProgress(1);

    return { file: await scratch.toFile(), durationSeconds: duration };
  } catch (e) {
    await scratch.abort();
    throw e;
  } finally {
    inputs.dispose();
  }
}
