import { useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { inspectAsset, measureTracks } from '../utils/mediaInfo';
import type { Measurement, MediaInfo } from '../utils/mediaInfo';
import {
  aspectRatio,
  codecLabel,
  decodeSummary,
  describeColorSpace,
  describeRotation,
  formatBitrateValue,
  formatChannels,
  formatFileSize,
  formatFrameRate,
  formatPreciseDuration,
  formatSampleRate,
} from '../utils/mediaInfoFormat';
import type { TrackInfo } from '../utils/mediaInfoFormat';
import { SOURCE_LABELS, readAllMeta } from '../capture/recordingStore';
import type { RecordingMeta } from '../capture/recordingStore';

const ORIGIN_LABEL: Record<string, string> = {
  imported: 'Imported from disk',
  recorded: 'Recorded in this editor',
  derived: 'Made by a library preset',
  pasted: 'Pasted from the clipboard',
};

/** One label/value line. The whole window is these. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
}

function TrackBlock({ track, measured }: { track: TrackInfo; measured?: Measurement }) {
  const stats = measured?.tracks.find((t) => t.id === track.id);

  return (
    <div className="info-track">
      <div className="info-track-head">
        <span className="info-track-kind">{track.kind === 'video' ? 'Video' : 'Audio'}</span>
        <span className="info-track-codec">{codecLabel(track.codec)}</span>
        {!track.canDecode && <span className="info-badge is-warn">no decoder here</span>}
      </div>

      {track.codecString && <Row label="Codec string" value={track.codecString} />}
      {track.language && <Row label="Language" value={track.language} />}

      {track.kind === 'video' ? (
        <>
          <Row
            label="Display size"
            value={`${track.displayWidth} × ${track.displayHeight} · ${aspectRatio(track.displayWidth, track.displayHeight)}`}
          />
          {/*
            Only shown when they disagree. They differ when the file has non-square pixels or a
            rotation in its container — which is exactly when the number someone is looking for
            is not the one the file stored.
          */}
          {(track.codedWidth !== track.displayWidth || track.codedHeight !== track.displayHeight) && (
            <Row label="Coded size" value={`${track.codedWidth} × ${track.codedHeight}`} />
          )}
          {(track.pixelAspect.num !== track.pixelAspect.den) && (
            <Row label="Pixel aspect" value={`${track.pixelAspect.num}:${track.pixelAspect.den}`} />
          )}
          <Row label="Rotation" value={describeRotation(track.rotation)} />
          <Row label="Colour" value={describeColorSpace(track.colorSpace)} />
          {track.hdr && <Row label="Range" value="High dynamic range" />}
          {track.mayHaveAlpha && <Row label="Alpha" value="May contain transparency" />}
          {track.keyFramesOnly && <Row label="Frames" value="All key frames — scrubs exactly" />}
        </>
      ) : (
        <>
          <Row label="Channels" value={formatChannels(track.channels)} />
          <Row label="Sample rate" value={formatSampleRate(track.sampleRate)} />
        </>
      )}

      <Row label="Bitrate" value={formatBitrateValue(track.bitrate)} />

      {stats && (
        <>
          <Row
            label={track.kind === 'video' ? 'Measured rate' : 'Measured packets'}
            value={
              track.kind === 'video'
                ? formatFrameRate(stats.packetRate)
                : `${Math.round(stats.packetRate)} per second`
            }
          />
          <Row label="Measured bitrate" value={formatBitrateValue(stats.averageBitrate)} />
          <Row label="Packets" value={stats.packetCount.toLocaleString()} />
        </>
      )}
    </div>
  );
}

/** The tags the file itself carries — the read side of the export dialog's tag form. */
function TagList({ info }: { info: MediaInfo }) {
  const { tags } = info;
  const image = tags.images?.[0];
  const coverUrl = useMemo(() => {
    if (!image) return null;
    // Copied into a fresh buffer: the view may be over a larger ArrayBuffer than the image.
    return URL.createObjectURL(new Blob([image.data.slice()], { type: image.mimeType }));
  }, [image]);
  useEffect(() => () => { if (coverUrl) URL.revokeObjectURL(coverUrl); }, [coverUrl]);

  const rows: [string, string][] = [];
  const push = (label: string, value: string | number | undefined) => {
    if (value !== undefined && String(value).length > 0) rows.push([label, String(value)]);
  };
  push('Title', tags.title);
  push('Artist', tags.artist);
  push('Album', tags.album);
  push('Album artist', tags.albumArtist);
  push('Genre', tags.genre);
  push('Track', tags.trackNumber && tags.tracksTotal ? `${tags.trackNumber} of ${tags.tracksTotal}` : tags.trackNumber);
  push('Disc', tags.discNumber && tags.discsTotal ? `${tags.discNumber} of ${tags.discsTotal}` : tags.discNumber);
  push('Date', tags.date ? tags.date.toLocaleDateString() : undefined);
  push('Comment', tags.comment);
  push('Description', tags.description);

  if (rows.length === 0 && !coverUrl) {
    return <p className="settings-note">This file carries no descriptive tags.</p>;
  }

  return (
    <div className="info-tags">
      {coverUrl && <img className="info-cover" src={coverUrl} alt="Cover art" />}
      <div className="info-tag-rows">
        {rows.map(([label, value]) => (
          <Row key={label} label={label} value={value} />
        ))}
        {tags.lyrics && <Row label="Lyrics" value={`${tags.lyrics.length} characters`} />}
      </div>
    </div>
  );
}

