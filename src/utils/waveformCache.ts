import { decodeWaveformPeaks } from './waveform';

const cache = new Map<string, number[]>();
const pending = new Map<string, Promise<number[]>>();

export function getCachedWaveform(assetId: string): number[] | undefined {
  return cache.get(assetId);
}

export function loadWaveformPeaks(assetId: string, file: File): Promise<number[]> {
  const cached = cache.get(assetId);
  if (cached) return Promise.resolve(cached);

  const inflight = pending.get(assetId);
  if (inflight) return inflight;

  const promise = decodeWaveformPeaks(file)
    .then((peaks) => {
      cache.set(assetId, peaks);
      pending.delete(assetId);
      return peaks;
    })
    .catch((err) => {
      pending.delete(assetId);
      throw err;
    });

  pending.set(assetId, promise);
  return promise;
}

export function clearWaveformCache(assetId?: string): void {
  if (assetId) {
    cache.delete(assetId);
    pending.delete(assetId);
    return;
  }
  cache.clear();
  pending.clear();
}
