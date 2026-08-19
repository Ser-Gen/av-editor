/**
 * Getting the streams, and being honest about what the platform actually gave us.
 *
 * System audio is the part that lies most easily. `getDisplayMedia({ audio: true })`
 * resolves happily on platforms that cannot capture system audio at all — Firefox and
 * Safari ignore the constraint outright, and Chrome only offers it for a tab everywhere,
 * for a window or whole screen on Windows/ChromeOS, and on macOS only from 14.2 with a
 * recent Chrome. The result is a stream with no audio track, which would record as a
 * silent file the user does not discover until playback. So the answer is taken from the
 * stream itself after the picker returns, never assumed from the request.
 */

export type MimeChoice = { mimeType: string; container: 'webm' | 'mp4' };

export interface SystemAudioSupport {
  /** False when we can say up front that this platform will not provide it. */
  likely: boolean;
  reason: string;
}

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent);

export function systemAudioSupport(): SystemAudioSupport {
  const agent = ua();
  const isChromium = /Chrome\/(\d+)/.test(agent) && !/Firefox/.test(agent);
  if (!isChromium) {
    return {
      likely: false,
      reason: 'This browser ignores the system-audio request. Only tab or screen video will be captured.',
    };
  }
  const chromeVersion = Number(/Chrome\/(\d+)/.exec(agent)?.[1] ?? 0);
  const isMac = /Mac OS X/.test(agent);
  if (isMac && chromeVersion < 141) {
    return {
      likely: false,
      reason:
        'On macOS, capturing system audio for a window or the whole screen needs Chrome 141+ (macOS 14.2+). Sharing a tab still captures that tab’s audio.',
    };
  }
  if (isMac) {
    return {
      likely: true,
      reason: 'On macOS, system audio comes through for a shared tab, and for a window or screen on macOS 14.2+.',
    };
  }
  return { likely: true, reason: 'Share a tab, window or screen and tick “Share audio” in the picker.' };
}

/** Container preference: WebM first, because its repair path is the one we control. */
export function pickVideoMime(): MimeChoice {
  const candidates: MimeChoice[] = [
    { mimeType: 'video/webm;codecs=vp9,opus', container: 'webm' },
    { mimeType: 'video/webm;codecs=vp8,opus', container: 'webm' },
    { mimeType: 'video/webm', container: 'webm' },
    { mimeType: 'video/mp4', container: 'mp4' },
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
  }
  return { mimeType: '', container: 'webm' };
}

export function pickAudioMime(): MimeChoice {
  const candidates: MimeChoice[] = [
    { mimeType: 'audio/webm;codecs=opus', container: 'webm' },
    { mimeType: 'audio/webm', container: 'webm' },
    { mimeType: 'audio/mp4', container: 'mp4' },
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
  }
  return { mimeType: '', container: 'webm' };
}

export interface AcquiredSources {
  screen: MediaStream | null;
  /** Only present when the platform really handed one over. */
  systemAudio: MediaStream | null;
  mic: MediaStream | null;
  /** Set when system audio was asked for and not granted — shown to the user. */
  systemAudioMissing: string | null;
  /** Set when the microphone was asked for and refused, and other sources still recorded. */
  micMissing: string | null;
  /** Set when the platform processed system audio anyway — see `unexpectedProcessing`. */
  systemAudioProcessed: string | null;
}

export interface SourceRequest {
  screen: boolean;
  mic: boolean;
  systemAudio: boolean;
  /**
   * Echo cancellation, noise suppression and automatic gain on the *microphone*.
   *
   * On for a voice in a room, which is what a microphone usually is. Off for anything being
   * recorded as music or as a performance, where the same three processors are damage.
   */
  processMic: boolean;
}

/**
 * What to ask for when the audio must arrive as it was, unprocessed.
 *
 * This is not a preference for system audio, which is why there is no toggle for it. Echo
 * cancellation on system audio tries to remove the very signal being captured; noise
 * suppression is trained on speech and treats sustained music as noise to be gated;
 * automatic gain rides the level up and down under anything with dynamics. All three are
 * right for a microphone in a room and wrong for a soundtrack.
 *
 * Chrome applies its own defaults when the audio constraint is a bare `true`, which is what
 * this replaces — the constraints have to be stated to be off.
 */
const UNPROCESSED_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

