import { useEffect, useRef } from 'react';
import { SOURCE_LABELS } from '../capture/recordingStore';
import type { CaptureSourceKind } from '../capture/recordingStore';
import {
  CAMERA_HEIGHT,
  CAMERA_WIDTH,
  CAPTURE_FPS_CHOICES,
  CAPTURE_SCALE_CHOICES,
  CAPTURE_STEP_LABELS,
  formatLabel,
  scaledSize,
} from '../capture/sources';
import type { CaptureController } from '../capture/useCaptureSession';
import type { SourceStatus } from '../capture/CaptureSession';
import {
  AUDIO_BITRATE_DEFAULT,
  AUDIO_BITRATE_SYSTEM,
  CAPTURE_BITRATE_CHOICES,
  bitrateLabel,
  KEYFRAME_SECONDS_DEFAULT,
  captureKeyFrameSeconds,
  estimatedBytesPerSecond,
  isQualityPreset,
  qualityLabel,
} from '../capture/bitrate';
import { formatDuration } from '../utils/time';
import { useEditorStore } from '../store/editorStore';
import { useStorageBudget } from '../hooks/useStorageBudget';
import {
  canStartRecording,
  formatBytes,
  formatHeadroom,
  headroomSeconds,
} from '../utils/storageBudget';
import type { SourceRequest } from '../capture/sources';
import type { CaptureBitrate } from '../capture/bitrate';

/**
 * What a video source is doing, in the two numbers that disagree.
 *
 * `getSettings()` reports what the track negotiated and goes on reporting it even when the
 * camera quietly halves its output — in dim light a driver lengthens exposure and delivers
 * 30 while still calling itself 60. So the delivered rate is shown beside the negotiated
 * one, and the two diverging is the readout doing its job, not a bug in the counter.
 */
function VideoReadout({ source }: { source: SourceStatus }) {
  if (!source.format) return null;
  const delivered = source.deliveredFps;
  const negotiated = source.format.frameRate;
  const starved = delivered > 0 && negotiated > 0 && delivered < negotiated * 0.8;
  return (
    <span className={`record-format${starved ? ' is-starved' : ''}`}>
      {formatLabel(source.format)}
      {delivered > 0 && ` · ${Math.round(delivered)} delivered`}
    </span>
  );
}

/** The preview, mirrored — see the note on `mirrorNote` below. */
function CameraPreview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} className="record-camera-preview" muted playsInline />;
}

/**
 * What a take *would* write per second, before it starts.
 *
 * Nothing has been negotiated yet, so the project's own frame size and rate stand in for the
 * screen. It is an estimate of an estimate and is worded as one — but it is the only number
 * available at the moment it can still change someone's mind.
 */
function plannedSources(
  request: SourceRequest,
  settings: { width: number; height: number },
): { width: number; height: number; fps: number }[] {
  const video: { width: number; height: number; fps: number }[] = [];
  // The *requested* rate, not the project's. Reading the project's meant a 30 fps project
  // priced a 60 fps screen capture at half its real cost, and the estimate only corrected
  // itself once the take was already running — after the moment it could have changed a mind.
  if (request.screen) {
    video.push({ ...scaledSize(settings.width, settings.height, request.scale), fps: request.fps });
  }
  if (request.camera) {
    video.push({ ...scaledSize(CAMERA_WIDTH, CAMERA_HEIGHT, request.scale), fps: request.fps });
  }
  return video;
}

function plannedAudio(request: SourceRequest): number[] {
  const rates: number[] = [];
  if (request.mic) rates.push(AUDIO_BITRATE_DEFAULT);
  if (request.systemAudio) rates.push(AUDIO_BITRATE_SYSTEM);
  return rates;
}

function plannedBytesPerSecond(
  request: SourceRequest,
  settings: { width: number; height: number; fps: number },
): number {
  return estimatedBytesPerSecond(
    plannedSources(request, settings),
    plannedAudio(request),
    request.videoBitrate,
  );
}

/** `1080p60 · Normal` — what the estimate below it is an estimate *of*. */
function plannedFormatLabel(
  request: SourceRequest,
  settings: { width: number; height: number },
): string {
  const sources = plannedSources(request, settings);
  const shape = sources[0] ? qualityLabel(sources[0].height, sources[0].fps) : 'audio only';
  return `${shape} · ${bitrateLabel(request.videoBitrate)}`;
}

/** What this take is on course to write in an hour, from the formats in use right now. */
function hourlyBytes(sources: SourceStatus[], bitrate: CaptureBitrate): number {
  const video = sources
    .filter((s) => s.format)
    .map((s) => ({ width: s.format!.width, height: s.format!.height, fps: s.format!.frameRate }));
  const audio = sources
    .filter((s) => !s.format)
    .map((s) => (s.kind === 'system' ? AUDIO_BITRATE_SYSTEM : AUDIO_BITRATE_DEFAULT));
  return estimatedBytesPerSecond(video, audio, bitrate) * 3600;
}

