import type { Clip, EditorState, MediaAsset } from '../types/editor';
import {
  clampRect,
  textFrameForClip, overlayTransformToPixels, rotatedOverlayBox, rotationOf } from '../utils/overlayTransform';
import { audibleClips, compositeLayers } from '../utils/compositeOrder';
import {
  activeEffects,
  clipSpeedOf,
  enabledEffects,
  isAnimated,
  transformAt,
} from '../utils/clipRender';
import { retimeAudioFilters } from '../utils/retime';
import { hasShapeAnimation } from '../utils/annotationAnim';
import { ffmpegChain } from '../render/effects/registry';
import { clipDuration } from '../utils/time';
import { incomingTransition, outgoingTransition } from '../utils/transitions';
import { ffmpegAudioFilters, unsupportedForFfmpeg } from '../utils/audioChain';
import type { OverlayImage } from './overlayPng';
import { evaluateChannel } from '../utils/keyframes';

export interface ExportInputSpec {
  path: string;
  /** Empty for a file this export generated rather than one from the library. */
  assetId: string;
  /** FFmpeg args placed immediately before `-i` (e.g. `-loop 1` for images). */
  inputOptions: string[];
  /** Set for a generated input — an overlay PNG — whose bytes the caller must write. */
  bytes?: Uint8Array;
}

export interface ExportPlan {
  inputSpecs: ExportInputSpec[];
  filterComplex: string;
  videoOut: string;
  audioOut: string;
  duration: number;
  /** Things this pipeline cannot reproduce, for the caller to show the user. */
  warnings: string[];
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

/**
 * `fade` filters for a clip's head and tail, in the layer's timebase — which after the
 * `setpts` shift is timeline time. `alpha=1` fades the layer's transparency rather than
 * its colour, matching what the WebGL compositor does.
 */
function fadeFilters(clip: Clip): string[] {
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  const out: string[] = [];
  if (fadeIn > 0) {
    out.push(`fade=t=in:st=${clip.timelineStart}:d=${fadeIn}:alpha=1`);
  }
  if (fadeOut > 0) {
    const start = clip.timelineStart + clipDuration(clip) - fadeOut;
    out.push(`fade=t=out:st=${start}:d=${fadeOut}:alpha=1`);
  }
  return out;
}


/**
 * A transition is an alpha ramp on the incoming clip over the outgoing one — exactly what
 * the compositor does — so `fade` expresses it and `xfade` is not needed. Wipes have no
 * equivalent and are reported instead.
 */
function transitionFilters(clip: Clip, clips: Clip[]): { filters: string[]; unsupported: string[] } {
  const filters: string[] = [];
  const unsupported: string[] = [];

  const incoming = incomingTransition(clip, clips);
  if (incoming) {
    const span = incoming.end - incoming.start;
    if (incoming.type === 'wipeL' || incoming.type === 'wipeR') {
      unsupported.push('a wipe transition');
    } else if (incoming.type === 'dipToBlack') {
      // Second half only: the frame is fully black at the midpoint.
      filters.push(`fade=t=in:st=${incoming.start + span / 2}:d=${span / 2}:alpha=1`);
    } else {
      filters.push(`fade=t=in:st=${incoming.start}:d=${span}:alpha=1`);
    }
  }

  const outgoing = outgoingTransition(clip, clips);
  if (outgoing && outgoing.type === 'dipToBlack') {
    const span = outgoing.end - outgoing.start;
    filters.push(`fade=t=out:st=${outgoing.start}:d=${span / 2}:alpha=1`);
  }
  return { filters, unsupported };
}

/** Audio side of a transition: a linear cross-fade over the same window. */
function transitionAfades(clip: Clip, clips: Clip[]): string[] {
  const out: string[] = [];
  const incoming = incomingTransition(clip, clips);
  if (incoming) {
    out.push(`afade=t=in:st=0:d=${incoming.end - incoming.start}`);
  }
  const outgoing = outgoingTransition(clip, clips);
  if (outgoing) {
    const span = outgoing.end - outgoing.start;
    out.push(`afade=t=out:st=${Math.max(0, clipDuration(clip) - span)}:d=${span}`);
  }
  return out;
}

/**
 * The drawn volume envelope, as far as a static filter chain can carry it.
 *
 * FFmpeg's `volume` is one number for the whole stream, so the envelope is applied at its
 * value at the clip's midpoint — exactly the compromise keyframed video parameters already
 * make in this path, and reported the same way. The WebCodecs path, which is the default,
 * follows the drawn curve.
 */
function volumeEnvelopeFilters(clip: Clip, warnings: string[]): string[] {
  const keys = 'gainKeyframes' in clip ? clip.gainKeyframes : undefined;
  if (!keys || keys.length === 0) return [];
  const midpoint = clipDuration(clip) / 2;
  const value = Math.max(0, evaluateChannel(keys, midpoint, 1));
  warnings.push('A drawn volume envelope is frozen at the clip midpoint by FFmpeg.');
  return value === 1 ? [] : [`volume=${value.toFixed(4)}`];
}

/** `afade` filters for a clip's own timeline, applied before the delay shift. */
function afadeFilters(clip: Clip): string[] {
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  const out: string[] = [];
  if (fadeIn > 0) out.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) {
    out.push(`afade=t=out:st=${Math.max(0, clipDuration(clip) - fadeOut)}:d=${fadeOut}`);
  }
  return out;
}

