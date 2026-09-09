import { useCallback, useEffect, useRef, useState } from 'react';
import type { Clip, Track } from '../../types/editor';
import { useEditorStore } from '../../store/editorStore';
import type { ClipMove } from '../../store/editorStore';
import { audioTracks, videoTracks } from '../../utils/compositeOrder';
import { buildSnapTargets, snapClipStart, snapValue } from '../../utils/snapping';
import { clipDuration, clipEnd } from '../../utils/time';
import { buildTrackLayout, trackAtY } from './trackLayout';

export interface MarqueeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Interaction =
  | {
      kind: 'move';
      startClientX: number;
      startClientY: number;
      primaryId: string;
      origins: Map<string, { start: number; trackId: string }>;
    }
  | { kind: 'trim'; clipId: string; edge: 'left' | 'right'; mode: 'trim' | 'rate' }
  | { kind: 'fade'; clipId: string; edge: 'in' | 'out' }
  | { kind: 'marquee'; startX: number; startY: number; additive: boolean; moved: boolean }
  | {
      kind: 'pan';
      startClientX: number;
      startClientY: number;
      startScrollX: number;
      startScrollY: number;
    }
  | { kind: 'scrub' };

/**
 * Dragging the playhead must not paint a text selection across whatever the pointer travels
 * over on its way — the inspector and the library sit right next to the lanes, and the
 * browser happily selects their labels. `preventDefault` on pointerdown is not enough on its
 * own: the drag continues on `window`, so the guard has to last as long as the drag does.
 */
function setDragGuard(on: boolean): void {
  document.body.classList.toggle('is-dragging', on);
  if (on) window.getSelection()?.removeAllRanges();
}

function groupFor(kind: Track['kind'], tracks: Track[]): Track[] {
  return kind === 'audio' ? audioTracks(tracks) : videoTracks(tracks);
}

function clipGroup(clip: Clip, tracks: Track[]): Track[] {
  return groupFor(clip.kind === 'audio' ? 'audio' : 'video', tracks);
}

/**
 * All pointer editing for the timeline: clip drag (including between tracks),
 * trimming, marquee selection, middle-drag panning and ruler scrubbing.
 * Listeners live on the window so a drag survives leaving the lane it started in.
 */
