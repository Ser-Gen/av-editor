import { useRef, useState } from 'react';
import { useCaptureSession } from '../capture/useCaptureSession';
import { RecordPanel } from './RecordPanel';
import { useEditorStore } from '../store/editorStore';
import { isAssetInUse } from '../store/clipFactory';
import type { AssetType } from '../types/editor';
import { inferAssetKind } from '../utils/assetKind';
import { VideoPoster } from './VideoPoster';
import { ProcessDialog } from './ProcessDialog';
import { formatDuration } from '../utils/time';
import { StorageBar } from './StorageBar';
import { ProjectFolderButtons } from './ProjectFolderButtons';
import { pickMediaFiles } from '../project/pickFiles';
import { formatBytes } from '../utils/storageBudget';

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
  const processJob = useEditorStore((s) => s.processJob);
  const cancelProcess = useEditorStore((s) => s.cancelProcess);
  /** Which asset the preset dialog is open for. */
  const [processTarget, setProcessTarget] = useState<string | null>(null);
  const relinkFiles = useEditorStore((s) => s.relinkFiles);
  const relinkAsset = useEditorStore((s) => s.relinkAsset);
  const readOnly = useEditorStore((s) => s.readOnly);
  const offlineCount = libraryOrder.filter((id) => mediaLibrary[id] && !mediaLibrary[id].file).length;
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

      {/*
        Relinking is one picker for the whole project rather than one per file: imported
        media is never copied, so this is the path every reopened project takes, and doing it
        file by file would make reopening a chore rather than a click.
      */}
      {offlineCount > 0 && (
        <div className="media-library-offline">
          <span>
            {offlineCount} file(s) offline — imported media lives on your disk, not in the
            browser.
          </span>
          <button type="button" onClick={() =>
              void pickMediaFiles(true).then((files) => {
                if (files.length > 0) void relinkFiles(files);
              })
            }>
            Relink…
          </button>
        </div>
      )}

      {readOnly && (
        <p className="media-library-notice is-warning">
          Open in another tab — nothing here is being saved.
        </p>
      )}

      <StorageBar />
      <ProjectFolderButtons />

      <p className="hint">Import once, add to timeline many times.</p>
      {showPanel && <RecordPanel capture={capture} />}
      {libraryNotice && <p className="media-library-notice">{libraryNotice}</p>}

      {processJob && (
        <div className="process-running">
          <div className="process-bar">
            <div className="process-bar-fill" style={{ width: `${processJob.progress}%` }} />
          </div>
          <span className="media-library-name" title={processJob.label}>
            {processJob.label}
          </span>
          <button type="button" title="Stop this preset" onClick={cancelProcess}>
            Cancel
          </button>
        </div>
      )}

      {processTarget && (
        <ProcessDialog assetId={processTarget} onClose={() => setProcessTarget(null)} />
      )}

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
            <li
              key={id}
              className={`media-library-item media-library-item--${asset.type}`}
              onContextMenu={(e) => {
                if (asset.type !== 'video') return;
                e.preventDefault();
                setProcessTarget(id);
              }}
            >
              {!asset.file && <span className="media-library-thumb is-offline" title="Offline" />}
              {asset.type === 'video' && asset.blobUrl && (
                <VideoPoster assetId={id} blobUrl={asset.blobUrl} alt={asset.name} />
              )}
              {asset.type === 'image' && asset.blobUrl && (
                <img className="media-library-thumb" src={asset.blobUrl} alt={asset.name} />
              )}
              <div className="media-library-item-main">
                <span className="media-library-type">{TYPE_LABEL[asset.type]}</span>
                <span className="media-library-name" title={asset.name}>
                  {asset.name}
                </span>
                <span className="media-library-meta">
                  {duration}
                  {asset.derivedFrom && ` · ${asset.derivedFrom.presetLabel}`}
                  {/*
                    Only files this app produced are sized here. They are the ones taking up
                    the quota — imported media is never copied — and deletion never cascades
                    to them, so without a size the largest reclaimable files are unfindable.
                  */}
                  {asset.origin !== 'imported' && asset.file && ` · ${formatBytes(asset.file.size)}`}
                  {!asset.file && ' · offline'}
                </span>
              </div>
              <div className="media-library-actions">
                {!asset.file && (
                  <button
                    type="button"
                    title={`Find ${asset.name} on disk`}
                    onClick={() =>
                      void pickMediaFiles(false).then((picked) => {
                        if (picked[0]) void relinkAsset(id, picked[0].file);
                      })
                    }
                  >
                    Relink
                  </button>
                )}
                <button
                  type="button"
                  title="Add to timeline at playhead"
                  disabled={!asset.file}
                  onClick={() => addAssetToTimeline(id)}
                >
                  +
                </button>
                {asset.type === 'video' && (
                  <button
                    type="button"
                    title="Process with a preset (right-click works too)"
                    disabled={processJob !== null}
                    onClick={() => setProcessTarget(id)}
                  >
                    ⚙
                  </button>
                )}
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
