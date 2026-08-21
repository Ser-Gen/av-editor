import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import {
  centeredScroll,
  minimapRows,
  scrollForWindowX,
  timeAtMinimapX,
  viewportWindow,
} from '../../utils/minimap';

const MINIMAP_HEIGHT = 34;
const PAD_Y = 4;
const ROW_HEIGHT = 12;
const ROW_GAP = 2;

type Drag =
  | { kind: 'pan'; grab: number; left: number; width: number }
  | { kind: 'scrub'; left: number; width: number };

/**
 * Seek, and bring the lanes with it. Clicking past the last clip is ordinary — the strip is
 * drawn over the tail too — so the centring reads the playhead back after `setPlayhead` has
 * clamped it, rather than centring on a time the playhead was not allowed to reach.
 */
function seek(time: number): void {
  const store = useEditorStore.getState();
  store.setPlayhead(time);
  const settled = useEditorStore.getState();
  settled.setScroll(
    centeredScroll(settled.playhead, settled.pxPerSec, settled.viewportWidth),
    settled.scrollY,
  );
}

/**
 * The whole project at a fixed size, whatever the zoom: clips at low fidelity, the lanes'
 * viewport as a window over them, the playhead as a line.
 *
 * It replaces two controls. The transport's scrub slider duplicated ruler-dragging at lower
 * precision and swallowed the frame-step keys when focused; the horizontal scrollbar showed a
 * viewport window with nothing in it. A window on a minimap is a scrollbar that shows its
 * contents, so the strip spans the same range the scrollbar did — content plus tail, not just
 * content — and shades the region past the last clip exactly as the lanes do.
 *
 * Two things follow from the timeline's performance rule, that playhead state must not flow
 * through React at animation-frame rate: the playhead marker and the window ride one transient
 * store subscription and write `transform` directly, and the clips are drawn to a canvas only
 * when the clips, tracks or span actually change.
 */
export function Minimap() {
  const stripRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(0);
  const applyRef = useRef<() => void>(() => {});
  const dragRef = useRef<Drag | null>(null);

  const [width, setWidth] = useState(0);

  const clips = useEditorStore((s) => s.clips);
  const tracks = useEditorStore((s) => s.tracks);
  const getProjectDuration = useEditorStore((s) => s.getProjectDuration);
  const getTimelineSpan = useEditorStore((s) => s.getTimelineSpan);

  const duration = getProjectDuration();
  const span = getTimelineSpan();

  // ------------------------------------------------------------------ measure

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      widthRef.current = el.clientWidth;
      setWidth(el.clientWidth);
      applyRef.current();
    });
    observer.observe(el);
    widthRef.current = el.clientWidth;
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // ----------------------------------------------------- window and playhead

  useEffect(() => {
    const windowEl = windowRef.current;
    const headEl = headRef.current;
    if (!windowEl || !headEl) return;

    const apply = () => {
      const w = widthRef.current;
      if (w <= 0) return;
      const s = useEditorStore.getState();
      const drawn = s.getTimelineSpan();
      const win = viewportWindow(s.scrollX, s.pxPerSec, s.viewportWidth, drawn, w);
      windowEl.style.transform = `translate3d(${win.x}px, 0, 0)`;
      windowEl.style.width = `${win.w}px`;
      headEl.style.transform = `translate3d(${(Math.min(s.playhead, drawn) / drawn) * w}px, 0, 0)`;
    };

    applyRef.current = apply;
    apply();

    return useEditorStore.subscribe((state, prev) => {
      if (
        state.playhead === prev.playhead &&
        state.scrollX === prev.scrollX &&
        state.pxPerSec === prev.pxPerSec &&
        state.viewportWidth === prev.viewportWidth &&
        state.clips === prev.clips
      ) {
        return;
      }
      apply();
    });
  }, []);

  // --------------------------------------------------------------------- draw

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(MINIMAP_HEIGHT * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Read the palette off the element so the strip cannot drift from the lanes' colours.
    const css = getComputedStyle(canvas);
    const colorOf = (name: string, fallback: string) =>
      css.getPropertyValue(name).trim() || fallback;

    ctx.clearRect(0, 0, width, MINIMAP_HEIGHT);

    // The same reading of "past the end" the lanes give, on the same drawn span.
    if (duration < span) {
      const from = (duration / span) * width;
      ctx.fillStyle = colorOf('--bg', '#0d0d0f');
      ctx.fillRect(from, 0, width - from, MINIMAP_HEIGHT);
      ctx.fillStyle = colorOf('--border', '#2a2a32');
      ctx.fillRect(from, 0, 1, MINIMAP_HEIGHT);
    }

    const rows = minimapRows(clips, tracks, span, width);
    const draw = (bars: { x: number; w: number }[], top: number, color: string) => {
      ctx.fillStyle = color;
      for (const bar of bars) ctx.fillRect(bar.x, top, bar.w, ROW_HEIGHT);
    };
    draw(rows.video, PAD_Y, colorOf('--clip-video', '#3d6eb5'));
    draw(rows.audio, PAD_Y + ROW_HEIGHT + ROW_GAP, colorOf('--clip-audio', '#3d9e6e'));

    applyRef.current();
  }, [clips, tracks, span, duration, width]);

  // ------------------------------------------------------------------- wheel

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const store = useEditorStore.getState();
      const rect = el.getBoundingClientRect();
      // Zoom about the time under the cursor — which, over a strip that shows the whole
      // project, is usually not on screen at all, so it is brought to the middle.
      const t = timeAtMinimapX(e.clientX - rect.left, rect.width, store.getTimelineSpan());
      store.setPxPerSec(store.pxPerSec * Math.exp(-e.deltaY * 0.01));
      const next = useEditorStore.getState();
      next.setScroll(centeredScroll(t, next.pxPerSec, next.viewportWidth), next.scrollY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ------------------------------------------------------------------ pointer

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const store = useEditorStore.getState();
      const drawn = store.getTimelineSpan();
      const x = e.clientX - drag.left;

      if (drag.kind === 'pan') {
        store.setScroll(
          scrollForWindowX(x - drag.grab, drag.width, drawn, store.pxPerSec),
          store.scrollY,
        );
        return;
      }
      seek(timeAtMinimapX(x, drag.width, drawn));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = stripRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const store = useEditorStore.getState();
    const drawn = store.getTimelineSpan();
    // The window is `pointer-events: none`, so which of the two gestures this is comes from
    // the geometry rather than from the event target — the same numbers that drew it.
    const win = viewportWindow(store.scrollX, store.pxPerSec, store.viewportWidth, drawn, rect.width);

    if (x >= win.x && x <= win.x + win.w) {
      dragRef.current = { kind: 'pan', grab: x - win.x, left: rect.left, width: rect.width };
      return;
    }
    dragRef.current = { kind: 'scrub', left: rect.left, width: rect.width };
    store.setPlaying(false);
    seek(timeAtMinimapX(x, rect.width, drawn));
  };

  return (
    <div
      ref={stripRef}
      className="minimap"
      style={{ height: MINIMAP_HEIGHT }}
      onPointerDown={onPointerDown}
      onDoubleClick={() => useEditorStore.getState().zoomToFit()}
      title="Click to seek · drag the window to pan · wheel to zoom · double-click to fit"
    >
      <canvas ref={canvasRef} className="minimap-canvas" style={{ height: MINIMAP_HEIGHT }} />
      <div ref={windowRef} className="minimap-window" aria-hidden />
      <div ref={headRef} className="minimap-playhead" aria-hidden />
    </div>
  );
}
