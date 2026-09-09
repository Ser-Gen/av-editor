import type { AudioMetadata } from '../utils/audioMetadata';
import type { TextStyle } from '../utils/textStyle';

export type ResolutionPreset = '480p' | '720p' | '1080p' | '4K';
/** Tracks are an ordered layer stack: video tracks composite bottom-up, audio tracks mix. */
export type TrackKind = 'video' | 'audio';
export type TextTemplate =
  | 'lowerThird'
  | 'centerTitle'
  | 'subtitle'
  | 'caption'
  | 'kicker'
  | 'quote'
  | 'outline'
  | 'ticker';
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

/** What the Export button makes. Audio-only is a different file, not a smaller one. */
export type ExportOutput = 'video' | 'audio';

export type AudioFormat = 'mp3' | 'm4a' | 'wav' | 'flac' | 'ogg';

/**
 * How the project is encoded on the way out.
 *
 * Separate from `ProjectSettings` because they answer different questions: the project is what
 * the composition *is*, and these are what one particular file made from it should be. That is
 * why the size override lives here — a 1080p web copy of a 4K project is an export, not an edit.
 */
export interface ExportSettings {
  /** Video (MP4) or audio only. The fields below are shared where they mean the same thing. */
  output: ExportOutput;
  quality: ExportQuality;
  /** Bits per second. Null follows the preset, scaled to the frame size and rate. */
  videoBitrate: number | null;
  /** Seconds between keyframes. Shorter seeks better and costs size. */
  keyframeInterval: number;
  /** Bits per second. Shared by both outputs; ignored by lossless audio formats. */
  audioBitrate: number;
  /** 1 = mono, 2 = stereo. Shared by both outputs. */
  audioChannels: number;
  /** Audio-only exports. The container and codec the file is written as. */
  audioFormat: AudioFormat;
  /** Audio-only exports. The mix renders at this rate rather than resampling afterwards. */
  audioSampleRate: number;
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
/**
 * One audio effect on one clip.
 *
 * Deliberately a different type from `EffectInstance`: a visual effect is a shader with a
 * uniform block, an audio effect is a Web Audio node with an `AudioParam`. They share nothing
 * but the shape of the list.
 */
export type AudioEffectType = 'highpass' | 'lowpass' | 'eq' | 'pitch';

export interface AudioEffect {
  id: string;
  type: AudioEffectType;
  enabled: boolean;
  params: Record<string, number>;
}

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

export type RippleScope = 'track' | 'all';

/**
 * A piece of text kept in the library and used by any number of clips.
 *
 * Reference semantics, like an asset: editing the object changes every clip showing it, and
 * *Duplicate* is how you get one that goes its own way.
 */
export interface TextObject {
  id: string;
  name: string;
  text: string;
  template: TextTemplate;
  style?: Partial<TextStyle>;
  addedAt: number;
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
  /**
   * Clockwise rotation of the placed picture in **degrees**, about the frame's own centre.
   * Absent means none. Degrees rather than radians because this is what the field shows and
   * what the project file stores; every renderer converts at its own boundary.
   *
   * Not wrapped to a single turn: an animated channel going 0 → 720 is two spins, and
   * wrapping would silently make it none.
   */
  rotate?: number;
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
  /**
   * The volume envelope, in clip-local seconds. A point list, evaluated by the same keyframe
   * engine that animates effect parameters — so it interpolates the same three ways and splits
   * with the clip. Absent means a flat `gain`.
   */
  gainKeyframes?: Keyframe[];
  /** Filters, EQ and pitch, in order. See `utils/audioChain.ts`. */
  audioEffects?: AudioEffect[];
  /**
   * The last measured integrated loudness, cached so the Inspector need not re-decode to show
   * it. Invalidated whenever the trim changes, because it describes an excerpt.
   */
  loudness?: { lufs: number; peakDb: number; trimIn: number; trimOut: number };
  /**
   * Playback rate, 0.25–4. Absent means 1.
   *
   * Speed is the one property that changes what a clip's *duration* means: the source range
   * stays fixed and the time it occupies becomes `(sourceTrimOut - sourceTrimIn) / speed`.
   * `clipDuration` and `sourceTimeAt` are the two functions that state that relationship, and
   * everything else in the app reads it through them rather than restating it.
   *
   * Only video and audio have one. An image, a title or an annotation has no source clock to
   * run faster — its duration is already whatever you trim it to.
   */
  speed?: number;
  /**
   * Let the pitch rise and fall with the speed, like a tape. Absent means the pitch is held,
   * which is what makes speech at 1.5× still sound like speech.
   */
  pitchFollowsSpeed?: boolean;
  hideVideo: boolean;
  /** Undefined = full-frame fit. Set = crop + placement (PiP). */
  transform?: OverlayTransform;
}

export interface AudioClip extends BaseClip {
  kind: 'audio';
  assetId: string;
  gain: number;
  /**
   * The volume envelope, in clip-local seconds. A point list, evaluated by the same keyframe
   * engine that animates effect parameters — so it interpolates the same three ways and splits
   * with the clip. Absent means a flat `gain`.
   */
  gainKeyframes?: Keyframe[];
  /** Filters, EQ and pitch, in order. See `utils/audioChain.ts`. */
  audioEffects?: AudioEffect[];
  /**
   * The last measured integrated loudness, cached so the Inspector need not re-decode to show
   * it. Invalidated whenever the trim changes, because it describes an excerpt.
   */
  loudness?: { lufs: number; peakDb: number; trimIn: number; trimOut: number };
  /**
   * Playback rate, 0.25–4. Absent means 1.
   *
   * Speed is the one property that changes what a clip's *duration* means: the source range
   * stays fixed and the time it occupies becomes `(sourceTrimOut - sourceTrimIn) / speed`.
   * `clipDuration` and `sourceTimeAt` are the two functions that state that relationship, and
   * everything else in the app reads it through them rather than restating it.
   *
   * Only video and audio have one. An image, a title or an annotation has no source clock to
   * run faster — its duration is already whatever you trim it to.
   */
  speed?: number;
  /**
   * Let the pitch rise and fall with the speed, like a tape. Absent means the pitch is held,
   * which is what makes speech at 1.5× still sound like speech.
   */
  pitchFollowsSpeed?: boolean;
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
  /**
   * Overrides on top of the template's style. Absent means the template as it comes — which is
   * what every clip saved before styling existed has, and why it still looks the same.
   */
  style?: Partial<TextStyle>;
  /** The text object in the library this clip shows, when it came from one. */
  textObjectId?: string;
  /** Text box on the composition canvas. */
  textFrame?: NormalizedRect;
}

/** One drawn mark on an annotation clip. Coordinates are normalized to the composition. */
export type AnnotationShapeType = 'arrow' | 'box' | 'ellipse' | 'freehand' | 'callout';

/**
 * A pose of one mark at one moment, in clip-local seconds.
 *
 * The whole point list, not a channel per coordinate: a mark is a shape, and interpolating its
 * corners independently is the same thing as interpolating the shape. Keys with a different
 * number of points than their neighbour cannot be blended — a freehand path redrawn mid-clip —
 * so the earlier one is held until the later one's moment arrives.
 */
export interface ShapePointKey {
  t: number;
  points: { x: number; y: number }[];
}

export interface AnnotationShape {
  id: string;
  type: AnnotationShapeType;
  /**
   * Arrow and callout: [tail, head]. Box and ellipse: [corner, corner]. Freehand: the path.
   * Normalized against the composition, so an aspect change refits them the way masks refit.
   */
  points: { x: number; y: number }[];
  color: string;
  width: number;
  fill: string | null;
  /** Callouts only. */
  text?: string;
  /**
   * Where this mark is over time, in clip-local seconds. Absent means it stays at `points`,
   * which is what every mark did before this existed and what most of them still do.
   */
  pointKeys?: ShapePointKey[];
}

/**
 * Drawn marks over whatever is below, for the clip's own time range.
 *
 * A clip rather than a property of another clip: an arrow usually wants to appear for three
 * seconds of a thirty-second take, and making it a clip means the timeline already knows how
 * to say when — no second mechanism, and trimming it is trimming it.
 */
export interface AnnotationClip extends BaseClip {
  kind: 'annotation';
  shapes: AnnotationShape[];
  /** Undefined = full-frame, like every other overlay. */
  transform?: OverlayTransform;
}

/**
 * A grade with no content of its own: it applies its effect chain to everything
 * composited below it, for the duration of the clip. The ranged counterpart to a
 * track's always-on effects.
 */
export interface AdjustmentClip extends BaseClip {
  kind: 'adjustment';
}

export type Clip =
  | VideoClip
  | AudioClip
  | ImageClip
  | TextClip
  | AnnotationClip
  | AdjustmentClip;
export type VisualClip = VideoClip | ImageClip | TextClip | AnnotationClip;

/**
 * Where an asset's bytes come from, which decides whether they survive a reload.
 *
 * `imported` files are the user's own and are never copied — only recognised again.
 * `derived`, `recorded` and `pasted` files were made or received by this app and have nowhere
 * else to live, so they are kept in OPFS. A pasted image is the clearest case: it never had a
 * path, so there is nothing to relink it to and nobody to ask for it again.
 * See `docs/persistence-plan.md`.
 */
export type AssetOrigin = 'imported' | 'derived' | 'recorded' | 'pasted';

/**
 * Enough of a file to recognise it when the user offers it back.
 *
 * Not a path: the File System Access API never gives one, and a `File` from an `<input>`
 * has no durable identity at all. These three fields are what both APIs do provide.
 */
export interface AssetFingerprint {
  name: string;
  size: number;
  lastModified: number;
}

/**
 * A file in the library.
 *
 * `file` and `blobUrl` are **optional on purpose**: an asset restored from disk has
 * everything needed to lay the timeline out — duration, dimensions, whether it has sound —
 * and no bytes at all until it is relinked or read back out of OPFS. That state is called
 * *offline*, and every consumer has to answer for it rather than assume media is there.
 */
export interface MediaAsset {
  /**
   * When it joined the library, epoch ms. Optional: assets stored before this field existed
   * have none, and sort last under "Added" rather than pretending to a date.
   */
  addedAt?: number;
  id: string;
  /** Absent while offline. */
  file?: File;
  /** Absent while offline. Revoked when the asset leaves the library. */
  blobUrl?: string;
  type: AssetType;
  name: string;
  duration: number;
  width?: number;
  height?: number;
  /** False when a video file has no audio track (export skips its audio branch). */
  hasAudio?: boolean;
  /** Present when a library preset made this asset out of another one. */
  derivedFrom?: DerivedFrom;
  origin: AssetOrigin;
  /** `imported` only: how to match a file the user re-picks back to this asset. */
  fingerprint?: AssetFingerprint;
  /** `derived` and `recorded`: the bytes in OPFS. */
  opfsName?: string;
  /** `recorded` only: the sidecar in `recordings/` that describes the capture. */
  recordingId?: string;
}

/** A `MediaAsset` with the live handles stripped — what actually goes in `project.json`. */
export type StoredAsset = Omit<MediaAsset, 'file' | 'blobUrl'>;

/**
 * The saved project.
 *
 * `doc` is exactly `docSnapshot()`, so what is undoable and what is saved cannot drift.
 * The library rides alongside it rather than inside it, mirroring the fact that
 * `mediaLibrary` is deliberately outside the undo document.
 */
export interface ProjectFile {
  version: 1;
  savedAt: number;
  doc: EditorDoc;
  assets: StoredAsset[];
}

export const PROJECT_FILE_VERSION = 1;

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
  /**
   * Reusable text, shown in the library beside the media.
   *
   * Inside the document snapshot, unlike `mediaLibrary`, and the difference is the point:
   * importing a file is not undone by pressing undo, but the words in a title very much are.
   * So text objects are displayed in the library panel and stored where undo can reach them.
   */
  textLibrary: TextObject[];
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
  /**
   * The mark being edited inside the selected annotation clip.
   *
   * A cursor, not a document fact, so it is outside `docSnapshot()` for the same reason
   * `selectedClipIds` is: undo restores what the project contains, not where you were
   * looking. Cleared whenever the clip selection changes.
   */
  selectedShapeId: string | null;
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
  /**
   * Ripple editing: trims and deletes drag the rest of the timeline along instead of leaving
   * a hole. Session state, not project state — it is how you are working right now, not
   * something a reopened project should silently impose.
   */
  rippleEnabled: boolean;
  /** `all` shifts every track by one amount, which is what keeps detached audio with its picture. */
  rippleScope: RippleScope;
  /**
   * Force the FFmpeg pipeline instead of WebCodecs for the next export.
   *
   * Session state on purpose, and deliberately not part of `exportSettings`: forcing the slow
   * path is something you do to diagnose one export, never a property a saved project should
   * carry silently into next week.
   */
  exportForceFfmpeg: boolean;
  /** The clip currently being measured for loudness, so the button can say so. */
  loudnessJob: string | null;
  /**
   * Monitoring loudness for the preview, 0..1, and whether it is muted. Neither is part of
   * the project: turning the speakers down while you work must not turn the export down too,
   * so this never reaches `docSnapshot` and never reaches an encoder.
   */
  previewVolume: number;
  previewMuted: boolean;
  /** Timeline position of the engaged snap target, for the indicator line. */
  snapIndicator: number | null;
  ffmpegStatus: 'idle' | 'loading' | 'ready' | 'error';
  ffmpegError: string | null;
  exportProgress: number | null;
  /** Which pipeline the running (or last) export used. */
  exportEngine: 'webcodecs' | 'ffmpeg' | null;
  /** Why the fast path was declined, or how the export ended. */
  exportNotice: string | null;
  /**
   * Descriptive tags written into the exported file.
   *
   * Session state, deliberately outside `EditorDoc`: typing a title is not yet an edit to the
   * project, so it is not undoable and not saved. Moving it into the document later means
   * moving this line into `EditorDoc` and routing its setter through `commit` — the value is
   * already plain and serializable for exactly that reason.
   */
  audioMetadata: AudioMetadata;
  /** Short-lived status after URL-based library import. */
  libraryNotice: string | null;
  /** The library preset currently running, if any. */
  processJob: ProcessJob | null;
  /**
   * Another tab holds the project. Autosave is off and edits are the user's own risk — the
   * alternative, two tabs writing one file, loses work silently.
   */
  readOnly: boolean;
}
