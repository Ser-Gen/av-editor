import { useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import type { Keyframe } from '../../types/editor';
import { envelopeGainAt } from '../../utils/audioChain';

/** 150% matches the Inspector's volume slider, so the two agree about what "loud" is. */
const MAX_GAIN = 1.5;
/** Where a click counts as landing on an existing point rather than making a new one. */
const HIT_PX = 7;

interface Props {
  clipId: string;
  keys: Keyframe[] | undefined;
  /** Clip-local seconds the strip spans — the trimmed length, not the source length. */
  duration: number;
  width: number;
  height: number;
}

/**
 * The volume envelope, drawn over the clip's own waveform.
 *
 * Here rather than in the Inspector because a level is shaped against what you can see: the
 * point of ducking music under a voice is putting the dip where the voice is, and a number
 * field cannot show you that.
 *
 * An SVG rather than another canvas — the points are interactive, and hit-testing shapes by
 * hand is work the browser will do for free.
 */
export function GainEnvelope({ clipId, keys, duration, width, height }: Props) {
  const setGainKey = useEditorStore((s) => s.setGainKey);
  const moveGainKey = useEditorStore((s) => s.moveGainKey);
  const removeGainKey = useEditorStore((s) => s.removeGainKey);
  const beginInteraction = useEditorStore((s) => s.beginInteraction);
  const endInteraction = useEditorStore((s) => s.endInteraction);
  const dragging = useRef<number | null>(null);

  if (duration <= 0 || width <= 0) return null;

  const points = [...(keys ?? [])].sort((a, b) => a.t - b.t);
  const xOf = (t: number) => (t / duration) * width;
  const yOf = (gain: number) => height - (Math.min(MAX_GAIN, Math.max(0, gain)) / MAX_GAIN) * height;
  const tOf = (x: number) => Math.min(duration, Math.max(0, (x / width) * duration));
  const gainOf = (y: number) => Math.min(MAX_GAIN, Math.max(0, (1 - y / height) * MAX_GAIN));

  // Sampled rather than drawn straight between points: `hold` steps and `smooth` eases, and a
  // polyline through the points would draw neither of them honestly.
  const line = (() => {
    if (points.length === 0) return '';
    const steps = Math.max(2, Math.min(240, Math.round(width / 3)));
    const parts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * duration;
      parts.push(`${i === 0 ? 'M' : 'L'}${xOf(t).toFixed(1)},${yOf(envelopeGainAt(points, t)).toFixed(1)}`);
    }
    return parts.join(' ');
  })();

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const box = (e.currentTarget as SVGElement).ownerSVGElement?.getBoundingClientRect()
      ?? (e.currentTarget as SVGElement).getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const onBackgroundClick = (e: React.MouseEvent<SVGRectElement>) => {
    e.stopPropagation();
    const { x, y } = local(e);
    // A first click seeds a flat line at the clicked level plus an anchor at the start, so the
    // envelope does not silently ramp from an implied 1.0 the user never asked for.
    const t = tOf(x);
    const value = gainOf(y);
    if (points.length === 0 && t > 0.01) setGainKey(clipId, 0, value);
    setGainKey(clipId, t, value);
  };

  return (
    <svg
      className="gain-envelope"
      width={width}
      height={height}
      onPointerMove={(e) => {
        if (dragging.current === null) return;
        const { x, y } = local(e);
        const from = dragging.current;
        const t = tOf(x);
        moveGainKey(clipId, from, t, gainOf(y));
        dragging.current = t;
      }}
      onPointerUp={() => {
        if (dragging.current === null) return;
        dragging.current = null;
        endInteraction();
      }}
      onPointerLeave={() => {
        if (dragging.current === null) return;
        dragging.current = null;
        endInteraction();
      }}
    >
      {/* Unity, so a point's height reads as louder or quieter than the clip's own gain. */}
      <line className="gain-unity" x1={0} y1={yOf(1)} x2={width} y2={yOf(1)} />

      <rect
        className="gain-hit"
        x={0}
        y={0}
        width={width}
        height={height}
        onClick={onBackgroundClick}
        onPointerDown={(e) => e.stopPropagation()}
      />

      {points.length > 0 && <path className="gain-line" d={line} />}

      {points.map((key) => (
        <circle
          key={key.t}
          className="gain-point"
          cx={xOf(key.t)}
          cy={yOf(key.value)}
          r={HIT_PX / 2}
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.target as Element).setPointerCapture?.(e.pointerId);
            // One history entry for the whole drag, like every other timeline gesture.
            beginInteraction('Move envelope point');
            dragging.current = key.t;
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            removeGainKey(clipId, key.t);
          }}
        />
      ))}
    </svg>
  );
}
