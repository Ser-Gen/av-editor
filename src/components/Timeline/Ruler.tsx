import { formatTimecode } from '../../utils/time';
import { TRACK_LABEL_WIDTH } from './constants';

interface Props {
  duration: number;
  pxPerSec: number;
  playhead: number;
  onSeek: (t: number) => void;
}

export function Ruler({ duration, pxPerSec, playhead, onSeek }: Props) {
  const width = Math.max(800, duration * pxPerSec + 200);
  const step = pxPerSec >= 60 ? 1 : pxPerSec >= 30 ? 2 : 5;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + step; t += step) ticks.push(t);

  const labelWidth = TRACK_LABEL_WIDTH;

  return (
    <div
      className="ruler"
      style={{ width }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left - labelWidth;
        if (x >= 0) onSeek(x / pxPerSec);
      }}
    >
      {ticks.map((t) => (
        <div key={t} className="ruler-tick" style={{ left: labelWidth + t * pxPerSec }}>
          {t % (step * 2) === 0 ? formatTimecode(t).slice(0, 5) : ''}
        </div>
      ))}
      <div className="playhead-line" style={{ left: labelWidth + playhead * pxPerSec }} />
    </div>
  );
}
