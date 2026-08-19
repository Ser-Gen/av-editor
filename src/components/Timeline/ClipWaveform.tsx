import { useEffect, useMemo, useRef, useState } from 'react';
import { loadWaveformPeaks } from '../../utils/waveformCache';
import { slicePeaksForTrim } from '../../utils/waveform';

interface Props {
  assetId: string;
  file: File;
  duration: number;
  sourceTrimIn: number;
  sourceTrimOut: number;
  width: number;
  height: number;
}

export function ClipWaveform({
  assetId,
  file,
  duration,
  sourceTrimIn,
  sourceTrimOut,
  width,
  height,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);

    loadWaveformPeaks(assetId, file)
      .then((loaded) => {
        if (!cancelled) setPeaks(loaded);
      })
      .catch((err) => {
        console.warn('[Waveform] decode failed:', assetId, err);
        if (!cancelled) setPeaks([]);
      });

    return () => {
      cancelled = true;
    };
  }, [assetId, file]);

  const visiblePeaks = useMemo(
    () => (peaks ? slicePeaksForTrim(peaks, duration, sourceTrimIn, sourceTrimOut) : null),
    [peaks, duration, sourceTrimIn, sourceTrimOut],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visiblePeaks || visiblePeaks.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const mid = h / 2;
    const maxBarHeight = (h - 4) / 2;
    const barWidth = w / visiblePeaks.length;

    // Light bars: the strip sits on dark blue (video clips) and dark green (audio clips).
    ctx.fillStyle = 'rgba(226, 240, 255, 0.62)';
    for (let i = 0; i < visiblePeaks.length; i++) {
      const peak = visiblePeaks[i];
      const barH = Math.max(1, peak * maxBarHeight);
      const x = i * barWidth;
      const bw = Math.max(1, barWidth - 0.5);
      ctx.fillRect(x, mid - barH, bw, barH * 2);
    }
  }, [visiblePeaks, width, height]);

  // Decode fails for some MP4/MOV audio depending on browser codec support —
  // degrade to a flat ribbon so the clip still reads as "has audio".
  if (visiblePeaks && visiblePeaks.length === 0) {
    return <div className="clip-audio-flat" style={{ height }} aria-hidden />;
  }
  if (!visiblePeaks) return null;

  return <canvas ref={canvasRef} className="clip-waveform" aria-hidden />;
}