const PROCESSED_AUDIO: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Which processors a track ended up with, when we asked for none.
 *
 * Audio constraints on a display-capture track are advisory — a browser is free to ignore
 * them and hand back a processed track anyway. Same rule as system audio availability: read
 * it off the track rather than assuming the request was honoured, and only say something
 * when reality differs from what was asked for.
 */
function unexpectedProcessing(stream: MediaStream | null): string | null {
  const settings = stream?.getAudioTracks()[0]?.getSettings();
  if (!settings) return null;
  const applied = [
    settings.echoCancellation ? 'echo cancellation' : null,
    settings.noiseSuppression ? 'noise suppression' : null,
    settings.autoGainControl ? 'automatic gain' : null,
  ].filter((s): s is string => !!s);
  if (applied.length === 0) return null;
  return `This browser applied ${applied.join(', ')} to system audio despite being asked not to, so the recording is processed rather than raw.`;
}

/**
 * Injectable so tests can drive `CaptureSession` with synthetic streams instead of a
 * picker dialog. The alignment and container work is what needs testing, not the two
 * `navigator.mediaDevices` calls.
 */
export interface SourceProvider {
  getDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export const browserSources: SourceProvider = {
  getDisplayMedia: (c) => navigator.mediaDevices.getDisplayMedia(c),
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
};

/**
 * Where starting a recording currently is.
 *
 * Every one of these steps waits on something outside the page — a picker, a permission
 * prompt, the disk — and any of them can sit there indefinitely without erroring. Reporting
 * the step is what turns "the button went dead" into "it is waiting for the microphone".
 */
export type CaptureStep =
  | 'choosing-engine'
  | 'screen-picker'
  | 'microphone'
  | 'opening-files'
  | 'starting-encoders';

export const CAPTURE_STEP_LABELS: Record<CaptureStep, string> = {
  'choosing-engine': 'Checking what this browser can encode…',
  'screen-picker': 'Waiting for you to choose a screen, window or tab…',
  microphone: 'Waiting for microphone permission — look for the browser’s prompt.',
  'opening-files': 'Opening the recording files on disk…',
  'starting-encoders': 'Starting the encoders…',
};

export type CaptureStepReporter = (step: CaptureStep) => void;

export async function acquireSources(
  request: SourceRequest,
  provider: SourceProvider = browserSources,
  onStep: CaptureStepReporter = () => undefined,
): Promise<AcquiredSources> {
  const result: AcquiredSources = {
    screen: null,
    systemAudio: null,
    mic: null,
    systemAudioMissing: null,
    micMissing: null,
    systemAudioProcessed: null,
  };

  if (request.screen || request.systemAudio) {
    onStep('screen-picker');
    const display = await provider.getDisplayMedia({
      video: request.screen ? { frameRate: 30 } : true,
      // Not a bare `true`: that hands the browser its own defaults, which on Chrome means a
      // soundtrack captured through echo cancellation and automatic gain.
      audio: request.systemAudio ? UNPROCESSED_AUDIO : false,
    });

    const audioTracks = display.getAudioTracks();
    if (request.systemAudio) {
      if (audioTracks.length > 0) {
        // Its own stream, because it becomes its own recorder and its own timeline track.
        result.systemAudio = new MediaStream(audioTracks);
        result.systemAudioProcessed = unexpectedProcessing(result.systemAudio);
      } else {
        result.systemAudioMissing = systemAudioSupport().reason;
      }
    } else {
      for (const track of audioTracks) track.stop();
    }

    if (request.screen) {
      result.screen = new MediaStream(display.getVideoTracks());
    } else {
      for (const track of display.getVideoTracks()) track.stop();
    }
  }

  if (request.mic) {
    // The microphone prompt arrives *after* the screen picker has already been dealt with.
    // Refusing it should not throw away the screen capture the user just chose — that is the
    // same rule system audio follows: record what was granted, say what was not. With the
    // microphone as the only requested source there is nothing left to record, so it stays
    // an error there.
    try {
      onStep('microphone');
      result.mic = await provider.getUserMedia({
        audio: request.processMic ? PROCESSED_AUDIO : UNPROCESSED_AUDIO,
      });
    } catch (e) {
      if (!result.screen && !result.systemAudio) throw e;
      const why = e instanceof Error ? e.message : 'the browser refused it';
      result.micMissing =
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microphone permission was refused, so no microphone track was recorded.'
          : `The microphone could not be opened (${why}), so no microphone track was recorded.`;
    }
  }

  return result;
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
