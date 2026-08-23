import { useCallback, useEffect, useRef, useState } from 'react';
import type { NormalizedRect, OverlayTransform } from '../types/editor';
import {
  canvasPxToCropNorm,
  cropRectHandlePx,
  frameHandleOnStage,
  frameStage,
  frameStageBudget,
  fromPct,
  fromPctSigned,
  getCropLayout,
  HANDLE_RADIUS_PX,
  lockedPartner,
  lockedResize,
  pct,
  STAGE_MAX_W,
  stageSize,
  pointerCanvasPx,
  pointerFrameNorm,
} from '../utils/overlayEditorUtils';
import {
  clampFrame,
  clampRect,
  drawOverlaySource,
  normalizeOverlayTransform,
  rotationOf,
} from '../utils/overlayTransform';
import { useEditorStore } from '../store/editorStore';

interface Props {
  mediaKind: 'video' | 'image';
  blobUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  transform: OverlayTransform;
  /** Where the clip is in its source right now, so the crop stage shows the live frame. */
  sourceTime: number;
  onChange: (transform: OverlayTransform) => void;
}

type DragTarget = 'frame' | 'crop';

export function MediaOverlayEditor({
  mediaKind,
  blobUrl,
  sourceWidth,
  sourceHeight,
  transform,
  sourceTime,
  onChange,
}: Props) {
  const settings = useEditorStore((s) => s.settings);
  const rootRef = useRef<HTMLDivElement>(null);
  // Measured rather than assumed: the panel is resizable now, and the stage is the control
  // that most wants the extra width.
  const [available, setAvailable] = useState(STAGE_MAX_W);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setAvailable(el.clientWidth));
    observer.observe(el);
    setAvailable(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const stage = stageSize(settings.width, settings.height, available);
  // The placement stage is drawn larger than the frame, so an overlay pushed past an edge
  // stays visible and grabbable instead of disappearing under the canvas boundary. Its frame
  // is sized to what is left after that margin, so the whole thing still fits the panel.
  const fs = frameStage(stageSize(settings.width, settings.height, frameStageBudget(available)));
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
  // Bumped whenever the hidden video lands on a new frame; both stages redraw off it, since
  // a <video> seeking is not something React would otherwise hear about.
  const [frameToken, setFrameToken] = useState(0);
  const [lockFrame, setLockFrame] = useState(false);
  const [lockCrop, setLockCrop] = useState(false);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const normalized = normalizeOverlayTransform(transform);

  useEffect(() => {
    setReady(false);
    if (mediaKind === 'video') {
      const video = videoRef.current;
      if (!video) return;
      const onReady = () => setReady(true);
      const onSeeked = () => setFrameToken((n) => n + 1);
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('seeked', onSeeked);
      if (video.readyState >= 2) onReady();
      return () => {
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('seeked', onSeeked);
      };
    }

    const img = imageRef.current;
    if (!img) return;
    const onReady = () => setReady(true);
    img.addEventListener('load', onReady);
    if (img.complete && img.naturalWidth > 0) onReady();
    return () => img.removeEventListener('load', onReady);
  }, [blobUrl, mediaKind]);

  /*
   * Follow the playhead, so the crop is drawn against the frame the clip is actually
   * showing rather than the one it opened on — a crop set against second zero of a talking
   * head is set against the wrong shot.
   *
   * Only while paused. During playback the main preview is already showing the motion, and
   * seeking a second decoder every frame would cost far more than this little stage is
   * worth.
   */
  useEffect(() => {
    if (mediaKind !== 'video' || !ready || isPlaying) return;
    const video = videoRef.current;
    if (!video) return;
    const want = Math.max(0, sourceTime);
    if (Math.abs(video.currentTime - want) < 0.04) return;
    video.currentTime = want;
  }, [sourceTime, ready, isPlaying, mediaKind]);

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
    canvas.width = fs.w * dpr;
    canvas.height = fs.h * dpr;
    canvas.style.width = `${fs.w}px`;
    canvas.style.height = `${fs.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Outside the frame first, then the frame itself, so the two never read as one surface.
    ctx.fillStyle = '#07090d';
    ctx.fillRect(0, 0, fs.w, fs.h);
    ctx.fillStyle = '#101820';
    ctx.fillRect(fs.ox, fs.oy, fs.fw, fs.fh);

    ctx.save();
    ctx.translate(fs.ox, fs.oy);
    drawOverlaySource(ctx, source, sw, sh, normalized, fs.fw, fs.fh);
    ctx.restore();

    // Whatever spilled into the bleed is dimmed: it is where the picture *is*, and it is
    // also the part that will not be in the render.
    ctx.fillStyle = 'rgba(7, 9, 13, 0.66)';
    ctx.fillRect(0, 0, fs.w, fs.oy);
    ctx.fillRect(0, fs.oy + fs.fh, fs.w, fs.oy);
    ctx.fillRect(0, fs.oy, fs.ox, fs.fh);
    ctx.fillRect(fs.ox + fs.fw, fs.oy, fs.ox, fs.fh);

    const frame = clampFrame(normalized.frame);
    const degrees = rotationOf(normalized);
    const bw = frame.w * fs.fw;
    const bh = frame.h * fs.fh;
    // The outline turns with the picture — an upright box around a tilted frame would be
    // describing a rectangle that is not there.
    ctx.save();
    ctx.translate(fs.ox + (frame.x + frame.w / 2) * fs.fw, fs.oy + (frame.y + frame.h / 2) * fs.fh);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.fillStyle = 'rgba(126, 200, 255, 0.12)';
    ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
    ctx.strokeStyle = '#7ec8ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
    if (degrees !== 0) {
      // Which way is up, once it is no longer obvious.
      ctx.beginPath();
      ctx.moveTo(0, -bh / 2);
      ctx.lineTo(0, -bh / 2 - 10);
      ctx.stroke();
    }
    ctx.restore();

    // The canvas edge, drawn last so it stays legible under an overlay crossing it.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth = 1;
    ctx.strokeRect(fs.ox + 0.5, fs.oy + 0.5, fs.fw - 1, fs.fh - 1);

    const handle = frameHandleOnStage(frame, fs, degrees);
    ctx.fillStyle = '#7ec8ff';
    ctx.fillRect(handle.x - 5, handle.y - 5, 10, 10);
  }, [normalized, ready, frameToken, mediaKind, fs.w, fs.h, fs.ox, fs.oy, fs.fw, fs.fh]);

  useEffect(() => {
    const canvas = cropCanvasRef.current;
    const source = getSource();
    if (!canvas || !source || !ready) return;
    const { sw, sh } = sourceSize();
    if (sw <= 0 || sh <= 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = stage.w * dpr;
    canvas.height = stage.h * dpr;
    canvas.style.width = `${stage.w}px`;
    canvas.style.height = `${stage.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const layout = getCropLayout(sw, sh, stage);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, stage.w, stage.h);
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
  }, [normalized, ready, frameToken, mediaKind, stage.w, stage.h]);

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
    const px = pointerCanvasPx(e, box, { w: fs.w, h: fs.h });
    const handle = frameHandleOnStage(normalized.frame, fs, rotationOf(normalized));
    const nearHandle = Math.hypot(px.x - handle.x, px.y - handle.y) < HANDLE_RADIUS_PX;
    beginDrag(e, 'frame', nearHandle ? 'resize' : 'move', pointerFrameNorm(e, box, fs));
  };

  const onCropPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { sw, sh } = sourceSize();
    const layout = getCropLayout(sw, sh, stage);
    const box = e.currentTarget.getBoundingClientRect();
    const px = pointerCanvasPx(e, box, stage);
    const handle = cropRectHandlePx(normalized.crop, layout);
    const nearHandle = Math.hypot(px.x - handle.x, px.y - handle.y) < HANDLE_RADIUS_PX;
    beginDrag(e, 'crop', nearHandle ? 'resize' : 'move', canvasPxToCropNorm(px, layout), layout);
  };

  const onFramePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.target !== 'frame') return;
    const box = e.currentTarget.getBoundingClientRect();
    const p = pointerFrameNorm(e, box, fs);
    const dx = p.x - drag.startPointer.x;
    const dy = p.y - drag.startPointer.y;
    const start = drag.startRect;
    if (drag.kind === 'move') {
      patchRect('frame', { ...start, x: start.x + dx, y: start.y + dy });
      return;
    }
    patchRect(
      'frame',
      lockFrame
        ? lockedResize(start, dx, dy, { w: settings.width, h: settings.height })
        : { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy },
    );
  };

  const onCropPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.target !== 'crop' || !drag.cropLayout) return;
    const box = e.currentTarget.getBoundingClientRect();
    const p = canvasPxToCropNorm(pointerCanvasPx(e, box, stage), drag.cropLayout);
    const dx = p.x - drag.startPointer.x;
    const dy = p.y - drag.startPointer.y;
    const start = drag.startRect;
    if (drag.kind === 'move') {
      patchRect('crop', { ...start, x: start.x + dx, y: start.y + dy });
      return;
    }
    const { sw, sh } = sourceSize();
    patchRect(
      'crop',
      lockCrop
        ? lockedResize(start, dx, dy, { w: sw, h: sh })
        : { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy },
    );
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  };

  /** What each rect's proportions are measured against: the canvas, or the source file. */
  const extentFor = (key: 'frame' | 'crop') => {
    if (key === 'frame') return { w: settings.width, h: settings.height };
    const { sw, sh } = sourceSize();
    return { w: sw, h: sh };
  };

  const numField = (key: 'frame' | 'crop', field: keyof NormalizedRect, label: string) => {
    // A frame's X and Y are the only signed fields here: the overlay may hang off an edge,
    // and `clampFrame` decides how far on the way through `emit`.
    const signed = key === 'frame' && (field === 'x' || field === 'y');
    const locked = key === 'frame' ? lockFrame : lockCrop;
    const sized = field === 'w' || field === 'h';
    return (
      <label className="overlay-num">
        {label}
        <input
          type="number"
          min={signed ? -100 : 0}
          max={100}
          value={pct(normalized[key][field])}
          onChange={(e) => {
            const raw = Number(e.target.value);
            const value = signed ? fromPctSigned(raw) : fromPct(raw);
            patchRect(
              key,
              locked && sized
                ? lockedPartner(normalized[key], field, value, extentFor(key))
                : { ...normalized[key], [field]: value },
            );
          }}
        />
      </label>
    );
  };

  const lockToggle = (checked: boolean, onToggle: (next: boolean) => void) => (
    <label className="checkbox overlay-lock">
      <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
      Keep aspect ratio
    </label>
  );

  return (
    <div className="video-overlay-editor" ref={rootRef}>
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
      {lockToggle(lockFrame, setLockFrame)}

      <div className="slider-row overlay-rotate">
        <span className="effect-param-label">Rotate</span>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={rotationOf(normalized)}
          onChange={(e) => emit({ ...normalized, rotate: Number(e.target.value) })}
        />
        <input
          type="number"
          className="overlay-rotate-num"
          value={Math.round(rotationOf(normalized) * 10) / 10}
          onChange={(e) => {
            const value = Number(e.target.value);
            emit({ ...normalized, rotate: Number.isFinite(value) ? value : 0 });
          }}
        />
        <button
          type="button"
          className="ghost"
          title="Back to upright"
          onClick={() => emit({ ...normalized, rotate: 0 })}
        >
          0°
        </button>
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
      {lockToggle(lockCrop, setLockCrop)}

      <p className="hint">
        Drag to move; drag the corner handle to resize. Rotation turns the picture about the
        frame's centre and is animated by the placement stopwatch, like the rest of the
        placement. Source {sourceWidth}×{sourceHeight}.
      </p>
    </div>
  );
}
