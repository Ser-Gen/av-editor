import {
  AudioBufferSource,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  canEncodeAudio,
} from 'mediabunny';
import type { Clip, EditorState, MediaAsset, VisualClip } from '../../types/editor';
import { audibleClips, compositeLayers, compositeOrderedClips } from '../../utils/compositeOrder';
import {
  activeEffects,
  clipClock,
  enabledEffects,
  fadeGainAt,
  timelineClock,
  transformAt,
} from '../../utils/clipRender';
import { transitionStateAt } from '../../utils/transitions';
import { clipDuration } from '../../utils/time';
import { GLCompositor } from '../../render/GLCompositor';
import { MIX_SAMPLE_RATE, MIX_WINDOW_SECONDS, downmixToMono, mixdownWindows } from './audioMixdown';
import { ClipFrameReader } from './frameSource';
import { MediaInputCache } from './mediaInputs';
import { openScratchFile } from './opfs';
import type { ResolvedExport } from '../../utils/exportSettings';
import { WebCodecsUnsupportedError, webCodecsExportSupported } from './support';

export type ExportSlice = Pick<EditorState, 'clips' | 'mediaLibrary' | 'settings' | 'tracks'>;

export interface WebCodecsExportResult {
  file: File;
  /** Frames actually encoded, for the progress log and the DOD checks. */
  frames: number;
  durationSeconds: number;
}

function isVideoClipWithSource(clip: VisualClip): clip is Extract<VisualClip, { kind: 'video' }> {
  return clip.kind === 'video';
}

function sourceTimeFor(clip: Clip, t: number): number {
  const raw = clip.sourceTrimIn + (t - clip.timelineStart);
  return Math.min(clip.sourceTrimOut - 1e-6, Math.max(clip.sourceTrimIn, raw));
}

