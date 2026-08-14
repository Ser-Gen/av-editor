import { useEffect, useState } from 'react';
import { loadVideoPoster } from '../utils/videoThumbnailCache';

interface Props {
  assetId: string;
  blobUrl: string;
  alt: string;
}

export function VideoPoster({ assetId, blobUrl, alt }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);

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

  if (!url) {
    return <div className="video-poster video-poster--loading" aria-hidden />;
  }

  return <img className="video-poster" src={url} alt={alt} draggable={false} />;
}
