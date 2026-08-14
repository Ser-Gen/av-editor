import type { ResolutionPreset } from '../types/editor';

export function resolutionToSize(preset: ResolutionPreset): { width: number; height: number } {
  switch (preset) {
    case '480p':
      return { width: 854, height: 480 };
    case '720p':
      return { width: 1280, height: 720 };
    case '1080p':
      return { width: 1920, height: 1080 };
    case '4K':
      return { width: 3840, height: 2160 };
  }
}
