import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import {
  TOOL_GROUPS,
  TOOL_PRESETS,
  derivedName,
  estimateSeconds,
  findPreset,
  formatEstimate,
  outputDuration,
  replaceRefusal,
} from '../tools/presets';
import type { SourceRange } from '../tools/presets';
import type { ProcessJob } from '../types/editor';
import { clipDuration } from '../utils/time';
import { EFFECTS } from '../render/effects/registry';

const PHASE_LABEL: Record<ProcessJob['phase'], string> = {
  loading: 'Loading FFmpeg…',
  writing: 'Copying the file in…',
  running: 'Processing…',
  reading: 'Collecting the result…',
};

/**
 * Picking and running a preset, over a whole library file or over one clip's excerpt.
 *
 * The dialog spends most of its space on consequences, because the consequences are the
 * decision. Half of these presets finish before you let go of the mouse and half take longer
 * than the edit you were in the middle of, and nothing on the button tells the two apart. So
 * the cost is stated before the run — and so is what will happen to the clip, which is the
 * part that is hard to undo by hand.
 */
export function ProcessDialog({
  assetId,
  clipId,
  onClose,
}: {
  assetId: string;
  /** Set from the timeline: process this clip's excerpt, and offer to swap it in. */
  clipId?: string;
  onClose: () => void;
}) {
  const asset = useEditorStore((s) => s.mediaLibrary[assetId]);
  const clip = useEditorStore((s) => (clipId ? s.clips.find((c) => c.id === clipId) : undefined));
  const job = useEditorStore((s) => s.processJob);
  const notice = useEditorStore((s) => s.libraryNotice);
  const startProcess = useEditorStore((s) => s.startProcess);
  const addEffect = useEditorStore((s) => s.addEffect);
  const cancelProcess = useEditorStore((s) => s.cancelProcess);

  const [presetId, setPresetId] = useState(TOOL_PRESETS[0].id);
  const [replace, setReplace] = useState(clipId !== undefined);
  // Only this dialog's own job should close it — another one may already be running.
  const ours = useRef(false);

  const running = job !== null && ours.current;

  useEffect(() => {
    if (ours.current && job === null) onClose();
  }, [job, onClose]);

  if (!asset) return null;

  const preset = findPreset(presetId) ?? TOOL_PRESETS[0];

  // A clip already knows its excerpt as two numbers, so there is nothing to measure.
  const range: SourceRange | undefined =
    clip && 'assetId' in clip
      ? { start: clip.sourceTrimIn, duration: clipDuration(clip) }
      : undefined;
  const sourceSeconds = range ? range.duration : asset.duration;

  const refusal = replaceRefusal(preset);
  const canReplace = clipId !== undefined && refusal === null;
  const willReplace = canReplace && replace;
  const seconds = estimateSeconds(preset, sourceSeconds);
  const resultSeconds = outputDuration(preset, sourceSeconds);
  const lengthChanges = Math.abs(resultSeconds - sourceSeconds) > 0.05;
  const framed = clip && 'transform' in clip && clip.transform !== undefined;
  const busyElsewhere = job !== null && !ours.current;

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal modal-process" onClick={(e) => e.stopPropagation()}>
        <h2>{range ? 'Process this clip' : `Process “${asset.name}”`}</h2>

        {range && (
          <p className="settings-note">
            {sourceSeconds.toFixed(1)}s of “{asset.name}”, from {range.start.toFixed(1)}s. Only
            that much is decoded, so the estimate is for the cut and not the file.
          </p>
        )}

        <label>Preset</label>
        <select value={presetId} disabled={running} onChange={(e) => setPresetId(e.target.value)}>
          {TOOL_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {TOOL_PRESETS.filter((p) => p.group === group).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <p className="settings-note">{preset.description}</p>

        <p className={preset.slow ? 'settings-warning' : 'hint'}>
          Roughly {formatEstimate(seconds)} for {Math.round(sourceSeconds)}s of source
          {preset.slow
            ? ' — FFmpeg runs on one thread here, and this is one of the slow ones. You can cancel it at any point.'
            : '. The estimate is a rough guide, not a measurement.'}
        </p>

        {preset.caveat && <p className="settings-warning">{preset.caveat}</p>}

        {preset.gpu && (
          <div className="settings-warning">
            <p>
              The renderer already does this: {preset.gpu.instead}. It previews live, keyframes,
              and costs nothing until export — and it bakes to a file on the GPU in a fraction of
              this time. {preset.gpu.limit}
            </p>
            <p>
              Running the preset here uses FFmpeg's own filter instead. The two do not match
              exactly — FFmpeg filters in YUV and the renderer works in RGB, so they disagree in
              the shadows — which is why this is a choice rather than a substitution.
            </p>
            {clipId !== undefined && preset.gpu.effect && (
              <button
                type="button"
                disabled={running}
                onClick={() => {
                  addEffect(clipId, preset.gpu!.effect!);
                  onClose();
                }}
              >
                Add {EFFECTS[preset.gpu.effect].label} to this clip instead
              </button>
            )}
          </div>
        )}

        {clipId !== undefined && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={willReplace}
              disabled={running || !canReplace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            Put the result on the timeline in this clip's place
          </label>
        )}

        {clipId !== undefined && refusal && <p className="settings-warning">{refusal}</p>}

        {willReplace && lengthChanges && (
          <p className="settings-warning">
            This preset returns {resultSeconds.toFixed(1)}s from {sourceSeconds.toFixed(1)}s, so
            the clip will change length in place and leave a gap. Nothing after it on the track
            moves.
          </p>
        )}

        {willReplace && framed && preset.reshapes && (
          <p className="settings-warning">
            This clip is placed or masked, and the preset changes the frame's shape. Placements
            and masks are stored as fractions of the frame, so they stay where they are while the
            picture inside them moves.
          </p>
        )}

        <p className="hint">
          Adds “{derivedName(asset.name, preset, range)}” to the library
          {willReplace
            ? ', and points this clip at it. Undo restores the clip; the file stays in the library.'
            : `. “${asset.name}” is left exactly as it is.`}
        </p>

        {running && job && (
          <div className="process-progress">
            <div className="process-bar">
              <div className="process-bar-fill" style={{ width: `${job.progress}%` }} />
            </div>
            <span className="hint">
              {PHASE_LABEL[job.phase]} {job.progress}%
            </span>
          </div>
        )}

        {job && busyElsewhere && (
          <p className="settings-warning">
            “{job.label}” is already running. Presets run one at a time.
          </p>
        )}

        {!running && notice && <p className="settings-note">{notice}</p>}

        <div className="modal-actions">
          {running ? (
            <button type="button" onClick={cancelProcess}>
              Cancel
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                disabled={busyElsewhere}
                onClick={() => {
                  // The store may refuse (an export holds the same FFmpeg), and it refuses
                  // synchronously — so whether this dialog owns a job is knowable right here.
                  void startProcess({
                    presetId,
                    assetId,
                    range,
                    replaceClipId: willReplace ? clipId : undefined,
                  });
                  ours.current = useEditorStore.getState().processJob !== null;
                }}
              >
                Run
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
