import { useEditorStore } from '../../store/editorStore';

export function TimelineToolbar() {
  const pxPerSec = useEditorStore((s) => s.pxPerSec);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);
  const followPlayhead = useEditorStore((s) => s.followPlayhead);
  const selectedCount = useEditorStore((s) => s.selectedClipIds.length);
  const canSplit = useEditorStore((s) => s.canSplitAtPlayhead());

  const zoomAt = useEditorStore((s) => s.zoomAt);
  const zoomToFit = useEditorStore((s) => s.zoomToFit);
  const zoomToSelection = useEditorStore((s) => s.zoomToSelection);
  const toggleSnap = useEditorStore((s) => s.toggleSnap);
  const setFollowPlayhead = useEditorStore((s) => s.setFollowPlayhead);
  const splitSelectedAtPlayhead = useEditorStore((s) => s.splitSelectedAtPlayhead);
  const addTrack = useEditorStore((s) => s.addTrack);
  const addAdjustmentClip = useEditorStore((s) => s.addAdjustmentClip);

  const viewportWidth = useEditorStore((s) => s.viewportWidth);

  return (
    <div className="timeline-toolbar">
      <div className="toolbar-group">
        <button type="button" title="Zoom out (⌘−)" onClick={() => zoomAt(1 / 1.3, viewportWidth / 2)}>
          −
        </button>
        <span className="zoom-readout" title="Pixels per second">
          {pxPerSec < 10 ? pxPerSec.toFixed(1) : Math.round(pxPerSec)} px/s
        </span>
        <button type="button" title="Zoom in (⌘+)" onClick={() => zoomAt(1.3, viewportWidth / 2)}>
          +
        </button>
        <button type="button" title="Fit project (⇧Z)" onClick={() => zoomToFit()}>
          Fit
        </button>
        <button
          type="button"
          title="Add an adjustment clip: a grade over everything below it, for its own time range"
          onClick={() => addAdjustmentClip()}
        >
          + Adjustment
        </button>
        <button
          type="button"
          title="Zoom to selection (Z)"
          disabled={selectedCount === 0}
          onClick={() => zoomToSelection()}
        >
          Selection
        </button>
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          className={snapEnabled ? 'is-active' : ''}
          title="Snap to clip edges and playhead (N) · hold ⌥ to bypass"
          onClick={() => toggleSnap()}
        >
          Snap
        </button>
        <button
          type="button"
          className={followPlayhead ? 'is-active' : ''}
          title="Scroll the timeline to follow the playhead during playback"
          onClick={() => setFollowPlayhead(!followPlayhead)}
        >
          Follow
        </button>
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          onClick={() => splitSelectedAtPlayhead()}
          disabled={!canSplit}
          title={
            selectedCount > 0
              ? 'Split selected clips at the playhead (S)'
              : 'Select a clip and put the playhead inside it'
          }
        >
          Split
        </button>
        <button type="button" title="Add a video layer" onClick={() => addTrack('video')}>
          + Video track
        </button>
        <button type="button" title="Add an audio track" onClick={() => addTrack('audio')}>
          + Audio track
        </button>
      </div>

      <span className="timeline-hint">
        ⌘/pinch zoom · wheel pans · middle-drag grabs · ⌥ bypasses snap
      </span>
    </div>
  );
}
