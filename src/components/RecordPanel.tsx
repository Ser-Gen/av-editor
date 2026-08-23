import { useEffect, useRef } from 'react';
import { SOURCE_LABELS } from '../capture/recordingStore';
import type { CaptureSourceKind } from '../capture/recordingStore';
import { CAPTURE_STEP_LABELS, formatLabel } from '../capture/sources';
import type { CaptureController } from '../capture/useCaptureSession';
import type { SourceStatus } from '../capture/CaptureSession';
import { estimatedBytesPerSecond } from '../capture/bitrate';
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
function plannedBytesPerSecond(
  request: SourceRequest,
  settings: { width: number; height: number; fps: number },
): number {
  const video: { width: number; height: number; fps: number }[] = [];
  if (request.screen) video.push(settings);
  if (request.camera) video.push(settings);
  const audio = (request.mic ? 1 : 0) + (request.systemAudio ? 1 : 0);
  return estimatedBytesPerSecond(video, audio);
}

/** What this take is on course to write in an hour, from the formats in use right now. */
function hourlyBytes(sources: SourceStatus[]): number {
  const video = sources
    .filter((s) => s.format)
    .map((s) => ({ width: s.format!.width, height: s.format!.height, fps: s.format!.frameRate }));
  const audio = sources.filter((s) => !s.format).length;
  return estimatedBytesPerSecond(video, audio) * 3600;
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
    ? hourlyBytes(status?.sources ?? []) / 3600
    : plannedBytesPerSecond(request, settings);
  // The estimate is not refreshed during a take — the library does not change — so the bytes
  // this take has already written are subtracted to keep the figure honest as it counts down.
  const freeNow = budget ? Math.max(0, budget.free - (recording ? (status?.bytesTotal ?? 0) : 0)) : 0;
  const headroom = budget ? headroomSeconds(freeNow, bytesPerSecond) : Infinity;
  // Refusing is the kinder failure: a take that dies at minute 38 has already cost the
  // thing it was recording.
  const noRoom = !!budget && !recording && !canStartRecording(freeNow, bytesPerSecond);

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
          ≈ {formatBytes(bytesPerSecond * 3600)} per hour at this quality ·{' '}
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
              {' '}≈ {formatBytes(hourlyBytes(status.sources))} per hour at this rate
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
