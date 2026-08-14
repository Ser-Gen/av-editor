import { useCallback, useEffect, useRef } from 'react';
import type { NormalizedRect, TextTemplate } from '../types/editor';
import {
  frameRectHandlePx,
  fromPct,
  HANDLE_RADIUS_PX,
  OVERLAY_PREVIEW_H,
  OVERLAY_PREVIEW_W,
  pct,
  pointerCanvasNorm,
  pointerCanvasPx,
} from '../utils/overlayEditorUtils';
import { clampRect } from '../utils/overlayTransform';
import { drawTextClip } from '../preview/textRenderer';

interface Props {
  text: string;
  template: TextTemplate;
  textFrame: NormalizedRect;
  onChange: (frame: NormalizedRect) => void;
}

export function TextPlacementEditor({ text, template, textFrame, onChange }: Props) {
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
    canvas.width = OVERLAY_PREVIEW_W * dpr;
    canvas.height = OVERLAY_PREVIEW_H * dpr;
    canvas.style.width = `${OVERLAY_PREVIEW_W}px`;
    canvas.style.height = `${OVERLAY_PREVIEW_H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, OVERLAY_PREVIEW_W, OVERLAY_PREVIEW_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    for (let x = 0; x < OVERLAY_PREVIEW_W; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, OVERLAY_PREVIEW_H);
      ctx.stroke();
    }

    drawTextClip(ctx, template, text || 'Text', OVERLAY_PREVIEW_W, OVERLAY_PREVIEW_H, frame);

    ctx.strokeStyle = '#c77dff';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      frame.x * OVERLAY_PREVIEW_W,
      frame.y * OVERLAY_PREVIEW_H,
      frame.w * OVERLAY_PREVIEW_W,
      frame.h * OVERLAY_PREVIEW_H,
    );
    ctx.fillStyle = 'rgba(199, 125, 255, 0.1)';
    ctx.fillRect(
      frame.x * OVERLAY_PREVIEW_W,
      frame.y * OVERLAY_PREVIEW_H,
      frame.w * OVERLAY_PREVIEW_W,
      frame.h * OVERLAY_PREVIEW_H,
    );
    const handle = frameRectHandlePx(frame);
    ctx.fillStyle = '#c77dff';
    ctx.fillRect(handle.x - 5, handle.y - 5, 10, 10);
  }, [frame, template, text]);

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
    const px = pointerCanvasPx(e, box);
    const handle = frameRectHandlePx(frame);
    const nearHandle = Math.hypot(px.x - handle.x, px.y - handle.y) < HANDLE_RADIUS_PX;
    beginDrag(e, nearHandle ? 'resize' : 'move', pointerCanvasNorm(e, box));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const box = e.currentTarget.getBoundingClientRect();
    const p = pointerCanvasNorm(e, box);
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

