import { create } from 'zustand';
import type {
  AssetType,
  Clip,
  EditorState,
  MediaAsset,
  ProjectSettings,
  ResolutionPreset,
  TextTemplate,
  Track,
} from '../types/editor';
import { buildClipsForAsset, findLaneForPlacement, isAssetInUse } from './clipFactory';
import { inferAssetKind } from '../utils/assetKind';
import { uid } from '../utils/id';
import { probeMediaFile } from '../utils/probeMedia';
import { fetchUrlAsFile } from '../utils/urlMedia';
import { clearVideoThumbnailCache } from '../utils/videoThumbnailCache';
import { clearWaveformCache } from '../utils/waveformCache';
import { DEFAULT_FULL_FRAME, DEFAULT_OVERLAY_TRANSFORM } from '../utils/overlayTransform';
import { clampTrackVolume, DEFAULT_TRACK_VOLUME } from '../utils/trackVolume';
import { clipDuration, clipEnd, MIN_CLIP_DURATION, snapTime } from '../utils/time';

function computeDuration(clips: Clip[]): number {
  if (clips.length === 0) return 30;
  return Math.max(5, ...clips.map((c) => clipEnd(c)));
}

function defaultTracks(): Track[] {
  return [
    { id: uid('track'), kind: 'overlay', label: 'Overlay 1' },
    { id: uid('track'), kind: 'overlay', label: 'Overlay 2' },
    { id: uid('track'), kind: 'video', label: 'Video 1' },
    { id: uid('track'), kind: 'audio', label: 'Audio 1', volume: DEFAULT_TRACK_VOLUME },
    { id: uid('track'), kind: 'audio', label: 'Audio 2', volume: DEFAULT_TRACK_VOLUME },
  ];
}

const initialState: EditorState = {
  settings: { resolution: '1080p', fps: 30 },
  tracks: defaultTracks(),
  clips: [],
  mediaLibrary: {},
  libraryOrder: [],
  selectedClipId: null,
  playhead: 0,
  trimPreview: null,
  isPlaying: false,
  timelineZoom: 80,
  ffmpegStatus: 'idle',
  ffmpegError: null,
  exportProgress: null,
  libraryNotice: null,
};

interface EditorActions {
  setResolution: (resolution: ResolutionPreset) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (playing: boolean) => void;
  setTimelineZoom: (zoom: number) => void;
  selectClip: (id: string | null) => void;
  setFfmpegStatus: (status: EditorState['ffmpegStatus'], error?: string | null) => void;
  setExportProgress: (p: number | null) => void;
  importToLibrary: (files: FileList | File[], kind: AssetType) => Promise<void>;
  importFiles: (files: FileList | File[], kind: AssetType) => Promise<void>;
  importUrlsToLibrary: (urls: string[]) => Promise<void>;
  setLibraryNotice: (message: string | null) => void;
  addAssetToTimeline: (assetId: string) => void;
  removeLibraryItem: (assetId: string) => void;
  addTextClip: (text: string, template: TextTemplate) => void;
  updateTextClip: (id: string, text: string, template: TextTemplate, textFrame?: import('../types/editor').NormalizedRect) => void;
  updateImageTransform: (id: string, overlayTransform: import('../types/editor').OverlayTransform) => void;
  removeSelectedClip: () => void;
  duplicateSelectedClip: () => void;
  splitSelectedAtPlayhead: () => void;
  canSplitAtPlayhead: () => boolean;
  moveClip: (id: string, timelineStart: number) => void;
  trimClip: (id: string, edge: 'left' | 'right', timelineDelta: number) => void;
  setTrimPreview: (clipId: string, sourceTime: number) => void;
  clearTrimPreview: () => void;
  updateVideoFlags: (
    id: string,
    flags: {
      muteAudio?: boolean;
      hideVideo?: boolean;
      overlayMode?: boolean;
      overlayTransform?: import('../types/editor').OverlayTransform;
    },
  ) => void;
  getProjectDuration: () => number;
  addAudioTrack: () => void;
  addOverlayTrack: () => void;
  setTrackVolume: (trackId: string, volume: number) => void;
}

async function createAssetFromFile(file: File, kind: AssetType): Promise<MediaAsset> {
  const probe = await probeMediaFile(file, kind);
  return {
    id: uid('asset'),
    file,
    blobUrl: URL.createObjectURL(file),
    type: kind,
    name: file.name,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    hasAudio: probe.hasAudio,
  };
}

