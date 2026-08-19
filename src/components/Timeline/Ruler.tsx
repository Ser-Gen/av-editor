import { useMemo } from 'react';
import { formatTimecode } from '../../utils/time';

interface Props {
  pxPerSec: number;
  scrollX: number;
  viewportWidth: number;
  duration: number;
  fps: number;
}

/** Tick spacing that keeps labels ~80px apart at any zoom, down to single frames. */
function chooseStep(pxPerSec: number, fps: number): number {
  const candidates = [
    1 / fps,
    2 / fps,
    5 / fps,
    0.5,
    1,
    2,
    5,
    10,
    15,
    30,
    60,
    120,
    300,
    600,
    1800,
  ];
  return candidates.find((step) => step * pxPerSec >= 80) ?? candidates[candidates.length - 1];
}

export function Ruler({ pxPerSec, scrollX, viewportWidth, duration, fps }: Props) {
  const ticks = useMemo(() => {
    const step = chooseStep(pxPerSec, fps);
    const startTime = Math.max(0, scrollX / pxPerSec - step);
    const endTime = (scrollX + viewportWidth) / pxPerSec + step;
    const firstIndex = Math.max(0, Math.floor(startTime / step));
    const out: { t: number; major: boolean }[] = [];
    // Index, not accumulated time. Frame-sized steps like 1/30 have no exact float
    // representation, so `t += step` drifts and `t % (step * 2)` starts missing majors —
    // which silently drops ruler labels. Counting ticks keeps the parity exact, and
    // multiplying instead of accumulating keeps each tick on its true time.
    for (let i = 0; i < 400; i++) {
      const index = firstIndex + i;
      const t = index * step;
      if (t > endTime) break;
      out.push({ t, major: index % 2 === 0 });
    }
    return out;
  }, [pxPerSec, scrollX, viewportWidth, fps]);

  return (
    <div className="ruler-inner" style={{ width: Math.max(0, duration * pxPerSec) }}>
      {ticks.map(({ t, major }) => (
        <div
          key={t.toFixed(4)}
          className={`ruler-tick${major ? ' ruler-tick--major' : ''}`}
          style={{ left: t * pxPerSec }}
        >
          {major && <span className="ruler-label">{formatTimecode(t, fps)}</span>}
        </div>
      ))}
    </div>
  );
}
