import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { PlaybackEngine } from '../preview/PlaybackEngine';
import { captureCanvasAsPngFile, frameFileNameFromTime } from '../utils/captureFrame';
import { formatTimecode, parseTimecode } from '../utils/time';
import { MaskOverlay } from './MaskOverlay';

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

export function PreviewPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);

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

  const [capturing, setCapturing] = useState(false);
  const duration = getProjectDuration();

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

  const stateSlice = { clips, mediaLibrary, settings, tracks, trimPreview };

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || isPlaying) return;
    void engine.seek(stateSlice, playhead);
  }, [clips, mediaLibrary, settings, tracks, playhead, trimPreview, isPlaying]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (isPlaying) {
      engine.play(stateSlice, playhead, duration);
    } else {
      engine.pause();
      engine.seek(stateSlice, playhead);
    }
  }, [isPlaying]);

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
    <section className="preview-area">
      <div className="preview-wrap">
        <canvas ref={canvasRef} />
        <MaskOverlay canvasRef={canvasRef} />
      </div>
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

        <input
          className="transport-scrub"
          type="range"
          min={0}
          max={duration}
          step={1 / settings.fps}
          value={playhead}
          onChange={(e) => {
            setPlaying(false);
            setPlayhead(Number(e.target.value));
          }}
        />

        <button
          type="button"
          title="Save current preview frame to Media Library"
          disabled={capturing}
          onClick={() => void handleCaptureFrame()}
        >
          {capturing ? 'Saving…' : 'Save frame'}
        </button>
      </div>
    </section>
  );
}
