import { useRef } from 'react';

interface Props {
  /** `x` for a divider between columns, `y` for one between rows. */
  axis: 'x' | 'y';
  size: number;
  /** True when dragging *towards* the panel shrinks it — a right-hand or bottom panel. */
  invert?: boolean;
  clamp: (px: number) => number;
  onChange: (next: number) => void;
  /** Double-click target. Omitted means double-clicking does nothing. */
  resetTo?: number;
  title: string;
}

/**
 * The divider between two panels.
 *
 * Pointer capture rather than window listeners: the drag then belongs to the element that
 * started it, survives leaving the six pixels it lives in, and cannot be left running by a
 * pointerup the window never sees.
 */
export function PanelSplitter({ axis, size, invert, clamp, onChange, resetTo, title }: Props) {
  const drag = useRef<{ from: number; size: number } | null>(null);

  return (
    <div
      className={`panel-splitter panel-splitter--${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add(axis === 'x' ? 'is-resizing-col' : 'is-resizing');
        drag.current = { from: axis === 'x' ? e.clientX : e.clientY, size };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const delta = (axis === 'x' ? e.clientX : e.clientY) - d.from;
        onChange(clamp(invert ? d.size - delta : d.size + delta));
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        drag.current = null;
        document.body.classList.remove('is-resizing', 'is-resizing-col');
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        document.body.classList.remove('is-resizing', 'is-resizing-col');
      }}
      onDoubleClick={resetTo === undefined ? undefined : () => onChange(clamp(resetTo))}
    />
  );
}
