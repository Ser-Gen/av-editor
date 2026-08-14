import type { VideoFrameThumb } from './videoThumbnails';
import {
  extractFilmstripFrames,
  extractPosterFrame,
  posterTime,
} from './videoThumbnails';

interface AssetThumbs {
  poster: string | null;
  frames: VideoFrameThumb[];
}

const cache = new Map<string, AssetThumbs>();
const posterPending = new Map<string, Promise<string>>();
const filmstripPending = new Map<string, Promise<VideoFrameThumb[]>>();

function revokeAssetThumbs(entry: AssetThumbs): void {
  const urls = new Set<string>();
  if (entry.poster) urls.add(entry.poster);
  for (const frame of entry.frames) urls.add(frame.url);
  urls.forEach((url) => URL.revokeObjectURL(url));
}

function ensureEntry(assetId: string): AssetThumbs {
  let entry = cache.get(assetId);
  if (!entry) {
    entry = { poster: null, frames: [] };
    cache.set(assetId, entry);
  }
  return entry;
}

export function loadVideoPoster(assetId: string, blobUrl: string): Promise<string> {
  const entry = ensureEntry(assetId);
  if (entry.poster) return Promise.resolve(entry.poster);

  const inflight = posterPending.get(assetId);
  if (inflight) return inflight;

  const promise = extractPosterFrame(blobUrl)
    .then((url) => {
      entry.poster = url;
      posterPending.delete(assetId);
      return url;
    })
    .catch((err) => {
      posterPending.delete(assetId);
      throw err;
    });

  posterPending.set(assetId, promise);
  return promise;
}

export function loadVideoFilmstrip(
  assetId: string,
  blobUrl: string,
  duration: number,
): Promise<VideoFrameThumb[]> {
  const entry = ensureEntry(assetId);
  if (entry.frames.length > 0) return Promise.resolve(entry.frames);

  const inflight = filmstripPending.get(assetId);
  if (inflight) return inflight;

  const promise = extractFilmstripFrames(blobUrl, duration)
    .then((frames) => {
      entry.frames = frames;
      if (!entry.poster && frames.length > 0) {
        const target = posterTime();
        const posterFrame = frames.reduce((best, frame) =>
          Math.abs(frame.time - target) < Math.abs(best.time - target) ? frame : best,
        );
        entry.poster = posterFrame.url;
      }
      filmstripPending.delete(assetId);
      return frames;
    })
    .catch((err) => {
      filmstripPending.delete(assetId);
      throw err;
    });

  filmstripPending.set(assetId, promise);
  return promise;
}

export function clearVideoThumbnailCache(assetId?: string): void {
  if (assetId) {
    const entry = cache.get(assetId);
    if (entry) revokeAssetThumbs(entry);
    cache.delete(assetId);
    posterPending.delete(assetId);
    filmstripPending.delete(assetId);
    return;
  }
  for (const entry of cache.values()) revokeAssetThumbs(entry);
  cache.clear();
  posterPending.clear();
  filmstripPending.clear();
}
