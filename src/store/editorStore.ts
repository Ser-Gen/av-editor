import { create } from 'zustand';
import type {
  AssetType,
  AudioClip,
  Clip,
  ImageClip,
  VideoClip,
  EditorDoc,
  EditorState,
  EffectInstance,
  BuiltinEffectType,
  Interp,
  Keyframe,
  ExportSettings,
  MediaAsset,
  NormalizedRect,
  OverlayTransform,
  ProjectSettings,
  TextTemplate,
  Track,
  TrackKind,
  TransitionType,
  ProcessRequest,
  DerivedFrom,
  AssetOrigin,
  RippleScope,
  AudioEffect,
  AudioEffectType,
  AnnotationShape,
  TextObject,
} from '../types/editor';
import {
  BAKE_ID,
  bakedName,
  derivedName,
  findPreset,
  presetChangesSound,
  replaceRefusal,
} from '../tools/presets';
import { bakeClip } from '../tools/bakeClip';
import { runPreset } from '../tools/runPreset';
import { formatExportError } from '../export/exportLog';
import {
  buildClipsForAsset,
  buildDropClips,
  buildRecordingClips,
  createTrack,
  findLaneForPlacement,
  insertTrack,
  isAssetInUse,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  ADJUSTMENT_CLIP_DURATION,
  TEXT_CLIP_DURATION,
  defaultTracks,
  nextTrackLabel,
  trackHasOverlap,
} from './clipFactory';
import type { DropItem, RecordingPlacement } from './clipFactory';
import { docEquals, docSnapshot, pruneSelection, pushEntry } from './history';
import { SOURCE_LANE } from '../capture/recordingStore';
import type { RecordedSource } from '../capture/recordingStore';
import { fastestRate, frameRateDecision } from '../capture/frameRate';
import { pictureInPictureTransform } from '../capture/pip';
import {
  DEFAULT_REGION,
  EFFECTS,
  REGION_CHANNELS,
  REGION_MODE,
  customDescriptor,
  defaultParams,
  defaultParamsFor,
  descriptorFor,
} from '../render/effects/registry';
import { clearShaderFailure } from '../render/effects/shaderStats';
import {
  TRANSFORM_CHANNELS,
  acceptsTransform,
  clampFade,
  clipSpeedOf,
} from '../utils/clipRender';
import {
  canRetime,
  clampSpeed,
  formatSpeed,
  retimeToSpeed,
  rippleDelta,
  slowestSpeedThatFits,
  speedForDuration,
} from '../utils/retime';
import {
  channelTimes,
  evaluateChannel,
  moveKey,
  removeKeyAt,
  setKeyInterp,
  splitChannelMap,
  upsertKey,
} from '../utils/keyframes';
import { audioTracks, videoTracks } from '../utils/compositeOrder';
import { removeShapeKeyAt, shapePointsAt, sortedKeys, upsertShapeKey } from '../utils/annotationAnim';
import { defaultAudioParams } from '../utils/audioChain';
import type { TextStyle } from '../utils/textStyle';
import { clampNormalizeGain, gainForTarget } from '../utils/loudness';
import { measureClipLoudness } from '../utils/measureLoudness';
import {
  applyShifts,
  closeGapsAcrossTracks,
  closeGapsOnTracks,
  rippleShift,
} from '../utils/ripple';
import { inferAssetKind } from '../utils/assetKind';
import { fingerprintOf, planRelink, relinkSummary } from '../utils/offlineMedia';
import { putMedia, dropMedia, collectGarbage } from '../project/mediaStore';
import { attachFile, reachableMedia, rehydrate } from '../project/rehydrate';
import { putHandle } from '../project/handleStore';
import { notifyProducedFile } from '../project/saveSignal';
import type { LoadedProject } from '../project/projectFile';
import { uid } from '../utils/id';
import { probeMediaFile } from '../utils/probeMedia';
import { clampDimension, clampFps, DEFAULT_SETTINGS, sameAspect } from '../utils/resolution';
import { DEFAULT_EXPORT_SETTINGS } from '../utils/exportSettings';
import { EMPTY_AUDIO_METADATA } from '../utils/audioMetadata';
import type { AudioMetadata } from '../utils/audioMetadata';
import { reframeClips, reframeTracks } from '../utils/reframe';
import { requantizeClips } from '../utils/requantize';
import { fetchUrlAsFile } from '../utils/urlMedia';
import { clearVideoThumbnailCache } from '../utils/videoThumbnailCache';
import { clearWaveformCache } from '../utils/waveformCache';
import { DEFAULT_FULL_FRAME } from '../utils/overlayTransform';
import { clampClipGain, clampTrackVolume } from '../utils/trackVolume';
import { detachedAudio, detachedAudioOutcome } from '../utils/detachedAudio';
import { overlapIsTransition } from '../utils/transitions';
import { clampVolume, mutedAfterVolumeChange } from '../utils/transport';
import { PREVIEW_VOLUME_KEY } from '../project/projectStore';
import {
  clipDuration,
  clipEnd,
  MIN_CLIP_DURATION,
  quantizeToFrame,
  rangesOverlap,
} from '../utils/time';

export const MIN_PX_PER_SEC = 2;
export const MAX_PX_PER_SEC = 1000;
/** Scrollable slack after the last clip, in seconds. */
export const TIMELINE_TAIL_SECONDS = 4;
/** An empty project still needs something to look at. Drawing only, never content. */
export const MIN_TIMELINE_SPAN_SECONDS = 10;

export interface ClipMove {
  id: string;
  timelineStart: number;
  trackId: string;
}

/**
 * What an effect action operates on. A bare string means a clip, so every existing
 * caller keeps working; tracks are addressed explicitly.
 */
export type EffectTarget = { kind: 'clip' | 'track'; id: string };
export type EffectTargetRef = string | EffectTarget;

function toTarget(ref: EffectTargetRef): EffectTarget {
  return typeof ref === 'string' ? { kind: 'clip', id: ref } : ref;
}

/** Addresses one animatable channel: an effect parameter, or a placement field. */
export interface ChannelRef {
  effectId: string | null;
  param: string;
}

function channelKeys(clip: Clip, ref: ChannelRef): Keyframe[] | undefined {
  if (ref.effectId === null) return clip.transformKeyframes?.[ref.param];
  return clip.effects?.find((e) => e.id === ref.effectId)?.keyframes?.[ref.param];
}

/** The channel's static value — what a first keyframe should capture. */
function currentChannelValue(clip: Clip, ref: ChannelRef): number | null {
  if (ref.effectId === null) {
    if (!acceptsTransform(clip)) return null;
    const transform = clip.transform;
    if (!transform) return null;
    const [group, axis] = ref.param.split('.') as ['crop' | 'frame', 'x' | 'y' | 'w' | 'h'];
    return transform[group]?.[axis] ?? null;
  }
  const effect = clip.effects?.find((e) => e.id === ref.effectId);
  return effect ? (effect.params[ref.param] ?? null) : null;
}

/** Writes a scalar back into the channel's static home, used when disarming. */
function freezeChannel(clip: Clip, ref: ChannelRef, value: number): Clip {
  if (ref.effectId === null) {
    if (!acceptsTransform(clip)) return clip;
    if (!clip.transform) return clip;
    const [group, axis] = ref.param.split('.') as ['crop' | 'frame', 'x' | 'y' | 'w' | 'h'];
    return {
      ...clip,
      transform: { ...clip.transform, [group]: { ...clip.transform[group], [axis]: value } },
    };
  }
  return {
    ...clip,
    effects: (clip.effects ?? []).map((e) =>
      e.id === ref.effectId ? { ...e, params: { ...e.params, [ref.param]: value } } : e,
    ),
  };
}

/** Rewrites one channel's key list, leaving everything else on the clip alone. */
function withChannel(
  clip: Clip,
  ref: ChannelRef,
  update: (keys: Keyframe[] | undefined) => Keyframe[] | undefined,
): Clip {
  if (ref.effectId === null) {
    const next = update(clip.transformKeyframes?.[ref.param]);
    const channels = { ...(clip.transformKeyframes ?? {}) };
    if (next === undefined) delete channels[ref.param];
    else channels[ref.param] = next;
    return { ...clip, transformKeyframes: Object.keys(channels).length > 0 ? channels : undefined };
  }
  return {
    ...clip,
    effects: (clip.effects ?? []).map((effect) => {
      if (effect.id !== ref.effectId) return effect;
      const next = update(effect.keyframes?.[ref.param]);
      const channels = { ...(effect.keyframes ?? {}) };
      if (next === undefined) delete channels[ref.param];
      else channels[ref.param] = next;
      return { ...effect, keyframes: Object.keys(channels).length > 0 ? channels : undefined };
    }),
  };
}

/** Rewrites the effect chain of a clip or a track, whichever the target names. */
function applyEffects(
  state: EditorState,
  ref: EffectTargetRef,
  update: (effects: EffectInstance[]) => EffectInstance[],
): Partial<EditorState> {
  const target = toTarget(ref);
  if (target.kind === 'track') {
    return {
      tracks: state.tracks.map((t) =>
        t.id === target.id ? { ...t, effects: update(t.effects ?? []) } : t,
      ),
    };
  }
  return { clips: mapEffects(state.clips, target.id, update) };
}

/** The region settings of a parameter set — kept when resetting an effect's own params. */
function regionOnly(params: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('region.')));
}

/** Where the content actually ends — the number export renders and the transport reports. */
function computeDuration(clips: Clip[]): number {
  if (clips.length === 0) return 0;
  return Math.max(0, ...clips.map((c) => clipEnd(c)));
}

/**
 * How much timeline to *draw*, which is not the same question. The tail is working room —
 * somewhere to drop a clip past the current end — and an empty project still needs a ruler
 * to look at. Neither is content.
 *
 * These used to be one number, floored at 5s and with the tail baked in, so a 2-second take
 * drew a 9-second project and then exported 2 seconds. Keeping them apart is what lets the
 * lanes show the extra room as *room* rather than as length.
 */
function computeSpan(clips: Clip[]): number {
  return Math.max(MIN_TIMELINE_SPAN_SECONDS, computeDuration(clips) + TIMELINE_TAIL_SECONDS);
}

/**
 * Where the playhead has to move to, or null when it is already in range.
 *
 * The playhead may not sit past the end of the content, and this is not a cosmetic tidy:
 * `setPlayhead` clamps against the project duration, so a playhead beyond it is a position
 * that can never be moved rightwards and never returned to. Deleting every clip is the
 * extreme case — the content is then zero seconds long and the playhead belongs at zero.
 *
 * Applied only when an edit is *finished*. Mid-drag the duration moves with every frame, and
 * clamping there would walk the playhead leftwards as a clip is dragged in and fail to walk
 * it back when the clip returns — losing a position the user never asked to change.
 */
function playheadInRange(clips: Clip[], playhead: number): number | null {
  const end = computeDuration(clips);
  return playhead > end ? end : null;
}

/** Monitoring volume outlives a reload; nothing else about the preview does. */
function storedVolume(): number {
  try {
    const raw = Number(localStorage.getItem(PREVIEW_VOLUME_KEY));
    return Number.isFinite(raw) ? clampVolume(raw) : 1;
  } catch {
    return 1;
  }
}

const initialState: EditorState = {
  settings: { ...DEFAULT_SETTINGS },
  exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
  tracks: defaultTracks(),
  clips: [],
  libraryOrder: [],
  textLibrary: [],
  mediaLibrary: {},
  past: [],
  future: [],
  selectedClipIds: [],
  selectedShapeId: null,
  playhead: 0,
  trimPreview: null,
  isPlaying: false,
  pxPerSec: 80,
  scrollX: 0,
  scrollY: 0,
  viewportWidth: 800,
  viewportHeight: 300,
  followPlayhead: true,
  snapEnabled: true,
  rippleEnabled: false,
  rippleScope: 'track',
  exportForceFfmpeg: false,
  loudnessJob: null,
  previewVolume: storedVolume(),
  previewMuted: false,
  snapIndicator: null,
  ffmpegStatus: 'idle',
  ffmpegError: null,
  exportProgress: null,
  exportEngine: null,
  exportNotice: null,
  audioMetadata: { ...EMPTY_AUDIO_METADATA },
  libraryNotice: null,
  processJob: null,
  readOnly: false,
};

interface EditorActions {
  // History
  undo: () => void;
  redo: () => void;
  beginInteraction: (label: string) => void;
  endInteraction: () => void;
  undoLabel: () => string | null;
  redoLabel: () => string | null;

  // Session
  /**
   * The whole composition at once: size in pixels and frame rate. An aspect change re-anchors
   * existing geometry and a rate change re-quantizes the timeline, both inside this one step.
   */
  setProjectSettings: (settings: ProjectSettings) => void;
  /** Encoder choices for the next export. Undoable like everything else in the document. */
  setExportSettings: (settings: ExportSettings) => void;
  setCanvasSize: (width: number, height: number) => void;
  setFps: (fps: number) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (playing: boolean) => void;
  setFfmpegStatus: (status: EditorState['ffmpegStatus'], error?: string | null) => void;
  setExportProgress: (p: number | null) => void;
  setExportEngine: (engine: EditorState['exportEngine']) => void;
  setExportNotice: (message: string | null) => void;
  setAudioMetadata: (metadata: AudioMetadata) => void;
  setLibraryNotice: (message: string | null) => void;
  /** Drag order of the library, which is what the "My order" sort shows. */
  reorderLibrary: (assetId: string, targetId: string | null) => void;
  getProjectDuration: () => number;
  /** What the timeline draws: content, plus tail, never less than the minimum span. */
  getTimelineSpan: () => number;
  getContentHeight: () => number;

  // Selection
  selectClip: (id: string | null, additive?: boolean) => void;
  setSelection: (ids: string[]) => void;
  selectAll: () => void;

  // Viewport
  setViewportSize: (width: number, height: number) => void;
  setScroll: (x: number, y: number) => void;
  setPxPerSec: (px: number) => void;
  zoomAt: (factor: number, anchorX: number) => void;
  zoomToFit: () => void;
  zoomToSelection: () => void;
  setFollowPlayhead: (follow: boolean) => void;
  setPreviewVolume: (volume: number) => void;
  togglePreviewMute: () => void;
  toggleSnap: () => void;
  setSnapIndicator: (t: number | null) => void;
  toggleRipple: () => void;
  setRippleScope: (scope: RippleScope) => void;
  closeGaps: () => void;
  setExportForceFfmpeg: (force: boolean) => void;

