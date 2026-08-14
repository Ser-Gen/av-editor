import type { AssetType } from '../types/editor';

const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];

export function inferAssetKind(name: string, mimeType = ''): AssetType {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('image/')) return 'image';

  const ext = name.split('.').pop()?.toLowerCase();
  if (ext && VIDEO_EXT.includes(ext)) return 'video';
  if (ext && AUDIO_EXT.includes(ext)) return 'audio';
  if (ext && IMAGE_EXT.includes(ext)) return 'image';
  return 'image';
}
