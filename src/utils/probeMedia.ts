import type { AssetType } from '../types/editor';

export interface ProbeResult {
  duration: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

export function probeMediaFile(file: File, type: AssetType): Promise<ProbeResult> {
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
      const width = video?.videoWidth;
      const height = video?.videoHeight;
      let hasAudio = type === 'audio';
      if (video) {
        // Most video files include audio; only mark false when the browser reports no tracks.
        hasAudio = true;
        const v = video as HTMLVideoElement & {
          audioTracks?: { length: number };
          mozHasAudio?: boolean;
        };
        if (v.audioTracks && v.audioTracks.length === 0) {
          hasAudio = false;
        } else if (v.mozHasAudio === false) {
          hasAudio = false;
        }
      }
      URL.revokeObjectURL(url);
      resolve({ duration, width, height, hasAudio });
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load media metadata'));
    };
    el.src = url;
  });
}