export const useEditorStore = create<EditorState & EditorActions>((set, get) => ({
  ...initialState,

  getProjectDuration: () => computeDuration(get().clips),

  addAudioTrack: () => {
    set((state) => {
      const n = state.tracks.filter((t) => t.kind === 'audio').length + 1;
      return {
        tracks: [
          ...state.tracks,
          {
            id: uid('track'),
            kind: 'audio' as const,
            label: `Audio ${n}`,
            volume: DEFAULT_TRACK_VOLUME,
          },
        ],
      };
    });
  },

  addOverlayTrack: () => {
    set((state) => {
      const n = state.tracks.filter((t) => t.kind === 'overlay').length + 1;
      return {
        tracks: [
          ...state.tracks,
          { id: uid('track'), kind: 'overlay' as const, label: `Overlay ${n}` },
        ],
      };
    });
  },

  setTrackVolume: (trackId, volume) => {
    const clamped = clampTrackVolume(volume);
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId && t.kind === 'audio' ? { ...t, volume: clamped } : t,
      ),
    }));
  },

  setResolution: (resolution) =>
    set((s) => ({ settings: { ...s.settings, resolution } as ProjectSettings })),

  setPlayhead: (t) => set({ playhead: Math.max(0, Math.min(t, get().getProjectDuration())) }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setTimelineZoom: (timelineZoom) => set({ timelineZoom: Math.max(20, Math.min(400, timelineZoom)) }),
  selectClip: (selectedClipId) => set({ selectedClipId }),
  setFfmpegStatus: (ffmpegStatus, ffmpegError = null) => set({ ffmpegStatus, ffmpegError }),
  setExportProgress: (exportProgress) => set({ exportProgress }),
  setLibraryNotice: (libraryNotice) => set({ libraryNotice }),

  importUrlsToLibrary: async (urls) => {
    if (urls.length === 0) return;

    set({ libraryNotice: `Importing ${urls.length} file(s) from URL…` });
    let imported = 0;
    const errors: string[] = [];

    for (const url of urls) {
      try {
        const file = await fetchUrlAsFile(url);
        const kind = inferAssetKind(file.name, file.type);
        const asset = await createAssetFromFile(file, kind);
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
      set({
        libraryNotice: `Imported ${imported} file(s). ${errors.length} failed (see console).`,
      });
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
        libraryOrder: [...state.libraryOrder, asset.id],
      }));
    }
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

    set((state) => {
      const placed = buildClipsForAsset(
        asset,
        assetId,
        state.tracks,
        state.clips,
        state.playhead,
      );
      return {
        tracks: placed.tracks,
        clips: [...state.clips, ...placed.clips],
        selectedClipId: placed.selectedClipId,
      };
    });
  },

  removeLibraryItem: (assetId) => {
    const asset = get().mediaLibrary[assetId];
    if (!asset) return;
    if (isAssetInUse(assetId, get().clips)) return;

    URL.revokeObjectURL(asset.blobUrl);
    clearWaveformCache(assetId);
    clearVideoThumbnailCache(assetId);
    set((state) => {
      const { [assetId]: _, ...mediaLibrary } = state.mediaLibrary;
      return {
        mediaLibrary,
        libraryOrder: state.libraryOrder.filter((id) => id !== assetId),
      };
    });
  },

  addTextClip: (text, template) => {
    set((state) => {
      const textDuration = 3;
      const lane = findLaneForPlacement(
        state.tracks,
        state.clips,
        [],
        'overlay',
        state.playhead,
        textDuration,
      );
      const clip: Clip = {
        id: uid('clip'),
        trackId: lane.trackId,
        kind: 'text',
        text,
        template,
        timelineStart: lane.start,
        sourceTrimIn: 0,
        sourceTrimOut: textDuration,
        textFrame: DEFAULT_FULL_FRAME,
      };
      return {
        tracks: lane.tracks,
        clips: [...state.clips, clip],
        selectedClipId: clip.id,
      };
    });
  },

  updateTextClip: (id, text, template, textFrame) => {
    set((state) => ({
      clips: state.clips.map((c) => {
        if (c.id !== id || c.kind !== 'text') return c;
        return {
          ...c,
          text,
          template,
          ...(textFrame !== undefined ? { textFrame } : {}),
        };
      }),
    }));
  },

  updateImageTransform: (id, overlayTransform) => {
    set((state) => ({
      clips: state.clips.map((c) =>
        c.id === id && c.kind === 'image' ? { ...c, overlayTransform } : c,
      ),
    }));
  },

  removeSelectedClip: () => {
    const id = get().selectedClipId;
    if (!id) return;
    set((state) => ({
      clips: state.clips.filter((c) => c.id !== id),
      selectedClipId: null,
    }));
  },

  duplicateSelectedClip: () => {
    const id = get().selectedClipId;
    if (!id) return;
    const clip = get().clips.find((c) => c.id === id);
    if (!clip) return;
    const copy: Clip = {
      ...clip,
      id: uid('clip'),
      timelineStart: snapTime(get().playhead + 0.1),
    };
    set((state) => ({
      clips: [...state.clips, copy],
      selectedClipId: copy.id,
    }));
  },

  canSplitAtPlayhead: () => {
    const { selectedClipId, playhead, clips } = get();
    if (!selectedClipId) return false;
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) return false;
    const rel = playhead - clip.timelineStart;
    const dur = clipDuration(clip);
    return rel > MIN_CLIP_DURATION && rel < dur - MIN_CLIP_DURATION;
  },

  splitSelectedAtPlayhead: () => {
    if (!get().canSplitAtPlayhead()) return;
    const { selectedClipId, playhead, clips } = get();
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) return;
    const rel = playhead - clip.timelineStart;

    const left: Clip = {
      ...clip,
      sourceTrimOut: clip.sourceTrimIn + rel,
    };
    const right: Clip = {
      ...clip,
      id: uid('clip'),
      timelineStart: clip.timelineStart + rel,
      sourceTrimIn: clip.sourceTrimIn + rel,
    };

    set((state) => ({
      clips: state.clips.map((c) => (c.id === clip.id ? left : c)).concat(right),
      selectedClipId: right.id,
    }));
  },

  moveClip: (id, timelineStart) => {
    set((state) => ({
      clips: state.clips.map((c) =>
        c.id === id ? { ...c, timelineStart: snapTime(Math.max(0, timelineStart)) } : c,
      ),
    }));
  },

  trimClip: (id, edge, timelineDelta) => {
    set((state) => {
      let playhead = state.playhead;
      const clips = state.clips.map((c) => {
        if (c.id !== id) return c;
        if (edge === 'left') {
          const delta = timelineDelta;
          const newTrimIn = Math.min(
            c.sourceTrimOut - MIN_CLIP_DURATION,
            Math.max(0, c.sourceTrimIn + delta),
          );
          const actual = newTrimIn - c.sourceTrimIn;
          const updated = {
            ...c,
            timelineStart: c.timelineStart + actual,
            sourceTrimIn: newTrimIn,
          };
          if (state.selectedClipId === id) {
            playhead = updated.timelineStart;
          }
          return updated;
        }
        const newTrimOut = Math.max(
          c.sourceTrimIn + MIN_CLIP_DURATION,
          Math.min(
            c.sourceTrimOut + timelineDelta,
            getMaxSourceOut(c, state.mediaLibrary),
          ),
        );
        return { ...c, sourceTrimOut: newTrimOut };
      });
      return { clips, playhead };
    });
  },

  setTrimPreview: (clipId, sourceTime) => set({ trimPreview: { clipId, sourceTime } }),

  clearTrimPreview: () =>
    set((state) => {
      let playhead = state.playhead;
      const clip = state.clips.find((c) => c.id === state.selectedClipId);
      if (clip) {
        const start = clip.timelineStart;
        const end = clipEnd(clip);
        if (playhead > end) playhead = end;
        else if (playhead < start) playhead = start;
      }
      return { trimPreview: null, playhead };
    }),

  updateVideoFlags: (id, flags) => {
    set((state) => ({
      clips: state.clips.map((c) => {
        if (c.id !== id || c.kind !== 'video') return c;
        const next = { ...c, ...flags };
        if (flags.overlayMode && !next.overlayTransform) {
          next.overlayTransform = DEFAULT_OVERLAY_TRANSFORM;
        }
        return next;
      }),
    }));
  },
}));

function getMaxSourceOut(clip: Clip, mediaLibrary: Record<string, MediaAsset>): number {
  if (clip.kind === 'text') return clip.sourceTrimOut;
  if (clip.kind === 'image') return clip.sourceTrimOut;
  const asset = mediaLibrary[clip.assetId];
  return asset?.duration ?? clip.sourceTrimOut;
}
