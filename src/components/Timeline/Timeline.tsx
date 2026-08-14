import { useEditorStore } from '../../store/editorStore';
import { clipDuration, MIN_CLIP_DURATION } from '../../utils/time';
import { Ruler } from './Ruler';
import { TRACK_LABEL_WIDTH } from './constants';
import { TrackLane } from './TrackLane';

export function Timeline() {
  const tracks = useEditorStore((s) => s.tracks);
  const clips = useEditorStore((s) => s.clips);
  const playhead = useEditorStore((s) => s.playhead);
  const timelineZoom = useEditorStore((s) => s.timelineZoom);
  const getProjectDuration = useEditorStore((s) => s.getProjectDuration);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setTimelineZoom = useEditorStore((s) => s.setTimelineZoom);
  const splitSelectedAtPlayhead = useEditorStore((s) => s.splitSelectedAtPlayhead);
  const addAudioTrack = useEditorStore((s) => s.addAudioTrack);
  const addOverlayTrack = useEditorStore((s) => s.addOverlayTrack);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const canSplit = useEditorStore((s) => {
    if (!s.selectedClipId) return false;
    const clip = s.clips.find((c) => c.id === s.selectedClipId);
    if (!clip) return false;
    const rel = s.playhead - clip.timelineStart;
    const dur = clipDuration(clip);
    return rel > MIN_CLIP_DURATION && rel < dur - MIN_CLIP_DURATION;
  });

  const duration = getProjectDuration();
  const pxPerSec = timelineZoom;

  const onSeek = (t: number) => {
    setPlaying(false);
    setPlayhead(t);
  };

  const innerWidth = Math.max(800, duration * pxPerSec + 200);

  return (
    <div className="timeline-panel">
      <div className="timeline-toolbar">
        <label>Zoom</label>
        <input
          type="range"
          min={20}
          max={400}
          value={timelineZoom}
          onChange={(e) => setTimelineZoom(Number(e.target.value))}
        />
        <button
          type="button"
          onClick={() => splitSelectedAtPlayhead()}
          disabled={!canSplit}
          title={
            selectedClipId
              ? 'Split selected clip at playhead (S)'
              : 'Select a clip, place playhead inside it, then split'
          }
        >
          Split at playhead
        </button>
        <button type="button" onClick={() => addOverlayTrack()} title="Add another overlay lane">
          + Overlay track
        </button>
        <button type="button" onClick={() => addAudioTrack()} title="Add another audio lane">
          + Audio track
        </button>
        <span className="hint">S · ⌘D duplicate · Del</span>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-inner" style={{ width: innerWidth }}>
          <Ruler duration={duration} pxPerSec={pxPerSec} playhead={playhead} onSeek={onSeek} />
          <div style={{ position: 'relative' }}>
            <div
              className="playhead-line"
              style={{ left: TRACK_LABEL_WIDTH + playhead * pxPerSec, top: 0, bottom: 0 }}
            />
            {tracks.map((track) => (
              <TrackLane
                key={track.id}
                track={track}
                clips={clips}
                pxPerSec={pxPerSec}
                onSeek={onSeek}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