/**
 * What is actually in a library file.
 *
 * The window answers one question first — will this play here — because that is what sends
 * people looking. An export that declines the fast path names the file and not the reason;
 * the reason is always a track this browser has no decoder for, and it is marked here.
 *
 * Everything shown on open comes from the container's header and index, which the demuxer
 * parsed anyway. The three numbers that need the whole file walked are behind Measure, which
 * says so — on an hour-long recording that walk is not instant.
 */
export function MediaInfoDialog({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const asset = useEditorStore((s) => s.mediaLibrary[assetId]);

  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [measured, setMeasured] = useState<Measurement | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [recording, setRecording] = useState<RecordingMeta | null>(null);

  // Keyed on the file rather than on the asset object: the store replaces library entries for
  // reasons that have nothing to do with the bytes, and re-probing on each of those would
  // also throw away a measurement the user just waited for.
  const file = asset?.file;
  useEffect(() => {
    let live = true;
    setInfo(null);
    setMeasured(null);
    const current = useEditorStore.getState().mediaLibrary[assetId];
    if (!current) return;
    void inspectAsset(current).then((result) => {
      if (live) setInfo(result);
    });
    return () => {
      live = false;
    };
  }, [assetId, file]);

  // The sidecar says how a recording was made, which the file itself cannot.
  useEffect(() => {
    let live = true;
    if (!asset?.recordingId) return;
    void readAllMeta().then((all) => {
      if (live) setRecording(all.find((m) => m.id === asset.recordingId) ?? null);
    });
    return () => {
      live = false;
    };
  }, [asset?.recordingId]);

  if (!asset) return null;

  const runMeasure = async () => {
    setMeasuring(true);
    try {
      const result = await measureTracks(asset);
      // The walk outlives a close on a long file; React warns about the late setState and the
      // result is worthless anyway.
      if (useEditorStore.getState().mediaLibrary[assetId]) setMeasured(result);
    } finally {
      setMeasuring(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-info" onClick={(e) => e.stopPropagation()}>
        <h2>{asset.name}</h2>

        {info && !info.unreadable && (
          <p className={`settings-warning${info.tracks.some((t) => !t.canDecode) ? ' settings-warning--hard' : ''}`}>
            {decodeSummary(info.tracks)}
          </p>
        )}
        {info?.unreadable && <p className="settings-warning">{info.unreadable}</p>}
        {!info && <p className="settings-note">Reading…</p>}

        <div className="info-section">
          <h3>File</h3>
          <Row label="Kind" value={ORIGIN_LABEL[asset.origin] ?? asset.origin} />
          {asset.file && <Row label="Size" value={formatFileSize(asset.file.size)} />}
          {info && info.container !== 'unknown' && <Row label="Container" value={info.container} />}
          {info?.mimeType && <Row label="Type" value={info.mimeType} />}
          {/*
            The library's own duration is the one the timeline lays out from, so it is shown
            even when the container disagrees — and when it does, that disagreement is the
            most interesting thing on the screen.
          */}
          <Row label="Duration (library)" value={formatPreciseDuration(asset.duration)} />
          {info?.metadataDuration !== null && info?.metadataDuration !== undefined && (
            <Row label="Duration (container)" value={formatPreciseDuration(info.metadataDuration)} />
          )}
          {measured && <Row label="Duration (measured)" value={formatPreciseDuration(measured.exactDuration)} />}
          {asset.width && asset.height && (
            <Row label="Stored size" value={`${asset.width} × ${asset.height}`} />
          )}
        </div>

        {info && info.tracks.length > 0 && (
          <div className="info-section">
            <h3>Tracks</h3>
            {info.tracks.map((track) => (
              <TrackBlock key={`${track.kind}-${track.id}`} track={track} measured={measured ?? undefined} />
            ))}
          </div>
        )}

        {info && !info.unreadable && (
          <div className="info-section">
            <h3>Measure</h3>
            <p className="settings-note">
              {measured
                ? 'Read from the file itself rather than from its header.'
                : 'Walks every packet header in the file — no decoding, but not instant on a long recording. Worth it when the header and the file disagree.'}
            </p>
            <button type="button" disabled={measuring || !asset.file} onClick={() => void runMeasure()}>
              {measuring ? 'Measuring…' : measured ? 'Measure again' : 'Measure'}
            </button>
          </div>
        )}

        {info && !info.unreadable && (
          <div className="info-section">
            <h3>Tags</h3>
            <TagList info={info} />
          </div>
        )}

        {recording && (
          <div className="info-section">
            <h3>Recording</h3>
            <Row label="Source" value={SOURCE_LABELS[recording.kind]} />
            <Row label="Engine" value={recording.engine === 'mediarecorder' ? 'MediaRecorder (fallback)' : 'WebCodecs'} />
            <Row label="Started" value={new Date(recording.startedAt).toLocaleString()} />
            {recording.startOffset > 0 && (
              <Row label="Offset in take" value={`${recording.startOffset.toFixed(3)}s`} />
            )}
            {recording.format && (
              <Row
                label="Negotiated"
                value={`${recording.format.width} × ${recording.format.height} · ${formatFrameRate(recording.format.frameRate)}`}
              />
            )}
            {recording.endedReason && <Row label="Stopped early" value={recording.endedReason} />}
          </div>
        )}

        {asset.derivedFrom && (
          <div className="info-section">
            <h3>Made from</h3>
            <Row label="Preset" value={asset.derivedFrom.presetLabel} />
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
