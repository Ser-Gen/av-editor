export const POSTER_TIME = 0.05;

export function posterTime(): number {
  return POSTER_TIME;
}
const MAX_FILMSTRIP_FRAMES = 48;
const THUMB_CAPTURE_WIDTH = 160;
const SEEK_TIMEOUT_MS = 2500;

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.videoWidth > 0) {
      resolve();
      return;
    }
    const onMeta = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error('Failed to load video metadata'));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
  });
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  const clamped = Math.max(0, time);
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - clamped) < 0.03 && video.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('loadeddata', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.addEventListener('loadeddata', done);
    video.currentTime = clamped;
    window.setTimeout(done, 120);
  });
}

function filmstripTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [POSTER_TIME];
  const count = Math.min(MAX_FILMSTRIP_FRAMES, Math.max(4, Math.ceil(duration)));
  const step = duration / count;
  return Array.from({ length: count }, (_, i) =>
    Math.min(Math.max(0, duration - 0.05), i * step + step / 2),
  );
}

async function captureFrame(video: HTMLVideoElement): Promise<string> {
  const canvas = document.createElement('canvas');
  const aspect =
    video.videoWidth > 0 && video.videoHeight > 0
      ? video.videoWidth / video.videoHeight
      : 16 / 9;
  canvas.height = THUMB_CAPTURE_WIDTH;
  canvas.width = Math.max(1, Math.round(THUMB_CAPTURE_WIDTH * aspect));

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.72),
  );
  if (!blob) throw new Error('Failed to encode thumbnail');
  return URL.createObjectURL(blob);
}

export interface VideoFrameThumb {
  time: number;
  url: string;
}

async function extractFrames(blobUrl: string, times: number[]): Promise<VideoFrameThumb[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = blobUrl;

  const timeout = window.setTimeout(() => {
    video.src = '';
  }, SEEK_TIMEOUT_MS * Math.max(1, times.length));

  try {
    await waitForMetadata(video);
    const frames: VideoFrameThumb[] = [];
    for (const time of times) {
      await seekVideo(video, time);
      const url = await captureFrame(video);
      frames.push({ time, url });
    }
    return frames;
  } finally {
    window.clearTimeout(timeout);
    video.removeAttribute('src');
    video.load();
  }
}

export async function extractPosterFrame(blobUrl: string): Promise<string> {
  const [frame] = await extractFrames(blobUrl, [POSTER_TIME]);
  return frame.url;
}

export async function extractFilmstripFrames(
  blobUrl: string,
  duration: number,
): Promise<VideoFrameThumb[]> {
  return extractFrames(blobUrl, filmstripTimes(duration));
}

export function selectFilmstripTiles(
  frames: VideoFrameThumb[],
  trimIn: number,
  trimOut: number,
  tileCount: number,
): string[] {
  if (frames.length === 0 || tileCount <= 0) return [];
  const start = Math.min(trimIn, trimOut);
  const end = Math.max(trimIn, trimOut);
  const span = Math.max(0.05, end - start);

  return Array.from({ length: tileCount }, (_, i) => {
    const t = start + (span * (i + 0.5)) / tileCount;
    let best = frames[0];
    let bestDist = Math.abs(best.time - t);
    for (const frame of frames) {
      const dist = Math.abs(frame.time - t);
      if (dist < bestDist) {
        best = frame;
        bestDist = dist;
      }
    }
    return best.url;
  });
}