/** A short name for a warning about an overlay that could not be drawn. */
function overlayName(clip: Clip): string {
  return clip.kind === 'text' ? clip.text.slice(0, 24) : 'annotation';
}

export function buildExportPlan(
  state: Pick<EditorState, 'clips' | 'mediaLibrary' | 'settings' | 'tracks'>,
  /**
   * Overlay bitmaps by clip id, drawn by `rasterizeOverlays`. Passed in rather than produced
   * here so this module stays free of the DOM, which is what lets `check:math` import it.
   */
  overlayImages: OverlayImage[] = [],
): ExportPlan {
  const overlays = new Map(overlayImages.map((o) => [o.clipId, o]));
  const { width, height } = state.settings;
  const fps = state.settings.fps;
  const duration = Math.max(0.1, ...state.clips.map((c) => c.timelineStart + clipDuration(c)));

  const inputSpecs: ExportInputSpec[] = [];
  const filters: string[] = [];
  const warnings: string[] = [];
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

  /** Runs an effect chain over the accumulated frame — a track grade or an adjustment. */
  const gradeAccumulated = (
    effects: ReturnType<typeof activeEffects>,
    tag: string,
    enable?: string,
  ): void => {
    const chain = ffmpegChain(effects, { width, height });
    warnings.push(...chain.unsupported.map((label) => `FFmpeg cannot reproduce ${label}.`));
    if (chain.segments.length === 0) return;

    // Ranged grades branch: the untouched frame is kept and the graded copy is overlaid
    // only inside the range. `enable` on the overlay works for every filter, unlike the
    // per-filter timeline option, which not all of them support.
    const entry = enable ? `g${tag}in` : videoLabel;
    if (enable) filters.push(`[${videoLabel}]split[g${tag}keep][${entry}]`);

    let cursor = entry;
    chain.segments.forEach((segment, index) => {
      const next = `g${tag}_${index}`;
      filters.push(segment(cursor, next, `${tag}_${index}`));
      cursor = next;
    });

    const out = `g${tag}out`;
    if (enable) {
      filters.push(`[g${tag}keep][${cursor}]overlay=0:0:enable='${enable}'[${out}]`);
    } else {
      filters.push(`[${cursor}]null[${out}]`);
    }
    videoLabel = out;
  };

  // One ordered pass over the track stack, bottom-most video track first, so the last
  // clip written wins. Preview walks the same structure.
  for (const layer of compositeLayers(state.clips, state.tracks)) {
    for (const clip of layer.clips) {
      if (clip.kind === 'text' || clip.kind === 'annotation') {
        // The same bitmap the preview draws, overlaid — not a look rebuilt out of filter
        // arguments. Which is also why an effect on a text clip is no longer refused: the
        // overlay is a layer like any other now, and the chain runs on it.
        const image = overlays.get(clip.id);
        if (!image) {
          warnings.push(`The overlay "${overlayName(clip)}" could not be rendered.`);
          continue;
        }

        const idx = inputIndex++;
        const path = `overlay_${safeId(clip.id)}.png`;
        inputSpecs.push({ path, assetId: '', inputOptions: ['-loop', '1'], bytes: image.bytes });

        const id = safeId(clip.id);
        const midpoint = clip.timelineStart + clipDuration(clip) / 2;
        const effects = activeEffects(clip, midpoint);
        // Marks that move are keyframed like anything else, and freeze like anything else —
        // `isAnimated` reads the clip's own channels and cannot see inside a shape.
        if (isAnimated(clip) || (clip.kind === 'annotation' && hasShapeAnimation(clip))) {
          warnings.push('Keyframed parameters are frozen at the clip midpoint by FFmpeg.');
        }

        /*
         * Where the bitmap lands.
         *
         * A text clip was rasterized at its own frame's size, so it only needs an origin. An
         * annotation is rasterized at composition size and then placed by the clip's
         * transform, through the same `overlayTransformToPixels` the video branch below uses
         * — the placement rule has one implementation, whatever is being placed.
         */
        let overlayAt = '0:0';
        let placeSteps: string[] = [];
        let rotateStep: string | null = null;
        let chainSize = { width: image.width, height: image.height };

        if (clip.kind === 'text') {
          const frame = clampRect(textFrameForClip(clip.textFrame));
          overlayAt = `${Math.round(frame.x * width)}:${Math.round(frame.y * height)}`;
        } else {
          const transform = transformAt(clip, midpoint);
          if (transform) {
            const px = overlayTransformToPixels(
              transform,
              image.width,
              image.height,
              width,
              height,
            );
            placeSteps = [
              `crop=${px.cropW}:${px.cropH}:${px.cropX}:${px.cropY}`,
              `scale=${px.frameW}:${px.frameH}`,
            ];
            chainSize = { width: px.frameW, height: px.frameH };
            overlayAt = `${px.frameX}:${px.frameY}`;

            const degrees = rotationOf(transform);
            if (degrees !== 0) {
              const box = rotatedOverlayBox(px.frameX, px.frameY, px.frameW, px.frameH, degrees);
              rotateStep = `rotate=${(degrees * Math.PI) / 180}:ow=${box.w}:oh=${box.h}:c=none`;
              overlayAt = `${box.x}:${box.y}`;
            }
          }
        }

        const chain = ffmpegChain(effects, chainSize);
        warnings.push(...chain.unsupported.map((label) => `FFmpeg cannot reproduce ${label}.`));

        const trimmed = `x${id}`;
        filters.push(
          `[${idx}:v]trim=duration=${clipDuration(clip)},setpts=PTS-STARTPTS,` +
            `setpts=PTS+${clip.timelineStart}/TB,format=rgba` +
            `${placeSteps.length > 0 ? `,${placeSteps.join(',')}` : ''}[${trimmed}]`,
        );

        let cursor = trimmed;
        const faded = [...fadeFilters(clip)];
        if (faded.length > 0) {
          const next = `x${id}f`;
          filters.push(`[${cursor}]${faded.join(',')}[${next}]`);
          cursor = next;
        }
        chain.segments.forEach((segment, index) => {
          const next = `x${id}e${index}`;
          filters.push(segment(cursor, next, `${id}e${index}`));
          cursor = next;
        });
        // Last, for the reason the video branch gives: the chain declares the size it was
        // built for, and turning the picture under it would invalidate that.
        if (rotateStep) {
          const next = `x${id}r`;
          filters.push(`[${cursor}]${rotateStep}[${next}]`);
          cursor = next;
        }

        const out = `o${id}`;
        filters.push(
          `[${videoLabel}][${cursor}]overlay=${overlayAt}:enable='${between(clip)}'[${out}]`,
        );
        videoLabel = out;
        continue;
      }

      if (clip.kind === 'video' && clip.hideVideo) continue;

      const asset = state.mediaLibrary[clip.assetId];
      if (!asset) continue;

      const isImage = clip.kind === 'image';
      const idx = registerAsset(asset, isImage ? ['-loop', '1', '-framerate', String(fps)] : []);
      const trimLabel = `t${safeId(clip.id)}`;
      const layerLabel = `l${safeId(clip.id)}`;
      const out = `o${safeId(clip.id)}`;
      const delay = clip.timelineStart;

      // Images loop a still, so they trim by duration; A/V trims by source range.
      const trimFilter = isImage
        ? `trim=duration=${clipDuration(clip)}`
        : `trim=start=${clip.sourceTrimIn}:end=${clip.sourceTrimOut}`;
      // Retiming divides the clip's own timestamps. The order matters: the timeline shift
      // that follows is in timeline seconds and must not be divided with them.
      const speed = clipSpeedOf(clip);
      const retime = speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${speed}`;
      filters.push(`[${idx}:v]${trimFilter},${retime},setpts=PTS+${delay}/TB[${trimLabel}]`);

      // An FFmpeg filter chain is static, so an animated parameter cannot be expressed.
      // Freezing it at the clip's midpoint keeps the export sensible; the warning keeps
      // the user from thinking the animation survived.
      const midpoint = clip.timelineStart + clipDuration(clip) / 2;
      const effects = activeEffects(clip, midpoint);
      if (isAnimated(clip)) {
        warnings.push('Keyframed parameters are frozen at the clip midpoint by FFmpeg.');
      }

      // Effects run on the placed layer, exactly as the compositor runs them on its
      // layer framebuffer, so radii and block sizes mean the same thing in both paths.
      const transition = transitionFilters(clip, state.clips);
      warnings.push(...transition.unsupported.map((label) => `FFmpeg cannot reproduce ${label}.`));
      const fades = [...fadeFilters(clip), ...transition.filters];

      const id = safeId(clip.id);
      let overlayAt = 'x=0:y=0';
      let preSteps: string[];
      let chain: ReturnType<typeof ffmpegChain>;
      // Turning the layer needs somewhere for the corners to go, and a transparent fill to
      // put in what they vacate — so a rotated layer always carries an alpha plane.
      let rotateStep: string | null = null;

      if (!clip.transform) {
        // Full-frame: fit inside the canvas and letterbox, drawn at the origin.
        preSteps = [
          `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        ];
        chain = ffmpegChain(effects, { width, height });
      } else {
        const sw = asset.width ?? width;
        const sh = asset.height ?? height;
        const px = overlayTransformToPixels(
          transformAt(clip, midpoint) ?? clip.transform,
          sw,
          sh,
          width,
          height,
        );
        preSteps = [
          `crop=${px.cropW}:${px.cropH}:${px.cropX}:${px.cropY}`,
          `scale=${px.frameW}:${px.frameH}`,
        ];
        chain = ffmpegChain(effects, { width: px.frameW, height: px.frameH });
        overlayAt = `${px.frameX}:${px.frameY}`;

        const degrees = rotationOf(transformAt(clip, midpoint) ?? clip.transform);
        if (degrees !== 0) {
          const box = rotatedOverlayBox(px.frameX, px.frameY, px.frameW, px.frameH, degrees);
          rotateStep = `rotate=${(degrees * Math.PI) / 180}:ow=${box.w}:oh=${box.h}:c=none`;
          overlayAt = `${box.x}:${box.y}`;
        }
      }
      warnings.push(...chain.unsupported.map((label) => `FFmpeg cannot reproduce ${label}.`));

      // Effects are emitted as labelled segments rather than one comma-joined chain: a
      // masked effect has to branch through `split`/`overlay`, which a chain cannot do.
      let cursor = `${layerLabel}p`;
      filters.push(`[${trimLabel}]${preSteps.join(',')}[${cursor}]`);
      chain.segments.forEach((segment, index) => {
        const next = `${layerLabel}e${index}`;
        filters.push(segment(cursor, next, `${id}_${index}`));
        cursor = next;
      });
      // Alpha fades need a plane to fade, and so does a rotation's transparent fill.
      const pixelFormat = fades.length > 0 || rotateStep ? 'format=yuva420p' : 'format=yuv420p';
      // Rotation goes last, after the effect chain and the fades. The chain declares the
      // size it was built for, and turning the picture under it would invalidate that; the
      // compositor's chain runs over the whole frame rather than the layer box, so the two
      // already differ in scope for anything that varies across the frame.
      const finish = [pixelFormat, ...fades, ...(rotateStep ? [rotateStep] : [])];
      filters.push(`[${cursor}]${finish.join(',')}[${layerLabel}]`);
      filters.push(
        `[${videoLabel}][${layerLabel}]overlay=${overlayAt}:enable='${between(clip)}':eof_action=pass[${out}]`,
      );
      videoLabel = out;
    }

    // Track grade, then any ranged adjustments — the order the compositor uses.
    if (layer.track.effects?.length) {
      gradeAccumulated(enabledEffects(layer.track.effects), `tr${safeId(layer.track.id)}`);
    }
    for (const adjustment of layer.adjustments) {
      const mid = adjustment.timelineStart + clipDuration(adjustment) / 2;
      if (isAnimated(adjustment)) {
        warnings.push('Keyframed parameters are frozen at the clip midpoint by FFmpeg.');
      }
      gradeAccumulated(
        activeEffects(adjustment, mid),
        `ad${safeId(adjustment.id)}`,
        between(adjustment),
      );
    }
  }

  const audioLabels: string[] = [];
  for (const { clip, gain } of audibleClips(state.clips, state.tracks)) {
    if (clip.kind !== 'audio' && clip.kind !== 'video') continue;
    const asset = state.mediaLibrary[clip.assetId];
    if (!asset) continue;
    if (clip.kind === 'video' && asset.hasAudio === false) continue;

    const idx = registerAsset(asset);
    const aLabel = `a${safeId(clip.id)}`;
    const delayMs = Math.round(clip.timelineStart * 1000);
    const effects = 'audioEffects' in clip ? clip.audioEffects : undefined;
    const audioFilters = ffmpegAudioFilters(effects);
    const refused = unsupportedForFfmpeg(effects);
    // Named and refused rather than dropped. An audio effect that silently does not happen is
    // the one failure the user cannot hear the absence of until the file is somewhere else.
    for (const label of refused) {
      warnings.push(`FFmpeg cannot reproduce the ${label} effect on "${asset.name}".`);
    }

    const steps = [
      `atrim=start=${clip.sourceTrimIn}:end=${clip.sourceTrimOut}`,
      'asetpts=PTS-STARTPTS',
      // Retiming first, so everything after it — the chain, the fades, the envelope, the
      // delay — is expressed in the clip's *output* time.
      ...retimeAudioFilters(clip),
      // The chain runs before the fades, so a filter never hears a fade it should not.
      ...(audioFilters ?? []),
      // afade runs before the delay, so its timings are clip-relative.
      ...afadeFilters(clip),
      ...transitionAfades(clip, state.clips),
      // A drawn envelope is a time-varying gain, which a static filter chain cannot express —
      // the same limit that freezes keyframed video parameters at the midpoint.
      ...volumeEnvelopeFilters(clip, warnings),
      `adelay=${delayMs}|${delayMs}`,
      ...(gain !== 1 ? [`volume=${gain}`] : []),
    ];
    filters.push(`[${idx}:a]${steps.join(',')}[${aLabel}]`);
    audioLabels.push(aLabel);
  }

  let audioOut = 'silence';
  if (audioLabels.length === 0) {
    filters.push(`anullsrc=r=44100:cl=stereo:d=${duration}[silence]`);
  } else if (audioLabels.length === 1) {
    audioOut = audioLabels[0];
  } else {
    // normalize=0 is required: amix's default divides by the input count, so adding a
    // second audio clip would quietly attenuate the whole mix. The preview sums clip
    // gains straight into the destination, and the export has to match it.
    filters.push(
      `${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=longest:dropout_transition=0[amixed]`,
    );
    audioOut = 'amixed';
  }

  return {
    inputSpecs,
    filterComplex: filters.join(';'),
    videoOut: videoLabel,
    audioOut,
    duration,
    warnings: [...new Set(warnings)],
  };
}

export function getAssetFilesFromPlan(
  plan: ExportPlan,
  mediaLibrary: Record<string, MediaAsset>,
): { path: string; file: File }[] {
  return plan.inputSpecs.flatMap((spec) => {
    const file = mediaLibrary[spec.assetId]?.file;
    // See `collectAssetMemPaths`: offline media cannot reach here, because export refuses
    // to start with any offline clip in the project.
    return file ? [{ path: spec.path, file }] : [];
  });
}

export function buildFfmpegInputArgs(plan: ExportPlan): string[] {
  const args: string[] = [];
  for (const spec of plan.inputSpecs) {
    if (spec.inputOptions.length > 0) args.push(...spec.inputOptions);
    args.push('-i', spec.path);
  }
  return args;
}
