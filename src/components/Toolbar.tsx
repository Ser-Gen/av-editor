import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { cancelExport, runExport } from '../export/runExport';
import { logExportError } from '../export/exportLog';
import { ProjectSettingsDialog } from './ProjectSettingsDialog';
import { ExportSettingsDialog } from './ExportSettingsDialog';
import { QUALITY_PRESETS } from '../utils/exportSettings';
import { AUDIO_FORMATS, audioSummary, resolveAudioExport } from '../utils/audioExport';

/**
 * History, project, export. Nothing else.
 *
 * `+ Video`, `+ Audio` and `+ Image` used to sit here beside the library's own `+ Import`,
 * which already takes all three at once and routes each file by what it is — so they were three
 * buttons that were strictly less capable than the one they duplicated. `+ Text` moved to the
 * library too, where it will become an object like any other. `Load FFmpeg` and
 * `Export (FFmpeg)` moved into the export dialog, which is where you are already looking when
 * either question comes up.
 */
export function Toolbar() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const settings = useEditorStore((s) => s.settings);
  const ffmpegStatus = useEditorStore((s) => s.ffmpegStatus);
  const ffmpegError = useEditorStore((s) => s.ffmpegError);
  const exportProgress = useEditorStore((s) => s.exportProgress);
  const exportEngine = useEditorStore((s) => s.exportEngine);
  const exportNotice = useEditorStore((s) => s.exportNotice);
  const clips = useEditorStore((s) => s.clips);
  const exportSettings = useEditorStore((s) => s.exportSettings);
  const forceFfmpeg = useEditorStore((s) => s.exportForceFfmpeg);
  const audioOnly = exportSettings.output === 'audio';

  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const undoLabel = useEditorStore((s) => s.past[s.past.length - 1]?.label ?? null);
  const redoLabel = useEditorStore((s) => s.future[s.future.length - 1]?.label ?? null);

  const handleExport = async () => {
    try {
      await runExport({ forceFfmpeg: forceFfmpeg && !audioOnly });
    } catch (e) {
      logExportError(e, 'export (UI)');
    }
  };

  const exporting = exportProgress != null;
  const engineLabel =
    exportEngine === 'webcodecs' ? 'WebCodecs' : exportEngine === 'ffmpeg' ? 'FFmpeg' : null;

  const statusLabel = exporting
    ? `${engineLabel ?? 'Export'} ${exportProgress}%`
    : ffmpegStatus === 'error'
      ? `FFmpeg: ${ffmpegError ?? 'Error'}`
      : ffmpegStatus === 'loading'
        ? 'FFmpeg: Loading…'
        : null;

  return (
    <header className="toolbar">
      <div className="toolbar-group">
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
      </div>

      <div className="spacer" />

      {/* Only speaks up when it has something to say; idle FFmpeg is not news. */}
      {statusLabel && (
        <span className="status" title={exportNotice ?? undefined}>
          {statusLabel}
        </span>
      )}
      {exportNotice && !exporting && <span className="export-notice">{exportNotice}</span>}

      <div className="toolbar-group">
        <button
          type="button"
          className="toolbar-settings"
          title="Frame size and frame rate"
          onClick={() => setSettingsOpen(true)}
        >
          {settings.width} × {settings.height} · {settings.fps} fps
        </button>
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          className="toolbar-settings"
          title={
            audioOnly
              ? 'Format, bitrate, engine and tags'
              : 'Quality, bitrate, output size, engine and tags'
          }
          onClick={() => setExportOpen(true)}
        >
          {audioOnly
            ? audioSummary(resolveAudioExport(exportSettings))
            : QUALITY_PRESETS[exportSettings.quality].label}
          {forceFfmpeg && !audioOnly && ' · FFmpeg'}
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
            title={clips.length === 0 ? 'Nothing on the timeline yet' : undefined}
          >
            {audioOnly ? `Export ${AUDIO_FORMATS[exportSettings.audioFormat].label}` : 'Export MP4'}
          </button>
        )}
      </div>

      {settingsOpen && <ProjectSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {exportOpen && <ExportSettingsDialog onClose={() => setExportOpen(false)} />}
    </header>
  );
}
