/**
 * What the library needs to know about a file the moment it arrives: how long, how big, and
 * whether there is any sound in it.
 *
 * Two probes, in order. The demuxer reads the container directly and is the one that can
 * actually answer the third question — and it answers the first two better, because
 * `displayWidth` accounts for a rotation stored in the container, which a `<video>` element
 * applies to the picture but never reports through `videoWidth`. A phone video used to land
 * in the library sideways for exactly this reason.
 *
 * The media element stays as the fallback, for a container mediabunny does not parse and for a
 * file whose header carries no duration at all.
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { AssetType } from '../types/editor';

export interface ProbeResult {
  duration: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

/** The demuxer's answer. `duration` is null when the container does not state one. */
interface DemuxedProbe {
  duration: number | null;
  width?: number;
  height?: number;
  hasAudio: boolean;
}

async function probeWithDemuxer(file: File, type: AssetType): Promise<DemuxedProbe | null> {
  let input: Input | null = null;
  try {
    input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const [videoTracks, audioTracks] = await Promise.all([
      input.getVideoTracks(),
      input.getAudioTracks(),
    ]);
    if (videoTracks.length === 0 && audioTracks.length === 0) return null;

    const duration = await input.getDurationFromMetadata();
    const video = type === 'video' ? videoTracks[0] : undefined;
    // Display size, not coded size: the rotation and the pixel aspect ratio are part of how
    // big the picture is, and the timeline lays out from this number.
    const [width, height] = video
      ? await Promise.all([video.getDisplayWidth(), video.getDisplayHeight()])
      : [undefined, undefined];

    return {
      duration: duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null,
      width,
      height,
      // The whole point of this path. The element probe read `HTMLVideoElement.audioTracks`,
      // which Chrome does not implement, so every video was recorded as having sound —
      // including silent screen captures.
      hasAudio: audioTracks.length > 0,
    };
  } catch {
    // Not a container mediabunny knows. The element may still play it.
    return null;
  } finally {
    try {
      input?.dispose();
    } catch {
      // Best-effort.
    }
  }
}

function probeWithElement(file: File, type: AssetType): Promise<ProbeResult> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    if (type === 'image') {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ duration: 5, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };
      img.src = url;
      return;
    }

    const el = document.createElement(type === 'video' ? 'video' : 'audio');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const duration = Number.isFinite(el.duration) ? el.duration : 10;
      const video = type === 'video' ? (el as HTMLVideoElement) : null;
      URL.revokeObjectURL(url);
      resolve({
        duration,
        width: video?.videoWidth,
        height: video?.videoHeight,
        // Unknowable from here — Chrome implements neither `audioTracks` nor `mozHasAudio`.
        // Assuming sound is the safer error: a track that turns out silent exports as silence,
        // where a wrongly-silenced one loses audio the user recorded.
        hasAudio: true,
      });
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load media metadata'));
    };
    el.src = url;
  });
}

export async function probeMediaFile(file: File, type: AssetType): Promise<ProbeResult> {
  // Images are not media containers; mediabunny has nothing to say about a PNG.
  if (type === 'image') return probeWithElement(file, type);

  const demuxed = await probeWithDemuxer(file, type);
  if (!demuxed) return probeWithElement(file, type);

  if (demuxed.duration !== null) {
    return {
      duration: demuxed.duration,
      width: demuxed.width,
      height: demuxed.height,
      hasAudio: demuxed.hasAudio,
    };
  }

  // A container with no stated duration — an unrepaired recording is exactly this. Borrow
  // only the length from the element, and keep the facts the demuxer was sure about.
  const fallback = await probeWithElement(file, type).catch(() => null);
  return {
    duration: fallback?.duration ?? 10,
    width: demuxed.width ?? fallback?.width,
    height: demuxed.height ?? fallback?.height,
    hasAudio: demuxed.hasAudio,
  };
}
