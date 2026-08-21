import { useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { countAnchored } from '../utils/reframe';
import { summarize } from '../utils/requantize';
import {
  CANVAS_PRESETS,
  FPS_CHOICES,
  aspectLabel,
  clampDimension,
  clampFps,
  encoderRejection,
  sameAspect,
} from '../utils/resolution';

interface Props {
  onClose: () => void;
}

/**
 * Project settings.
 *
 * The dialog's real job is the middle section: both of these settings can move work the user
 * already did, and neither consequence is visible from the control that causes it. Changing
 * the shape re-anchors every placed overlay and mask; changing the frame rate moves every clip
 * edge onto the new grid. Both are correct, both are undoable in one step, and both are stated
 * here *before* the Apply button rather than discovered afterwards.
 */
export function ProjectSettingsDialog({ onClose }: Props) {
  const settings = useEditorStore((s) => s.settings);
  const clips = useEditorStore((s) => s.clips);
  const setProjectSettings = useEditorStore((s) => s.setProjectSettings);

  const [width, setWidth] = useState(String(settings.width));
  const [height, setHeight] = useState(String(settings.height));
  const [fps, setFpsValue] = useState(String(settings.fps));
  const [rejection, setRejection] = useState<string | null>(null);

  const size = {
    width: clampDimension(Number(width)),
    height: clampDimension(Number(height)),
  };
  const nextFps = clampFps(Number(fps));
  const current = { width: settings.width, height: settings.height };

  const resized = size.width !== settings.width || size.height !== settings.height;
  const reshaped = resized && !sameAspect(current, size);
  const rateChanged = nextFps !== settings.fps;

  const anchored = useMemo(() => (reshaped ? countAnchored(clips) : 0), [reshaped, clips]);
  const requantized = useMemo(
    () => (rateChanged ? summarize(clips, nextFps) : null),
    [rateChanged, clips, nextFps],
  );

  // Asked of the encoder, not guessed from a table: the limit is the machine's, and it
  // differs between a laptop and the phone the same page might be open on.
  useEffect(() => {
    let live = true;
    setRejection(null);
    void encoderRejection(size.width, size.height, nextFps).then((message) => {
      if (live) setRejection(message);
    });
    return () => {
      live = false;
    };
  }, [size.width, size.height, nextFps]);

  const apply = () => {
    setProjectSettings({ ...size, fps: nextFps });
    onClose();
  };

  const presetValue = CANVAS_PRESETS.findIndex(
    (p) => p.width === size.width && p.height === size.height,
  );

  const groups = [...new Set(CANVAS_PRESETS.map((p) => p.group))];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-settings" onClick={(e) => e.stopPropagation()}>
        <h2>Project settings</h2>

        <label>Frame size</label>
        <select
          value={presetValue}
          onChange={(e) => {
            const preset = CANVAS_PRESETS[Number(e.target.value)];
            if (!preset) return;
            setWidth(String(preset.width));
            setHeight(String(preset.height));
          }}
        >
          {presetValue === -1 && <option value={-1}>Custom</option>}
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {CANVAS_PRESETS.map((preset, index) =>
                preset.group === group ? (
                  <option key={preset.label} value={index}>
                    {preset.label}
                  </option>
                ) : null,
              )}
            </optgroup>
          ))}
        </select>

        <div className="settings-size">
          <input
            type="number"
            aria-label="Width"
            value={width}
            min={16}
            step={2}
            onChange={(e) => setWidth(e.target.value)}
          />
          <span className="settings-times">×</span>
          <input
            type="number"
            aria-label="Height"
            value={height}
            min={16}
            step={2}
            onChange={(e) => setHeight(e.target.value)}
          />
          <button
            type="button"
            title="Swap width and height"
            onClick={() => {
              setWidth(height);
              setHeight(width);
            }}
          >
            ⇄
          </button>
        </div>
        <p className="settings-note">
          {size.width} × {size.height} · {aspectLabel(size.width, size.height)}
          {(size.width !== Number(width) || size.height !== Number(height)) &&
            ' · rounded to even numbers, which is all H.264 will encode'}
        </p>

        <label>Frame rate</label>
        <div className="settings-size">
          <select
            value={FPS_CHOICES.includes(nextFps as (typeof FPS_CHOICES)[number]) ? nextFps : 'custom'}
            onChange={(e) => {
              if (e.target.value !== 'custom') setFpsValue(e.target.value);
            }}
          >
            {FPS_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice} fps
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
          <input
            type="number"
            aria-label="Frame rate"
            value={fps}
            min={1}
            max={240}
            onChange={(e) => setFpsValue(e.target.value)}
          />
        </div>

        {reshaped && (
          <p className="settings-warning">
            {anchored === 0
              ? 'Changing the shape moves nothing: every clip is fit to the frame and will re-fit itself.'
              : `${anchored} clip${anchored === 1 ? '' : 's'} with placed overlays, text boxes or masks will be re-anchored to the new shape. Undo restores the shape and the framing together.`}
          </p>
        )}

        {requantized && requantized.clips > 0 && (
          <p className="settings-warning">
            {requantized.clips} clip{requantized.clips === 1 ? '' : 's'} sit between frames at{' '}
            {nextFps} fps and will move by up to {Math.round(requantized.maxShift * 1000)} ms —
            under one frame, in the same undo step.
          </p>
        )}

        {rejection && <p className="settings-warning settings-warning--hard">{rejection}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!resized && !rateChanged}
            onClick={apply}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
