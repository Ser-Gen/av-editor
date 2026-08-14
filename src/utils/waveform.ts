const PEAKS_PER_SECOND = 64;
const MAX_PEAKS = 8000;
const MAX_DECODE_BYTES = 80 * 1024 * 1024;

function mixPeaks(audioBuffer: AudioBuffer, bucketCount: number): number[] {
  const { length, numberOfChannels } = audioBuffer;
  const samplesPerBucket = Math.max(1, Math.floor(length / bucketCount));
  const peaks = new Array<number>(bucketCount).fill(0);

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = bucket * samplesPerBucket;
    const end = Math.min(length, start + samplesPerBucket);
    let max = 0;
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = start; i < end; i++) {
        const abs = Math.abs(data[i]);
        if (abs > max) max = abs;
      }
    }
    peaks[bucket] = max;
  }

  const peakMax = Math.max(...peaks, 0.001);
  return peaks.map((p) => p / peakMax);
}

export async function decodeWaveformPeaks(file: File): Promise<number[]> {
  if (file.size > MAX_DECODE_BYTES) {
    throw new Error(`File too large for waveform (${file.name})`);
  }

  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const bucketCount = Math.min(
      MAX_PEAKS,
      Math.max(16, Math.ceil(audioBuffer.duration * PEAKS_PER_SECOND)),
    );
    return mixPeaks(audioBuffer, bucketCount);
  } finally {
    await ctx.close();
  }
}

export function slicePeaksForTrim(
  peaks: number[],
  duration: number,
  trimIn: number,
  trimOut: number,
): number[] {
  if (peaks.length === 0 || duration <= 0) return peaks;
  const startIdx = Math.floor((trimIn / duration) * peaks.length);
  const endIdx = Math.max(startIdx + 1, Math.ceil((trimOut / duration) * peaks.length));
  return peaks.slice(startIdx, endIdx);
}
