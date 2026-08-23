/**
 * What a clip looks like when its file is not here.
 *
 * Drawn onto a canvas at the source's own dimensions and then handed to the ordinary
 * `drawSource` path, so it lands in exactly the rectangle the real media would have
 * occupied — same crop, same PiP placement, same transform. Nothing here knows where a clip
 * sits on screen, which is the point: a second placement rule would be a second thing to
 * keep in agreement with `overlayTransform`.
 *
 * Cached, because an offline clip is offline for every frame of a scrub.
 */

const cache = new Map<string, HTMLCanvasElement>();
const MAX_CACHED = 24;

/** Enough resolution for the text to stay crisp when a clip fills the frame. */
function cardSize(width: number, height: number): { w: number; h: number } {
  const w = Math.max(160, Math.round(width || 1280));
  const h = Math.max(90, Math.round(height || 720));
  return { w, h };
}

export function offlineCard(name: string, width: number, height: number): HTMLCanvasElement {
  const { w, h } = cardSize(width, height);
  const key = `${name}|${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.fillStyle = '#141418';
  ctx.fillRect(0, 0, w, h);

  // Diagonal hatching: reads as "deliberately not media" at any size, including the
  // thumbnail-sized draw a PiP gets, where text alone would be unreadable.
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = Math.max(2, h / 90);
  const step = Math.max(12, h / 14);
  for (let x = -h; x < w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + h, 0);
    ctx.stroke();
  }
  ctx.restore();

  const inset = Math.max(4, h / 60);
  ctx.strokeStyle = 'rgba(226,138,88,0.55)';
  ctx.lineWidth = Math.max(2, h / 120);
  ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);

  const title = Math.max(13, Math.round(h / 12));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e28a58';
  ctx.font = `600 ${title}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText('Media offline', w / 2, h / 2 - title * 0.6);

  const sub = Math.max(11, Math.round(h / 20));
  ctx.fillStyle = 'rgba(232,232,237,0.72)';
  ctx.font = `400 ${sub}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText(fit(ctx, name, w * 0.86), w / 2, h / 2 + sub * 1.1);

  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(key, canvas);
  return canvas;
}

/** Middle-truncate, so the extension survives — it is half of what identifies the file. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  const tail = text.slice(-10);
  let head = text.slice(0, -10);
  while (head.length > 1 && ctx.measureText(`${head}…${tail}`).width > max) {
    head = head.slice(0, -1);
  }
  return `${head}…${tail}`;
}

export function clearOfflineCards(): void {
  cache.clear();
}
