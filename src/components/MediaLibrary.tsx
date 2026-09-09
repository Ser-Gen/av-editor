import { useEffect, useRef, useState } from 'react';
import { useCaptureSession } from '../capture/useCaptureSession';
import { RecordPanel } from './RecordPanel';
import { useEditorStore } from '../store/editorStore';
import { isAssetInUse } from '../store/clipFactory';
import type { AssetType, MediaAsset } from '../types/editor';
import { inferAssetKind } from '../utils/assetKind';
import { VideoPoster } from './VideoPoster';
import { ProcessDialog } from './ProcessDialog';
import { MediaInfoDialog } from './MediaInfoDialog';
import { LibraryContextMenu } from './LibraryContextMenu';
import type { LibraryMenuRequest } from './LibraryContextMenu';
import { formatDuration } from '../utils/time';
import { StorageBar } from './StorageBar';
import { ProjectFolderButtons } from './ProjectFolderButtons';
import { pickMediaFiles } from '../project/pickFiles';
import { formatBytes } from '../utils/storageBudget';
import { PanelTabs } from './PanelTabs';
import type { PanelTab } from './PanelTabs';
import { resolveTab } from '../utils/panelLayout';
import { LIBRARY_TAB_KEY, LIBRARY_VIEW_KEY } from '../project/projectStore';
import { MediaPreview } from './MediaPreview';
import { downloadFile, safeFileName } from '../utils/downloadFile';
import {
  DEFAULT_LIBRARY_VIEW,
  GROUP_LABELS,
  SORT_LABELS,
  arrangeLibrary,
} from '../utils/libraryView';
import type { LibraryGroup, LibrarySort, LibraryView } from '../utils/libraryView';

type LibraryTab = 'media' | 'record' | 'storage';

const LIBRARY_TABS: PanelTab<LibraryTab>[] = [
  { id: 'media', label: 'Media' },
  { id: 'record', label: 'Record' },
  { id: 'storage', label: 'Storage' },
];

/** Private drag type, so a row drag is never mistaken for a file arriving from the desktop. */
const ASSET_DRAG_TYPE = 'application/x-aww-asset';

const TYPE_LABEL: Record<AssetType, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
};

interface Props {
  width: number;
  /**
   * Text moved here from the top bar. For now it still opens the same modal and makes a clip;
   * phase 5 turns it into a library object like any other, which is why the button lives beside
   * `+ Import` rather than anywhere else.
   */
  onAddText: () => void;
}

