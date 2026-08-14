const MEDIA_PARAM_KEYS = ['media', 'url', 'file'] as const;

export function parseMediaUrlsFromSearch(search: string): string[] {
  const params = new URLSearchParams(search);
  const urls: string[] = [];

  for (const key of MEDIA_PARAM_KEYS) {
    for (const value of params.getAll(key)) {
      for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (trimmed) urls.push(trimmed);
      }
    }
  }

  return [...new Set(urls)];
}

export function stripMediaParamsFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of MEDIA_PARAM_KEYS) {
    params.delete(key);
  }
  const next = params.toString();
  return next ? `?${next}` : '';
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').pop() ?? 'media';
    const decoded = decodeURIComponent(base.split('?')[0]);
    return decoded || 'media';
  } catch {
    return 'media';
  }
}

export async function fetchUrlAsFile(url: string): Promise<File> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(`Network error: ${url}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  const blob = await response.blob();
  const name = filenameFromUrl(url);
  const type = blob.type || 'application/octet-stream';
  return new File([blob], name, { type });
}
