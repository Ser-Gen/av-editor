import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { PlaybackEngine } from '../preview/PlaybackEngine';
import { captureCanvasAsPngFile, frameFileNameFromTime } from '../utils/captureFrame';
import { formatTimecode } from '../utils/time';

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
      </div>
      <div className="transport">
        <button
          type="button"
          onClick={() => {
            setPlayhead(0);
            setPlaying(false);
          }}
        >
          |◀
        </button>
        <button
          type="button"
          onClick={() => setPlaying(!isPlaying)}
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          title="Save current preview frame to Media Library"
          disabled={capturing}
          onClick={() => void handleCaptureFrame()}
        >
          {capturing ? 'Saving…' : 'Save frame'}
        </button>
        <span>
          {formatTimecode(playhead)} / {formatTimecode(duration)}
        </span>
        <input
          type="range"
          min={0}
          max={duration}
          step={0.01}
          value={playhead}
          onChange={(e) => {
            setPlaying(false);
            setPlayhead(Number(e.target.value));
          }}
        />
      </div>
    </section>
  );
}
