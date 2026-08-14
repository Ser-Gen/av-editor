import { useCallback, useEffect, useRef, useState } from 'react';
import { MicrophoneRecorder, recordingFileName } from '../audio/microphoneRecorder';
import { useEditorStore } from '../store/editorStore';
import { formatTimecode } from '../utils/time';

export function useMicrophoneRecorder() {
  const importToLibrary = useEditorStore((s) => s.importToLibrary);
  const setLibraryNotice = useEditorStore((s) => s.setLibraryNotice);

  const recorderRef = useRef<MicrophoneRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const startedAt = performance.now();
    const id = window.setInterval(() => {
      setElapsed((performance.now() - startedAt) / 1000);
    }, 100);
    return () => window.clearInterval(id);
  }, [recording]);

  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, []);

  const startRecording = useCallback(async () => {
    if (recording || busy) return;
    setBusy(true);
    try {
      const recorder = new MicrophoneRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setElapsed(0);
      setRecording(true);
      setLibraryNotice('Recording microphone… playback can continue.');
    } catch (e) {
      const msg =
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microphone access denied.'
          : e instanceof Error
            ? e.message
            : 'Microphone unavailable.';
      setLibraryNotice(msg);
      console.warn('[Microphone] start failed:', e);
    } finally {
      setBusy(false);
    }
  }, [recording, busy, setLibraryNotice]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || busy) return;

    setBusy(true);
    setRecording(false);
    const duration = elapsed;

    try {
      const mimeType = recorder.recordingMimeType;
      const blob = await recorder.stop();
      const name = recordingFileName(mimeType);
      const file = new File([blob], name, { type: blob.type });
      await importToLibrary([file], 'audio');
      setLibraryNotice(`Recording saved to library (${formatTimecode(duration).slice(0, 8)}).`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save recording';
      setLibraryNotice(msg);
      console.warn('[Microphone] stop failed:', e);
    } finally {
      recorderRef.current = null;
      setElapsed(0);
      setBusy(false);
    }
  }, [busy, elapsed, importToLibrary, setLibraryNotice]);

  const toggleRecording = useCallback(() => {
    if (recording) void stopRecording();
    else void startRecording();
  }, [recording, startRecording, stopRecording]);

  return {
    recording,
    busy,
    elapsed,
    toggleRecording,
  };
}
