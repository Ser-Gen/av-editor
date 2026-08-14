import type { Clip, EditorState, MediaAsset } from '../types/editor';
import { resolutionToSize } from '../utils/resolution';
import { imageTransformForClip, overlayTransformToPixels } from '../utils/overlayTransform';
import { getAudioTrackVolume } from '../utils/trackVolume';
import { clipDuration } from '../utils/time';
import { drawtextFilter } from './textDrawtext';

export interface ExportInputSpec {
  path: string;
  assetId: string;
  /** FFmpeg args placed immediately before `-i` (e.g. `-loop 1` for images). */
  inputOptions: string[];
}

export interface ExportPlan {
  inputSpecs: ExportInputSpec[];
  filterComplex: string;
  videoOut: string;
  audioOut: string;
  duration: number;
}

function extFromName(name: string): string {
  const m = name.match(/\.(\w+)$/);
  return m ? m[1].toLowerCase() : 'dat';
}

function between(clip: Clip): string {
  const start = clip.timelineStart;
  const end = start + clipDuration(clip);
  return `between(t\\,${start}\\,${end})`;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '');
}

export function buildExportPlan(state: Pick<EditorState, 'clips' | 'mediaLibrary' | 'settings' | 'tracks'>): ExportPlan {
  const { width, height } = resolutionToSize(state.settings.resolution);
  const fps = state.settings.fps;
  const duration = Math.max(
    0.1,
    ...state.clips.map((c) => c.timelineStart + clipDuration(c)),
  );

  const inputSpecs: ExportInputSpec[] = [];
  const filters: string[] = [];
  let inputIndex = 0;
  const assetInputMap = new Map<string, number>();

  const registerAsset = (asset: MediaAsset, inputOptions: string[] = []): number => {
    if (assetInputMap.has(asset.id)) return assetInputMap.get(asset.id)!;
    const idx = inputIndex++;
    const path = `input_${asset.id}.${extFromName(asset.name)}`;
    inputSpecs.push({ path, assetId: asset.id, inputOptions });
    assetInputMap.set(asset.id, idx);
    return idx;
  };

  filters.push(`color=c=black:s=${width}x${height}:d=${duration}:r=${fps},format=yuv420p[base]`);
  let videoLabel = 'base';

  const baseVideoClips = state.clips.filter(
    (c): c is Extract<Clip, { kind: 'video' }> =>
      c.kind === 'video' && !c.hideVideo && !c.overlayMode,
  );
  const overlayVideoClips = state.clips.filter(
    (c): c is Extract<Clip, { kind: 'video' }> =>
      c.kind === 'video' && !c.hideVideo && !!c.overlayMode,
  );
  const imageClips = state.clips.filter((c): c is Extract<Clip, { kind: 'image' }> => c.kind === 'image');
  const textClips = state.clips.filter((c): c is Extract<Clip, { kind: 'text' }> => c.kind === 'text');

  for (const clip of baseVideoClips) {
    const asset = state.mediaLibrary[clip.assetId];
    if (!asset) continue;
    const idx = registerAsset(asset);
    const vLabel = `v${safeId(clip.id)}`;
    const out = `vo${safeId(clip.id)}`;
    const delay = clip.timelineStart;

    filters.push(
      `[${idx}:v]trim=start=${clip.sourceTrimIn}:end=${clip.sourceTrimOut},setpts=PTS-STARTPTS,setpts=PTS+${delay}/TB,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p[${vLabel}]`,
    );
    filters.push(
      `[${videoLabel}][${vLabel}]overlay=x=0:y=0:enable='${between(clip)}':eof_action=pass[${out}]`,
    );
    videoLabel = out;
  }

  for (const clip of imageClips) {
    const asset = state.mediaLibrary[clip.assetId];
    if (!asset) continue;
    const idx = registerAsset(asset, ['-loop', '1', '-framerate', String(fps)]);
    const trimLabel = `imgtrim${safeId(clip.id)}`;
    const scaledLabel = `img${safeId(clip.id)}`;
    const out = `io${safeId(clip.id)}`;
    const delay = clip.timelineStart;
    const clipDur = clipDuration(clip);
    const sw = asset.width ?? width;
    const sh = asset.height ?? height;
    const transform = imageTransformForClip(clip.overlayTransform, sw, sh);
    const px = overlayTransformToPixels(transform, sw, sh, width, height);

    filters.push(
      `[${idx}:v]trim=duration=${clipDur},setpts=PTS-STARTPTS,setpts=PTS+${delay}/TB[${trimLabel}]`,
    );
    filters.push(
      `[${trimLabel}]crop=${px.cropW}:${px.cropH}:${px.cropX}:${px.cropY},scale=${px.frameW}:${px.frameH},format=yuv420p[${scaledLabel}]`,
    );
    filters.push(
      `[${videoLabel}][${scaledLabel}]overlay=${px.frameX}:${px.frameY}:enable='${between(clip)}':eof_action=pass[${out}]`,
    );
    videoLabel = out;
  }

  for (const clip of overlayVideoClips) {
    const asset = state.mediaLibrary[clip.assetId];
    if (!asset) continue;
    const idx = registerAsset(asset);
    const trimLabel = `vtrim${safeId(clip.id)}`;
    const scaledLabel = `vov${safeId(clip.id)}`;
    const out = `vo${safeId(clip.id)}`;
    const delay = clip.timelineStart;
    const sw = asset.width ?? width;
    const sh = asset.height ?? height;
    const px = overlayTransformToPixels(clip.overlayTransform, sw, sh, width, height);

    filters.push(
      `[${idx}:v]trim=start=${clip.sourceTrimIn}:end=${clip.sourceTrimOut},setpts=PTS-STARTPTS,setpts=PTS+${delay}/TB[${trimLabel}]`,
    );
    filters.push(
      `[${trimLabel}]crop=${px.cropW}:${px.cropH}:${px.cropX}:${px.cropY},scale=${px.frameW}:${px.frameH},format=yuv420p[${scaledLabel}]`,
    );
    filters.push(
      `[${videoLabel}][${scaledLabel}]overlay=${px.frameX}:${px.frameY}:enable='${between(clip)}':eof_action=pass[${out}]`,
    );
    videoLabel = out;
  }

  for (const clip of textClips) {
    const { filter, outLabel } = drawtextFilter(
      clip.template,
      clip.text,
      width,
      height,
      '/font.ttf',
      between(clip),
      videoLabel,
      clip.textFrame,
    );
    filters.push(filter);
    videoLabel = outLabel;
  }

  const audioClips = state.clips.filter((c) => {
    if (c.kind === 'audio') return true;
    if (c.kind === 'video' && !c.muteAudio) {
      const asset = state.mediaLibrary[c.assetId];
      return asset?.hasAudio === true;
    }
    return false;
  });

  const audioLabels: string[] = [];
  for (const clip of audioClips) {
    if (clip.kind !== 'audio' && clip.kind !== 'video') continue;
    const asset = state.mediaLibrary[clip.assetId];
    if (!asset) continue;
    const idx = registerAsset(asset);
    const aLabel = `a${safeId(clip.id)}`;
    const delayMs = Math.round(clip.timelineStart * 1000);

    const track = state.tracks.find((tr) => tr.id === clip.trackId);
    const volume = getAudioTrackVolume(track);
    const volumeFilter = volume !== 1 ? `,volume=${volume}` : '';
    filters.push(
      `[${idx}:a]atrim=start=${clip.sourceTrimIn}:end=${clip.sourceTrimOut},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}${volumeFilter}[${aLabel}]`,
    );
    audioLabels.push(aLabel);
  }

  let audioOut = 'silence';
  if (audioLabels.length === 0) {
    filters.push(`anullsrc=r=44100:cl=stereo:d=${duration}[silence]`);
  } else if (audioLabels.length === 1) {
    audioOut = audioLabels[0];
  } else {
    filters.push(
      `${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0[amixed]`,
    );
    audioOut = 'amixed';
  }

  return {
    inputSpecs,
    filterComplex: filters.join(';'),
    videoOut: videoLabel,
    audioOut,
    duration,
  };
}

export function getAssetFilesFromPlan(
  plan: ExportPlan,
  mediaLibrary: Record<string, MediaAsset>,
): { path: string; file: File }[] {
  return plan.inputSpecs.map((spec) => ({
    path: spec.path,
    file: mediaLibrary[spec.assetId].file,
  }));
}

export function buildFfmpegInputArgs(plan: ExportPlan): string[] {
  const args: string[] = [];
  for (const spec of plan.inputSpecs) {
    if (spec.inputOptions.length > 0) args.push(...spec.inputOptions);
    args.push('-i', spec.path);
  }
  return args;
}