interface Props {
  capture: CaptureController;
}

/**
 * Mirroring is a one-way door, and this is the sentence that says so.
 *
 * The preview is mirrored because that is what people expect of their own face. The
 * recording is not: a mirror baked in at encode time can never be taken out again, and
 * every frame of text in shot would be backwards forever. A mirrored result is a
 * horizontal-flip effect on the clip, added and removed at will.
 */
const MIRROR_NOTE = 'The preview is mirrored; the recording is not.';

/**
 * The Record panel. Three things here are deliberate rather than decorative: the level
 * meters, so a dead microphone is obvious in the first second instead of after the take;
 * the byte counter, which is proof the capture is reaching disk rather than filling the
 * heap; and the system-audio warning, which appears *before* recording so nobody discovers
 * a silent track afterwards.
 */
export function RecordPanel({ capture }: Props) {
  const { phase, request, setRequest, status, notice, orphans, setPreviewWanted } = capture;
  const busy = phase === 'starting' || phase === 'finishing';
  const recording = phase === 'recording';
  const levels = new Map(status?.sources.map((s) => [s.kind, s]) ?? []);

  // Storage, in the unit the question is actually asked in. During a take the rate comes
  // from the formats really negotiated; before one, from the project's own shape.
  const settings = useEditorStore((s) => s.settings);
  const { budget } = useStorageBudget();
  const measured = status?.sources.some((s) => s.format) ?? false;
  const bytesPerSecond = measured
    ? hourlyBytes(status?.sources ?? [], request.videoBitrate) / 3600
    : plannedBytesPerSecond(request, settings);
  // The estimate is not refreshed during a take — the library does not change — so the bytes
  // this take has already written are subtracted to keep the figure honest as it counts down.
  const freeNow = budget ? Math.max(0, budget.free - (recording ? (status?.bytesTotal ?? 0) : 0)) : 0;
  const headroom = budget ? headroomSeconds(freeNow, bytesPerSecond) : Infinity;
  // Refusing is the kinder failure: a take that dies at minute 38 has already cost the
  // thing it was recording.
  const noRoom = !!budget && !recording && !canStartRecording(freeNow, bytesPerSecond);
  // Only ever shown while idle, so the planned shape is the right one to ask about.
  const plannedFirst = plannedSources(request, settings)[0];
  const keyFrameSeconds = plannedFirst
    ? captureKeyFrameSeconds(
        plannedFirst.width,
        plannedFirst.height,
        plannedFirst.fps,
        request.videoBitrate,
      )
    : KEYFRAME_SECONDS_DEFAULT;

  // The camera is held open only while this panel is on screen: elsewhere it would light
  // the indicator and lock the device against other applications for nothing.
  useEffect(() => {
    setPreviewWanted(true);
    return () => setPreviewWanted(false);
  }, [setPreviewWanted]);

  const toggle = (key: keyof typeof request) => {
    if (recording || busy) return;
    setRequest({ ...request, [key]: !request[key] });
  };

  return (
    <div className="record-panel">
      <div className="record-sources">
        {(['screen', 'camera', 'mic', 'systemAudio'] as const).map((key) => {
          const kind: CaptureSourceKind = key === 'systemAudio' ? 'system' : key;
          const source = levels.get(kind);
          return (
            <button
              key={key}
              type="button"
              className={`record-source${request[key] ? ' is-on' : ''}`}
              disabled={recording || busy}
              onClick={() => toggle(key)}
              title={
                key === 'systemAudio'
                  ? capture.systemAudioNote
                  : `Capture ${SOURCE_LABELS[kind].toLowerCase()}`
              }
            >
              <span className="record-source-name">{SOURCE_LABELS[kind]}</span>
              {kind !== 'screen' && kind !== 'camera' && (
                <span className="record-meter" aria-hidden>
                  <span
                    className="record-meter-fill"
                    style={{ width: `${Math.round((source?.level ?? 0) * 100)}%` }}
                  />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/*
        All three are locked once a take is running: the encoder and the tracks were
        configured from them at `start`, and a control that silently applied to the *next*
        recording would be worse than one that is greyed out.
      */}
      <div className="record-format">
        <label className="record-format-field">
          <span>Frame rate</span>
          <select
            value={request.fps}
            disabled={recording || busy}
            onChange={(e) => setRequest({ ...request, fps: Number(e.target.value) })}
          >
            {CAPTURE_FPS_CHOICES.map((rate) => (
              <option key={rate} value={rate}>
                {rate} fps
              </option>
            ))}
          </select>
        </label>
        <label
          className="record-format-field"
          title="A fraction of whatever the source turns out to be — a screen picker decides the resolution, not this app."
        >
          <span>Scale</span>
          <select
            value={request.scale}
            disabled={recording || busy}
            onChange={(e) => setRequest({ ...request, scale: Number(e.target.value) })}
          >
            {CAPTURE_SCALE_CHOICES.map((s) => (
              <option key={s} value={s}>
                {Math.round(s * 100)}%
              </option>
            ))}
          </select>
        </label>
        {/*
          One control, two kinds of answer. A preset sizes itself to whatever the picture
          turns out to be, which is right for anything that will be edited; a fixed rate is
          for the recording nobody will edit and everybody has to store — an hour of a call
          whose shared screen is a slide.
        */}
        <label
          className="record-format-field"
          title="A preset scales with the picture. A fixed rate does not — that is the point of naming one."
        >
          <span>Video bitrate</span>
          <select
            value={String(request.videoBitrate)}
            disabled={recording || busy}
            onChange={(e) => {
              const raw = e.target.value;
              const next: CaptureBitrate = /^[0-9]+$/.test(raw)
                ? Number(raw)
                : (raw as CaptureBitrate);
              setRequest({ ...request, videoBitrate: next });
            }}
          >
            <optgroup label="Sized to the picture">
              {CAPTURE_BITRATE_CHOICES.filter(isQualityPreset).map((b) => (
                <option key={b} value={b}>
                  {bitrateLabel(b)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Fixed rate, per video source">
              {CAPTURE_BITRATE_CHOICES.filter((b) => !isQualityPreset(b)).map((b) => (
                <option key={String(b)} value={String(b)}>
                  {bitrateLabel(b)}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
      </div>
      {phase === 'idle' && (
        <p className="record-option-note record-option-note--block">
          Rate and scale are what the display or camera are asked for, not what they must
          give — the panel reports what each track actually negotiated once recording starts.
          Scale is a fraction of the source, because a share picker decides the resolution and
          a window is whatever size you left it. Anything that would come out under
          128&nbsp;px on an edge is left unscaled. A fixed bitrate is spent per video source,
          and is spent only where the picture moves — a screen that sits still costs far less
          than the number suggests.
        </p>
      )}

      {phase === 'idle' && keyFrameSeconds > KEYFRAME_SECONDS_DEFAULT && (
        <p className="record-option-note record-option-note--block">
          At this rate a key frame is worth more than a whole second of video, so one is
          written every {keyFrameSeconds} seconds instead of every one. That is what makes a
          low bitrate look clean rather than smeared — the cost is that scrubbing lands on a{' '}
          {keyFrameSeconds}-second grid, and a tab killed mid-take loses up to{' '}
          {keyFrameSeconds} seconds of the recording instead of one.
        </p>
      )}

      {request.mic && (
        <label className="record-option" title="Chrome's voice processing: right for a voice in a room, wrong for anything recorded as music or as a performance.">
          <input
            type="checkbox"
            checked={request.processMic}
            disabled={recording || busy}
            onChange={() => setRequest({ ...request, processMic: !request.processMic })}
          />
          <span>
            Clean up the microphone
            <span className="record-option-note">
              echo cancellation, noise suppression, auto gain — off for music
            </span>
          </span>
        </label>
      )}

      {request.camera && (phase === 'idle' || recording) && (
        <div className="record-camera">
          {phase === 'idle' && capture.cameras.length > 1 && (
            <label className="record-camera-pick">
              <span>Camera</span>
              <select
                value={request.cameraDeviceId ?? ''}
                disabled={recording || busy}
                onChange={(e) => setRequest({ ...request, cameraDeviceId: e.target.value })}
              >
                {capture.cameras.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {capture.cameraPreview ? (
            <CameraPreview stream={capture.cameraPreview} />
          ) : (
            phase === 'idle' && (
              <p className="record-option-note record-option-note--block">
                {capture.cameras.length === 0
                  ? 'No camera found. Plug one in and it will appear here.'
                  : 'Opening the camera…'}
              </p>
            )
          )}
          {phase === 'idle' && (
            <p className="record-option-note record-option-note--block">
              {MIRROR_NOTE}
              {request.screen ? ' It lands above the screen as a picture-in-picture.' : ''}
            </p>
          )}
        </div>
      )}

      {request.systemAudio && phase === 'idle' && (
        <p className="record-option-note record-option-note--block">
          System audio is always captured unprocessed.
        </p>
      )}

      {request.systemAudio && !capture.systemAudioLikely && phase === 'idle' && (
        <p className="record-warning">{capture.systemAudioNote}</p>
      )}

      {budget && !recording && (
        <p className={`record-headroom${noRoom ? ' is-blocked' : headroom <= 15 * 60 ? ' is-low' : ''}`}>
          ≈ {formatBytes(bytesPerSecond * 3600)} per hour at{' '}
          {measured ? formatLabel(status?.sources.find((s) => s.format)?.format ?? null) : plannedFormatLabel(request, settings)} ·{' '}
          {noRoom
            ? `only ${formatHeadroom(headroom)} of space left — free some up before recording.`
            : `room for ${formatHeadroom(headroom)}.`}
        </p>
      )}

      <div className="record-controls">
        <button
          type="button"
          className={recording ? 'btn-record-active' : 'btn-record'}
          disabled={busy || noRoom}
          onClick={() => void (recording ? capture.stop() : capture.start())}
        >
          {recording
            ? 'Stop'
            : phase === 'finishing'
              ? 'Finishing…'
              : phase === 'starting'
                ? 'Starting…'
                : 'Record'}
        </button>
        {phase === 'starting' && capture.step && (
          <span className="record-readout">{CAPTURE_STEP_LABELS[capture.step]}</span>
        )}
        {/*
          The only control that is live while starting, and it has to be: every step of a
          start waits on something outside the page — a picker, a permission prompt, a track
          being asked to resize — and any of them can sit there forever without erroring.
          Without this the whole panel is disabled and the only way out is reloading the page
          and losing the project.
        */}
        {phase === 'starting' && (
          <button type="button" className="record-discard" onClick={() => capture.cancelStart()}>
            Cancel
          </button>
        )}
        {recording && (
          <button type="button" className="record-discard" onClick={() => void capture.cancel()}>
            Discard
          </button>
        )}
        {recording && status && (
          <span className="record-readout">
            <span className="record-dot" />
            {formatDuration(status.elapsed)} · {formatBytes(status.bytesTotal)}
          </span>
        )}
      </div>

      {recording && status && status.sources.some((s) => s.format) && (
        <ul className="record-formats">
          {status.sources
            .filter((s) => s.format)
            .map((s) => (
              <li key={s.kind}>
                <span className="record-source-name">{SOURCE_LABELS[s.kind]}</span>
                <VideoReadout source={s} />
                {s.endedReason && <span className="record-ended">stopped early</span>}
              </li>
            ))}
        </ul>
      )}

      {phase === 'starting' && capture.stalled && (
        <p className="record-warning">{capture.stalled}</p>
      )}

      {recording && status?.degraded && <p className="record-warning">{status.degraded}</p>}

      {recording && status && (
        <p className={`record-disk${status.writing ? ' is-writing' : ''}`}>
          {status.writing ? 'Writing to disk…' : 'On disk'} — nothing is held in memory.
          {status.engine === 'webcodecs' && status.sources.some((s) => s.framesEncoded > 0) && (
            <>
              {' '}
              {status.droppedFrames === 0
                ? 'No dropped frames.'
                : `${status.droppedFrames} dropped frame${status.droppedFrames === 1 ? '' : 's'}.`}
            </>
          )}
          {/* From the formats actually negotiated, so 60 fps reads as the extra bytes it is
              rather than as the fixed number a 30 fps assumption would print. */}
          {status.sources.some((s) => s.format) && (
            <>
              {' '}≈ {formatBytes(hourlyBytes(status.sources, request.videoBitrate))} per hour at this rate
              {budget && <>, room for {formatHeadroom(headroom)}</>}.
            </>
          )}
        </p>
      )}

      {capture.engine && (
        <p className="record-engine" title={capture.engine.fallbackFrom ?? capture.engine.reason}>
          {capture.engine.reason}
          {capture.engine.fallbackFrom ? ` ${capture.engine.fallbackFrom}` : ''}
        </p>
      )}

      {notice && <p className="record-notice">{notice}</p>}

      {orphans.length > 0 && phase === 'idle' && (
        <div className="record-recovery">
          <p className="record-recovery-title">
            {orphans.some((o) => o.interrupted)
              ? 'A recording was interrupted'
              : 'Recordings found on disk'}
          </p>
          <ul>
            {orphans.map((orphan) => (
              <li key={orphan.meta.id}>
                <span>
                  {orphan.label} · {formatBytes(orphan.sizeBytes)}
                  {orphan.interrupted ? ' · unfinished' : ''}
                </span>
                <span className="record-recovery-actions">
                  <button type="button" onClick={() => void capture.restore(orphan)}>
                    Restore
                  </button>
                  <button type="button" onClick={() => void capture.discard(orphan)}>
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
