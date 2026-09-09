import { useCallback, useEffect, useRef, useState } from 'react';
import { loadVideoFilmstrip, loadVideoPoster } from '../utils/videoThumbnailCache';
import type { VideoFrameThumb } from '../utils/videoThumbnails';

interface Props {
  assetId: string;
  blobUrl: string;
  alt: string;
  /**
   * Moving across the thumbnail scrubs the file. Off by default because the timeline draws
   * this component too, where the pointer is busy dragging clips.
   */
  scrub?: boolean;
  duration?: number;
}

/**
 * The library's thumbnail, and — when scrubbing is on — a way to see what is in a file without
 * opening it.
 *
 * The frames are the filmstrip the timeline already extracts and caches, so hovering a file
 * that is on the timeline costs nothing at all; hovering one that is not extracts the strip
 * once and every later hover is free. There is no `<video>` element here: at library row size,
 * a dozen cached stills read better than a decoder seeking behind the pointer.
 */
export function VideoPoster({ assetId, blobUrl, alt, scrub = false, duration = 0 }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [frames, setFrames] = useState<VideoFrameThumb[] | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const asking = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFrames(null);
    setHovered(null);
    asking.current = false;

    loadVideoPoster(assetId, blobUrl)
      .then((poster) => {
        if (!cancelled) setUrl(poster);
      })
      .catch((err) => {
        console.warn('[VideoPoster] failed:', assetId, err);
      });

    return () => {
      cancelled = true;
    };
  }, [assetId, blobUrl]);

  // Extracted on first hover, not on mount: a library of forty files must not decode forty
  // filmstrips because it was scrolled past.
  const wantFrames = useCallback(() => {
    if (!scrub || frames || asking.current) return;
    asking.current = true;
    loadVideoFilmstrip(assetId, blobUrl, duration)
      .then(setFrames)
      .catch(() => {
        // A file the decoder will not seek keeps its poster. Nothing to say about it.
      });
  }, [scrub, frames, assetId, blobUrl, duration]);

  const onMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!scrub) return;
    wantFrames();
    if (!frames || frames.length === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(0.999, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
    setHovered(frames[Math.floor(ratio * frames.length)].url);
  };

  if (!url) {
    return <div className="video-poster video-poster--loading" aria-hidden />;
  }

  return (
    <img
      className={`video-poster${scrub ? ' is-scrubbable' : ''}`}
      src={hovered ?? url}
      alt={alt}
      draggable={false}
      onPointerEnter={wantFrames}
      onPointerMove={onMove}
      onPointerLeave={() => setHovered(null)}
    />
  );
}
