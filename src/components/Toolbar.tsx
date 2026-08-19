import { useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { cancelExport, runExport } from '../export/runExport';
import { loadFfmpeg } from '../export/ffmpegLoader';
import { formatExportError, logExportError } from '../export/exportLog';
import type { ResolutionPreset } from '../types/editor';

interface Props {
  onAddText: () => void;
}

export function Toolbar({ onAddText }: Props) {
  const videoRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  const resolution = useEditorStore((s) => s.settings.resolution);
  const ffmpegStatus = useEditorStore((s) => s.ffmpegStatus);
  const ffmpegError = useEditorStore((s) => s.ffmpegError);
  const exportProgress = useEditorStore((s) => s.exportProgress);
  const exportEngine = useEditorStore((s) => s.exportEngine);
  const exportNotice = useEditorStore((s) => s.exportNotice);
  const clips = useEditorStore((s) => s.clips);

  const setResolution = useEditorStore((s) => s.setResolution);
  const importFiles = useEditorStore((s) => s.importFiles);
  const setFfmpegStatus = useEditorStore((s) => s.setFfmpegStatus);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const undoLabel = useEditorStore((s) => s.past[s.past.length - 1]?.label ?? null);
  const redoLabel = useEditorStore((s) => s.future[s.future.length - 1]?.label ?? null);

  const handlePreload = async () => {
    setFfmpegStatus('loading');
    try {
      await loadFfmpeg();
      setFfmpegStatus('ready');
    } catch (e) {
      const msg = formatExportError(e);
      logExportError(e, 'load');
      setFfmpegStatus('error', msg);
    }
  };

  const handleExport = async (forceFfmpeg = false) => {
    try {
      await runExport({ forceFfmpeg });
    } catch (e) {
      logExportError(e, 'export (UI)');
    }
  };

  const exporting = exportProgress != null;
  const engineLabel =
    exportEngine === 'webcodecs' ? 'WebCodecs' : exportEngine === 'ffmpeg' ? 'FFmpeg' : null;

  const statusLabel = exporting
    ? `${engineLabel ?? 'Export'} ${exportProgress}%`
    : ffmpegStatus === 'ready'
      ? 'FFmpeg: Ready'
      : ffmpegStatus === 'loading'
        ? 'FFmpeg: Loading…'
        : ffmpegStatus === 'error'
          ? `FFmpeg: ${ffmpegError ?? 'Error'}`
          : 'FFmpeg: Not loaded';

  return (
    <header className="toolbar">
      <button
        type="button"
        disabled={!undoLabel}
        title={undoLabel ? `Undo: ${undoLabel} (⌘Z)` : 'Nothing to undo'}
        onClick={() => undo()}
      >
        ↶ Undo
      </button>
      <button
        type="button"
        disabled={!redoLabel}
        title={redoLabel ? `Redo: ${redoLabel} (⇧⌘Z)` : 'Nothing to redo'}
        onClick={() => redo()}
      >
        ↷ Redo
      </button>
      <span className="toolbar-divider" />
      <button type="button" onClick={() => videoRef.current?.click()}>
        + Video
      </button>
      <input
        ref={videoRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files, 'video');
          e.target.value = '';
        }}
      />
      <button type="button" onClick={() => audioRef.current?.click()}>
        + Audio
      </button>
      <input
        ref={audioRef}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files, 'audio');
          e.target.value = '';
        }}
      />
      <button type="button" onClick={() => imageRef.current?.click()}>
        + Image
      </button>
      <input
        ref={imageRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files, 'image');
          e.target.value = '';
        }}
      />
      <button type="button" onClick={onAddText}>
        + Text
      </button>

      <div className="spacer" />

      <span
        className="status"
        title={exportNotice ?? 'Exports use WebCodecs when available, otherwise FFmpeg WASM'}
      >
        {statusLabel}
      </span>
      {exportNotice && !exporting && <span className="export-notice">{exportNotice}</span>}

      <button type="button" onClick={() => void handlePreload()} disabled={ffmpegStatus === 'loading'}>
        Load FFmpeg
      </button>

      <label className="toolbar-resolution">
        Resolution
        <select
          value={resolution}
          onChange={(e) => setResolution(e.target.value as ResolutionPreset)}
        >
          <option value="480p">480p</option>
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="4K">4K</option>
        </select>
      </label>

      <button
        type="button"
        title="Force the FFmpeg pipeline instead of WebCodecs"
        onClick={() => void handleExport(true)}
        disabled={clips.length === 0 || exporting}
      >
        Export (FFmpeg)
      </button>

      {exporting ? (
        <button type="button" className="primary" onClick={() => cancelExport()}>
          Cancel
        </button>
      ) : (
        <button
          type="button"
          className="primary"
          onClick={() => void handleExport()}
          disabled={clips.length === 0}
        >
          Export MP4
        </button>
      )}
    </header>
  );
}