export function MediaLibrary({ width, onAddText }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const libraryOrder = useEditorStore((s) => s.libraryOrder);
  const reorderLibrary = useEditorStore((s) => s.reorderLibrary);
  const textLibrary = useEditorStore((s) => s.textLibrary);
  const addTextObjectToTimeline = useEditorStore((s) => s.addTextObjectToTimeline);
  const duplicateTextObject = useEditorStore((s) => s.duplicateTextObject);
  const removeTextObject = useEditorStore((s) => s.removeTextObject);
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
  /** Which asset the info window is open for. */
  const [infoTarget, setInfoTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<LibraryMenuRequest | null>(null);
  /** Which asset the preview popover is open for. */
  const [previewTarget, setPreviewTarget] = useState<string | null>(null);
  const relinkFiles = useEditorStore((s) => s.relinkFiles);
  const relinkAsset = useEditorStore((s) => s.relinkAsset);
  const readOnly = useEditorStore((s) => s.readOnly);
  const offlineCount = libraryOrder.filter((id) => mediaLibrary[id] && !mediaLibrary[id].file).length;
  const capture = useCaptureSession();
  const recording = capture.phase === 'recording';
  const busy = capture.phase !== 'idle';

  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const [tab, setTab] = useState<LibraryTab>(
    () => (localStorage.getItem(LIBRARY_TAB_KEY) as LibraryTab) ?? 'media',
  );

  /*
    Arrangement is a view, not an edit: `libraryOrder` is inside `docSnapshot()` and undoing
    must undo your last edit, never the fact that you decided to look at things by date. So it
    is kept here and in localStorage, and never reaches the document.
  */
  const [view, setView] = useState<LibraryView>(() => {
    try {
      const raw = localStorage.getItem(LIBRARY_VIEW_KEY);
      return raw ? { ...DEFAULT_LIBRARY_VIEW, ...(JSON.parse(raw) as Partial<LibraryView>) } : DEFAULT_LIBRARY_VIEW;
    } catch {
      return DEFAULT_LIBRARY_VIEW;
    }
  });
  useEffect(() => {
    try {
      // The query is deliberately not stored: coming back to a library that is filtered by
      // something typed last week reads as an empty library.
      localStorage.setItem(LIBRARY_VIEW_KEY, JSON.stringify({ ...view, query: '' }));
    } catch {
      // Storage disabled; the arrangement simply will not be remembered.
    }
  }, [view]);
  const active = resolveTab(LIBRARY_TABS.map((t) => t.id), tab) ?? 'media';
  useEffect(() => {
    localStorage.setItem(LIBRARY_TAB_KEY, active);
  }, [active]);

  // A capture in progress, or a crash leftover waiting to be claimed, is the one thing that
  // must not sit unseen behind a tab. It is pulled forward rather than merely dotted: both
  // states have a control the user is expected to reach.
  const wantsRecordTab = busy || capture.orphans.length > 0;
  useEffect(() => {
    if (wantsRecordTab) setTab('record');
  }, [wantsRecordTab]);

  /*
    An image off the clipboard, anywhere in the app except a text field — pasting into the
    filename box you are typing in must paste text. The store writes it to OPFS, because a
    pasted image never had a path and can never be relinked.
  */
  const pasteImages = useEditorStore((s) => s.pasteImages);
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || /^(input|textarea|select)$/i.test(target?.tagName ?? '')) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return;
      e.preventDefault();
      setTab('media');
      void pasteImages(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [pasteImages]);

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

  const sections = arrangeLibrary(
    libraryOrder.map((id) => mediaLibrary[id]).filter((a): a is NonNullable<typeof a> => !!a),
    view,
  );

  const renderRow = (asset: MediaAsset) => {
    const id = asset.id;
          const inUse = isAssetInUse(id, clips);
          const duration = asset.type === 'image' ? '5s' : formatDuration(asset.duration);
          // Dragging only means something when the list is in the order you put it in. Under
          // any other sort the row would spring back to where the sort says it goes, which
          // reads as the drag having failed.
          const orderable = view.sort === 'custom';

          return (
            <li
              key={id}
              className={`media-library-item media-library-item--${asset.type}${
                dragging === id ? ' is-dragging' : ''
              }${dropTarget === id ? ' is-drop-target' : ''}`}
              draggable={orderable}
              onDragStart={(e) => {
                if (!orderable) return;
                // A private type, so the window-level handler that swallows stray file drops
                // can tell this apart from a file arriving from the desktop.
                e.dataTransfer.setData(ASSET_DRAG_TYPE, id);
                e.dataTransfer.effectAllowed = 'move';
                setDragging(id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
              onDragOver={(e) => {
                if (!orderable || !dragging || dragging === id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropTarget(id);
              }}
              onDragLeave={() => setDropTarget((current) => (current === id ? null : current))}
              onDrop={(e) => {
                if (!orderable) return;
                e.preventDefault();
                e.stopPropagation();
                const moved = e.dataTransfer.getData(ASSET_DRAG_TYPE) || dragging;
                setDragging(null);
                setDropTarget(null);
                if (moved && moved !== id) reorderLibrary(moved, id);
              }}
              onContextMenu={(e) => {
                // Was video-only and opened the preset dialog outright. Every file now has
                // something worth reaching by right-click, so it opens a menu instead.
                e.preventDefault();
                setMenu({ assetId: id, x: e.clientX, y: e.clientY });
              }}
            >
              {!asset.file && <span className="media-library-thumb is-offline" title="Offline" />}
              {/* Hover scrubs, click opens the full preview. */}
              {asset.type === 'video' && asset.blobUrl && (
                <button
                  type="button"
                  className="media-library-thumb-button"
                  title="Hover to scrub · click to preview"
                  onClick={() => setPreviewTarget(id)}
                >
                  <VideoPoster
                    assetId={id}
                    blobUrl={asset.blobUrl}
                    alt={asset.name}
                    scrub
                    duration={asset.duration}
                  />
                </button>
              )}
              {asset.type === 'image' && asset.blobUrl && (
                <button
                  type="button"
                  className="media-library-thumb-button"
                  title="Preview"
                  onClick={() => setPreviewTarget(id)}
                >
                  <img className="media-library-thumb" src={asset.blobUrl} alt={asset.name} />
                </button>
              )}
              {asset.type === 'audio' && asset.blobUrl && (
                <button
                  type="button"
                  className="media-library-thumb-button media-library-thumb--audio"
                  title="Listen"
                  onClick={() => setPreviewTarget(id)}
                >
                  ♪
                </button>
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
                    Every online file is sized, not only the ones this app made. The size was
                    once here just to find what was filling the OPFS quota, which imported
                    media never does — but "how big is this" is a question about a file, not
                    about where it came from, and the alternative was opening the info window.
                  */}
                  {asset.file && ` · ${formatBytes(asset.file.size)}`}
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
                <button
                  type="button"
                  title="What is in this file"
                  onClick={() => setInfoTarget(id)}
                >
                  ℹ
                </button>
                <button
                  type="button"
                  title={
                    asset.file
                      ? 'Save a copy of this file, exactly as it is'
                      : 'Offline — there are no bytes to save'
                  }
                  disabled={!asset.file}
                  onClick={() => asset.file && downloadFile(asset.file, safeFileName(asset.name))}
                >
                  ⤓
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
  };

  return (
    <aside className="media-library" style={{ width }}>
      <div className="media-library-header">
        <h3>Library</h3>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={recording || busy}>
          + Import
        </button>
        <button type="button" title="Add a text clip at the playhead" onClick={onAddText}>
          + Text
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

      <PanelTabs
        tabs={LIBRARY_TABS.map((t) =>
          t.id === 'record' && recording ? { ...t, label: 'Recording', marked: true } : t,
        )}
        active={active}
        onSelect={setTab}
      />

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

      {/* Never tucked behind a tab: it explains why nothing anywhere is being saved. */}
      {readOnly && (
        <p className="media-library-notice is-warning">
          Open in another tab — nothing here is being saved.
        </p>
      )}
      {libraryNotice && <p className="media-library-notice">{libraryNotice}</p>}

      {active === 'storage' && (
        <>
          <StorageBar />
          <ProjectFolderButtons />
        </>
      )}

      {active === 'record' && <RecordPanel capture={capture} />}

      {active === 'media' && processJob && (
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

      {infoTarget && <MediaInfoDialog assetId={infoTarget} onClose={() => setInfoTarget(null)} />}

      {previewTarget && (
        <MediaPreview assetId={previewTarget} onClose={() => setPreviewTarget(null)} />
      )}

      {menu && (
        <LibraryContextMenu
          request={menu}
          onClose={() => setMenu(null)}
          onInfo={setInfoTarget}
          onPreset={setProcessTarget}
          onRelink={(id) =>
            void pickMediaFiles(false).then((picked) => {
              if (picked[0]) void relinkAsset(id, picked[0].file);
            })
          }
        />
      )}

      {active === 'media' && (
        <div className="library-view">
          <input
            className="library-search"
            type="search"
            placeholder="Search"
            value={view.query}
            onChange={(e) => setView({ ...view, query: e.target.value })}
          />
          <select
            value={view.group}
            title="Group the list"
            onChange={(e) => setView({ ...view, group: e.target.value as LibraryGroup })}
          >
            {(Object.keys(GROUP_LABELS) as LibraryGroup[]).map((g) => (
              <option key={g} value={g}>
                {GROUP_LABELS[g]}
              </option>
            ))}
          </select>
          <select
            value={view.sort}
            title="Sort within each group"
            onChange={(e) => setView({ ...view, sort: e.target.value as LibrarySort })}
          >
            {(Object.keys(SORT_LABELS) as LibrarySort[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="library-sort-dir"
            disabled={view.sort === 'custom'}
            title={
              view.sort === 'custom'
                ? 'Your own order has no direction — drag rows to change it'
                : view.direction === 'asc'
                  ? 'Ascending'
                  : 'Descending'
            }
            onClick={() =>
              setView({ ...view, direction: view.direction === 'asc' ? 'desc' : 'asc' })
            }
          >
            {view.direction === 'asc' ? '↑' : '↓'}
          </button>
        </div>
      )}

      {active === 'media' && (
        <p className="hint media-library-lede">
          Import once, add to timeline many times.
          {view.sort === 'custom' && libraryOrder.length > 1 && ' Drag a row to reorder.'}
        </p>
      )}

      {active === 'media' && (
        <div className="media-library-list">
          {textLibrary.length > 0 && view.query.trim() === '' && (
            <section className="library-section">
              <h4 className="library-section-head">
                Text
                <span>{textLibrary.length}</span>
              </h4>
              <ul>
                {textLibrary.map((object) => (
                  <li key={object.id} className="media-library-item media-library-item--text">
                    <span className="media-library-thumb media-library-thumb--text">T</span>
                    <div className="media-library-item-main">
                      <span className="media-library-type">Text</span>
                      <span className="media-library-name" title={object.text}>
                        {object.name}
                      </span>
                      <span className="media-library-meta">{object.template}</span>
                    </div>
                    <div className="media-library-actions">
                      <button
                        type="button"
                        title="Add to timeline at playhead"
                        onClick={() => addTextObjectToTimeline(object.id)}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        title="Make an independent copy"
                        onClick={() => duplicateTextObject(object.id)}
                      >
                        ⧉
                      </button>
                      <button
                        type="button"
                        title="Remove from the library. Clips already using it keep their words"
                        onClick={() => removeTextObject(object.id)}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {libraryOrder.length === 0 && textLibrary.length === 0 && (
            <p className="media-library-empty">No media yet</p>
          )}
          {libraryOrder.length > 0 && sections.length === 0 && (
            <p className="media-library-empty">Nothing matches “{view.query}”.</p>
          )}
          {sections.map((section) => (
            <section key={section.label || 'all'} className="library-section">
              {section.label && (
                <h4 className="library-section-head">
                  {section.label}
                  <span>{section.assets.length}</span>
                </h4>
              )}
              <ul>{section.assets.map(renderRow)}</ul>
            </section>
          ))}
        </div>
      )}

    </aside>
  );
}
