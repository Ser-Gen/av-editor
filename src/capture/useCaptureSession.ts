import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { CaptureSession } from './CaptureSession';
import type { CaptureStatus } from './CaptureSession';
import { chooseEngine } from './engine';
import type { EngineChoice, EnginePreference } from './engine';
import { SOURCE_LABELS } from './recordingStore';
import type { RecordedSource } from './recordingStore';
import { discardRecording, findOrphans, finalizeRecording, recoverRecording } from './recovery';
import type { OrphanRecording } from './recovery';
import { cameraConstraints, systemAudioSupport } from './sources';
import { TARGET_FPS } from './sources';
import type { CaptureStep, SourceProvider, SourceRequest } from './sources';
import { listCameras, onDeviceChange, resolveCameraChoice } from './cameraDevices';
import type { CameraDevice } from './cameraDevices';

export type CapturePhase = 'idle' | 'starting' | 'recording' | 'finishing';

/** Status is polled rather than pushed: meters want a frame rate, not an event per chunk. */
const POLL_MS = 100;

export interface CaptureController {
  phase: CapturePhase;
  /** While starting: which external thing is being waited on. Null at any other time. */
  step: CaptureStep | null;
  request: SourceRequest;
  setRequest: (next: SourceRequest) => void;
  status: CaptureStatus | null;
  notice: string | null;
  /** Which engine will record, and why — decided before the first Record press. */
  engine: EngineChoice | null;
  /** What this platform will do about system audio, known before recording starts. */
  systemAudioNote: string;
  systemAudioLikely: boolean;
  /** Cameras present right now — re-read on every plug and unplug. */
  cameras: CameraDevice[];
  /**
   * A live camera for the panel to show before the take. Framing and lighting are things
   * you cannot check afterwards, and a preview is the only place the mirrored image is
   * correct — the recording is never mirrored.
   */
  cameraPreview: MediaStream | null;
  /** Opened and closed by the panel, so a camera is not held open by a collapsed panel. */
  setPreviewWanted: (wanted: boolean) => void;
  orphans: OrphanRecording[];
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  restore: (orphan: OrphanRecording) => Promise<void>;
  discard: (orphan: OrphanRecording) => Promise<void>;
}

