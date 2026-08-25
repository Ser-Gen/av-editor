/**
 * Reading a library file for everything it will say about itself — an ffprobe with no FFmpeg.
 *
 * Two halves, split by cost rather than by subject. `inspectAsset` reads the container's header
 * and index, which the demuxer has parsed anyway: format, tracks, codecs, sizes, tags. It is
 * effectively free. `measureTracks` walks every packet header in the file to find out what the
 * header would not say — the true frame rate, the real average bitrate, the exact duration.
 * On an hour-long fragmented recording that is a genuine wait, which is why the two are
 * separate functions and the second one is behind a button.
 *
 * Neither decodes anything: the packet walk uses `metadataOnly`, so sample bytes are never read.
 *
 * Nothing here throws for a file it cannot understand. A container mediabunny does not parse is
 * a fact about the file worth showing, not an error worth propagating.
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { Input as InputType, MetadataTags } from 'mediabunny';
import type { MediaAsset } from '../types/editor';
import type { AudioTrackInfo, TrackInfo, VideoTrackInfo } from './mediaInfoFormat';

export interface MediaInfo {
  /** The container's own name, e.g. `MP4`, `Matroska`, `MP3`. */
  container: string;
  mimeType: string;
  sizeBytes: number;
  /** What the container claims, in seconds. Null when it does not say — which happens. */
  metadataDuration: number | null;
  tracks: TrackInfo[];
  /** The file's own descriptive tags, read back. */
  tags: MetadataTags;
  /** Set when mediabunny could not parse the file; every other field is then meaningless. */
  unreadable: string | null;
}

export interface TrackMeasurement {
  id: number;
  packetCount: number;
  /** Packets per second — for a video track, this is the true frame rate. */
  packetRate: number;
  averageBitrate: number;
}

