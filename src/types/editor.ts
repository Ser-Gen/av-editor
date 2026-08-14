export type ResolutionPreset = '480p' | '720p' | '1080p' | '4K';
export type TrackKind = 'video' | 'audio' | 'overlay';
export type TextTemplate = 'lowerThird' | 'centerTitle' | 'subtitle';
export type AssetType = 'video' | 'audio' | 'image';

export interface ProjectSettings {
  resolution: ResolutionPreset;
  fps: number;
}

export interface Track {
  id: string;
  kind: TrackKind;
  label: string;
  /** Audio lanes only. 1 = 100%, up to 1.5 = 150%. */
  volume?: number;
}

export interface BaseClip {
  id: string;
  trackId: string;
  timelineStart: number;
  sourceTrimIn: number;
  sourceTrimOut: number;
}

/** 0–1 normalized rectangle. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayTransform {
  /** Visible region of the source media. */
  crop: NormalizedRect;
  /** Placement on the composition canvas. */
  frame: NormalizedRect;
}

export interface VideoClip extends BaseClip {
  kind: 'video';
  assetId: string;
  muteAudio: boolean;
  hideVideo: boolean;
  /** PiP-style overlay instead of full-frame base layer. */
  overlayMode?: boolean;
  overlayTransform?: OverlayTransform;
}

export interface AudioClip extends BaseClip {
  kind: 'audio';
  assetId: string;
}

export interface ImageClip extends BaseClip {
  kind: 'image';
  assetId: string;
  overlayTransform?: OverlayTransform;
}

export interface TextClip extends BaseClip {
  kind: 'text';
  text: string;
  template: TextTemplate;
  /** Text box on the composition canvas. */
  textFrame?: NormalizedRect;
}

export type Clip = VideoClip | AudioClip | ImageClip | TextClip;

export interface MediaAsset {
  id: string;
  file: File;
  blobUrl: string;
  type: AssetType;
  name: string;
  duration: number;
  width?: number;
  height?: number;
  /** False when a video file has no audio track (export skips its audio branch). */
  hasAudio?: boolean;
}

/** While dragging a trim handle: preview this source timestamp without moving playhead. */
export interface TrimPreview {
  clipId: string;
  sourceTime: number;
}

export interface EditorState {
  settings: ProjectSettings;
  tracks: Track[];
  clips: Clip[];
  /** All imported media available for reuse. */
  mediaLibrary: Record<string, MediaAsset>;
  /** Display order in the library panel. */
  libraryOrder: string[];
  selectedClipId: string | null;
  playhead: number;
  trimPreview: TrimPreview | null;
  isPlaying: boolean;
  timelineZoom: number;
  ffmpegStatus: 'idle' | 'loading' | 'ready' | 'error';
  ffmpegError: string | null;
  exportProgress: number | null;
  /** Short-lived status after URL-based library import. */
  libraryNotice: string | null;
}
