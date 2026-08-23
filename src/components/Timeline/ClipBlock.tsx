import { memo } from 'react';
import type { Clip, MediaAsset } from '../../types/editor';
import { clipDuration } from '../../utils/time';
import { ClipFilmstrip } from './ClipFilmstrip';
import { ClipWaveform } from './ClipWaveform';

interface Props {
  clip: Clip;
  pxPerSec: number;
  fps: number;
  trackHeight: number;
  selected: boolean;
  invalid: boolean;
  locked: boolean;
  asset: MediaAsset | undefined;
  onPointerDown: (
    e: React.PointerEvent,
    clip: Clip,
    mode: 'move' | 'left' | 'right' | 'fadeIn' | 'fadeOut',
  ) => void;
  onContextMenu: (e: React.MouseEvent, clip: Clip) => void;
}

function clipLabel(clip: Clip, asset: MediaAsset | undefined): string {
  if (clip.kind === 'text') return clip.text.slice(0, 40) || 'Text';
  if (clip.kind === 'adjustment') return 'Adjustment';
  return asset?.name ?? clip.kind;
}

export const ClipBlock = memo(function ClipBlock({
  clip,
  pxPerSec,
  fps,
  trackHeight,
  selected,
  invalid,
  locked,
  asset,
  onPointerDown,
  onContextMenu,
}: Props) {
  const duration = clipDuration(clip);
  const left = clip.timelineStart * pxPerSec;
  const width = Math.max(8, duration * pxPerSec);
  const height = Math.max(20, trackHeight - 8);
  const label = clipLabel(clip, asset);
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  const effectCount = (clip.effects ?? []).filter((e) => e.enabled).length;

  // A video clip carries its own audio: picture on top, waveform underneath.
  const showsAudioStrip =
    clip.kind === 'audio' || (clip.kind === 'video' && clip.hasAudio && clip.audioEnabled);
  const videoStripHeight =
    clip.kind === 'video' && showsAudioStrip ? Math.round(height * 0.62) : height;
  const audioStripHeight = clip.kind === 'video' ? height - videoStripHeight : height;

  const classes = [
    'clip',
    `clip--${clip.kind}`,
    selected ? 'is-selected' : '',
    invalid && selected ? 'is-invalid' : '',
    locked ? 'is-locked' : '',
    clip.kind === 'video' && clip.transform ? 'has-transform' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      style={{ left, width, height, top: 4 }}
      onPointerDown={(e) => onPointerDown(e, clip, 'move')}
      onContextMenu={(e) => onContextMenu(e, clip)}
      title={label}
    >
      {/*
        Offline: the block keeps its length, label, fades and effect badges — everything the
        edit consists of — and says what it is waiting for. A filmstrip cannot be derived
        without the file, and an empty strip would read as a black clip rather than a missing
        one.
      */}
      {asset && !asset.file && (
        <div className="clip-offline" style={{ height }}>
          <span className="clip-offline-label">Offline</span>
        </div>
      )}

      {clip.kind === 'video' && !clip.hideVideo && asset?.blobUrl && (
        <div className="clip-visual" style={{ height: videoStripHeight }}>
          <ClipFilmstrip
            assetId={asset.id}
            blobUrl={asset.blobUrl}
            duration={asset.duration}
            sourceTrimIn={clip.sourceTrimIn}
            sourceTrimOut={clip.sourceTrimOut}
            width={width}
            height={videoStripHeight}
          />
        </div>
      )}

      {clip.kind === 'image' && asset?.blobUrl && (
        <div
          className="clip-image-fill"
          style={{ height, backgroundImage: `url(${asset.blobUrl})` }}
        />
      )}

      {showsAudioStrip && asset?.file && (
        <div
          className="clip-audio"
          style={{ height: audioStripHeight, top: clip.kind === 'video' ? videoStripHeight : 0 }}
        >
          <ClipWaveform
            assetId={asset.id}
            file={asset.file}
            duration={asset.duration}
            sourceTrimIn={clip.sourceTrimIn}
            sourceTrimOut={clip.sourceTrimOut}
            width={width}
            height={audioStripHeight}
          />
        </div>
      )}

      {/* Fade ramps: the wedge is the envelope, drawn over whatever the clip shows. */}
      {fadeIn > 0 && (
        <span
          className="clip-fade clip-fade--in"
          style={{ width: Math.max(2, fadeIn * pxPerSec), height }}
        />
      )}
      {fadeOut > 0 && (
        <span
          className="clip-fade clip-fade--out"
          style={{ width: Math.max(2, fadeOut * pxPerSec), height }}
        />
      )}
      {/* Length in frames, which is the unit the edit actually snaps to. */}
      {fadeIn * pxPerSec > 30 && (
        <span className="clip-fade-count clip-fade-count--in">{Math.round(fadeIn * fps)}f</span>
      )}
      {fadeOut * pxPerSec > 30 && (
        <span className="clip-fade-count clip-fade-count--out">{Math.round(fadeOut * fps)}f</span>
      )}

      <span className="clip-label">
        {clip.kind === 'video' && clip.transform ? '◱ ' : ''}
        {clip.kind === 'video' && clip.hasAudio && !clip.audioEnabled ? '🔇 ' : ''}
        {effectCount > 0 ? <span className="clip-fx-badge">fx{effectCount}</span> : null}
        {label}
      </span>

      {!locked && (
        <>
          <span
            className="clip-handle clip-handle--left"
            onPointerDown={(e) => onPointerDown(e, clip, 'left')}
          />
          <span
            className="clip-handle clip-handle--right"
            onPointerDown={(e) => onPointerDown(e, clip, 'right')}
          />
          <span
            className="clip-fade-grip clip-fade-grip--in"
            style={{ left: fadeIn * pxPerSec }}
            title="Drag to fade in"
            onPointerDown={(e) => onPointerDown(e, clip, 'fadeIn')}
          />
          <span
            className="clip-fade-grip clip-fade-grip--out"
            style={{ right: fadeOut * pxPerSec }}
            title="Drag to fade out"
            onPointerDown={(e) => onPointerDown(e, clip, 'fadeOut')}
          />
        </>
      )}
    </div>
  );
});
