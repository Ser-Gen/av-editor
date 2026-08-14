import { useCallback, useEffect, useRef, useState } from 'react';
import type { NormalizedRect, OverlayTransform } from '../types/editor';
import {
  canvasPxToCropNorm,
  cropRectHandlePx,
  frameRectHandlePx,
  fromPct,
  getCropLayout,
  HANDLE_RADIUS_PX,
  OVERLAY_PREVIEW_H,
  OVERLAY_PREVIEW_W,
  pct,
  pointerCanvasNorm,
  pointerCanvasPx,
} from '../utils/overlayEditorUtils';
import { clampRect, drawOverlaySource, normalizeOverlayTransform } from '../utils/overlayTransform';

interface Props {
  mediaKind: 'video' | 'image';
  blobUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  transform: OverlayTransform;
  onChange: (transform: OverlayTransform) => void;
}

type DragTarget = 'frame' | 'crop';

export function MediaOverlayEditor({
  mediaKind,
  blobUrl,
  sourceWidth,
  sourceHeight,
  transform,
  onChange,
}: Props) {
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    target: DragTarget;
    kind: 'move' | 'resize';
    startRect: NormalizedRect;
    startPointer: { x: number; y: number };
    cropLayout?: ReturnType<typeof getCropLayout>;
  } | null>(null);

  const [ready, setReady] = useState(false);
  const normalized = normalizeOverlayTransform(transform);

  useEffect(() => {
    setReady(false);
    if (mediaKind === 'video') {
      const video = videoRef.current;
      if (!video) return;
      const onReady = () => {
        video.currentTime = 0.05;
        setReady(true);
      };
      video.addEventListener('loadeddata', onReady);
      if (video.readyState >= 2) onReady();
      return () => video.removeEventListener('loadeddata', onReady);
    }

    const img = imageRef.current;
    if (!img) return;
    const onReady = () => setReady(true);
    img.addEventListener('load', onReady);
    if (img.complete && img.naturalWidth > 0) onReady();
    return () => img.removeEventListener('load', onReady);
  }, [blobUrl, mediaKind]);

  const emit = useCallback(
    (next: OverlayTransform) => onChange(normalizeOverlayTransform(next)),
    [onChange],
  );

  const patchRect = useCallback(
    (key: 'frame' | 'crop', rect: NormalizedRect) => {
      emit({ ...normalized, [key]: rect });
    },
    [emit, normalized],
  );

  const sourceSize = () => {
    if (mediaKind === 'video') {
      const video = videoRef.current;
      return {
        sw: video?.videoWidth || sourceWidth,
        sh: video?.videoHeight || sourceHeight,
      };
    }
    const img = imageRef.current;
    return {
      sw: img?.naturalWidth || sourceWidth,
      sh: img?.naturalHeight || sourceHeight,
    };
  };

  const getSource = (): CanvasImageSource | null => {
    if (mediaKind === 'video') return videoRef.current;
    return imageRef.current;
  };

  useEffect(() => {
    const canvas = frameCanvasRef.current;
    const source = getSource();
    if (!canvas || !source || !ready) return;
    const { sw, sh } = sourceSize();
    if (sw <= 0 || sh <= 0) return;

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
    drawOverlaySource(ctx, source, sw, sh, normalized, OVERLAY_PREVIEW_W, OVERLAY_PREVIEW_H);

    const frame = clampRect(normalized.frame);
    ctx.strokeStyle = '#7ec8ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      frame.x * OVERLAY_PREVIEW_W,
      frame.y * OVERLAY_PREVIEW_H,
      frame.w * OVERLAY_PREVIEW_W,
      frame.h * OVERLAY_PREVIEW_H,
    );
    ctx.fillStyle = 'rgba(126, 200, 255, 0.12)';
    ctx.fillRect(
      frame.x * OVERLAY_PREVIEW_W,
      frame.y * OVERLAY_PREVIEW_H,
      frame.w * OVERLAY_PREVIEW_W,
      frame.h * OVERLAY_PREVIEW_H,
    );
    const handle = frameRectHandlePx(frame);
    ctx.fillStyle = '#7ec8ff';
    ctx.fillRect(handle.x - 5, handle.y - 5, 10, 10);
  }, [normalized, ready, mediaKind]);

  useEffect(() => {
    const canvas = cropCanvasRef.current;
    const source = getSource();
    if (!canvas || !source || !ready) return;
    const { sw, sh } = sourceSize();
    if (sw <= 0 || sh <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = OVERLAY_PREVIEW_W * dpr;
    canvas.height = OVERLAY_PREVIEW_H * dpr;
    canvas.style.width = `${OVERLAY_PREVIEW_W}px`;
    canvas.style.height = `${OVERLAY_PREVIEW_H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const layout = getCropLayout(sw, sh);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, OVERLAY_PREVIEW_W, OVERLAY_PREVIEW_H);
    ctx.drawImage(source, layout.ox, layout.oy, layout.dw, layout.dh);

    const crop = clampRect(normalized.crop);
    ctx.strokeStyle = '#ffb74d';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      layout.ox + crop.x * layout.dw,
      layout.oy + crop.y * layout.dh,
      crop.w * layout.dw,
      crop.h * layout.dh,
    );
    ctx.fillStyle = 'rgba(255, 183, 77, 0.15)';
    ctx.fillRect(
      layout.ox + crop.x * layout.dw,
      layout.oy + crop.y * layout.dh,
      crop.w * layout.dw,
      crop.h * layout.dh,
    );
    const handle = cropRectHandlePx(crop, layout);
    ctx.fillStyle = '#ffb74d';
    ctx.fillRect(handle.x - 5, handle.y - 5, 10, 10);
  }, [normalized, ready, mediaKind]);

  const beginDrag = (
    e: React.PointerEvent<HTMLCanvasElement>,
    target: DragTarget,
    kind: 'move' | 'resize',
    startPointer: { x: number; y: number },
    cropLayout?: ReturnType<typeof getCropLayout>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { target, kind, startRect: normalized[target], startPointer, cropLayout };
  };

  const onFramePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = pointerCanvasPx(e, box);
    const handle = frameRectHandlePx(normalized.frame);
    const nearHandle = Math.hypot(px.x - handle.x, px.y - handle.y) < HANDLE_RADIUS_PX;
    beginDrag(e, 'frame', nearHandle ? 'resize' : 'move', pointerCanvasNorm(e, box));
  };

  const onCropPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { sw, sh } = sourceSize();
    const layout = getCropLayout(sw, sh);
    const box = e.currentTarget.getBoundingClientRect();
    const px = pointerCanvasPx(e, box);
    const handle = cropRectHandlePx(normalized.crop, layout);
    const nearHandle = Math.hypot(px.x - handle.x, px.y - handle.y) < HANDLE_RADIUS_PX;
    beginDrag(e, 'crop', nearHandle ? 'resize' : 'move', canvasPxToCropNorm(px, layout), layout);
  };

  const onFramePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.target !== 'frame') return;
    const box = e.currentTarget.getBoundingClientRect();
    const p = pointerCanvasNorm(e, box);
    const dx = p.x - drag.startPointer.x;
    const dy = p.y - drag.startPointer.y;
    const start = drag.startRect;
    if (drag.kind === 'move') {
      patchRect('frame', { ...start, x: start.x + dx, y: start.y + dy });
      return;
    }
    patchRect('frame', { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy });
  };

  const onCropPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.target !== 'crop' || !drag.cropLayout) return;
    const box = e.currentTarget.getBoundingClientRect();
    const p = canvasPxToCropNorm(pointerCanvasPx(e, box), drag.cropLayout);
    const dx = p.x - drag.startPointer.x;
    const dy = p.y - drag.startPointer.y;
    const start = drag.startRect;
    if (drag.kind === 'move') {
      patchRect('crop', { ...start, x: start.x + dx, y: start.y + dy });
      return;
    }
    patchRect('crop', { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy });
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  };

  const numField = (key: 'frame' | 'crop', field: keyof NormalizedRect, label: string) => (
    <label className="overlay-num">
      {label}
      <input
        type="number"
        min={0}
        max={100}
        value={pct(normalized[key][field])}
        onChange={(e) => {
          patchRect(key, { ...normalized[key], [field]: fromPct(Number(e.target.value)) });
        }}
      />
    </label>
  );

  return (
    <div className="video-overlay-editor">
      {mediaKind === 'video' ? (
        <video ref={videoRef} src={blobUrl} muted playsInline preload="auto" hidden />
      ) : (
        <img ref={imageRef} src={blobUrl} alt="" hidden />
      )}

      <p className="overlay-editor-label">Position on screen</p>
      <canvas
        ref={frameCanvasRef}
        className="overlay-editor-canvas"
        onPointerDown={onFramePointerDown}
        onPointerMove={onFramePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <div className="overlay-editor-fields">
        {numField('frame', 'x', 'X')}
        {numField('frame', 'y', 'Y')}
        {numField('frame', 'w', 'W')}
        {numField('frame', 'h', 'H')}
      </div>

      <p className="overlay-editor-label">Crop source</p>
      <canvas
        ref={cropCanvasRef}
        className="overlay-editor-canvas"
        onPointerDown={onCropPointerDown}
        onPointerMove={onCropPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <div className="overlay-editor-fields">
        {numField('crop', 'x', 'X')}
        {numField('crop', 'y', 'Y')}
        {numField('crop', 'w', 'W')}
        {numField('crop', 'h', 'H')}
      </div>

      <p className="hint">
        Drag to move; drag the corner handle to resize. Source {sourceWidth}×{sourceHeight}.
      </p>
    </div>
  );
}