export function useCaptureSession(
  provider?: SourceProvider,
  enginePreference: EnginePreference = 'auto',
): CaptureController {
  const importRecordings = useEditorStore((s) => s.importRecordings);
  const setLibraryNotice = useEditorStore((s) => s.setLibraryNotice);

  const sessionRef = useRef<CaptureSession | null>(null);
  /**
   * `stop` as it is right now, for callbacks the session holds from before it existed.
   * A source can end by itself — an unplugged camera — and if it was the last one, the take
   * has to be wound up from inside that event rather than waiting for a Stop press that is
   * never coming.
   */
  const stopRef = useRef<() => Promise<void>>(async () => undefined);
  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [request, setRequest] = useState<SourceRequest>({
    screen: true,
    camera: false,
    mic: true,
    systemAudio: true,
    processMic: true,
    fps: TARGET_FPS,
    quality: 'normal',
    scale: 1,
  });
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [cameraPreview, setCameraPreview] = useState<MediaStream | null>(null);
  const [previewWanted, setPreviewWanted] = useState(false);
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<OrphanRecording[]>([]);
  const [engine, setEngine] = useState<EngineChoice | null>(null);
  const [step, setStep] = useState<CaptureStep | null>(null);
  /**
   * Recordings already pulled into this session's library.
   *
   * The files stay on disk after a restore — the project itself is not persisted yet, so
   * they are still worth offering on a *later* launch. But offering one again in the
   * session that just imported it invites a duplicate asset, so they are filtered here
   * rather than deleted.
   */
  const consumed = useRef(new Set<string>());

  const support = systemAudioSupport();

  const refreshOrphans = useCallback(async () => {
    const found = await findOrphans().catch(() => [] as OrphanRecording[]);
    // A restored project owns its own recordings. Without this a reload would offer every
    // recording in the open project back as a crash leftover — `consumed` only remembers
    // what *this* page load imported, and a reload starts it empty.
    const owned = new Set(
      Object.values(useEditorStore.getState().mediaLibrary)
        .map((a) => a.recordingId)
        .filter((id): id is string => !!id),
    );
    setOrphans(found.filter((o) => !consumed.current.has(o.meta.id) && !owned.has(o.meta.id)));
  }, []);

  // Anything left on disk from a previous session — including a tab that was killed.
  useEffect(() => {
    void refreshOrphans();
  }, [refreshOrphans]);

  /**
   * The camera list, refreshed on every plug and unplug.
   *
   * Also refreshed after the preview opens: `enumerateDevices()` withholds labels until a
   * camera permission has been granted once, so the first read is usually a list of blanks
   * and the second is the real names.
   */
  const refreshCameras = useCallback(async () => {
    const found = await listCameras();
    setCameras(found);
    setRequest((current) => {
      const chosen = resolveCameraChoice(found, current.cameraDeviceId);
      return chosen === current.cameraDeviceId ? current : { ...current, cameraDeviceId: chosen };
    });
  }, []);

  useEffect(() => {
    void refreshCameras();
    return onDeviceChange(() => void refreshCameras());
  }, [refreshCameras]);

  /**
   * The preview camera, held open only while the panel is showing it.
   *
   * A camera left open shows a lit indicator light and locks the device against other
   * applications, so it is closed the moment the panel collapses, the tick comes off, or a
   * recording starts — during a take the camera belongs to the session, not to the preview.
   */
  useEffect(() => {
    // During a take the camera belongs to the session: a second `getUserMedia` would be
    // fighting the recorder for a device that can only be opened once. So the preview shows
    // the recorder's own stream, and stops nothing when it goes away.
    if (phase === 'recording') {
      setCameraPreview(previewWanted ? (sessionRef.current?.cameraStream() ?? null) : null);
      return;
    }
    // The previous run's cleanup has already stopped whatever was open, so there is
    // nothing to close here — only the state to clear.
    if (!previewWanted || !request.camera || phase !== 'idle') {
      setCameraPreview(null);
      return;
    }
    let live = true;
    let opened: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: cameraConstraints(request.cameraDeviceId, request.fps) })
      .then((stream) => {
        opened = stream;
        if (!live) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        setCameraPreview(stream);
        // Labels arrive with the grant, not before it.
        void refreshCameras();
      })
      .catch(() => undefined);
    return () => {
      live = false;
      for (const track of opened?.getTracks() ?? []) track.stop();
      setCameraPreview(null);
    };
  }, [previewWanted, request.camera, request.cameraDeviceId, request.fps, phase, refreshCameras]);

  // Decided up front so the panel can say how it will record before anyone presses Record.
  useEffect(() => {
    let live = true;
    chooseEngine(enginePreference)
      .then((choice) => {
        if (live) setEngine(choice);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enginePreference]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const id = window.setInterval(() => {
      const session = sessionRef.current;
      if (session) setStatus(session.status());
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    return () => {
      void sessionRef.current?.cancel();
      sessionRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (phase !== 'idle') return;
    if (!request.screen && !request.camera && !request.mic && !request.systemAudio) {
      setNotice('Pick at least one source.');
      return;
    }
    setPhase('starting');
    setNotice(null);
    setStep('choosing-engine');
    try {
      const session = await CaptureSession.start(request, provider, enginePreference, setStep);
      sessionRef.current = session;
      session.onSourceEnded = (kind, reason) => {
        setNotice(`${SOURCE_LABELS[kind]}: ${reason}. It was saved as far as it got; the rest is still recording.`);
      };
      session.onAllEnded = () => {
        setNotice('Every source stopped on its own — saving what was recorded.');
        void stopRef.current();
      };
      setEngine(session.engineChoice);
      setStatus(session.status());
      setPhase('recording');
      setStep(null);
      const gaps = [
        session.systemAudioMissing && `Recording without system audio. ${session.systemAudioMissing}`,
        session.micMissing,
        session.cameraMissing,
        session.systemAudioProcessed,
      ].filter((s): s is string => !!s);
      setNotice(gaps.length > 0 ? gaps.join(' ') : null);
    } catch (e) {
      sessionRef.current = null;
      setPhase('idle');
      setStep(null);
      const message =
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Permission denied — nothing was recorded.'
          : e instanceof Error
            ? e.message
            : 'Could not start recording.';
      setNotice(message);
    }
  }, [phase, request, provider, enginePreference]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || phase !== 'recording') return;
    setPhase('finishing');
    setNotice(
      session.engineChoice.engine === 'webcodecs'
        ? 'Finishing: closing the file…'
        : 'Finishing: rebuilding the container so the file seeks…',
    );

    try {
      const captured = await session.stop();
      sessionRef.current = null;

      const sources: RecordedSource[] = [];
      const warnings: string[] = [];
      for (const entry of captured) {
        try {
          const finished = await finalizeRecording(entry.meta);
          // It is in this session's library now; do not offer it back as a leftover.
          consumed.current.add(entry.meta.id);
          if (finished.note) warnings.push(finished.note);
          sources.push({
            kind: entry.meta.kind,
            file: finished.file,
            recordingId: finished.meta.id,
            storedName: finished.meta.readyFile ?? finished.meta.rawFile,
            startOffset: entry.meta.startOffset,
            duration: finished.duration || entry.measuredDuration,
            format: entry.meta.format,
          });
        } catch (e) {
          warnings.push(
            `${SOURCE_LABELS[entry.meta.kind]}: ${e instanceof Error ? e.message : 'failed'}`,
          );
        }
      }

      if (sources.length === 0) {
        setNotice(warnings[0] ?? 'Nothing was recorded.');
      } else {
        const imported = await importRecordings(sources);
        const names = sources.map((s) => SOURCE_LABELS[s.kind]).join(', ');
        setLibraryNotice(`Recorded ${names} — placed at the playhead.`);
        // The frame-rate note belongs with the warnings, not instead of them: a project
        // that changed its rate is worth saying even when something else also went wrong.
        const all = [...warnings, imported.notice].filter((n): n is string => !!n);
        setNotice(all.length > 0 ? all.join(' ') : null);
      }
      await refreshOrphans();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed to save the recording.');
    } finally {
      setStatus(null);
      setPhase('idle');
    }
  }, [phase, importRecordings, setLibraryNotice, refreshOrphans]);

  // Kept current so a source ending by itself calls the live `stop`, not the one that
  // existed when the session started. In an effect rather than in the render body: a render
  // that is never committed must not leave the ref pointing at its closure.
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  const cancel = useCallback(async () => {
    await sessionRef.current?.cancel();
    sessionRef.current = null;
    setStatus(null);
    setPhase('idle');
    setNotice('Recording discarded.');
  }, []);

  const restore = useCallback(
    async (orphan: OrphanRecording) => {
      setNotice(`Recovering ${orphan.label} recording…`);
      try {
        const finished = await recoverRecording(orphan.meta);
        await importRecordings([
          {
            kind: orphan.meta.kind,
            file: finished.file,
            recordingId: finished.meta.id,
            storedName: finished.meta.readyFile ?? finished.meta.rawFile,
            // A recovered file stands alone; there is no session left to align it against.
            startOffset: 0,
            duration: finished.duration,
            format: orphan.meta.format,
          },
        ]);
        consumed.current.add(orphan.meta.id);
        setLibraryNotice(`Recovered ${orphan.label} recording.`);
        setNotice(finished.note ?? null);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Could not recover that recording.');
      }
      await refreshOrphans();
    },
    [importRecordings, setLibraryNotice, refreshOrphans],
  );

  const discard = useCallback(
    async (orphan: OrphanRecording) => {
      await discardRecording(orphan.meta);
      await refreshOrphans();
    },
    [refreshOrphans],
  );

  return {
    phase,
    step,
    request,
    setRequest,
    status,
    notice,
    engine,
    systemAudioNote: support.reason,
    systemAudioLikely: support.likely,
    cameras,
    cameraPreview,
    setPreviewWanted,
    orphans,
    start,
    stop,
    cancel,
    restore,
    discard,
  };
}
