import type { Track, Clip } from '../../types/editor';
import { useEditorStore } from '../../store/editorStore';
import { getAudioTrackVolume } from '../../utils/trackVolume';
import { ClipBlock } from './ClipBlock';
import { TRACK_LABEL_WIDTH } from './constants';

interface Props {
  track: Track;
  clips: Clip[];
  pxPerSec: number;
  onSeek: (t: number) => void;
}

export function TrackLane({ track, clips, pxPerSec, onSeek }: Props) {
  const setTrackVolume = useEditorStore((s) => s.setTrackVolume);
  const trackClips = clips.filter((c) => c.trackId === track.id);
  const volume = track.kind === 'audio' ? getAudioTrackVolume(track) : null;

  const stopLaneClick = (e: React.SyntheticEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      className={`track-row${track.kind === 'audio' ? ' track-row--audio' : ''}${track.kind === 'video' ? ' track-row--video' : ''}`}
    >
      <div className="track-label" style={{ width: TRACK_LABEL_WIDTH }}>
        <span className="track-label-name">{track.label}</span>
        {track.kind === 'audio' && volume !== null && (
          <div
            className="track-volume"
            onPointerDown={stopLaneClick}
            onClick={stopLaneClick}
          >
            <input
              type="range"
              min={0}
              max={150}
              step={1}
              value={Math.round(volume * 100)}
              onChange={(e) => setTrackVolume(track.id, Number(e.target.value) / 100)}
              title="Track volume (0–150%)"
            />
            <span className="track-volume-value">{Math.round(volume * 100)}%</span>
          </div>
        )}
      </div>
      <div
        className="track-lane"
        style={{ minWidth: 0 }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          onSeek(x / pxPerSec);
        }}
      >
        {trackClips.map((clip) => (
          <ClipBlock key={clip.id} clip={clip} pxPerSec={pxPerSec} />
        ))}
      </div>
    </div>
  );
}