  // Tracks
  addTrack: (kind: TrackKind) => void;
  removeTrack: (id: string) => void;
  renameTrack: (id: string, label: string) => void;
  moveTrack: (id: string, direction: -1 | 1) => void;
  setTrackHeight: (id: string, height: number) => void;
  toggleTrackFlag: (id: string, flag: 'hidden' | 'muted' | 'solo' | 'locked') => void;
  setTrackVolume: (trackId: string, volume: number) => void;

  // Media
  importToLibrary: (files: FileList | File[], kind: AssetType) => Promise<void>;
  pasteImages: (files: File[]) => Promise<number>;
  importFiles: (files: FileList | File[], kind: AssetType) => Promise<void>;
  importUrlsToLibrary: (urls: string[]) => Promise<void>;
  addAssetToTimeline: (assetId: string) => void;
  dropFilesAt: (dropped: DroppedFile[], trackId: string, time: number) => Promise<void>;
  removeLibraryItem: (assetId: string) => void;
  /**
   * Replaces the whole document with a saved one. Not a `commit`: reopening a project is not
   * an edit, so it starts a fresh history rather than becoming an entry in the old one.
   */
  restoreProject: (loaded: LoadedProject, files?: ReadonlyMap<string, File>) => Promise<void>;
  /** Hands offline assets their bytes back. Returns what to tell the user. */
  relinkFiles: (inputs: RelinkInput[]) => Promise<string>;
  /** Attaches one specific file to one specific asset, for a per-item relink. */
  relinkAsset: (assetId: string, file: File) => Promise<void>;
  setReadOnly: (readOnly: boolean) => void;
  /** Imports one capture session and lays its sources out keeping their measured offsets. */
  /**
   * Adds a finished capture session. The notice is anything the user has to be told about
   * the project itself — today, whether its frame rate moved to match the recording.
   */
  importRecordings: (
    recordings: RecordedSource[],
  ) => Promise<{ assetIds: string[]; notice: string | null }>;
  /** Runs one preset over a whole asset or one excerpt of it, adding the result as a new asset. */
  startProcess: (request: ProcessRequest) => Promise<void>;
  cancelProcess: () => void;
  /**
   * Points a clip at a different asset, keeping the edit and taking the new file whole.
   *
   * `baked` says the new file already contains what the clip was doing to it — the effect
   * chain *and* the retiming — so both come off the clip. Leaving either on would apply it
   * twice: the picture would be double-graded, and a 2× clip pointed at an already-2× file
   * would play at 4× and be half as long. A preset's output is the opposite case: it is
   * unretimed material of the same range, so it keeps the speed and stays the same length.
   *
   * Returns a sentence describing what changed, or null when it could not be done.
   */
  replaceClipSource: (
    clipId: string,
    assetId: string,
    options?: { baked?: boolean; followDetachedAudio?: boolean },
  ) => string | null;
  /** Renders one clip's effect chain to a new file on the GPU, through the export path. */
  startBake: (clipId: string, replace: boolean) => Promise<void>;

  // Clips
  addTextClip: (text: string, template: TextTemplate) => void;
  /** Style overrides on a text clip, and on the object it came from when it has one. */
  setTextStyle: (clipId: string, style: Partial<TextStyle>) => void;
  setTextTemplate: (clipId: string, template: TextTemplate) => void;
  /** Reusable text in the library. */
  addTextObject: (text: string, template: TextTemplate) => string;
  updateTextObject: (id: string, patch: Partial<Omit<TextObject, 'id'>>) => void;
  duplicateTextObject: (id: string) => void;
  /** Break a text clip's link to its library object, so it styles alone. */
  unlinkTextClip: (clipId: string) => void;
  removeTextObject: (id: string) => void;
  addTextObjectToTimeline: (id: string) => void;
  /** Drawn marks over the picture, for their own time range. */
  addAnnotationClip: () => void;
  /** Which mark inside the selected annotation clip is being edited. */
  selectShape: (shapeId: string | null) => void;
  addAnnotationShape: (clipId: string, shape: AnnotationShape) => void;
  updateAnnotationShape: (clipId: string, shapeId: string, patch: Partial<AnnotationShape>) => void;
  removeAnnotationShape: (clipId: string, shapeId: string) => void;
  /** Key one mark's pose at the playhead, so it can follow what it points at. */
  setAnnotationShapeKey: (
    clipId: string,
    shapeId: string,
    points: { x: number; y: number }[],
  ) => void;
  /** Drop one pose. The last one left standing is baked back into the mark's own points. */
  removeAnnotationShapeKey: (clipId: string, shapeId: string, t: number) => void;
  /** Slide one pose along the clip, in clip-local seconds. */
  moveAnnotationShapeKey: (clipId: string, shapeId: string, fromT: number, toT: number) => void;
  clearAnnotationShapeKeys: (clipId: string, shapeId: string) => void;
  updateTextClip: (
    id: string,
    text: string,
    template: TextTemplate,
    textFrame?: NormalizedRect,
  ) => void;
  updateClipTransform: (id: string, transform: OverlayTransform | undefined) => void;
  updateVideoFlags: (
    id: string,
    flags: { audioEnabled?: boolean; hideVideo?: boolean; gain?: number },
  ) => void;
  setClipGain: (id: string, gain: number) => void;
  /** Volume envelope: add or move a point, remove one, change how it interpolates. */
  setGainKey: (clipId: string, t: number, value: number, interp?: Interp) => void;
  moveGainKey: (clipId: string, from: number, t: number, value: number) => void;
  removeGainKey: (clipId: string, t: number) => void;
  clearGainEnvelope: (clipId: string) => void;
  /** Audio effects on a clip: filters, EQ, pitch. */
  addAudioEffect: (clipId: string, type: AudioEffectType) => void;
  removeAudioEffect: (clipId: string, effectId: string) => void;
  toggleAudioEffect: (clipId: string, effectId: string) => void;
  setAudioEffectParam: (clipId: string, effectId: string, key: string, value: number) => void;
  /** Measure the selected audio and set each clip's gain so it lands on `targetLufs`. */
  normalizeSelected: (targetLufs: number) => Promise<void>;
  detachAudio: (id: string) => void;

  // Effects and fades. `target` is a clip id, or { kind: 'track', id } for a track grade.
  addEffect: (target: EffectTargetRef, type: BuiltinEffectType) => void;
  /** Adds a user-supplied shader as an effect, with its annotated parameters. */
  addCustomEffect: (target: EffectTargetRef, source: string) => void;
  /** Replaces a custom effect's source, keeping the parameters that still exist. */
  setEffectShader: (target: EffectTargetRef, effectId: string, source: string) => void;
  removeEffect: (target: EffectTargetRef, effectId: string) => void;
  moveEffect: (target: EffectTargetRef, effectId: string, direction: -1 | 1) => void;
  toggleEffect: (target: EffectTargetRef, effectId: string) => void;
  setEffectParam: (target: EffectTargetRef, effectId: string, param: string, value: number) => void;
  /** Region shape: 0 = whole frame, 1 = rectangle, 2 = ellipse. Seeds a default box. */
  setRegionMode: (target: EffectTargetRef, effectId: string, mode: number) => void;
  /** Moves or resizes the mask box, writing keyframes when the region is armed. */
  setRegionRect: (target: EffectTargetRef, effectId: string, rect: NormalizedRect) => void;
  /** Adds an effect already configured with a region — the one-click masking presets. */
  addRegionEffect: (target: EffectTargetRef, type: BuiltinEffectType) => void;
  resetEffect: (target: EffectTargetRef, effectId: string) => void;
  setClipFade: (clipId: string, edge: 'in' | 'out', seconds: number) => void;
  /** Adds a ranged grade: a clip with no picture that affects everything below it. */
  addAdjustmentClip: () => void;
  setTransitionType: (clipId: string, type: TransitionType) => void;

  // Keyframes. `effectId: null` addresses a placement channel (`frame.x`, `crop.w`, …).
  isChannelArmed: (clipId: string, ref: ChannelRef) => boolean;
  toggleChannelArmed: (clipId: string, ref: ChannelRef) => void;
  moveKeyframe: (clipId: string, ref: ChannelRef, from: number, to: number) => void;
  removeKeyframe: (clipId: string, ref: ChannelRef, t: number) => void;
  setKeyframeInterp: (clipId: string, ref: ChannelRef, t: number, interp: Interp) => void;
  jumpToKeyframe: (direction: -1 | 1) => void;

  /** `allowTransitions` off refuses every overlap — used by nudge and duplicate. */
  moveClipsTo: (moves: ClipMove[], commit: boolean, allowTransitions?: boolean) => boolean;
  /**
   * Drag a trim handle. `mode: 'rate'` holds the source range and solves for the speed
   * instead — every frame is kept and the clip takes a different amount of time to play them.
   */
  trimClipTo: (
    id: string,
    edge: 'left' | 'right',
    timelineTime: number,
    mode?: 'trim' | 'rate',
  ) => void;
  /** Retime a video or audio clip. Growing it follows the ripple mode. */
  setClipSpeed: (id: string, speed: number) => void;
  /** Let the pitch rise and fall with the speed, tape-style, instead of being held. */
  setClipPitchFollows: (id: string, follows: boolean) => void;
  nudgeSelected: (frames: number) => void;
  removeSelected: (ripple?: boolean) => void;
  duplicateSelected: () => void;
  splitSelectedAtPlayhead: () => void;
  canSplitAtPlayhead: () => boolean;
  setTrimPreview: (clipId: string, sourceTime: number) => void;
  clearTrimPreview: () => void;
}

/**
 * A file offered back for an offline asset. The handle, where the picker gave one, is kept
 * so a future open may need no click at all.
 */
export interface RelinkInput {
  file: File;
  handle?: FileSystemFileHandle;
}

/**
 * A file dragged in from the desktop. Structurally a `RelinkInput` on purpose — a dropped
 * file and a picked one are the same thing to everything downstream, handle included.
 */
export interface DroppedFile {
  file: File;
  handle?: FileSystemFileHandle;
}

type Store = EditorState & EditorActions;

/**
 * What to say after a project comes back. Offline is the ordinary case here, not a failure,
 * so it is reported as a next step rather than an error.
 */
function restoreNotice(loaded: LoadedProject, assets: MediaAsset[]): string {
  const offline = assets.filter((a) => !a.file).length;
  const parts: string[] = [];
  if (loaded.recovered) parts.push('Recovered the previous save.');
  else parts.push('Project restored.');
  if (loaded.repairs.length > 0) parts.push(`Repaired on load: ${loaded.repairs.join('; ')}.`);
  if (offline > 0) {
    parts.push(
      `${offline} file(s) are offline — imported media is not copied, so pick them again with Relink.`,
    );
  }
  return parts.join(' ');
}


/** The running preset job, so `cancelProcess` has something to abort. One at a time. */
let activeProcess: AbortController | null = null;

/**
 * A library entry for a file, plus whatever will let it be found again after a reload.
 *
 * An imported file records a fingerprint and nothing else — it is the user's own and is
 * never copied. Anything this app produced is written into OPFS here, because there is
 * nobody to ask for it later. See `docs/persistence-plan.md`.
 */
async function createAssetFromFile(
  file: File,
  kind: AssetType,
  origin: AssetOrigin = 'imported',
): Promise<MediaAsset> {
  const probe = await probeMediaFile(file, kind);
  const id = uid('asset');
  const asset: MediaAsset = {
    id,
    file,
    blobUrl: URL.createObjectURL(file),
    type: kind,
    name: file.name,
    addedAt: Date.now(),
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    hasAudio: probe.hasAudio,
    origin,
  };
  if (origin === 'imported') return { ...asset, fingerprint: fingerprintOf(file) };
  if (origin === 'derived' || origin === 'pasted') {
    return { ...asset, opfsName: (await putMedia(id, file)) ?? undefined };
  }
  return asset;
}

function assetDurationFor(clip: Clip, mediaLibrary: Record<string, MediaAsset>): number {
  // Text, stills and adjustments have no source, so they can be stretched freely.
  if (!('assetId' in clip)) return Infinity;
  const asset = mediaLibrary[clip.assetId];
  return asset?.duration ?? clip.sourceTrimOut;
}

/**
 * The same clip, reading from a different file, starting at its beginning.
 *
 * Everything that describes the *edit* survives: where the clip sits, its effect chain and
 * keyframes, its placement, its fades. Only what describes the *source* is rewritten. Fades
 * are clamped because the new file may be shorter than the old excerpt, and a video's audio
 * flags follow the new file — a preset that strips audio has to leave a clip that knows it.
 */
function swapSource(clip: VideoClip | AudioClip | ImageClip, asset: MediaAsset): Clip {
  const duration = asset.duration;
  const fadeIn = Math.min(clip.fadeIn ?? 0, duration);
  const fadeOut = Math.min(clip.fadeOut ?? 0, Math.max(0, duration - fadeIn));
  const common = {
    assetId: asset.id,
    sourceTrimIn: 0,
    sourceTrimOut: duration,
    fadeIn: fadeIn > 0 ? fadeIn : undefined,
    fadeOut: fadeOut > 0 ? fadeOut : undefined,
  };
  if (clip.kind === 'video') {
    const hasAudio = asset.hasAudio ?? false;
    return { ...clip, ...common, hasAudio, audioEnabled: clip.audioEnabled && hasAudio };
  }
  return { ...clip, ...common };
}

/** Rewrites one clip's effect chain, leaving the array identity alone when nothing changed. */
function mapEffects(
  clips: Clip[],
  clipId: string,
  update: (effects: EffectInstance[]) => EffectInstance[],
): Clip[] {
  return clips.map((c) => {
    if (c.id !== clipId) return c;
    const next = update(c.effects ?? []);
    return next === c.effects ? c : { ...c, effects: next };
  });
}

function clipAcceptsTrack(clip: Clip, track: Track | undefined): boolean {
  if (!track) return false;
  return clip.kind === 'audio' ? track.kind === 'audio' : track.kind === 'video';
}

