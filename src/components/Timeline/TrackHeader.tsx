import { useEffect, useRef, useState } from 'react';
import type { Track } from '../../types/editor';
import { useEditorStore } from '../../store/editorStore';
import { MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT } from '../../store/clipFactory';

interface Props {
  track: Track;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canDelete: boolean;
  clipCount: number;
}

export function TrackHeader({ track, canMoveUp, canMoveDown, canDelete, clipCount }: Props) {
  const renameTrack = useEditorStore((s) => s.renameTrack);
  const moveTrack = useEditorStore((s) => s.moveTrack);
  const removeTrack = useEditorStore((s) => s.removeTrack);
  const toggleTrackFlag = useEditorStore((s) => s.toggleTrackFlag);
  const setTrackVolume = useEditorStore((s) => s.setTrackVolume);
  const setTrackHeight = useEditorStore((s) => s.setTrackHeight);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.label);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    if (!editing) setDraft(track.label);
  }, [track.label, editing]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      setTrackHeight(track.id, drag.startHeight + (e.clientY - drag.startY));
    };
    const onUp = () => {
      resizeRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [track.id, setTrackHeight]);

  const commitRename = () => {
    setEditing(false);
    if (draft.trim() && draft !== track.label) renameTrack(track.id, draft);
  };

  // Below these heights the row can't fit its controls without clipping them.
  const compact = track.height < 52;
  const showVolume = track.kind === 'audio' && track.height >= 64;

  return (
    <div
      className={`track-header track-header--${track.kind}${compact ? ' is-compact' : ''}`}
      style={{ height: track.height }}
    >
      <div className="track-header-top">
        {editing ? (
          <input
            className="track-name-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setDraft(track.label);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="track-name"
            title="Double-click to rename"
            onDoubleClick={() => setEditing(true)}
          >
            {track.label}
          </button>
        )}

        <div className="track-order">
          <button
            type="button"
            disabled={!canMoveUp}
            title={track.kind === 'video' ? 'Move layer up (draws later)' : 'Move track up'}
            onClick={() => moveTrack(track.id, -1)}
          >
            ▲
          </button>
          <button
            type="button"
            disabled={!canMoveDown}
            title={track.kind === 'video' ? 'Move layer down' : 'Move track down'}
            onClick={() => moveTrack(track.id, 1)}
          >
            ▼
          </button>
        </div>
      </div>

      <div className="track-header-controls">
        {track.kind === 'video' ? (
          <button
            type="button"
            className={track.hidden ? 'is-active' : ''}
            title={track.hidden ? 'Show this layer' : 'Hide this layer'}
            onClick={() => toggleTrackFlag(track.id, 'hidden')}
          >
            {track.hidden ? '🚫' : '👁'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={track.muted ? 'is-active' : ''}
              title="Mute track"
              onClick={() => toggleTrackFlag(track.id, 'muted')}
            >
              M
            </button>
            <button
              type="button"
              className={track.solo ? 'is-active' : ''}
              title="Solo track"
              onClick={() => toggleTrackFlag(track.id, 'solo')}
            >
              S
            </button>
          </>
        )}
        <button
          type="button"
          className={track.locked ? 'is-active' : ''}
          title={track.locked ? 'Unlock track' : 'Lock track'}
          onClick={() => toggleTrackFlag(track.id, 'locked')}
        >
          {track.locked ? '🔒' : '🔓'}
        </button>
        <button
          type="button"
          disabled={!canDelete}
          title={
            canDelete
              ? clipCount > 0
                ? `Delete track and ${clipCount} clip(s)`
                : 'Delete track'
              : 'The last track of a kind cannot be deleted'
          }
          onClick={() => removeTrack(track.id)}
        >
          ✕
        </button>
      </div>

      {showVolume && (
        <div className="track-volume">
          <input
            type="range"
            min={0}
            max={150}
            step={1}
            value={Math.round(track.volume * 100)}
            onChange={(e) => setTrackVolume(track.id, Number(e.target.value) / 100)}
            title="Track volume (0–150%)"
          />
          <span>{Math.round(track.volume * 100)}%</span>
        </div>
      )}

      <div
        className="track-resize"
        title="Drag to resize track"
        onPointerDown={(e) => {
          e.preventDefault();
          resizeRef.current = { startY: e.clientY, startHeight: track.height };
        }}
        onDoubleClick={() =>
          setTrackHeight(
            track.id,
            track.height > MIN_TRACK_HEIGHT + 4 ? MIN_TRACK_HEIGHT : Math.min(MAX_TRACK_HEIGHT, 76),
          )
        }
      />
    </div>
  );
}
