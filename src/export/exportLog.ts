import type { FFmpeg } from '@ffmpeg/ffmpeg';

const MAX_LOG_LINES = 200;
const recentLogs: string[] = [];
const loggingAttached = new WeakSet<FFmpeg>();

export function clearExportLogs(): void {
  recentLogs.length = 0;
}

export function getRecentExportLogs(): readonly string[] {
  return recentLogs;
}

function pushLog(line: string): void {
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOG_LINES) {
    recentLogs.shift();
  }
}

export function attachFfmpegLogging(ffmpeg: FFmpeg, tag = 'FFmpeg'): void {
  if (loggingAttached.has(ffmpeg)) return;
  loggingAttached.add(ffmpeg);

  ffmpeg.on('log', ({ type, message }) => {
    const line = `[${tag}] [${type}] ${message}`;
    pushLog(line);
    if (type === 'stderr') {
      console.error(line);
    } else {
      console.log(line);
    }
  });
}

export function formatExportError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function logExportError(err: unknown, context?: string): void {
  const msg = formatExportError(err);
  const prefix = context ? `[Export] ${context}: ` : '[Export] ';
  console.error(prefix + msg);
  if (recentLogs.length > 0) {
    console.groupCollapsed('[Export] Recent FFmpeg log');
    for (const line of recentLogs.slice(-40)) {
      console.log(line);
    }
    console.groupEnd();
  }
}
