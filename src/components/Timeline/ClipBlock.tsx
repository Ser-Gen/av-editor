import { useRef } from 'react';
import type { Clip } from '../../types/editor';
import { useEditorStore } from '../../store/editorStore';
import { clipDuration } from '../../utils/time';
import { ClipFilmstrip } from './ClipFilmstrip';
import { ClipWaveform } from './ClipWaveform';

interface Props {
  clip: Clip;
  pxPerSec: number;
}

export function ClipBlock({ clip, pxPerSec }: Props) {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const mediaLibrary = useEditorStore((s) => s.mediaLibrary);
  const selectClip = useEditorStore((s) => s.selectClip);
  const moveClip = useEditorStore((s) => s.moveClip);
  const trimClip = useEditorStore((s) => s.trimClip);
  const setTrimPreview = useEditorStore((s) => s.setTrimPreview);
  const clearTrimPreview = useEditorStore((s) => s.clearTrimPreview);
  const settings = useEditorStore((s) => s.settings);

  const dragRef = useRef<{ startX: number; startT: number } | null>(null);
  const trimRef = useRef<{ edge: 'left' | 'right'; startX: number } | null>(null);

  const dur = clipDuration(clip);
  const left = clip.timelineStart * pxPerSec;
  const width = Math.max(24, dur * pxPerSec);
  const audioAsset = clip.kind === 'audio' ? mediaLibrary[clip.assetId] : undefined;
  const videoAsset =
    clip.kind === 'video' && !clip.hideVideo ? mediaLibrary[clip.assetId] : undefined;

  let label: string;
  switch (clip.kind) {
    case 'text':
      label = clip.text.slice(0, 24);
      break;
    case 'video':
    case 'audio':
    case 'image':
      label = mediaLibrary[clip.assetId]?.name ?? clip.kind;
      break;
  }

  const onPointerDown = (e: React.PointerEvent, mode: 'move' | 'left' | 'right') => {
    e.stopPropagation();
    selectClip(clip.id);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (mode === 'move') {
      dragRef.current = { startX: e.clientX, startT: clip.timelineStart };
    } else {
      trimRef.current = { edge: mode, startX: e.clientX };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      moveClip(clip.id, dragRef.current.startT + dx / pxPerSec);
    }
    if (trimRef.current) {
      const dx = e.clientX - trimRef.current.startX;
      trimRef.current.startX = e.clientX;
      const edge = trimRef.current.edge;
      trimClip(clip.id, edge, dx / pxPerSec);

      const updated = useEditorStore.getState().clips.find((c) => c.id === clip.id);
      if (updated && (updated.kind === 'video' || updated.kind === 'audio')) {
        const frame = 1 / settings.fps;
        const sourceTime =
          edge === 'left'
            ? updated.sourceTrimIn
            : Math.max(updated.sourceTrimIn, updated.sourceTrimOut - frame);
        setTrimPreview(clip.id, sourceTime);
      }
    }
  };

  const onPointerUp = () => {
    if (trimRef.current) clearTrimPreview();
    dragRef.current = null;
    trimRef.current = null;
  };

  return (
    <div
      className={`clip-block ${clip.kind} ${selectedClipId === clip.id ? 'selected' : ''}`}
      style={{ left, width }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      title={label}
    >
      <span
        className="clip-handle left"
        onPointerDown={(e) => onPointerDown(e, 'left')}
      />
      {videoAsset && videoAsset.type === 'video' && (
        <ClipFilmstrip
          assetId={videoAsset.id}
          blobUrl={videoAsset.blobUrl}
          duration={videoAsset.duration}
          sourceTrimIn={clip.sourceTrimIn}
          sourceTrimOut={clip.sourceTrimOut}
          width={width}
          height={56}
        />
      )}
      {audioAsset && (
        <ClipWaveform
          assetId={audioAsset.id}
          file={audioAsset.file}
          duration={audioAsset.duration}
          sourceTrimIn={clip.sourceTrimIn}
          sourceTrimOut={clip.sourceTrimOut}
          width={width}
          height={56}
        />
      )}
      <span className="clip-label">
        {clip.kind === 'video' && clip.overlayMode ? 'PiP · ' : ''}
        {label}
      </span>
      <span
        className="clip-handle right"
        onPointerDown={(e) => onPointerDown(e, 'right')}
      />
    </div>
  );
}
