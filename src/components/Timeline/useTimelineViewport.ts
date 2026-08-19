import { useCallback, useEffect } from 'react';
import { useEditorStore } from '../../store/editorStore';

/**
 * Owns the timeline's own scroll and zoom. The lanes element has
 * `overflow: hidden` — nothing here ever rides browser scrolling, and the
 * wheel handler is non-passive so the page can never scroll underneath.
 */
export function useTimelineViewport(viewportRef: React.RefObject<HTMLDivElement | null>) {
  const pxPerSec = useEditorStore((s) => s.pxPerSec);
  const scrollX = useEditorStore((s) => s.scrollX);
  const scrollY = useEditorStore((s) => s.scrollY);
  const setViewportSize = useEditorStore((s) => s.setViewportSize);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      setViewportSize(el.clientWidth, el.clientHeight);
    });
    observer.observe(el);
    setViewportSize(el.clientWidth, el.clientHeight);
    return () => observer.disconnect();
  }, [viewportRef, setViewportSize]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Always ours: the timeline consumes every wheel event inside its bounds.
      e.preventDefault();
      const store = useEditorStore.getState();

      // Trackpad pinch arrives as a ctrlKey wheel event in every browser.
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const anchorX = e.clientX - rect.left;
        store.zoomAt(Math.exp(-e.deltaY * 0.01), anchorX);
        return;
      }

      const lineFactor = e.deltaMode === 1 ? 16 : 1;
      // Shift+wheel is the conventional "scroll sideways" on a mouse wheel.
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * lineFactor;
      const dy = (e.shiftKey ? 0 : e.deltaY) * lineFactor;
      store.setScroll(store.scrollX + dx, store.scrollY + dy);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewportRef]);

  /** Client X → timeline seconds. */
  const xToTime = useCallback(
    (clientX: number): number => {
      const el = viewportRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const state = useEditorStore.getState();
      return Math.max(0, (clientX - rect.left + state.scrollX) / state.pxPerSec);
    },
    [viewportRef],
  );

  const timeToX = useCallback((t: number): number => t * pxPerSec - scrollX, [pxPerSec, scrollX]);

  return { pxPerSec, scrollX, scrollY, xToTime, timeToX };
}
