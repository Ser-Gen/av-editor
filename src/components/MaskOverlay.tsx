import { useLayoutEffect, useState } from 'react';
import type { EffectInstance, NormalizedRect } from '../types/editor';
import { useEditorStore } from '../store/editorStore';
import { REGION_MODE, descriptorFor, regionOf } from '../render/effects/registry';
import { clipDuration } from '../utils/time';
import { evaluateChannel } from '../utils/keyframes';

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/**
 * Direct manipulation of a masked region, drawn over the preview canvas.
 *
 * With the region armed, every drag writes a keyframe at the playhead — so obscuring a
 * moving licence plate is *scrub, drag, scrub, drag*, and the interpolation covers the
 * frames in between.
 */
export function MaskOverlay({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  const clips = useEditorStore((s) => s.clips);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const playhead = useEditorStore((s) => s.playhead);
  const setRegionRect = useEditorStore((s) => s.setRegionRect);
  const beginInteraction = useEditorStore((s) => s.beginInteraction);
  const endInteraction = useEditorStore((s) => s.endInteraction);

  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );

  // The canvas is centred and letterboxed by CSS, so its on-screen box has to be measured
  // rather than computed.
  useLayoutEffect(() => {
    const measure = () => {
      const canvas = canvasRef.current;
      const parent = canvas?.parentElement;
      if (!canvas || !parent) return setBox(null);
      const c = canvas.getBoundingClientRect();
      const p = parent.getBoundingClientRect();
      setBox({ left: c.left - p.left, top: c.top - p.top, width: c.width, height: c.height });
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [canvasRef]);

  const clip = clips.find((c) => c.id === selectedClipIds[0]);
  if (!clip || !box || selectedClipIds.length !== 1) return null;

  const active =
    playhead >= clip.timelineStart && playhead < clip.timelineStart + clipDuration(clip);
  if (!active) return null;

  const rel = playhead - clip.timelineStart;
  const masked = (clip.effects ?? []).filter(
    (e) => e.enabled && (e.params[REGION_MODE] ?? 0) > 0.5,
  );
  if (masked.length === 0) return null;

  /** Region rect at the playhead — animated channels included. */
  const rectOf = (effect: EffectInstance): NormalizedRect => {
    const at = (name: string, fallback: number) =>
      evaluateChannel(effect.keyframes?.[name], rel, effect.params[name] ?? fallback);
    return {
      x: at('region.x', 0.35),
      y: at('region.y', 0.35),
      w: at('region.w', 0.3),
      h: at('region.h', 0.3),
    };
  };

  const startDrag = (e: React.PointerEvent, effect: EffectInstance, handle: Handle) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;

    const start = rectOf(effect);
    const originX = e.clientX;
    const originY = e.clientY;
    beginInteraction(handle === 'move' ? 'Move mask region' : 'Resize mask region');

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - originX) / box.width;
      const dy = (ev.clientY - originY) / box.height;
      let next: NormalizedRect;
      if (handle === 'move') {
        next = { ...start, x: start.x + dx, y: start.y + dy };
      } else {
        const west = handle === 'nw' || handle === 'sw';
        const north = handle === 'nw' || handle === 'ne';
        const x = west ? start.x + dx : start.x;
        const y = north ? start.y + dy : start.y;
        const w = west ? start.w - dx : start.w + dx;
        const h = north ? start.h - dy : start.h + dy;
        // Below the floor the box would invert; stop at a grabbable minimum instead.
        next = {
          x: w < 0.01 ? start.x : x,
          y: h < 0.01 ? start.y : y,
          w: Math.max(0.01, w),
          h: Math.max(0.01, h),
        };
      }
      setRegionRect(clip.id, effect.id, next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      endInteraction();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="mask-layer" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      {masked.map((effect) => {
        const rect = rectOf(effect);
        const ellipse = (regionOf(effect.params)?.shape ?? 1) === 2;
        return (
          <div
            key={effect.id}
            className={`mask-box${ellipse ? ' mask-box--ellipse' : ''}`}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
            title={`${descriptorFor(effect)?.label ?? effect.type} region — drag to move, corners to resize`}
            onPointerDown={(e) => startDrag(e, effect, 'move')}
          >
            {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
              <span
                key={handle}
                className={`mask-handle mask-handle--${handle}`}
                onPointerDown={(e) => startDrag(e, effect, handle)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
