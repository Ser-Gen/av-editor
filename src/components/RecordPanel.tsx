import { SOURCE_LABELS } from '../capture/recordingStore';
import { CAPTURE_STEP_LABELS } from '../capture/sources';
import type { CaptureController } from '../capture/useCaptureSession';
import { formatDuration } from '../utils/time';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface Props {
  capture: CaptureController;
}

/**
 * The Record panel. Three things here are deliberate rather than decorative: the level
 * meters, so a dead microphone is obvious in the first second instead of after the take;
 * the byte counter, which is proof the capture is reaching disk rather than filling the
 * heap; and the system-audio warning, which appears *before* recording so nobody discovers
 * a silent track afterwards.
 */
export function RecordPanel({ capture }: Props) {
  const { phase, request, setRequest, status, notice, orphans } = capture;
  const busy = phase === 'starting' || phase === 'finishing';
  const recording = phase === 'recording';
  const levels = new Map(status?.sources.map((s) => [s.kind, s]) ?? []);

  const toggle = (key: keyof typeof request) => {
    if (recording || busy) return;
    setRequest({ ...request, [key]: !request[key] });
  };

  return (
    <div className="record-panel">
      <div className="record-sources">
        {(['screen', 'mic', 'systemAudio'] as const).map((key) => {
          const kind = key === 'systemAudio' ? 'system' : key;
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
              {kind !== 'screen' && (
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

      {request.systemAudio && phase === 'idle' && (
        <p className="record-option-note record-option-note--block">
          System audio is always captured unprocessed.
        </p>
      )}

      {request.systemAudio && !capture.systemAudioLikely && phase === 'idle' && (
        <p className="record-warning">{capture.systemAudioNote}</p>
      )}

      <div className="record-controls">
        <button
          type="button"
          className={recording ? 'btn-record-active' : 'btn-record'}
          disabled={busy}
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