export async function exportWithWebCodecs(
  state: ExportSlice,
  spec: ResolvedExport,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<WebCodecsExportResult> {
  if (!(await webCodecsExportSupported())) {
    throw new WebCodecsUnsupportedError('This browser cannot encode H.264 through WebCodecs.');
  }

  // The composition is defined in normalized space, so exporting at a different pixel size is
  // a scale of the whole render, not a re-layout. Aspect is guarded before we get here.
  const { width, height, fps } = spec;
  const duration = Math.max(
    0.1,
    ...state.clips.map((c) => c.timelineStart + clipDuration(c)),
  );
  const totalFrames = Math.max(1, Math.round(duration * fps));

  const compositor = new GLCompositor();
  if (!compositor.available) {
    compositor.dispose();
    throw new WebCodecsUnsupportedError('WebGL2 is unavailable, so frames cannot be composited.');
  }

  const inputs = new MediaInputCache();
  const readers = new Map<string, ClipFrameReader>();
  const images = new Map<string, ImageBitmap>();
  const scratch = await openScratchFile(`export_${Date.now()}.mp4`);

  const cleanup = async () => {
    for (const reader of readers.values()) await reader.dispose();
    for (const bitmap of images.values()) bitmap.close();
    inputs.dispose();
    compositor.dispose();
  };

  try {
    // --- Prepare per-clip decoders -------------------------------------------------
    const ordered = compositeOrderedClips(state.clips, state.tracks);
    const layers = compositeLayers(state.clips, state.tracks);
    for (const clip of ordered) {
      if (isVideoClipWithSource(clip)) {
        if (clip.hideVideo) continue;
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset) continue;
        const track = await inputs.videoTrack(asset);
        if (!track) {
          throw new WebCodecsUnsupportedError(
            `"${asset.name}" cannot be decoded by WebCodecs in this browser.`,
          );
        }
        readers.set(clip.id, new ClipFrameReader(track, clip.sourceTrimIn, clip.sourceTrimOut));
      } else if (clip.kind === 'image') {
        const asset = state.mediaLibrary[clip.assetId];
        if (!asset || images.has(asset.id)) continue;
        images.set(asset.id, await createImageBitmap(asset.file));
      }
    }

    // --- Muxer -------------------------------------------------------------------
    const audible = audibleClips(state.clips, state.tracks).filter(
      ({ clip }) => clip.kind === 'audio' || clip.kind === 'video',
    );
    const hasAudio = audible.length > 0 && (await canEncodeAudio('aac'));

    const output = new Output({
      // 'reserve' puts the metadata at the front without buffering the file in memory,
      // which is what keeps a long export's heap flat. It needs exact packet bounds.
      format: new Mp4OutputFormat({ fastStart: 'reserve' }),
      target: new StreamTarget(scratch.writable, { chunked: true }),
    });

    // Creation date is the one descriptive field the editor can honestly fill in: a project has
    // no name to put in a title until projects can be saved. Without this an exported file has
    // no date at all, and players fall back to whenever it was copied.
    output.setMetadataTags({
      date: new Date(),
      comment: 'Encoded in the browser with WebCodecs.',
    });

    const videoSource = new CanvasSource(compositor.canvas, {
      codec: 'avc',
      bitrate: spec.videoBitrate,
      keyFrameInterval: spec.keyframeInterval,
    });
    output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: totalFrames });

    let audioSource: AudioBufferSource | null = null;
    if (hasAudio) {
      // Channel count and sample rate come from the mixed AudioBuffer itself.
      audioSource = new AudioBufferSource({ codec: 'aac', bitrate: spec.audioBitrate });
      // AAC packs 1024 samples per frame; the slack covers priming and the final partial.
      // One extra frame per window can appear at window boundaries, so budget for those.
      const windows = Math.ceil(duration / MIX_WINDOW_SECONDS);
      const maxAudioPackets = Math.ceil((duration * MIX_SAMPLE_RATE) / 1024) + windows * 2 + 32;
      output.addAudioTrack(audioSource, { maximumPacketCount: maxAudioPackets });
    }

    await output.start();

    // --- Audio pump: stays at most one window ahead of the video ------------------
    const audioWindows = hasAudio
      ? mixdownWindows(audible, state.mediaLibrary, inputs, duration, signal, state.clips)
      : null;
    let audioSeconds = 0;
    let audioDone = false;

    const pumpAudioUntil = async (seconds: number): Promise<void> => {
      if (!audioWindows || !audioSource) return;
      while (!audioDone && audioSeconds < seconds) {
        const next = await audioWindows.next();
        if (next.done) {
          audioDone = true;
          break;
        }
        await audioSource.add(
          spec.audioChannels === 1 ? downmixToMono(next.value) : next.value,
        );
        audioSeconds += next.value.duration;
      }
    };

    // --- Frame loop ---------------------------------------------------------------
    for (let frame = 0; frame < totalFrames; frame++) {
      signal.throwIfAborted();
      const t = frame / fps;

      compositor.beginFrame(width, height);
      // Track by track, bottom-up — the same grouping the preview uses, so a track
      // grade lands on exactly the same layers in both.
      for (const layer of layers) {
        for (const clip of layer.clips) {
          const start = clip.timelineStart;
          if (t < start || t >= start + clipDuration(clip)) continue;

          const transition = transitionStateAt(clip, state.clips, t);
          const fade = fadeGainAt(clip, t) * transition.alpha;
          const effects = activeEffects(clip, t);
          const clock = clipClock(clip, t, fps);

          if (clip.kind === 'text') {
            compositor.withEffects(
              effects,
              fade,
              (alpha, flip) => compositor.drawTextClip(clip, alpha, flip),
              transition.wipe,
              clock,
            );
            continue;
          }

          if (clip.kind === 'image') {
            const bitmap = images.get(clip.assetId);
            if (bitmap) {
              compositor.withEffects(
                effects,
                fade,
                (alpha, flip) =>
                  compositor.drawSource(
                    clip.assetId,
                    bitmap,
                    bitmap.width,
                    bitmap.height,
                    transformAt(clip, t),
                    alpha,
                    flip,
                  ),
                transition.wipe,
                clock,
              );
            }
            continue;
          }

          if (clip.hideVideo) continue;
          const reader = readers.get(clip.id);
          if (!reader) continue;
          const sample = await reader.frameAt(sourceTimeFor(clip, t));
          if (!sample) continue;
          const drawable = reader.toDrawable(sample);
          if (!drawable) continue;
          // Per-clip texture key: two clips may cut from one asset at different times.
          compositor.withEffects(
            effects,
            fade,
            (alpha, flip) =>
              compositor.drawSource(
                `clip:${clip.id}`,
                drawable.source,
                drawable.width,
                drawable.height,
                transformAt(clip, t),
                alpha,
                flip,
              ),
            transition.wipe,
            clock,
          );
          if (drawable.source instanceof VideoFrame) drawable.source.close();
        }

        if (layer.track.effects?.length) {
          compositor.applyToScene(enabledEffects(layer.track.effects), timelineClock(t, fps));
        }
        for (const adjustment of layer.adjustments) {
          const start = adjustment.timelineStart;
          if (t < start || t >= start + clipDuration(adjustment)) continue;
          compositor.applyToScene(activeEffects(adjustment, t), clipClock(adjustment, t, fps));
        }
      }
      compositor.endFrame();

      // CanvasSource.add resolves on encoder backpressure, so this loop cannot outrun
      // the encoder and pile up frames in memory.
      await videoSource.add(t, 1 / fps);
      await pumpAudioUntil(Math.min(duration, t + MIX_WINDOW_SECONDS));
      onProgress((frame + 1) / totalFrames);
    }

    await pumpAudioUntil(duration);
    // finalize() awaits the target's stream close, so the OPFS file is complete here.
    await output.finalize();

    return {
      file: await scratch.toFile(),
      frames: totalFrames,
      durationSeconds: duration,
    };
  } catch (e) {
    await scratch.abort();
    throw e;
  } finally {
    await cleanup();
  }
}

export type { MediaAsset };
