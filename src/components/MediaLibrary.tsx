import { useRef, useState } from 'react';
import { useCaptureSession } from '../capture/useCaptureSession';
import { RecordPanel } from './RecordPanel';
import { useEditorStore } from '../store/editorStore';
import { isAssetInUse } from '../store/clipFactory';
import type { AssetType } from '../types/editor';
import { inferAssetKind } from '../utils/assetKind';
import { VideoPoster } from './VideoPoster';
import { formatDuration } from '../utils/time';

const TYPE_LABEL: Record<AssetType, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
};

export function MediaLibrary() {
  const fileRef = useRef<HTMLInputElement>(null);
  const libraryOrder = useEditorStore((s) => s.libraryOrder);
  const mediaLibrary = useEditorStore((s) => s.mediaLibrary);
  const clips = useEditorStore((s) => s.clips);
  const importToLibrary = useEditorStore((s) => s.importToLibrary);
  const addAssetToTimeline = useEditorStore((s) => s.addAssetToTimeline);
  const removeLibraryItem = useEditorStore((s) => s.removeLibraryItem);
  const libraryNotice = useEditorStore((s) => s.libraryNotice);
  const capture = useCaptureSession();
  const recording = capture.phase === 'recording';
  const busy = capture.phase !== 'idle';
  // The panel stays open while a recording or a recovery offer is live, so neither can be
  // hidden by a stray click.
  const [panelOpen, setPanelOpen] = useState(false);
  const showPanel = panelOpen || busy || capture.orphans.length > 0;

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = [...list];

    const groups: Record<AssetType, File[]> = { video: [], audio: [], image: [] };
    for (const f of files) groups[inferAssetKind(f.name, f.type)].push(f);
    for (const kind of ['video', 'audio', 'image'] as const) {
      if (groups[kind].length > 0) await importToLibrary(groups[kind], kind);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <aside className="media-library">
      <div className="media-library-header">
        <h3>Media Library</h3>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={recording || busy}>
          + Import
        </button>
        <button
          type="button"
          className={recording ? 'btn-record-active' : undefined}
          aria-expanded={showPanel}
          title="Record screen, microphone and system audio (works during playback)"
          onClick={() => setPanelOpen((open) => !open)}
        >
          {recording ? 'Recording' : 'Record'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="video/*,audio/*,image/*"
          multiple
          hidden
          onChange={(e) => void onFiles(e.target.files)}
        />
      </div>

      <p className="hint">Import once, add to timeline many times.</p>
      {showPanel && <RecordPanel capture={capture} />}
      {libraryNotice && <p className="media-library-notice">{libraryNotice}</p>}

      <ul className="media-library-list">
        {libraryOrder.length === 0 && (
          <li className="media-library-empty">No media yet</li>
        )}
        {libraryOrder.map((id) => {
          const asset = mediaLibrary[id];
          if (!asset) return null;
          const inUse = isAssetInUse(id, clips);
          const duration = asset.type === 'image' ? '5s' : formatDuration(asset.duration);

          return (
            <li key={id} className={`media-library-item media-library-item--${asset.type}`}>
              {asset.type === 'video' && (
                <VideoPoster assetId={id} blobUrl={asset.blobUrl} alt={asset.name} />
              )}
              {asset.type === 'image' && (
                <img className="media-library-thumb" src={asset.blobUrl} alt={asset.name} />
              )}
              <div className="media-library-item-main">
                <span className="media-library-type">{TYPE_LABEL[asset.type]}</span>
                <span className="media-library-name" title={asset.name}>
                  {asset.name}
                </span>
                <span className="media-library-meta">{duration}</span>
              </div>
              <div className="media-library-actions">
                <button
                  type="button"
                  title="Add to timeline at playhead"
                  onClick={() => addAssetToTimeline(id)}
                >
                  +
                </button>
                <button
                  type="button"
                  title={inUse ? 'In use on timeline' : 'Remove from library'}
                  disabled={inUse}
                  onClick={() => removeLibraryItem(id)}
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
