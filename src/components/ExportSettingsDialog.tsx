import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import type { ExportQuality, ExportSettings } from '../types/editor';
import {
  QUALITY_PRESETS,
  applyQuality,
  derivedBitrate,
  estimateBytes,
  formatBitrate,
  resolveExport,
} from '../utils/exportSettings';
import { clampDimension, clampFps, sameAspect } from '../utils/resolution';

interface Props {
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Export settings.
 *
 * A preset is the whole answer for almost everyone, so the presets are the dialog and the
 * numbers are folded away behind one disclosure. The estimate under them is the point of the
 * screen: it is the difference between choosing a quality and discovering one.
 */
export function ExportSettingsDialog({ onClose }: Props) {
  const project = useEditorStore((s) => s.settings);
  const stored = useEditorStore((s) => s.exportSettings);
  const duration = useEditorStore((s) => s.getProjectDuration());
  const save = useEditorStore((s) => s.setExportSettings);

  const [draft, setDraft] = useState<ExportSettings>(stored);
  const [advanced, setAdvanced] = useState(
    stored.videoBitrate !== null || stored.width !== null || stored.fps !== null,
  );

  const spec = resolveExport(draft, project);
  const reshaped = spec.scaled && !sameAspect(project, spec);
  const patch = (fields: Partial<ExportSettings>) => setDraft({ ...draft, ...fields });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-settings" onClick={(e) => e.stopPropagation()}>
        <h2>Export settings</h2>

        <div className="quality-list">
          {(Object.keys(QUALITY_PRESETS) as ExportQuality[]).map((quality) => {
            const preset = QUALITY_PRESETS[quality];
            return (
              <button
                key={quality}
                type="button"
                className={`quality-option${draft.quality === quality ? ' is-on' : ''}`}
                onClick={() => setDraft(applyQuality(draft, quality))}
              >
                <span className="quality-name">{preset.label}</span>
                <span className="quality-rate">
                  {formatBitrate(derivedBitrate(quality, spec.width, spec.height, spec.fps))}
                </span>
                <span className="quality-note">{preset.description}</span>
              </button>
            );
          })}
        </div>

        <p className="settings-note">
          {spec.width} × {spec.height} · {spec.fps} fps · about{' '}
          {formatSize(estimateBytes(spec, Math.max(duration, 1)))} for{' '}
          {duration > 0 ? `${duration.toFixed(1)}s` : 'an empty project'}
          {draft.videoBitrate !== null && ' · bitrate set by hand'}
        </p>

        <button type="button" className="disclosure" onClick={() => setAdvanced(!advanced)}>
          {advanced ? '▾' : '▸'} Advanced
        </button>

        {advanced && (
          <div className="settings-advanced">
            <label>Video bitrate</label>
            <div className="settings-size">
              <input
                type="number"
                aria-label="Video bitrate in kbps"
                value={Math.round(spec.videoBitrate / 1000)}
                min={100}
                step={100}
                onChange={(e) => patch({ videoBitrate: Math.max(100_000, Number(e.target.value) * 1000) })}
              />
              <span className="settings-times">kbps</span>
              <button
                type="button"
                disabled={draft.videoBitrate === null}
                onClick={() => patch({ videoBitrate: null })}
                title="Go back to the preset's bitrate for this frame size"
              >
                Reset
              </button>
            </div>

            <label>Keyframe interval</label>
            <div className="settings-size">
              <input
                type="number"
                aria-label="Keyframe interval in seconds"
                value={draft.keyframeInterval}
                min={0.5}
                max={10}
                step={0.5}
                onChange={(e) =>
                  patch({ keyframeInterval: Math.min(10, Math.max(0.5, Number(e.target.value))) })
                }
              />
              <span className="settings-times">seconds</span>
            </div>
            <p className="settings-note">
              Shorter seeks more precisely and costs size. Longer is smaller and scrubs in jumps.
            </p>

            <label>Audio</label>
            <div className="settings-size">
              <select
                value={draft.audioBitrate}
                onChange={(e) => patch({ audioBitrate: Number(e.target.value) })}
              >
                <option value={128_000}>128 kbps</option>
                <option value={192_000}>192 kbps</option>
                <option value={256_000}>256 kbps</option>
                <option value={320_000}>320 kbps</option>
              </select>
              <select
                value={draft.audioChannels}
                onChange={(e) => patch({ audioChannels: Number(e.target.value) })}
              >
                <option value={2}>Stereo</option>
                <option value={1}>Mono</option>
              </select>
            </div>

            <label>Output size</label>
            <div className="settings-size">
              <input
                type="number"
                aria-label="Output width"
                value={spec.width}
                min={16}
                step={2}
                onChange={(e) => {
                  const width = clampDimension(Number(e.target.value));
                  // Height follows, because an export may scale but not reshape — offering two
                  // free numbers here would only be offering a way to be refused.
                  patch({ width, height: clampDimension((width * project.height) / project.width) });
                }}
              />
              <span className="settings-times">×</span>
              <input type="number" aria-label="Output height" value={spec.height} readOnly />
              <button
                type="button"
                disabled={draft.width === null && draft.height === null}
                onClick={() => patch({ width: null, height: null })}
              >
                Reset
              </button>
            </div>

            <label>Output frame rate</label>
            <div className="settings-size">
              <input
                type="number"
                aria-label="Output frame rate"
                value={spec.fps}
                min={1}
                max={240}
                onChange={(e) => patch({ fps: clampFps(Number(e.target.value)) })}
              />
              <span className="settings-times">fps</span>
              <button type="button" disabled={draft.fps === null} onClick={() => patch({ fps: null })}>
                Reset
              </button>
            </div>
            <p className="settings-note">
              The project stays {project.width} × {project.height} at {project.fps} fps. This only
              changes the file.
            </p>
          </div>
        )}

        {reshaped && (
          <p className="settings-warning settings-warning--hard">
            An export can be scaled but not reshaped. Change the frame size in project settings,
            which re-anchors overlays and masks to match.
          </p>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={reshaped}
            onClick={() => {
              save(draft);
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
