import { useEffect, useMemo, useState } from 'react';
import type { VideoFrameThumb } from '../../utils/videoThumbnails';
import { selectFilmstripTiles } from '../../utils/videoThumbnails';
import { loadVideoFilmstrip } from '../../utils/videoThumbnailCache';

const TILE_WIDTH = 72;

interface Props {
  assetId: string;
  blobUrl: string;
  duration: number;
  sourceTrimIn: number;
  sourceTrimOut: number;
  width: number;
  height: number;
}

export function ClipFilmstrip({
  assetId,
  blobUrl,
  duration,
  sourceTrimIn,
  sourceTrimOut,
  width,
  height,
}: Props) {
  const [frames, setFrames] = useState<VideoFrameThumb[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFrames(null);

    loadVideoFilmstrip(assetId, blobUrl, duration)
      .then((loaded) => {
        if (!cancelled) setFrames(loaded);
      })
      .catch((err) => {
        console.warn('[ClipFilmstrip] failed:', assetId, err);
        if (!cancelled) setFrames([]);
      });

    return () => {
      cancelled = true;
    };
  }, [assetId, blobUrl, duration]);

  const tileUrls = useMemo(() => {
    if (!frames || frames.length === 0) return [];
    const tileCount = Math.max(1, Math.ceil(width / TILE_WIDTH));
    return selectFilmstripTiles(frames, sourceTrimIn, sourceTrimOut, tileCount);
  }, [frames, sourceTrimIn, sourceTrimOut, width]);

  if (tileUrls.length === 0) return null;

  return (
    <div className="clip-filmstrip" style={{ height }} aria-hidden>
      {tileUrls.map((url, i) => (
        <img
          key={`${url}-${i}`}
          className="clip-filmstrip-tile"
          src={url}
          alt=""
          draggable={false}
          style={{ width: width / tileUrls.length, height }}
        />
      ))}
    </div>
  );
}
