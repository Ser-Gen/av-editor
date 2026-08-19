/**
 * Capability probe for the WebCodecs export path.
 *
 * Deliberately free of any `mediabunny` import: this runs on every export click, while
 * the muxer and its codec tables (~500 kB) are loaded lazily only once the fast path is
 * actually taken.
 */

/** Thrown when this browser or this media cannot run the WebCodecs path. */
export class WebCodecsUnsupportedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WebCodecsUnsupportedError';
  }
}

/** Baseline H.264 at a size every hardware encoder handles — a proxy for "AVC works". */
const PROBE_CONFIG: VideoEncoderConfig = {
  codec: 'avc1.42001f',
  width: 640,
  height: 480,
  framerate: 30,
};

export async function webCodecsExportSupported(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') return false;
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return false;
  try {
    const support = await VideoEncoder.isConfigSupported(PROBE_CONFIG);
    return support.supported === true;
  } catch {
    return false;
  }
}