export const useEditorStore = create<Store>((set, get) => {
  /** Interaction in progress: intermediate mutations don't push history. */
  let interaction: { label: string; doc: EditorDoc } | null = null;
  let lastCoalesce: { label: string; at: number } | null = null;

  /**
   * Everything that happens once a job has produced a file: probe it, put it in the library
   * beside its source, and — when asked — point a clip at it.
   *
   * Shared by both producers, because where a result goes is a property of the library and
   * the timeline, not of whether FFmpeg or the GPU made it.
   */
  async function adoptProduced(
    produced: File,
    kind: AssetType,
    name: string,
    derivedFrom: DerivedFrom,
    replace?: { clipId: string; baked?: boolean; followDetachedAudio?: boolean },
  ): Promise<{ asset: MediaAsset; swapped: string | null }> {
    const created = await createAssetFromFile(
      new File([produced], name, { type: produced.type }),
      kind,
      'derived',
    );
    const asset: MediaAsset = { ...created, derivedFrom };

    set((s) => {
      const libraryOrder = [...s.libraryOrder];
      const at = libraryOrder.indexOf(derivedFrom.assetId);
      libraryOrder.splice(at < 0 ? libraryOrder.length : at + 1, 0, asset.id);
      return { mediaLibrary: { ...s.mediaLibrary, [asset.id]: asset }, libraryOrder };
    });

    // Written through now rather than on the debounce: this file took minutes to encode and
    // nobody can be asked to supply it again.
    notifyProducedFile();

    // Storing it is what makes it survive a reload. If it did not store, the asset works for
    // this session and vanishes on the next — which the user should hear now, while the
    // source clip is still there to bake again, not after the reload.
    if (!asset.opfsName) {
      set({
        libraryNotice:
          `"${name}" was made, but could not be written to browser storage — it will not survive a reload. ` +
          `Free up space, or use "Save a copy…" to keep it.`,
      });
    }

    const swapped = replace
      ? get().replaceClipSource(replace.clipId, asset.id, {
          baked: replace.baked,
          followDetachedAudio: replace.followDetachedAudio,
        })
      : null;
    return { asset, swapped };
  }

  /** Push an undo entry, then apply. Coalesces repeats of the same label within 500ms. */
  function commit(label: string, updater: (state: Store) => Partial<EditorState>, coalesce = false): void {
    const state = get();
    const before = docSnapshot(state);
    let patch = updater(state);
    const after = { ...before, ...patch } as EditorDoc;
    if (docEquals(before, after)) {
      set(patch as Partial<Store>);
      return;
    }

    if (interaction) {
      set(patch as Partial<Store>);
      return;
    }

    // Every finished edit passes through here, so this is the one place the rule is needed
    // for them — drags are caught in `endInteraction` instead, once they settle.
    const moved = playheadInRange(after.clips, state.playhead);
    if (moved !== null) patch = { ...patch, playhead: moved };

    const now = performance.now();
    const shouldCoalesce =
      coalesce && lastCoalesce?.label === label && now - lastCoalesce.at < 500;
    lastCoalesce = coalesce ? { label, at: now } : null;

    set({
      ...(patch as Partial<Store>),
      ...(shouldCoalesce ? {} : { past: pushEntry(state.past, { label, doc: before }) }),
      future: [],
    } as Partial<Store>);
  }

  function contentHeight(tracks: Track[]): number {
    return tracks.reduce((sum, t) => sum + t.height, 0);
  }

  function clampScroll(state: EditorState, x: number, y: number): { scrollX: number; scrollY: number } {
    const maxX = Math.max(0, computeSpan(state.clips) * state.pxPerSec - state.viewportWidth);
    const maxY = Math.max(0, contentHeight(state.tracks) - state.viewportHeight);
    return {
      scrollX: Math.min(maxX, Math.max(0, x)),
      scrollY: Math.min(maxY, Math.max(0, y)),
    };
  }

  return {
    ...initialState,

    getProjectDuration: () => computeDuration(get().clips),
    getTimelineSpan: () => computeSpan(get().clips),
    getContentHeight: () => contentHeight(get().tracks),

    // ---------------------------------------------------------------- history

    beginInteraction: (label) => {
      if (interaction) return;
      interaction = { label, doc: docSnapshot(get()) };
    },

    endInteraction: () => {
      const pending = interaction;
      interaction = null;
      if (!pending) return;
      const state = get();
      if (docEquals(pending.doc, docSnapshot(state))) return;
      lastCoalesce = null;
      const moved = playheadInRange(state.clips, state.playhead);
      set({
        past: pushEntry(state.past, { label: pending.label, doc: pending.doc }),
        future: [],
        ...(moved !== null ? { playhead: moved } : {}),
      });
    },

    undo: () => {
      const state = get();
      const entry = state.past[state.past.length - 1];
      if (!entry) return;
      interaction = null;
      lastCoalesce = null;
      const moved = playheadInRange(entry.doc.clips, state.playhead);
      set({
        ...entry.doc,
        past: state.past.slice(0, -1),
        future: [...state.future, { label: entry.label, doc: docSnapshot(state) }],
        selectedClipIds: pruneSelection(state.selectedClipIds, entry.doc),
        trimPreview: null,
        libraryNotice: `Undid: ${entry.label}`,
        ...(moved !== null ? { playhead: moved } : {}),
      });
    },

    redo: () => {
      const state = get();
      const entry = state.future[state.future.length - 1];
      if (!entry) return;
      interaction = null;
      lastCoalesce = null;
      const moved = playheadInRange(entry.doc.clips, state.playhead);
      set({
        ...entry.doc,
        future: state.future.slice(0, -1),
        past: pushEntry(state.past, { label: entry.label, doc: docSnapshot(state) }),
        selectedClipIds: pruneSelection(state.selectedClipIds, entry.doc),
        trimPreview: null,
        libraryNotice: `Redid: ${entry.label}`,
        ...(moved !== null ? { playhead: moved } : {}),
      });
    },

    undoLabel: () => get().past[get().past.length - 1]?.label ?? null,
    redoLabel: () => get().future[get().future.length - 1]?.label ?? null,

    // ---------------------------------------------------------------- session

    /**
     * Resizing and reshaping are the same action but not the same edit.
     *
     * At a constant aspect a normalized rect still means what it meant, so 1080p → 4K only
     * writes two numbers. A change of *shape* moves every explicit placement, and a change of
     * frame rate moves every clip edge onto the new grid. All of it belongs to one commit: the
     * setting and the consequences it forced are a single history entry, so one undo puts back
     * both. Undoing a canvas change and finding the overlays still moved would be the worst of
     * both.
     */
    setProjectSettings: (requested) => {
      const size = {
        width: clampDimension(requested.width),
        height: clampDimension(requested.height),
      };
      const fps = clampFps(requested.fps);
      const current = get().settings;
      const resized = size.width !== current.width || size.height !== current.height;
      const rateChanged = fps !== current.fps;
      if (!resized && !rateChanged) return;

      const from = { width: current.width, height: current.height };
      const reshaped = resized && !sameAspect(from, size);
      const label =
        resized && rateChanged
          ? 'Change project settings'
          : reshaped
            ? 'Change canvas shape'
            : resized
              ? 'Change resolution'
              : 'Change frame rate';

      commit(label, (s) => {
        let clips = s.clips;
        if (reshaped) clips = reframeClips(clips, s.mediaLibrary, from, size);
        // Existing edges were snapped to the old grid and are now between frames. Leaving
        // them there is not neutral: export samples the nearest frame either way, so the
        // choice is between moving them visibly now or invisibly at export.
        if (rateChanged && clips.length > 0) clips = requantizeClips(clips, fps);
        return {
          settings: { ...size, fps },
          clips,
          ...(reshaped ? { tracks: reframeTracks(s.tracks, from, size) } : {}),
        };
      });
    },

    setExportSettings: (next) => commit('Change export settings', () => ({ exportSettings: next })),

    setCanvasSize: (width, height) =>
      get().setProjectSettings({ ...get().settings, width, height }),

    setFps: (fps) => get().setProjectSettings({ ...get().settings, fps }),

    setPlayhead: (t) => {
      const max = get().getProjectDuration();
      set({ playhead: Math.max(0, Math.min(t, max)) });
    },
    setPlaying: (isPlaying) => set({ isPlaying }),
    setFfmpegStatus: (ffmpegStatus, ffmpegError = null) => set({ ffmpegStatus, ffmpegError }),
    setExportProgress: (exportProgress) => set({ exportProgress }),
    setExportEngine: (exportEngine) => set({ exportEngine }),
    setExportNotice: (exportNotice) => set({ exportNotice }),
    // Deliberately not `commit`: tags are not part of the document yet, so typing a title is
    // not an undoable edit and does not mark the project dirty. See `AudioMetadata`.
    setAudioMetadata: (audioMetadata) => set({ audioMetadata }),
    setLibraryNotice: (libraryNotice) => set({ libraryNotice }),

    /**
     * Move a library row to sit before `targetId`, or to the end when that is null.
     *
     * `libraryOrder` is document state — it is inside `docSnapshot()` — so dragging a row is
     * an edit and undo puts it back. The *view* (grouping, sorting, the search box) is not,
     * and lives in the component; this is only the underlying order that "My order" shows.
     */
    reorderLibrary: (assetId, targetId) => {
      if (assetId === targetId) return;
      commit('Reorder library', (s) => {
        const without = s.libraryOrder.filter((id) => id !== assetId);
        if (!s.libraryOrder.includes(assetId)) return {};
        const at = targetId === null ? without.length : without.indexOf(targetId);
        if (targetId !== null && at < 0) return {};
        return { libraryOrder: [...without.slice(0, at), assetId, ...without.slice(at)] };
      });
    },

    // -------------------------------------------------------------- selection

    selectClip: (id, additive = false) => {
      if (id === null) {
        set({ selectedClipIds: [], selectedShapeId: null });
        return;
      }
      set((s) => {
        // A mark belongs to one clip, so changing which clip is selected always ends its
        // edit — there is nowhere for the selection to still mean something.
        if (!additive) return { selectedClipIds: [id], selectedShapeId: null };
        return s.selectedClipIds.includes(id)
          ? { selectedClipIds: s.selectedClipIds.filter((x) => x !== id), selectedShapeId: null }
          : { selectedClipIds: [...s.selectedClipIds, id], selectedShapeId: null };
      });
    },

    setSelection: (ids) => set({ selectedClipIds: ids, selectedShapeId: null }),
    selectAll: () =>
      set((s) => ({ selectedClipIds: s.clips.map((c) => c.id), selectedShapeId: null })),
    selectShape: (shapeId) => set({ selectedShapeId: shapeId }),

    // --------------------------------------------------------------- viewport

    setViewportSize: (viewportWidth, viewportHeight) =>
      set((s) => {
        const clamped = clampScroll({ ...s, viewportWidth, viewportHeight }, s.scrollX, s.scrollY);
        return { viewportWidth, viewportHeight, ...clamped };
      }),

    setScroll: (x, y) => set((s) => clampScroll(s, x, y)),

    setPxPerSec: (px) =>
      set((s) => {
        const pxPerSec = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, px));
        return { pxPerSec, ...clampScroll({ ...s, pxPerSec }, s.scrollX, s.scrollY) };
      }),

    zoomAt: (factor, anchorX) =>
      set((s) => {
        const pxPerSec = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, s.pxPerSec * factor));
        const anchorTime = (s.scrollX + anchorX) / s.pxPerSec;
        const scrollX = anchorTime * pxPerSec - anchorX;
        return { pxPerSec, ...clampScroll({ ...s, pxPerSec }, scrollX, s.scrollY) };
      }),

    zoomToFit: () =>
      set((s) => {
        const duration = Math.max(1, computeDuration(s.clips));
        const pxPerSec = Math.min(
          MAX_PX_PER_SEC,
          Math.max(MIN_PX_PER_SEC, (s.viewportWidth - 24) / duration),
        );
        return { pxPerSec, ...clampScroll({ ...s, pxPerSec }, 0, s.scrollY) };
      }),

    zoomToSelection: () =>
      set((s) => {
        const selected = s.clips.filter((c) => s.selectedClipIds.includes(c.id));
        if (selected.length === 0) return {};
        const start = Math.min(...selected.map((c) => c.timelineStart));
        const end = Math.max(...selected.map((c) => clipEnd(c)));
        const span = Math.max(0.2, end - start);
        const pxPerSec = Math.min(
          MAX_PX_PER_SEC,
          Math.max(MIN_PX_PER_SEC, (s.viewportWidth - 80) / span),
        );
        const scrollX = start * pxPerSec - 40;
        return { pxPerSec, ...clampScroll({ ...s, pxPerSec }, scrollX, s.scrollY) };
      }),

    setFollowPlayhead: (followPlayhead) => set({ followPlayhead }),

    setPreviewVolume: (volume) => {
      const previewVolume = clampVolume(volume);
      set((s) => ({
        previewVolume,
        previewMuted: mutedAfterVolumeChange(previewVolume, s.previewMuted),
      }));
      try {
        localStorage.setItem(PREVIEW_VOLUME_KEY, String(previewVolume));
      } catch {
        // Storage disabled; the volume simply will not be remembered.
      }
    },

    togglePreviewMute: () => set((s) => ({ previewMuted: !s.previewMuted })),
    toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),

    toggleRipple: () => set((s) => ({ rippleEnabled: !s.rippleEnabled })),
    setRippleScope: (rippleScope) => set({ rippleScope }),
    setExportForceFfmpeg: (exportForceFfmpeg) => set({ exportForceFfmpeg }),

    /**
     * Scope follows the selection, because that is what the user is pointing at.
     *
     * With clips selected, each of their tracks is closed on its own. With nothing selected the
     * timeline is closed as a whole — only the stretches where *nothing* is playing anywhere
     * are removed, so every cross-track relationship survives. Closing every track
     * independently would be the one operation guaranteed to slide detached audio out of sync
     * with its own picture.
     */
    closeGaps: () => {
      const state = get();
      const lockedTracks = new Set(state.tracks.filter((t) => t.locked).map((t) => t.id));
      const selected = state.clips.filter((c) => state.selectedClipIds.includes(c.id));

      const shifts =
        selected.length > 0
          ? closeGapsOnTracks(
              state.clips,
              [...new Set(selected.map((c) => c.trackId))].filter((id) => !lockedTracks.has(id)),
            )
          : closeGapsAcrossTracks(state.clips.filter((c) => !lockedTracks.has(c.trackId)));

      if (shifts.length === 0) return;
      commit(selected.length > 0 ? 'Close gaps on track' : 'Close gaps', (s) => ({
        clips: applyShifts(s.clips, shifts),
      }));
    },
    setSnapIndicator: (snapIndicator) => set({ snapIndicator }),

    // ----------------------------------------------------------------- tracks

    addTrack: (kind) =>
      commit(`Add ${kind} track`, (s) => ({
        tracks: insertTrack(s.tracks, createTrack(kind, nextTrackLabel(s.tracks, kind))),
      })),

    removeTrack: (id) =>
      commit('Delete track', (s) => {
        const track = s.tracks.find((t) => t.id === id);
        if (!track) return {};
        const sameKind = s.tracks.filter((t) => t.kind === track.kind);
        if (sameKind.length <= 1) return {};
        return {
          tracks: s.tracks.filter((t) => t.id !== id),
          clips: s.clips.filter((c) => c.trackId !== id),
        };
      }),

    renameTrack: (id, label) =>
      commit('Rename track', (s) => ({
        tracks: s.tracks.map((t) => (t.id === id ? { ...t, label: label.trim() || t.label } : t)),
      })),

    /** Reorders within the track's own kind group — video and audio never interleave. */
    moveTrack: (id, direction) =>
      commit('Reorder track', (s) => {
        const track = s.tracks.find((t) => t.id === id);
        if (!track) return {};
        const group = track.kind === 'video' ? videoTracks(s.tracks) : audioTracks(s.tracks);
        const index = group.findIndex((t) => t.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= group.length) return {};

        const reordered = [...group];
        [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
        const others = s.tracks.filter((t) => t.kind !== track.kind);
        return {
          tracks: track.kind === 'video' ? [...reordered, ...others] : [...others, ...reordered],
        };
      }),

    setTrackHeight: (id, height) =>
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === id
            ? { ...t, height: Math.min(MAX_TRACK_HEIGHT, Math.max(MIN_TRACK_HEIGHT, height)) }
            : t,
        ),
      })),

    toggleTrackFlag: (id, flag) =>
      set((s) => ({
        tracks: s.tracks.map((t) => (t.id === id ? { ...t, [flag]: !t[flag] } : t)),
      })),

    setTrackVolume: (trackId, volume) =>
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === trackId && t.kind === 'audio' ? { ...t, volume: clampTrackVolume(volume) } : t,
        ),
      })),

    // ------------------------------------------------------------------ media

    importUrlsToLibrary: async (urls) => {
      if (urls.length === 0) return;
      set({ libraryNotice: `Importing ${urls.length} file(s) from URL…` });
      let imported = 0;
      const errors: string[] = [];

      for (const url of urls) {
        try {
          const file = await fetchUrlAsFile(url);
          const kind = inferAssetKind(file.name, file.type);
          // Stored like anything else the app made: the user picked a URL, not a file, and
          // has nothing on disk to offer back if these bytes go missing.
          const asset = await createAssetFromFile(file, kind, 'derived');
          set((state) => ({
            mediaLibrary: { ...state.mediaLibrary, [asset.id]: asset },
            libraryOrder: state.libraryOrder.includes(asset.id)
              ? state.libraryOrder
              : [...state.libraryOrder, asset.id],
          }));
          imported += 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(msg);
          console.warn('[MediaLibrary] URL import failed:', url, e);
        }
      }

      if (imported === 0 && errors.length > 0) {
        set({ libraryNotice: `URL import failed: ${errors[0]}` });
      } else if (errors.length > 0) {
        set({ libraryNotice: `Imported ${imported} file(s). ${errors.length} failed (see console).` });
      } else {
        set({ libraryNotice: `Imported ${imported} file(s) from URL.` });
      }
    },

    importToLibrary: async (fileInput, kind) => {
      const files = Array.from(fileInput instanceof FileList ? fileInput : fileInput);
      for (const file of files) {
        const asset = await createAssetFromFile(file, kind);
        set((state) => ({
          mediaLibrary: { ...state.mediaLibrary, [asset.id]: asset },
          libraryOrder: state.libraryOrder.includes(asset.id)
            ? state.libraryOrder
            : [...state.libraryOrder, asset.id],
        }));
      }
    },

    /**
     * An image off the clipboard.
     *
     * Unlike an import, this has no file on disk: it never had a path, so there is nothing to
     * relink it to and nobody to ask for it again. It is written to OPFS like a recording, and
     * carries the `pasted` origin so a reopened project knows to look there — an imported
     * origin would send `rehydrate` hunting for a fingerprint that can never match, and the
     * image would come back offline every time.
     */
    pasteImages: async (files) => {
      let added = 0;
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const asset = await createAssetFromFile(file, 'image', 'pasted');
        set((state) => ({
          mediaLibrary: { ...state.mediaLibrary, [asset.id]: asset },
          libraryOrder: [...state.libraryOrder, asset.id],
        }));
        added++;
      }
      if (added > 0) {
        set({ libraryNotice: `Pasted ${added} image${added === 1 ? '' : 's'} into the library.` });
        notifyProducedFile();
      }
      return added;
    },

    importFiles: async (fileInput, kind) => {
      const files = Array.from(fileInput instanceof FileList ? fileInput : fileInput);
      for (const file of files) {
        const asset = await createAssetFromFile(file, kind);
        set((state) => ({
          mediaLibrary: { ...state.mediaLibrary, [asset.id]: asset },
          libraryOrder: state.libraryOrder.includes(asset.id)
            ? state.libraryOrder
            : [...state.libraryOrder, asset.id],
        }));
        get().addAssetToTimeline(asset.id);
      }
    },

    addAssetToTimeline: (assetId) => {
      const asset = get().mediaLibrary[assetId];
      if (!asset) return;
      commit(`Add ${asset.name}`, (s) => {
        const placed = buildClipsForAsset(
          asset,
          assetId,
          s.tracks,
          s.clips,
          s.playhead,
          s.settings.fps,
        );
        return {
          tracks: placed.tracks,
          clips: [...s.clips, ...placed.clips],
          selectedClipIds: [placed.selectedClipId],
        } as Partial<EditorState>;
      });
    },

    /**
     * Files dragged in from the desktop, onto the lane and the time the pointer named.
     *
     * They enter the library like any other import — referenced, never copied, so they come
     * back offline after a reload like everything else the user brought — but they reach the
     * timeline through `buildDropClips` rather than the import placement, because the drop
     * already said where. The handle is kept where the browser offers one; it is the same
     * bonus relinking gets, and the same thing nothing depends on.
     *
     * One history entry for the whole drop, however many files it carried.
     */
    dropFilesAt: async (dropped, trackId, time) => {
      if (dropped.length === 0) return;
      set({ libraryNotice: `Adding ${dropped.length} file(s)\u2026` });

      const items: DropItem[] = [];
      const failed: string[] = [];
      for (const { file, handle } of dropped) {
        try {
          const asset = await createAssetFromFile(file, inferAssetKind(file.name, file.type));
          set((state) => ({
            mediaLibrary: { ...state.mediaLibrary, [asset.id]: asset },
            libraryOrder: state.libraryOrder.includes(asset.id)
              ? state.libraryOrder
              : [...state.libraryOrder, asset.id],
          }));
          if (handle) void putHandle(asset.id, handle);
          items.push({ assetId: asset.id, asset });
        } catch (e) {
          failed.push(file.name);
          console.warn('[Timeline] dropped file could not be read:', file.name, e);
        }
      }

      if (items.length > 0) {
        const label = items.length === 1 ? `Add ${items[0].asset.name}` : `Add ${items.length} files`;
        commit(label, (s) => {
          const placed = buildDropClips(items, s.tracks, s.clips, trackId, time, s.settings.fps);
          return {
            tracks: placed.tracks,
            clips: [...s.clips, ...placed.clips],
            selectedClipIds: placed.clips.map((c) => c.id),
          } as Partial<EditorState>;
        });
      }

      const added =
        items.length === 1 ? `Added ${items[0].asset.name}.` : `Added ${items.length} files.`;
      set({
        libraryNotice:
          failed.length === 0
            ? added
            : items.length === 0
              ? `Could not read ${failed.join(', ')}.`
              : `${added} Could not read ${failed.join(', ')}.`,
      });
    },

    /**
     * A capture session arrives as up to three files that belong together. They enter the
     * library like any import, but reach the timeline through their own placement so the
     * measured start offsets survive — and as a single history entry, because undoing a
     * recording one track at a time would be a strange thing to make someone do.
     */
    importRecordings: async (recordings) => {
      const placements: RecordingPlacement[] = [];
      // A camera composites over a screen; on its own it is simply the picture, full frame.
      const overScreen = recordings.some((r) => r.kind === 'screen');

      for (const recording of recordings) {
        const visual = recording.kind === 'screen' || recording.kind === 'camera';
        const kind: AssetType = visual ? 'video' : 'audio';
        const asset = await createAssetFromFile(recording.file, kind, 'recorded');
        // Prefer the length the capture reported. `probeMediaFile` substitutes a flat 10s
        // whenever a container says `Infinity`, which is exactly the state an unrepaired
        // recording is in — so trusting the probe here would silently truncate a recording
        // on the one path where repair failed.
        const duration = recording.duration > 0 ? recording.duration : asset.duration;
        const resolved: MediaAsset = {
          ...asset,
          duration,
          // Bound, not copied: the bytes are already in `recordings/`, and duplicating the
          // largest files in the store to say so would be a poor trade.
          recordingId: recording.recordingId,
          opfsName: recording.storedName,
        };
        set((state) => ({
          mediaLibrary: { ...state.mediaLibrary, [resolved.id]: resolved },
          libraryOrder: state.libraryOrder.includes(resolved.id)
            ? state.libraryOrder
            : [...state.libraryOrder, resolved.id],
        }));
        placements.push({
          assetId: resolved.id,
          asset: resolved,
          startOffset: recording.startOffset,
          lane: SOURCE_LANE[recording.kind],
          ...(recording.kind === 'camera' && overScreen
            ? {
                transform: pictureInPictureTransform(
                  recording.format ?? { width: resolved.width ?? 0, height: resolved.height ?? 0 },
                  get().settings,
                ),
              }
            : {}),
        });
      }

      if (placements.length === 0) return { assetIds: [], notice: null };

      // Decided against the timeline as it was *before* this recording landed: the whole
      // question is whether there were already clips whose edges a rate change would move.
      const rate = frameRateDecision(
        fastestRate(recordings.map((r) => r.format)),
        get().settings,
        get().clips.length,
        DEFAULT_SETTINGS.fps,
      );

      // One history entry for the whole thing, frame rate included. Undoing a recording one
      // track — or one setting — at a time would be a strange thing to make someone do.
      commit('Add recording', (s) => {
        const fps = rate.fps ?? s.settings.fps;
        const placed = buildRecordingClips(placements, s.tracks, s.clips, s.playhead, fps);
        return {
          tracks: placed.tracks,
          clips: [...s.clips, ...placed.clips],
          selectedClipIds: placed.selectedClipId ? [placed.selectedClipId] : [],
          ...(rate.fps ? { settings: { ...s.settings, fps: rate.fps } } : {}),
        } as Partial<EditorState>;
      });

      return { assetIds: placements.map((p) => p.assetId), notice: rate.notice };
    },

    /**
     * Runs a library preset over one asset.
     *
     * Never in place: the result enters the library beside its source, so the two can be
     * compared and the slow ones can be thrown away. Not a history entry either — like every
     * other import, it changes what is available to edit with rather than the edit itself.
     */
    startProcess: async ({ presetId, assetId, range, replaceClipId }) => {
      const state = get();
      if (state.processJob) return;
      if (state.exportProgress !== null) {
        set({
          libraryNotice:
            'An export is running. Presets share the same FFmpeg, so this has to wait for it.',
        });
        return;
      }

      const asset = state.mediaLibrary[assetId];
      const preset = findPreset(presetId);
      if (!asset || !preset) return;
      if (!asset.file) {
        set({ libraryNotice: `"${asset.name}" is offline. Relink it before running a preset on it.` });
        return;
      }
      // Checked here as well as in the dialog: the dialog is one caller, not the contract.
      const refusal = replaceClipId ? replaceRefusal(preset) : null;
      if (refusal) {
        set({ libraryNotice: refusal });
        return;
      }

      const controller = new AbortController();
      activeProcess = controller;
      const label = `${preset.label} · ${asset.name}`;
      set({
        processJob: { assetId, presetId, label, phase: 'loading', progress: 0 },
        libraryNotice: null,
      });

      try {
        const produced = await runPreset(
          asset,
          preset,
          range,
          ({ phase, progress }) => {
            const job = get().processJob;
            if (job) set({ processJob: { ...job, phase, progress } });
          },
          controller.signal,
        );

        // A GIF is an image as far as the rest of the app is concerned; everything else
        // the presets write is an mp4. The library entry is added either way, and outside the
        // history entry — so undoing the replacement puts the clip back without throwing away
        // a file that took minutes to make.
        const kind: AssetType = preset.ext === 'gif' ? 'image' : 'video';
        const { asset: derived, swapped } = await adoptProduced(
          produced,
          kind,
          derivedName(asset.name, preset, range),
          { assetId, presetId, presetLabel: preset.label, range },
          replaceClipId
            ? { clipId: replaceClipId, followDetachedAudio: presetChangesSound(preset) }
            : undefined,
        );
        set({
          libraryNotice: swapped
            ? `${preset.label}: ${swapped} Undo restores the clip; “${derived.name}” stays in the library.`
            : `${preset.label}: added “${derived.name}”. The original is untouched.`,
        });
      } catch (e) {
        if (controller.signal.aborted) {
          set({ libraryNotice: `${preset.label} cancelled — nothing was added.` });
        } else {
          console.error('[Tools] preset failed:', presetId, e);
          set({ libraryNotice: `${preset.label} failed: ${formatExportError(e)}` });
        }
      } finally {
        activeProcess = null;
        set({ processJob: null });
      }
    },

    /**
     * Renders one clip's effect chain to a new file on the GPU.
     *
     * The counterpart to `startProcess`, and the fast one: it goes through the WebCodecs
     * export path, so the compositor that drew the preview draws the file and the hardware
     * encoder writes it. That is why it is not another implementation of any effect — it is
     * the same one, which is the only way "what you see is what you get" survives a bake.
     */
    startBake: async (clipId, replace) => {
      const state = get();
      if (state.processJob) return;
      if (state.exportProgress !== null) {
        set({ libraryNotice: 'An export is already running. One encode at a time.' });
        return;
      }

      const clip = state.clips.find((c) => c.id === clipId);
      if (!clip || !('assetId' in clip)) return;
      const asset = state.mediaLibrary[clip.assetId];
      if (!asset) return;
      if (!asset.file) {
        set({ libraryNotice: `"${asset.name}" is offline. Relink it before baking this clip.` });
        return;
      }

      const controller = new AbortController();
      activeProcess = controller;
      const label = `Bake effects · ${asset.name}`;
      set({
        processJob: { assetId: asset.id, presetId: BAKE_ID, label, phase: 'running', progress: 0 },
        libraryNotice: null,
      });

      try {
        const result = await bakeClip(
          clip,
          asset,
          state.settings,
          state.exportSettings,
          (fraction) => {
            const job = get().processJob;
            if (job) set({ processJob: { ...job, progress: Math.round(fraction * 100) } });
          },
          controller.signal,
        );

        const range = { start: clip.sourceTrimIn, duration: clipDuration(clip) };
        const { asset: derived, swapped } = await adoptProduced(
          result.file,
          'video',
          bakedName(asset.name, range),
          { assetId: asset.id, presetId: BAKE_ID, presetLabel: 'Baked effects', range },
          // No `followDetachedAudio`: a bake renders the picture, and the clip whose audio
          // was detached has `audioEnabled: false`, so the file it writes carries no sound to
          // point that audio clip at.
          replace ? { clipId, baked: true } : undefined,
        );

        const speed = result.seconds > 0 ? range.duration / result.seconds : 0;
        const rate = `${result.frames} frames in ${result.seconds.toFixed(1)}s (${speed.toFixed(1)}× realtime)`;
        set({
          libraryNotice: swapped
            ? `Baked ${rate}: ${swapped} Undo restores the clip; “${derived.name}” stays in the library.`
            : `Baked ${rate} — added “${derived.name}”.`,
        });
      } catch (e) {
        if (controller.signal.aborted) {
          set({ libraryNotice: 'Bake cancelled — nothing was added.' });
        } else {
          console.error('[Tools] bake failed:', clipId, e);
          set({ libraryNotice: `Bake failed: ${formatExportError(e)}` });
        }
      } finally {
        activeProcess = null;
        set({ processJob: null });
      }
    },

    cancelProcess: () => {
      activeProcess?.abort(new DOMException('Preset cancelled', 'AbortError'));
    },

    replaceClipSource: (clipId, assetId, options) => {
      const clip = get().clips.find((c) => c.id === clipId);
      const asset = get().mediaLibrary[assetId];
      if (!clip || !asset || !('assetId' in clip)) return null;

      const was = clipDuration(clip);
      const now = asset.duration;
      const wasBaked = options?.baked === true;
      const baked = wasBaked && (clip.effects?.length ?? 0) > 0;

      // Detaching a clip's audio leaves a second clip playing the same file, and nothing
      // recorded that the two belong together. Swapping only the video is how a project ends
      // up with a processed picture over unprocessed sound — silently, because both halves
      // are individually doing what they were told. Whether the new file's sound is meant to
      // stand in is the producer's call, not this one's: a picture-only preset leaves the
      // original audio correct, and a bake of a clip whose audio is off writes silence.
      const partners = detachedAudio(clip, get().clips);
      const follow =
        options?.followDetachedAudio === true
          ? new Set(partners.following.map((c) => c.id))
          : new Set<string>();

      commit(baked ? 'Bake effects' : 'Replace clip source', (s) => ({
        clips: s.clips.map((c) => {
          if (c.id === clipId) {
            return {
              ...swapSource(clip, asset),
              ...(wasBaked ? { effects: undefined, speed: undefined } : {}),
            };
          }
          // One entry covers both, because one user action caused both.
          return follow.has(c.id) && c.kind === 'audio' ? swapSource(c, asset) : c;
        }),
      }));

      const audio = detachedAudioOutcome(partners, follow.size > 0);

      // Said out loud because leaving the chain on the clip would apply every effect twice —
      // once from the file and once from the renderer — and the picture would only look
      // wrong to someone who knew what it was supposed to look like.
      const chain = baked ? ' Its effect chain moved into the file and is off the clip.' : '';

      // Under a frame is rounding, not a length change worth reporting.
      if (Math.abs(now - was) < 1 / get().settings.fps) {
        return `the clip now plays the processed version.${chain}${audio}`;
      }
      const tail =
        now < was
          ? `so there is a ${(was - now).toFixed(1)}s gap after it`
          : `so it now reaches ${(now - was).toFixed(1)}s further right`;
      return (
        `the clip now plays the processed version and runs ${now.toFixed(1)}s instead of ` +
        `${was.toFixed(1)}s, ${tail} — nothing later on the track moved.${chain}${audio}`
      );
    },

    removeLibraryItem: (assetId) => {
      const asset = get().mediaLibrary[assetId];
      if (!asset) return;
      if (isAssetInUse(assetId, get().clips)) {
        set({
          libraryNotice: `"${asset.name}" is on the timeline. Remove those clips first — deleting it here would take its file with it.`,
        });
        return;
      }

      if (asset.blobUrl) URL.revokeObjectURL(asset.blobUrl);
      // Bytes this app made have nowhere else to exist, so removing the entry removes them.
      // Undo does not bring them back — `mediaLibrary` is outside the undo document, and the
      // confirm in the library says so.
      // Not in a read-only tab: the deletion is not being saved, so dropping the bytes would
      // take a file the owning tab still references.
      if (asset.origin === 'derived' && asset.opfsName && !get().readOnly) {
        void dropMedia(asset.opfsName);
      }
      clearWaveformCache(assetId);
      clearVideoThumbnailCache(assetId);
      set((state) => {
        const { [assetId]: _removed, ...mediaLibrary } = state.mediaLibrary;
        return {
          mediaLibrary,
          libraryOrder: state.libraryOrder.filter((id) => id !== assetId),
        };
      });
    },

    restoreProject: async (loaded, files) => {
      const assets = await rehydrate(loaded.assets, files);
      // Files in `media/` that no restored asset claims belonged to a project that no longer
      // exists — but only if they predate this save. A file newer than the project cannot be
      // described by it yet, and sweeping those deletes work that was merely unsaved. The
      // sweep is also skipped entirely in a read-only tab, which by definition holds a
      // project that is behind the one on disk.
      // Skipped for a folder bundle too (`files` given): those assets live in the folder, so
      // what OPFS holds says nothing about whether they are still wanted.
      if (!files && !get().readOnly && loaded.savedAt > 0) {
        void collectGarbage(reachableMedia(loaded.assets), loaded.savedAt);
      }

      set((state) => {
        for (const asset of Object.values(state.mediaLibrary)) {
          if (asset.blobUrl) URL.revokeObjectURL(asset.blobUrl);
        }
        const mediaLibrary: Record<string, MediaAsset> = {};
        for (const asset of assets) mediaLibrary[asset.id] = asset;
        return {
          ...loaded.doc,
          mediaLibrary,
          // Reopening is not an edit. A fresh history is also the only honest one: the
          // states those entries described are gone with the page that held them.
          past: [],
          future: [],
          selectedClipIds: [],
          playhead: 0,
          isPlaying: false,
          libraryNotice: restoreNotice(loaded, assets),
        } as Partial<EditorState>;
      });
    },

    relinkFiles: async (inputs) => {
      const state = get();
      const offline = state.libraryOrder
        .map((id) => state.mediaLibrary[id])
        .filter((a): a is MediaAsset => !!a && !a.file);

      const candidates = inputs.map((input) => ({
        name: input.file.name,
        size: input.file.size,
        lastModified: input.file.lastModified,
        input,
      }));
      const plan = planRelink(candidates, offline);

      const attached: Record<string, MediaAsset> = {};
      for (const pair of plan.pairs) {
        const asset = get().mediaLibrary[pair.assetId];
        if (!asset) continue;
        const { file, handle } = pair.file.input;
        attached[asset.id] = { ...attachFile(asset, file), fingerprint: fingerprintOf(file) };
        // Storing the handle is what can make the *next* open silent, where the browser
        // remembers the grant. It never makes this one silent, and nothing depends on it.
        if (handle) void putHandle(asset.id, handle);
      }
      if (Object.keys(attached).length > 0) {
        set((s) => ({ mediaLibrary: { ...s.mediaLibrary, ...attached } }));
      }

      const message = relinkSummary(plan);
      set({ libraryNotice: message });
      return message;
    },

    relinkAsset: async (assetId, file) => {
      await get().relinkFiles([{ file }]);
      const asset = get().mediaLibrary[assetId];
      // The picker was opened for one specific asset, so an unmatched file is still meant
      // for it — the name simply changed since. Honour that rather than refuse it.
      if (asset && !asset.file) {
        set((s) => ({
          mediaLibrary: {
            ...s.mediaLibrary,
            [assetId]: { ...attachFile(asset, file), fingerprint: fingerprintOf(file) },
          },
        }));
        set({ libraryNotice: `Relinked ${asset.name} to ${file.name}.` });
      }
    },

    setReadOnly: (readOnly) => set({ readOnly }),

    // ------------------------------------------------------------------ clips

    addTextClip: (text, template) =>
      commit('Add text', (s) => {
        const lane = findLaneForPlacement(
          s.tracks,
          s.clips,
          'video',
          s.playhead,
          TEXT_CLIP_DURATION,
          s.settings.fps,
          true,
        );
        const clip: Clip = {
          id: uid('clip'),
          trackId: lane.trackId,
          kind: 'text',
          text,
          template,
          timelineStart: lane.start,
          sourceTrimIn: 0,
          sourceTrimOut: TEXT_CLIP_DURATION,
          textFrame: DEFAULT_FULL_FRAME,
        };
        return {
          tracks: lane.tracks,
          clips: [...s.clips, clip],
          selectedClipIds: [clip.id],
        } as Partial<EditorState>;
      }),

    updateTextClip: (id, text, template, textFrame) =>
      commit(
        'Edit text',
        (s) => ({
          clips: s.clips.map((c) => {
            if (c.id !== id || c.kind !== 'text') return c;
            return { ...c, text, template, ...(textFrame !== undefined ? { textFrame } : {}) };
          }),
        }),
        true,
      ),

    updateClipTransform: (id, transform) => {
      const state = get();
      const clip = state.clips.find((c) => c.id === id);
      const armed =
        !!transform &&
        !!clip &&
        TRANSFORM_CHANNELS.some((ch) => (clip.transformKeyframes?.[ch]?.length ?? 0) > 0);

      if (armed && clip) {
        // With placement armed, moving the box writes the whole rectangle as one set of
        // keys at the playhead — that is what makes a picture-in-picture travel.
        const at = quantizeToFrame(
          Math.max(0, state.playhead - clip.timelineStart),
          state.settings.fps,
        );
        commit(
          'Set placement keyframe',
          (s) => ({
            clips: s.clips.map((c) => {
              if (c.id !== id) return c;
              let next = c;
              for (const channel of TRANSFORM_CHANNELS) {
                let value: number;
                if (channel === 'rotate') {
                  value = transform.rotate ?? 0;
                } else {
                  const [group, axis] = channel.split('.') as [
                    'crop' | 'frame',
                    'x' | 'y' | 'w' | 'h',
                  ];
                  value = transform[group][axis];
                }
                next = withChannel(next, { effectId: null, param: channel }, (keys) =>
                  upsertKey(keys, at, value),
                );
              }
              return next;
            }),
          }),
          true,
        );
        return;
      }

      commit(
        transform ? 'Change placement' : 'Reset to full frame',
        (s) => ({
          clips: s.clips.map((c) => {
            if (c.id !== id) return c;
            // Asked rather than listed: this guard used to name video and image, so an
            // annotation's placement checkbox wrote nothing and could not be ticked.
            if (!acceptsTransform(c)) return c;
            // Dropping the transform drops any animation of it with it.
            return transform ? { ...c, transform } : { ...c, transform, transformKeyframes: undefined };
          }),
        }),
        true,
      );
    },

    updateVideoFlags: (id, flags) =>
      commit('Change clip', (s) => ({
        clips: s.clips.map((c) => (c.id === id && c.kind === 'video' ? { ...c, ...flags } : c)),
      })),

    setClipGain: (id, gain) =>
      commit(
        'Change volume',
        (s) => ({
          clips: s.clips.map((c) => {
            if (c.id !== id) return c;
            if (c.kind !== 'video' && c.kind !== 'audio') return c;
            return { ...c, gain: clampClipGain(gain) };
          }),
        }),
        true,
      ),

    // ------------------------------------------------- volume envelope and audio effects

    /**
     * Envelope points are stored in *clip-local* seconds, so trimming or moving the clip
     * carries them along without arithmetic — the same convention the transform channels use.
     */
    setGainKey: (clipId, t, value, interp = 'linear') =>
      commit(
        'Volume envelope',
        (s) => ({
          clips: s.clips.map((c) =>
            c.id === clipId && (c.kind === 'audio' || c.kind === 'video')
              ? { ...c, gainKeyframes: upsertKey(c.gainKeyframes, t, Math.max(0, value), interp) }
              : c,
          ),
        }),
        // Coalesced: a drag is one entry, not one per pixel.
        true,
      ),

    moveGainKey: (clipId, from, t, value) =>
      commit(
        'Move envelope point',
        (s) => ({
          clips: s.clips.map((c) =>
            c.id === clipId && (c.kind === 'audio' || c.kind === 'video')
              ? { ...c, gainKeyframes: moveKey(c.gainKeyframes, from, t, Math.max(0, value)) }
              : c,
          ),
        }),
        true,
      ),

    removeGainKey: (clipId, t) =>
      commit('Remove envelope point', (s) => ({
        clips: s.clips.map((c) =>
          c.id === clipId && (c.kind === 'audio' || c.kind === 'video')
            ? { ...c, gainKeyframes: removeKeyAt(c.gainKeyframes, t) }
            : c,
        ),
      })),

    clearGainEnvelope: (clipId) =>
      commit('Clear envelope', (s) => ({
        clips: s.clips.map((c) =>
          c.id === clipId && (c.kind === 'audio' || c.kind === 'video')
            ? { ...c, gainKeyframes: undefined }
            : c,
        ),
      })),

    addAudioEffect: (clipId, type) =>
      commit('Add audio effect', (s) => ({
        clips: s.clips.map((c) => {
          if (c.id !== clipId || (c.kind !== 'audio' && c.kind !== 'video')) return c;
          const effect: AudioEffect = {
            id: uid('afx'),
            type,
            enabled: true,
            params: defaultAudioParams(type),
          };
          return { ...c, audioEffects: [...(c.audioEffects ?? []), effect] };
        }),
      })),

    removeAudioEffect: (clipId, effectId) =>
      commit('Remove audio effect', (s) => ({
        clips: s.clips.map((c) =>
          c.id === clipId && (c.kind === 'audio' || c.kind === 'video')
            ? { ...c, audioEffects: (c.audioEffects ?? []).filter((e) => e.id !== effectId) }
            : c,
        ),
      })),

    toggleAudioEffect: (clipId, effectId) =>
      commit('Toggle audio effect', (s) => ({
        clips: s.clips.map((c) =>
          c.id === clipId && (c.kind === 'audio' || c.kind === 'video')
            ? {
                ...c,
                audioEffects: (c.audioEffects ?? []).map((e) =>
                  e.id === effectId ? { ...e, enabled: !e.enabled } : e,
                ),
              }
            : c,
        ),
      })),

    setAudioEffectParam: (clipId, effectId, key, value) =>
      commit(
        'Adjust audio effect',
        (s) => ({
          clips: s.clips.map((c) =>
            c.id === clipId && (c.kind === 'audio' || c.kind === 'video')
              ? {
                  ...c,
                  audioEffects: (c.audioEffects ?? []).map((e) =>
                    e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e,
                  ),
                }
              : c,
          ),
        }),
        true,
      ),

    /**
     * Normalize, and match loudness, are the same operation: measure, then set a gain.
     *
     * A gain, never new samples. Nothing is re-encoded, the whole thing is one history entry,
     * and the measurement is cached on the clip against the trim it was taken from — an
     * excerpt's loudness stops being true the moment the excerpt changes.
     */
    normalizeSelected: async (targetLufs) => {
      const state = get();
      const targets = state.clips.filter(
        (c) =>
          state.selectedClipIds.includes(c.id) &&
          (c.kind === 'audio' || (c.kind === 'video' && c.hasAudio && c.audioEnabled)),
      );
      if (targets.length === 0 || state.loudnessJob) return;

      const results: { id: string; gain: number; lufs: number; peakDb: number }[] = [];
      const silent: string[] = [];
      /** Clips whose target needed more lift than 12 dB, which is as far as this will go. */
      const short: string[] = [];

      for (const clip of targets) {
        if (!('assetId' in clip)) continue;
        set({ loudnessJob: clip.id });
        const asset = get().mediaLibrary[clip.assetId];
        const measured = asset
          ? await measureClipLoudness(asset, clip.sourceTrimIn, clip.sourceTrimOut)
          : null;
        if (!measured) {
          silent.push(asset?.name ?? clip.id);
          continue;
        }
        const wanted = gainForTarget(measured.lufs, targetLufs);
        const gain = clampNormalizeGain(wanted);
        // Said out loud rather than silently applied: a take 20 dB down cannot be lifted onto
        // the target without bringing its own noise floor with it, and a clip that landed
        // short of the number on the button looks like the button not working.
        if (Math.abs(20 * Math.log10(wanted / gain)) > 0.1) short.push(asset?.name ?? clip.id);
        results.push({ id: clip.id, gain, lufs: measured.lufs, peakDb: measured.peakDb });
      }
      set({ loudnessJob: null });

      if (results.length > 0) {
        const byId = new Map(results.map((r) => [r.id, r]));
        commit(
          results.length === 1 ? 'Normalize' : `Match loudness (${results.length} clips)`,
          (s) => ({
            clips: s.clips.map((c) => {
              const hit = byId.get(c.id);
              if (!hit || (c.kind !== 'audio' && c.kind !== 'video')) return c;
              return {
                ...c,
                gain: hit.gain,
                loudness: {
                  lufs: hit.lufs,
                  peakDb: hit.peakDb,
                  trimIn: c.sourceTrimIn,
                  trimOut: c.sourceTrimOut,
                },
              };
            }),
          }),
        );
      }

      const notices: string[] = [];
      if (results.length > 0) {
        const moved = results.length === 1 ? 'Normalized' : `Matched ${results.length} clips`;
        notices.push(`${moved} to ${targetLufs} LUFS.`);
      }
      if (short.length > 0) {
        notices.push(
          `${short.join(', ')} needed more than +12 dB and stopped there — lifting further ` +
            'brings the noise floor up with the signal.',
        );
      }
      if (silent.length > 0) {
        notices.push(`Nothing measurable in ${silent.join(', ')} — silence has no loudness.`);
      }
      if (notices.length > 0) set({ libraryNotice: notices.join(' ') });
    },

    // ------------------------------------------------------ effects and fades

    addEffect: (target, type) =>
      commit(`Add ${EFFECTS[type].label}`, (s) =>
        applyEffects(s, target, (effects) => [
          ...effects,
          { id: uid('fx'), type, enabled: true, params: defaultParams(type) },
        ]),
      ),

    addCustomEffect: (target, source) => {
      const seed: EffectInstance = {
        id: uid('fx'),
        type: 'custom',
        enabled: true,
        params: {},
        shader: source,
      };
      const effect: EffectInstance = { ...seed, params: defaultParamsFor(seed) };
      commit(`Add ${customDescriptor(source).label}`, (s) =>
        applyEffects(s, target, (effects) => [...effects, effect]),
      );
    },

    setEffectShader: (target, effectId, source) => {
      // Editing the source is the user saying "try again" — a shader that took the GPU
      // down last time deserves another run now that it is different.
      clearShaderFailure(effectId);
      commit('Edit shader', (s) =>
        applyEffects(s, target, (effects) =>
          effects.map((e) => {
            if (e.id !== effectId) return e;
            const next: EffectInstance = { ...e, shader: source };
            const names = new Set((descriptorFor(next)?.params ?? []).map((p) => p.name));
            // A parameter that survived the edit keeps its value and its animation; one
            // the new source no longer declares takes its keyframes with it, rather than
            // lingering invisibly in the document.
            const params = { ...regionOnly(e.params), ...defaultParamsFor(next) };
            for (const [name, value] of Object.entries(e.params)) {
              if (names.has(name)) params[name] = value;
            }
            const kept = Object.entries(e.keyframes ?? {}).filter(
              ([name]) => names.has(name) || name.startsWith('region.'),
            );
            return {
              ...next,
              params,
              keyframes: kept.length > 0 ? Object.fromEntries(kept) : undefined,
            };
          }),
        ),
      );
    },

    removeEffect: (target, effectId) =>
      commit('Remove effect', (s) =>
        applyEffects(s, target, (effects) => effects.filter((e) => e.id !== effectId)),
      ),

    /** Chain order is render order, so this is a real edit, not a display preference. */
    moveEffect: (target, effectId, direction) =>
      commit('Reorder effects', (s) =>
        applyEffects(s, target, (effects) => {
          const index = effects.findIndex((e) => e.id === effectId);
          const swap = index + direction;
          if (index < 0 || swap < 0 || swap >= effects.length) return effects;
          const next = [...effects];
          [next[index], next[swap]] = [next[swap], next[index]];
          return next;
        }),
      ),

    toggleEffect: (target, effectId) => {
      // Switching a custom shader back on clears the strike against it: if the GPU
      // dropped the context last time, the user has had the chance to lower its cost.
      clearShaderFailure(effectId);
      commit('Toggle effect', (s) =>
        applyEffects(s, target, (effects) =>
          effects.map((e) => (e.id === effectId ? { ...e, enabled: !e.enabled } : e)),
        ),
      );
    },

    /**
     * Writes a keyframe at the playhead when the parameter is armed, otherwise sets the
     * scalar. Same control, two meanings — which is how every editor does it.
     */
    setEffectParam: (target, effectId, param, value) => {
      const state = get();
      const ref = toTarget(target);
      if (ref.kind === 'track') {
        // Tracks have no time base, so a track effect's parameters are always scalars.
        commit(
          'Adjust effect',
          (s) =>
            applyEffects(s, target, (effects) =>
              effects.map((e) =>
                e.id === effectId ? { ...e, params: { ...e.params, [param]: value } } : e,
              ),
            ),
          true,
        );
        return;
      }
      const clipId = ref.id;
      const clip = state.clips.find((c) => c.id === clipId);
      const armed = clip ? (channelKeys(clip, { effectId, param })?.length ?? 0) > 0 : false;

      if (armed) {
        const at = quantizeToFrame(
          Math.max(0, state.playhead - (clip?.timelineStart ?? 0)),
          state.settings.fps,
        );
        commit(
          'Set keyframe',
          (s) => ({
            clips: s.clips.map((c) =>
              c.id === clipId
                ? withChannel(c, { effectId, param }, (keys) => upsertKey(keys, at, value))
                : c,
            ),
          }),
          true,
        );
        return;
      }

      commit(
        'Adjust effect',
        (s) => ({
          clips: mapEffects(s.clips, clipId, (effects) =>
            effects.map((e) =>
              e.id === effectId ? { ...e, params: { ...e.params, [param]: value } } : e,
            ),
          ),
        }),
        true,
      );
    },

    setTransitionType: (clipId, type) =>
      commit('Change transition', (s) => ({
        clips: s.clips.map((c) => (c.id === clipId ? { ...c, transitionIn: type } : c)),
      })),

    setTextStyle: (clipId, style) =>
      commit(
        'Restyle text',
        (s) => {
          const clip = s.clips.find((c) => c.id === clipId);
          const objectId = clip?.kind === 'text' ? clip.textObjectId : undefined;
          return {
            clips: s.clips.map((c) =>
              c.kind === 'text' && (c.id === clipId || (objectId && c.textObjectId === objectId))
                ? { ...c, style: { ...(c.style ?? {}), ...style } }
                : c,
            ),
            // A clip made from a library object edits the object, so every use of it follows.
            textLibrary: objectId
              ? s.textLibrary.map((o) =>
                  o.id === objectId ? { ...o, style: { ...(o.style ?? {}), ...style } } : o,
                )
              : s.textLibrary,
          } as Partial<EditorState>;
        },
        true,
      ),

    setTextTemplate: (clipId, template) =>
      commit('Change template', (s) => {
        const clip = s.clips.find((c) => c.id === clipId);
        const objectId = clip?.kind === 'text' ? clip.textObjectId : undefined;
        return {
          clips: s.clips.map((c) =>
            c.kind === 'text' && (c.id === clipId || (objectId && c.textObjectId === objectId))
              ? // The overrides go with the old template: they were expressed against it, and
                // carrying them onto a new one produces a look neither template describes.
                { ...c, template, style: undefined }
              : c,
          ),
          textLibrary: objectId
            ? s.textLibrary.map((o) => (o.id === objectId ? { ...o, template, style: undefined } : o))
            : s.textLibrary,
        } as Partial<EditorState>;
      }),

    addTextObject: (text, template) => {
      const id = uid('text');
      commit('Add text to library', (s) => ({
        textLibrary: [
          ...s.textLibrary,
          { id, name: text.split('\n')[0].slice(0, 40) || 'Text', text, template, addedAt: Date.now() },
        ],
      }));
      return id;
    },

    updateTextObject: (id, patch) =>
      commit(
        'Edit text',
        (s) => ({
          textLibrary: s.textLibrary.map((o) => (o.id === id ? { ...o, ...patch } : o)),
          // Every clip showing this object follows, which is what "the same object" means.
          clips: s.clips.map((c) =>
            c.kind === 'text' && c.textObjectId === id
              ? {
                  ...c,
                  text: patch.text ?? c.text,
                  template: patch.template ?? c.template,
                  style: patch.style ?? c.style,
                }
              : c,
          ),
        }),
        true,
      ),

    duplicateTextObject: (id) =>
      commit('Duplicate text', (s) => {
        const source = s.textLibrary.find((o) => o.id === id);
        if (!source) return {};
        return {
          textLibrary: [
            ...s.textLibrary,
            { ...source, id: uid('text'), name: `${source.name} copy`, addedAt: Date.now() },
          ],
        };
      }),

    unlinkTextClip: (clipId) =>
      commit('Unlink text', (s) => ({
        clips: s.clips.map((c) =>
          c.id === clipId && c.kind === 'text' ? { ...c, textObjectId: undefined } : c,
        ),
      })),

    removeTextObject: (id) =>
      commit('Remove text', (s) => ({
        textLibrary: s.textLibrary.filter((o) => o.id !== id),
        // The clips keep their words. Removing the object breaks the link, it does not
        // delete an edit somebody made.
        clips: s.clips.map((c) =>
          c.kind === 'text' && c.textObjectId === id ? { ...c, textObjectId: undefined } : c,
        ),
      })),

    addTextObjectToTimeline: (id) => {
      const object = get().textLibrary.find((o) => o.id === id);
      if (!object) return;
      commit(`Add ${object.name}`, (s) => {
        const lane = findLaneForPlacement(
          s.tracks, s.clips, 'video', s.playhead, TEXT_CLIP_DURATION, s.settings.fps, true,
        );
        const clip: Clip = {
          id: uid('clip'),
          trackId: lane.trackId,
          kind: 'text',
          text: object.text,
          template: object.template,
          style: object.style,
          textObjectId: object.id,
          timelineStart: lane.start,
          sourceTrimIn: 0,
          sourceTrimOut: TEXT_CLIP_DURATION,
          textFrame: DEFAULT_FULL_FRAME,
        };
        return {
          tracks: lane.tracks,
          clips: [...s.clips, clip],
          selectedClipIds: [clip.id],
        } as Partial<EditorState>;
      });
    },

    addAnnotationClip: () =>
      commit('Add annotation', (s) => {
        // Top-down like text and adjustments: an annotation marks what is below it.
        const lane = findLaneForPlacement(
          s.tracks, s.clips, 'video', s.playhead, TEXT_CLIP_DURATION, s.settings.fps, true,
        );
        const clip: Clip = {
          id: uid('clip'),
          trackId: lane.trackId,
          kind: 'annotation',
          shapes: [],
          timelineStart: lane.start,
          sourceTrimIn: 0,
          sourceTrimOut: TEXT_CLIP_DURATION,
        };
        return {
          tracks: lane.tracks,
          clips: [...s.clips, clip],
          selectedClipIds: [clip.id],
        } as Partial<EditorState>;
      }),

    addAnnotationShape: (clipId, shape) =>
      commit('Draw', (s) => ({
        clips: s.clips.map((c) =>
          c.id === clipId && c.kind === 'annotation' ? { ...c, shapes: [...c.shapes, shape] } : c,
        ),
      })),

    updateAnnotationShape: (clipId, shapeId, patch) =>
      commit(
        'Adjust annotation',
        (s) => ({
          clips: s.clips.map((c) =>
            c.id === clipId && c.kind === 'annotation'
              ? { ...c, shapes: c.shapes.map((sh) => (sh.id === shapeId ? { ...sh, ...patch } : sh)) }
              : c,
          ),
        }),
        true,
      ),

    /**
     * Put this mark *here* at the playhead.
     *
     * The first key on a static mark captures where it already is at that moment, so arming
     * and dragging leaves the clip looking the same before the key and moving after it,
     * rather than snapping the whole clip to the new pose.
     */
    setAnnotationShapeKey: (clipId, shapeId, points) =>
      commit(
        'Move mark',
        (s) => {
          const clip = s.clips.find((c) => c.id === clipId);
          if (!clip || clip.kind !== 'annotation') return {};
          const at = quantizeToFrame(Math.max(0, s.playhead - clip.timelineStart), s.settings.fps);
          return {
            clips: s.clips.map((c) =>
              c.id === clipId && c.kind === 'annotation'
                ? {
                    ...c,
                    shapes: c.shapes.map((sh) =>
                      sh.id === shapeId
                        ? { ...sh, pointKeys: upsertShapeKey(sh.pointKeys, at, points) }
                        : sh,
                    ),
                  }
                : c,
            ),
          };
        },
        true,
      ),

    /**
     * Drop one pose.
     *
     * Removing the last one does not just delete the list: a mark with no poses falls back to
     * `points`, which is wherever it was first drawn, so the mark would jump somewhere else at
     * the moment you removed its last pose. That pose is baked into `points` instead, which is
     * the same bargain `clearAnnotationShapeKeys` makes.
     */
    removeAnnotationShapeKey: (clipId, shapeId, t) =>
      commit('Remove pose', (s) => ({
        clips: s.clips.map((c) => {
          if (c.id !== clipId || c.kind !== 'annotation') return c;
          return {
            ...c,
            shapes: c.shapes.map((sh) => {
              if (sh.id !== shapeId) return sh;
              const kept = removeShapeKeyAt(sh.pointKeys, t);
              if (kept && kept.length > 1) return { ...sh, pointKeys: kept };
              const survivor = kept?.[0] ?? sortedKeys(sh.pointKeys)[0];
              return {
                ...sh,
                points: survivor ? survivor.points.map((p) => ({ ...p })) : sh.points,
                pointKeys: undefined,
              };
            }),
          };
        }),
      })),

    moveAnnotationShapeKey: (clipId, shapeId, fromT, toT) =>
      commit(
        'Move pose',
        (s) => {
          const clip = s.clips.find((c) => c.id === clipId);
          if (!clip || clip.kind !== 'annotation') return {};
          const at = quantizeToFrame(
            Math.min(clipDuration(clip), Math.max(0, toT)),
            s.settings.fps,
          );
          return {
            clips: s.clips.map((c) =>
              c.id === clipId && c.kind === 'annotation'
                ? {
                    ...c,
                    shapes: c.shapes.map((sh) => {
                      if (sh.id !== shapeId) return sh;
                      const moving = sortedKeys(sh.pointKeys).find(
                        (key) => Math.abs(key.t - fromT) < 1e-4,
                      );
                      if (!moving) return sh;
                      // Remove then upsert, so landing on another pose replaces it rather
                      // than leaving two at one moment.
                      return {
                        ...sh,
                        pointKeys: upsertShapeKey(
                          removeShapeKeyAt(sh.pointKeys, fromT),
                          at,
                          moving.points,
                        ),
                      };
                    }),
                  }
                : c,
            ),
          };
        },
        true,
      ),

    /** Stop a mark moving: the pose at the playhead becomes its only one. */
    clearAnnotationShapeKeys: (clipId, shapeId) =>
      commit('Stop the mark moving', (s) => {
        const clip = s.clips.find((c) => c.id === clipId);
        if (!clip || clip.kind !== 'annotation') return {};
        return {
          clips: s.clips.map((c) =>
            c.id === clipId && c.kind === 'annotation'
              ? {
                  ...c,
                  shapes: c.shapes.map((sh) =>
                    sh.id === shapeId
                      ? {
                          ...sh,
                          points: shapePointsAt(sh, Math.max(0, s.playhead - clip.timelineStart)),
                          pointKeys: undefined,
                        }
                      : sh,
                  ),
                }
              : c,
          ),
        };
      }),

    removeAnnotationShape: (clipId, shapeId) =>
      commit('Remove shape', (s) => ({
        clips: s.clips.map((c) =>
          c.id === clipId && c.kind === 'annotation'
            ? { ...c, shapes: c.shapes.filter((sh) => sh.id !== shapeId) }
            : c,
        ),
        // Nothing may stay selected that no longer exists: the overlay would draw handles
        // for it and the Inspector would offer to restyle it.
        ...(s.selectedShapeId === shapeId ? { selectedShapeId: null } : {}),
      })),

    addAdjustmentClip: () =>
      commit('Add adjustment', (s) => {
        // Placed top-down like text: an adjustment grades what is *below* it, so the
        // topmost free lane is the useful default.
        const lane = findLaneForPlacement(
          s.tracks,
          s.clips,
          'video',
          s.playhead,
          ADJUSTMENT_CLIP_DURATION,
          s.settings.fps,
          true,
        );
        const clip: Clip = {
          id: uid('clip'),
          trackId: lane.trackId,
          kind: 'adjustment',
          timelineStart: lane.start,
          sourceTrimIn: 0,
          sourceTrimOut: ADJUSTMENT_CLIP_DURATION,
          effects: [{ id: uid('fx'), type: 'eq', enabled: true, params: defaultParams('eq') }],
        };
        return {
          tracks: lane.tracks,
          clips: [...s.clips, clip],
          selectedClipIds: [clip.id],
        } as Partial<EditorState>;
      }),

    resetEffect: (target, effectId) =>
      commit('Reset effect', (s) =>
        applyEffects(s, target, (effects) =>
          effects.map((e) =>
            e.id === effectId
              ? { ...e, params: { ...regionOnly(e.params), ...defaultParamsFor(e) } }
              : e,
          ),
        ),
      ),

    setClipFade: (clipId, edge, seconds) =>
      commit(
        edge === 'in' ? 'Fade in' : 'Fade out',
        (s) => ({
          clips: s.clips.map((c) => {
            if (c.id !== clipId) return c;
            const value = quantizeToFrame(clampFade(c, edge, seconds), s.settings.fps);
            return edge === 'in' ? { ...c, fadeIn: value } : { ...c, fadeOut: value };
          }),
        }),
        true,
      ),

    setRegionMode: (target, effectId, mode) =>
      commit(mode > 0 ? 'Add mask region' : 'Remove mask region', (s) =>
        applyEffects(s, target, (effects) =>
          effects.map((e) => {
            if (e.id !== effectId) return e;
            if (mode <= 0) {
              const { [REGION_MODE]: _mode, ...rest } = e.params;
              return { ...e, params: rest };
            }
            // Turning a region on seeds a visible default box rather than a zero-size
            // one the user would have to hunt for.
            return { ...e, params: { ...DEFAULT_REGION, ...e.params, [REGION_MODE]: mode } };
          }),
        ),
      ),

    setRegionRect: (targetRef, effectId, rect) => {
      const state = get();
      const target = toTarget(targetRef);
      const clipId = target.id;
      const clip = target.kind === 'clip' ? state.clips.find((c) => c.id === clipId) : undefined;
      const armed =
        !!clip &&
        REGION_CHANNELS.some(
          (ch) => (channelKeys(clip, { effectId, param: ch })?.length ?? 0) > 0,
        );
      const values: Record<string, number> = {
        'region.x': rect.x,
        'region.y': rect.y,
        'region.w': rect.w,
        'region.h': rect.h,
      };

      if (armed && clip) {
        // Scrub, drag, scrub, drag — the workflow the moving-licence-plate case needs.
        const at = quantizeToFrame(
          Math.max(0, state.playhead - clip.timelineStart),
          state.settings.fps,
        );
        commit(
          'Set region keyframe',
          (s) => ({
            clips: s.clips.map((c) => {
              if (c.id !== clipId) return c;
              let next = c;
              for (const channel of REGION_CHANNELS) {
                next = withChannel(next, { effectId, param: channel }, (keys) =>
                  upsertKey(keys, at, values[channel]),
                );
              }
              return next;
            }),
          }),
          true,
        );
        return;
      }

      commit(
        'Move mask region',
        (s) =>
          applyEffects(s, targetRef, (effects) =>
            effects.map((e) =>
              e.id === effectId ? { ...e, params: { ...e.params, ...values } } : e,
            ),
          ),
        true,
      );
    },

    addRegionEffect: (target, type) =>
      commit(`Add ${EFFECTS[type].label} region`, (s) =>
        applyEffects(s, target, (effects) => [
          ...effects,
          {
            id: uid('fx'),
            type,
            enabled: true,
            params: { ...defaultParams(type), ...DEFAULT_REGION },
          },
        ]),
      ),

    // -------------------------------------------------------------- keyframes

    isChannelArmed: (clipId, ref) => {
      const clip = get().clips.find((c) => c.id === clipId);
      return clip ? (channelKeys(clip, ref)?.length ?? 0) > 0 : false;
    },

    /**
     * Arming drops a key at the playhead holding the current value, so the parameter
     * keeps its look until a second key is made. Disarming discards the animation and
     * freezes the value the playhead is currently showing.
     */
    toggleChannelArmed: (clipId, ref) =>
      commit('Toggle keyframing', (s) => {
        const clip = s.clips.find((c) => c.id === clipId);
        if (!clip) return {};
        const rel = quantizeToFrame(Math.max(0, s.playhead - clip.timelineStart), s.settings.fps);
        const keys = channelKeys(clip, ref);

        if (keys && keys.length > 0) {
          const frozen = evaluateChannel(keys, rel, 0);
          const cleared = withChannel(clip, ref, () => undefined);
          return {
            clips: s.clips.map((c) => (c.id === clipId ? freezeChannel(cleared, ref, frozen) : c)),
          };
        }

        const current = currentChannelValue(clip, ref);
        if (current === null) return {};
        return {
          clips: s.clips.map((c) =>
            c.id === clipId ? withChannel(c, ref, (k) => upsertKey(k, rel, current)) : c,
          ),
        };
      }),

    moveKeyframe: (clipId, ref, from, to) =>
      commit('Move keyframe', (s) => {
        const clip = s.clips.find((c) => c.id === clipId);
        if (!clip) return {};
        // Keys snap to frames and stay inside the clip, like every other timeline edit.
        const target = Math.min(
          clipDuration(clip),
          Math.max(0, quantizeToFrame(to, s.settings.fps)),
        );
        return {
          clips: s.clips.map((c) =>
            c.id === clipId ? withChannel(c, ref, (k) => moveKey(k, from, target)) : c,
          ),
        };
      }),

    removeKeyframe: (clipId, ref, t) =>
      commit('Delete keyframe', (s) => ({
        clips: s.clips.map((c) => {
          if (c.id !== clipId) return c;
          return withChannel(c, ref, (keys) => {
            const next = removeKeyAt(keys, t);
            return next.length > 0 ? next : undefined;
          });
        }),
      })),

    setKeyframeInterp: (clipId, ref, t, interp) =>
      commit('Change interpolation', (s) => ({
        clips: s.clips.map((c) =>
          c.id === clipId ? withChannel(c, ref, (k) => setKeyInterp(k, t, interp)) : c,
        ),
      })),

    jumpToKeyframe: (direction) => {
      const state = get();
      const clip = state.clips.find((c) => state.selectedClipIds.includes(c.id));
      if (!clip) return;
      const times = channelTimes([
        clip.transformKeyframes,
        ...(clip.effects ?? []).map((e) => e.keyframes),
      ]).map((t) => t + clip.timelineStart);
      if (times.length === 0) return;

      const epsilon = 1 / (state.settings.fps * 4);
      const next =
        direction > 0
          ? times.find((t) => t > state.playhead + epsilon)
          : [...times].reverse().find((t) => t < state.playhead - epsilon);
      if (next !== undefined) get().setPlayhead(next);
    },

    /** Splits a video clip's audio onto an audio lane; the two are independent afterwards. */
    detachAudio: (id) =>
      commit('Detach audio', (s) => {
        const clip = s.clips.find((c) => c.id === id);
        if (!clip || clip.kind !== 'video' || !clip.hasAudio || !clip.audioEnabled) return {};

        const lane = findLaneForPlacement(
          s.tracks,
          s.clips,
          'audio',
          clip.timelineStart,
          clipDuration(clip),
          s.settings.fps,
        );
        const audioClip: AudioClip = {
          id: uid('clip'),
          trackId: lane.trackId,
          timelineStart: clip.timelineStart,
          sourceTrimIn: clip.sourceTrimIn,
          sourceTrimOut: clip.sourceTrimOut,
          kind: 'audio',
          assetId: clip.assetId,
          gain: clip.gain,
          // Retiming carries across, or the two halves are different lengths the moment
          // either is retimed — the same desync the ripple scope exists to prevent.
          ...(clip.speed !== undefined ? { speed: clip.speed } : {}),
          ...(clip.pitchFollowsSpeed !== undefined
            ? { pitchFollowsSpeed: clip.pitchFollowsSpeed }
            : {}),
        };
        return {
          tracks: lane.tracks,
          clips: s.clips
            .map((c) => (c.id === id && c.kind === 'video' ? { ...c, audioEnabled: false } : c))
            .concat(audioClip),
          selectedClipIds: [audioClip.id],
        } as Partial<EditorState>;
      }),

    /**
     * Atomic, validated placement. Rejects overlaps, locked tracks and
     * kind mismatches so a drag can never corrupt the timeline.
     */
    moveClipsTo: (moves, commitToHistory, allowTransitions = true) => {
      const state = get();
      if (moves.length === 0) return false;

      const movingIds = new Set(moves.map((m) => m.id));
      const byId = new Map(state.clips.map((c) => [c.id, c]));
      const trackById = new Map(state.tracks.map((t) => [t.id, t]));

      for (const move of moves) {
        const clip = byId.get(move.id);
        const track = trackById.get(move.trackId);
        if (!clip || !track || track.locked) return false;
        if (!clipAcceptsTrack(clip, track)) return false;
        if (move.timelineStart < 0) return false;

        const sourceTrack = trackById.get(clip.trackId);
        if (sourceTrack?.locked) return false;

        const duration = clipDuration(clip);
        const end = move.timelineStart + duration;
        const proposed: Clip = { ...clip, trackId: move.trackId, timelineStart: move.timelineStart };

        // Overlap is still refused, with one exception: a *single* neighbour overlapping
        // by less than either clip's length. That overlap is the cross-dissolve — the
        // transition has no separate existence, so this is the only rule it needs.
        let overlaps = 0;
        for (const other of state.clips) {
          if (movingIds.has(other.id)) continue;
          if (other.trackId !== move.trackId) continue;
          if (!rangesOverlap(move.timelineStart, end, other.timelineStart, clipEnd(other))) {
            continue;
          }
          if (!allowTransitions || !overlapIsTransition(proposed, other)) return false;
          overlaps += 1;
          if (overlaps > 1) return false;
        }
        for (const peer of moves) {
          if (peer.id === move.id || peer.trackId !== move.trackId) continue;
          const peerClip = byId.get(peer.id);
          if (!peerClip) continue;
          if (
            rangesOverlap(
              move.timelineStart,
              end,
              peer.timelineStart,
              peer.timelineStart + clipDuration(peerClip),
            )
          ) {
            return false;
          }
        }
      }

      const moveById = new Map(moves.map((m) => [m.id, m]));
      const apply = (s: Store): Partial<EditorState> => ({
        clips: s.clips.map((c) => {
          const move = moveById.get(c.id);
          if (!move) return c;
          return {
            ...c,
            trackId: move.trackId,
            timelineStart: quantizeToFrame(move.timelineStart, s.settings.fps),
          };
        }),
      });

      if (commitToHistory) commit('Move clip', apply);
      else set(apply(state) as Partial<Store>);
      return true;
    },

    /** Absolute trim: `timelineTime` is where the edge should land. */
    trimClipTo: (id, edge, timelineTime, mode = 'trim') => {
      const state = get();
      const clip = state.clips.find((c) => c.id === id);
      if (!clip) return;
      const track = state.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return;

      const fps = state.settings.fps;
      const speed = clipSpeedOf(clip);
      const maxSource = assetDurationFor(clip, state.mediaLibrary);
      const neighbours = state.clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id);
      const ripple = state.rippleEnabled;
      const oldEnd = clipEnd(clip);

      let next: Clip;
      if (mode === 'rate' && canRetime(clip)) {
        /*
         * A rate trim keeps every frame and changes how long they take. The source range is
         * untouched, the edge lands where the pointer let go, and the speed is whatever makes
         * those two true — `retimeToSpeed` then nudges the out point so the duration is a
         * whole number of frames, exactly as the Inspector's slider does.
         */
        const wanted =
          edge === 'right'
            ? quantizeToFrame(Math.max(MIN_CLIP_DURATION, timelineTime - clip.timelineStart), fps)
            : quantizeToFrame(Math.max(MIN_CLIP_DURATION, oldEnd - timelineTime), fps);
        const retimed = retimeToSpeed(clip, speedForDuration(clip, wanted), fps);
        const retimedStart =
          edge === 'left' ? Math.max(0, oldEnd - retimed.duration) : clip.timelineStart;
        next = {
          ...clip,
          speed: retimed.speed,
          sourceTrimOut: retimed.sourceTrimOut,
          timelineStart: retimedStart,
        };
      } else if (edge === 'left') {
        // A ripple trim is bounded by the source alone: the neighbour it would have run into
        // is about to move out of the way.
        const leftBound = ripple
          ? 0
          : neighbours
              .filter((c) => clipEnd(c) <= clip.timelineStart + 1e-6)
              .reduce((max, c) => Math.max(max, clipEnd(c)), 0);
        // Can't pull in earlier than the source has material for. A second of timeline is
        // `speed` seconds of source, so a retimed clip reaches back further in timeline terms
        // than the material it has left.
        const earliest = Math.max(leftBound, clip.timelineStart - clip.sourceTrimIn / speed);
        const latest = oldEnd - MIN_CLIP_DURATION;
        const start = quantizeToFrame(Math.min(latest, Math.max(earliest, timelineTime)), fps);
        const delta = start - clip.timelineStart;
        // The *timeline* edge is what lands on a frame; the source point is derived from it.
        // Quantizing the derived value too would be a no-op at 1× and would knock a retimed
        // clip's duration off the frame grid at any other speed.
        const sourceTrimIn = clip.sourceTrimIn + delta * speed;
        next = ripple
          ? {
              // The edit point stays put and the material scrolls under it — the clip's start
              // never moves under ripple, only its length, and the rest of the track follows.
              ...clip,
              sourceTrimIn,
            }
          : {
              ...clip,
              timelineStart: start,
              sourceTrimIn,
            };
      } else {
        const rightBound = ripple
          ? Infinity
          : neighbours
              .filter((c) => c.timelineStart >= oldEnd - 1e-6)
              .reduce((min, c) => Math.min(min, c.timelineStart), Infinity);
        const sourceLimit =
          maxSource === Infinity
            ? Infinity
            : clip.timelineStart + (maxSource - clip.sourceTrimIn) / speed;
        const latest = Math.min(rightBound, sourceLimit);
        const earliest = clip.timelineStart + MIN_CLIP_DURATION;
        const end = quantizeToFrame(Math.min(latest, Math.max(earliest, timelineTime)), fps);
        next = {
          ...clip,
          sourceTrimOut: clip.sourceTrimIn + (end - clip.timelineStart) * speed,
        };
      }

      const delta = ripple ? clipEnd(next) - oldEnd : 0;
      const shifts = ripple
        ? rippleShift(
            state.clips,
            oldEnd,
            delta,
            state.rippleScope === 'all' ? null : clip.trackId,
            new Set([clip.id]),
          )
        : [];

      commit(mode === 'rate' ? 'Rate trim' : ripple ? 'Ripple trim' : 'Trim clip', (s) => ({
        clips: applyShifts(
          s.clips.map((c) => (c.id === id ? next : c)),
          shifts,
        ),
      }));
    },

    /**
     * Retime a clip.
     *
     * The source range is what stays fixed: changing the speed changes how long the clip
     * occupies the timeline, and `retimeToSpeed` moves the out point so that length lands on
     * a frame. Growing a clip follows the ripple mode, which is the same rule trimming and
     * deleting already follow — with ripple off it grows into the free space and stops at its
     * neighbour rather than overlapping it, because an overlap *is* a transition here and
     * slowing a clip down must not silently cross-dissolve it into whatever comes next.
     */
    setClipSpeed: (id, speed) => {
      const state = get();
      const clip = state.clips.find((c) => c.id === id);
      if (!clip || !canRetime(clip)) return;
      const track = state.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return;

      const ripple = state.rippleEnabled;
      let wanted = clampSpeed(speed);
      let clamped: number | null = null;
      if (!ripple) {
        const slowest = slowestSpeedThatFits(state.clips, clip);
        if (wanted < slowest) {
          clamped = slowest;
          wanted = slowest;
        }
      }

      const retimed = retimeToSpeed(clip, wanted, state.settings.fps);
      const next: Clip = { ...clip, speed: retimed.speed, sourceTrimOut: retimed.sourceTrimOut };
      const oldEnd = clipEnd(clip);
      const delta = rippleDelta(clip, next);
      const shifts =
        ripple && Math.abs(delta) > 1e-9
          ? rippleShift(
              state.clips,
              oldEnd,
              delta,
              state.rippleScope === 'all' ? null : clip.trackId,
              new Set([clip.id]),
            )
          : [];

      commit(
        'Change speed',
        (s) => ({
          clips: applyShifts(
            s.clips.map((c) => (c.id === id ? next : c)),
            shifts,
          ),
          ...(clamped !== null
            ? {
                libraryNotice: `Slowed to ${formatSpeed(clamped)} — the next clip is in the way. Turn on Ripple to make room.`,
              }
            : {}),
        }),
        // Coalesced: dragging the slider is one edit, not fifty.
        true,
      );
    },

    setClipPitchFollows: (id, follows) =>
      commit('Change pitch behaviour', (s) => ({
        clips: s.clips.map((c) =>
          c.id === id && canRetime(c) ? { ...c, pitchFollowsSpeed: follows } : c,
        ),
      })),

    nudgeSelected: (frames) => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;
      const delta = frames / state.settings.fps;
      const moves: ClipMove[] = [];
      for (const id of state.selectedClipIds) {
        const clip = state.clips.find((c) => c.id === id);
        if (!clip) continue;
        moves.push({
          id,
          trackId: clip.trackId,
          timelineStart: Math.max(0, clip.timelineStart + delta),
        });
      }
      const movingIds = new Set(moves.map((m) => m.id));
      const byId = new Map(state.clips.map((c) => [c.id, c]));
      const blocked = moves.some((move) =>
        state.clips.some((other) => {
          if (movingIds.has(other.id) || other.trackId !== move.trackId) return false;
          const clip = byId.get(move.id)!;
          return rangesOverlap(
            move.timelineStart,
            move.timelineStart + clipDuration(clip),
            other.timelineStart,
            clipEnd(other),
          );
        }),
      );
      if (blocked) return;

      const moveById = new Map(moves.map((m) => [m.id, m]));
      commit(
        'Nudge clip',
        (s) => ({
          clips: s.clips.map((c) => {
            const move = moveById.get(c.id);
            return move
              ? { ...c, timelineStart: quantizeToFrame(move.timelineStart, s.settings.fps) }
              : c;
          }),
        }),
        true,
      );
    },

    removeSelected: (ripple = get().rippleEnabled) => {
      const state = get();
      const ids = state.selectedClipIds;
      if (ids.length === 0) return;
      // `all` shifts every track by one amount at one time, which is the only scope under
      // which a video clip and the audio it was detached to stay together.
      const scopeAll = state.rippleScope === 'all';

      commit(ripple ? 'Ripple delete' : 'Delete clip', (s) => {
        const removed = s.clips.filter((c) => ids.includes(c.id));
        let clips = s.clips.filter((c) => !ids.includes(c.id));

        if (ripple) {
          const ordered = [...removed].sort((a, b) => a.timelineStart - b.timelineStart);
          for (const gone of ordered) {
            clips = applyShifts(
              clips,
              rippleShift(
                clips,
                gone.timelineStart,
                -clipDuration(gone),
                scopeAll ? null : gone.trackId,
              ),
            );
          }
        }
        return { clips, selectedClipIds: [] } as Partial<EditorState>;
      });
    },

    duplicateSelected: () => {
      const state = get();
      if (state.selectedClipIds.length === 0) return;

      commit('Duplicate clip', (s) => {
        const copies: Clip[] = [];
        let working = [...s.clips];

        for (const id of s.selectedClipIds) {
          const clip = working.find((c) => c.id === id);
          if (!clip) continue;
          const duration = clipDuration(clip);
          // Land in the first free slot after the original, on its own track.
          let start = clipEnd(clip);
          let guard = 0;
          while (trackHasOverlap(working, clip.trackId, start, duration) && guard < 500) {
            const blocker = working
              .filter((c) => c.trackId === clip.trackId && clipEnd(c) > start)
              .sort((a, b) => a.timelineStart - b.timelineStart)[0];
            if (!blocker) break;
            start = clipEnd(blocker);
            guard += 1;
          }
          const copy: Clip = {
            ...clip,
            id: uid('clip'),
            timelineStart: quantizeToFrame(start, s.settings.fps),
            // A duplicate is a copy, not another use. A text clip made from a library object
            // shares every restyle with the object's other clips, so keeping the link here
            // meant editing "the copy" changed the original too — the library's own ⧉ is
            // where "another independent one" comes from, and + is where another *use* does.
            ...(clip.kind === 'text' ? { textObjectId: undefined } : {}),
          };
          copies.push(copy);
          working = [...working, copy];
        }

        return {
          clips: working,
          selectedClipIds: copies.map((c) => c.id),
        } as Partial<EditorState>;
      });
    },

    canSplitAtPlayhead: () => {
      const { selectedClipIds, playhead, clips } = get();
      return clips.some((c) => {
        if (!selectedClipIds.includes(c.id)) return false;
        const rel = playhead - c.timelineStart;
        return rel > MIN_CLIP_DURATION && rel < clipDuration(c) - MIN_CLIP_DURATION;
      });
    },

    splitSelectedAtPlayhead: () => {
      if (!get().canSplitAtPlayhead()) return;

      commit('Split clip', (s) => {
        const nextClips: Clip[] = [];
        const selected: string[] = [];

        for (const clip of s.clips) {
          const rel = s.playhead - clip.timelineStart;
          const splittable =
            s.selectedClipIds.includes(clip.id) &&
            rel > MIN_CLIP_DURATION &&
            rel < clipDuration(clip) - MIN_CLIP_DURATION;

          if (!splittable) {
            nextClips.push(clip);
            continue;
          }

          const cut = quantizeToFrame(rel, s.settings.fps);
          // The cut is a timeline position; the source point behind it is `speed` times as
          // far in. Both halves keep the speed, so together they still play what the one did.
          const sourceCut = cut * clipSpeedOf(clip);
          // Keys are clip-relative, so the split has to divide them and rebase the
          // right-hand set. Both halves get a key at the cut holding the interpolated
          // value, so the pair renders the same curve the single clip did.
          const transformParts = splitChannelMap(clip.transformKeyframes, cut);
          const effectParts = (clip.effects ?? []).map((effect) => {
            const parts = splitChannelMap(effect.keyframes, cut);
            return {
              left: { ...effect, keyframes: parts.left },
              right: { ...effect, keyframes: parts.right },
            };
          });
          // Fades belong to their own end of the cut.
          const fadeIn = clip.fadeIn ?? 0;
          const fadeOut = clip.fadeOut ?? 0;

          const left: Clip = {
            ...clip,
            sourceTrimOut: clip.sourceTrimIn + sourceCut,
            transformKeyframes: transformParts.left,
            effects: clip.effects ? effectParts.map((p) => p.left) : undefined,
            fadeIn: Math.min(fadeIn, cut),
            fadeOut: 0,
          };
          const right: Clip = {
            ...clip,
            id: uid('clip'),
            timelineStart: clip.timelineStart + cut,
            sourceTrimIn: clip.sourceTrimIn + sourceCut,
            transformKeyframes: transformParts.right,
            effects: clip.effects ? effectParts.map((p) => p.right) : undefined,
            fadeIn: 0,
            fadeOut: Math.min(fadeOut, clipDuration(clip) - cut),
          };
          nextClips.push(left, right);
          selected.push(right.id);
        }

        return {
          clips: nextClips,
          selectedClipIds: selected.length > 0 ? selected : s.selectedClipIds,
        } as Partial<EditorState>;
      });
    },

    setTrimPreview: (clipId, sourceTime) => set({ trimPreview: { clipId, sourceTime } }),
    clearTrimPreview: () => set({ trimPreview: null }),
  };
});
