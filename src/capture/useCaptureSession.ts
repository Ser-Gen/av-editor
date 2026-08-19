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
import { systemAudioSupport } from './sources';
import type { CaptureStep, SourceProvider, SourceRequest } from './sources';

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
  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [request, setRequest] = useState<SourceRequest>({
    screen: true,
    mic: true,
    systemAudio: true,
    processMic: true,
  });
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
    setOrphans(found.filter((o) => !consumed.current.has(o.meta.id)));
  }, []);

  // Anything left on disk from a previous session — including a tab that was killed.
  useEffect(() => {
    void refreshOrphans();
  }, [refreshOrphans]);

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
    if (!request.screen && !request.mic && !request.systemAudio) {
      setNotice('Pick at least one source.');
      return;
    }
    setPhase('starting');
    setNotice(null);
    setStep('choosing-engine');
    try {
      const session = await CaptureSession.start(request, provider, enginePreference, setStep);
      sessionRef.current = session;
      setEngine(session.engineChoice);
      setStatus(session.status());
      setPhase('recording');
      setStep(null);
      const gaps = [
        session.systemAudioMissing && `Recording without system audio. ${session.systemAudioMissing}`,
        session.micMissing,
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
            startOffset: entry.meta.startOffset,
            duration: finished.duration || entry.measuredDuration,
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
        await importRecordings(sources);
        const names = sources.map((s) => SOURCE_LABELS[s.kind]).join(', ');
        setLibraryNotice(`Recorded ${names} — placed at the playhead.`);
        setNotice(warnings.length > 0 ? warnings.join(' ') : null);
      }
      await refreshOrphans();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Failed to save the recording.');
    } finally {
      setStatus(null);
      setPhase('idle');
    }
  }, [phase, importRecordings, setLibraryNotice, refreshOrphans]);

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
            // A recovered file stands alone; there is no session left to align it against.
            startOffset: 0,
            duration: finished.duration,
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
    orphans,
    start,
    stop,
    cancel,
    restore,
    discard,
  };
}
