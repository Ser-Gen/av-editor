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
  camera: MediaStream | null;
  /** Only present when the platform really handed one over. */
  systemAudio: MediaStream | null;
  mic: MediaStream | null;
  /** Set when system audio was asked for and not granted — shown to the user. */
  systemAudioMissing: string | null;
  /** Set when the microphone was asked for and refused, and other sources still recorded. */
  micMissing: string | null;
  /** Set when the camera was asked for and could not be opened, and the rest still recorded. */
  cameraMissing: string | null;
  /** Set when the platform processed system audio anyway — see `unexpectedProcessing`. */
  systemAudioProcessed: string | null;
}

export interface SourceRequest {
  screen: boolean;
  camera: boolean;
  mic: boolean;
  systemAudio: boolean;
  /** Which camera, from `listCameras()`. Undefined lets the browser pick its default. */
  cameraDeviceId?: string;
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
 * What both video sources ask for, and why the numbers are these numbers.
 *
 * 60 rather than 30 because the engine is proven there — phase 15's 1080p60 capture ran at
 * 59.9 fps with no drops — and because a screen recording of anything scrolling looks
 * broken at 30. It is asked for as `ideal`: a camera that only offers 30 must record at 30,
 * not fail to open.
 *
 * 1280×720 for the camera rather than matching the screen. That is not a compromise made
 * for the encoder's sake, although it helps — a typical USB camera offers 720p60 or
 * 1080p30 and not both, and between smooth motion and more lines on a face that will be a
 * quarter of the frame wide, the frame rate is worth more. The panel shows what was
 * actually granted, so a camera that gives something else does not do so quietly.
 */
export const TARGET_FPS = 60;
export const CAMERA_WIDTH = 1280;
export const CAMERA_HEIGHT = 720;

export function cameraConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    // `ideal`, so a remembered camera that has since been unplugged opens the default one
    // instead of throwing. `resolveCameraChoice` already drops ids that are not present.
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    width: { ideal: CAMERA_WIDTH },
    height: { ideal: CAMERA_HEIGHT },
    frameRate: { ideal: TARGET_FPS },
  };
}

/**
 * Why the camera would not open, said in terms of the thing to go and fix.
 *
 * `NotReadableError` is by far the most common of these and the least self-explanatory:
 * the camera opened fine, another application is simply holding it. A generic "recording
 * failed" sends people to their permissions settings, which is the wrong place entirely.
 */
export function cameraFailure(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError') {
    return 'Camera permission was refused, so no camera track was recorded.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is in use by another application — Zoom, Teams, Photo Booth or another browser tab. Close it and start again; the rest was recorded without it.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found, so no camera track was recorded.';
  }
  if (name === 'OverconstrainedError') {
    return 'That camera could not provide any usable format, so no camera track was recorded.';
  }
  const why = e instanceof Error ? e.message : 'the browser refused it';
  return `The camera could not be opened (${why}), so no camera track was recorded.`;
}

export interface VideoFormat {
  width: number;
  height: number;
  frameRate: number;
}

/**
 * The format a video track actually negotiated.
 *
 * Read from the track rather than from the request, which is the same rule system audio
 * follows: what a camera returns from a 1080p60 request is routinely 720p30, and a panel
 * echoing the request back would be describing a file that does not exist.
 */
export function trackFormat(stream: MediaStream | null): VideoFormat | null {
  const settings = stream?.getVideoTracks()[0]?.getSettings();
  if (!settings) return null;
  return {
    width: settings.width ?? 0,
    height: settings.height ?? 0,
    frameRate: Math.round(settings.frameRate ?? 0),
  };
}

export function formatLabel(format: VideoFormat | null): string {
  if (!format || !format.width || !format.height) return 'format unknown';
  const rate = format.frameRate > 0 ? ` · ${format.frameRate} fps` : '';
  return `${format.width} × ${format.height}${rate}`;
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
  | 'camera'
  | 'microphone'
  | 'opening-files'
  | 'starting-encoders';

export const CAPTURE_STEP_LABELS: Record<CaptureStep, string> = {
  'choosing-engine': 'Checking what this browser can encode…',
  'screen-picker': 'Waiting for you to choose a screen, window or tab…',
  camera: 'Opening the camera — look for the browser’s prompt.',
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
    camera: null,
    systemAudio: null,
    mic: null,
    systemAudioMissing: null,
    micMissing: null,
    cameraMissing: null,
    systemAudioProcessed: null,
  };

  if (request.screen || request.systemAudio) {
    onStep('screen-picker');
    const display = await provider.getDisplayMedia({
      // `ideal`, never `exact`: a display that cannot deliver 60 should hand back 30, not
      // throw `OverconstrainedError` and record nothing at all.
      video: request.screen ? { frameRate: { ideal: TARGET_FPS } } : true,
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


  if (request.camera) {
    // Video only. The camera's own microphone is not taken here: with both camera and mic
    // ticked that would capture the same voice twice and put a duplicate on the timeline.
    try {
      onStep('camera');
      result.camera = await provider.getUserMedia({ video: cameraConstraints(request.cameraDeviceId) });
    } catch (e) {
      if (!result.screen && !result.systemAudio && !request.mic) throw e;
      result.cameraMissing = cameraFailure(e);
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
