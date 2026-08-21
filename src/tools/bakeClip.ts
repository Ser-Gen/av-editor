import type { Clip, ExportSettings, MediaAsset, ProjectSettings, Track } from '../types/editor';
import { createTrack } from '../store/clipFactory';
import { derivedBitrate } from '../utils/exportSettings';
import type { ResolvedExport } from '../utils/exportSettings';
import { clipDuration } from '../utils/time';
import { clampDimension } from '../utils/resolution';

/**
 * Baking a clip's effect chain into a new media file, on the GPU.
 *
 * There is no new rendering code here and there should not be: the WebCodecs export already
 * composites through the same `GLCompositor` the preview uses and encodes with the hardware
 * encoder, and `ExportSlice` is only four fields. So a bake is a *synthetic one-clip project*
 * handed to the exporter that already exists — which is why this is the fast path for every
 * effect the renderer knows, and why it stays in step with the preview by construction rather
 * than by a second implementation agreeing with the first.
 *
 * What is deliberately dropped from the synthetic clip, and why:
 *
 * - **Placement and its keyframes.** A bake makes a *source file*, at the source's own size.
 *   Rendering a corner PiP would produce a frame that is mostly empty.
 * - **Fades and transitions.** They belong to the edit, not the picture. Baking them in and
 *   then leaving them on the clip would apply each one twice.
 * - **Clip gain.** Same reason: the replacing clip keeps its own.
 *
 * What is kept is the effect chain with its keyframes, which is the entire point.
 */

export interface BakeResult {
  file: File;
  frames: number;
  /** Wall-clock seconds the encode took, for the "×realtime" line. */
  seconds: number;
}

/** The clip as the bake sees it: at t = 0, unplaced, unfaded, effects intact. */
export function bakeClipOf(clip: Clip): Clip {
  return {
    ...clip,
    timelineStart: 0,
    transform: undefined,
    transformKeyframes: undefined,
    fadeIn: undefined,
    fadeOut: undefined,
    transitionIn: undefined,
    ...('gain' in clip ? { gain: 1 } : {}),
  } as Clip;
}

/**
 * The frame size a bake writes.
 *
 * The source's own, so the new file can stand in for the old one without anything being
 * resampled on the way through. Falls back to the project's frame when the probe never
 * learned a size — an audio-only or unreadable source — and is forced even, which is all
 * H.264 will encode.
 */
export function bakeSize(asset: MediaAsset, project: ProjectSettings): { width: number; height: number } {
  const width = asset.width && asset.width > 0 ? asset.width : project.width;
  const height = asset.height && asset.height > 0 ? asset.height : project.height;
  return { width: clampDimension(width), height: clampDimension(height) };
}

/**
 * Encoder settings for a bake.
 *
 * Quality comes from the project's own export settings so that "master" means the same thing
 * here as it does on the way out, but the *size* is the source's rather than the project's —
 * an intermediate that has been quietly letterboxed into the project frame is not an
 * intermediate, it is a render.
 */
export function bakeSpec(
  asset: MediaAsset,
  project: ProjectSettings,
  exportSettings: ExportSettings,
): ResolvedExport {
  const { width, height } = bakeSize(asset, project);
  const fps = exportSettings.fps ?? project.fps;
  return {
    width,
    height,
    fps,
    videoBitrate: derivedBitrate(exportSettings.quality, width, height, fps),
    keyframeInterval: exportSettings.keyframeInterval,
    audioBitrate: exportSettings.audioBitrate,
    audioChannels: exportSettings.audioChannels,
    scaled: width !== project.width || height !== project.height,
  };
}

/**
 * Renders one clip's effect chain to a new file through the WebCodecs export path.
 *
 * The exporter is imported lazily for the same reason the real export does it: mediabunny's
 * muxer and codec tables are half a megabyte nobody needs until something is actually encoded.
 */
export async function bakeClip(
  clip: Clip,
  asset: MediaAsset,
  project: ProjectSettings,
  exportSettings: ExportSettings,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<BakeResult> {
  const { exportWithWebCodecs } = await import('../export/webcodecs/exportWebCodecs');

  const track: Track = { ...createTrack('video', 'V1'), id: clip.trackId };
  const spec = bakeSpec(asset, project, exportSettings);
  const started = performance.now();

  const result = await exportWithWebCodecs(
    {
      clips: [bakeClipOf(clip)],
      mediaLibrary: { [asset.id]: asset },
      settings: { width: spec.width, height: spec.height, fps: spec.fps },
      tracks: [track],
    },
    spec,
    onProgress,
    signal,
  );

  return {
    file: result.file,
    frames: result.frames,
    seconds: (performance.now() - started) / 1000,
  };
}

/** How long the bake will be — the clip's own length, since nothing retimes it. */
export function bakeDuration(clip: Clip): number {
  return clipDuration(clip);
}
