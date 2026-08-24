import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import type { AudioFormat, ExportQuality, ExportSettings, MediaAsset } from '../types/editor';
import {
  QUALITY_PRESETS,
  applyQuality,
  derivedBitrate,
  estimateBytes,
  formatBitrate,
  resolveExport,
} from '../utils/exportSettings';
import {
  AUDIO_BITRATE_CHOICES,
  AUDIO_FORMATS,
  AUDIO_FORMAT_ORDER,
  AUDIO_SAMPLE_RATES,
  estimateAudioBytes,
  resolveAudioExport,
} from '../utils/audioExport';
import {
  EMPTY_AUDIO_METADATA,
  METADATA_TEXT_FIELDS,
  metadataFieldCount,
  metadataIsEmpty,
} from '../utils/audioMetadata';
import type { AudioMetadata } from '../utils/audioMetadata';
import { clampDimension, clampFps, sameAspect } from '../utils/resolution';

interface Props {
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** An empty box means "no number", not zero — a track numbered 0 is not a thing. */
function positiveOrNull(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Export settings.
 *
 * A preset is the whole answer for almost everyone, so the presets are the dialog and the
 * numbers are folded away behind one disclosure. The estimate under them is the point of the
 * screen: it is the difference between choosing a quality and discovering one.
 *
 * The output switch at the top is the one thing above the presets, because it changes what
 * every control below it means: a keyframe interval and an output size say nothing about a
 * file with no picture in it.
 */
export function ExportSettingsDialog({ onClose }: Props) {
  const project = useEditorStore((s) => s.settings);
  const stored = useEditorStore((s) => s.exportSettings);
  const storedMetadata = useEditorStore((s) => s.audioMetadata);
  const duration = useEditorStore((s) => s.getProjectDuration());
  const mediaLibrary = useEditorStore((s) => s.mediaLibrary);
  const libraryOrder = useEditorStore((s) => s.libraryOrder);
  const save = useEditorStore((s) => s.setExportSettings);
  const saveMetadata = useEditorStore((s) => s.setAudioMetadata);

  const [draft, setDraft] = useState<ExportSettings>(stored);
  const [metadata, setMetadata] = useState<AudioMetadata>(storedMetadata);
  const [advanced, setAdvanced] = useState(
    stored.videoBitrate !== null || stored.width !== null || stored.fps !== null,
  );
  // Open when there is something in it, so tags already typed are never hidden behind a triangle.
  const [tagsOpen, setTagsOpen] = useState(() => !metadataIsEmpty(storedMetadata));

  const audioOnly = draft.output === 'audio';
  const spec = resolveExport(draft, project);
  const audioSpec = resolveAudioExport(draft);
  const reshaped = !audioOnly && spec.scaled && !sameAspect(project, spec);
  const patch = (fields: Partial<ExportSettings>) => setDraft({ ...draft, ...fields });
  const patchMeta = (fields: Partial<AudioMetadata>) => setMetadata({ ...metadata, ...fields });

  const seconds = Math.max(duration, 1);
  const estimated = audioOnly ? estimateAudioBytes(audioSpec, seconds) : estimateBytes(spec, seconds);
  const images = libraryOrder
    .map((id) => mediaLibrary[id])
    .filter((a): a is MediaAsset => !!a && a.type === 'image');
  const cover = metadata.coverAssetId ? mediaLibrary[metadata.coverAssetId] : null;
  const tagCount = metadataFieldCount(metadata);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-settings" onClick={(e) => e.stopPropagation()}>
        <h2>Export settings</h2>

        <div className="output-switch">
          <button
            type="button"
            className={`output-option${audioOnly ? '' : ' is-on'}`}
            onClick={() => patch({ output: 'video' })}
          >
            Video (MP4)
          </button>
          <button
            type="button"
            className={`output-option${audioOnly ? ' is-on' : ''}`}
            onClick={() => patch({ output: 'audio' })}
          >
            Audio only
          </button>
        </div>

        {!audioOnly && (
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
        )}

        {audioOnly && (
          <div className="settings-advanced">
            <label htmlFor="audio-format">Format</label>
            <div className="settings-size">
              <select
                id="audio-format"
                value={draft.audioFormat}
                onChange={(e) => patch({ audioFormat: e.target.value as AudioFormat })}
              >
                {AUDIO_FORMAT_ORDER.map((format) => (
                  <option key={format} value={format}>
                    {AUDIO_FORMATS[format].label}
                  </option>
                ))}
              </select>
            </div>
            <p className="settings-note">{AUDIO_FORMATS[draft.audioFormat].description}</p>

            <label htmlFor="audio-bitrate">Bitrate</label>
            <div className="settings-size">
              <select
                id="audio-bitrate"
                value={draft.audioBitrate}
                disabled={audioSpec.lossless}
                onChange={(e) => patch({ audioBitrate: Number(e.target.value) })}
              >
                {AUDIO_BITRATE_CHOICES.map((bits) => (
                  <option key={bits} value={bits}>
                    {formatBitrate(bits)}
                  </option>
                ))}
              </select>
              {audioSpec.lossless && <span className="settings-times">lossless</span>}
            </div>

            <label htmlFor="audio-rate">Sample rate and channels</label>
            <div className="settings-size">
              <select
                id="audio-rate"
                value={draft.audioSampleRate}
                onChange={(e) => patch({ audioSampleRate: Number(e.target.value) })}
              >
                {AUDIO_SAMPLE_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {(rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz
                  </option>
                ))}
              </select>
              <select
                aria-label="Channels"
                value={draft.audioChannels}
                onChange={(e) => patch({ audioChannels: Number(e.target.value) })}
              >
                <option value={2}>Stereo</option>
                <option value={1}>Mono</option>
              </select>
            </div>
            <p className="settings-note">
              The mix renders at this rate, so nothing is resampled afterwards. The project's
              video settings are untouched by any of this.
            </p>
          </div>
        )}

        <p className="settings-note">
          {audioOnly
            ? `${AUDIO_FORMATS[draft.audioFormat].label} · about ${formatSize(estimated)}`
            : `${spec.width} × ${spec.height} · ${spec.fps} fps · about ${formatSize(estimated)}`}{' '}
          for {duration > 0 ? `${duration.toFixed(1)}s` : 'an empty project'}
          {audioOnly && draft.audioFormat === 'flac' && ' · FLAC size varies with the material'}
          {!audioOnly && draft.videoBitrate !== null && ' · bitrate set by hand'}
        </p>

        {!audioOnly && (
          <button type="button" className="disclosure" onClick={() => setAdvanced(!advanced)}>
            {advanced ? '▾' : '▸'} Advanced
          </button>
        )}

        {!audioOnly && advanced && (
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

        <button type="button" className="disclosure" onClick={() => setTagsOpen(!tagsOpen)}>
          {tagsOpen ? '▾' : '▸'} Tags{tagCount > 0 ? ` (${tagCount})` : ''}
        </button>

        {tagsOpen && (
          <div className="settings-advanced">
            <div className="metadata-grid">
              {METADATA_TEXT_FIELDS.map(({ key, label, multiline }) => (
                <div key={key} className="metadata-row">
                  <label htmlFor={`tag-${key}`}>{label}</label>
                  {multiline ? (
                    <textarea
                      id={`tag-${key}`}
                      rows={2}
                      value={metadata[key]}
                      onChange={(e) => patchMeta({ [key]: e.target.value } as Partial<AudioMetadata>)}
                    />
                  ) : (
                    <input
                      id={`tag-${key}`}
                      type="text"
                      value={metadata[key]}
                      onChange={(e) => patchMeta({ [key]: e.target.value } as Partial<AudioMetadata>)}
                    />
                  )}
                </div>
              ))}

              <div className="metadata-row">
                <label htmlFor="tag-track">Track</label>
                <div className="settings-size">
                  <input
                    id="tag-track"
                    type="number"
                    min={1}
                    value={metadata.trackNumber ?? ''}
                    onChange={(e) => patchMeta({ trackNumber: positiveOrNull(e.target.value) })}
                  />
                  <span className="settings-times">of</span>
                  <input
                    type="number"
                    aria-label="Tracks in total"
                    min={1}
                    value={metadata.tracksTotal ?? ''}
                    onChange={(e) => patchMeta({ tracksTotal: positiveOrNull(e.target.value) })}
                  />
                </div>
              </div>

              <div className="metadata-row">
                <label htmlFor="tag-disc">Disc</label>
                <div className="settings-size">
                  <input
                    id="tag-disc"
                    type="number"
                    min={1}
                    value={metadata.discNumber ?? ''}
                    onChange={(e) => patchMeta({ discNumber: positiveOrNull(e.target.value) })}
                  />
                  <span className="settings-times">of</span>
                  <input
                    type="number"
                    aria-label="Discs in total"
                    min={1}
                    value={metadata.discsTotal ?? ''}
                    onChange={(e) => patchMeta({ discsTotal: positiveOrNull(e.target.value) })}
                  />
                </div>
              </div>

              <div className="metadata-row">
                <label htmlFor="tag-date">Date</label>
                <input
                  id="tag-date"
                  type="date"
                  value={metadata.date}
                  onChange={(e) => patchMeta({ date: e.target.value })}
                />
              </div>

              <div className="metadata-row">
                <label htmlFor="tag-cover">Cover</label>
                <div className="settings-size">
                  <select
                    id="tag-cover"
                    value={metadata.coverAssetId ?? ''}
                    onChange={(e) => patchMeta({ coverAssetId: e.target.value || null })}
                  >
                    <option value="">None</option>
                    {images.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.name}
                      </option>
                    ))}
                  </select>
                  {cover?.blobUrl && <img className="metadata-cover" src={cover.blobUrl} alt="" />}
                </div>
              </div>
            </div>

            {images.length === 0 && (
              <p className="settings-note">
                Import an image to use it as cover art — the list is the library's images.
              </p>
            )}
            {cover && !cover.file && (
              <p className="settings-warning">
                "{cover.name}" is offline, so the cover would be left out. Relink it to include it.
              </p>
            )}

            <p className="settings-note">
              Written into whatever you export, audio or video. Tags are remembered while this tab
              is open, but they are not saved with the project.
            </p>

            <button
              type="button"
              className="disclosure"
              disabled={tagCount === 0}
              onClick={() => setMetadata({ ...EMPTY_AUDIO_METADATA })}
            >
              Clear tags
            </button>
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
              saveMetadata(metadata);
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
