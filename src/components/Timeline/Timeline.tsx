import { useEffect, useMemo, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { audioTracks, videoTracks } from '../../utils/compositeOrder';
import { PlayheadLine } from './PlayheadLine';
import { Ruler } from './Ruler';
import { TimelineToolbar } from './TimelineToolbar';
import { TrackHeader } from './TrackHeader';
import { TrackLane } from './TrackLane';
import { RULER_HEIGHT, TRACK_HEADER_WIDTH } from './constants';
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
          </div>

          {snapIndicator !== null && (
            <div className="snap-line" style={{ left: snapIndicator * pxPerSec - scrollX }} />
          )}
          <PlayheadLine variant="lanes" />
        </div>

        <HorizontalScrollbar contentWidth={contentWidth} />
      </div>
    </section>
  );
}

/** Native scrollbars are gone with `overflow: hidden`, so the timeline draws its own. */
function HorizontalScrollbar({ contentWidth }: { contentWidth: number }) {
  const scrollX = useEditorStore((s) => s.scrollX);
  const viewportWidth = useEditorStore((s) => s.viewportWidth);
  const setScroll = useEditorStore((s) => s.setScroll);
  const scrollY = useEditorStore((s) => s.scrollY);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startClientX: number; startScrollX: number } | null>(null);

  const ratio = contentWidth > 0 ? Math.min(1, viewportWidth / contentWidth) : 1;
  const thumbWidth = Math.max(32, viewportWidth * ratio);
  const maxScroll = Math.max(1, contentWidth - viewportWidth);
  const thumbLeft = (scrollX / maxScroll) * (viewportWidth - thumbWidth);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const travel = Math.max(1, viewportWidth - thumbWidth);
      const delta = ((e.clientX - drag.startClientX) / travel) * maxScroll;
      setScroll(drag.startScrollX + delta, scrollY);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [maxScroll, viewportWidth, thumbWidth, scrollY, setScroll]);

  if (ratio >= 1) return <div className="h-scrollbar" ref={trackRef} />;

  return (
    <div className="h-scrollbar" ref={trackRef}>
      <div
        className="h-scrollbar-thumb"
        style={{ width: thumbWidth, transform: `translate3d(${thumbLeft}px, 0, 0)` }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dragRef.current = { startClientX: e.clientX, startScrollX: scrollX };
        }}
      />
    </div>
  );
}
