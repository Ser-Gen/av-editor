import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { descriptorFor } from '../render/effects/registry';
import { clipDuration } from '../utils/time';
import { bakeSize } from '../tools/bakeClip';

/**
 * Baking a clip's effect chain into a file, on the GPU.
 *
 * The counterpart to the FFmpeg preset dialog, and the reason it is a separate one: there is
 * nothing to choose. A bake takes the chain the clip already has and renders it through the
 * compositor that has been drawing it all along, so the only questions are where the result
 * goes and what is deliberately left out of it.
 */
export function BakeDialog({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  const clip = useEditorStore((s) => s.clips.find((c) => c.id === clipId));
  const asset = useEditorStore((s) =>
    clip && 'assetId' in clip ? s.mediaLibrary[clip.assetId] : undefined,
  );
  const settings = useEditorStore((s) => s.settings);
  const job = useEditorStore((s) => s.processJob);
  const notice = useEditorStore((s) => s.libraryNotice);
  const startBake = useEditorStore((s) => s.startBake);
  const cancelProcess = useEditorStore((s) => s.cancelProcess);

  const [replace, setReplace] = useState(true);
  const ours = useRef(false);
  const running = job !== null && ours.current;

  useEffect(() => {
    if (ours.current && job === null) onClose();
  }, [job, onClose]);

  if (!clip || !asset) return null;

  const effects = (clip.effects ?? []).filter((e) => e.enabled);
  const duration = clipDuration(clip);
  const size = bakeSize(asset, settings);
  const placed = 'transform' in clip && clip.transform !== undefined;
  const faded = (clip.fadeIn ?? 0) > 0 || (clip.fadeOut ?? 0) > 0;
  const busyElsewhere = job !== null && !ours.current;

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal modal-process" onClick={(e) => e.stopPropagation()}>
        <h2>Bake effects to a file</h2>

        <p className="settings-note">
          {duration.toFixed(1)}s at {size.width} × {size.height}, rendered by the same compositor
          that draws the preview and encoded in hardware. No FFmpeg, and no second
          implementation of any effect.
        </p>

        {effects.length === 0 ? (
          <p className="settings-warning">
            This clip has no enabled effects, so the bake is a straight re-encode of the
            excerpt. Useful for pinning down a cut; not useful for anything else.
          </p>
        ) : (
          <>
            <label>Baking in</label>
            <ol className="bake-list">
              {effects.map((effect) => {
                const desc = descriptorFor(effect);
                return <li key={effect.id}>{desc ? desc.label : effect.type}</li>;
              })}
            </ol>
          </>
        )}

        <label className="checkbox">
          <input
            type="checkbox"
            checked={replace}
            disabled={running}
            onChange={(e) => setReplace(e.target.checked)}
          />
          Put the result on the timeline in this clip's place
        </label>

        {replace && effects.length > 0 && (
          <p className="settings-warning">
            The effect chain comes off the clip when the file takes its place — the effects are
            in the file now, and leaving them on would apply every one of them twice.
          </p>
        )}

        {(placed || faded) && (
          <p className="hint">
            Not baked: {[placed && 'the clip’s placement', faded && 'its fades'].filter(Boolean).join(' and ')}.
            {' '}Those belong to the edit rather than to the picture, and the clip keeps them.
          </p>
        )}

        {running && job && (
          <div className="process-progress">
            <div className="process-bar">
              <div className="process-bar-fill" style={{ width: `${job.progress}%` }} />
            </div>
            <span className="hint">Rendering and encoding… {job.progress}%</span>
          </div>
        )}

        {job && busyElsewhere && (
          <p className="settings-warning">“{job.label}” is already running. One encode at a time.</p>
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
                  void startBake(clipId, replace);
                  ours.current = useEditorStore.getState().processJob !== null;
                }}
              >
                Bake
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
