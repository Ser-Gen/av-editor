export type ResolutionPreset = '480p' | '720p' | '1080p' | '4K';
/** Tracks are an ordered layer stack: video tracks composite bottom-up, audio tracks mix. */
export type TrackKind = 'video' | 'audio';
export type TextTemplate = 'lowerThird' | 'centerTitle' | 'subtitle';
export type AssetType = 'video' | 'audio' | 'image';

/**
 * The composition itself: how big a frame is and how many of them there are per second.
 *
 * Stored as pixels rather than as a preset name so a project can be any shape — vertical,
 * square, or something a phone produced. Presets are a convenience in the settings dialog
 * that write these numbers; they are not the storage. `ResolutionPreset` survives only so
 * a project written by an older build can still be read.
 */
export interface ProjectSettings {
  /** Even numbers only: H.264 refuses an odd dimension. */
  width: number;
  height: number;
  fps: number;
}

/** How much the exporter spends on quality. Presets set every field below at once. */
export type ExportQuality = 'master' | 'web' | 'small';

/**
 * How the project is encoded on the way out.
 *
 * Separate from `ProjectSettings` because they answer different questions: the project is what
 * the composition *is*, and these are what one particular file made from it should be. That is
 * why the size override lives here — a 1080p web copy of a 4K project is an export, not an edit.
 */
export interface ExportSettings {
  quality: ExportQuality;
  /** Bits per second. Null follows the preset, scaled to the frame size and rate. */
  videoBitrate: number | null;
  /** Seconds between keyframes. Shorter seeks better and costs size. */
  keyframeInterval: number;
  audioBitrate: number;
  /** 1 = mono, 2 = stereo. */
  audioChannels: number;
  /** Output size. Null follows the project. Must be the project's aspect — scale, not reshape. */
  width: number | null;
  height: number | null;
  /** Output frame rate. Null follows the project. */
  fps: number | null;
}

/** The shape of `ProjectSettings` before sizes became pixels. Read on load, never written. */
export interface LegacyProjectSettings {
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

/** Every shader effect the registry ships with. */
export type BuiltinEffectType =
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

/**
 * An effect is either one of the built-ins or a shader the user pasted in. A custom
 * effect carries its own source and its own parameter list, so it is a *type* only in
 * the sense that the renderer dispatches on it — every instance can be a different
 * shader.
 */
export type EffectType = BuiltinEffectType | 'custom';

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
  /**
   * GLSL source, for `type: 'custom'` only. The annotated text exactly as the author
   * left it: it is both what compiles and what the shader editor reopens, so a shader
   * survives a round trip through the document unchanged.
   */
  shader?: string;
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
  /** Present when a library preset made this asset out of another one. */
  derivedFrom?: DerivedFrom;
}

/**
 * The recipe that produced a processed asset.
 *
 * Kept on the asset rather than in a log because the question it answers — "which of these
 * four near-identical files is the stabilized one?" — is asked weeks later, in the library,
 * about a file whose name has since been changed by whoever exported it.
 */
export interface DerivedFrom {
  /** The asset it was made from. May since have been removed from the library. */
  assetId: string;
  presetId: string;
  presetLabel: string;
  /** The excerpt of the source it was made from, in source seconds. Absent = all of it. */
  range?: { start: number; duration: number };
}

/**
 * What one preset run was asked to do.
 *
 * The same action serves both entry points: the library processes a whole file, the timeline
 * processes the cut a split produced. The difference is entirely in `range` — a clip already
 * knows its excerpt as two numbers, so nothing has to be measured or re-derived.
 */
export interface ProcessRequest {
  presetId: string;
  /** The library asset the media comes from. */
  assetId: string;
  /** The excerpt to process. Absent = the whole file. */
  range?: { start: number; duration: number };
  /** When set, the finished excerpt takes this clip's place on the timeline. */
  replaceClipId?: string;
}

/** A library preset running over one asset. One at a time, session-only. */
export interface ProcessJob {
  assetId: string;
  presetId: string;
  /** "Stabilize · holiday.mov", for the progress row. */
  label: string;
  phase: 'loading' | 'writing' | 'running' | 'reading';
  progress: number;
}

/** While dragging a trim handle: preview this source timestamp without moving playhead. */
export interface TrimPreview {
  clipId: string;
  sourceTime: number;
}

/** Undoable document state. Everything else in the store is session-only. */
export interface EditorDoc {
  settings: ProjectSettings;
  exportSettings: ExportSettings;
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
  /** The library preset currently running, if any. */
  processJob: ProcessJob | null;
}