export function useTimelineInteractions(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  altHeldRef: React.RefObject<boolean>,
) {
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [dragInvalid, setDragInvalid] = useState(false);
  const interactionRef = useRef<Interaction | null>(null);

  /** Client coords → content coords (scroll included). */
  const toContent = useCallback(
    (clientX: number, clientY: number) => {
      const el = viewportRef.current;
      const state = useEditorStore.getState();
      if (!el) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      return {
        x: clientX - rect.left + state.scrollX,
        y: clientY - rect.top + state.scrollY,
      };
    },
    [viewportRef],
  );

  const contentToTime = useCallback((x: number) => Math.max(0, x / useEditorStore.getState().pxPerSec), []);

  const snapOpts = useCallback(() => {
    const s = useEditorStore.getState();
    return {
      enabled: s.snapEnabled && !altHeldRef.current,
      pxPerSec: s.pxPerSec,
      fps: s.settings.fps,
    };
  }, [altHeldRef]);

  // ------------------------------------------------------------------ starts

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, clip: Clip, mode: 'move' | 'left' | 'right' | 'fadeIn' | 'fadeOut') => {
      if (e.button !== 0) return;
      e.stopPropagation();
      setDragGuard(true);

      const store = useEditorStore.getState();
      const track = store.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return;

      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const alreadySelected = store.selectedClipIds.includes(clip.id);
      if (!alreadySelected || additive) store.selectClip(clip.id, additive);

      if (mode === 'fadeIn' || mode === 'fadeOut') {
        const edge = mode === 'fadeIn' ? 'in' : 'out';
        // One undo step for the whole drag, like trimming.
        store.beginInteraction(edge === 'in' ? 'Fade in' : 'Fade out');
        interactionRef.current = { kind: 'fade', clipId: clip.id, edge };
        return;
      }

      if (mode !== 'move') {
        /*
         * ⌥ turns a trim into a *rate* trim: every frame is kept and the clip takes a
         * different amount of time to play them. The modifier is read once, at the start of
         * the drag, so letting go of the key half way through does not change what the
         * gesture means underneath the pointer.
         */
        const rate = e.altKey && (clip.kind === 'video' || clip.kind === 'audio');
        store.beginInteraction(rate ? 'Rate trim' : 'Trim clip');
        interactionRef.current = {
          kind: 'trim',
          clipId: clip.id,
          edge: mode,
          mode: rate ? 'rate' : 'trim',
        };
        return;
      }

      const selection = useEditorStore.getState().selectedClipIds;
      const ids = selection.includes(clip.id) ? selection : [clip.id];
      const origins = new Map<string, { start: number; trackId: string }>();
      for (const id of ids) {
        const c = store.clips.find((x) => x.id === id);
        if (!c) continue;
        const t = store.tracks.find((x) => x.id === c.trackId);
        if (t?.locked) continue;
        origins.set(id, { start: c.timelineStart, trackId: c.trackId });
      }
      if (origins.size === 0) return;

      store.beginInteraction(origins.size > 1 ? 'Move clips' : 'Move clip');
      interactionRef.current = {
        kind: 'move',
        startClientX: e.clientX,
        startClientY: e.clientY,
        primaryId: clip.id,
        origins,
      };
    },
    [],
  );

  const onLanePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const store = useEditorStore.getState();
      if (e.button === 0 || e.button === 1) setDragGuard(true);
      if (e.button === 1) {
        e.preventDefault();
        interactionRef.current = {
          kind: 'pan',
          startClientX: e.clientX,
          startClientY: e.clientY,
          startScrollX: store.scrollX,
          startScrollY: store.scrollY,
        };
        return;
      }
      if (e.button !== 0) return;

      const { x, y } = toContent(e.clientX, e.clientY);
      interactionRef.current = {
        kind: 'marquee',
        startX: x,
        startY: y,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
        moved: false,
      };
    },
    [toContent],
  );

  const onRulerPointerDown = useCallback(
    (e: React.PointerEvent, clientXToTime: (x: number) => number) => {
      if (e.button !== 0) return;
      const store = useEditorStore.getState();
      setDragGuard(true);
      store.setPlaying(false);
      interactionRef.current = { kind: 'scrub' };

      const targets = buildSnapTargets(store.clips, [], -1);
      const snapped = snapValue(clientXToTime(e.clientX), targets, snapOpts());
      store.setPlayhead(snapped.value);
    },
    [snapOpts],
  );

  // ------------------------------------------------------------------- moves

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) return;
      const store = useEditorStore.getState();

      if (interaction.kind === 'pan') {
        store.setScroll(
          interaction.startScrollX - (e.clientX - interaction.startClientX),
          interaction.startScrollY - (e.clientY - interaction.startClientY),
        );
        return;
      }

      if (interaction.kind === 'scrub') {
        const { x } = toContent(e.clientX, e.clientY);
        const targets = buildSnapTargets(store.clips, [], -1);
        const snapped = snapValue(contentToTime(x), targets, snapOpts());
        store.setPlayhead(snapped.value);
        return;
      }

      if (interaction.kind === 'marquee') {
        const { x, y } = toContent(e.clientX, e.clientY);
        const rect = {
          x: Math.min(x, interaction.startX),
          y: Math.min(y, interaction.startY),
          w: Math.abs(x - interaction.startX),
          h: Math.abs(y - interaction.startY),
        };
        if (rect.w > 3 || rect.h > 3) interaction.moved = true;
        setMarquee(rect);

        const rows = buildTrackLayout(store.tracks);
        const startTime = rect.x / store.pxPerSec;
        const endTime = (rect.x + rect.w) / store.pxPerSec;
        const hit = store.clips.filter((clip) => {
          const row = rows.find((r) => r.track.id === clip.trackId);
          if (!row) return false;
          const rowOverlaps = row.top < rect.y + rect.h && rect.y < row.top + row.height;
          const timeOverlaps = clip.timelineStart < endTime && startTime < clipEnd(clip);
          return rowOverlaps && timeOverlaps;
        });
        store.setSelection(hit.map((c) => c.id));
        return;
      }

      if (interaction.kind === 'fade') {
        const clip = store.clips.find((c) => c.id === interaction.clipId);
        if (!clip) return;
        const { x } = toContent(e.clientX, e.clientY);
        const time = contentToTime(x);
        const seconds =
          interaction.edge === 'in' ? time - clip.timelineStart : clipEnd(clip) - time;
        store.setClipFade(clip.id, interaction.edge, seconds);
        return;
      }

      if (interaction.kind === 'trim') {
        const clip = store.clips.find((c) => c.id === interaction.clipId);
        if (!clip) return;
        const { x } = toContent(e.clientX, e.clientY);
        const targets = buildSnapTargets(store.clips, [clip.id], store.playhead);
        const snapped = snapValue(contentToTime(x), targets, snapOpts());
        store.setSnapIndicator(snapped.target);
        store.trimClipTo(clip.id, interaction.edge, snapped.value, interaction.mode);

        const updated = useEditorStore.getState().clips.find((c) => c.id === clip.id);
        if (updated && (updated.kind === 'video' || updated.kind === 'audio')) {
          const frame = 1 / store.settings.fps;
          const sourceTime =
            interaction.edge === 'left'
              ? updated.sourceTrimIn
              : Math.max(updated.sourceTrimIn, updated.sourceTrimOut - frame);
          store.setTrimPreview(clip.id, sourceTime);
        }
        return;
      }

      // Clip drag, possibly across tracks and with several clips at once.
      const primary = store.clips.find((c) => c.id === interaction.primaryId);
      const primaryOrigin = interaction.origins.get(interaction.primaryId);
      if (!primary || !primaryOrigin) return;

      const rawDelta = (e.clientX - interaction.startClientX) / store.pxPerSec;
      const targets = buildSnapTargets(store.clips, interaction.origins.keys(), store.playhead);
      const proposed = Math.max(0, primaryOrigin.start + rawDelta);
      const snapped = snapClipStart(proposed, clipDuration(primary), targets, snapOpts());
      store.setSnapIndicator(snapped.target);

      let delta = snapped.value - primaryOrigin.start;
      let minStart = Infinity;
      for (const origin of interaction.origins.values()) {
        minStart = Math.min(minStart, origin.start);
      }
      if (minStart + delta < 0) delta = -minStart;

      // Vertical: shift every clip by the same number of lanes within its own group.
      const rows = buildTrackLayout(store.tracks);
      const { y } = toContent(e.clientX, e.clientY);
      const hovered = trackAtY(rows, y);
      const primaryGroup = clipGroup(primary, store.tracks);
      const primaryOriginIndex = primaryGroup.findIndex((t) => t.id === primaryOrigin.trackId);
      let laneShift = 0;
      if (hovered && hovered.kind === (primary.kind === 'audio' ? 'audio' : 'video')) {
        const hoveredIndex = primaryGroup.findIndex((t) => t.id === hovered.id);
        if (hoveredIndex >= 0 && primaryOriginIndex >= 0) {
          laneShift = hoveredIndex - primaryOriginIndex;
        }
      }

      const moves: ClipMove[] = [];
      for (const [id, origin] of interaction.origins) {
        const clip = store.clips.find((c) => c.id === id);
        if (!clip) continue;
        const group = clipGroup(clip, store.tracks);
        const originIndex = group.findIndex((t) => t.id === origin.trackId);
        const targetIndex = Math.min(
          group.length - 1,
          Math.max(0, originIndex + laneShift),
        );
        moves.push({
          id,
          trackId: group[targetIndex]?.id ?? origin.trackId,
          timelineStart: origin.start + delta,
        });
      }

      setDragInvalid(!store.moveClipsTo(moves, false));
    };

    const onUp = () => {
      const interaction = interactionRef.current;
      interactionRef.current = null;
      // Unconditionally, and before the early return: a pointerdown that decided not to
      // start anything still raised the guard.
      setDragGuard(false);
      if (!interaction) return;
      const store = useEditorStore.getState();

      if (interaction.kind === 'marquee') {
        if (!interaction.moved && !interaction.additive) store.setSelection([]);
        setMarquee(null);
        return;
      }
      if (interaction.kind === 'trim') {
        store.clearTrimPreview();
      }
      if (interaction.kind === 'move' || interaction.kind === 'trim' || interaction.kind === 'fade') {
        store.endInteraction();
        store.setSnapIndicator(null);
        setDragInvalid(false);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [toContent, contentToTime, snapOpts]);

  return { marquee, dragInvalid, onClipPointerDown, onLanePointerDown, onRulerPointerDown };
}
