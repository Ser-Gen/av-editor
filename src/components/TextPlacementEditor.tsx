import { useCallback, useEffect, useRef } from 'react';
import type { NormalizedRect, TextTemplate } from '../types/editor';
import {
  frameRectHandlePx,
  fromPct,
  HANDLE_RADIUS_PX,
  pct,
  stageSize,
  pointerCanvasNorm,
  pointerCanvasPx,
} from '../utils/overlayEditorUtils';
import { clampRect } from '../utils/overlayTransform';
import { useEditorStore } from '../store/editorStore';
import { drawTextClip } from '../preview/textRenderer';

interface Props {
  text: string;
  template: TextTemplate;
  textFrame: NormalizedRect;
  onChange: (frame: NormalizedRect) => void;
}

export function TextPlacementEditor({ text, template, textFrame, onChange }: Props) {
  const settings = useEditorStore((s) => s.settings);
  const stage = stageSize(settings.width, settings.height);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{
    kind: 'move' | 'resize';
    startRect: NormalizedRect;
    startPointer: { x: number; y: number };
  } | null>(null);

  const frame = clampRect(textFrame);

  const emit = useCallback((rect: NormalizedRect) => onChange(clampRect(rect)), [onChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = stage.w * dpr;
    canvas.height = stage.h * dpr;
    canvas.style.width = `${stage.w}px`;
    canvas.style.height = `${stage.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, stage.w, stage.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    for (let x = 0; x < stage.w; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, stage.h);
      ctx.stroke();
    }

    drawTextClip(ctx, template, text || 'Text', stage.w, stage.h, frame);

    ctx.strokeStyle = '#c77dff';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      frame.x * stage.w,
      frame.y * stage.h,
      frame.w * stage.w,
      frame.h * stage.h,
    );
    ctx.fillStyle = 'rgba(199, 125, 255, 0.1)';
    ctx.fillRect(
      frame.x * stage.w,
      frame.y * stage.h,
      frame.w * stage.w,
      frame.h * stage.h,
    );
    const handle = frameRectHandlePx(frame, stage);
    ctx.fillStyle = '#c77dff';
    ctx.fillRect(handle.x - 5, handle.y - 5, 10, 10);
  }, [frame, template, text, stage.w, stage.h]);

  const beginDrag = (
    e: React.PointerEvent<HTMLCanvasElement>,
    kind: 'move' | 'resize',
    startPointer: { x: number; y: number },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { kind, startRect: frame, startPointer };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = pointerCanvasPx(e, box, stage);
    const handle = frameRectHandlePx(frame, stage);
    const nearHandle = Math.hypot(px.x - handle.x, px.y - handle.y) < HANDLE_RADIUS_PX;
    beginDrag(e, nearHandle ? 'resize' : 'move', pointerCanvasNorm(e, box, stage));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const box = e.currentTarget.getBoundingClientRect();
    const p = pointerCanvasNorm(e, box, stage);
    const dx = p.x - drag.startPointer.x;
    const dy = p.y - drag.startPointer.y;
    const start = drag.startRect;
    if (drag.kind === 'move') {
      emit({ ...start, x: start.x + dx, y: start.y + dy });
      return;
    }
    emit({ x: start.x, y: start.y, w: start.w + dx, h: start.h + dy });
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  };

  const numField = (field: keyof NormalizedRect, label: string) => (
    <label className="overlay-num">
      {label}
      <input
        type="number"
        min={0}
        max={100}
        value={pct(frame[field])}
        onChange={(e) => emit({ ...frame, [field]: fromPct(Number(e.target.value)) })}
      />
    </label>
  );

  return (
    <div className="video-overlay-editor">
      <p className="overlay-editor-label">Text box on screen</p>
      <canvas
        ref={canvasRef}
        className="overlay-editor-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <div className="overlay-editor-fields">
        {numField('x', 'X')}
        {numField('y', 'Y')}
        {numField('w', 'W')}
        {numField('h', 'H')}
      </div>
      <p className="hint">Drag the box or corner handle. Template layout fits inside the box.</p>
    </div>
  );
}

