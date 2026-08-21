import { memo } from 'react';
import type { Clip, Interp, Keyframe } from '../../types/editor';
import type { ChannelRef } from '../../store/editorStore';
import { useEditorStore } from '../../store/editorStore';
import { descriptorFor } from '../../render/effects/registry';
import { clipDuration } from '../../utils/time';

export const KEYFRAME_ROW_HEIGHT = 13;

interface Row {
  ref: ChannelRef;
  label: string;
  keys: Keyframe[];
}

/** Every animated channel on a clip, in the order the Inspector shows them. */
export function keyframeRows(clip: Clip): Row[] {
  const rows: Row[] = [];
  for (const [name, keys] of Object.entries(clip.transformKeyframes ?? {})) {
    if (keys.length > 0) rows.push({ ref: { effectId: null, param: name }, label: name, keys });
  }
  for (const effect of clip.effects ?? []) {
    const desc = descriptorFor(effect);
    for (const [name, keys] of Object.entries(effect.keyframes ?? {})) {
      if (keys.length === 0) continue;
      const param = desc?.params.find((p) => p.name === name);
      rows.push({
        ref: { effectId: effect.id, param: name },
        label: `${desc?.label ?? effect.type} · ${param?.label ?? name}`,
        keys,
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
  const beginInteraction = useEditorStore((s) => s.beginInteraction);
  const endInteraction = useEditorStore((s) => s.endInteraction);

  const rows = keyframeRows(clip);
  if (rows.length === 0) return null;

  const left = clip.timelineStart * pxPerSec;
  const width = Math.max(8, clipDuration(clip) * pxPerSec);

  const startDrag = (e: React.PointerEvent, ref: ChannelRef, key: Keyframe) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;

    // One undo entry for the whole drag, like clip moves and trims.
    beginInteraction('Move keyframe');
    const originClientX = e.clientX;
    const originT = key.t;

    const onMove = (ev: PointerEvent) => {
      moveKeyframe(clip.id, ref, originT, originT + (ev.clientX - originClientX) / pxPerSec);
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
      {rows.map((row) => (
        <div className="kf-row" key={`${row.ref.effectId ?? 'transform'}:${row.ref.param}`}>
          <span className="kf-row-label">{row.label}</span>
          {row.keys.map((key) => (
            <span
              key={key.t}
              className={`kf-key kf-key--${key.interp}`}
              style={{ left: key.t * pxPerSec }}
              title={`${row.label} — ${key.value.toFixed(3)} at ${key.t.toFixed(2)}s (${key.interp}). Click to change interpolation, right-click to delete.`}
              onPointerDown={(e) => startDrag(e, row.ref, key)}
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
      ))}
    </div>
  );
});
