import { memo } from 'react';
import type { Clip, Interp, Keyframe } from '../../types/editor';
import type { ChannelRef } from '../../store/editorStore';
import { useEditorStore } from '../../store/editorStore';
import { descriptorFor } from '../../render/effects/registry';
import { sortedKeys } from '../../utils/annotationAnim';
import { SHAPE_LABELS } from '../../utils/annotationEdit';
import { clipDuration, quantizeToFrame } from '../../utils/time';

export const KEYFRAME_ROW_HEIGHT = 13;

/**
 * A row is either an animated *channel* — a number that interpolates, with its own curve — or a
 * mark's *poses*, which are whole sets of points and have no value to graph. They share this
 * strip because they answer the same question: what on this clip moves, and when.
 */
type Row =
  | { kind: 'channel'; id: string; label: string; ref: ChannelRef; keys: Keyframe[] }
  | { kind: 'pose'; id: string; label: string; shapeId: string; times: number[] };

/** Every animated channel on a clip, in the order the Inspector shows them. */
export function keyframeRows(clip: Clip): Row[] {
  const rows: Row[] = [];
  for (const [name, keys] of Object.entries(clip.transformKeyframes ?? {})) {
    if (keys.length > 0) {
      rows.push({
        kind: 'channel',
        id: `transform:${name}`,
        ref: { effectId: null, param: name },
        label: name,
        keys,
      });
    }
  }
  for (const effect of clip.effects ?? []) {
    const desc = descriptorFor(effect);
    for (const [name, keys] of Object.entries(effect.keyframes ?? {})) {
      if (keys.length === 0) continue;
      const param = desc?.params.find((p) => p.name === name);
      rows.push({
        kind: 'channel',
        id: `${effect.id}:${name}`,
        ref: { effectId: effect.id, param: name },
        label: `${desc?.label ?? effect.type} · ${param?.label ?? name}`,
        keys,
      });
    }
  }
  // A mark that follows its subject is animation like any other, and it was the one kind you
  // could not see on the timeline — you had to select the mark to find out it moved at all.
  if (clip.kind === 'annotation') {
    for (const shape of clip.shapes) {
      const times = sortedKeys(shape.pointKeys).map((key) => key.t);
      if (times.length === 0) continue;
      rows.push({
        kind: 'pose',
        id: `shape:${shape.id}`,
        label: `${SHAPE_LABELS[shape.type]}${shape.text ? ` · ${shape.text}` : ''}`,
        shapeId: shape.id,
        times,
      });
    }
  }
  return rows;
}

/**
 * One row per animated channel, diamonds at each key.
 *
 * Rendered as a sibling of the clip rather than inside it: `.clip` clips its overflow,
 * and the strip has to be able to sit under a short clip without being cut off.
 */
export const KeyframeStrip = memo(function KeyframeStrip({
  clip,
  pxPerSec,
  top,
}: {
  clip: Clip;
  pxPerSec: number;
  top: number;
}) {
  const moveKeyframe = useEditorStore((s) => s.moveKeyframe);
  const removeKeyframe = useEditorStore((s) => s.removeKeyframe);
  const setKeyframeInterp = useEditorStore((s) => s.setKeyframeInterp);
  const moveShapeKey = useEditorStore((s) => s.moveAnnotationShapeKey);
  const removeShapeKey = useEditorStore((s) => s.removeAnnotationShapeKey);
  const selectShape = useEditorStore((s) => s.selectShape);
  const selectedShapeId = useEditorStore((s) => s.selectedShapeId);
  const beginInteraction = useEditorStore((s) => s.beginInteraction);
  const endInteraction = useEditorStore((s) => s.endInteraction);
  const fps = useEditorStore((s) => s.settings.fps);

  const rows = keyframeRows(clip);
  if (rows.length === 0) return null;

  const left = clip.timelineStart * pxPerSec;
  const width = Math.max(8, clipDuration(clip) * pxPerSec);

  /**
   * Drag one key along the strip. `apply` is what a channel and a pose disagree about; the
   * gesture, and the one-undo-entry rule it exists to keep, is the same for both.
   *
   * A key is addressed **by the time it currently sits at**, so each step has to know where the
   * last one left it. And where it lands is quantized to a frame, like every other timeline
   * edit, so the drag has to quantize identically — otherwise the next step looks for a key at
   * an unrounded time, finds none, and the marker stops dead after its first frame of travel.
   * That was true of effect and placement keys before poses existed; a drag moved them exactly
   * one frame and then stuck.
   */
  const startDrag = (
    e: React.PointerEvent,
    originT: number,
    apply: (from: number, to: number) => void,
    label: string,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;

    // One undo entry for the whole drag, like clip moves and trims.
    beginInteraction(label);
    const originClientX = e.clientX;
    const duration = clipDuration(clip);
    let current = originT;

    const onMove = (ev: PointerEvent) => {
      const raw = originT + (ev.clientX - originClientX) / pxPerSec;
      const next = Math.min(duration, Math.max(0, quantizeToFrame(raw, fps)));
      if (Math.abs(next - current) < 1e-6) return;
      apply(current, next);
      current = next;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endInteraction();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const cycleInterp = (ref: ChannelRef, key: Keyframe) => {
    const order: Interp[] = ['linear', 'smooth', 'hold'];
    const next = order[(order.indexOf(key.interp) + 1) % order.length];
    setKeyframeInterp(clip.id, ref, key.t, next);
  };

  return (
    <div className="kf-strip" style={{ left, width, top }}>
      {rows.map((row) =>
        row.kind === 'channel' ? (
          <div className="kf-row" key={row.id}>
            <span className="kf-row-label">{row.label}</span>
            {row.keys.map((key) => (
              <span
                key={key.t}
                className={`kf-key kf-key--${key.interp}`}
                style={{ left: key.t * pxPerSec }}
                title={`${row.label} — ${key.value.toFixed(3)} at ${key.t.toFixed(2)}s (${key.interp}). Click to change interpolation, right-click to delete.`}
                onPointerDown={(e) =>
                  startDrag(e, key.t, (from, to) => moveKeyframe(clip.id, row.ref, from, to), 'Move keyframe')
                }
                onClick={(e) => {
                  e.stopPropagation();
                  cycleInterp(row.ref, key);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeKeyframe(clip.id, row.ref, key.t);
                }}
              />
            ))}
          </div>
        ) : (
          <div
            className={`kf-row${row.shapeId === selectedShapeId ? ' is-selected' : ''}`}
            key={row.id}
          >
            <span className="kf-row-label">{row.label}</span>
            {row.times.map((t) => (
              <span
                key={t}
                className="kf-key kf-key--pose"
                style={{ left: t * pxPerSec }}
                title={`${row.label} — pose at ${t.toFixed(2)}s. Drag to move it, click to select the mark, right-click to delete the pose.`}
                onPointerDown={(e) =>
                  startDrag(
                    e,
                    t,
                    (from, to) => moveShapeKey(clip.id, row.shapeId, from, to),
                    'Move pose',
                  )
                }
                onClick={(e) => {
                  e.stopPropagation();
                  selectShape(row.shapeId);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeShapeKey(clip.id, row.shapeId, t);
                }}
              />
            ))}
          </div>
        ),
      )}
    </div>
  );
});
