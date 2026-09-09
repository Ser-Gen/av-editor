import type { CaptureController } from '../capture/useCaptureSession';
import type { SourceStatus } from '../capture/CaptureSession';
import { SOURCE_LABELS } from '../capture/recordingStore';
import { formatLabel } from '../capture/sources';
import { formatBytes } from '../utils/storageBudget';
import { formatDuration } from '../utils/time';

/**
 * What every source is doing, while it is doing it.
 *
 * Pulled out of `RecordPanel`, which also owns setup, device choice and crash recovery: while
 * a take is running, none of that is what you are looking for, and a control you have to find
 * among the settings that started the take is a control you reach for too late.
 *
 * Each row answers three questions in the order they get asked: is this source alive, is it
 * keeping up, and can I turn it off. Muting is silence in place — the file keeps running and
 * keeps its length, so a muted stretch costs nothing to line up afterwards.
 */
export function RecordingControl({ capture }: { capture: CaptureController }) {
  const status = capture.status;
  if (!status) return null;

  return (
    <div className="recording-control">
      <div className="recording-head">
        <span className="record-dot" />
        <strong className="recording-elapsed">{formatDuration(status.elapsed)}</strong>
        <span className="recording-bytes">{formatBytes(status.bytesTotal)}</span>
        <div className="spacer" />
        <button type="button" className="primary" onClick={() => void capture.stop()}>
          Stop
        </button>
        <button type="button" className="record-discard" onClick={() => void capture.cancel()}>
          Discard
        </button>
      </div>

      <ul className="recording-sources">
        {status.sources.map((source) => (
          <SourceRow
            key={source.kind}
            source={source}
            onMute={(muted) => capture.setSourceMuted(source.kind, muted)}
            onStop={() => void capture.stopSource(source.kind)}
            canStopSource={status.sources.filter((s) => !s.endedReason).length > 1}
          />
        ))}
      </ul>
    </div>
  );
}

function SourceRow({
  source,
  onMute,
  onStop,
  canStopSource,
}: {
  source: SourceStatus;
  onMute: (muted: boolean) => void;
  onStop: () => void;
  canStopSource: boolean;
}) {
  const ended = !!source.endedReason;
  // The gap between negotiated and delivered is the one worth colouring: it is the only
  // symptom of a machine that cannot keep up, and it is invisible in the finished file.
  const negotiated = source.format?.frameRate ?? 0;
  const starved =
    !ended && source.deliveredFps > 0 && negotiated > 0 && source.deliveredFps < negotiated * 0.8;

  return (
    <li className={`recording-source${ended ? ' is-ended' : ''}${source.muted ? ' is-muted' : ''}`}>
      <span className="recording-source-name">{SOURCE_LABELS[source.kind]}</span>

      <span className="recording-source-format">
        {source.format ? formatLabel(source.format) : source.canMute ? 'audio' : '—'}
      </span>

      {/*
        Negotiated against delivered. The gap is the point: a camera in dim light lengthens
        its exposure and halves its output without renegotiating, so the track goes on
        claiming 60 while 30 arrive.
      */}
      <span className={`recording-source-rate${starved ? ' is-starved' : ''}`} title={
        starved ? 'Delivering well under what the track negotiated' : undefined
      }>
        {ended
          ? 'stopped'
          : source.format
            ? `${Math.round(source.deliveredFps)} fps`
            : source.muted
              ? 'muted'
              : ''}
      </span>

      <span className="record-level" title={source.canMute ? 'Input level' : 'No audio on this source'}>
        <span
          className="record-level-fill"
          style={{ width: `${Math.round(source.level * 100)}%` }}
        />
      </span>

      <span className="recording-source-actions">
        {source.canMute && !ended && (
          <button
            type="button"
            className={source.muted ? 'is-active' : ''}
            title={
              source.muted
                ? 'Unmute. The file has been recording silence, at full length'
                : 'Record silence from here. The file keeps running, so nothing needs re-aligning'
            }
            onClick={() => onMute(!source.muted)}
          >
            {source.muted ? 'Muted' : 'Mute'}
          </button>
        )}
        {!ended && (
          <button
            type="button"
            disabled={!canStopSource}
            title={
              canStopSource
                ? 'End this source now. The file is finalized and playable, and the rest of the take carries on'
                : 'The last source — stopping it would end the take'
            }
            onClick={onStop}
          >
            End
          </button>
        )}
      </span>

      {source.droppedFrames > 0 && !ended && (
        <span className="recording-source-note">{source.droppedFrames} dropped</span>
      )}
      {ended && <span className="recording-source-note">{source.endedReason}</span>}
      {source.error && <span className="recording-source-note is-error">{source.error}</span>}
    </li>
  );
}