export interface Measurement {
  tracks: TrackMeasurement[];
  /** Walked from the packets rather than believed from the header. */
  exactDuration: number;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function openInput(file: File): Promise<InputType> {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
}

/**
 * Every getter is wrapped, because a malformed file answers some questions and not others.
 * A colour space that throws should cost that one row, not the whole window.
 */
async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

async function readVideoTrack(
  track: Awaited<ReturnType<InputType['getVideoTracks']>>[number],
): Promise<VideoTrackInfo> {
  const [
    codec,
    codecString,
    language,
    canDecode,
    bitrate,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotation,
    pixelAspect,
    colorSpace,
    hdr,
    mayHaveAlpha,
    keyFramesOnly,
  ] = await Promise.all([
    safely(() => track.getCodec(), null),
    safely(() => track.getCodecParameterString(), null),
    safely(() => track.getLanguageCode(), null),
    safely(() => track.canDecode(), false),
    safely(() => track.getBitrate(), null),
    safely(() => track.getCodedWidth(), 0),
    safely(() => track.getCodedHeight(), 0),
    safely(() => track.getDisplayWidth(), 0),
    safely(() => track.getDisplayHeight(), 0),
    safely(() => track.getRotation(), 0 as const),
    safely(() => track.getPixelAspectRatio(), { num: 1, den: 1 }),
    safely(() => track.getColorSpace(), {}),
    safely(() => track.hasHighDynamicRange(), false),
    safely(() => track.canBeTransparent(), false),
    safely(() => track.hasOnlyKeyPackets(), false),
  ]);

  return {
    kind: 'video',
    id: track.id,
    codec,
    codecString,
    // Mediabunny reports 'und' for a track that never said; that is not worth a row.
    language: language && language !== 'und' ? language : null,
    canDecode,
    bitrate,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotation,
    pixelAspect,
    colorSpace: {
      primaries: colorSpace.primaries ?? null,
      transfer: colorSpace.transfer ?? null,
      matrix: colorSpace.matrix ?? null,
      fullRange: colorSpace.fullRange ?? null,
    },
    hdr,
    mayHaveAlpha,
    keyFramesOnly,
  };
}

async function readAudioTrack(
  track: Awaited<ReturnType<InputType['getAudioTracks']>>[number],
): Promise<AudioTrackInfo> {
  const [codec, codecString, language, canDecode, bitrate, channels, sampleRate] = await Promise.all([
    safely(() => track.getCodec(), null),
    safely(() => track.getCodecParameterString(), null),
    safely(() => track.getLanguageCode(), null),
    safely(() => track.canDecode(), false),
    safely(() => track.getBitrate(), null),
    safely(() => track.getNumberOfChannels(), 0),
    safely(() => track.getSampleRate(), 0),
  ]);

  return {
    kind: 'audio',
    id: track.id,
    codec,
    codecString,
    language: language && language !== 'und' ? language : null,
    canDecode,
    bitrate,
    channels,
    sampleRate,
  };
}

const EMPTY_INFO: Omit<MediaInfo, 'unreadable' | 'sizeBytes'> = {
  container: 'unknown',
  mimeType: '',
  metadataDuration: null,
  tracks: [],
  tags: {},
};

/**
 * Everything the header knows. Free enough to run on opening a window.
 *
 * Images are not media containers, so mediabunny cannot read them; the caller shows the
 * library's own facts instead. That is a caller's decision, so this reports it plainly rather
 * than pretending an image is a broken video.
 */
export async function inspectAsset(asset: MediaAsset): Promise<MediaInfo> {
  const file = asset.file;
  if (!file) {
    return { ...EMPTY_INFO, sizeBytes: 0, unreadable: 'This file is offline. Relink it to read it.' };
  }
  if (asset.type === 'image') {
    return {
      ...EMPTY_INFO,
      sizeBytes: file.size,
      mimeType: file.type,
      unreadable: 'Images are not media containers, so there are no tracks to read.',
    };
  }

  let input: InputType | null = null;
  try {
    input = await openInput(file);
    const [format, mimeType, videoTracks, audioTracks] = await Promise.all([
      input.getFormat(),
      safely(() => input!.getMimeType(), file.type),
      safely(() => input!.getVideoTracks(), []),
      safely(() => input!.getAudioTracks(), []),
    ]);

    const [videos, audios, metadataDuration, tags] = await Promise.all([
      Promise.all(videoTracks.map(readVideoTrack)),
      Promise.all(audioTracks.map(readAudioTrack)),
      safely(() => input!.getDurationFromMetadata(), null),
      safely(() => input!.getMetadataTags(), {} as MetadataTags),
    ]);

    return {
      container: format.name,
      mimeType,
      sizeBytes: file.size,
      metadataDuration,
      // Video first, then audio — the order a person expects, not the order the file stored them.
      tracks: [...videos, ...audios],
      tags,
      unreadable: null,
    };
  } catch (e) {
    return {
      ...EMPTY_INFO,
      sizeBytes: file.size,
      mimeType: file.type,
      unreadable: `This container could not be read: ${message(e)}`,
    };
  } finally {
    try {
      input?.dispose();
    } catch {
      // Best-effort, exactly as MediaInputCache does it.
    }
  }
}

/**
 * The expensive half: what the file actually contains, rather than what it claims.
 *
 * Worth the wait when they disagree — a recording rescued from a killed tab has a header
 * written before the take, and a variable-rate screen capture's nominal frame rate is a
 * ceiling rather than a measurement.
 */
export async function measureTracks(asset: MediaAsset): Promise<Measurement | null> {
  const file = asset.file;
  if (!file || asset.type === 'image') return null;

  let input: InputType | null = null;
  try {
    input = await openInput(file);
    const tracks = await input.getTracks();
    const stats = await Promise.all(
      tracks.map(async (track) => {
        const s = await track.computePacketStats();
        return {
          id: track.id,
          packetCount: s.packetCount,
          packetRate: s.averagePacketRate,
          averageBitrate: s.averageBitrate,
        };
      }),
    );
    return { tracks: stats, exactDuration: await input.computeDuration(tracks) };
  } catch {
    return null;
  } finally {
    try {
      input?.dispose();
    } catch {
      // Best-effort.
    }
  }
}
