function pickMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

export function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

export function recordingFileName(mimeType: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `mic-recording_${stamp}.${extensionForMimeType(mimeType)}`;
}

export class MicrophoneRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = '';

  get recordingMimeType(): string {
    return this.mimeType;
  }

  async start(): Promise<void> {
    if (this.recorder?.state === 'recording') return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.mimeType = pickMimeType();
    this.chunks = [];
    this.recorder = this.mimeType
      ? new MediaRecorder(this.stream, { mimeType: this.mimeType })
      : new MediaRecorder(this.stream);

    if (!this.mimeType) {
      this.mimeType = this.recorder.mimeType || 'audio/webm';
    }

    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    this.recorder.start(250);
  }

  stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      this.cleanup();
      return Promise.reject(new Error('No active recording'));
    }

    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.cleanup();
        if (blob.size === 0) {
          reject(new Error('Recording is empty'));
          return;
        }
        resolve(blob);
      };
      recorder.onerror = () => {
        this.cleanup();
        reject(new Error('Recording failed'));
      };
      recorder.stop();
    });
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
