import { useLayoutEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { AnnotationOverlay } from './AnnotationOverlay';
import type { AnnotationTool } from './AnnotationOverlay';
import { transformAt } from '../utils/clipRender';
import { clipDuration } from '../utils/time';

/**
 * Mounts the drawing surface over the preview when an annotation clip is selected.
 *
 * Measures the canvas the way `MaskOverlay` does, for the same reason: the canvas is centred
 * and letterboxed by CSS, so its on-screen box has to be measured rather than computed.
 *
 * The surface follows the *selection*, and the renderer draws the marks on *time*. Those are
 * not the same condition, so scrubbing off the clip while it is still selected used to leave
 * a live drawing surface over a frame that could not show a single stroke. It says so now,
 * and offers the playhead a way back, rather than accepting marks nobody can see.
 */
export function AnnotationLayer({
  canvasRef,
  tool,
  color,
  width,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  tool: AnnotationTool;
  color: string;
  width: number;
}) {
  const clips = useEditorStore((s) => s.clips);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const playhead = useEditorStore((s) => s.playhead);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );

  const clip = clips.find((c) => c.id === selectedClipIds[0] && c.kind === 'annotation');

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
    const observer = new ResizeObserver(measure);
    if (canvasRef.current) observer.observe(canvasRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [canvasRef, clip?.id]);

  if (!clip || clip.kind !== 'annotation' || !box) return null;

  const start = clip.timelineStart;
  const end = start + clipDuration(clip);
  if (playhead < start || playhead >= end) {
    return (
      <div className="annotation-offscreen" style={{ left: box.left, top: box.top }}>
        <span>This annotation is not on screen at the playhead.</span>
        <button type="button" onClick={() => setPlayhead(start)}>
          Go to it
        </button>
      </div>
    );
  }

  return (
    <AnnotationOverlay
      clip={clip}
      tool={tool}
      color={color}
      width={width}
      transform={transformAt(clip, playhead)}
      playhead={playhead}
      stage={box}
    />
  );
}
