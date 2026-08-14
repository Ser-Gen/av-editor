import { useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { runExport } from '../export/runExport';
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
  const clips = useEditorStore((s) => s.clips);

  const setResolution = useEditorStore((s) => s.setResolution);
  const importFiles = useEditorStore((s) => s.importFiles);
  const setFfmpegStatus = useEditorStore((s) => s.setFfmpegStatus);

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

  const handleExport = async () => {
    try {
      await runExport();
    } catch (e) {
      logExportError(e, 'export (UI)');
    }
  };

  const statusLabel =
    ffmpegStatus === 'ready'
      ? 'FFmpeg: Ready'
      : ffmpegStatus === 'loading'
        ? 'FFmpeg: Loading…'
        : ffmpegStatus === 'error'
          ? `FFmpeg: ${ffmpegError ?? 'Error'}`
          : 'FFmpeg: Not loaded';

  return (
    <header className="toolbar">
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

      <span className="status" title="Large exports may be slow and memory-limited in the browser">
        {statusLabel}
        {exportProgress != null ? ` · Export ${exportProgress}%` : ''}
      </span>

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
        className="primary"
        onClick={() => void handleExport()}
        disabled={clips.length === 0 || exportProgress != null}
      >
        Export MP4
      </button>
    </header>
  );
}
