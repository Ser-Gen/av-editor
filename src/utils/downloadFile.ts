/**
 * Handing a file back to the user, exactly as it is.
 *
 * No remux, no re-encode: a recording downloads the fragmented MP4 that was written during the
 * take, byte for byte. The blob URL is revoked on the next tick rather than immediately —
 * a URL that vanishes in the same tick as the click has been known to cancel the download.
 */
export function downloadFile(file: File, name = file.name): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * A name a file system will take.
 *
 * Recordings are named from a source kind and a timestamp and preset outputs from a label;
 * both can carry a colon or a slash, which several platforms refuse outright.
 */
export function safeFileName(name: string, fallback = 'file'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\-\s]+/, '');
  // A name made entirely of separators is not a name. `-`, `---` and `/` all land here.
  return /[^\-\s]/.test(cleaned) ? cleaned.slice(0, 180) : fallback;
}
