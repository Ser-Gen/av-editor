export type ResolutionPreset = '480p' | '720p' | '1080p' | '4K';
/** Tracks are an ordered layer stack: video tracks composite bottom-up, audio tracks mix. */
export type TrackKind = 'video' | 'audio';
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
  /** Lane height in px; drag-resizable from the track header. */
  height: number;
  locked: boolean;
  /** Video tracks: excluded from preview and export. */
  hidden: boolean;
  /** Audio tracks: silenced. */
  muted: boolean;
  /** Audio tracks: when any track is soloed, only soloed tracks are audible. */
  solo: boolean;
  /** Audio tracks. 1 = 100%, up to 1.5 = 150%. */
  volume: number;
  /**
   * Video tracks: an always-on grade applied to everything composited so far — this
   * track's own clips and every track below it.
   */
  effects?: EffectInstance[];
}

/** Every shader effect the registry knows how to render. */
export type EffectType =
  | 'eq'
  | 'cinematic'
  | 'blackWhite'
  | 'sharpen'
  | 'denoise'
  | 'pixelate'
  | 'edgeDetect'
  | 'blur'
  | 'flip'
  | 'fill'
  | 'colorBalance';

/** How two overlapping clips blend. Stored on the *incoming* clip. */
export type TransitionType = 'dissolve' | 'dipToBlack' | 'wipeL' | 'wipeR';

export type Interp = 'linear' | 'hold' | 'smooth';

/** One control point. `t` is **clip-relative** seconds, so moving a clip carries it along. */
export interface Keyframe {
  t: number;
  value: number;
  interp: Interp;
}

/**
 * One effect on one clip. `params` is keyed by the descriptor's param names; a param
 * that appears in `keyframes` is animated and its scalar in `params` is ignored.
 */
export interface EffectInstance {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number>;
  keyframes?: Record<string, Keyframe[]>;
}

export interface BaseClip {
  id: string;
  trackId: string;
  timelineStart: number;
  sourceTrimIn: number;
  sourceTrimOut: number;
  /**
   * Ordered effect chain, applied in list order. Absent means none — the renderer
   * skips the whole layer machinery for clips without effects.
   */
  effects?: EffectInstance[];
  /** Seconds of fade at the head of the clip. 0 or absent = none. */
  fadeIn?: number;
  /** Seconds of fade at the tail of the clip. */
  fadeOut?: number;
  /**
   * Animated placement, keyed by channel name (`frame.x`, `crop.w`, …). A channel
   * present here overrides the matching field of `transform` at render time.
   */
  transformKeyframes?: Record<string, Keyframe[]>;
  /**
   * Blend used where this clip overlaps the previous clip on its track. The overlap
   * itself *is* the transition — there is no separate entity to keep in sync — so the
   * duration is however far the two clips overlap. Absent means a dissolve.
   */
  transitionIn?: TransitionType;
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

/**
 * A video clip carries its own audio — importing a video creates exactly one clip.
 * `detachAudio` splits the audio onto an audio track when independent control is needed.
 */
export interface VideoClip extends BaseClip {
  kind: 'video';
  assetId: string;
  /** From probe; false when the source file has no audio stream. */
  hasAudio: boolean;
  /** False after detaching, or when muted from the Inspector. */
  audioEnabled: boolean;
  gain: number;
  hideVideo: boolean;
  /** Undefined = full-frame fit. Set = crop + placement (PiP). */
  transform?: OverlayTransform;
}

export interface AudioClip extends BaseClip {
  kind: 'audio';
  assetId: string;
  gain: number;
}

export interface ImageClip extends BaseClip {
  kind: 'image';
  assetId: string;
  /** Undefined = full-frame fit. */
  transform?: OverlayTransform;
}

export interface TextClip extends BaseClip {
  kind: 'text';
  text: string;
  template: TextTemplate;
  /** Text box on the composition canvas. */
  textFrame?: NormalizedRect;
}

/**
 * A grade with no content of its own: it applies its effect chain to everything
 * composited below it, for the duration of the clip. The ranged counterpart to a
 * track's always-on effects.
 */
export interface AdjustmentClip extends BaseClip {
  kind: 'adjustment';
}

export type Clip = VideoClip | AudioClip | ImageClip | TextClip | AdjustmentClip;
export type VisualClip = VideoClip | ImageClip | TextClip;

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

/** Undoable document state. Everything else in the store is session-only. */
export interface EditorDoc {
  settings: ProjectSettings;
  tracks: Track[];
  clips: Clip[];
  libraryOrder: string[];
}

export interface HistoryEntry {
  label: string;
  doc: EditorDoc;
}

export interface EditorState extends EditorDoc {
  /** All imported media available for reuse. */
  mediaLibrary: Record<string, MediaAsset>;
  past: HistoryEntry[];
  future: HistoryEntry[];
  selectedClipIds: string[];
  playhead: number;
  trimPreview: TrimPreview | null;
  isPlaying: boolean;
  /** Timeline viewport. */
  pxPerSec: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  followPlayhead: boolean;
  snapEnabled: boolean;
  /** Timeline position of the engaged snap target, for the indicator line. */
  snapIndicator: number | null;
  ffmpegStatus: 'idle' | 'loading' | 'ready' | 'error';
  ffmpegError: string | null;
  exportProgress: number | null;
  /** Which pipeline the running (or last) export used. */
  exportEngine: 'webcodecs' | 'ffmpeg' | null;
  /** Why the fast path was declined, or how the export ended. */
  exportNotice: string | null;
  /** Short-lived status after URL-based library import. */
  libraryNotice: string | null;
}
