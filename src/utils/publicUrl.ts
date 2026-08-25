/**
 * Where a file in `public/` actually lives at runtime.
 *
 * Vite rewrites every URL it can see — an `import`, an `href` in `index.html`, a `?worker&url`
 * — against the configured base. It cannot see a string handed to `fetch()`, and there are two
 * of those: the FFmpeg core (`ffmpegLoader.ts`) and the overlay font (`runExport.ts`). Written
 * as `/ffmpeg/...` they only ever resolve at a domain root, which is why they go through here.
 *
 * `BASE_URL` is `'./'` for the relative build, so the answer is resolved against the document
 * rather than the module: the chunk lives in `assets/`, the public files do not. An absolute
 * base (`vite build --base=/app/`) resolves the same way and simply ignores the document.
 */
export function publicUrl(path: string): string {
  const base = new URL(import.meta.env.BASE_URL, document.baseURI);
  return new URL(path.replace(/^\//, ''), base).href;
}
