/**
 * The fallback engine: `MediaRecorder` streaming to disk, exactly as phase 14 built it.
 *
 * It stays because not every browser can read raw frames out of a stream, and a recorder
 * that only works in Chrome is not a recorder. What it costs is the container: MediaRecorder
 * writes a live profile with no duration and no index, so a file from this engine has to be
 * rebuilt before it will scrub — see `containerFix`.
 */
import { ChunkSink } from './ChunkSink';
import type { SourceEngine, SourceEngineStats, StoppedSource } from './engine';
import { pickAudioMime, pickVideoMime } from './sources';

/** How often MediaRecorder hands us bytes. Smaller means less lost to a crash. */
const CHUNK_MS = 1000;

export function mediaRecorderExtension(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

export function mediaRecorderMime(video: boolean): string {
  const choice = video ? pickVideoMime() : pickAudioMime();
  return choice.mimeType || (video ? 'video/webm' : 'audio/webm');
}

export class MediaRecorderSourceEngine implements SourceEngine {
  readonly engine = 'mediarecorder' as const;
  readonly needsRepair = true;
  readonly mimeType: string;
  readonly fileName: string;

  private recorder: MediaRecorder;
  private sink: ChunkSink;
  /**
   * When `start()` was called, which is where this source's media timeline begins.
   *
   * Not the `onstart` event: that fires after an encoder-init hop, and the hop is far
   * longer for video than for audio — measuring it put the screen 74ms behind the two
   * audio sources whose content was in fact within 13ms of it. The event lags the media;
   * the call does not.
   */
  private startCalledMs = 0;

  private constructor(recorder: MediaRecorder, sink: ChunkSink, mimeType: string, fileName: string) {
    this.recorder = recorder;
    this.sink = sink;
    this.mimeType = mimeType;
    this.fileName = fileName;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) void sink.write(event.data);
    };
  }

  /**
   * The bitrates are passed here too, and were not before.
   *
   * They were easy to forget because this engine only runs on browsers that cannot do the
   * other one — but a fallback that ignores the setting is worse than no setting: someone
   * picks 600 kbps for an hour-long call, gets Chrome's own default of about 2.5 Mbps, and
   * has no way to tell which engine wrote the file that filled the disk. Two engines, one
   * rule.
   */
  static async open(
    stream: MediaStream,
    options: {
      fileName: string;
      mimeType: string;
      videoBitrate?: number;
      audioBitrate?: number;
    },
  ): Promise<MediaRecorderSourceEngine> {
    const config: MediaRecorderOptions = {
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
      ...(options.videoBitrate ? { videoBitsPerSecond: options.videoBitrate } : {}),
      ...(options.audioBitrate ? { audioBitsPerSecond: options.audioBitrate } : {}),
    };
    const recorder = new MediaRecorder(stream, config);
    const sink = await ChunkSink.open(options.fileName);
    return new MediaRecorderSourceEngine(
      recorder,
      sink,
      options.mimeType || recorder.mimeType,
      options.fileName,
    );
  }

  start(): void {
    this.startCalledMs = performance.now();
    this.recorder.start(CHUNK_MS);
  }

  mediaStartMs(): number {
    return this.startCalledMs;
  }

  stats(): SourceEngineStats {
    return {
      bytesWritten: this.sink.bytesWritten,
      pending: this.sink.pending,
      error: this.sink.error,
      // MediaRecorder does its own encoding and reports nothing about what it dropped.
      framesDelivered: 0,
      framesEncoded: 0,
      framesDropped: 0,
    };
  }

  async stop(): Promise<StoppedSource> {
    const stoppedAtMs = await new Promise<number>((resolve) => {
      if (this.recorder.state === 'inactive') {
        resolve(performance.now());
        return;
      }
      this.recorder.onstop = () => resolve(performance.now());
      this.recorder.onerror = () => resolve(performance.now());
      this.recorder.stop();
    });
    const bytes = await this.sink.close();
    return { bytes, stoppedAtMs };
  }

  async cancel(): Promise<void> {
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await this.sink.close();
  }
}
