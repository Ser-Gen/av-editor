import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { PlaybackEngine } from '../preview/PlaybackEngine';
import { captureCanvasAsPngFile, frameFileNameFromTime } from '../utils/captureFrame';
import { formatClock, formatTimecode, parseTimecode } from '../utils/time';
import {
  CONTROLS_IDLE_MS,
  fractionAcross,
  monitorGain,
  progressFraction,
  seekTimeAt,
} from '../utils/transport';
import { bindMediaKeys, setMediaPlaybackState } from '../preview/mediaSession';
import { MaskOverlay } from './MaskOverlay';
import { AnnotationLayer } from './AnnotationLayer';
import { ANNOTATION_TOOLS } from './AnnotationOverlay';
import type { AnnotationTool } from './AnnotationOverlay';
import { shapePointsAt, sortedKeys } from '../utils/annotationAnim';

/** Editable MM:SS:FF — type a timecode and the playhead jumps there. */
function TimecodeField({
  playhead,
  fps,
  onSeek,
}: {
  playhead: number;
  fps: number;
  onSeek: (t: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      className="transport-timecode"
      value={draft ?? formatTimecode(playhead, fps)}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        if (draft !== null) {
          const parsed = parseTimecode(draft, fps);
          if (parsed !== null) onSeek(parsed);
        }
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      title="Timecode MM:SS:FF — type to jump"
    />
  );
}

/** Speaker plus a slider. The same control in both layouts — one volume, one place to set it. */
function VolumeControl({ compact }: { compact?: boolean }) {
  const volume = useEditorStore((s) => s.previewVolume);
  const muted = useEditorStore((s) => s.previewMuted);
  const setPreviewVolume = useEditorStore((s) => s.setPreviewVolume);
  const togglePreviewMute = useEditorStore((s) => s.togglePreviewMute);
  const silent = muted || volume === 0;

  return (
    <div className={`volume-control${compact ? ' is-compact' : ''}`}>
      <button
        type="button"
        className="volume-mute"
        title={silent ? 'Unmute preview' : 'Mute preview (monitoring only — exports are unaffected)'}
        aria-pressed={muted}
        onClick={togglePreviewMute}
      >
        {silent ? '🔇' : '🔊'}
      </button>
      <input
        type="range"
        className="volume-slider"
        min={0}
        max={100}
        value={Math.round((muted ? 0 : volume) * 100)}
        aria-label="Preview volume"
        onChange={(e) => setPreviewVolume(Number(e.target.value) / 100)}
      />
    </div>
  );
}

/**
 * The scrub bar for the expanded player: the whole project in one strip.
 *
 * It is the simple counterpart to the timeline, not a replacement — no clips, no tracks, no
 * zoom, just where you are in the finished thing. Pointer capture so a drag that leaves the
 * bar keeps scrubbing, which is how every player behaves and how the timeline's own drags
 * already work.
 */
function ScrubBar({ playhead, duration }: { playhead: number; duration: number }) {
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const dragging = useRef(false);

  const seek = (clientX: number, box: DOMRect) => {
    setPlayhead(seekTimeAt(fractionAcross(clientX, box), duration));
  };

  return (
    <div
      className="scrub-bar"
      role="slider"
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(playhead)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        seek(e.clientX, e.currentTarget.getBoundingClientRect());
      }}
      onPointerMove={(e) => {
        if (dragging.current) seek(e.clientX, e.currentTarget.getBoundingClientRect());
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onLostPointerCapture={() => {
        dragging.current = false;
      }}
    >
      <div className="scrub-track">
        <div
          className="scrub-fill"
          style={{ width: `${progressFraction(playhead, duration) * 100}%` }}
        />
      </div>
    </div>
  );
}

export function PreviewPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);

  // The drawing tool is a property of the session, not of the clip: you pick a colour once
  // and mark up ten things with it.
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>('arrow');
  const [annotationColor, setAnnotationColor] = useState('#ff3b30');
  const [annotationWidth, setAnnotationWidth] = useState(0.006);
  const annotationClipId = useEditorStore((st) =>
    st.clips.find((c) => c.id === st.selectedClipIds[0] && c.kind === 'annotation')?.id ?? null,
  );
  const selectedShapeId = useEditorStore((s) => s.selectedShapeId);
  const setAnnotationShapeKey = useEditorStore((s) => s.setAnnotationShapeKey);
  const clearAnnotationShapeKeys = useEditorStore((s) => s.clearAnnotationShapeKeys);
  const updateAnnotationShape = useEditorStore((s) => s.updateAnnotationShape);
  const annotating = annotationClipId !== null;

  /*
   * Colour and width are one value each, and they mean both things at once: they restyle the
   * selected mark and they are what the next mark is drawn with. The alternative — a separate
   * "default" and "selection" pair — is two controls that look identical and a question about
   * which one a slider just moved.
   */
  const setAnnotationStyle = (patch: { color?: string; width?: number }) => {
    if (patch.color !== undefined) setAnnotationColor(patch.color);
    if (patch.width !== undefined) setAnnotationWidth(patch.width);
    if (annotationClipId && selectedShapeId) {
      updateAnnotationShape(annotationClipId, selectedShapeId, patch);
    }
  };

  const clips = useEditorStore((s) => s.clips);
  const mediaLibrary = useEditorStore((s) => s.mediaLibrary);
  const settings = useEditorStore((s) => s.settings);
  const tracks = useEditorStore((s) => s.tracks);
  const playhead = useEditorStore((s) => s.playhead);
  const trimPreview = useEditorStore((s) => s.trimPreview);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const getProjectDuration = useEditorStore((s) => s.getProjectDuration);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const importToLibrary = useEditorStore((s) => s.importToLibrary);
  const setLibraryNotice = useEditorStore((s) => s.setLibraryNotice);

  /*
   * The selected mark, as it stands at the playhead. The ⏱ acts on this rather than toggling
   * a mode: a mark either moves or it does not, and which one is visible in the button.
   */
  const annotationClip = clips.find(
    (c): c is Extract<typeof c, { kind: 'annotation' }> =>
      c.id === annotationClipId && c.kind === 'annotation',
  );
  const selectedShape = annotationClip?.shapes.find((sh) => sh.id === selectedShapeId) ?? null;
  const shapeMoves = !!selectedShape && sortedKeys(selectedShape.pointKeys).length > 0;

  const previewVolume = useEditorStore((s) => s.previewVolume);
  const previewMuted = useEditorStore((s) => s.previewMuted);

  const [capturing, setCapturing] = useState(false);
  const [theater, setTheater] = useState(false);
  const [controlsIdle, setControlsIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  const duration = getProjectDuration();

  // One node, set from one place: the engine is created once and outlives every re-render,
  // so this is the only thing that has to stay in step with the store.
  useEffect(() => {
    engineRef.current?.setMonitorGain(monitorGain(previewVolume, previewMuted));
  }, [previewVolume, previewMuted]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new PlaybackEngine(canvas);
    engineRef.current = engine;
    if (import.meta.env.DEV) {
      // Dev handle: lets a browser-driven check read the live audio graph.
      (window as unknown as { __engine?: PlaybackEngine }).__engine = engine;
    }
    engine.setCallbacks(
      (t) => setPlayhead(t),
      () => setPlaying(false),
    );
    return () => engine.destroy();
  }, [setPlayhead, setPlaying]);

  // The media keys drive the transport, not whichever decoder the engine last touched.
  useEffect(
    () => bindMediaKeys({ play: () => setPlaying(true), pause: () => setPlaying(false) }),
    [setPlaying],
  );
  useEffect(() => setMediaPlaybackState(isPlaying), [isPlaying]);

  const stateSlice = { clips, mediaLibrary, settings, tracks, trimPreview };

  /*
   * The engine reads these every frame while playing rather than being handed a snapshot when
   * playback starts. Refs rather than state: the play loop must see the newest document, and
   * re-running the effect that starts playback would restart it.
   */
  const sliceRef = useRef(stateSlice);
  sliceRef.current = stateSlice;
  const durationRef = useRef(0);
  durationRef.current = duration;

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || isPlaying) return;
    void engine.seek(stateSlice, playhead);
  }, [clips, mediaLibrary, settings, tracks, playhead, trimPreview, isPlaying]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (isPlaying) {
      engine.play(() => sliceRef.current, playhead, () => durationRef.current);
    } else {
      engine.pause();
      engine.seek(stateSlice, playhead);
    }
  }, [isPlaying]);

  /*
   * Floating controls get out of the way when the pointer stops moving, and take the cursor
   * with them — a cursor parked over the picture is as much of an intrusion as the bar is.
   * The timer restarts on any movement, so the controls are never more than a twitch away.
   */
  const wake = useCallback(() => {
    setControlsIdle(false);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setControlsIdle(true), CONTROLS_IDLE_MS);
  }, []);

  useEffect(() => {
    if (!theater) {
      // Leaving the mode must also leave the cursor visible, whatever the timer was doing.
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
      setControlsIdle(false);
      return;
    }
    wake();
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, [theater, wake]);

  // Escape leaves, from anywhere — including with the pointer over a control that swallowed
  // the click. The app's own shortcut handler never sees a key pressed inside a text field,
  // and this must work regardless.
  useEffect(() => {
    if (!theater) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setTheater(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [theater]);

  const handleCaptureFrame = useCallback(async () => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas || capturing) return;

    setCapturing(true);
    setPlaying(false);
    try {
      await engine.seek(stateSlice, playhead);
      const file = await captureCanvasAsPngFile(canvas, frameFileNameFromTime(playhead));
      await importToLibrary([file], 'image');
      setLibraryNotice(`Captured frame at ${formatTimecode(playhead)}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to capture frame';
      setLibraryNotice(msg);
      console.warn('[Preview] frame capture failed:', e);
    } finally {
      setCapturing(false);
    }
  }, [capturing, stateSlice, playhead, setPlaying, importToLibrary, setLibraryNotice]);

  return (
    <section
      className={`preview-area${theater ? ' is-theater' : ''}${
        theater && controlsIdle ? ' is-idle' : ''
      }`}
      onPointerMove={theater ? wake : undefined}
      onPointerDown={theater ? wake : undefined}
    >
      <div className="preview-wrap">
        {/*
          On the canvas rather than the wrapper: the mask handles sit in a layer above it, and
          a double-click while dragging one out should adjust a mask, not swallow the editor.
        */}
        <canvas ref={canvasRef} onDoubleClick={() => setTheater((on) => !on)} />
        {/*
          Mask handles are an editing affordance, and the expanded player is for watching.
          They also anchor to the canvas box, which is a different box in this mode.
        */}
        {!theater && <MaskOverlay canvasRef={canvasRef} />}
        {!theater && (
          <AnnotationLayer
            canvasRef={canvasRef}
            tool={annotationTool}
            color={annotationColor}
            width={annotationWidth}
          />
        )}
        {/* The tool strip only appears with an annotation clip selected. */}
        {!theater && annotating && (
          <div className="annotation-tools">
            {ANNOTATION_TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={annotationTool === t.id ? 'is-active' : ''}
                title={t.hint}
                onClick={() => setAnnotationTool(t.id)}
              >
                {t.label}
              </button>
            ))}
            <input
              type="color"
              value={annotationColor}
              title="Colour of the selected mark, and of the next one"
              onChange={(e) => setAnnotationStyle({ color: e.target.value })}
            />
            <input
              type="range"
              min={2}
              max={20}
              value={Math.round(annotationWidth * 1000)}
              title="Width of the selected mark, and of the next one"
              onChange={(e) => setAnnotationStyle({ width: Number(e.target.value) / 1000 })}
            />
            <button
              type="button"
              className={`stopwatch${shapeMoves ? ' is-armed' : ''}`}
              disabled={!selectedShape}
              title={
                !selectedShape
                  ? 'Select a mark first'
                  : shapeMoves
                    ? 'Stop this mark moving — it keeps the pose at the playhead'
                    : 'Make this mark move: records where it is now, then drag it at another moment'
              }
              onClick={() => {
                if (!annotationClip || !selectedShape) return;
                if (shapeMoves) clearAnnotationShapeKeys(annotationClip.id, selectedShape.id);
                // Recording where it already is, so the first drag elsewhere has something to
                // travel *from*. Without it one pose holds for the whole clip and the mark
                // looks as though it simply jumped.
                else
                  setAnnotationShapeKey(
                    annotationClip.id,
                    selectedShape.id,
                    shapePointsAt(selectedShape, playhead - annotationClip.timelineStart),
                  );
              }}
            >
              ⏱
            </button>
            <span className="annotation-hint">
              {shapeMoves
                ? 'this mark moves · drag it at another moment to add a pose'
                : selectedShapeId
                  ? 'colour and width restyle this mark · ⏱ makes it move · Delete removes it'
                  : 'Select picks a mark to move or restyle · right-click removes one'}
            </span>
          </div>
        )}
      </div>

      {/*
        The expanded player's own bar: position, a clock, sound, and the way out. Everything
        else the transport offers is an editing control and stays in the editing layout.
      */}
      {theater && (
        <div className="theater-controls" onPointerMove={wake}>
          <ScrubBar playhead={playhead} duration={duration} />
          <div className="theater-row">
            <button
              type="button"
              className="transport-play"
              onClick={() => setPlaying(!isPlaying)}
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <span className="theater-clock">
              {formatClock(playhead)} <span className="theater-clock-total">/ {formatClock(duration)}</span>
            </span>
            <span className="transport-spacer" />
            <VolumeControl compact />
            <button type="button" title="Back to the editor (Esc)" onClick={() => setTheater(false)}>
              Exit
            </button>
          </div>
        </div>
      )}

      <div className="transport">
        <button
          type="button"
          title="Go to start (Home)"
          onClick={() => {
            setPlayhead(0);
            setPlaying(false);
          }}
        >
          |◀
        </button>
        <button
          type="button"
          title="Previous frame (,)"
          onClick={() => {
            setPlaying(false);
            setPlayhead(playhead - 1 / settings.fps);
          }}
        >
          ◀|
        </button>
        <button type="button" className="transport-play" onClick={() => setPlaying(!isPlaying)}>
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          title="Next frame (.)"
          onClick={() => {
            setPlaying(false);
            setPlayhead(playhead + 1 / settings.fps);
          }}
        >
          |▶
        </button>

        <TimecodeField
          playhead={playhead}
          fps={settings.fps}
          onSeek={(t) => {
            setPlaying(false);
            setPlayhead(t);
          }}
        />
        <span className="transport-duration">/ {formatTimecode(duration, settings.fps)}</span>

        <span className="transport-spacer" />

        <VolumeControl />

        <button
          type="button"
          title="Save current preview frame to Media Library"
          disabled={capturing}
          onClick={() => void handleCaptureFrame()}
        >
          {capturing ? 'Saving…' : 'Save frame'}
        </button>
        <button
          type="button"
          title="Fill the window with the player (double-click the picture, Esc to leave)"
          onClick={() => setTheater(true)}
        >
          ⛶
        </button>
      </div>
    </section>
  );
}
