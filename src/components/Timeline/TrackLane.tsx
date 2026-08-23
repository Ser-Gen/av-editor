import { memo } from 'react';
import type { Clip, MediaAsset, Track } from '../../types/editor';
import { clipEnd } from '../../utils/time';
import { TRANSITION_LABELS, allTransitions } from '../../utils/transitions';
import { ClipBlock } from './ClipBlock';
import { KEYFRAME_ROW_HEIGHT, KeyframeStrip, keyframeRows } from './KeyframeStrip';
import { CULL_MARGIN_PX } from './constants';

interface Props {
  track: Track;
  clips: Clip[];
  pxPerSec: number;
  fps: number;
  scrollX: number;
  viewportWidth: number;
  selectedIds: string[];
  dragInvalid: boolean;
  mediaLibrary: Record<string, MediaAsset>;
  onClipPointerDown: (
    e: React.PointerEvent,
    clip: Clip,
    mode: 'move' | 'left' | 'right' | 'fadeIn' | 'fadeOut',
  ) => void;
  onClipContextMenu: (e: React.MouseEvent, clip: Clip) => void;
}

export const TrackLane = memo(function TrackLane({
  track,
  clips,
  pxPerSec,
  fps,
  scrollX,
  viewportWidth,
  selectedIds,
  dragInvalid,
  mediaLibrary,
  onClipPointerDown,
  onClipContextMenu,
}: Props) {
  const from = scrollX - CULL_MARGIN_PX;
  const to = scrollX + viewportWidth + CULL_MARGIN_PX;

  return (
    <div
      className={`lane lane--${track.kind}${track.locked ? ' is-locked' : ''}${
        track.hidden ? ' is-hidden' : ''
      }`}
      style={{ height: track.height }}
      data-track-id={track.id}
    >
      {clips.map((clip) => {
        // Offscreen clips are not rendered at all — filmstrips and waveforms are expensive.
        if (clipEnd(clip) * pxPerSec < from || clip.timelineStart * pxPerSec > to) return null;
        return (
          <ClipBlock
            key={clip.id}
            clip={clip}
            pxPerSec={pxPerSec}
            fps={fps}
            trackHeight={track.height}
            selected={selectedIds.includes(clip.id)}
            invalid={dragInvalid}
            locked={track.locked}
            asset={'assetId' in clip ? mediaLibrary[clip.assetId] : undefined}
            onPointerDown={onClipPointerDown}
            onContextMenu={onClipContextMenu}
          />
        );
      })}

      {/* A transition *is* the overlap, so it is drawn from the two clips' geometry. */}
      {allTransitions(clips).map(({ clip, window }) => (
        <div
          key={`tr-${clip.id}`}
          className="transition-bowtie"
          style={{
            left: window.start * pxPerSec,
            width: Math.max(3, (window.end - window.start) * pxPerSec),
            height: track.height - 8,
          }}
          title={`${TRANSITION_LABELS[window.type]} — drag either clip to change its length`}
        />
      ))}

      {/* Keyframes for the selected clip only — one strip is informative, ten is noise. */}
      {clips.map((clip) => {
        if (!selectedIds.includes(clip.id)) return null;
        if (clipEnd(clip) * pxPerSec < from || clip.timelineStart * pxPerSec > to) return null;
        const rows = keyframeRows(clip).length;
        if (rows === 0) return null;
        return (
          <KeyframeStrip
            key={`kf-${clip.id}`}
            clip={clip}
            pxPerSec={pxPerSec}
            top={Math.max(4, track.height - rows * KEYFRAME_ROW_HEIGHT - 4)}
          />
        );
      })}
    </div>
  );
});
