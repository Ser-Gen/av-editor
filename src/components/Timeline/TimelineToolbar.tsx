import { useEditorStore } from '../../store/editorStore';
import type { RippleScope } from '../../types/editor';

/**
 * Three groups, in the order the work happens: what you are looking at, what you are doing to
 * it, and what you are adding. They used to be one undifferentiated row in which zoom controls
 * sat next to "add an audio track".
 */
export function TimelineToolbar() {
  const pxPerSec = useEditorStore((s) => s.pxPerSec);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);
  const followPlayhead = useEditorStore((s) => s.followPlayhead);
  const rippleEnabled = useEditorStore((s) => s.rippleEnabled);
  const rippleScope = useEditorStore((s) => s.rippleScope);
  const selectedCount = useEditorStore((s) => s.selectedClipIds.length);
  const canSplit = useEditorStore((s) => s.canSplitAtPlayhead());
  const clipCount = useEditorStore((s) => s.clips.length);

  const zoomAt = useEditorStore((s) => s.zoomAt);
  const zoomToFit = useEditorStore((s) => s.zoomToFit);
  const zoomToSelection = useEditorStore((s) => s.zoomToSelection);
  const toggleSnap = useEditorStore((s) => s.toggleSnap);
  const setFollowPlayhead = useEditorStore((s) => s.setFollowPlayhead);
  const toggleRipple = useEditorStore((s) => s.toggleRipple);
  const setRippleScope = useEditorStore((s) => s.setRippleScope);
  const closeGaps = useEditorStore((s) => s.closeGaps);
  const splitSelectedAtPlayhead = useEditorStore((s) => s.splitSelectedAtPlayhead);
  const addTrack = useEditorStore((s) => s.addTrack);
  const addAdjustmentClip = useEditorStore((s) => s.addAdjustmentClip);
  const addAnnotationClip = useEditorStore((s) => s.addAnnotationClip);

  const viewportWidth = useEditorStore((s) => s.viewportWidth);

  return (
    <div className="timeline-toolbar">
      <div className="toolbar-group" aria-label="View">
        <span className="toolbar-group-label">View</span>
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
          title="Zoom to selection (Z)"
          disabled={selectedCount === 0}
          onClick={() => zoomToSelection()}
        >
          Selection
        </button>
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

      <div className="toolbar-group" aria-label="Edit">
        <span className="toolbar-group-label">Edit</span>
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
        <button
          type="button"
          disabled={clipCount < 2}
          onClick={() => closeGaps()}
          title={
            selectedCount > 0
              ? 'Pull the clips on the selected tracks together. The first clip on each track stays put, and an overlap keeps its length so a dissolve survives'
              : 'Remove every stretch where nothing is playing on any track. Everything after a gap moves together, so detached audio stays with its picture'
          }
        >
          Close gaps
        </button>
        <button
          type="button"
          className={rippleEnabled ? 'is-active' : ''}
          title="Trims and deletes drag the rest of the timeline along instead of leaving a hole"
          onClick={() => toggleRipple()}
        >
          Ripple
        </button>
        <select
          className="ripple-scope"
          value={rippleScope}
          disabled={!rippleEnabled}
          title="What a ripple moves: the edited clip's own track, or every track at once"
          onChange={(e) => setRippleScope(e.target.value as RippleScope)}
        >
          <option value="track">This track</option>
          <option value="all">All tracks</option>
        </select>
      </div>

      <div className="toolbar-group" aria-label="Add">
        <span className="toolbar-group-label">Add</span>
        <button type="button" title="Add a video layer" onClick={() => addTrack('video')}>
          + Video track
        </button>
        <button type="button" title="Add an audio track" onClick={() => addTrack('audio')}>
          + Audio track
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
          title="Add an annotation clip: arrows, boxes and freehand marks over the picture, drawn on the preview"
          onClick={() => addAnnotationClip()}
        >
          + Annotation
        </button>
      </div>

      <span className="timeline-hint">
        ⌘/pinch zoom · wheel pans · middle-drag grabs · ⌥ bypasses snap
      </span>
    </div>
  );
}
