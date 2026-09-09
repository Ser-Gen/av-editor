import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { formatDuration } from '../utils/time';

/**
 * Looking at a library file before committing it to the timeline.
 *
 * Deliberately its own `<video>`/`<audio>` element rather than anything borrowed from
 * `PlaybackEngine`: that pool is keyed to clips and seeks against the project clock, and
 * pointing it at a whole asset would fight the timeline for the same decoder. This element is
 * created when the popover opens and dropped when it closes.
 *
 * It also stops the moment timeline playback starts. Two things playing at once is never what
 * was meant, and the timeline is the one with the playhead.
 */
export function MediaPreview({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const asset = useEditorStore((s) => s.mediaLibrary[assetId]);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const ref = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const [time, setTime] = useState(0);

  // The timeline wins. Pausing rather than closing keeps the frame you were looking at.
  useEffect(() => {
    if (isPlaying) ref.current?.pause();
  }, [isPlaying]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!asset) return null;

  const duration = asset.duration || 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-preview" onClick={(e) => e.stopPropagation()}>
        <h2 title={asset.name}>{asset.name}</h2>

        {!asset.blobUrl && (
          <p className="settings-warning">
            This file is offline — there are no bytes to play. Relink it first.
          </p>
        )}

        {asset.blobUrl && asset.type === 'image' && (
          <img className="preview-media" src={asset.blobUrl} alt={asset.name} />
        )}

        {asset.blobUrl && asset.type === 'video' && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            ref={ref as React.RefObject<HTMLVideoElement>}
            className="preview-media"
            src={asset.blobUrl}
            controls
            autoPlay
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          />
        )}

        {asset.blobUrl && asset.type === 'audio' && (
          <audio
            ref={ref as React.RefObject<HTMLAudioElement>}
            className="preview-media preview-media--audio"
            src={asset.blobUrl}
            controls
            autoPlay
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          />
        )}

        <p className="settings-note">
          {asset.type === 'image'
            ? `${asset.width ?? '?'} × ${asset.height ?? '?'}`
            : `${formatDuration(time)} of ${formatDuration(duration)}`}
          {asset.type === 'video' && asset.width && ` · ${asset.width} × ${asset.height}`}
        </p>

        <div className="modal-actions">
          <button
            type="button"
            disabled={!asset.file}
            onClick={() => {
              useEditorStore.getState().addAssetToTimeline(assetId);
              onClose();
            }}
          >
            Add to timeline
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
