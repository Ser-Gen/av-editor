import { useEffect, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';

interface Props {
  variant: 'ruler' | 'lanes';
}

/**
 * The playhead moves every animation frame during playback. It subscribes to the
 * store transiently and writes `transform` directly, so clips and track headers
 * are never re-rendered by playback.
 */
export function PlayheadLine({ variant }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = (playhead: number, pxPerSec: number, scrollX: number) => {
      const x = playhead * pxPerSec - scrollX;
      el.style.transform = `translate3d(${x}px, 0, 0)`;
      el.style.visibility = x < -2 ? 'hidden' : 'visible';
    };

    const initial = useEditorStore.getState();
    apply(initial.playhead, initial.pxPerSec, initial.scrollX);

    return useEditorStore.subscribe((state, prev) => {
      if (
        state.playhead === prev.playhead &&
        state.pxPerSec === prev.pxPerSec &&
        state.scrollX === prev.scrollX
      ) {
        return;
      }
      apply(state.playhead, state.pxPerSec, state.scrollX);
    });
  }, []);

  return (
    <div ref={ref} className={`playhead playhead--${variant}`}>
      {variant === 'ruler' && <div className="playhead-grip" />}
    </div>
  );
}
