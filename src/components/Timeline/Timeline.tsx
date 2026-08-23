import { useEffect, useMemo, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { audioTracks, videoTracks } from '../../utils/compositeOrder';
import { formatTimecode } from '../../utils/time';
import { Minimap } from './Minimap';
import { PlayheadLine } from './PlayheadLine';
import { Ruler } from './Ruler';
import { TimelineToolbar } from './TimelineToolbar';
import { TrackHeader } from './TrackHeader';
import { TrackLane } from './TrackLane';
import { RULER_HEIGHT, TRACK_HEADER_WIDTH } from './constants';
import { useTimelineDrop } from './useTimelineDrop';
import { useTimelineInteractions } from './useTimelineInteractions';
import { useTimelineViewport } from './useTimelineViewport';

export function Timeline() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const altHeldRef = useRef(false);

  const tracks = useEditorStore((s) => s.tracks);
  const clips = useEditorStore((s) => s.clips);
  const mediaLibrary = useEditorStore((s) => s.mediaLibrary);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const snapIndicator = useEditorStore((s) => s.snapIndicator);
  const viewportWidth = useEditorStore((s) => s.viewportWidth);
  const fps = useEditorStore((s) => s.settings.fps);
  const getProjectDuration = useEditorStore((s) => s.getProjectDuration);
  const getTimelineSpan = useEditorStore((s) => s.getTimelineSpan);

  const { pxPerSec, scrollX, scrollY, xToTime } = useTimelineViewport(viewportRef);
  const { marquee, dragInvalid, onClipPointerDown, onLanePointerDown, onRulerPointerDown } =
    useTimelineInteractions(viewportRef, altHeldRef);
  const { dropTarget, onDragEnter, onDragOver, onDragLeave, onDrop } = useTimelineDrop(viewportRef);

  const duration = getProjectDuration();
  const span = getTimelineSpan();
  const contentWidth = span * pxPerSec;

  // ⌥ bypasses snapping while held; tracked on a ref so drags read it without re-rendering.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altHeldRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altHeldRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Page-scroll follow: jump when the playhead nears the right edge.
  useEffect(() =>
    useEditorStore.subscribe((state, prev) => {
      if (state.playhead === prev.playhead) return;
      if (!state.isPlaying || !state.followPlayhead) return;
      const x = state.playhead * state.pxPerSec - state.scrollX;
      if (x > state.viewportWidth * 0.85 || x < 0) {
        state.setScroll(state.playhead * state.pxPerSec - state.viewportWidth * 0.15, state.scrollY);
      }
    }),
  []);

  const clipsByTrack = useMemo(() => {
    const map = new Map<string, typeof clips>();
    for (const clip of clips) {
      const list = map.get(clip.trackId);
      if (list) list.push(clip);
      else map.set(clip.trackId, [clip]);
    }
    return map;
  }, [clips]);

  const videoGroup = videoTracks(tracks);
  const audioGroup = audioTracks(tracks);

  return (
    <section className="timeline">
      <TimelineToolbar />

      <div className="timeline-body" style={{ ['--header-width' as string]: `${TRACK_HEADER_WIDTH}px` }}>
        <div className="timeline-corner" style={{ height: RULER_HEIGHT }}>
          <span>{videoGroup.length}V · {audioGroup.length}A</span>
        </div>

        <div
          className="ruler-viewport"
          style={{ height: RULER_HEIGHT }}
          onPointerDown={(e) => onRulerPointerDown(e, xToTime)}
        >
          <div className="ruler-shift" style={{ transform: `translate3d(${-scrollX}px, 0, 0)` }}>
            <Ruler
              pxPerSec={pxPerSec}
              scrollX={scrollX}
              viewportWidth={viewportWidth}
              duration={span}
              fps={fps}
            />
          </div>
          <PlayheadLine variant="ruler" />
        </div>

        <div className="track-headers">
          <div className="track-headers-shift" style={{ transform: `translate3d(0, ${-scrollY}px, 0)` }}>
            {tracks.map((track) => {
              const group = track.kind === 'video' ? videoGroup : audioGroup;
              const index = group.findIndex((t) => t.id === track.id);
              return (
                <TrackHeader
                  key={track.id}
                  track={track}
                  canMoveUp={index > 0}
                  canMoveDown={index < group.length - 1}
                  canDelete={group.length > 1}
                  clipCount={clipsByTrack.get(track.id)?.length ?? 0}
                />
              );
            })}
          </div>
        </div>

        <div
          ref={viewportRef}
          className="lanes-viewport"
          onPointerDown={onLanePointerDown}
          onContextMenu={(e) => e.preventDefault()}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <div
            className="lanes-content"
            style={{
              width: contentWidth,
              transform: `translate3d(${-scrollX}px, ${-scrollY}px, 0)`,
            }}
          >
            {tracks.map((track) => (
              <TrackLane
                key={track.id}
                track={track}
                clips={clipsByTrack.get(track.id) ?? []}
                pxPerSec={pxPerSec}
                fps={fps}
                scrollX={scrollX}
                viewportWidth={viewportWidth}
                selectedIds={selectedClipIds}
                dragInvalid={dragInvalid}
                mediaLibrary={mediaLibrary}
                onClipPointerDown={onClipPointerDown}
              />
            ))}

            {/*
              Everything past the last clip is scrolling room, not project length. Shading it
              is what keeps the timeline honest about a 2-second take that exports as 2
              seconds: the lanes are wider than the content on purpose, and now they look it.
              Drawn over the lanes rather than under them, because lane backgrounds are opaque
              — there are no clips out here for it to obscure.
            */}
            {duration < span && (
              <div
                className="lanes-beyond"
                style={{ left: duration * pxPerSec, width: (span - duration) * pxPerSec }}
                aria-hidden
              />
            )}

            {marquee && (
              <div
                className="marquee"
                style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
              />
            )}

            {/*
              Where a dropped file would land. The lane and the time are known; the length is
              not — the browser will not name a dragged file until it is let go — so this is a
              line and a lane, not a clip-shaped ghost that would have to guess.
            */}
            {dropTarget && (
              <div
                className={`drop-target${dropTarget.locked ? ' is-locked' : ''}`}
                style={{ top: dropTarget.top, height: dropTarget.height }}
                aria-hidden
              >
                <div className="drop-line" style={{ left: dropTarget.time * pxPerSec }} />
                <div className="drop-chip" style={{ left: dropTarget.time * pxPerSec }}>
                  {dropTarget.count > 0 && (
                    <strong>{dropTarget.count} file{dropTarget.count === 1 ? '' : 's'}</strong>
                  )}
                  <span>{formatTimecode(dropTarget.time, fps)}</span>
                  {dropTarget.locked && <em>lane locked</em>}
                </div>
              </div>
            )}
          </div>

          {snapIndicator !== null && (
            <div className="snap-line" style={{ left: snapIndicator * pxPerSec - scrollX }} />
          )}
          <PlayheadLine variant="lanes" />
        </div>

        <Minimap />
      </div>
    </section>
  );
}
